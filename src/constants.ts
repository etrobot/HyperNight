import type { StrategyConfig } from './types.js';

export const BAR_MS = 5 * 60 * 1_000;
export const HOUR_MS = 60 * 60 * 1_000;
export const DAY_MS = 24 * HOUR_MS;
export const CANDLE_HISTORY_LIMIT = 5_000;
export const STRATEGY_VERSION = 'hypernight-offhours-multifactor-v1';
export const FEATURE_ENGINE_VERSION = 'nodejs-polars-cross-section-v1';
export const OPTIMIZATION_VERSION = 'hypernight-parameter-optimization-v1-time-split';
export const SCHEMA_VERSION = 1;
export const DEFAULT_DB_PATH = './data/hypernight.db';
export const DEFAULT_INFO_URL = 'https://api.hyperliquid.xyz/info';
export const STOCK_KLINE_URL = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get';

/** Hyperliquid HIP-3 股票代币到腾讯美股日 K 代码。 */
export const SYMBOL_MAP: Readonly<Record<string, string>> = {
  'xyz:NVDA': 'usNVDA.OQ',
  'xyz:TSLA': 'usTSLA.OQ',
  'xyz:AAPL': 'usAAPL.OQ',
  'xyz:MSFT': 'usMSFT.OQ',
  'xyz:META': 'usMETA.OQ',
  'xyz:GOOGL': 'usGOOGL.OQ',
  'xyz:AMZN': 'usAMZN.OQ',
  'xyz:AMD': 'usAMD.OQ',
  'xyz:INTC': 'usINTC.OQ',
  'xyz:MU': 'usMU.OQ',
  'xyz:MRVL': 'usMRVL.OQ',
  'xyz:WDC': 'usWDC.OQ',
  'xyz:SNDK': 'usSNDK.OQ',
  'xyz:LITE': 'usLITE.OQ',
  'xyz:PLTR': 'usPLTR.OQ',
  'xyz:NFLX': 'usNFLX.OQ',
  'xyz:COIN': 'usCOIN.OQ',
  'xyz:HOOD': 'usHOOD.OQ',
  'xyz:MSTR': 'usMSTR.OQ',
  'xyz:CRWV': 'usCRWV.OQ',
  'xyz:NBIS': 'usNBIS.OQ',
  'xyz:ORCL': 'usORCL.N',
  'xyz:LLY': 'usLLY.N',
  'xyz:TSM': 'usTSM.N',
  'xyz:IBM': 'usIBM.N',
  'xyz:CRCL': 'usCRCL.N',
  'xyz:DELL': 'usDELL.N',
  'xyz:NOW': 'usNOW.N',
  'xyz:BABA': 'usBABA.N',
  'xyz:HIMS': 'usHIMS.N',
  'xyz:BE': 'usBE.N'
};

export const DEFAULT_SYMBOLS = Object.keys(SYMBOL_MAP).sort();

export const DEFAULT_CONFIG: StrategyConfig = {
  windowStartEt: '16:00',
  windowEndEt: '09:30',
  referenceMode: 'stock_close',
  entryDeviation: 0.05,
  exitDeviation: 0.01,
  minScore: 0,
  momentumBars: 3,
  volatilityBars: 12,
  liquidityBars: 12,
  factorWeights: {
    deviation: 0.4,
    momentum: 0.2,
    liquidity: 0.15,
    lowVolatility: 0.15,
    fundingCarry: 0.1
  },
  maxPositions: 5,
  grossNotionalPct: 1,
  maxCoreNotional: 10_000,
  maxNotional: 15_000,
  takeProfit: 0.02,
  stopLoss: 0.015,
  maxHoldBars: 48,
  hedgeStep: 0.02,
  hedgeFraction: 0.2,
  maxHedgeRatio: 0.8,
  maxFunding: 0.001,
  minBarNotional: 5_000,
  minExpectedEdge: 0.003,
  feeRate: 0.00045,
  slippageBps: 5,
  initialCapital: 100_000,
  referenceMismatchLimit: 0.02,
  minSessionCoverage: 0.8
};

export function tickerOf(symbol: string): string {
  return symbol.includes(':') ? symbol.slice(symbol.indexOf(':') + 1).toUpperCase() : symbol.toUpperCase();
}

export function normalizeSymbols(values?: string[]): string[] {
  const source = values?.length ? values : DEFAULT_SYMBOLS;
  const output: string[] = [];
  for (const raw of source) {
    const cleaned = raw.trim();
    if (!cleaned) continue;
    const normalized = cleaned in SYMBOL_MAP ? cleaned : `xyz:${tickerOf(cleaned)}`;
    if (normalized in SYMBOL_MAP && !output.includes(normalized)) output.push(normalized);
  }
  return output.sort();
}
