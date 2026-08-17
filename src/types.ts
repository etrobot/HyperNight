export type CandleInterval = '5m' | '1d';

export interface CandleBar {
  symbol: string;
  timestamp: number;
  closeTimestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  estimatedNotionalVolume: number;
  source?: string;
}

export interface FundingBar {
  symbol: string;
  timestamp: number;
  fundingRate: number;
}

export interface StockDailyBar {
  ticker: string;
  tradeDate: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
}

export interface MarketContext {
  symbol: string;
  capturedAt: number;
  markPx: number;
  midPx: number | null;
  funding: number | null;
  openInterest: number | null;
  dayNotionalVolume: number;
  impactBidPx: number | null;
  impactAskPx: number | null;
}

export interface FactorWeights {
  deviation: number;
  momentum: number;
  liquidity: number;
  lowVolatility: number;
  fundingCarry: number;
}

export interface StrategyConfig {
  windowStartEt: string;
  windowEndEt: string;
  referenceMode: 'stock_close' | 'hl_session_close';
  entryDeviation: number;
  exitDeviation: number;
  minScore: number;
  momentumBars: number;
  volatilityBars: number;
  liquidityBars: number;
  factorWeights: FactorWeights;
  maxPositions: number;
  grossNotionalPct: number;
  maxCoreNotional: number;
  maxNotional: number;
  takeProfit: number;
  stopLoss: number;
  maxHoldBars: number;
  hedgeStep: number;
  hedgeFraction: number;
  maxHedgeRatio: number;
  maxFunding: number;
  minBarNotional: number;
  minExpectedEdge: number;
  feeRate: number;
  slippageBps: number;
  initialCapital: number;
  referenceMismatchLimit: number;
  minSessionCoverage: number;
}

export interface OffHoursWindow {
  sessionDate: string;
  nextTradeDate: string;
  windowStart: number;
  windowEnd: number;
  sessionCloseAt: number;
  expectedBars: number;
}

export type FactorEligibilityReason =
  | 'eligible'
  | 'below_entry_deviation'
  | 'edge_below_cost'
  | 'funding_too_high'
  | 'bar_too_thin'
  | 'warmup'
  | 'score_below_minimum'
  | 'no_reference'
  | 'no_bars'
  | 'reference_mismatch'
  | 'insufficient_coverage';

export type SessionStatus =
  | 'ok'
  | 'no_reference'
  | 'no_bars'
  | 'reference_mismatch'
  | 'insufficient_coverage';

export interface SessionAudit {
  symbol: string;
  ticker: string;
  sessionDate: string;
  nextTradeDate: string;
  windowStart: number;
  windowEnd: number;
  expectedBars: number;
  barCount: number;
  coverage: number;
  status: SessionStatus;
  referencePrice: number | null;
  stockClose: number | null;
  hlSessionClosePrice: number | null;
  referenceMismatch: number | null;
}

export interface FactorRow {
  symbol: string;
  ticker: string;
  sessionDate: string;
  nextTradeDate: string;
  windowStart: number;
  windowEnd: number;
  timestamp: number;
  isSessionLast: boolean;
  close: number;
  referencePrice: number;
  deviation: number;
  direction: 1 | -1;
  fundingRate: number;
  fundingKnown: boolean;
  estimatedNotionalVolume: number;
  deviationFactor: number;
  momentumFactor: number;
  liquidityFactor: number;
  lowVolatilityFactor: number;
  fundingCarryFactor: number;
  deviationZ: number;
  momentumZ: number;
  liquidityZ: number;
  lowVolatilityZ: number;
  fundingCarryZ: number;
  score: number;
  rank: number;
  eligible: boolean;
  eligibilityReason: FactorEligibilityReason;
}

export interface FactorBuildResult {
  rows: FactorRow[];
  audits: SessionAudit[];
  startTime: number;
  endTime: number;
  warnings: string[];
}

export interface FactorMetric {
  factor: keyof FactorWeights | 'score';
  meanRankIc: number | null;
  positiveIcRate: number | null;
  observations: number;
}

export interface ResearchResult {
  runId: string;
  generatedAt: string;
  strategyVersion: string;
  featureEngineVersion: string;
  config: StrategyConfig;
  symbols: string[];
  startTime: number;
  endTime: number;
  rowCount: number;
  eligibleCount: number;
  sessionCount: number;
  factorMetrics: FactorMetric[];
  topScoreForwardReturnPct: number | null;
  allForwardReturnPct: number | null;
  latestScores: FactorRow[];
  warnings: string[];
}

export type FillAction = 'open_core' | 'add_hedge' | 'reduce_hedge' | 'close_core' | 'close_hedge';
export type ExitReason = 'take_profit' | 'stop_loss' | 'reverted' | 'max_hold' | 'session_end';

export interface Fill {
  timestamp: number;
  action: FillAction;
  direction: 1 | -1;
  size: number;
  price: number;
  notional: number;
  fee: number;
  slippage: number;
  deviationPct: number;
}

export interface PositionState {
  id: string;
  symbol: string;
  ticker: string;
  sessionDate: string;
  nextTradeDate: string;
  coreQty: number;
  hedgeQty: number;
  cashFlow: number;
  corePrice: number;
  lastHedgePrice: number;
  lastMarkPrice: number;
  lastMarkTimestamp: number;
  entryTimestamp: number;
  entryDeviation: number;
  entryScore: number;
  entryRank: number;
  fees: number;
  slippage: number;
  funding: number;
  lastFundingTimestamp: number | null;
  hedgeCount: number;
  maxHedgeSize: number;
  fills: Fill[];
}

