import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { SCHEMA_VERSION } from './constants.js';
import type {
  CandleBar,
  CandleInterval,
  FactorRow,
  FundingBar,
  MarketDataAudit,
  MarketContext,
  PaperAccount,
  PositionState,
  StockDailyBar,
  StrategyConfig,
  Trade
} from './types.js';

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS market_contexts (
    symbol TEXT NOT NULL,
    captured_at INTEGER NOT NULL,
    mark_px REAL NOT NULL,
    mid_px REAL,
    funding REAL,
    open_interest REAL,
    day_notional_volume REAL NOT NULL,
    impact_bid_px REAL,
    impact_ask_px REAL,
    PRIMARY KEY (symbol, captured_at)
  );

  CREATE TABLE IF NOT EXISTS candles_5m (
    symbol TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    close_timestamp INTEGER NOT NULL,
    open REAL NOT NULL,
    high REAL NOT NULL,
    low REAL NOT NULL,
    close REAL NOT NULL,
    volume REAL NOT NULL,
    estimated_notional_volume REAL NOT NULL,
    source TEXT NOT NULL DEFAULT 'hyperliquid-5m',
    PRIMARY KEY (symbol, timestamp)
  );

  CREATE TABLE IF NOT EXISTS candles_1d (
    symbol TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    close_timestamp INTEGER NOT NULL,
    open REAL NOT NULL,
    high REAL NOT NULL,
    low REAL NOT NULL,
    close REAL NOT NULL,
    volume REAL NOT NULL,
    estimated_notional_volume REAL NOT NULL,
    source TEXT NOT NULL DEFAULT 'hyperliquid-1d',
    PRIMARY KEY (symbol, timestamp)
  );

  CREATE TABLE IF NOT EXISTS stock_daily_candles (
    ticker TEXT NOT NULL,
    trade_date TEXT NOT NULL,
    open REAL NOT NULL,
    close REAL NOT NULL,
    high REAL NOT NULL,
    low REAL NOT NULL,
    volume REAL NOT NULL,
    quote_code TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'qq-usfqkline',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (ticker, trade_date)
  );

  CREATE TABLE IF NOT EXISTS funding_rates (
    symbol TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    funding_rate REAL NOT NULL,
    source TEXT NOT NULL DEFAULT 'hyperliquid-funding',
    PRIMARY KEY (symbol, timestamp)
  );

  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    config_json TEXT NOT NULL,
    result_json TEXT,
    error TEXT
  );

  CREATE TABLE IF NOT EXISTS factor_scores (
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    symbol TEXT NOT NULL,
    session_date TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    score REAL NOT NULL,
    rank INTEGER NOT NULL,
    eligible INTEGER NOT NULL,
    factors_json TEXT NOT NULL,
    PRIMARY KEY (run_id, symbol, timestamp)
  );

  CREATE TABLE IF NOT EXISTS paper_accounts (
    id TEXT PRIMARY KEY,
    initial_capital REAL NOT NULL,
    cash REAL NOT NULL,
    realized_pnl REAL NOT NULL,
    fees_paid REAL NOT NULL,
    funding_paid REAL NOT NULL,
    slippage_paid REAL NOT NULL,
    last_processed_timestamp INTEGER,
    config_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS paper_positions (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES paper_accounts(id) ON DELETE CASCADE,
    symbol TEXT NOT NULL,
    state_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (account_id, symbol)
  );

  CREATE TABLE IF NOT EXISTS paper_trades (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES paper_accounts(id) ON DELETE CASCADE,
    symbol TEXT NOT NULL,
    exit_timestamp INTEGER NOT NULL,
    trade_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS paper_equity (
    account_id TEXT NOT NULL REFERENCES paper_accounts(id) ON DELETE CASCADE,
    timestamp INTEGER NOT NULL,
    cash REAL NOT NULL,
    equity REAL NOT NULL,
    unrealized_pnl REAL NOT NULL,
    open_positions INTEGER NOT NULL,
    PRIMARY KEY (account_id, timestamp)
  );

  CREATE INDEX IF NOT EXISTS candles_5m_time_symbol_idx ON candles_5m(timestamp, symbol);
  CREATE INDEX IF NOT EXISTS candles_1d_time_symbol_idx ON candles_1d(timestamp, symbol);
  CREATE INDEX IF NOT EXISTS stock_daily_date_ticker_idx ON stock_daily_candles(trade_date, ticker);
  CREATE INDEX IF NOT EXISTS funding_time_symbol_idx ON funding_rates(timestamp, symbol);
  CREATE INDEX IF NOT EXISTS factor_scores_time_rank_idx ON factor_scores(run_id, timestamp, rank);
  CREATE INDEX IF NOT EXISTS runs_kind_time_idx ON runs(kind, created_at DESC);
`;

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}

export class HyperNightDb {
  readonly db: DatabaseSync;
  readonly path: string;

  constructor(path: string) {
    this.path = path === ':memory:' ? path : resolve(path);
    if (path !== ':memory:') mkdirSync(dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 8000');
    this.db.exec(SCHEMA_SQL);
    const row = this.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value?: string } | undefined;
    if (row?.value !== undefined && Number(row.value) !== SCHEMA_VERSION) {
      this.close();
      throw new Error(`HyperNight SQLite schema ${row.value} 与代码要求 ${SCHEMA_VERSION} 不一致`);
    }
    this.db.prepare(`
      INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(SCHEMA_VERSION));
    this.db.prepare(`
      UPDATE runs
      SET status = 'failed', updated_at = ?, error = COALESCE(error, '进程在任务完成前中断')
      WHERE status = 'running'
    `).run(Date.now());
  }

  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* retain original error */ }
      throw error;
    }
  }

  upsertCandles(interval: CandleInterval, rows: CandleBar[]): number {
    if (!rows.length) return 0;
    const table = interval === '5m' ? 'candles_5m' : 'candles_1d';
    const statement = this.db.prepare(`
      INSERT INTO ${table}
        (symbol, timestamp, close_timestamp, open, high, low, close, volume, estimated_notional_volume, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(symbol, timestamp) DO UPDATE SET
        close_timestamp = excluded.close_timestamp,
        open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close,
        volume = excluded.volume, estimated_notional_volume = excluded.estimated_notional_volume,
        source = excluded.source
    `);
    return this.transaction(() => {
      for (const row of rows) statement.run(
        row.symbol, row.timestamp, row.closeTimestamp, row.open, row.high, row.low, row.close,
        row.volume, row.estimatedNotionalVolume, row.source ?? `hyperliquid-${interval}`
      );
      return rows.length;
    });
  }

  upsertStockDaily(rows: StockDailyBar[], quoteCode: string, now = Date.now()): number {
    if (!rows.length) return 0;
    const statement = this.db.prepare(`
      INSERT INTO stock_daily_candles
        (ticker, trade_date, open, close, high, low, volume, quote_code, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ticker, trade_date) DO UPDATE SET
        open = excluded.open, close = excluded.close, high = excluded.high, low = excluded.low,
        volume = excluded.volume, quote_code = excluded.quote_code, updated_at = excluded.updated_at
    `);
    return this.transaction(() => {
      for (const row of rows) statement.run(
        row.ticker, row.tradeDate, row.open, row.close, row.high, row.low, row.volume, quoteCode, now
      );
      return rows.length;
    });
  }

  upsertFunding(rows: FundingBar[]): number {
    if (!rows.length) return 0;
    const statement = this.db.prepare(`
      INSERT INTO funding_rates (symbol, timestamp, funding_rate)
      VALUES (?, ?, ?)
      ON CONFLICT(symbol, timestamp) DO UPDATE SET funding_rate = excluded.funding_rate
    `);
    return this.transaction(() => {
      for (const row of rows) statement.run(row.symbol, row.timestamp, row.fundingRate);
      return rows.length;
    });
  }

  saveMarketContexts(rows: MarketContext[]): number {
    if (!rows.length) return 0;
    const statement = this.db.prepare(`
      INSERT INTO market_contexts
        (symbol, captured_at, mark_px, mid_px, funding, open_interest, day_notional_volume, impact_bid_px, impact_ask_px)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(symbol, captured_at) DO UPDATE SET
        mark_px = excluded.mark_px, mid_px = excluded.mid_px, funding = excluded.funding,
        open_interest = excluded.open_interest, day_notional_volume = excluded.day_notional_volume,
        impact_bid_px = excluded.impact_bid_px, impact_ask_px = excluded.impact_ask_px
    `);
    return this.transaction(() => {
      for (const row of rows) statement.run(
        row.symbol, row.capturedAt, row.markPx, row.midPx, row.funding, row.openInterest,
        row.dayNotionalVolume, row.impactBidPx, row.impactAskPx
      );
      return rows.length;
    });
  }

  candles(symbols: string[], startTime: number, endTime: number, interval: CandleInterval = '5m'): CandleBar[] {
    if (!symbols.length) return [];
    const table = interval === '5m' ? 'candles_5m' : 'candles_1d';
    return this.db.prepare(`
      SELECT symbol, timestamp, close_timestamp AS closeTimestamp, open, high, low, close, volume,
             estimated_notional_volume AS estimatedNotionalVolume, source
      FROM ${table}
      WHERE symbol IN (${placeholders(symbols.length)}) AND timestamp >= ? AND timestamp < ?
      ORDER BY timestamp ASC, symbol ASC
    `).all(...symbols, startTime, endTime) as unknown as CandleBar[];
  }

  candleBounds(symbols: string[], interval: CandleInterval = '5m'): { startTime: number; endTime: number; rowCount: number } | null {
    if (!symbols.length) return null;
    const table = interval === '5m' ? 'candles_5m' : 'candles_1d';
    const row = this.db.prepare(`
      SELECT MIN(timestamp) AS startTime, MAX(close_timestamp) AS endTime, COUNT(*) AS rowCount
      FROM ${table} WHERE symbol IN (${placeholders(symbols.length)})
    `).get(...symbols) as { startTime: number | null; endTime: number | null; rowCount: number };
    if (row.startTime === null || row.endTime === null || row.rowCount <= 0) return null;
    return { startTime: row.startTime, endTime: row.endTime, rowCount: row.rowCount };
  }

  latestCandleTimestamp(symbols: string[], interval: CandleInterval = '5m'): number | null {
    if (!symbols.length) return null;
    const table = interval === '5m' ? 'candles_5m' : 'candles_1d';
    const row = this.db.prepare(`
      SELECT MAX(timestamp) AS timestamp FROM ${table}
      WHERE symbol IN (${placeholders(symbols.length)})
    `).get(...symbols) as { timestamp: number | null };
    return row.timestamp;
  }

  tableCounts(): Record<string, number> {
    const tables = [
      'market_contexts',
      'candles_5m',
      'candles_1d',
      'stock_daily_candles',
      'funding_rates',
      'runs',
      'factor_scores',
      'paper_positions',
      'paper_trades',
      'paper_equity'
    ];
    return Object.fromEntries(tables.map((table) => {
      const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
      return [table, row.count];
    }));
  }

  symbolCoverage(): Array<{
    symbol: string;
    candleCount5m: number;
    firstTimestamp: number;
    lastTimestamp: number;
  }> {
    return this.db.prepare(`
      SELECT symbol, COUNT(*) AS candleCount5m, MIN(timestamp) AS firstTimestamp, MAX(timestamp) AS lastTimestamp
      FROM candles_5m GROUP BY symbol ORDER BY candleCount5m DESC, symbol ASC
    `).all() as Array<{ symbol: string; candleCount5m: number; firstTimestamp: number; lastTimestamp: number }>;
  }

  marketDataAudit(): MarketDataAudit {
    const sourceCounts = (table: 'candles_5m' | 'candles_1d' | 'stock_daily_candles' | 'funding_rates') => this.db.prepare(`
      SELECT source, COUNT(*) AS rowCount FROM ${table}
      GROUP BY source ORDER BY rowCount DESC, source ASC
    `).all() as Array<{ source: string; rowCount: number }>;
    const sourceTables = ['candles_5m', 'candles_1d', 'stock_daily_candles', 'funding_rates'] as const;
    const syntheticRows = sourceTables.reduce((sum, table) => {
      const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE lower(source) LIKE '%synthetic%'`).get() as { count: number };
      return sum + row.count;
    }, 0);
    return {
      candles5m: sourceCounts('candles_5m'),
      candles1d: sourceCounts('candles_1d'),
      stockDaily: sourceCounts('stock_daily_candles'),
      funding: sourceCounts('funding_rates'),
      syntheticRows
    };
  }

  latestMarketContexts(): MarketContext[] {
    return this.db.prepare(`
      SELECT context.symbol, context.captured_at AS capturedAt, context.mark_px AS markPx,
             context.mid_px AS midPx, context.funding, context.open_interest AS openInterest,
             context.day_notional_volume AS dayNotionalVolume,
             context.impact_bid_px AS impactBidPx, context.impact_ask_px AS impactAskPx
      FROM market_contexts AS context
      JOIN (
        SELECT symbol, MAX(captured_at) AS capturedAt FROM market_contexts GROUP BY symbol
      ) AS latest ON latest.symbol = context.symbol AND latest.capturedAt = context.captured_at
      ORDER BY context.day_notional_volume DESC, context.symbol ASC
    `).all() as unknown as MarketContext[];
  }

  stockDaily(tickers: string[], startDate: string, endDate: string): StockDailyBar[] {
    if (!tickers.length) return [];
    return this.db.prepare(`
      SELECT ticker, trade_date AS tradeDate, open, close, high, low, volume
      FROM stock_daily_candles
      WHERE ticker IN (${placeholders(tickers.length)}) AND trade_date >= ? AND trade_date <= ?
      ORDER BY trade_date ASC, ticker ASC
    `).all(...tickers, startDate, endDate) as unknown as StockDailyBar[];
  }

  funding(symbols: string[], startTime: number, endTime: number): FundingBar[] {
    if (!symbols.length) return [];
    return this.db.prepare(`
      SELECT symbol, timestamp, funding_rate AS fundingRate
      FROM funding_rates
      WHERE symbol IN (${placeholders(symbols.length)}) AND timestamp >= ? AND timestamp < ?
      ORDER BY timestamp ASC, symbol ASC
    `).all(...symbols, startTime, endTime) as unknown as FundingBar[];
  }

  tradingDates(tickers: string[], startDate: string, endDate: string): string[] {
    if (!tickers.length) return [];
    const rows = this.db.prepare(`
      SELECT trade_date AS tradeDate, COUNT(DISTINCT ticker) AS tickerCount
      FROM stock_daily_candles
      WHERE ticker IN (${placeholders(tickers.length)}) AND trade_date >= ? AND trade_date <= ?
      GROUP BY trade_date
      HAVING tickerCount >= ?
      ORDER BY trade_date ASC
    `).all(...tickers, startDate, endDate, Math.max(1, Math.ceil(tickers.length / 2))) as Array<{ tradeDate: string }>;
    return rows.map((row) => row.tradeDate);
  }

  createRun(kind: 'research' | 'backtest' | 'optimization', config: StrategyConfig): string {
    const id = randomUUID();
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO runs (id, kind, status, created_at, updated_at, config_json)
      VALUES (?, ?, 'running', ?, ?, ?)
    `).run(id, kind, now, now, JSON.stringify(config));
    return id;
  }

  finishRun(id: string, result: unknown): void {
    this.db.prepare(`UPDATE runs SET status = 'completed', updated_at = ?, result_json = ?, error = NULL WHERE id = ?`)
      .run(Date.now(), JSON.stringify(result), id);
  }

  failRun(id: string, error: unknown): void {
    this.db.prepare(`UPDATE runs SET status = 'failed', updated_at = ?, error = ? WHERE id = ?`)
      .run(Date.now(), error instanceof Error ? error.message : String(error), id);
  }

  latestRun<T>(kind: 'research' | 'backtest' | 'optimization'): T | null {
    const row = this.db.prepare(`
      SELECT result_json AS resultJson FROM runs
      WHERE kind = ? AND status = 'completed' AND result_json IS NOT NULL
      ORDER BY created_at DESC LIMIT 1
    `).get(kind) as { resultJson?: string } | undefined;
    return row?.resultJson ? JSON.parse(row.resultJson) as T : null;
  }

  saveFactorRows(runId: string, rows: FactorRow[]): void {
    const statement = this.db.prepare(`
      INSERT INTO factor_scores (run_id, symbol, session_date, timestamp, score, rank, eligible, factors_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, symbol, timestamp) DO UPDATE SET
        score = excluded.score, rank = excluded.rank, eligible = excluded.eligible, factors_json = excluded.factors_json
    `);
    this.transaction(() => {
      for (const row of rows) statement.run(
        runId, row.symbol, row.sessionDate, row.timestamp, row.score, row.rank, row.eligible ? 1 : 0,
        JSON.stringify({
          deviation: row.deviationFactor,
          momentum: row.momentumFactor,
          liquidity: row.liquidityFactor,
          lowVolatility: row.lowVolatilityFactor,
          fundingCarry: row.fundingCarryFactor,
          deviationZ: row.deviationZ,
          momentumZ: row.momentumZ,
          liquidityZ: row.liquidityZ,
          lowVolatilityZ: row.lowVolatilityZ,
          fundingCarryZ: row.fundingCarryZ,
          eligibilityReason: row.eligibilityReason
        })
      );
    });
  }

  resetPaperAccount(initialCapital: number, config: StrategyConfig): PaperAccount {
    const now = Date.now();
    const account: PaperAccount = {
      id: 'hypernight-paper',
      initialCapital,
      cash: initialCapital,
      realizedPnl: 0,
      feesPaid: 0,
      fundingPaid: 0,
      slippagePaid: 0,
      lastProcessedTimestamp: null,
      config,
      createdAt: now,
      updatedAt: now
    };
    this.transaction(() => {
      this.db.prepare('DELETE FROM paper_equity').run();
      this.db.prepare('DELETE FROM paper_trades').run();
      this.db.prepare('DELETE FROM paper_positions').run();
      this.db.prepare('DELETE FROM paper_accounts').run();
      this.db.prepare(`
        INSERT INTO paper_accounts
          (id, initial_capital, cash, realized_pnl, fees_paid, funding_paid, slippage_paid,
           last_processed_timestamp, config_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        account.id, account.initialCapital, account.cash, account.realizedPnl, account.feesPaid,
        account.fundingPaid, account.slippagePaid, account.lastProcessedTimestamp,
        JSON.stringify(account.config), account.createdAt, account.updatedAt
      );
    });
    return account;
  }

  paperAccount(): PaperAccount | null {
    const row = this.db.prepare(`
      SELECT id, initial_capital AS initialCapital, cash, realized_pnl AS realizedPnl,
             fees_paid AS feesPaid, funding_paid AS fundingPaid, slippage_paid AS slippagePaid,
             last_processed_timestamp AS lastProcessedTimestamp, config_json AS configJson,
             created_at AS createdAt, updated_at AS updatedAt
      FROM paper_accounts LIMIT 1
    `).get() as (Omit<PaperAccount, 'config'> & { configJson: string }) | undefined;
    return row ? { ...row, config: JSON.parse(row.configJson) as StrategyConfig } : null;
  }

  updatePaperAccount(account: PaperAccount): void {
    this.db.prepare(`
      UPDATE paper_accounts SET
        cash = ?, realized_pnl = ?, fees_paid = ?, funding_paid = ?, slippage_paid = ?,
        last_processed_timestamp = ?, config_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      account.cash, account.realizedPnl, account.feesPaid, account.fundingPaid, account.slippagePaid,
      account.lastProcessedTimestamp, JSON.stringify(account.config), account.updatedAt, account.id
    );
  }

  paperPositions(accountId = 'hypernight-paper'): PositionState[] {
    const rows = this.db.prepare(`SELECT state_json AS stateJson FROM paper_positions WHERE account_id = ? ORDER BY symbol`)
      .all(accountId) as Array<{ stateJson: string }>;
    return rows.map((row) => JSON.parse(row.stateJson) as PositionState);
  }

  replacePaperPositions(accountId: string, positions: PositionState[], now = Date.now()): void {
    const statement = this.db.prepare(`
      INSERT INTO paper_positions (id, account_id, symbol, state_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(account_id, symbol) DO UPDATE SET
        id = excluded.id, state_json = excluded.state_json, updated_at = excluded.updated_at
    `);
    this.transaction(() => {
      this.db.prepare('DELETE FROM paper_positions WHERE account_id = ?').run(accountId);
      for (const position of positions) statement.run(position.id, accountId, position.symbol, JSON.stringify(position), now);
    });
  }

  appendPaperTrades(accountId: string, trades: Trade[]): void {
    if (!trades.length) return;
    const statement = this.db.prepare(`
      INSERT OR IGNORE INTO paper_trades (id, account_id, symbol, exit_timestamp, trade_json)
      VALUES (?, ?, ?, ?, ?)
    `);
    this.transaction(() => {
      for (const trade of trades) statement.run(trade.id, accountId, trade.symbol, trade.exitTimestamp, JSON.stringify(trade));
    });
  }

  paperTrades(accountId = 'hypernight-paper', limit = 200): Trade[] {
    const rows = this.db.prepare(`
      SELECT trade_json AS tradeJson FROM paper_trades
      WHERE account_id = ? ORDER BY exit_timestamp DESC LIMIT ?
    `).all(accountId, limit) as Array<{ tradeJson: string }>;
    return rows.map((row) => JSON.parse(row.tradeJson) as Trade);
  }

  appendPaperEquity(accountId: string, point: { timestamp: number; cash: number; equity: number; unrealizedPnl: number; openPositions: number }): void {
    this.db.prepare(`
      INSERT INTO paper_equity (account_id, timestamp, cash, equity, unrealized_pnl, open_positions)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, timestamp) DO UPDATE SET
        cash = excluded.cash, equity = excluded.equity, unrealized_pnl = excluded.unrealized_pnl,
        open_positions = excluded.open_positions
    `).run(accountId, point.timestamp, point.cash, point.equity, point.unrealizedPnl, point.openPositions);
  }

  savePaperTick(
    account: PaperAccount,
    positions: PositionState[],
    trades: Trade[],
    point: { timestamp: number; cash: number; equity: number; unrealizedPnl: number; openPositions: number }
  ): void {
    const positionStatement = this.db.prepare(`
      INSERT INTO paper_positions (id, account_id, symbol, state_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    const tradeStatement = this.db.prepare(`
      INSERT OR IGNORE INTO paper_trades (id, account_id, symbol, exit_timestamp, trade_json)
      VALUES (?, ?, ?, ?, ?)
    `);
    this.transaction(() => {
      this.db.prepare(`
        UPDATE paper_accounts SET
          cash = ?, realized_pnl = ?, fees_paid = ?, funding_paid = ?, slippage_paid = ?,
          last_processed_timestamp = ?, config_json = ?, updated_at = ?
        WHERE id = ?
      `).run(
        account.cash, account.realizedPnl, account.feesPaid, account.fundingPaid, account.slippagePaid,
        account.lastProcessedTimestamp, JSON.stringify(account.config), account.updatedAt, account.id
      );
      this.db.prepare('DELETE FROM paper_positions WHERE account_id = ?').run(account.id);
      for (const position of positions) {
        positionStatement.run(position.id, account.id, position.symbol, JSON.stringify(position), account.updatedAt);
      }
      for (const trade of trades) {
        tradeStatement.run(trade.id, account.id, trade.symbol, trade.exitTimestamp, JSON.stringify(trade));
      }
      this.db.prepare(`
        INSERT INTO paper_equity (account_id, timestamp, cash, equity, unrealized_pnl, open_positions)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, timestamp) DO UPDATE SET
          cash = excluded.cash, equity = excluded.equity, unrealized_pnl = excluded.unrealized_pnl,
          open_positions = excluded.open_positions
      `).run(account.id, point.timestamp, point.cash, point.equity, point.unrealizedPnl, point.openPositions);
    });
  }

  paperEquity(accountId = 'hypernight-paper', limit = 500): Array<{ timestamp: number; cash: number; equity: number; unrealizedPnl: number; openPositions: number }> {
    return this.db.prepare(`
      SELECT timestamp, cash, equity, unrealized_pnl AS unrealizedPnl, open_positions AS openPositions
      FROM paper_equity WHERE account_id = ? ORDER BY timestamp DESC LIMIT ?
    `).all(accountId, limit) as Array<{ timestamp: number; cash: number; equity: number; unrealizedPnl: number; openPositions: number }>;
  }

  close(): void {
    this.db.close();
  }
}
