import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadFactorData } from '../src/analysis-data.js';
import { runBacktest } from '../src/backtest.js';
import { BAR_MS } from '../src/constants.js';
import { HyperNightDb } from '../src/db.js';
import { initializePaperAccount, paperStatus, tickPaperRows } from '../src/paper.js';
import { runResearch } from '../src/research.js';
import { seedTestMarketData, TEST_MARKET_SYMBOLS, testConfig } from './helpers.js';

test('组合回测与持久化模拟盘在重启后产生相同信号和净值', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hypernight-test-'));
  const path = join(directory, 'paper.db');
  const config = testConfig();
  let expectedPnl = 0;
  let allRows: ReturnType<typeof loadFactorData>['rows'] = [];
  try {
    const firstDb = new HyperNightDb(path);
    seedTestMarketData(firstDb, config);
    const factors = loadFactorData(firstDb, { symbols: TEST_MARKET_SYMBOLS, config });
    allRows = factors.rows;
    const backtest = runBacktest(firstDb, { symbols: TEST_MARKET_SYMBOLS, config });
    expectedPnl = backtest.portfolio.totalPnl;
    assert.equal(backtest.portfolio.tradeCount > 0, true);
    assert.equal(backtest.noHedgePortfolio.tradeCount, backtest.portfolio.tradeCount);
    assert.equal(backtest.maxConcurrentPositions <= config.maxPositions, true);

    initializePaperAccount(firstDb, config, { symbols: TEST_MARKET_SYMBOLS, startAfterTimestamp: null });
    const firstEntry = allRows.find((row) => row.eligible)!;
    const split = firstEntry.timestamp + 5 * BAR_MS;
    const firstTick = tickPaperRows(firstDb, allRows.filter((row) => row.timestamp <= split));
    assert.equal(firstTick.openedPositions > 0, true);
    assert.equal(paperStatus(firstDb).positions.length > 0, true);
    firstDb.close();

    const restarted = new HyperNightDb(path);
    const secondTick = tickPaperRows(restarted, allRows);
    const status = paperStatus(restarted);
    assert.equal(secondTick.closedTrades > 0, true);
    assert.equal(status.positions.length, 0);
    const paperPnl = status.trades.reduce((sum, trade) => sum + trade.pnl, 0);
    assert.ok(Math.abs(paperPnl - expectedPnl) < 1e-8);
    assert.ok(Math.abs((status.account?.cash ?? 0) - (config.initialCapital + expectedPnl)) < 1e-8);

    const idempotent = tickPaperRows(restarted, allRows);
    assert.equal(idempotent.processedBars, 0);
    assert.equal(idempotent.closedTrades, 0);
    restarted.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('隔离测试数据端到端完成研究 run 与回测 run 的 SQLite 持久化', () => {
  const db = new HyperNightDb(':memory:');
  try {
    const config = testConfig();
    seedTestMarketData(db, config);
    const research = runResearch(db, { symbols: TEST_MARKET_SYMBOLS, config });
    const result = runBacktest(db, { symbols: TEST_MARKET_SYMBOLS, config });
    assert.equal(research.factorMetrics.find((metric) => metric.factor === 'score')!.observations > 0, true);
    assert.equal(db.latestRun<typeof research>('research')?.runId, research.runId);
    assert.equal(result.trades.length > 0, true);
    assert.equal(db.latestRun<typeof result>('backtest')?.runId, result.runId);
    assert.equal(db.candleBounds(TEST_MARKET_SYMBOLS, '5m')?.rowCount! > 1_000, true);
    assert.equal(db.candleBounds(TEST_MARKET_SYMBOLS, '1d')?.rowCount, TEST_MARKET_SYMBOLS.length * 7);
  } finally {
    db.close();
  }
});
