import { buildOffHoursWindows, etDateString, nextUsTradingDate } from './calendar.js';
import { BAR_MS, DAY_MS, normalizeSymbols, tickerOf } from './constants.js';
import type { HyperNightDb } from './db.js';
import { buildFactorRows } from './factors.js';
import type { FactorBuildResult, StrategyConfig } from './types.js';

export interface LoadFactorDataOptions {
  symbols?: string[];
  startTime?: number;
  endTime?: number;
  includeOpenWindow?: boolean;
  config: StrategyConfig;
}

/** 从独立 SQLite 中读取完整休市段，并保留收盘前一根 bar 供参照价护栏使用。 */
export function loadFactorData(database: HyperNightDb, options: LoadFactorDataOptions): FactorBuildResult {
  const audit = database.marketDataAudit();
  if (audit.syntheticRows > 0) {
    throw new Error(`SQLite 中仍有 ${audit.syntheticRows} 行合成行情；请清理后再运行真实研究、优化或回测`);
  }
  const symbols = normalizeSymbols(options.symbols);
  if (!symbols.length) throw new Error('没有可用于研究的 HyperNight 标的');
  const bounds = database.candleBounds(symbols, '5m');
  if (!bounds) return { rows: [], audits: [], startTime: 0, endTime: 0, warnings: ['SQLite 中没有 5m K 线'] };
  const startTime = Math.max(bounds.startTime, options.startTime ?? bounds.startTime);
  const endTime = Math.min(bounds.endTime, options.endTime ?? bounds.endTime);
  if (!(endTime > startTime)) throw new Error('研究时间范围为空或颠倒');

  const tickers = symbols.map(tickerOf);
  const startDate = etDateString(startTime - 10 * DAY_MS);
  const endDate = etDateString(endTime + 10 * DAY_MS);
  const stockDaily = database.stockDaily(tickers, startDate, endDate);
  const tradingDates = database.tradingDates(tickers, startDate, endDate);
  const windows = buildOffHoursWindows(tradingDates, options.config.windowStartEt, options.config.windowEndEt)
    .filter((window) => window.windowStart >= startTime && window.windowEnd <= endTime);
  if (options.includeOpenWindow) {
    const latestTradeDate = tradingDates.at(-1);
    if (latestTradeDate) {
      const inferredNextDate = nextUsTradingDate(latestTradeDate);
      const candidate = buildOffHoursWindows(
        [latestTradeDate, inferredNextDate],
        options.config.windowStartEt,
        options.config.windowEndEt
      )[0];
      if (candidate
          && candidate.windowStart >= startTime
          && candidate.windowStart < endTime
          && !windows.some((window) => window.sessionDate === candidate.sessionDate)) {
        windows.push(candidate);
        windows.sort((a, b) => a.windowStart - b.windowStart);
      }
    }
  }
  if (!windows.length) {
    return {
      rows: [],
      audits: [],
      startTime,
      endTime,
      warnings: ['可用正股交易日不足，或指定范围内没有完整休市段']
    };
  }

  const candleStart = Math.min(...windows.map((window) => Math.min(window.windowStart, window.sessionCloseAt) - BAR_MS));
  const candleEnd = Math.min(endTime, Math.max(...windows.map((window) => window.windowEnd)));
  const candles = database.candles(symbols, candleStart, candleEnd, '5m');
  const funding = database.funding(symbols, candleStart, candleEnd);
  const result = buildFactorRows({
    symbols,
    windows,
    candles,
    stockDaily,
    funding,
    config: options.config,
    dataCutoff: endTime,
    retainInsufficientCoverageRows: options.includeOpenWindow === true
  });
  if (options.includeOpenWindow && windows.some((window) => window.windowEnd > endTime)) {
    result.warnings.push('当前休市段的下一交易日由规则日历推断；特殊临时休市需人工确认');
  }
  return result;
}
