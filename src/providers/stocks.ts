import { isTradingDayComplete, parseTradeDate } from '../calendar.js';
import { STOCK_KLINE_URL } from '../constants.js';
import type { StockDailyBar } from '../types.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const HEADERS: Record<string, string> = {
  Accept: '*/*',
  Referer: 'https://gu.qq.com/',
  'User-Agent': 'Mozilla/5.0 HyperNight/0.1'
};

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseJsonp(body: string): unknown {
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('腾讯日 K 响应不含完整 JSON');
  return JSON.parse(body.slice(start, end + 1));
}

export function parseStockDaily(payload: unknown, ticker: string, quoteCode: string): StockDailyBar[] {
  const root = payload as { code?: unknown; msg?: unknown; data?: Record<string, unknown> } | null;
  if (!root || typeof root !== 'object' || finite(root.code) !== 0) {
    throw new Error(`腾讯日 K 返回错误：${quoteCode} ${String(root?.msg ?? root?.code ?? 'invalid')}`);
  }
  const entry = root.data?.[quoteCode] as Record<string, unknown> | undefined;
  if (!entry) throw new Error(`腾讯日 K 响应缺少 ${quoteCode}`);
  const values = Array.isArray(entry.qfqday) ? entry.qfqday : Array.isArray(entry.day) ? entry.day : [];
  const rows: StockDailyBar[] = [];
  for (const value of values) {
    if (!Array.isArray(value) || value.length < 6) continue;
    const tradeDate = typeof value[0] === 'string' ? value[0] : '';
    const open = finite(value[1]);
    const close = finite(value[2]);
    const high = finite(value[3]);
    const low = finite(value[4]);
    const volume = finite(value[5]);
    if (!parseTradeDate(tradeDate) || open === null || close === null || high === null || low === null || volume === null) continue;
    if (open <= 0 || close <= 0 || high <= 0 || low <= 0 || volume < 0) continue;
    if (high < Math.max(open, close, low) || low > Math.min(open, close, high)) continue;
    rows.push({ ticker, tradeDate, open, close, high, low, volume });
  }
  return rows.sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
}

export class StockQuoteClient {
  constructor(
    private readonly baseUrl = STOCK_KLINE_URL,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = 15_000
  ) {}

  async daily(ticker: string, quoteCode: string, count: number, now = Date.now()): Promise<StockDailyBar[]> {
    const rows = Math.max(2, Math.min(640, Math.trunc(count)));
    const url = `${this.baseUrl}?_var=kline_dayqfq&param=${encodeURIComponent(`${quoteCode},day,,,${rows},qfq`)}`;
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await this.fetchImpl(url, {
          headers: HEADERS,
          signal: AbortSignal.timeout(this.timeoutMs)
        });
        if (!response.ok) throw new Error(`腾讯日 K HTTP ${response.status}`);
        return parseStockDaily(parseJsonp(await response.text()), ticker, quoteCode)
          .filter((bar) => isTradingDayComplete(bar.tradeDate, now));
      } catch (error) {
        lastError = error;
        if (attempt < 2) await delay(300 * 2 ** attempt);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}
