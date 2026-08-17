import { randomUUID } from 'node:crypto';

import { BAR_MS, HOUR_MS } from './constants.js';
import type {
  ExitReason,
  FactorRow,
  FillAction,
  PerformanceMetrics,
  PositionState,
  StrategyConfig,
  Trade
} from './types.js';

const TRADING_DAYS_PER_YEAR = 252;

export interface PositionStep {
  position: PositionState | null;
  trade: Trade | null;
}

export interface PositionMark {
  grossPnl: number;
  estimatedExitCost: number;
  netPnl: number;
  netReturn: number;
}

export function estimatedRoundTripCost(config: StrategyConfig): number {
  return 2 * (config.feeRate + config.slippageBps / 10_000);
}

function recordFill(
  state: PositionState,
  config: StrategyConfig,
  action: FillAction,
  direction: 1 | -1,
  size: number,
  price: number,
  timestamp: number,
  deviation: number
): void {
  const notional = size * price;
  const fee = notional * config.feeRate;
  const slippage = notional * (config.slippageBps / 10_000);
  state.cashFlow -= direction * notional;
  state.fees += fee;
  state.slippage += slippage;
  state.fills.push({
    timestamp,
    action,
    direction,
    size,
    price,
    notional,
    fee,
    slippage,
    deviationPct: deviation * 100
  });
}

export function openPosition(row: FactorRow, config: StrategyConfig, coreNotional = config.maxCoreNotional): PositionState {
  if (!(row.close > 0) || !(coreNotional > 0)) throw new Error(`无法按无效价格或名义开仓：${row.symbol}`);
  const size = coreNotional / row.close;
  const state: PositionState = {
    id: randomUUID(),
    symbol: row.symbol,
    ticker: row.ticker,
    sessionDate: row.sessionDate,
    nextTradeDate: row.nextTradeDate,
    coreQty: row.direction * size,
    hedgeQty: 0,
    cashFlow: 0,
    corePrice: row.close,
    lastHedgePrice: row.close,
    lastMarkPrice: row.close,
    lastMarkTimestamp: row.timestamp,
    entryTimestamp: row.timestamp,
    entryDeviation: row.deviation,
    entryScore: row.score,
    entryRank: row.rank,
    fees: 0,
    slippage: 0,
    funding: 0,
    lastFundingTimestamp: null,
    hedgeCount: 0,
    maxHedgeSize: 0,
    fills: []
  };
  recordFill(state, config, 'open_core', row.direction, size, row.close, row.timestamp, row.deviation);
  return state;
}

export function markPosition(state: PositionState, price: number, config: StrategyConfig): PositionMark {
  const grossPnl = state.cashFlow + (state.coreQty + state.hedgeQty) * price;
  const exitNotional = (Math.abs(state.coreQty) + Math.abs(state.hedgeQty)) * price;
  const estimatedExitCost = exitNotional * (config.feeRate + config.slippageBps / 10_000);
  const netPnl = grossPnl - state.fees - state.slippage - state.funding - estimatedExitCost;
  const coreNotional = Math.abs(state.coreQty) * state.corePrice;
  return {
    grossPnl,
    estimatedExitCost,
    netPnl,
    netReturn: coreNotional > 0 ? netPnl / coreNotional : 0
  };
}

export function closePosition(
  state: PositionState,
  row: FactorRow,
  config: StrategyConfig,
  reason: ExitReason
): Trade {
  const side = state.coreQty > 0 ? 'long' as const : 'short' as const;
  const coreSize = Math.abs(state.coreQty);
  if (state.hedgeQty !== 0) {
    const direction: 1 | -1 = state.hedgeQty > 0 ? -1 : 1;
    recordFill(state, config, 'close_hedge', direction, Math.abs(state.hedgeQty), row.close, row.timestamp, row.deviation);
    state.hedgeQty = 0;
  }
  if (state.coreQty !== 0) {
    const direction: 1 | -1 = state.coreQty > 0 ? -1 : 1;
    recordFill(state, config, 'close_core', direction, Math.abs(state.coreQty), row.close, row.timestamp, row.deviation);
    state.coreQty = 0;
  }
  const grossPnl = state.cashFlow;
  const pnl = grossPnl - state.fees - state.slippage - state.funding;
  const coreNotional = coreSize * state.corePrice;
  return {
    id: state.id,
    symbol: state.symbol,
    ticker: state.ticker,
    sessionDate: state.sessionDate,
    side,
    entryTimestamp: state.entryTimestamp,
    exitTimestamp: row.timestamp,
    entryDeviationPct: state.entryDeviation * 100,
    entryScore: state.entryScore,
    entryRank: state.entryRank,
    exitDeviationPct: row.deviation * 100,
    exitReason: reason,
    coreSize,
    corePrice: state.corePrice,
    maxHedgeSize: state.maxHedgeSize,
    hedgeCount: state.hedgeCount,
    grossPnl,
    fees: state.fees,
    slippage: state.slippage,
    funding: state.funding,
    pnl,
    returnPct: coreNotional > 0 ? (pnl / coreNotional) * 100 : 0,
    holdBars: Math.max(0, Math.floor((row.timestamp - state.entryTimestamp) / BAR_MS)),
    fills: state.fills
  };
}

