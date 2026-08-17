#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';

import { runBacktest } from './backtest.js';
import { resolveConfig } from './config.js';
import { DEFAULT_DB_PATH, normalizeSymbols } from './constants.js';
import { HyperNightDb } from './db.js';
import { MarketDataService } from './market-data.js';
import { runParameterOptimization } from './optimizer.js';
import { initializePaperAccount, paperStatus, tickPaper } from './paper.js';
import { runResearch } from './research.js';

try {
  loadEnvFile('.env');
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
}

interface ParsedArguments {
  command: string;
  flags: Map<string, string | boolean>;
}

function parseArguments(argv: string[]): ParsedArguments {
  const command = argv[0] ?? 'help';
  const flags = new Map<string, string | boolean>();
  for (let index = 1; index < argv.length; index += 1) {
    const item = argv[index]!;
    if (!item.startsWith('--')) throw new Error(`无法识别参数：${item}`);
    const equals = item.indexOf('=');
    if (equals > 2) {
      flags.set(item.slice(2, equals), item.slice(equals + 1));
      continue;
    }
    const name = item.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(name, next);
      index += 1;
    } else {
      flags.set(name, true);
    }
  }
  return { command, flags };
}

function textFlag(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

function integerFlag(flags: Map<string, string | boolean>, name: string): number | undefined {
  const raw = textFlag(flags, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`--${name} 必须是整数`);
  return value;
}

function timestampFlag(flags: Map<string, string | boolean>, name: string): number | undefined {
  const raw = textFlag(flags, name);
  if (raw === undefined) return undefined;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && /^\d+$/.test(raw)) return numeric;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} 不是有效时间戳或 ISO 时间`);
  return parsed;
}

function symbolsFlag(flags: Map<string, string | boolean>): string[] | undefined {
  const raw = textFlag(flags, 'symbols') ?? process.env.HYPERNIGHT_SYMBOLS;
  if (!raw) return undefined;
  return normalizeSymbols(raw.split(','));
}

function loadConfig(flags: Map<string, string | boolean>) {
  const path = textFlag(flags, 'config');
  const environmentJson = process.env.HYPERNIGHT_CONFIG_JSON;
  if (path) return resolveConfig(JSON.parse(readFileSync(resolve(path), 'utf8')));
  if (environmentJson) return resolveConfig(JSON.parse(environmentJson));
  return resolveConfig();
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function help(): void {
  process.stdout.write(`HyperNight — HIP-3 休市截面多因子研究、回测与模拟交易\n\n`);
  process.stdout.write(`命令：\n`);
  process.stdout.write(`  data:backfill  [--db PATH] [--symbols AAPL,MSFT] [--days 17]\n`);
  process.stdout.write(`  research       [--db PATH] [--config config.json] [--start ISO] [--end ISO]\n`);
  process.stdout.write(`  backtest       [--db PATH] [--config config.json] [--start ISO] [--end ISO]\n`);
  process.stdout.write(`  optimize       [--db PATH] [--config config.json] [--start ISO] [--end ISO] [--trials 60] [--folds 3]\n`);
  process.stdout.write(`  paper:init     [--db PATH] [--config config.json] [--replay | --after ISO]\n`);
  process.stdout.write(`  paper:tick     [--db PATH] [--refresh] [--days 3] [--end ISO]\n`);
  process.stdout.write(`  paper:status   [--db PATH] [--full]\n`);
  process.stdout.write(`\n`);
  process.stdout.write(`环境变量：HYPERNIGHT_DB_PATH、HYPERNIGHT_SYMBOLS、HYPERNIGHT_CONFIG_JSON\n`);
}

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.command === 'help' || parsed.command === '--help' || parsed.flags.has('help')) {
    help();
    return;
  }
  const config = loadConfig(parsed.flags);
  const symbols = symbolsFlag(parsed.flags);
  const days = integerFlag(parsed.flags, 'days');
  const startTime = timestampFlag(parsed.flags, 'start');
  const endTime = timestampFlag(parsed.flags, 'end');
  const dbPath = textFlag(parsed.flags, 'db') ?? process.env.HYPERNIGHT_DB_PATH ?? DEFAULT_DB_PATH;
  const database = new HyperNightDb(dbPath);
  try {
    if (parsed.command === 'data:backfill') {
      const service = new MarketDataService(database);
      print(await service.backfill({
        ...(symbols === undefined ? {} : { symbols }),
        ...(days === undefined ? {} : { days })
      }));
      return;
    }
    if (parsed.command === 'research') {
      const result = runResearch(database, {
        config,
        ...(symbols === undefined ? {} : { symbols }),
        ...(startTime === undefined ? {} : { startTime }),
        ...(endTime === undefined ? {} : { endTime })
      });
      print(parsed.flags.has('full') ? result : {
        runId: result.runId,
        rows: result.rowCount,
        eligibleRows: result.eligibleCount,
        sessions: result.sessionCount,
        factorMetrics: result.factorMetrics,
        topScoreForwardReturnPct: result.topScoreForwardReturnPct,
        allForwardReturnPct: result.allForwardReturnPct,
        latestScores: result.latestScores.slice(0, 10),
        warnings: result.warnings
      });
      return;
    }
    if (parsed.command === 'backtest') {
      const result = runBacktest(database, {
        config,
        ...(symbols === undefined ? {} : { symbols }),
        ...(startTime === undefined ? {} : { startTime }),
        ...(endTime === undefined ? {} : { endTime })
      });
      print(parsed.flags.has('full') ? result : {
        runId: result.runId,
        portfolio: result.portfolio,
        noHedgePortfolio: result.noHedgePortfolio,
        maxConcurrentPositions: result.maxConcurrentPositions,
        trades: result.trades.slice(0, 10),
        warnings: result.warnings
      });
      return;
    }
    if (parsed.command === 'optimize') {
      const trials = integerFlag(parsed.flags, 'trials');
      const folds = integerFlag(parsed.flags, 'folds');
      const seed = integerFlag(parsed.flags, 'seed');
      const result = runParameterOptimization(database, {
        config,
        ...(symbols === undefined ? {} : { symbols }),
        ...(startTime === undefined ? {} : { startTime }),
        ...(endTime === undefined ? {} : { endTime }),
        ...(trials === undefined ? {} : { trials }),
        ...(folds === undefined ? {} : { folds }),
        ...(seed === undefined ? {} : { seed })
      });
      print(parsed.flags.has('full') ? result : {
        optimizationRunId: result.optimization.runId,
        formalBacktestRunId: result.optimization.formalBacktestRunId,
        recommendationStatus: result.optimization.recommendationStatus,
        datasetVersion: result.optimization.datasetVersion,
        sessions: result.optimization.sessionCount,
        trials: result.optimization.trials.length,
        bestValidation: result.optimization.bestValidation,
        testWindow: result.optimization.testWindow,
        costStress: result.optimization.costStress,
        bestConfig: result.optimization.bestConfig,
        backtest: result.backtest.portfolio,
        warnings: result.optimization.warnings
      });
      return;
    }
    if (parsed.command === 'paper:init') {
      const after = timestampFlag(parsed.flags, 'after');
      const account = initializePaperAccount(database, config, {
        ...(symbols === undefined ? {} : { symbols }),
        ...(parsed.flags.has('replay')
          ? { startAfterTimestamp: null }
          : after === undefined ? {} : { startAfterTimestamp: after })
      });
      print(account);
      return;
    }
    if (parsed.command === 'paper:tick') {
      if (parsed.flags.has('refresh')) {
        const service = new MarketDataService(database);
        await service.backfill({
          ...(symbols === undefined ? {} : { symbols }),
          days: days ?? 3
        });
      }
      print(tickPaper(database, {
        ...(symbols === undefined ? {} : { symbols }),
        ...(endTime === undefined ? {} : { endTime })
      }));
      return;
    }
    if (parsed.command === 'paper:status') {
      const status = paperStatus(database);
      print(parsed.flags.has('full') ? status : {
        account: status.account,
        openPositions: status.positions,
        recentTrades: status.trades.slice(0, 10),
        latestEquity: status.equity[0] ?? null
      });
      return;
    }
    throw new Error(`未知命令：${parsed.command}`);
  } finally {
    database.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`HyperNight: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
