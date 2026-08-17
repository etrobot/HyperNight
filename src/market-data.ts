import {
  BAR_MS,
  CANDLE_HISTORY_LIMIT,
  DAY_MS,
  SYMBOL_MAP,
  normalizeSymbols,
  tickerOf
} from './constants.js';
import type { DataBackfillSummary } from './types.js';
import type { HyperNightDb } from './db.js';
import { HyperliquidClient } from './providers/hyperliquid.js';
import { StockQuoteClient } from './providers/stocks.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class MarketDataService {
  constructor(
    private readonly database: HyperNightDb,
    private readonly hyperliquid = new HyperliquidClient(),
    private readonly stocks = new StockQuoteClient()
  ) {}

  async backfill(options: { symbols?: string[]; days?: number; now?: number } = {}): Promise<DataBackfillSummary> {
    const startedAt = Date.now();
    const now = options.now ?? startedAt;
    const days = Math.max(2, Math.min(90, Math.trunc(options.days ?? 17)));
    const symbols = normalizeSymbols(options.symbols);
    if (!symbols.length) throw new Error('没有可回补的 HyperNight 标的');

    const contexts = await this.hyperliquid.marketContexts('xyz', now);
    this.database.saveMarketContexts(contexts.filter((row) => symbols.includes(row.symbol)));

    const end5m = HyperliquidClient.alignedEnd(now, '5m');
    const start5m = Math.max(end5m - days * DAY_MS, end5m - CANDLE_HISTORY_LIMIT * BAR_MS);
    const end1d = HyperliquidClient.alignedEnd(now, '1d');
    const start1d = end1d - Math.max(days + 10, 45) * DAY_MS;
    const results: DataBackfillSummary['results'] = [];

    for (const symbol of symbols) {
      const ticker = tickerOf(symbol);
      const quoteCode = SYMBOL_MAP[symbol]!;
      try {
        const stockRows = await this.stocks.daily(ticker, quoteCode, Math.max(days + 20, 90), now);
        const stockDaysSaved = this.database.upsertStockDaily(stockRows, quoteCode, now);
        await delay(100);
        const candles5m = await this.hyperliquid.candles(symbol, '5m', start5m, end5m);
        const candles5mSaved = this.database.upsertCandles('5m', candles5m);
        await delay(100);
        const candles1d = await this.hyperliquid.candles(symbol, '1d', start1d, end1d);
        const candles1dSaved = this.database.upsertCandles('1d', candles1d);
        await delay(100);
        const funding = await this.hyperliquid.funding(symbol, start5m, end5m);
        const fundingSaved = this.database.upsertFunding(funding);
        results.push({ symbol, ticker, candles5mSaved, candles1dSaved, fundingSaved, stockDaysSaved });
      } catch (error) {
        results.push({
          symbol,
          ticker,
          candles5mSaved: 0,
          candles1dSaved: 0,
          fundingSaved: 0,
          stockDaysSaved: 0,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    return { symbols, requestedDays: days, startedAt, completedAt: Date.now(), results };
  }
}
