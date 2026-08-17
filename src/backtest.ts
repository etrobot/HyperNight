import { FEATURE_ENGINE_VERSION, STRATEGY_VERSION, normalizeSymbols } from './constants.js';
import { loadFactorData } from './analysis-data.js';
import type { HyperNightDb } from './db.js';
import { computePerformanceMetrics, openPosition, stepPosition } from './simulator.js';
import type {
  BacktestResult,
  EquityPoint,
  FactorBuildResult,
  FactorRow,
  PositionState,
  StrategyConfig,
  Trade
} from './types.js';

export interface BacktestOptions {
  symbols?: string[];
  startTime?: number;
  endTime?: number;
  config: StrategyConfig;
}

export interface EntrySignal {
  symbol: string;
  sessionDate: string;
  timestamp: number;
  score: number;
  rank: number;
}

export interface PortfolioSimulation {
  trades: Trade[];
  sessionPnls: Map<string, number>;
  entrySignals: EntrySignal[];
  maxConcurrentPositions: number;
}

function groupRows(rows: FactorRow[]): Map<string, FactorRow[]> {
  const sessions = new Map<string, FactorRow[]>();
  for (const row of rows) {
    const existing = sessions.get(row.sessionDate) ?? [];
    existing.push(row);
    sessions.set(row.sessionDate, existing);
  }
  for (const values of sessions.values()) values.sort((a, b) => a.timestamp - b.timestamp || a.symbol.localeCompare(b.symbol));
  return sessions;
}

function groupSignals(signals: EntrySignal[]): Map<string, EntrySignal[]> {
  const output = new Map<string, EntrySignal[]>();
  for (const signal of signals) {
    const id = `${signal.sessionDate}|${signal.timestamp}`;
    const values = output.get(id) ?? [];
    values.push(signal);
    output.set(id, values);
  }
  return output;
}

/**
 * 组合级逐 bar 状态机。主组合产生截面入场清单；影子组合传入同一清单，
 * 因而只改变是否对冲，不改变任何入场信号。
 */
