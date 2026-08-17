export function finite(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function number(value: unknown, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  return new Intl.NumberFormat('zh-CN', {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits
  }).format(Number(value));
}

export function compact(value: unknown): string {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(value));
}

export function money(value: unknown, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: digits
  }).format(Number(value));
}

export function percent(value: unknown, digits = 2, alreadyPercent = true): string {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  const result = alreadyPercent ? Number(value) : Number(value) * 100;
  return `${result >= 0 ? '+' : ''}${number(result, digits)}%`;
}

export function dateTime(timestamp: unknown, includeDate = true): string {
  if (!timestamp || !Number.isFinite(Number(timestamp))) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Hong_Kong',
    ...(includeDate ? { month: '2-digit', day: '2-digit' } : {}),
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date(Number(timestamp)));
}

export function isoDate(timestamp: unknown): string {
  return timestamp && Number.isFinite(Number(timestamp)) ? new Date(Number(timestamp)).toISOString().slice(0, 10) : '';
}

export function tone(value: unknown): string {
  return finite(value) > 0 ? 'positive' : finite(value) < 0 ? 'negative' : '';
}
