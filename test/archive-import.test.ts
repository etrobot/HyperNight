import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import pl from 'nodejs-polars';

import {
  HYPERARBITRARY_ARCHIVE_SOURCE,
  archiveEntryForSymbol,
  archiveSymbol,
  importArchiveCandles,
  parseArchiveFeather
} from '../src/archive-import.js';
import { BAR_MS } from '../src/constants.js';
import { HyperNightDb } from '../src/db.js';
import type { CandleBar } from '../src/types.js';

interface FixtureRow {
  date: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function writeArchiveFeather(root: string, ticker: string, rows: FixtureRow[]): string {
  const directory = join(root, 'data', 'hyperliquid', 'futures');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `XYZ-${ticker}_USDC_USDC-5m-futures.feather`);
  pl.DataFrame({
    date: rows.map((row) => row.date),
    open: rows.map((row) => row.open),
    high: rows.map((row) => row.high),
    low: rows.map((row) => row.low),
    close: rows.map((row) => row.close),
    volume: rows.map((row) => row.volume)
  }).writeIPC(path);
  return path;
}

function fixtureRows(start: number): FixtureRow[] {
  return [
    { date: start, open: 100, high: 102, low: 99, close: 101, volume: 10 },
    { date: start + BAR_MS, open: 101, high: 103, low: 100, close: 102, volume: 11 }
  ];
}

test('HyperArbitrary 5m Feather 映射 symbol、时间戳和名义成交额', () => {
  const root = mkdtempSync(join(tmpdir(), 'hypernight-archive-'));
  try {
    const start = Date.UTC(2026, 0, 5, 20, 0);
    const file = writeArchiveFeather(root, 'AAPL', [
      { ...fixtureRows(start)[0]!, date: start / 1_000 },
      fixtureRows(start)[1]!
    ]);
    assert.equal(archiveSymbol(file), 'xyz:AAPL');
    assert.equal(
      archiveEntryForSymbol('xyz:AAPL'),
      'data/hyperliquid/futures/XYZ-AAPL_USDC_USDC-5m-futures.feather'
    );
    const parsed = parseArchiveFeather(file, { cutoff: start + 2 * BAR_MS });
    assert.equal(parsed.rows.length, 2);
    assert.equal(parsed.rows[0]!.timestamp, start);
    assert.equal(parsed.rows[0]!.closeTimestamp, start + BAR_MS - 1);
    assert.equal(parsed.rows[0]!.estimatedNotionalVolume, 10 * (102 + 99 + 101) / 3);
    assert.equal(parsed.rows[0]!.source, HYPERARBITRARY_ARCHIVE_SOURCE);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('归档导入跳过未知标的并保持重复运行幂等', () => {
  const root = mkdtempSync(join(tmpdir(), 'hypernight-archive-'));
  const database = new HyperNightDb(':memory:');
  try {
    const start = Date.UTC(2026, 0, 5, 20, 0);
    writeArchiveFeather(root, 'AAPL', fixtureRows(start));
    writeArchiveFeather(root, 'UNKNOWN', fixtureRows(start));

    const dryRun = importArchiveCandles(database, {
      inputPath: root,
      symbols: ['AAPL'],
      cutoff: start + 2 * BAR_MS,
      dryRun: true
    });
    assert.equal(dryRun.addedRows, 2);
    assert.equal(dryRun.writeRows, 2);
    assert.equal(dryRun.unknownFiles.length, 1);
    assert.equal(database.candleBounds(['xyz:AAPL']), null);

    const first = importArchiveCandles(database, {
      inputPath: root,
      symbols: ['AAPL'],
      cutoff: start + 2 * BAR_MS
    });
    assert.equal(first.addedRows, 2);
    assert.equal(first.differingOverlapRows, 0);
    assert.equal(database.candleBounds(['xyz:AAPL'])?.rowCount, 2);
    assert.ok(database.candles(['xyz:AAPL'], start, start + 2 * BAR_MS).every(
      (row) => row.source === HYPERARBITRARY_ARCHIVE_SOURCE
    ));

    const repeated = importArchiveCandles(database, {
      inputPath: root,
      symbols: ['AAPL'],
      cutoff: start + 2 * BAR_MS
    });
    assert.equal(repeated.addedRows, 0);
    assert.equal(repeated.writeRows, 0);
    assert.equal(repeated.matchingOverlapRows, 2);
    assert.equal(database.candleBounds(['xyz:AAPL'])?.rowCount, 2);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('默认保留 API 重叠记录并审计差异，显式覆盖才改写', () => {
  const root = mkdtempSync(join(tmpdir(), 'hypernight-archive-'));
  const database = new HyperNightDb(':memory:');
  try {
    const start = Date.UTC(2026, 0, 5, 20, 0);
    writeArchiveFeather(root, 'AAPL', fixtureRows(start));
    const existing: CandleBar = {
      symbol: 'xyz:AAPL',
      timestamp: start,
      closeTimestamp: start + BAR_MS,
      open: 100,
      high: 103,
      low: 99,
      close: 101.5,
      volume: 10,
      estimatedNotionalVolume: 10 * (103 + 99 + 101.5) / 3,
      source: 'hyperliquid-5m'
    };
    database.upsertCandles('5m', [existing]);

    const preserved = importArchiveCandles(database, {
      inputPath: root,
      symbols: ['AAPL'],
      cutoff: start + 2 * BAR_MS
    });
    assert.equal(preserved.differingOverlapRows, 1);
    assert.deepEqual(preserved.files[0]!.differingTimestamps, [start]);
    assert.equal(preserved.addedRows, 1);
    assert.equal(database.candles(['xyz:AAPL'], start, start + BAR_MS)[0]!.close, 101.5);
    assert.equal(database.candles(['xyz:AAPL'], start, start + BAR_MS)[0]!.source, 'hyperliquid-5m');

    const overwritten = importArchiveCandles(database, {
      inputPath: root,
      symbols: ['AAPL'],
      cutoff: start + 2 * BAR_MS,
      overwriteExisting: true
    });
    assert.equal(overwritten.writeRows, 2);
    assert.equal(overwritten.addedRows, 0);
    assert.equal(database.candles(['xyz:AAPL'], start, start + BAR_MS)[0]!.close, 101);
    assert.equal(database.candles(['xyz:AAPL'], start, start + BAR_MS)[0]!.source, HYPERARBITRARY_ARCHIVE_SOURCE);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('归档拒绝未对齐 5m 网格和异常 OHLC', () => {
  const root = mkdtempSync(join(tmpdir(), 'hypernight-archive-'));
  try {
    const start = Date.UTC(2026, 0, 5, 20, 0);
    const file = writeArchiveFeather(root, 'MSFT', [
      { date: start + 1, open: 100, high: 99, low: 98, close: 101, volume: 10 }
    ]);
    assert.throws(
      () => parseArchiveFeather(file, { cutoff: start + BAR_MS }),
      /字段无效/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
