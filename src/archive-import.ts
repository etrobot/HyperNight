import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import pl from 'nodejs-polars';

import { BAR_MS, DEFAULT_SYMBOLS, SYMBOL_MAP, normalizeSymbols, tickerOf } from './constants.js';
import type { HyperNightDb } from './db.js';
import type { CandleBar } from './types.js';

export const HYPERARBITRARY_ARCHIVE_SOURCE = 'hyperarbitrary-archive-5m';
const ARCHIVE_FILE_PATTERN = /^XYZ-([^_]+)_USDC_USDC-5m-futures\.feather$/i;
const ARCHIVE_ENTRY_DIRECTORY = 'data/hyperliquid/futures';
const EXTRACTION_MANIFEST = '.hypernight-5m-extraction.json';

type ArchiveInputKind = '7z' | 'directory' | 'feather';

export interface ParsedArchiveCandles {
  filePath: string;
  symbol: string;
  rows: CandleBar[];
  inputRows: number;
  skippedOpenRows: number;
  startTime: number | null;
  endTime: number | null;
}

export interface ArchiveImportFileResult {
  filePath: string;
  symbol: string;
  inputRows: number;
  acceptedRows: number;
  skippedOpenRows: number;
  overlapRows: number;
  matchingOverlapRows: number;
  differingOverlapRows: number;
  writeRows: number;
  addedRows: number;
  startTime: number | null;
  endTime: number | null;
  differingTimestamps: number[];
}

export interface ArchiveImportSummary {
  inputPath: string;
  inputKind: ArchiveInputKind;
  extractionPath: string | null;
  source: string;
  dryRun: boolean;
  overwriteExisting: boolean;
  requestedSymbols: string[];
  importedSymbols: string[];
  missingSymbols: string[];
  unknownFiles: string[];
  inputRows: number;
  acceptedRows: number;
  skippedOpenRows: number;
  overlapRows: number;
  matchingOverlapRows: number;
  differingOverlapRows: number;
  writeRows: number;
  addedRows: number;
  startedAt: number;
  completedAt: number;
  files: ArchiveImportFileResult[];
}

interface LocatedFiles {
  inputKind: ArchiveInputKind;
  extractionPath: string | null;
  files: Array<{ symbol: string; filePath: string }>;
  missingSymbols: string[];
  unknownFiles: string[];
}

interface ArchiveTool {
  command: string;
  kind: '7z' | 'bsdtar';
}

interface ExtractionManifestData {
  archivePath: string;
  archiveSize: number;
  archiveMtimeMs: number;
  entries: string[];
}

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeTimestamp(value: number): number {
  if (value > 0 && value < 1e11) return Math.trunc(value * 1_000);
  if (value >= 1e17) return Math.trunc(value / 1_000_000);
  if (value >= 1e14) return Math.trunc(value / 1_000);
  return Math.trunc(value);
}

function archiveTicker(filePath: string): string | null {
  const match = basename(filePath).match(ARCHIVE_FILE_PATTERN);
  return match?.[1]?.toUpperCase() ?? null;
}

export function archiveSymbol(filePath: string): string | null {
  const ticker = archiveTicker(filePath);
  if (!ticker) return null;
  const symbol = `xyz:${ticker}`;
  return symbol in SYMBOL_MAP ? symbol : null;
}

export function archiveEntryForSymbol(symbol: string): string {
  return `${ARCHIVE_ENTRY_DIRECTORY}/XYZ-${tickerOf(symbol)}_USDC_USDC-5m-futures.feather`;
}

function requiredColumn(frame: any, aliases: string[], filePath: string): unknown[] {
  const columns = (frame.columns as string[]).map((name) => ({ name, key: name.toLowerCase().replaceAll('_', '') }));
  const wanted = new Set(aliases.map((name) => name.toLowerCase().replaceAll('_', '')));
  const selected = columns.find((column) => wanted.has(column.key));
  if (!selected) throw new Error(`归档 Feather 缺少 ${aliases[0]} 字段：${filePath}`);
  return frame.getColumn(selected.name).toArray() as unknown[];
}

