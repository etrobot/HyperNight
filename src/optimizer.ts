import { createHash } from 'node:crypto';

import { runBacktest, simulatePortfolio } from './backtest.js';
import { resolveConfig } from './config.js';
import {
  FEATURE_ENGINE_VERSION,
  OPTIMIZATION_VERSION,
  STRATEGY_VERSION,
  normalizeSymbols
} from './constants.js';
import type { HyperNightDb } from './db.js';
import { loadFactorData } from './analysis-data.js';
import { computePerformanceMetrics } from './simulator.js';
import type {
  FactorBuildResult,
  OptimizationAxis,
  OptimizationAxisKey,
  OptimizationFoldMetric,
  OptimizationResult,
  OptimizationScore,
  OptimizationTrial,
  StrategyConfig
} from './types.js';

export const DEFAULT_OPTIMIZATION_AXES: OptimizationAxis[] = [
  { key: 'entryDeviation', label: '开仓偏离', min: 0.02, max: 0.12, step: 0.01 },
  { key: 'exitDeviation', label: '退出偏离', min: 0.0025, max: 0.04, step: 0.0025 },
  { key: 'maxPositions', label: '最大持仓', min: 1, max: 10, step: 1, integer: true },
  { key: 'grossNotionalPct', label: '组合毛敞口', min: 0.25, max: 2, step: 0.25 },
  { key: 'takeProfit', label: '止盈', min: 0.005, max: 0.08, step: 0.005 },
  { key: 'stopLoss', label: '止损', min: 0.005, max: 0.08, step: 0.005 },
  { key: 'maxHoldBars', label: '最长持有', min: 12, max: 144, step: 12, integer: true },
  { key: 'hedgeStep', label: '对冲步长', min: 0.01, max: 0.05, step: 0.005 },
  { key: 'hedgeFraction', label: '单次对冲', min: 0.05, max: 0.5, step: 0.05 },
  { key: 'maxHedgeRatio', label: '对冲上限', min: 0.2, max: 1, step: 0.1 }
];

export interface ParameterOptimizationOptions {
  symbols?: string[];
  startTime?: number;
  endTime?: number;
  config: StrategyConfig;
  axes?: OptimizationAxisKey[];
  trials?: number;
  folds?: number;
  costScenariosBps?: number[];
  seed?: number;
}

interface SessionWindow {
  sessionDate: string;
  startTime: number;
  endTime: number;
}

