import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from 'node:process';

import { loadFactorData } from './analysis-data.js';
import { runBacktest } from './backtest.js';
import { resolveConfig } from './config.js';
import { DEFAULT_CONFIG, DEFAULT_DB_PATH, DEFAULT_SYMBOLS, normalizeSymbols } from './constants.js';
import { HyperNightDb } from './db.js';
import { MarketDataService } from './market-data.js';
import { DEFAULT_OPTIMIZATION_AXES, runParameterOptimization } from './optimizer.js';
import { initializePaperAccount, paperStatus, tickPaper } from './paper.js';
import { runResearch } from './research.js';
import type { OptimizationAxisKey, OptimizationResult, StrategyConfig } from './types.js';

try {
  loadEnvFile('.env');
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

interface JsonBody {
  symbols?: unknown;
  days?: unknown;
  startTime?: unknown;
  endTime?: unknown;
  config?: unknown;
  refresh?: unknown;
  replay?: unknown;
  startAfterTimestamp?: unknown;
  trials?: unknown;
  folds?: unknown;
  seed?: unknown;
  axes?: unknown;
  costScenariosBps?: unknown;
}

export interface WebServerOptions {
  dbPath?: string;
  webRoot?: string;
}

export interface HyperNightWebServer {
  server: Server;
  database: HyperNightDb;
  close: () => Promise<void>;
}

function securityHeaders(response: ServerResponse): void {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'");
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  securityHeaders(response);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(JSON.stringify(value));
}

async function readJson(request: IncomingMessage): Promise<JsonBody> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new Error('请求体超过 1 MB');
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请求体必须是 JSON 对象');
  return parsed as JsonBody;
}

function optionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${name} 必须是有限数值`);
  return number;
}

function requestSymbols(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error('symbols 必须是字符串数组');
  return normalizeSymbols(value as string[]);
}

function requestConfig(value: unknown): StrategyConfig {
  return resolveConfig(value);
}

function requestAxes(value: unknown): OptimizationAxisKey[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error('axes 必须是字符串数组');
  const allowed = new Set(DEFAULT_OPTIMIZATION_AXES.map((axis) => axis.key));
  const axes = [...new Set(value as string[])];
  if (axes.some((axis) => !allowed.has(axis as OptimizationAxisKey))) throw new Error('axes 包含不支持的参数');
  return axes as OptimizationAxisKey[];
}

function requestNumberArray(value: unknown, name: string): number[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${name} 必须是数值数组`);
  const values = value.map(Number);
  if (values.some((item) => !Number.isFinite(item))) throw new Error(`${name} 必须是有限数值数组`);
  return values;
}

function statusCounts(values: Array<{ status: string }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value.status] = (counts[value.status] ?? 0) + 1;
  return counts;
}

