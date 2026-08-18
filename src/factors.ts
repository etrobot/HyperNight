import pl from 'nodejs-polars';

import { BAR_MS, HOUR_MS, tickerOf } from './constants.js';
import type {
  CandleBar,
  FactorBuildResult,
  FactorEligibilityReason,
  FactorRow,
  FundingBar,
  OffHoursWindow,
  SessionAudit,
  StockDailyBar,
  StrategyConfig
} from './types.js';

export interface BuildFactorRowsInput {
  symbols: string[];
  windows: OffHoursWindow[];
  candles: CandleBar[];
  stockDaily: StockDailyBar[];
  funding: FundingBar[];
  config: StrategyConfig;
  /** 已知数据截止边界；用于模拟盘构建尚未结束的当前休市段。 */
  dataCutoff?: number;
  /** 模拟盘为已有仓位保留低覆盖率路径，但这些行仍不可作为新开仓信号。 */
  retainInsufficientCoverageRows?: boolean;
}

interface BaseFactorRow {
  symbol: string;
  ticker: string;
  sessionDate: string;
  nextTradeDate: string;
  windowStart: number;
  windowEnd: number;
  timestamp: number;
  isSessionLast: boolean;
  close: number;
  referencePrice: number;
  deviation: number;
  direction: number;
  fundingRate: number;
  fundingKnown: boolean;
  estimatedNotionalVolume: number;
  sessionReason: FactorEligibilityReason;
}

const RAW_FACTORS = [
  ['deviationFactor', 'deviationZ'],
  ['momentumFactor', 'momentumZ'],
  ['liquidityFactor', 'liquidityZ'],
  ['lowVolatilityFactor', 'lowVolatilityZ'],
  ['fundingCarryFactor', 'fundingCarryZ']
] as const;

function key(...parts: Array<string | number>): string {
  return parts.join('|');
}

function lastClosedPrice(bars: CandleBar[], timestamp: number): number | null {
  let price: number | null = null;
  for (const bar of bars) {
    if (bar.closeTimestamp <= timestamp) price = bar.close;
    else break;
  }
  return price;
}

