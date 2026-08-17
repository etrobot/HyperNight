import assert from 'node:assert/strict';
import test from 'node:test';

import { BAR_MS, HOUR_MS } from '../src/constants.js';
import { openPosition, stepPosition } from '../src/simulator.js';
import { factorRow, testConfig } from './helpers.js';

test('正偏离做多、负偏离做空，方向保持价格发现动量语义', () => {
  const config = testConfig();
  assert.equal(openPosition(factorRow({ direction: 1 }), config).coreQty > 0, true);
  assert.equal(openPosition(factorRow({ direction: -1, deviation: -0.03 }), config).coreQty < 0, true);
});

test('平价退出时净亏损精确等于双边手续费和滑点', () => {
  const config = testConfig({
    feeRate: 0.001,
    slippageBps: 10,
    takeProfit: 1,
    stopLoss: 1,
    maxHoldBars: 1_000
  });
  const entry = factorRow({ close: 100, deviation: 0.03, timestamp: Date.UTC(2026, 7, 6, 20, 5) });
  const position = openPosition(entry, config);
  const exit = factorRow({
    ...entry,
    timestamp: entry.timestamp + BAR_MS,
    close: 100,
    isSessionLast: true
  });
  const stepped = stepPosition(position, exit, config, true);
  assert.equal(stepped.trade?.exitReason, 'session_end');
  assert.equal(stepped.trade?.grossPnl, 0);
  assert.equal(stepped.trade?.fees, 20);
  assert.equal(stepped.trade?.slippage, 20);
  assert.equal(stepped.trade?.pnl, -40);
});

test('funding 只在 UTC 整点且每个整点最多计提一次', () => {
  const config = testConfig({ takeProfit: 1, stopLoss: 1, maxHoldBars: 1_000 });
  const entryTime = Date.UTC(2026, 7, 6, 20, 5);
  const position = openPosition(factorRow({ close: 100, timestamp: entryTime }), config);
  const hour = Math.ceil(entryTime / HOUR_MS) * HOUR_MS;
  const row = factorRow({ timestamp: hour, close: 100, fundingKnown: true, fundingRate: 0.001 });
  const first = stepPosition(position, row, config, false).position!;
  assert.equal(first.funding, 10);
  const second = stepPosition(first, row, config, false).position!;
  assert.equal(second.funding, 10);
});

test('动态对冲的不利加仓与有利减仓使用不同容量约束', () => {
  const config = testConfig({
    maxCoreNotional: 10_000,
    maxNotional: 20_000,
    takeProfit: 1,
    stopLoss: 1,
    hedgeStep: 0.01,
    hedgeFraction: 0.5,
    maxHedgeRatio: 1,
    maxHoldBars: 1_000
  });
  const entry = factorRow({ close: 100, timestamp: Date.UTC(2026, 7, 6, 20, 5) });
  const position = openPosition(entry, config);
  const adverse = factorRow({ ...entry, timestamp: entry.timestamp + BAR_MS, close: 98, deviation: 0.03 });
  const hedged = stepPosition(position, adverse, config, true).position!;
  assert.equal(hedged.hedgeQty, -50);
  assert.equal(hedged.fills.at(-1)?.action, 'add_hedge');
  const favorable = factorRow({ ...entry, timestamp: entry.timestamp + 2 * BAR_MS, close: 100.5, deviation: 0.03 });
  const reduced = stepPosition(hedged, favorable, config, true).position!;
  assert.equal(reduced.hedgeQty, 0);
  assert.equal(reduced.fills.at(-1)?.action, 'reduce_hedge');
});
