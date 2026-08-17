import { buildOffHoursWindows } from '../src/calendar.js';
import { BAR_MS, DAY_MS, SYMBOL_MAP, tickerOf } from '../src/constants.js';
import { resolveConfig } from '../src/config.js';
import type { HyperNightDb } from '../src/db.js';
import type { CandleBar, FactorRow, FactorWeights, FundingBar, MarketContext, StockDailyBar, StrategyConfig } from '../src/types.js';

type ConfigOverrides = Partial<Omit<StrategyConfig, 'factorWeights'>> & { factorWeights?: Partial<FactorWeights> };

export function testConfig(overrides: ConfigOverrides = {}): StrategyConfig {
  return resolveConfig({
    entryDeviation: 0.02,
    exitDeviation: 0.005,
    momentumBars: 2,
    volatilityBars: 3,
    liquidityBars: 3,
    minSessionCoverage: 0,
    minBarNotional: 0,
    maxFunding: 1,
    minExpectedEdge: 0,
    feeRate: 0,
    slippageBps: 0,
    ...overrides
  });
}

export function factorRow(overrides: Partial<FactorRow> = {}): FactorRow {
  return {
    symbol: 'xyz:AAPL',
    ticker: 'AAPL',
    sessionDate: '2026-08-06',
    nextTradeDate: '2026-08-07',
    windowStart: Date.UTC(2026, 7, 6, 20, 0),
    windowEnd: Date.UTC(2026, 7, 7, 13, 30),
    timestamp: Date.UTC(2026, 7, 6, 20, 0),
    isSessionLast: false,
    close: 103,
    referencePrice: 100,
    deviation: 0.03,
    direction: 1,
    fundingRate: 0,
    fundingKnown: false,
    estimatedNotionalVolume: 1_000_000,
    deviationFactor: 0.025,
    momentumFactor: 0.01,
    liquidityFactor: 12,
    lowVolatilityFactor: -0.01,
    fundingCarryFactor: 0,
    deviationZ: 1,
    momentumZ: 1,
    liquidityZ: 0,
    lowVolatilityZ: 0,
    fundingCarryZ: 0,
    score: 0.6,
    rank: 1,
    eligible: true,
    eligibilityReason: 'eligible',
    ...overrides
  };
}

export const TEST_MARKET_SYMBOLS = ['xyz:AAPL', 'xyz:MSFT', 'xyz:NVDA'];
export const TEST_TRADING_DATES = [
  '2026-08-03',
  '2026-08-04',
  '2026-08-05',
  '2026-08-06',
  '2026-08-07',
  '2026-08-10',
  '2026-08-11'
];

function testReference(symbol: string, dayIndex: number): number {
  const base = symbol === 'xyz:AAPL' ? 100 : symbol === 'xyz:MSFT' ? 200 : 150;
  return base * (1 + dayIndex * 0.0015);
}

function testDeviation(symbol: string, index: number, sessionIndex: number): number {
  const noise = Math.sin((index + sessionIndex * 3) / 4) * 0.0005;
  if (index < 18) return noise;
  if (symbol === 'xyz:AAPL') return Math.min(0.065, 0.027 + (index - 18) * 0.00045) + noise;
  if (symbol === 'xyz:MSFT') return -Math.min(0.06, 0.028 + (index - 18) * 0.0004) + noise;
  return 0.009 * Math.sin((index + sessionIndex) / 18);
}

/** 只写入测试创建的临时/内存数据库，不被生产代码导入。 */
export function seedTestMarketData(database: HyperNightDb, config: StrategyConfig = testConfig()): void {
  const stockBySymbol = new Map<string, StockDailyBar[]>();
  for (const symbol of TEST_MARKET_SYMBOLS) {
    const ticker = tickerOf(symbol);
    const stockRows = TEST_TRADING_DATES.map((tradeDate, dayIndex) => {
      const close = testReference(symbol, dayIndex);
      return {
        ticker,
        tradeDate,
        open: close * (1 - 0.001),
        close,
        high: close * 1.01,
        low: close * 0.99,
        volume: 10_000_000 + dayIndex * 100_000
      };
    });
    stockBySymbol.set(symbol, stockRows);
    database.upsertStockDaily(stockRows, SYMBOL_MAP[symbol]!, Date.UTC(2026, 7, 12));
    database.upsertCandles('1d', stockRows.map((row): CandleBar => {
      const timestamp = Date.parse(`${row.tradeDate}T00:00:00Z`);
      return {
        symbol,
        timestamp,
        closeTimestamp: timestamp + DAY_MS,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume,
        estimatedNotionalVolume: row.volume * row.close,
        source: 'test-fixture-1d'
      };
    }));
  }

  const windows = buildOffHoursWindows(TEST_TRADING_DATES, config.windowStartEt, config.windowEndEt);
  for (const symbol of TEST_MARKET_SYMBOLS) {
    const candles: CandleBar[] = [];
    const funding: FundingBar[] = [];
    const stockRows = stockBySymbol.get(symbol)!;
    for (let sessionIndex = 0; sessionIndex < windows.length; sessionIndex += 1) {
      const window = windows[sessionIndex]!;
      const reference = stockRows[sessionIndex]!.close;
      candles.push({
        symbol,
        timestamp: window.sessionCloseAt - BAR_MS,
        closeTimestamp: window.sessionCloseAt,
        open: reference * 0.9998,
        high: reference * 1.0005,
        low: reference * 0.9995,
        close: reference,
        volume: 50_000,
        estimatedNotionalVolume: reference * 50_000,
        source: 'test-fixture-5m'
      });
      let previous = reference;
      for (let index = 0; index < window.expectedBars; index += 1) {
        const timestamp = window.windowStart + index * BAR_MS;
        const close = reference * (1 + testDeviation(symbol, index, sessionIndex));
        candles.push({
          symbol,
          timestamp,
          closeTimestamp: timestamp + BAR_MS,
          open: previous,
          high: Math.max(previous, close) * 1.0005,
          low: Math.min(previous, close) * 0.9995,
          close,
          volume: 35_000 + (index % 12) * 1_000,
          estimatedNotionalVolume: close * (35_000 + (index % 12) * 1_000),
          source: 'test-fixture-5m'
        });
        previous = close;
      }
      for (let timestamp = Math.ceil(window.windowStart / 3_600_000) * 3_600_000;
        timestamp < window.windowEnd;
        timestamp += 3_600_000) {
        funding.push({ symbol, timestamp, fundingRate: symbol === 'xyz:AAPL' ? 0.00001 : -0.000005 });
      }
    }
    database.upsertCandles('5m', candles);
    database.upsertFunding(funding);
  }

  const lastWindow = windows.at(-1)!;
  const contexts: MarketContext[] = TEST_MARKET_SYMBOLS.map((symbol) => ({
    symbol,
    capturedAt: lastWindow.windowEnd,
    markPx: testReference(symbol, TEST_TRADING_DATES.length - 1),
    midPx: testReference(symbol, TEST_TRADING_DATES.length - 1),
    funding: 0,
    openInterest: 1_000_000,
    dayNotionalVolume: 50_000_000,
    impactBidPx: testReference(symbol, TEST_TRADING_DATES.length - 1) * 0.9995,
    impactAskPx: testReference(symbol, TEST_TRADING_DATES.length - 1) * 1.0005
  }));
  database.saveMarketContexts(contexts);
}