export function simulatePortfolio(
  rows: FactorRow[],
  config: StrategyConfig,
  hedgeEnabled: boolean,
  fixedSignals?: EntrySignal[]
): PortfolioSimulation {
  const grossLimit = config.initialCapital * config.grossNotionalPct;
  const reservedPerPosition = Math.max(config.maxCoreNotional, config.maxNotional);
  const capacityByNotional = reservedPerPosition > 0 ? Math.floor(grossLimit / reservedPerPosition) : 0;
  const capacity = Math.max(0, Math.min(config.maxPositions, capacityByNotional));
  const sessions = groupRows(rows);
  const fixedByTimestamp = groupSignals(fixedSignals ?? []);
  const trades: Trade[] = [];
  const sessionPnls = new Map<string, number>();
  const entrySignals: EntrySignal[] = [];
  let maxConcurrentPositions = 0;

  for (const [sessionDate, sessionRows] of [...sessions.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const byTimestamp = new Map<number, FactorRow[]>();
    for (const row of sessionRows) {
      const values = byTimestamp.get(row.timestamp) ?? [];
      values.push(row);
      byTimestamp.set(row.timestamp, values);
    }
    const positions = new Map<string, PositionState>();
    const enteredSymbols = new Set<string>();
    const sessionTrades: Trade[] = [];

    for (const timestamp of [...byTimestamp.keys()].sort((a, b) => a - b)) {
      const timestampRows = byTimestamp.get(timestamp)!;
      const rowBySymbol = new Map(timestampRows.map((row) => [row.symbol, row]));

      // 先退出和调仓，再让腾出的账户槽位参与本 bar 的截面选择。
      for (const [symbol, position] of [...positions.entries()]) {
        const row = rowBySymbol.get(symbol);
        if (!row) continue;
        const stepped = stepPosition(position, row, config, hedgeEnabled);
        if (stepped.trade) {
          positions.delete(symbol);
          trades.push(stepped.trade);
          sessionTrades.push(stepped.trade);
        } else if (stepped.position) {
          positions.set(symbol, stepped.position);
        }
      }

      if (fixedSignals) {
        const signals = fixedByTimestamp.get(`${sessionDate}|${timestamp}`) ?? [];
        for (const signal of signals) {
          if (positions.has(signal.symbol)) continue;
          const row = rowBySymbol.get(signal.symbol);
          if (!row || row.isSessionLast) continue;
          positions.set(signal.symbol, openPosition({ ...row, score: signal.score, rank: signal.rank }, config));
          enteredSymbols.add(signal.symbol);
        }
      } else {
        const slots = capacity - positions.size;
        if (slots > 0) {
          const candidates = timestampRows
            .filter((row) => row.eligible && !row.isSessionLast && !enteredSymbols.has(row.symbol))
            .sort((a, b) => b.score - a.score || a.rank - b.rank || a.symbol.localeCompare(b.symbol));
          for (const row of candidates.slice(0, slots)) {
            positions.set(row.symbol, openPosition(row, config));
            enteredSymbols.add(row.symbol);
            const signal = {
              symbol: row.symbol,
              sessionDate,
              timestamp,
              score: row.score,
              rank: row.rank
            };
            entrySignals.push(signal);
          }
        }
      }
      maxConcurrentPositions = Math.max(maxConcurrentPositions, positions.size);
    }
    sessionPnls.set(sessionDate, sessionTrades.reduce((sum, trade) => sum + trade.pnl, 0));
  }

  trades.sort((a, b) => a.exitTimestamp - b.exitTimestamp || a.symbol.localeCompare(b.symbol));
  return { trades, sessionPnls, entrySignals, maxConcurrentPositions };
}

function resultFromFactors(runId: string, symbols: string[], factors: FactorBuildResult, config: StrategyConfig): BacktestResult {
  const primary = simulatePortfolio(factors.rows, config, true);
  const shadow = simulatePortfolio(factors.rows, config, false, primary.entrySignals);
  const sessionWindows = new Map<string, { timestamp: number; sessionDate: string }>();
  for (const audit of factors.audits) {
    sessionWindows.set(audit.sessionDate, { timestamp: audit.windowEnd, sessionDate: audit.sessionDate });
  }
  const orderedSessions = [...sessionWindows.values()].sort((a, b) => a.timestamp - b.timestamp);
  const primaryPnls = orderedSessions.map((session) => primary.sessionPnls.get(session.sessionDate) ?? 0);
  const shadowPnls = orderedSessions.map((session) => shadow.sessionPnls.get(session.sessionDate) ?? 0);
  const equity: EquityPoint[] = [];
  let portfolioEquity = config.initialCapital;
  let noHedgeEquity = config.initialCapital;
  for (let index = 0; index < orderedSessions.length; index += 1) {
    const session = orderedSessions[index]!;
    portfolioEquity += primaryPnls[index] ?? 0;
    noHedgeEquity += shadowPnls[index] ?? 0;
    equity.push({
      timestamp: session.timestamp,
      sessionDate: session.sessionDate,
      equity: portfolioEquity,
      noHedgeEquity,
      openPositions: 0
    });
  }

  const warnings = [...factors.warnings];
  if (orderedSessions.length < 20) warnings.push(`只有 ${orderedSessions.length} 个完整休市段，样本不具统计意义`);
  const reservedPerPosition = Math.max(config.maxCoreNotional, config.maxNotional);
  if (reservedPerPosition > config.initialCapital * config.grossNotionalPct) {
    warnings.push('单仓预留敞口高于组合毛名义上限，当前配置不会产生交易');
  }
  return {
    runId,
    generatedAt: new Date().toISOString(),
    strategyVersion: STRATEGY_VERSION,
    featureEngineVersion: FEATURE_ENGINE_VERSION,
    config,
    symbols,
    startTime: factors.startTime,
    endTime: factors.endTime,
    trades: primary.trades,
    noHedgeTrades: shadow.trades,
    equity,
    portfolio: computePerformanceMetrics(primary.trades, primaryPnls, config.initialCapital),
    noHedgePortfolio: computePerformanceMetrics(shadow.trades, shadowPnls, config.initialCapital),
    maxConcurrentPositions: primary.maxConcurrentPositions,
    warnings
  };
}

export function runBacktest(database: HyperNightDb, options: BacktestOptions): BacktestResult {
  const symbols = normalizeSymbols(options.symbols);
  const runId = database.createRun('backtest', options.config);
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

/** 供参数评估与隔离测试复用，不触碰 SQLite run 状态。 */
export function backtestFactorRows(
  rows: FactorRow[],
  config: StrategyConfig,
  symbols = [...new Set(rows.map((row) => row.symbol))]
): BacktestResult {
  const audits = [...new Map(rows.map((row) => [
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
  ])).values()];
  return resultFromFactors(
    'in-memory-backtest-evaluation',
    symbols,
    {
      rows,
      audits,
      startTime: rows[0]?.windowStart ?? 0,
      endTime: rows.at(-1)?.windowEnd ?? 0,
      warnings: []
    },
    config
  );
}
