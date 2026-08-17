import assert from 'node:assert/strict';
import test from 'node:test';

import { BAR_MS } from '../src/constants.js';
import { buildFactorRows } from '../src/factors.js';
import type { CandleBar, OffHoursWindow, StockDailyBar } from '../src/types.js';
import { testConfig } from './helpers.js';

const SYMBOLS = ['xyz:AAPL', 'xyz:MSFT', 'xyz:NVDA'];

function fixture(count: number, mismatch = false) {
  const windowStart = Date.UTC(2026, 7, 6, 20, 0);
  const window: OffHoursWindow = {
    sessionDate: '2026-08-06',
    nextTradeDate: '2026-08-07',
    windowStart,
    windowEnd: windowStart + 20 * BAR_MS,
    sessionCloseAt: windowStart,
    expectedBars: 20
  };
  const candles: CandleBar[] = [];
  const stockDaily: StockDailyBar[] = [];
  for (const symbol of SYMBOLS) {
    const ticker = symbol.slice(4);
    stockDaily.push({ ticker, tradeDate: window.sessionDate, open: 99, close: 100, high: 101, low: 98, volume: 1_000 });
    stockDaily.push({ ticker, tradeDate: window.nextTradeDate, open: 101, close: 101, high: 102, low: 100, volume: 1_000 });
    const preClose = mismatch && symbol === 'xyz:AAPL' ? 105 : 100;
    candles.push({
      symbol,
      timestamp: windowStart - BAR_MS,
      closeTimestamp: windowStart,
      open: preClose,
      high: preClose,
      low: preClose,
      close: preClose,
      volume: 1_000,
      estimatedNotionalVolume: 100_000
    });
    for (let index = 0; index < count; index += 1) {
      const deviation = symbol === 'xyz:AAPL'
        ? index * 0.0022
        : symbol === 'xyz:MSFT' ? -index * 0.0018 : Math.sin(index / 3) * 0.004;
      const close = 100 * (1 + deviation);
      candles.push({
        symbol,
        timestamp: windowStart + index * BAR_MS,
        closeTimestamp: windowStart + (index + 1) * BAR_MS,
        open: close,
        high: close * 1.001,
        low: close * 0.999,
        close,
        volume: 10_000 + index,
        estimatedNotionalVolume: close * (10_000 + index)
      });
    }
  }
  return { window, candles, stockDaily };
}

test('Polars 生成滚动因子、截面 z-score、综合分与唯一排名', () => {
  const data = fixture(20);
  const result = buildFactorRows({
    symbols: SYMBOLS,
    windows: [data.window],
    candles: data.candles,
    stockDaily: data.stockDaily,
    funding: [],
    config: testConfig()
  });
  assert.equal(result.rows.length, 60);
  assert.equal(result.audits.every((audit) => audit.status === 'ok'), true);
  assert.equal(result.rows.filter((row) => row.eligibilityReason === 'warmup').length > 0, true);
  const eligibleByTime = new Map<number, number[]>();
  for (const row of result.rows.filter((row) => row.eligible)) {
    assert.equal(Number.isFinite(row.score), true);
    const ranks = eligibleByTime.get(row.timestamp) ?? [];
    ranks.push(row.rank);
    eligibleByTime.set(row.timestamp, ranks);
  }
  assert.equal(eligibleByTime.size > 0, true);
  for (const ranks of eligibleByTime.values()) {
    assert.equal(new Set(ranks).size, ranks.length);
    assert.equal(Math.min(...ranks), 1);
  }
});

test('补入未来 bar 不改变既有时点的因子与排名', () => {
  const partial = fixture(16);
  const full = fixture(20);
  const config = testConfig();
  const earlier = buildFactorRows({
    symbols: SYMBOLS,
    windows: [partial.window],
    candles: partial.candles,
    stockDaily: partial.stockDaily,
    funding: [],
    config
  });
  const later = buildFactorRows({
    symbols: SYMBOLS,
    windows: [full.window],
    candles: full.candles,
    stockDaily: full.stockDaily,
    funding: [],
    config
  });
  const cutoff = partial.window.windowStart + 14 * BAR_MS;
  const project = (rows: typeof earlier.rows) => rows
    .filter((row) => row.timestamp <= cutoff)
    .map((row) => ({ symbol: row.symbol, timestamp: row.timestamp, score: row.score, rank: row.rank, reason: row.eligibilityReason }));
  assert.deepEqual(project(earlier.rows), project(later.rows));
});

test('参照价护栏排除 HL 收盘价错配的标的休市段', () => {
  const data = fixture(20, true);
  const result = buildFactorRows({
    symbols: SYMBOLS,
    windows: [data.window],
    candles: data.candles,
    stockDaily: data.stockDaily,
    funding: [],
    config: testConfig()
  });
  const audit = result.audits.find((row) => row.symbol === 'xyz:AAPL')!;
  assert.equal(audit.status, 'reference_mismatch');
  assert.equal(result.rows.some((row) => row.symbol === 'xyz:AAPL'), false);
});

test('当前未结束的模拟盘窗口只按已流逝 bar 计算覆盖率且不提前强平', () => {
  const data = fixture(20);
  const openWindow = {
    ...data.window,
    windowEnd: data.window.windowStart + 210 * BAR_MS,
    expectedBars: 210
  };
  const cutoff = data.window.windowStart + 20 * BAR_MS;
  const result = buildFactorRows({
    symbols: SYMBOLS,
    windows: [openWindow],
    candles: data.candles,
    stockDaily: data.stockDaily,
    funding: [],
    config: testConfig({ minSessionCoverage: 0.8 }),
    dataCutoff: cutoff
  });
  assert.equal(result.audits.every((audit) => audit.status === 'ok' && audit.expectedBars === 20), true);
  assert.equal(result.rows.some((row) => row.isSessionLast), false);
});

test('模拟盘保留低覆盖率路径供已有仓位估值，但禁止新增仓位', () => {
  const data = fixture(10);
  const openWindow = { ...data.window, windowEnd: data.window.windowStart + 210 * BAR_MS, expectedBars: 210 };
  const result = buildFactorRows({
    symbols: SYMBOLS,
    windows: [openWindow],
    candles: data.candles,
    stockDaily: data.stockDaily,
    funding: [],
    config: testConfig({ minSessionCoverage: 0.8 }),
    dataCutoff: data.window.windowStart + 20 * BAR_MS,
    retainInsufficientCoverageRows: true
  });
  assert.equal(result.rows.length, 30);
  assert.equal(result.rows.every((row) => !row.eligible && row.eligibilityReason === 'insufficient_coverage'), true);
});
