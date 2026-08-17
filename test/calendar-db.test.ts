import assert from 'node:assert/strict';
import test from 'node:test';

import { buildOffHoursWindows, etWallClockToUtc, nextUsTradingDate } from '../src/calendar.js';
import { BAR_MS } from '../src/constants.js';
import { HyperNightDb } from '../src/db.js';
import type { CandleBar, StockDailyBar } from '../src/types.js';

test('美东窗口跨 DST 与周末时按真实 UTC 时长构造', () => {
  const spring = buildOffHoursWindows(['2026-03-06', '2026-03-09'], '16:00', '09:30')[0]!;
  assert.equal(spring.windowStart, Date.UTC(2026, 2, 6, 21, 0));
  assert.equal(spring.windowEnd, Date.UTC(2026, 2, 9, 13, 30));
  assert.equal(spring.expectedBars, 64.5 * 12);

  const winter = buildOffHoursWindows(['2026-01-05', '2026-01-06'], '16:00', '09:30')[0]!;
  assert.equal(winter.expectedBars, 17.5 * 12);
  assert.equal(etWallClockToUtc(2026, 1, 5, 16, 0), Date.UTC(2026, 0, 5, 21, 0));
  assert.equal(nextUsTradingDate('2026-07-02'), '2026-07-06');
  assert.equal(nextUsTradingDate('2026-11-25'), '2026-11-27');
});

test('Node SQLite 独立持久化并 upsert 5m、1d 与正股日 K', () => {
  const db = new HyperNightDb(':memory:');
  try {
    const start = Date.UTC(2026, 7, 6, 20, 0);
    const candle: CandleBar = {
      symbol: 'xyz:AAPL',
      timestamp: start,
      closeTimestamp: start + BAR_MS,
      open: 100,
      high: 102,
      low: 99,
      close: 101,
      volume: 10,
      estimatedNotionalVolume: 1_010
    };
    db.upsertCandles('5m', [candle]);
    db.upsertCandles('5m', [{ ...candle, close: 103 }]);
    db.upsertCandles('1d', [{ ...candle, closeTimestamp: start + 86_400_000 }]);
    assert.equal(db.candles(['xyz:AAPL'], start, start + 2 * BAR_MS)[0]!.close, 103);
    assert.equal(db.candles(['xyz:AAPL'], start, start + 86_400_001, '1d').length, 1);
    assert.deepEqual(db.candleBounds(['xyz:AAPL']), { startTime: start, endTime: start + BAR_MS, rowCount: 1 });

    const stock: StockDailyBar = {
      ticker: 'AAPL',
      tradeDate: '2026-08-06',
      open: 99,
      close: 100,
      high: 101,
      low: 98,
      volume: 1_000
    };
    db.upsertStockDaily([stock], 'usAAPL.OQ');
    assert.deepEqual({ ...db.stockDaily(['AAPL'], '2026-08-01', '2026-08-10')[0]! }, stock);
    assert.deepEqual(db.tradingDates(['AAPL'], '2026-08-01', '2026-08-10'), ['2026-08-06']);
  } finally {
    db.close();
  }
});
