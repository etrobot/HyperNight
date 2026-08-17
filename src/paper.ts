import { loadFactorData } from './analysis-data.js';
import { normalizeSymbols } from './constants.js';
import type { HyperNightDb } from './db.js';
import { markPosition, openPosition, stepPosition } from './simulator.js';
import type {
  FactorRow,
  PaperAccount,
  PaperStatus,
  PaperTickResult,
  PositionState,
  StrategyConfig,
  Trade
} from './types.js';

export interface PaperInitOptions {
  symbols?: string[];
  startAfterTimestamp?: number | null;
  startAtLatest?: boolean;
}

export interface PaperTickOptions {
  symbols?: string[];
  endTime?: number;
}

function reservedCapacity(config: StrategyConfig): number {
  const reserved = Math.max(config.maxCoreNotional, config.maxNotional);
  if (!(reserved > 0)) return 0;
  return Math.max(0, Math.min(config.maxPositions, Math.floor(config.initialCapital * config.grossNotionalPct / reserved)));
}

function normalizePersistedPosition(position: PositionState): PositionState {
  return {
    ...position,
    lastMarkPrice: Number.isFinite(position.lastMarkPrice) ? position.lastMarkPrice : position.corePrice,
    lastMarkTimestamp: Number.isFinite(position.lastMarkTimestamp) ? position.lastMarkTimestamp : position.entryTimestamp
  };
}

function accountEquity(account: PaperAccount, positions: PositionState[]): { equity: number; unrealizedPnl: number } {
  const unrealizedPnl = positions.reduce(
    (sum, position) => sum + markPosition(position, position.lastMarkPrice, account.config).netPnl,
    0
  );
  return { equity: account.cash + unrealizedPnl, unrealizedPnl };
}

export function initializePaperAccount(
  database: HyperNightDb,
  config: StrategyConfig,
  options: PaperInitOptions = {}
): PaperAccount {
  const symbols = normalizeSymbols(options.symbols);
  const account = database.resetPaperAccount(config.initialCapital, config);
  if (options.startAfterTimestamp !== undefined) {
    account.lastProcessedTimestamp = options.startAfterTimestamp;
  } else if (options.startAtLatest !== false) {
    account.lastProcessedTimestamp = database.latestCandleTimestamp(symbols, '5m');
  }
  account.updatedAt = Date.now();
  database.updatePaperAccount(account);
  return account;
}

export function paperStatus(database: HyperNightDb): PaperStatus {
  const account = database.paperAccount();
  if (!account) return { account: null, positions: [], trades: [], equity: [] };
  return {
    account,
    positions: database.paperPositions(account.id).map(normalizePersistedPosition),
    trades: database.paperTrades(account.id),
    equity: database.paperEquity(account.id)
  };
}

export function tickPaperRows(
  database: HyperNightDb,
  rows: FactorRow[],
  warnings: string[] = []
): PaperTickResult {
  const account = database.paperAccount();
  if (!account) throw new Error('模拟账户尚未初始化，请先运行 paper:init');
  const positions = new Map(
    database.paperPositions(account.id).map(normalizePersistedPosition).map((position) => [position.symbol, position])
  );
  const entered = new Set<string>();
  for (const position of positions.values()) entered.add(`${position.sessionDate}|${position.symbol}`);
  for (const trade of database.paperTrades(account.id, 100_000)) entered.add(`${trade.sessionDate}|${trade.symbol}`);

  const pendingRows = rows.filter(
    (row) => account.lastProcessedTimestamp === null || row.timestamp > account.lastProcessedTimestamp
  );
  const byTimestamp = new Map<number, FactorRow[]>();
  for (const row of pendingRows) {
    const values = byTimestamp.get(row.timestamp) ?? [];
    values.push(row);
    byTimestamp.set(row.timestamp, values);
  }
  const capacity = reservedCapacity(account.config);
  let openedPositions = 0;
  let closedTrades = 0;
  let processedBars = 0;

  for (const timestamp of [...byTimestamp.keys()].sort((a, b) => a - b)) {
    const timestampRows = byTimestamp.get(timestamp)!;
    timestampRows.sort((a, b) => a.symbol.localeCompare(b.symbol));
    processedBars += timestampRows.length;
    const rowBySymbol = new Map(timestampRows.map((row) => [row.symbol, row]));
    const justClosed: Trade[] = [];

    for (const [symbol, position] of [...positions.entries()]) {
      const row = rowBySymbol.get(symbol);
      if (!row) continue;
      const stepped = stepPosition(position, row, account.config, true);
      if (stepped.trade) {
        positions.delete(symbol);
        justClosed.push(stepped.trade);
        account.cash += stepped.trade.pnl;
        account.realizedPnl += stepped.trade.pnl;
        account.feesPaid += stepped.trade.fees;
        account.fundingPaid += stepped.trade.funding;
        account.slippagePaid += stepped.trade.slippage;
        closedTrades += 1;
      } else if (stepped.position) {
        positions.set(symbol, stepped.position);
      }
    }

    const slots = capacity - positions.size;
    if (slots > 0) {
      const candidates = timestampRows
        .filter((row) => row.eligible && !row.isSessionLast && !positions.has(row.symbol)
          && !entered.has(`${row.sessionDate}|${row.symbol}`))
        .sort((a, b) => b.score - a.score || a.rank - b.rank || a.symbol.localeCompare(b.symbol));
      for (const row of candidates.slice(0, slots)) {
        positions.set(row.symbol, openPosition(row, account.config));
        entered.add(`${row.sessionDate}|${row.symbol}`);
        openedPositions += 1;
      }
    }

    account.lastProcessedTimestamp = timestamp;
    account.updatedAt = Date.now();
    const openPositions = [...positions.values()];
    const marked = accountEquity(account, openPositions);
    database.savePaperTick(account, openPositions, justClosed, {
      timestamp,
      cash: account.cash,
      equity: marked.equity,
      unrealizedPnl: marked.unrealizedPnl,
      openPositions: openPositions.length
    });
  }

  const marked = accountEquity(account, [...positions.values()]);
  return {
    accountId: account.id,
    processedBars,
    openedPositions,
    closedTrades,
    lastProcessedTimestamp: account.lastProcessedTimestamp,
    equity: marked.equity,
    warnings
  };
}

export function tickPaper(database: HyperNightDb, options: PaperTickOptions = {}): PaperTickResult {
  const account = database.paperAccount();
  if (!account) throw new Error('模拟账户尚未初始化，请先运行 paper:init');
  const symbols = normalizeSymbols(options.symbols);
  const factors = loadFactorData(database, {
    symbols,
    config: account.config,
    includeOpenWindow: true,
    ...(options.endTime === undefined ? {} : { endTime: options.endTime })
  });
  return tickPaperRows(database, factors.rows, factors.warnings);
}
