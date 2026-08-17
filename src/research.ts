import { BAR_MS, FEATURE_ENGINE_VERSION, STRATEGY_VERSION, normalizeSymbols } from './constants.js';
import { loadFactorData } from './analysis-data.js';
import type { HyperNightDb } from './db.js';
import type {
  FactorBuildResult,
  FactorMetric,
  FactorRow,
  FactorWeights,
  ResearchResult,
  StrategyConfig
} from './types.js';

export interface ResearchOptions {
  symbols?: string[];
  startTime?: number;
  endTime?: number;
  config: StrategyConfig;
}

interface ForwardObservation {
  row: FactorRow;
  forwardReturn: number;
}

const FACTOR_FIELDS: Array<{ factor: keyof FactorWeights | 'score'; field: keyof FactorRow }> = [
  { factor: 'deviation', field: 'deviationFactor' },
  { factor: 'momentum', field: 'momentumFactor' },
  { factor: 'liquidity', field: 'liquidityFactor' },
  { factor: 'lowVolatility', field: 'lowVolatilityFactor' },
  { factor: 'fundingCarry', field: 'fundingCarryFactor' },
  { factor: 'score', field: 'score' }
];

function average(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function ranks(values: number[]): number[] {
  const indexed = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value || a.index - b.index);
  const output = new Array<number>(values.length);
  let cursor = 0;
  while (cursor < indexed.length) {
    let end = cursor + 1;
    while (end < indexed.length && indexed[end]!.value === indexed[cursor]!.value) end += 1;
    const rank = (cursor + 1 + end) / 2;
    for (let index = cursor; index < end; index += 1) output[indexed[index]!.index] = rank;
    cursor = end;
  }
  return output;
}

function correlation(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 3) return null;
  const meanX = average(xs)!;
  const meanY = average(ys)!;
  let covariance = 0;
  let varianceX = 0;
  let varianceY = 0;
  for (let index = 0; index < xs.length; index += 1) {
    const dx = xs[index]! - meanX;
    const dy = ys[index]! - meanY;
    covariance += dx * dy;
    varianceX += dx * dx;
    varianceY += dy * dy;
  }
  return varianceX > 0 && varianceY > 0 ? covariance / Math.sqrt(varianceX * varianceY) : null;
}

function observations(rows: FactorRow[]): ForwardObservation[] {
  const bySeries = new Map<string, FactorRow[]>();
  for (const row of rows) {
    const id = `${row.symbol}|${row.sessionDate}`;
    const values = bySeries.get(id) ?? [];
    values.push(row);
    bySeries.set(id, values);
  }
  const output: ForwardObservation[] = [];
  for (const values of bySeries.values()) {
    values.sort((a, b) => a.timestamp - b.timestamp);
    for (let index = 0; index + 1 < values.length; index += 1) {
      const row = values[index]!;
      const next = values[index + 1]!;
      if (row.eligibilityReason === 'warmup' || next.timestamp - row.timestamp !== BAR_MS || !(row.close > 0)) continue;
      output.push({ row, forwardReturn: row.direction * (next.close / row.close - 1) });
    }
  }
  return output;
}

function factorMetrics(values: ForwardObservation[]): FactorMetric[] {
  const byTimestamp = new Map<number, ForwardObservation[]>();
  for (const value of values) {
    const rows = byTimestamp.get(value.row.timestamp) ?? [];
    rows.push(value);
    byTimestamp.set(value.row.timestamp, rows);
  }
  return FACTOR_FIELDS.map(({ factor, field }) => {
    const ics: number[] = [];
    for (const rows of byTimestamp.values()) {
      const valid = rows.filter((item) => Number.isFinite(Number(item.row[field])) && Number.isFinite(item.forwardReturn));
      if (valid.length < 3) continue;
      const factorRanks = ranks(valid.map((item) => Number(item.row[field])));
      const returnRanks = ranks(valid.map((item) => item.forwardReturn));
      const ic = correlation(factorRanks, returnRanks);
      if (ic !== null) ics.push(ic);
    }
    return {
      factor,
      meanRankIc: average(ics),
      positiveIcRate: ics.length ? ics.filter((value) => value > 0).length / ics.length : null,
      observations: ics.length
    };
  });
}