export function parseArchiveFeather(filePath: string, options: {
  symbol?: string;
  cutoff?: number;
  source?: string;
} = {}): ParsedArchiveCandles {
  const resolvedPath = resolve(filePath);
  const symbol = options.symbol ?? archiveSymbol(resolvedPath);
  if (!symbol || !(symbol in SYMBOL_MAP)) throw new Error(`归档文件不是 HyperNight 已知标的：${filePath}`);
  let frame: any;
  try {
    frame = pl.readIPC(readFileSync(resolvedPath)) as any;
  } catch (error) {
    throw new Error(`无法读取归档 Feather：${filePath}：${error instanceof Error ? error.message : String(error)}`);
  }
  const dates = requiredColumn(frame, ['date', 'timestamp', 'time'], filePath);
  const opens = requiredColumn(frame, ['open'], filePath);
  const highs = requiredColumn(frame, ['high'], filePath);
  const lows = requiredColumn(frame, ['low'], filePath);
  const closes = requiredColumn(frame, ['close'], filePath);
  const volumes = requiredColumn(frame, ['volume'], filePath);
  const lengths = [opens.length, highs.length, lows.length, closes.length, volumes.length];
  if (lengths.some((length) => length !== dates.length)) throw new Error(`归档 Feather 列长度不一致：${filePath}`);

  const cutoff = options.cutoff ?? Math.floor(Date.now() / BAR_MS) * BAR_MS;
  const source = options.source ?? HYPERARBITRARY_ARCHIVE_SOURCE;
  const byTimestamp = new Map<number, CandleBar>();
  let skippedOpenRows = 0;
  for (let index = 0; index < dates.length; index += 1) {
    const rawTimestamp = finite(dates[index]);
    const open = finite(opens[index]);
    const high = finite(highs[index]);
    const low = finite(lows[index]);
    const close = finite(closes[index]);
    const volume = finite(volumes[index]);
    const timestamp = rawTimestamp === null ? null : normalizeTimestamp(rawTimestamp);
    if (timestamp === null || timestamp <= 0 || timestamp % BAR_MS !== 0
      || open === null || high === null || low === null || close === null || volume === null
      || open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0
      || high < Math.max(open, close, low) || low > Math.min(open, close, high)) {
      throw new Error(`归档 Feather 第 ${index + 1} 行字段无效：${filePath}`);
    }
    // Hyperliquid candleSnapshot 的 T 是 bar 最后一毫秒，而非下一根 bar 的起点。
    const closeTimestamp = timestamp + BAR_MS - 1;
    if (closeTimestamp >= cutoff) {
      skippedOpenRows += 1;
      continue;
    }
    if (byTimestamp.has(timestamp)) throw new Error(`归档 Feather 存在重复时间点：${symbol}@${timestamp}`);
    byTimestamp.set(timestamp, {
      symbol,
      timestamp,
      closeTimestamp,
      open,
      high,
      low,
      close,
      volume,
      estimatedNotionalVolume: volume * (high + low + close) / 3,
      source
    });
  }
  const rows = [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp);
  return {
    filePath: resolvedPath,
    symbol,
    rows,
    inputRows: dates.length,
    skippedOpenRows,
    startTime: rows[0]?.timestamp ?? null,
    endTime: rows.at(-1)?.closeTimestamp ?? null
  };
}

function walkFiles(directory: string): string[] {
  const output: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...walkFiles(path));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}