interface SplitWindows {
  validation: SessionWindow[][];
  test: SessionWindow[];
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function clamp(axis: OptimizationAxis, value: number): number {
  const bounded = Math.min(axis.max, Math.max(axis.min, value));
  const stepped = axis.min + Math.round((bounded - axis.min) / axis.step) * axis.step;
  const normalized = Math.min(axis.max, Math.max(axis.min, stepped));
  return axis.integer ? Math.round(normalized) : Math.round(normalized * 1e9) / 1e9;
}

function valuesForAxis(axis: OptimizationAxis): number[] {
  const count = Math.max(0, Math.floor((axis.max - axis.min) / axis.step + 1e-9));
  return Array.from({ length: count + 1 }, (_, index) => clamp(axis, axis.min + index * axis.step));
}

function configValue(config: StrategyConfig, key: OptimizationAxisKey): number {
  return config[key];
}

function paramsFromConfig(config: StrategyConfig, axes: OptimizationAxis[]): Record<OptimizationAxisKey, number> {
  return Object.fromEntries(axes.map((axis) => [axis.key, clamp(axis, configValue(config, axis.key))])) as Record<OptimizationAxisKey, number>;
}

function applyParams(base: StrategyConfig, params: Partial<Record<OptimizationAxisKey, number>>, axes: OptimizationAxis[]): StrategyConfig {
  const next = { ...base, factorWeights: { ...base.factorWeights } };
  const writable = next as unknown as Record<OptimizationAxisKey, number>;
  for (const axis of axes) {
    const value = params[axis.key];
    if (value !== undefined) writable[axis.key] = clamp(axis, value);
  }
  if (next.exitDeviation >= next.entryDeviation) {
    next.exitDeviation = Math.max(0.0001, Math.min(next.entryDeviation - 0.0001, next.entryDeviation / 2));
  }
  return resolveConfig(next);
}

function createRng(seed: number): () => number {
  let state = (Math.trunc(seed) >>> 0) || 0x6d2b79f5;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function buildCandidates(base: StrategyConfig, axes: OptimizationAxis[], target: number, seed: number): Array<Record<OptimizationAxisKey, number>> {
  if (!axes.length) return [paramsFromConfig(base, axes)];
  const random = createRng(seed);
  const candidates: Array<Record<OptimizationAxisKey, number>> = [];
  const seen = new Set<string>();
  const add = (params: Record<OptimizationAxisKey, number>) => {
    const key = JSON.stringify(axes.map((axis) => params[axis.key]));
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push(params);
    }
  };
  add(paramsFromConfig(base, axes));
  add(Object.fromEntries(axes.map((axis) => [axis.key, clamp(axis, (axis.min + axis.max) / 2)])) as Record<OptimizationAxisKey, number>);
  const values = new Map(axes.map((axis) => [axis.key, valuesForAxis(axis)]));
  const attempts = Math.max(target * 50, 200);
  for (let attempt = 0; candidates.length < target && attempt < attempts; attempt += 1) {
    const params = Object.fromEntries(axes.map((axis) => {
      const choices = values.get(axis.key)!;
      return [axis.key, choices[Math.floor(random() * choices.length)]!];
    })) as Record<OptimizationAxisKey, number>;
    add(params);
  }
  return candidates.slice(0, target);
}

function sessionWindows(factors: FactorBuildResult): SessionWindow[] {
  const sessions = new Map<string, SessionWindow>();
  for (const row of factors.rows) {
    const current = sessions.get(row.sessionDate);
    sessions.set(row.sessionDate, {
      sessionDate: row.sessionDate,
      startTime: Math.min(current?.startTime ?? row.windowStart, row.windowStart),
      endTime: Math.max(current?.endTime ?? row.windowEnd, row.windowEnd)
    });
  }
  return [...sessions.values()].sort((a, b) => a.startTime - b.startTime || a.sessionDate.localeCompare(b.sessionDate));
}

function splitWindows(windows: SessionWindow[], requestedFolds: number): SplitWindows {
  if (windows.length < 3) return { validation: [], test: windows.slice(-1) };
  const testCount = Math.max(1, Math.floor(windows.length * 0.2));
  const development = windows.slice(0, windows.length - testCount);
  const foldCount = Math.max(1, Math.min(requestedFolds, development.length));
  const validation: SessionWindow[][] = [];
  for (let index = 0; index < foldCount; index += 1) {
    const start = Math.floor(index * development.length / foldCount);
    const end = Math.max(start + 1, Math.floor((index + 1) * development.length / foldCount));
    const fold = development.slice(start, end);
    if (fold.length) validation.push(fold);
  }
  return { validation, test: windows.slice(development.length) };
}

function factorCacheKey(config: StrategyConfig): string {
  return JSON.stringify({
    windowStartEt: config.windowStartEt,
    windowEndEt: config.windowEndEt,
    referenceMode: config.referenceMode,
    entryDeviation: config.entryDeviation,
    exitDeviation: config.exitDeviation,
    minScore: config.minScore,
    momentumBars: config.momentumBars,
    volatilityBars: config.volatilityBars,
    liquidityBars: config.liquidityBars,
    factorWeights: config.factorWeights,
    maxFunding: config.maxFunding,
    minBarNotional: config.minBarNotional,
    minExpectedEdge: config.minExpectedEdge,
    feeRate: config.feeRate,
    slippageBps: config.slippageBps,
    referenceMismatchLimit: config.referenceMismatchLimit,
    minSessionCoverage: config.minSessionCoverage
  });
}

function rowsForWindows(factors: FactorBuildResult, windows: SessionWindow[]): FactorBuildResult['rows'] {
  const selected = new Set(windows.map((window) => window.sessionDate));
  return factors.rows.filter((row) => selected.has(row.sessionDate));
}

function emptyScore(): OptimizationScore {
  return { objective: -100, totalReturnPct: 0, sharpe: null, maxDrawdownPct: 0, tradeCount: 0, winRate: null };
}

function evaluate(factors: FactorBuildResult, config: StrategyConfig, windows: SessionWindow[]): OptimizationScore {
  if (!windows.length) return emptyScore();
  const rows = rowsForWindows(factors, windows);
  if (!rows.length) return emptyScore();
  const simulation = simulatePortfolio(rows, config, true);
  const pnls = windows.map((window) => simulation.sessionPnls.get(window.sessionDate) ?? 0);
  const metrics = computePerformanceMetrics(simulation.trades, pnls, config.initialCapital);
  const boundedSharpe = metrics.sharpe === null ? 0 : Math.max(-5, Math.min(5, metrics.sharpe));
  const tradePenalty = metrics.tradeCount < 2 ? (2 - metrics.tradeCount) * 1.5 : 0;
  return {
    objective: metrics.totalReturnPct - metrics.maxDrawdownPct * 0.45 + boundedSharpe * 0.35 - tradePenalty,
    totalReturnPct: metrics.totalReturnPct,
    sharpe: metrics.sharpe,
    maxDrawdownPct: metrics.maxDrawdownPct,
    tradeCount: metrics.tradeCount,
    winRate: metrics.winRate
  };
}

function aggregate(scores: OptimizationScore[]): OptimizationScore {
  if (!scores.length) return emptyScore();
  const objectives = scores.map((score) => score.objective);
  const averageObjective = mean(objectives);
  const dispersion = Math.sqrt(mean(objectives.map((value) => (value - averageObjective) ** 2)));
  const sharpes = scores.map((score) => score.sharpe).filter((value): value is number => value !== null && Number.isFinite(value));
  const trades = scores.reduce((sum, score) => sum + score.tradeCount, 0);
  const weightedWins = scores.reduce((sum, score) => sum + (score.winRate ?? 0) * score.tradeCount, 0);
  return {
    objective: averageObjective - dispersion * 0.35,
    totalReturnPct: mean(scores.map((score) => score.totalReturnPct)),
    sharpe: sharpes.length ? median(sharpes) : null,
    maxDrawdownPct: Math.max(...scores.map((score) => score.maxDrawdownPct), 0),
    tradeCount: trades,
    winRate: trades ? weightedWins / trades : null
  };
}

function foldMetric(index: number, windows: SessionWindow[], score: OptimizationScore): OptimizationFoldMetric {
  return {
    foldIndex: index,
    startTime: windows[0]?.startTime ?? 0,
    endTime: windows.at(-1)?.endTime ?? 0,
    sessionCount: windows.length,
    ...score
  };
}

function datasetVersion(database: HyperNightDb, symbols: string[], factors: FactorBuildResult): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify({ symbols, startTime: factors.startTime, endTime: factors.endTime, audit: database.marketDataAudit() }));
  for (const row of factors.rows) {
    hash.update(`${row.symbol}|${row.sessionDate}|${row.timestamp}|${row.close}|${row.referencePrice}|${row.fundingRate}|${row.estimatedNotionalVolume};`);
  }
  return `sha256-v1:${hash.digest('hex').slice(0, 20)}`;
}

