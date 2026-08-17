import { parseEtClock } from './calendar.js';
import { DEFAULT_CONFIG } from './constants.js';
import type { FactorWeights, StrategyConfig } from './types.js';

type PartialConfig = Partial<Omit<StrategyConfig, 'factorWeights'>> & { factorWeights?: Partial<FactorWeights> };

function numeric(config: StrategyConfig, field: keyof StrategyConfig, minimum: number, maximum = Number.POSITIVE_INFINITY): void {
  const value = config[field];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`策略参数 ${String(field)} 超出允许范围`);
  }
}

export function resolveConfig(value?: unknown): StrategyConfig {
  if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) {
    throw new Error('策略配置必须是 JSON 对象');
  }
  const partial = (value ?? {}) as PartialConfig;
  const config: StrategyConfig = {
    ...DEFAULT_CONFIG,
    ...partial,
    factorWeights: { ...DEFAULT_CONFIG.factorWeights, ...(partial.factorWeights ?? {}) }
  };
  if (!parseEtClock(config.windowStartEt) || !parseEtClock(config.windowEndEt)) throw new Error('休市窗口必须是有效的 ET HH:mm');
  if (config.referenceMode !== 'stock_close' && config.referenceMode !== 'hl_session_close') {
    throw new Error('referenceMode 只能是 stock_close 或 hl_session_close');
  }
  numeric(config, 'entryDeviation', 0, 1);
  numeric(config, 'exitDeviation', 0, 1);
  if (config.exitDeviation >= config.entryDeviation) throw new Error('exitDeviation 必须小于 entryDeviation');
  numeric(config, 'minScore', -100, 100);
  numeric(config, 'momentumBars', 1, 1_000);
  numeric(config, 'volatilityBars', 2, 1_000);
  numeric(config, 'liquidityBars', 1, 1_000);
  numeric(config, 'maxPositions', 1, 1_000);
  numeric(config, 'grossNotionalPct', 0.000001, 100);
  numeric(config, 'maxCoreNotional', 0.01);
  numeric(config, 'maxNotional', 0.01);
  if (config.maxCoreNotional > config.maxNotional) throw new Error('maxCoreNotional 不得高于 maxNotional');
  numeric(config, 'takeProfit', 0, 10);
  numeric(config, 'stopLoss', 0, 10);
  numeric(config, 'maxHoldBars', 1, 100_000);
  numeric(config, 'hedgeStep', 0.000001, 10);
  numeric(config, 'hedgeFraction', 0.000001, 1);
  numeric(config, 'maxHedgeRatio', 0, 1);
  numeric(config, 'maxFunding', 0, 1);
  numeric(config, 'minBarNotional', 0);
  numeric(config, 'minExpectedEdge', 0, 1);
  numeric(config, 'feeRate', 0, 1);
  numeric(config, 'slippageBps', 0, 100_000);
  numeric(config, 'initialCapital', 0.01);
  numeric(config, 'referenceMismatchLimit', 0, 1);
  numeric(config, 'minSessionCoverage', 0, 1);
  const weights = Object.values(config.factorWeights);
  if (weights.some((weight) => !Number.isFinite(weight) || weight < 0)) throw new Error('因子权重必须是非负有限数');
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  if (Math.abs(weightSum - 1) > 1e-9) throw new Error(`因子权重之和必须等于 1，当前为 ${weightSum}`);
  for (const integerField of ['momentumBars', 'volatilityBars', 'liquidityBars', 'maxPositions', 'maxHoldBars'] as const) {
    if (!Number.isInteger(config[integerField])) throw new Error(`${integerField} 必须是整数`);
  }
  return config;
}