/** 按原休市策略的退出优先级和动态对冲规则推进一根已收盘 5m bar。 */
export function stepPosition(
  state: PositionState,
  row: FactorRow,
  config: StrategyConfig,
  hedgeEnabled: boolean
): PositionStep {
  state.lastMarkPrice = row.close;
  state.lastMarkTimestamp = row.timestamp;
  if (row.timestamp % HOUR_MS === 0
      && row.fundingKnown
      && (state.lastFundingTimestamp === null || row.timestamp > state.lastFundingTimestamp)) {
    state.funding += (state.coreQty + state.hedgeQty) * row.close * row.fundingRate;
    state.lastFundingTimestamp = row.timestamp;
  }

  const mark = markPosition(state, row.close, config);
  let reason: ExitReason | null = null;
  if (mark.netReturn >= config.takeProfit) reason = 'take_profit';
  else if (mark.netReturn <= -config.stopLoss) reason = 'stop_loss';
  else if (Math.abs(row.deviation) <= config.exitDeviation) reason = 'reverted';
  else if (Math.floor((row.timestamp - state.entryTimestamp) / BAR_MS) >= config.maxHoldBars) reason = 'max_hold';
  else if (row.isSessionLast) reason = 'session_end';
  if (reason !== null) return { position: null, trade: closePosition(state, row, config, reason) };
  if (!hedgeEnabled) return { position: state, trade: null };

  const priceChange = state.lastHedgePrice > 0 ? (row.close - state.lastHedgePrice) / state.lastHedgePrice : 0;
  if (Math.abs(priceChange) < config.hedgeStep) return { position: state, trade: null };
  const rising = priceChange >= config.hedgeStep;
  const coreIsShort = state.coreQty < 0;
  const adding = coreIsShort ? rising : !rising;
  const coreSize = Math.abs(state.coreQty);
  const currentHedge = Math.abs(state.hedgeQty);
  const step = coreSize * config.hedgeFraction;
  let size = 0;
  if (adding) {
    const hedgeHeadroom = coreSize * config.maxHedgeRatio - currentHedge;
    const notionalHeadroom = (config.maxNotional - (coreSize + currentHedge) * row.close) / row.close;
    size = Math.min(step, hedgeHeadroom, notionalHeadroom);
  } else {
    size = Math.min(step, currentHedge);
  }
  if (!(size > 0)) return { position: state, trade: null };

  const hedgeDirection: 1 | -1 = coreIsShort ? (adding ? 1 : -1) : (adding ? -1 : 1);
  recordFill(
    state,
    config,
    adding ? 'add_hedge' : 'reduce_hedge',
    hedgeDirection,
    size,
    row.close,
    row.timestamp,
    row.deviation
  );
  state.hedgeQty += hedgeDirection * size;
  state.hedgeCount += 1;
  state.maxHedgeSize = Math.max(state.maxHedgeSize, Math.abs(state.hedgeQty));
  state.lastHedgePrice = row.close;
  return { position: state, trade: null };
}

export function computePerformanceMetrics(
  trades: Trade[],
  sessionPnls: number[],
  initialCapital: number
): PerformanceMetrics {
  const grossPnl = trades.reduce((sum, trade) => sum + trade.grossPnl, 0);
  const fees = trades.reduce((sum, trade) => sum + trade.fees, 0);
  const slippage = trades.reduce((sum, trade) => sum + trade.slippage, 0);
  const funding = trades.reduce((sum, trade) => sum + trade.funding, 0);
  const totalPnl = trades.reduce((sum, trade) => sum + trade.pnl, 0);
  let equity = initialCapital;
  let peak = initialCapital;
  let maxDrawdown = 0;
  const returns: number[] = [];
  for (const pnl of sessionPnls) {
    const previous = equity;
    equity += pnl;
    if (previous > 0) returns.push(pnl / previous);
    peak = Math.max(peak, equity);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
  }
  let sharpe: number | null = null;
  if (returns.length >= 2) {
    const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
    const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
    const standardDeviation = Math.sqrt(variance);
    if (standardDeviation > 0) sharpe = mean / standardDeviation * Math.sqrt(TRADING_DAYS_PER_YEAR);
  }
  return {
    tradeCount: trades.length,
    winRate: trades.length ? trades.filter((trade) => trade.pnl > 0).length / trades.length : null,
    grossPnl,
    fees,
    slippage,
    funding,
    totalPnl,
    totalReturnPct: initialCapital > 0 ? totalPnl / initialCapital * 100 : 0,
    maxDrawdownPct: maxDrawdown * 100,
    sharpe,
    avgHoldBars: trades.length ? trades.reduce((sum, trade) => sum + trade.holdBars, 0) / trades.length : null
  };
}