export function runParameterOptimization(database: HyperNightDb, options: ParameterOptimizationOptions): {
  optimization: OptimizationResult;
  backtest: ReturnType<typeof runBacktest>;
} {
  const startedAt = Date.now();
  const symbols = normalizeSymbols(options.symbols);
  const selectedAxes = options.axes === undefined
    ? DEFAULT_OPTIMIZATION_AXES
    : DEFAULT_OPTIMIZATION_AXES.filter((axis) => options.axes!.includes(axis.key));
  const trialsRequested = Math.max(1, Math.min(300, Math.trunc(options.trials ?? 60)));
  const foldsRequested = Math.max(1, Math.min(6, Math.trunc(options.folds ?? 3)));
  const seed = Math.trunc(options.seed ?? 7);
  const costScenariosBps = [...new Set((options.costScenariosBps ?? [0, 2, 5])
    .map(Number).filter((value) => Number.isFinite(value) && value >= 0))].sort((a, b) => a - b).slice(0, 5);
  const baseConfig = resolveConfig(options.config);
  const runId = database.createRun('optimization', baseConfig);

  try {
    // 每份全量因子结果都包含数万到十余万行对象。只保留最近两份，避免
    // 标准/深度搜索把所有候选永久留在 V8 堆中。
    const factorCache = new Map<string, FactorBuildResult>();
    const factorCacheLimit = 2;
    const factorsFor = (config: StrategyConfig): FactorBuildResult => {
      const key = factorCacheKey(config);
      const cached = factorCache.get(key);
      if (cached) {
        factorCache.delete(key);
        factorCache.set(key, cached);
        return cached;
      }
      const factors = loadFactorData(database, {
        symbols,
        config,
        ...(options.startTime === undefined ? {} : { startTime: options.startTime }),
        ...(options.endTime === undefined ? {} : { endTime: options.endTime })
      });
      while (factorCache.size >= factorCacheLimit) {
        const oldest = factorCache.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        factorCache.delete(oldest);
      }
      factorCache.set(key, factors);
      return factors;
    };

    const baseFactors = factorsFor(baseConfig);
    if (!baseFactors.rows.length) throw new Error('真实行情没有形成可用于参数优化的完整休市段');
    const windows = sessionWindows(baseFactors);
    if (windows.length < 3) throw new Error(`参数优化至少需要 3 个完整休市段，当前只有 ${windows.length} 个`);
    const split = splitWindows(windows, foldsRequested);
    const candidates = buildCandidates(baseConfig, selectedAxes, trialsRequested, seed);
    const trials: OptimizationTrial[] = [];
    let bestConfig = baseConfig;
    let bestParams = paramsFromConfig(baseConfig, selectedAxes);
    let bestScore: OptimizationScore | null = null;

    for (let index = 0; index < candidates.length; index += 1) {
      const trialStartedAt = Date.now();
      const params = candidates[index]!;
      const config = applyParams(baseConfig, params, selectedAxes);
      const factors = factorsFor(config);
      const foldScores = split.validation.map((fold) => evaluate(factors, config, fold));
      const score = aggregate(foldScores);
      const validation = foldScores.map((foldScore, foldIndex) => foldMetric(foldIndex, split.validation[foldIndex]!, foldScore));
      const trial: OptimizationTrial = {
        index,
        params,
        validation,
        durationMs: Date.now() - trialStartedAt,
        ...score
      };
      trials.push(trial);
      if (!bestScore || score.objective > bestScore.objective) {
        bestScore = score;
        bestConfig = config;
        bestParams = params;
      }
    }

    const bestFactors = factorsFor(bestConfig);
    const testScore = split.test.length ? evaluate(bestFactors, bestConfig, split.test) : null;
    const sensitivity = selectedAxes.map((axis) => {
      const center = bestParams[axis.key] ?? clamp(axis, configValue(bestConfig, axis.key));
      const values = [...new Set([clamp(axis, center - axis.step), clamp(axis, center), clamp(axis, center + axis.step)])].sort((a, b) => a - b);
      const objectives = values.map((value) => {
        const config = applyParams(baseConfig, { ...bestParams, [axis.key]: value }, selectedAxes);
        const factors = factorsFor(config);
        return aggregate(split.validation.map((fold) => evaluate(factors, config, fold))).objective;
      });
      return { key: axis.key, values, objectives, bestIndex: objectives.indexOf(Math.max(...objectives)) };
    });
    const costStress = costScenariosBps.map((additionalSlippageBps) => {
      const config = resolveConfig({ ...bestConfig, slippageBps: bestConfig.slippageBps + additionalSlippageBps });
      const score = evaluate(factorsFor(config), config, split.test.length ? split.test : windows);
      return {
        additionalSlippageBps,
        totalSlippageBps: config.slippageBps,
        totalReturnPct: score.totalReturnPct,
        sharpe: score.sharpe,
        maxDrawdownPct: score.maxDrawdownPct,
        tradeCount: score.tradeCount
      };
    });

    const warnings = [...baseFactors.warnings];
    if (windows.length < 20) warnings.push(`只有 ${windows.length} 个完整休市段，优化结论样本偏小`);
    if (split.validation.length < 2) warnings.push('时间验证折少于 2 个，参数稳定性证据不足');
    if (split.test.length < 2) warnings.push('独立测试窗少于 2 个休市段');
    if (bestScore && bestScore.tradeCount < 4) warnings.push('推荐参数在验证折中的交易数少于 4 笔');
    if (bestScore && bestScore.maxDrawdownPct > 35) warnings.push('推荐参数的验证最大回撤高于 35%');
    if (testScore && testScore.totalReturnPct <= 0) warnings.push('推荐参数在独立测试窗收益非正');
    const recommendationStatus = !bestScore || split.validation.length < 2
      ? 'insufficient_data' as const
      : bestScore.totalReturnPct > 0 && bestScore.maxDrawdownPct < 35 && bestScore.tradeCount >= 4 && (testScore?.totalReturnPct ?? -Infinity) > 0
        ? 'recommended' as const
        : bestScore.totalReturnPct > -1 ? 'watch' as const : 'not_recommended' as const;

    const backtest = runBacktest(database, {
      symbols,
      config: bestConfig,
      startTime: baseFactors.startTime,
      endTime: baseFactors.endTime
    });
    const optimization: OptimizationResult = {
      runId,
      generatedAt: new Date().toISOString(),
      optimizationVersion: OPTIMIZATION_VERSION,
      strategyVersion: STRATEGY_VERSION,
      featureEngineVersion: FEATURE_ENGINE_VERSION,
      baseConfig,
      bestConfig,
      symbols,
      startTime: baseFactors.startTime,
      endTime: baseFactors.endTime,
      sessionCount: windows.length,
      axes: selectedAxes,
      validationFolds: [...trials].sort((a, b) => b.objective - a.objective)[0]?.validation ?? [],
      testWindow: testScore ? foldMetric(split.validation.length, split.test, testScore) : null,
      trials: trials.sort((a, b) => b.objective - a.objective),
      sensitivity,
      costStress,
      bestValidation: bestScore,
      recommendationStatus,
      datasetVersion: datasetVersion(database, symbols, baseFactors),
      seed,
      durationMs: Date.now() - startedAt,
      formalBacktestRunId: backtest.runId,
      warnings: [...new Set(warnings)]
    };
    database.finishRun(runId, optimization);
    return { optimization, backtest };
  } catch (error) {
    database.failRun(runId, error);
    throw error;
  }
}