export function createHyperNightWebServer(options: WebServerOptions = {}): HyperNightWebServer {
  const database = new HyperNightDb(options.dbPath ?? process.env.HYPERNIGHT_DB_PATH ?? DEFAULT_DB_PATH);
  const webRoot = resolve(options.webRoot ?? process.env.HYPERNIGHT_WEB_ROOT ?? resolve(process.cwd(), 'frontend', 'dist'));
  let activeTask: string | null = null;

  const bootstrap = () => {
    const optimization = database.latestRun<OptimizationResult>('optimization');
    const backtest = database.latestRun<ReturnType<typeof runBacktest>>('backtest');
    return {
      generatedAt: Date.now(),
      database: {
        path: database.path,
        counts: database.tableCounts(),
        candleBounds5m: database.candleBounds(DEFAULT_SYMBOLS, '5m'),
        candleBounds1d: database.candleBounds(DEFAULT_SYMBOLS, '1d'),
        coverage: database.symbolCoverage(),
        marketContexts: database.latestMarketContexts(),
        audit: database.marketDataAudit()
      },
      config: optimization?.bestConfig ?? backtest?.config ?? DEFAULT_CONFIG,
      symbols: DEFAULT_SYMBOLS,
      research: database.latestRun('research'),
      optimization,
      backtest,
      paper: paperStatus(database),
      activeTask
    };
  };

  const runTask = async <T>(name: string, work: () => Promise<T> | T): Promise<T> => {
    if (activeTask) throw new Error(`已有任务正在运行：${activeTask}`);
    activeTask = name;
    try {
      return await work();
    } finally {
      activeTask = null;
    }
  };

  const api = async (request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean> => {
    if (!pathname.startsWith('/api/')) return false;
    try {
      if (request.method === 'GET' && pathname === '/api/health') {
        sendJson(response, 200, { ok: true, activeTask, database: database.path, now: Date.now() });
        return true;
      }
      if (request.method === 'GET' && pathname === '/api/bootstrap') {
        sendJson(response, 200, bootstrap());
        return true;
      }
      if (request.method === 'GET' && pathname === '/api/paper/status') {
        sendJson(response, 200, paperStatus(database));
        return true;
      }
      if (request.method === 'GET' && pathname === '/api/research/latest') {
        sendJson(response, 200, database.latestRun('research'));
        return true;
      }
      if (request.method === 'GET' && pathname === '/api/backtest/latest') {
        sendJson(response, 200, database.latestRun('backtest'));
        return true;
      }
      if (request.method === 'GET' && pathname === '/api/optimization/latest') {
        sendJson(response, 200, database.latestRun('optimization'));
        return true;
      }
      if (request.method === 'GET' && pathname === '/api/factors/latest') {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        const symbols = normalizeSymbols(url.searchParams.get('symbols')?.split(',') ?? undefined);
        const latestOptimization = database.latestRun<OptimizationResult>('optimization');
        const latestBacktest = database.latestRun<ReturnType<typeof runBacktest>>('backtest');
        const config = latestOptimization?.bestConfig ?? latestBacktest?.config ?? DEFAULT_CONFIG;
        const factors = loadFactorData(database, { symbols, config, includeOpenWindow: true });
        const latestTimestamp = factors.rows.reduce((latest, row) => Math.max(latest, row.timestamp), 0);
        sendJson(response, 200, {
          timestamp: latestTimestamp || null,
          rows: factors.rows.filter((row) => row.timestamp === latestTimestamp)
            .sort((a, b) => Number(b.eligible) - Number(a.eligible) || a.rank - b.rank || b.score - a.score),
          sessionStatuses: statusCounts(factors.audits),
          warnings: factors.warnings
        });
        return true;
      }
      if (request.method === 'POST' && pathname === '/api/data/backfill') {
        const body = await readJson(request);
        const symbols = requestSymbols(body.symbols);
        const days = optionalNumber(body.days, 'days');
        const result = await runTask('行情回补', () => new MarketDataService(database).backfill({
          ...(symbols === undefined ? {} : { symbols }),
          ...(days === undefined ? {} : { days })
        }));
        sendJson(response, 200, result);
        return true;
      }
      if (request.method === 'POST' && pathname === '/api/research') {
        const body = await readJson(request);
        const symbols = requestSymbols(body.symbols);
        const startTime = optionalNumber(body.startTime, 'startTime');
        const endTime = optionalNumber(body.endTime, 'endTime');
        const config = requestConfig(body.config);
        const result = await runTask('多因子研究', () => runResearch(database, {
          config,
          ...(symbols === undefined ? {} : { symbols }),
          ...(startTime === undefined ? {} : { startTime }),
          ...(endTime === undefined ? {} : { endTime })
        }));
        sendJson(response, 200, result);
        return true;
      }
      if (request.method === 'POST' && pathname === '/api/backtest') {
        const body = await readJson(request);
        const symbols = requestSymbols(body.symbols);
        const startTime = optionalNumber(body.startTime, 'startTime');
        const endTime = optionalNumber(body.endTime, 'endTime');
        const config = requestConfig(body.config);
        const result = await runTask('组合回测', () => runBacktest(database, {
          config,
          ...(symbols === undefined ? {} : { symbols }),
          ...(startTime === undefined ? {} : { startTime }),
          ...(endTime === undefined ? {} : { endTime })
        }));
        sendJson(response, 200, result);
        return true;
      }
      if (request.method === 'POST' && pathname === '/api/optimization') {
        const body = await readJson(request);
        const symbols = requestSymbols(body.symbols);
        const startTime = optionalNumber(body.startTime, 'startTime');
        const endTime = optionalNumber(body.endTime, 'endTime');
        const trials = optionalNumber(body.trials, 'trials');
        const folds = optionalNumber(body.folds, 'folds');
        const seed = optionalNumber(body.seed, 'seed');
        const axes = requestAxes(body.axes);
        const costScenariosBps = requestNumberArray(body.costScenariosBps, 'costScenariosBps');
        const config = requestConfig(body.config);
        const result = await runTask('参数优化与正式回测', () => runParameterOptimization(database, {
          config,
          ...(symbols === undefined ? {} : { symbols }),
          ...(startTime === undefined ? {} : { startTime }),
          ...(endTime === undefined ? {} : { endTime }),
          ...(trials === undefined ? {} : { trials }),
          ...(folds === undefined ? {} : { folds }),
          ...(seed === undefined ? {} : { seed }),
          ...(axes === undefined ? {} : { axes }),
          ...(costScenariosBps === undefined ? {} : { costScenariosBps })
        }));
        sendJson(response, 200, result);
        return true;
      }
      if (request.method === 'POST' && pathname === '/api/paper/init') {
        const body = await readJson(request);
        const symbols = requestSymbols(body.symbols);
        const config = requestConfig(body.config);
        const explicitStart = optionalNumber(body.startAfterTimestamp, 'startAfterTimestamp');
        const account = await runTask('初始化模拟账户', () => initializePaperAccount(database, config, {
          ...(symbols === undefined ? {} : { symbols }),
          ...(body.replay === true
            ? { startAfterTimestamp: null }
            : explicitStart === undefined ? {} : { startAfterTimestamp: explicitStart })
        }));
        sendJson(response, 200, { account, status: paperStatus(database) });
        return true;
      }
      if (request.method === 'POST' && pathname === '/api/paper/tick') {
        const body = await readJson(request);
        const symbols = requestSymbols(body.symbols);
        const endTime = optionalNumber(body.endTime, 'endTime');
        const result = await runTask('模拟盘推进', async () => {
          if (body.refresh === true) {
            const days = optionalNumber(body.days, 'days') ?? 3;
            await new MarketDataService(database).backfill({
              ...(symbols === undefined ? {} : { symbols }),
              days
            });
          }
          return tickPaper(database, {
            ...(symbols === undefined ? {} : { symbols }),
            ...(endTime === undefined ? {} : { endTime })
          });
        });
        sendJson(response, 200, { result, status: paperStatus(database) });
        return true;
      }
      sendJson(response, 404, { error: `不存在的 API：${request.method} ${pathname}` });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /已有任务正在运行/.test(message) ? 409 : 400;
      sendJson(response, status, { error: message });
      return true;
    }
  };

  const staticFile = async (request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> => {
    const requested = pathname === '/' ? '/index.html' : decodeURIComponent(pathname);
    const documentationPath = resolve(process.cwd(), 'README.md');
    const filePath = requested === '/README.md' ? documentationPath : resolve(webRoot, `.${requested}`);
    const isDocumentation = filePath === documentationPath && requested === '/README.md';
    if (!isDocumentation && filePath !== webRoot && !filePath.startsWith(`${webRoot}${sep}`)) {
      sendJson(response, 403, { error: '禁止访问该路径' });
      return;
    }
    try {
      const content = await readFile(filePath);
      securityHeaders(response);
      response.writeHead(200, {
        'Content-Type': MIME_TYPES[extname(filePath)] ?? 'application/octet-stream',
        'Cache-Control': extname(filePath) === '.html' ? 'no-cache' : 'public, max-age=300'
      });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (pathname !== '/' && !extname(pathname)) {
        try {
          const index = await readFile(resolve(webRoot, 'index.html'));
          securityHeaders(response);
          response.writeHead(200, { 'Content-Type': MIME_TYPES['.html'], 'Cache-Control': 'no-cache' });
          response.end(index);
          return;
        } catch { /* fall through to 404 */ }
      }
      sendJson(response, 404, { error: '页面资源不存在' });
    }
  };

  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    void api(request, response, pathname).then((handled) => {
      if (!handled) return staticFile(request, response, pathname);
    }).catch((error: unknown) => {
      if (!response.headersSent) sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
      else response.end();
    });
  });

  return {
    server,
    database,
    close: () => new Promise<void>((resolveClose, reject) => {
      server.close((error) => {
        database.close();
        if (error) reject(error);
        else resolveClose();
      });
    })
  };
}

export async function startHyperNightWebServer(options: WebServerOptions & { port?: number; host?: string } = {}): Promise<HyperNightWebServer> {
  const app = createHyperNightWebServer(options);
  const port = options.port ?? Number(process.env.HYPERNIGHT_PORT ?? 4317);
  const host = options.host ?? process.env.HYPERNIGHT_HOST ?? '127.0.0.1';
  await new Promise<void>((resolveListen, reject) => {
    app.server.once('error', reject);
    app.server.listen(port, host, () => {
      app.server.off('error', reject);
      resolveListen();
    });
  });
  const address = app.server.address();
  const resolvedPort = typeof address === 'object' && address ? address.port : port;
  process.stdout.write(`HyperNight Web: http://${host}:${resolvedPort}\n`);
  return app;
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (entryPath === fileURLToPath(import.meta.url)) {
  const app = await startHyperNightWebServer();
  const shutdown = () => { void app.close().finally(() => process.exit(0)); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
