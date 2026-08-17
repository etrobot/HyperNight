import type {
  BacktestResult,
  FactorRow,
  MarketDataAudit,
  MarketContext,
  OptimizationResult,
  PaperStatus,
  ResearchResult,
  StrategyConfig
} from '../../src/types.js';

export type View = 'overview' | 'factors' | 'research' | 'backtest' | 'paper' | 'data';

export interface CandleBounds {
  startTime: number;
  endTime: number;
  rowCount: number;
}

export interface SymbolCoverage {
  symbol: string;
  candleCount5m: number;
  firstTimestamp: number;
  lastTimestamp: number;
}

export interface BootstrapPayload {
  generatedAt: number;
  database: {
    path: string;
    counts: Record<string, number>;
    candleBounds5m: CandleBounds | null;
    candleBounds1d: CandleBounds | null;
    coverage: SymbolCoverage[];
    marketContexts: MarketContext[];
    audit: MarketDataAudit;
  };
  config: StrategyConfig;
  symbols: string[];
  research: ResearchResult | null;
  optimization: OptimizationResult | null;
  backtest: BacktestResult | null;
  paper: PaperStatus;
  activeTask: string | null;
}

export interface FactorSnapshot {
  timestamp: number | null;
  rows: FactorRow[];
  sessionStatuses: Record<string, number>;
  warnings: string[];
}

export interface BackfillResult {
  results: Array<{ symbol: string; error?: string }>;
}

export interface PaperTickResponse {
  result: {
    openedPositions: number;
    closedTrades: number;
    warnings: string[];
  };
  status: PaperStatus;
}

export interface OptimizationResponse {
  optimization: OptimizationResult;
  backtest: BacktestResult;
}

export type { BacktestResult, FactorRow, OptimizationResult, PaperStatus, ResearchResult, StrategyConfig };