export interface Trade {
  id: string;
  symbol: string;
  ticker: string;
  sessionDate: string;
  side: 'long' | 'short';
  entryTimestamp: number;
  exitTimestamp: number;
  entryDeviationPct: number;
  entryScore: number;
  entryRank: number;
  exitDeviationPct: number;
  exitReason: ExitReason;
  coreSize: number;
  corePrice: number;
  maxHedgeSize: number;
  hedgeCount: number;
  grossPnl: number;
  fees: number;
  slippage: number;
  funding: number;
  pnl: number;
  returnPct: number;
  holdBars: number;
  fills: Fill[];
}

export interface PerformanceMetrics {
  tradeCount: number;
  winRate: number | null;
  grossPnl: number;
  fees: number;
  slippage: number;
  funding: number;
  totalPnl: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  sharpe: number | null;
  avgHoldBars: number | null;
}

export interface EquityPoint {
  timestamp: number;
  sessionDate: string;
  equity: number;
  noHedgeEquity: number;
  openPositions: number;
}

export interface BacktestResult {
  runId: string;
  generatedAt: string;
  strategyVersion: string;
  featureEngineVersion: string;
  config: StrategyConfig;
  symbols: string[];
  startTime: number;
  endTime: number;
  trades: Trade[];
  noHedgeTrades: Trade[];
  equity: EquityPoint[];
  portfolio: PerformanceMetrics;
  noHedgePortfolio: PerformanceMetrics;
  maxConcurrentPositions: number;
  warnings: string[];
}

export type OptimizationAxisKey =
  | 'entryDeviation'
  | 'exitDeviation'
  | 'maxPositions'
  | 'grossNotionalPct'
  | 'takeProfit'
  | 'stopLoss'
  | 'maxHoldBars'
  | 'hedgeStep'
  | 'hedgeFraction'
  | 'maxHedgeRatio';

export interface OptimizationAxis {
  key: OptimizationAxisKey;
  label: string;
  min: number;
  max: number;
  step: number;
  integer?: boolean;
}

export interface OptimizationScore {
  objective: number;
  totalReturnPct: number;
  sharpe: number | null;
  maxDrawdownPct: number;
  tradeCount: number;
  winRate: number | null;
}

export interface OptimizationFoldMetric extends OptimizationScore {
  foldIndex: number;
  startTime: number;
  endTime: number;
  sessionCount: number;
}

export interface OptimizationTrial extends OptimizationScore {
  index: number;
  params: Partial<Record<OptimizationAxisKey, number>>;
  validation: OptimizationFoldMetric[];
  durationMs: number;
}

export interface OptimizationSensitivity {
  key: OptimizationAxisKey;
  values: number[];
  objectives: number[];
  bestIndex: number;
}

export interface OptimizationResult {
  runId: string;
  generatedAt: string;
  optimizationVersion: string;
  strategyVersion: string;
  featureEngineVersion: string;
  baseConfig: StrategyConfig;
  bestConfig: StrategyConfig;
  symbols: string[];
  startTime: number;
  endTime: number;
  sessionCount: number;
  axes: OptimizationAxis[];
  validationFolds: OptimizationFoldMetric[];
  testWindow: OptimizationFoldMetric | null;
  trials: OptimizationTrial[];
  sensitivity: OptimizationSensitivity[];
  costStress: Array<{
    additionalSlippageBps: number;
    totalSlippageBps: number;
    totalReturnPct: number;
    sharpe: number | null;
    maxDrawdownPct: number;
    tradeCount: number;
  }>;
  bestValidation: OptimizationScore | null;
  recommendationStatus: 'recommended' | 'watch' | 'not_recommended' | 'insufficient_data';
  datasetVersion: string;
  seed: number;
  durationMs: number;
  formalBacktestRunId: string;
  warnings: string[];
}

export interface PaperAccount {
  id: string;
  initialCapital: number;
  cash: number;
  realizedPnl: number;
  feesPaid: number;
  fundingPaid: number;
  slippagePaid: number;
  lastProcessedTimestamp: number | null;
  config: StrategyConfig;
  createdAt: number;
  updatedAt: number;
}

export interface PaperStatus {
  account: PaperAccount | null;
  positions: PositionState[];
  trades: Trade[];
  equity: Array<{ timestamp: number; cash: number; equity: number; unrealizedPnl: number; openPositions: number }>;
}

export interface PaperTickResult {
  accountId: string;
  processedBars: number;
  openedPositions: number;
  closedTrades: number;
  lastProcessedTimestamp: number | null;
  equity: number;
  warnings: string[];
}

export interface DataBackfillSummary {
  symbols: string[];
  requestedDays: number;
  startedAt: number;
  completedAt: number;
  results: Array<{
    symbol: string;
    ticker: string;
    candles5mSaved: number;
    candles1dSaved: number;
    fundingSaved: number;
    stockDaysSaved: number;
    error?: string;
  }>;
}

export interface MarketDataSourceCount {
  source: string;
  rowCount: number;
}

export interface MarketDataAudit {
  candles5m: MarketDataSourceCount[];
  candles1d: MarketDataSourceCount[];
  stockDaily: MarketDataSourceCount[];
  funding: MarketDataSourceCount[];
  syntheticRows: number;
}
