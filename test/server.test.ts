import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { HyperNightDb } from '../src/db.js';
import { createHyperNightWebServer, type HyperNightWebServer } from '../src/server.js';
import { seedTestMarketData, TEST_MARKET_SYMBOLS, testConfig } from './helpers.js';

async function listen(app: HyperNightWebServer): Promise<string> {
  await new Promise<void>((resolveListen, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', () => {
      app.server.off('error', reject);
      resolveListen();
    });
  });
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

test('Web 工作台运行真实入口并在重启后恢复最新优化与回测', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hypernight-web-'));
  const dbPath = join(directory, 'web.db');
  const config = testConfig();
  const seeded = new HyperNightDb(dbPath);
  seedTestMarketData(seeded, config);
  seeded.close();

  let app = createHyperNightWebServer({
    dbPath,
    webRoot: fileURLToPath(new URL('../frontend/dist/', import.meta.url))
  });
  let open = false;

  try {
    let baseUrl = await listen(app);
    open = true;

    const healthResponse = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthResponse.status, 200);
    assert.match(healthResponse.headers.get('content-type') ?? '', /application\/json/);
    assert.equal((await healthResponse.json() as { ok: boolean }).ok, true);

    const homeResponse = await fetch(`${baseUrl}/`);
    const home = await homeResponse.text();
    assert.equal(homeResponse.status, 200);
    assert.match(homeResponse.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    assert.match(home, /HyperNight/);
    assert.match(home, /id="root"/);

    const docsResponse = await fetch(`${baseUrl}/README.md`);
    assert.equal(docsResponse.status, 200);
    assert.match(await docsResponse.text(), /Web 工作台/);

    const scriptPath = home.match(/<script[^>]+src="([^"]+)"/)?.[1];
    assert.ok(scriptPath);
    const scriptResponse = await fetch(`${baseUrl}${scriptPath}`);
    assert.equal(scriptResponse.status, 200);
    assert.match(scriptResponse.headers.get('content-type') ?? '', /text\/javascript/);
    assert.ok((await scriptResponse.text()).length > 100_000);

    const removedDemoResponse = await fetch(`${baseUrl}/api/demo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(removedDemoResponse.status, 404);

    const researchResponse = await fetch(`${baseUrl}/api/research`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbols: TEST_MARKET_SYMBOLS, config })
    });
    assert.equal(researchResponse.status, 200);

    const optimizationResponse = await fetch(`${baseUrl}/api/optimization`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbols: TEST_MARKET_SYMBOLS,
        config,
        trials: 4,
        folds: 2,
        axes: ['entryDeviation', 'maxPositions'],
        costScenariosBps: [0, 2],
        seed: 7
      })
    });
    assert.equal(optimizationResponse.status, 200);
    const completed = await optimizationResponse.json() as {
      optimization: { runId: string; formalBacktestRunId: string; trials: unknown[]; bestConfig: { entryDeviation: number } };
      backtest: { runId: string };
    };
    assert.equal(completed.optimization.trials.length, 4);
    assert.equal(completed.optimization.formalBacktestRunId, completed.backtest.runId);

    const bootstrapResponse = await fetch(`${baseUrl}/api/bootstrap`);
    assert.equal(bootstrapResponse.status, 200);
    const bootstrap = await bootstrapResponse.json() as {
      activeTask: string | null;
      config: { entryDeviation: number };
      database: { coverage: unknown[]; counts: Record<string, number>; audit: { syntheticRows: number } };
      research: { runId: string } | null;
      optimization: { runId: string; formalBacktestRunId: string } | null;
      backtest: { runId: string } | null;
    };
    assert.equal(bootstrap.activeTask, null);
    assert.equal(bootstrap.database.coverage.length, 3);
    assert.equal(bootstrap.database.audit.syntheticRows, 0);
    assert.ok((bootstrap.database.counts.runs ?? 0) >= 3);
    assert.ok(bootstrap.research?.runId);
    assert.equal(bootstrap.optimization?.runId, completed.optimization.runId);
    assert.equal(bootstrap.backtest?.runId, completed.backtest.runId);
    assert.equal(bootstrap.config.entryDeviation, completed.optimization.bestConfig.entryDeviation);

    const factorsResponse = await fetch(`${baseUrl}/api/factors/latest?symbols=xyz%3AAAPL%2Cxyz%3AMSFT%2Cxyz%3ANVDA`);
    assert.equal(factorsResponse.status, 200);
    const factors = await factorsResponse.json() as { timestamp: number | null; rows: unknown[] };
    assert.ok(factors.timestamp);
    assert.equal(factors.rows.length, 3);

    const invalidConfigResponse = await fetch(`${baseUrl}/api/backtest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: { entryDeviation: 0.01, exitDeviation: 0.02 } })
    });
    assert.equal(invalidConfigResponse.status, 400);
    assert.match((await invalidConfigResponse.json() as { error: string }).error, /exitDeviation/);

    await app.close();
    open = false;
    app = createHyperNightWebServer({
      dbPath,
      webRoot: fileURLToPath(new URL('../frontend/dist/', import.meta.url))
    });
    baseUrl = await listen(app);
    open = true;

    const restored = await fetch(`${baseUrl}/api/bootstrap`).then((response) => response.json()) as {
      optimization: { runId: string; formalBacktestRunId: string } | null;
      backtest: { runId: string } | null;
    };
    assert.equal(restored.optimization?.runId, completed.optimization.runId);
    assert.equal(restored.optimization?.formalBacktestRunId, completed.backtest.runId);
    assert.equal(restored.backtest?.runId, completed.backtest.runId);
  } finally {
    if (open) await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
