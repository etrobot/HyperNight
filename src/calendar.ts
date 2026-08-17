import { BAR_MS } from './constants.js';
import type { OffHoursWindow } from './types.js';

const ET_TIME_ZONE = 'America/New_York';
const ET_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: ET_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
});

export interface EtClock { hour: number; minute: number }

interface EtParts extends EtClock {
  year: number;
  month: number;
  day: number;
  second: number;
}

function etParts(timestamp: number): EtParts {
  const parts = Object.fromEntries(
    ET_FORMATTER.formatToParts(new Date(timestamp))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)])
  ) as Record<string, number>;
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour === 24 ? 0 : parts.hour!,
    minute: parts.minute!,
    second: parts.second!
  };
}

function timeZoneOffsetMs(timestamp: number): number {
  const parts = etParts(timestamp);
  const representedUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return representedUtc - Math.floor(timestamp / 1_000) * 1_000;
}

export function etWallClockToUtc(year: number, month: number, day: number, hour: number, minute: number): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  let candidate = naive - timeZoneOffsetMs(naive);
  candidate = naive - timeZoneOffsetMs(candidate);
  return candidate;
}

export function parseTradeDate(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { year, month, day };
}

export function parseEtClock(value: string): EtClock | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

export function tradeDateTimeUtc(tradeDate: string, clock: EtClock): number {
  const date = parseTradeDate(tradeDate);
  if (!date) throw new Error(`无效交易日：${tradeDate}`);
  return etWallClockToUtc(date.year, date.month, date.day, clock.hour, clock.minute);
}

export function etDateString(timestamp: number): string {
  const parts = etParts(timestamp);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

export function isTradingDayComplete(tradeDate: string, now: number): boolean {
  return tradeDateTimeUtc(tradeDate, { hour: 16, minute: 0 }) <= now;
}

function utcDateString(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function observedFixedHoliday(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay();
  if (weekday === 6) date.setUTCDate(date.getUTCDate() - 1);
  else if (weekday === 0) date.setUTCDate(date.getUTCDate() + 1);
  return utcDateString(date);
}

function nthWeekday(year: number, month: number, weekday: number, occurrence: number): string {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7 + (occurrence - 1) * 7;
  return utcDateString(new Date(Date.UTC(year, month - 1, 1 + offset)));
}

function lastWeekday(year: number, month: number, weekday: number): string {
  const last = new Date(Date.UTC(year, month, 0));
  last.setUTCDate(last.getUTCDate() - (last.getUTCDay() - weekday + 7) % 7);
  return utcDateString(last);
}

/** Gregorian Easter Sunday，供 NYSE Good Friday 前向日历使用。 */
function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = (h + l - 7 * m + 114) % 31 + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

function marketHolidays(year: number): Set<string> {
  const goodFriday = easterSunday(year);
  goodFriday.setUTCDate(goodFriday.getUTCDate() - 2);
  const values = new Set([
    observedFixedHoliday(year, 1, 1),
    nthWeekday(year, 1, 1, 3),
    nthWeekday(year, 2, 1, 3),
    utcDateString(goodFriday),
    lastWeekday(year, 5, 1),
    observedFixedHoliday(year, 7, 4),
    nthWeekday(year, 9, 1, 1),
    nthWeekday(year, 11, 4, 4),
    observedFixedHoliday(year, 12, 25)
  ]);
  if (year >= 2022) values.add(observedFixedHoliday(year, 6, 19));
  return values;
}

function isRegularUsTradingDate(date: Date): boolean {
  const weekday = date.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  const value = utcDateString(date);
  const year = date.getUTCFullYear();
  return !marketHolidays(year - 1).has(value)
    && !marketHolidays(year).has(value)
    && !marketHolidays(year + 1).has(value);
}

/**
 * 只用于当前模拟盘尚无“下一交易日”日 K 时的前向推断。历史研究仍完全以日 K
 * 实际出现日期为准。特殊临时休市无法由规则预知，调用方应保留运行警告。
 */
export function nextUsTradingDate(tradeDate: string): string {
  const parsed = parseTradeDate(tradeDate);
  if (!parsed) throw new Error(`无效交易日：${tradeDate}`);
  const candidate = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + 1));
  for (let attempts = 0; attempts < 14; attempts += 1) {
    if (isRegularUsTradingDate(candidate)) return utcDateString(candidate);
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }
  throw new Error(`无法推断 ${tradeDate} 之后的美股交易日`);
}

export function buildOffHoursWindows(tradingDates: string[], startEt: string, endEt: string): OffHoursWindow[] {
  const start = parseEtClock(startEt);
  const end = parseEtClock(endEt);
  if (!start || !end) throw new Error(`无效休市窗口：${startEt} → ${endEt} ET`);
  const ordered = [...new Set(tradingDates)].filter((value) => parseTradeDate(value) !== null).sort();
  const output: OffHoursWindow[] = [];
  for (let index = 0; index + 1 < ordered.length; index += 1) {
    const sessionDate = ordered[index]!;
    const nextTradeDate = ordered[index + 1]!;
    const windowStart = tradeDateTimeUtc(sessionDate, start);
    const windowEnd = tradeDateTimeUtc(nextTradeDate, end);
    if (windowEnd <= windowStart) continue;
    output.push({
      sessionDate,
      nextTradeDate,
      windowStart,
      windowEnd,
      sessionCloseAt: tradeDateTimeUtc(sessionDate, { hour: 16, minute: 0 }),
      expectedBars: Math.round((windowEnd - windowStart) / BAR_MS)
    });
  }
  return output;
}
