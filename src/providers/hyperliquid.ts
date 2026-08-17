import { BAR_MS, DAY_MS, DEFAULT_INFO_URL, HOUR_MS } from '../constants.js';
import type { CandleBar, CandleInterval, FundingBar, MarketContext } from '../types.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function required(value: unknown, label: string): number {
  const number = finite(value);
  if (number === null) throw new Error(`Hyperliquid 返回无效字段：${label}`);
  return number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseCandleRows(symbol: string, interval: CandleInterval, payload: unknown[], cutoff = Number.POSITIVE_INFINITY): CandleBar[] {
  const rows: CandleBar[] = [];
  for (const item of payload) {
    const raw = item as Record<string, unknown>;
    const timestamp = finite(raw.t);
    const closeTimestamp = finite(raw.T);
    const open = finite(raw.o);
    const high = finite(raw.h);
    const low = finite(raw.l);
    const close = finite(raw.c);
    const volume = finite(raw.v);
    if (timestamp === null || closeTimestamp === null || open === null || high === null || low === null || close === null || volume === null) continue;
    if (timestamp >= cutoff || closeTimestamp >= cutoff || open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0) continue;
    const estimatedNotionalVolume = volume * (high + low + close) / 3;
    rows.push({
      symbol,
      timestamp: Math.trunc(timestamp),
      closeTimestamp: Math.trunc(closeTimestamp),
      open,
      high,
      low,
      close,
      volume,
      estimatedNotionalVolume,
      source: `hyperliquid-${interval}`
    });
  }
  rows.sort((a, b) => a.timestamp - b.timestamp);
  return rows;
}

export function parseFundingRows(symbol: string, payload: unknown[], startTime: number, endTime: number): FundingBar[] {
  const byHour = new Map<number, FundingBar>();
  for (const item of payload) {
    const raw = item as Record<string, unknown>;
    const time = finite(raw.time);
    const rate = finite(raw.fundingRate);
    if (time === null || rate === null) continue;
    const timestamp = Math.floor(time / HOUR_MS) * HOUR_MS;
    if (timestamp < startTime || timestamp >= endTime) continue;
    byHour.set(timestamp, { symbol, timestamp, fundingRate: rate });
  }
  return [...byHour.values()].sort((a, b) => a.timestamp - b.timestamp);
}

export class HyperliquidClient {
  constructor(
    private readonly infoUrl = process.env.HYPERLIQUID_INFO_URL ?? DEFAULT_INFO_URL,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = 15_000
  ) {}

  private async info<T>(body: Record<string, unknown>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const response = await this.fetchImpl(this.infoUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs)
        });
        if (response.status === 429 && attempt < 3) {
          const retryAfter = Number(response.headers.get('retry-after'));
          await delay(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : 1_000 * 2 ** attempt);
          continue;
        }
        if (!response.ok) throw new Error(`Hyperliquid Info API ${response.status}`);
        return await response.json() as T;
      } catch (error) {
        lastError = error;
        if (attempt < 3) await delay(350 * 2 ** attempt);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async marketContexts(dex = 'xyz', capturedAt = Date.now()): Promise<MarketContext[]> {
    const payload = await this.info<unknown>({ type: 'metaAndAssetCtxs', dex });
    if (!Array.isArray(payload) || payload.length < 2) throw new Error('Hyperliquid metaAndAssetCtxs 格式无效');
    const meta = payload[0] as { universe?: unknown };
    const contexts = payload[1];
    if (!Array.isArray(meta.universe) || !Array.isArray(contexts) || meta.universe.length !== contexts.length) {
      throw new Error('Hyperliquid universe 与 asset contexts 未对齐');
    }
    const output: MarketContext[] = [];
    for (let index = 0; index < meta.universe.length; index += 1) {
      const market = meta.universe[index] as Record<string, unknown>;
      const context = contexts[index] as Record<string, unknown>;
      const name = typeof market.name === 'string' ? market.name.trim() : '';
      const markPx = finite(context.markPx);
      const dayNotionalVolume = finite(context.dayNtlVlm);
      if (!name || markPx === null || markPx <= 0 || dayNotionalVolume === null || dayNotionalVolume < 0) continue;
      const symbol = name.includes(':') ? name : `${dex}:${name}`;
      const impact = Array.isArray(context.impactPxs) ? context.impactPxs : [];
      output.push({
        symbol,
        capturedAt,
        markPx,
        midPx: finite(context.midPx),
        funding: finite(context.funding),
        openInterest: finite(context.openInterest),
        dayNotionalVolume,
        impactBidPx: finite(impact[0]),
        impactAskPx: finite(impact[1])
      });
    }
    return output;
  }

  async candles(symbol: string, interval: CandleInterval, startTime: number, endTime: number): Promise<CandleBar[]> {
    const payload = await this.info<unknown>({
      type: 'candleSnapshot',
      req: { coin: symbol, interval, startTime, endTime }
    });
    if (!Array.isArray(payload)) throw new Error(`Hyperliquid candleSnapshot 格式无效：${symbol}`);
    return parseCandleRows(symbol, interval, payload, endTime);
  }

  async funding(symbol: string, startTime: number, endTime: number): Promise<FundingBar[]> {
    const payload = await this.info<unknown>({ type: 'fundingHistory', coin: symbol, startTime, endTime });
    if (!Array.isArray(payload)) throw new Error(`Hyperliquid fundingHistory 格式无效：${symbol}`);
    return parseFundingRows(symbol, payload, startTime, endTime);
  }

  static alignedEnd(now = Date.now(), interval: CandleInterval = '5m'): number {
    const intervalMs = interval === '5m' ? BAR_MS : DAY_MS;
    return Math.floor(now / intervalMs) * intervalMs;
  }
}