function commandAvailable(command: string, args: string[]): boolean {
  try {
    execFileSync(command, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function findArchiveTool(): ArchiveTool {
  if (commandAvailable('7z', ['--help'])) return { command: '7z', kind: '7z' };
  if (commandAvailable('7zz', ['--help'])) return { command: '7zz', kind: '7z' };
  if (commandAvailable('bsdtar', ['--version'])) return { command: 'bsdtar', kind: 'bsdtar' };
  throw new Error('系统未安装可读取 7z 的 7z、7zz 或 bsdtar');
}

function listArchiveEntries(tool: ArchiveTool, archivePath: string): string[] {
  const output = tool.kind === '7z'
    ? execFileSync(tool.command, ['l', '-slt', archivePath], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    : execFileSync(tool.command, ['-tf', archivePath], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (tool.kind === 'bsdtar') return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return [...output.matchAll(/^Path = (.+)$/gm)].map((match) => match[1]!.trim());
}

function manifestMatches(path: string, expected: ExtractionManifestData): boolean {
  try {
    const current = JSON.parse(readFileSync(path, 'utf8')) as ExtractionManifestData;
    return current.archivePath === expected.archivePath
      && current.archiveSize === expected.archiveSize
      && current.archiveMtimeMs === expected.archiveMtimeMs
      && current.entries.length === expected.entries.length
      && current.entries.every((entry, index) => entry === expected.entries[index]);
  } catch {
    return false;
  }
}

function extractArchiveFiles(archivePath: string, extractionPath: string, entries: string[]): void {
  const archiveStat = statSync(archivePath);
  const manifest: ExtractionManifestData = {
    archivePath,
    archiveSize: archiveStat.size,
    archiveMtimeMs: archiveStat.mtimeMs,
    entries: [...entries].sort()
  };
  const manifestPath = join(extractionPath, EXTRACTION_MANIFEST);
  const extractedPaths = entries.map((entry) => join(extractionPath, entry));
  if (manifestMatches(manifestPath, manifest) && extractedPaths.every((path) => existsSync(path) && statSync(path).size > 0)) return;

  const tool = findArchiveTool();
  mkdirSync(extractionPath, { recursive: true });
  if (tool.kind === '7z') {
    execFileSync(tool.command, ['x', '-y', '-aoa', archivePath, ...entries, `-o${extractionPath}`], {
      stdio: 'inherit',
      maxBuffer: 32 * 1024 * 1024
    });
  } else {
    execFileSync(tool.command, ['-xf', archivePath, '-C', extractionPath, ...entries], {
      stdio: 'inherit',
      maxBuffer: 32 * 1024 * 1024
    });
  }
  const missing = extractedPaths.filter((path) => !existsSync(path) || statSync(path).size <= 0);
  if (missing.length) throw new Error(`归档提取后缺少 ${missing.length} 个 5m Feather 文件`);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function locateInputFiles(inputPath: string, requestedSymbols: string[], extractionPath?: string): LocatedFiles {
  const resolvedInput = resolve(inputPath);
  if (!existsSync(resolvedInput)) throw new Error(`归档输入不存在：${resolvedInput}`);
  const inputStat = statSync(resolvedInput);
  if (inputStat.isDirectory()) {
    const candidates = walkFiles(resolvedInput).filter((path) => ARCHIVE_FILE_PATTERN.test(basename(path))).sort();
    const bySymbol = new Map<string, string>();
    const unknownFiles: string[] = [];
    for (const path of candidates) {
      const symbol = archiveSymbol(path);
      if (!symbol) { unknownFiles.push(path); continue; }
      if (bySymbol.has(symbol)) throw new Error(`目录中同一标的存在多个 5m Feather：${symbol}`);
      bySymbol.set(symbol, path);
    }
    return {
      inputKind: 'directory',
      extractionPath: null,
      files: requestedSymbols.flatMap((symbol) => bySymbol.has(symbol) ? [{ symbol, filePath: bySymbol.get(symbol)! }] : []),
      missingSymbols: requestedSymbols.filter((symbol) => !bySymbol.has(symbol)),
      unknownFiles
    };
  }
  if (resolvedInput.toLowerCase().endsWith('.feather')) {
    const symbol = archiveSymbol(resolvedInput);
    const selected = symbol && requestedSymbols.includes(symbol) ? [{ symbol, filePath: resolvedInput }] : [];
    return {
      inputKind: 'feather',
      extractionPath: null,
      files: selected,
      missingSymbols: requestedSymbols.filter((item) => item !== symbol),
      unknownFiles: symbol ? [] : [resolvedInput]
    };
  }
  if (!resolvedInput.toLowerCase().endsWith('.7z')) throw new Error(`仅支持 .7z、目录或单个 .feather：${resolvedInput}`);

  const tool = findArchiveTool();
  const listed = new Set(listArchiveEntries(tool, resolvedInput));
  const entries = requestedSymbols.map((symbol) => ({ symbol, entry: archiveEntryForSymbol(symbol) }));
  const available = entries.filter(({ entry }) => listed.has(entry));
  const resolvedExtraction = resolve(extractionPath ?? join(dirname(resolvedInput), 'hyperliquid-market-archive'));
  if (available.length) extractArchiveFiles(resolvedInput, resolvedExtraction, available.map(({ entry }) => entry));
  return {
    inputKind: '7z',
    extractionPath: resolvedExtraction,
    files: available.map(({ symbol, entry }) => ({ symbol, filePath: join(resolvedExtraction, entry) })),
    missingSymbols: entries.filter(({ entry }) => !listed.has(entry)).map(({ symbol }) => symbol),
    unknownFiles: []
  };
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(1e-9, Math.max(Math.abs(left), Math.abs(right)) * 1e-10);
}

function candlesEqual(left: CandleBar, right: CandleBar): boolean {
  return left.closeTimestamp === right.closeTimestamp
    && nearlyEqual(left.open, right.open)
    && nearlyEqual(left.high, right.high)
    && nearlyEqual(left.low, right.low)
    && nearlyEqual(left.close, right.close)
    && nearlyEqual(left.volume, right.volume)
    && nearlyEqual(left.estimatedNotionalVolume, right.estimatedNotionalVolume);
}

function writeChunks(database: HyperNightDb, rows: CandleBar[], chunkSize: number): number {
  let written = 0;
  for (let start = 0; start < rows.length; start += chunkSize) {
    written += database.upsertCandles('5m', rows.slice(start, start + chunkSize));
  }
  return written;
}

export function importArchiveCandles(database: HyperNightDb, options: {
  inputPath: string;
  extractionPath?: string;
  symbols?: string[];
  cutoff?: number;
  dryRun?: boolean;
  overwriteExisting?: boolean;
  strictUnknown?: boolean;
  source?: string;
  chunkSize?: number;
}): ArchiveImportSummary {
  const startedAt = Date.now();
  const requestedSymbols = normalizeSymbols(options.symbols ?? DEFAULT_SYMBOLS);
  if (!requestedSymbols.length) throw new Error('没有可导入的 HyperNight 标的');
  const located = locateInputFiles(options.inputPath, requestedSymbols, options.extractionPath);
  if (options.strictUnknown && located.unknownFiles.length) {
    throw new Error(`归档目录包含 ${located.unknownFiles.length} 个未知标的文件`);
  }
  if (!located.files.length) throw new Error('归档中没有找到请求标的的 5m Feather');

  const source = options.source ?? HYPERARBITRARY_ARCHIVE_SOURCE;
  const dryRun = options.dryRun ?? false;
  const overwriteExisting = options.overwriteExisting ?? false;
  const chunkSize = Math.max(1, Math.trunc(options.chunkSize ?? 5_000));
  const files: ArchiveImportFileResult[] = [];
  for (const locatedFile of located.files) {
    const parsed = parseArchiveFeather(locatedFile.filePath, {
      symbol: locatedFile.symbol,
      ...(options.cutoff === undefined ? {} : { cutoff: options.cutoff }),
      source
    });
    const existing = parsed.startTime === null || parsed.endTime === null
      ? []
      : database.candles([parsed.symbol], parsed.startTime, parsed.endTime, '5m');
    const existingByTimestamp = new Map(existing.map((row) => [row.timestamp, row]));
    let matchingOverlapRows = 0;
    let differingOverlapRows = 0;
    const differingTimestamps: number[] = [];
    for (const row of parsed.rows) {
      const current = existingByTimestamp.get(row.timestamp);
      if (!current) continue;
      if (candlesEqual(current, row)) matchingOverlapRows += 1;
      else {
        differingOverlapRows += 1;
        if (differingTimestamps.length < 10) differingTimestamps.push(row.timestamp);
      }
    }
    const rowsToWrite = overwriteExisting
      ? parsed.rows
      : parsed.rows.filter((row) => !existingByTimestamp.has(row.timestamp));
    const beforeCount = database.candleBounds([parsed.symbol], '5m')?.rowCount ?? 0;
    if (!dryRun) writeChunks(database, rowsToWrite, chunkSize);
    const afterCount = dryRun ? beforeCount + rowsToWrite.length : database.candleBounds([parsed.symbol], '5m')?.rowCount ?? 0;
    files.push({
      filePath: parsed.filePath,
      symbol: parsed.symbol,
      inputRows: parsed.inputRows,
      acceptedRows: parsed.rows.length,
      skippedOpenRows: parsed.skippedOpenRows,
      overlapRows: matchingOverlapRows + differingOverlapRows,
      matchingOverlapRows,
      differingOverlapRows,
      writeRows: rowsToWrite.length,
      addedRows: Math.max(0, afterCount - beforeCount),
      startTime: parsed.startTime,
      endTime: parsed.endTime,
      differingTimestamps
    });
  }

  const sum = (select: (file: ArchiveImportFileResult) => number) => files.reduce((total, file) => total + select(file), 0);
  return {
    inputPath: resolve(options.inputPath),
    inputKind: located.inputKind,
    extractionPath: located.extractionPath,
    source,
    dryRun,
    overwriteExisting,
    requestedSymbols,
    importedSymbols: files.map((file) => file.symbol),
    missingSymbols: located.missingSymbols,
    unknownFiles: located.unknownFiles,
    inputRows: sum((file) => file.inputRows),
    acceptedRows: sum((file) => file.acceptedRows),
    skippedOpenRows: sum((file) => file.skippedOpenRows),
    overlapRows: sum((file) => file.overlapRows),
    matchingOverlapRows: sum((file) => file.matchingOverlapRows),
    differingOverlapRows: sum((file) => file.differingOverlapRows),
    writeRows: sum((file) => file.writeRows),
    addedRows: sum((file) => file.addedRows),
    startedAt,
    completedAt: Date.now(),
    files
  };
}