function finiteNumber(value: unknown, fallback = 0): number {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function eligibilityReason(
  record: Record<string, unknown>,
  config: StrategyConfig,
  retainInsufficientCoverage = record.sessionReason === 'insufficient_coverage'
): FactorEligibilityReason {
  if (retainInsufficientCoverage) return 'insufficient_coverage';
  const factorNames = RAW_FACTORS.map(([raw]) => raw);
  if (factorNames.some((name) => record[name] === null || record[name] === undefined || !Number.isFinite(Number(record[name])))) {
    return 'warmup';
  }
  const deviation = Math.abs(finiteNumber(record.deviation));
  if (deviation < config.entryDeviation) return 'below_entry_deviation';
  if (finiteNumber(record.deviationFactor) < config.minExpectedEdge) return 'edge_below_cost';
  if (Boolean(record.fundingKnown) && Math.abs(finiteNumber(record.fundingRate)) > config.maxFunding) {
    return 'funding_too_high';
  }
  if (finiteNumber(record.estimatedNotionalVolume) < config.minBarNotional) return 'bar_too_thin';
  if (finiteNumber(record.score) < config.minScore) return 'score_below_minimum';
  return 'eligible';
}

function assignRanks(rows: FactorRow[]): void {
  for (const row of rows) row.rank = 0;
  let start = 0;
  while (start < rows.length) {
    let end = start + 1;
    while (end < rows.length && rows[end]!.timestamp === rows[start]!.timestamp) end += 1;
    const eligible = rows.slice(start, end)
      .filter((row) => row.eligible)
      .sort((left, right) => right.score - left.score || left.symbol.localeCompare(right.symbol));
    for (let index = 0; index < eligible.length; index += 1) eligible[index]!.rank = index + 1;
    start = end;
  }
}

/**
 * 优化器的默认搜索轴不会改变滚动因子或截面 z-score；entry/exit/cost 只会
 * 改变准入门槛。复用同一份因子行并轻量重分类，避免每个 trial 重跑 Polars。
 */
export function reclassifyFactorRows(rows: FactorRow[], config: StrategyConfig): void {
  const roundTripCost = 2 * (config.feeRate + config.slippageBps / 10_000);
  for (const row of rows) {
    const retainInsufficientCoverage = row.eligibilityReason === 'insufficient_coverage';
    row.deviationFactor = Math.abs(row.deviation) - config.exitDeviation - roundTripCost;
    const reason = eligibilityReason(
      row as unknown as Record<string, unknown>,
      config,
      retainInsufficientCoverage
    );
    row.eligibilityReason = reason;
    row.eligible = reason === 'eligible';
  }
  assignRanks(rows);
}

function addCrossSectionalZScores(frame: pl.DataFrame): pl.DataFrame {
  let output = frame;
  for (const [raw, z] of RAW_FACTORS) {
    const low = `_${raw}P05`;
    const high = `_${raw}P95`;
    const winsorized = `_${raw}Winsorized`;
    const mean = `_${raw}Mean`;
    const standardDeviation = `_${raw}Std`;
    output = output
      .withColumns(
        pl.col(raw).quantile(0.05, 'linear').over('timestamp').alias(low),
        pl.col(raw).quantile(0.95, 'linear').over('timestamp').alias(high)
      )
      .withColumn(
        pl.when(pl.col(raw).lt(pl.col(low)))
          .then(pl.col(low))
          .when(pl.col(raw).gt(pl.col(high)))
          .then(pl.col(high))
          .otherwise(pl.col(raw))
          .alias(winsorized)
      )
      .withColumns(
        pl.col(winsorized).mean().over('timestamp').alias(mean),
        pl.col(winsorized).std().over('timestamp').alias(standardDeviation)
      )
      .withColumn(
        pl.when(pl.col(standardDeviation).isNotNull().and(pl.col(standardDeviation).gt(0)))
          .then(pl.col(winsorized).sub(pl.col(mean)).div(pl.col(standardDeviation)))
          .otherwise(pl.lit(0))
          .alias(z)
      );
  }
  return output;
}

/**
 * 使用已知于当前 5m 收线时刻的数据构建因子。滚动窗口按标的和休市段隔离，
 * `center=false` 且 funding 只按当前或更早的整点样本映射，因此不会引用未来 bar。
 */
export function buildFactorRows(input: BuildFactorRowsInput): FactorBuildResult {
  const candlesBySymbol = new Map<string, CandleBar[]>();
  for (const symbol of input.symbols) candlesBySymbol.set(symbol, []);
  for (const bar of input.candles) {
    const rows = candlesBySymbol.get(bar.symbol);
    if (rows) rows.push(bar);
  }
  for (const rows of candlesBySymbol.values()) rows.sort((a, b) => a.timestamp - b.timestamp);

  const stocks = new Map<string, StockDailyBar>();
  for (const bar of input.stockDaily) stocks.set(key(bar.ticker, bar.tradeDate), bar);
  const funding = new Map<string, number>();
  for (const row of input.funding) funding.set(key(row.symbol, row.timestamp), row.fundingRate);

  const baseRows: BaseFactorRow[] = [];
  const audits: SessionAudit[] = [];
  for (const window of input.windows) {
    for (const symbol of input.symbols) {
      const ticker = tickerOf(symbol);
      const bars = candlesBySymbol.get(symbol) ?? [];
      const sessionStock = stocks.get(key(ticker, window.sessionDate)) ?? null;
      const cutoff = Math.min(window.windowEnd, input.dataCutoff ?? window.windowEnd);
      const sessionComplete = cutoff >= window.windowEnd;
      const windowBars = bars.filter((bar) => bar.timestamp >= window.windowStart
        && bar.timestamp < window.windowEnd
        && bar.closeTimestamp <= cutoff);
      const hlSessionClosePrice = lastClosedPrice(bars, window.sessionCloseAt);
      const referencePrice = input.config.referenceMode === 'hl_session_close'
        ? hlSessionClosePrice
        : sessionStock?.close ?? null;
      const mismatch = sessionStock && hlSessionClosePrice !== null && sessionStock.close > 0
        ? (hlSessionClosePrice - sessionStock.close) / sessionStock.close
        : null;
      const elapsedExpectedBars = sessionComplete
        ? window.expectedBars
        : Math.max(0, Math.floor((cutoff - window.windowStart) / BAR_MS));
      const coverage = elapsedExpectedBars > 0 ? windowBars.length / elapsedExpectedBars : 0;
      const status = referencePrice === null || referencePrice <= 0
        ? 'no_reference' as const
        : mismatch !== null && Math.abs(mismatch) > input.config.referenceMismatchLimit
          ? 'reference_mismatch' as const
          : windowBars.length === 0
            ? 'no_bars' as const
            : coverage < input.config.minSessionCoverage
              ? 'insufficient_coverage' as const
              : 'ok' as const;
      audits.push({
        symbol,
        ticker,
        sessionDate: window.sessionDate,
        nextTradeDate: window.nextTradeDate,
        windowStart: window.windowStart,
        windowEnd: window.windowEnd,
        expectedBars: elapsedExpectedBars,
        barCount: windowBars.length,
        coverage,
        status,
        referencePrice,
        stockClose: sessionStock?.close ?? null,
        hlSessionClosePrice,
        referenceMismatch: mismatch
      });
      const retainForPaper = status === 'insufficient_coverage' && input.retainInsufficientCoverageRows;
      if ((status !== 'ok' && !retainForPaper) || referencePrice === null) continue;

      for (let index = 0; index < windowBars.length; index += 1) {
        const bar = windowBars[index]!;
        const deviation = (bar.close - referencePrice) / referencePrice;
        const fundingTimestamp = Math.floor(bar.timestamp / HOUR_MS) * HOUR_MS;
        const fundingRate = funding.get(key(symbol, fundingTimestamp));
        baseRows.push({
          symbol,
          ticker,
          sessionDate: window.sessionDate,
          nextTradeDate: window.nextTradeDate,
          windowStart: window.windowStart,
          windowEnd: window.windowEnd,
          timestamp: bar.timestamp,
          isSessionLast: sessionComplete && index === windowBars.length - 1,
          close: bar.close,
          referencePrice,
          deviation,
          direction: deviation >= 0 ? 1 : -1,
          fundingRate: fundingRate ?? 0,
          fundingKnown: fundingRate !== undefined,
          estimatedNotionalVolume: bar.estimatedNotionalVolume,
          sessionReason: status === 'ok' ? 'eligible' : 'insufficient_coverage'
        });
      }
    }
  }

  const statusCounts = new Map<string, number>();
  for (const audit of audits) {
    if (audit.status !== 'ok') statusCounts.set(audit.status, (statusCounts.get(audit.status) ?? 0) + 1);
  }
  const warnings = [...statusCounts.entries()].map(([status, count]) => `${count} 个标的休市段未通过会话校验：${status}`);
  const startTime = input.windows[0]?.windowStart ?? 0;
  const endTime = input.windows.at(-1)?.windowEnd ?? 0;
  if (!baseRows.length) return { rows: [], audits, startTime, endTime, warnings };

  const roundTripCost = 2 * (input.config.feeRate + input.config.slippageBps / 10_000);
  const longitudinal = pl.DataFrame(baseRows)
    .sort(['symbol', 'sessionDate', 'timestamp'])
    .withColumn(
      pl.col('close').log()
        .sub(pl.col('close').shift(input.config.momentumBars).log())
        .over('symbol', 'sessionDate')
        .mul(pl.col('direction'))
        .alias('momentumFactor')
    )
    .withColumn(
      pl.col('close').log()
        .sub(pl.col('close').shift(1).log())
        .over('symbol', 'sessionDate')
        .alias('_logReturn')
    )
    .withColumns(
      pl.col('estimatedNotionalVolume')
        .rollingMean({ windowSize: input.config.liquidityBars, minPeriods: input.config.liquidityBars })
        .over('symbol', 'sessionDate')
        .clip(1e-12, Number.MAX_VALUE)
        .log()
        .alias('liquidityFactor'),
      pl.col('_logReturn')
        .rollingStd({ windowSize: input.config.volatilityBars, minPeriods: input.config.volatilityBars })
        .over('symbol', 'sessionDate')
        .mul(-1)
        .alias('lowVolatilityFactor'),
      pl.col('deviation').abs().sub(input.config.exitDeviation + roundTripCost).alias('deviationFactor'),
      pl.col('fundingRate').mul(pl.col('direction')).mul(-1).alias('fundingCarryFactor')
    );

  const standardized = addCrossSectionalZScores(longitudinal).withColumn(
    pl.col('deviationZ').mul(input.config.factorWeights.deviation)
      .add(pl.col('momentumZ').mul(input.config.factorWeights.momentum))
      .add(pl.col('liquidityZ').mul(input.config.factorWeights.liquidity))
      .add(pl.col('lowVolatilityZ').mul(input.config.factorWeights.lowVolatility))
      .add(pl.col('fundingCarryZ').mul(input.config.factorWeights.fundingCarry))
      .alias('score')
  );

  const rows = standardized.toRecords().map((record): FactorRow => {
    const reason = eligibilityReason(record, input.config);
    return {
      symbol: String(record.symbol),
      ticker: String(record.ticker),
      sessionDate: String(record.sessionDate),
      nextTradeDate: String(record.nextTradeDate),
      windowStart: finiteNumber(record.windowStart),
      windowEnd: finiteNumber(record.windowEnd),
      timestamp: finiteNumber(record.timestamp),
      isSessionLast: Boolean(record.isSessionLast),
      close: finiteNumber(record.close),
      referencePrice: finiteNumber(record.referencePrice),
      deviation: finiteNumber(record.deviation),
      direction: finiteNumber(record.direction) >= 0 ? 1 : -1,
      fundingRate: finiteNumber(record.fundingRate),
      fundingKnown: Boolean(record.fundingKnown),
      estimatedNotionalVolume: finiteNumber(record.estimatedNotionalVolume),
      deviationFactor: finiteNumber(record.deviationFactor),
      momentumFactor: finiteNumber(record.momentumFactor, Number.NaN),
      liquidityFactor: finiteNumber(record.liquidityFactor, Number.NaN),
      lowVolatilityFactor: finiteNumber(record.lowVolatilityFactor, Number.NaN),
      fundingCarryFactor: finiteNumber(record.fundingCarryFactor),
      deviationZ: finiteNumber(record.deviationZ),
      momentumZ: finiteNumber(record.momentumZ),
      liquidityZ: finiteNumber(record.liquidityZ),
      lowVolatilityZ: finiteNumber(record.lowVolatilityZ),
      fundingCarryZ: finiteNumber(record.fundingCarryZ),
      score: finiteNumber(record.score),
      rank: 0,
      eligible: reason === 'eligible',
      eligibilityReason: reason
    };
  });
  rows.sort((a, b) => a.timestamp - b.timestamp || a.symbol.localeCompare(b.symbol));
  assignRanks(rows);
  return { rows, audits, startTime, endTime, warnings };
}
