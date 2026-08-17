import assert from 'node:assert/strict';
import test from 'node:test';

import { BAR_MS, HOUR_MS } from '../src/constants.js';
import { parseCandleRows, parseFundingRows } from '../src/providers/hyperliquid.js';
import { parseJsonp, parseStockDaily } from '../src/providers/stocks.js';

test('Hyperliquid 解析器只接受 cutoff 前已收盘 K 线并估算名义量', () => {
  const start = Date.UTC(2026, 7, 6, 20, 0);
  const rows = parseCandleRows('xyz:AAPL', '5m', [
    { t: start, T: start + BAR_MS - 1, o: '100', h: '102', l: '99', c: '101', v: '10' },
    { t: start + BAR_MS, T: start + 2 * BAR_MS, o: '101', h: '103', l: '100', c: '102', v: '11' },
    { t: 'bad', T: 0, o: 0, h: 0, l: 0, c: 0, v: 0 }
  ], start + 2 * BAR_MS);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.estimatedNotionalVolume, 10 * (102 + 99 + 101) / 3);
});

test('funding 按 UTC 小时去重且不越过请求边界', () => {
  const start = Date.UTC(2026, 7, 6, 20, 0);
  const rows = parseFundingRows('xyz:AAPL', [
    { time: start + 1_000, fundingRate: '0.001' },
    { time: start + 2_000, fundingRate: '0.002' },
    { time: start + HOUR_MS, fundingRate: '-0.001' },
    { time: start + 2 * HOUR_MS, fundingRate: '0.5' }
  ], start, start + 2 * HOUR_MS);
  assert.deepEqual(rows.map((row) => [row.timestamp, row.fundingRate]), [
    [start, 0.002],
    [start + HOUR_MS, -0.001]
  ]);
});

test('腾讯 JSONP 优先解析 qfqday 并过滤异常 OHLC', () => {
  const body = 'kline_dayqfq={"code":0,"data":{"usAAPL.OQ":{"qfqday":[["2026-08-06","100","101","102","99","1000"],["bad","1","1","1","1","1"],["2026-08-07","100","101","100","99","1000"]]}}};';
  const rows = parseStockDaily(parseJsonp(body), 'AAPL', 'usAAPL.OQ');
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    ticker: 'AAPL',
    tradeDate: '2026-08-06',
    open: 100,
    close: 101,
    high: 102,
    low: 99,
    volume: 1_000
  });
});