function resultFromFactors(
  runId: string,
  symbols: string[],
  factors: FactorBuildResult,
  config: StrategyConfig
): ResearchResult {
  const forward = observations(factors.rows);
  const eligibleForward = forward.filter((item) => item.row.eligible);
  const latestTimestamp = factors.rows.reduce((latest, row) => Math.max(latest, row.timestamp), 0);
  const latestScores = factors.rows
    .filter((row) => row.timestamp === latestTimestamp)
    .sort((a, b) => Number(b.eligible) - Number(a.eligible) || a.rank - b.rank || b.score - a.score)
    .slice(0, 50);
  const topReturns = eligibleForward
    .filter((item) => item.row.rank > 0 && item.row.rank <= config.maxPositions)
    .map((item) => item.forwardReturn);
  const allReturns = eligibleForward.map((item) => item.forwardReturn);
  const sessionCount = new Set(factors.audits.filter((audit) => audit.status === 'ok').map((audit) => audit.sessionDate)).size;
  const warnings = [...factors.warnings];
  if (sessionCount < 20) warnings.push(`只有 ${sessionCount} 个有效休市段，IC 与收益均不具统计意义`);
  if (!forward.length) warnings.push('没有满足严格相邻 5m 条件的前向收益观测');
  return {
    runId,
    generatedAt: new Date().toISOString(),
    strategyVersion: STRATEGY_VERSION,
    featureEngineVersion: FEATURE_ENGINE_VERSION,
    config,
    symbols,
    startTime: factors.startTime,
    endTime: factors.endTime,
    rowCount: factors.rows.length,
    eligibleCount: factors.rows.filter((row) => row.eligible).length,
    sessionCount,
    factorMetrics: factorMetrics(forward),
    topScoreForwardReturnPct: topReturns.length ? average(topReturns)! * 100 : null,
    allForwardReturnPct: allReturns.length ? average(allReturns)! * 100 : null,
    latestScores,
    warnings
  };
}

export function runResearch(database: HyperNightDb, options: ResearchOptions): ResearchResult {
  const symbols = normalizeSymbols(options.symbols);
  const runId = database.createRun('research', options.config);
  try {
    const factors = loadFactorData(database, { ...options, symbols });
    database.saveFactorRows(runId, factors.rows);
    const result = resultFromFactors(runId, symbols, factors, options.config);
    database.finishRun(runId, result);
    return result;
  } catch (error) {
    database.failRun(runId, error);
    throw error;
  }
}

export function researchFactorRows(
  rows: FactorRow[],
  config: StrategyConfig,
  symbols = [...new Set(rows.map((row) => row.symbol))]
): ResearchResult {
  const factors: FactorBuildResult = {
    rows,
    audits: [...new Map(rows.map((row) => [
      `${row.symbol}|${row.sessionDate}`,
      {
        symbol: row.symbol,
        ticker: row.ticker,
        sessionDate: row.sessionDate,
        nextTradeDate: row.nextTradeDate,
        windowStart: row.windowStart,
        windowEnd: row.windowEnd,
        expectedBars: 0,
        barCount: 0,
        coverage: 1,
        status: 'ok' as const,
        referencePrice: row.referencePrice,
        stockClose: row.referencePrice,
        hlSessionClosePrice: row.referencePrice,
        referenceMismatch: 0
      }
    ])).values()],
    startTime: rows[0]?.windowStart ?? 0,
    endTime: rows.at(-1)?.windowEnd ?? 0,
    warnings: []
  };
  return resultFromFactors('in-memory-research-evaluation', symbols, factors, config);
}
