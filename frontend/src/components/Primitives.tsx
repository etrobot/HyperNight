import { useId, type ReactNode } from 'react';

import { compact, dateTime, finite, money, number, percent, tone } from '../lib/format';
import type { FactorMetric, FactorRow, Trade } from '../../../src/types.js';

export const FACTORS = [
  ['deviation', '偏离边际', 'deviationZ'],
  ['momentum', '方向动量', 'momentumZ'],
  ['liquidity', '流动性', 'liquidityZ'],
  ['lowVolatility', '低波动', 'lowVolatilityZ'],
  ['fundingCarry', '资金费率', 'fundingCarryZ']
] as const;

export const REASON_LABELS: Record<string, string> = {
  eligible: '可交易', below_entry_deviation: '偏离不足', edge_below_cost: '边际不足',
  funding_too_high: 'Funding 过高', bar_too_thin: '流动性不足', warmup: '滚动预热',
  score_below_minimum: '评分不足', no_reference: '缺参照价', no_bars: '缺 5m K',
  reference_mismatch: '参照错配', insufficient_coverage: '覆盖率不足'
};

export function factorLabel(key: string): string {
  return ({ deviation: '偏离边际', momentum: '方向动量', liquidity: '流动性', lowVolatility: '低波动', fundingCarry: '资金费率', score: '综合评分' } as Record<string, string>)[key] || key;
}

export function EmptyState({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return <div className="empty-state"><div><div className="empty-icon">⌁</div><h3>{title}</h3><p>{detail}</p>{action}</div></div>;
}

export function WarningList({ warnings }: { warnings?: string[] | undefined }) {
  if (!warnings?.length) return null;
  return <div className="warning-list">{warnings.map((warning, index) => <div className="warning-item" key={`${warning}-${index}`}>{warning}</div>)}</div>;
}

export function LineChart({
  points,
  primaryKey,
  secondaryKey,
  labels = ['主组合', '无对冲']
}: {
  points?: unknown[];
  primaryKey: string;
  secondaryKey?: string;
  labels?: [string, string?];
}) {
  const gradientId = useId().replaceAll(':', '');
  if (!points?.length) return <EmptyState title="暂无曲线" detail="完成一次回测或模拟盘推进后，这里会绘制权益路径。" />;
  const width = 820;
  const height = 250;
  const pad = { left: 54, right: 16, top: 18, bottom: 30 };
  const get = (point: unknown, key: string) => finite((point as Record<string, unknown>)[key]);
  const allValues = points.flatMap((point) => [get(point, primaryKey), secondaryKey ? get(point, secondaryKey) : null]).filter((value): value is number => value !== null);
  let min = Math.min(...allValues);
  let max = Math.max(...allValues);
  if (min === max) { min -= 1; max += 1; }
  const margin = (max - min) * .08;
  min -= margin;
  max += margin;
  const x = (index: number) => pad.left + index / Math.max(1, points.length - 1) * (width - pad.left - pad.right);
  const y = (value: number) => pad.top + (max - value) / (max - min) * (height - pad.top - pad.bottom);
  const path = (key: string) => points.map((point, index) => `${index ? 'L' : 'M'} ${x(index).toFixed(2)} ${y(get(point, key)).toFixed(2)}`).join(' ');
  const area = `${path(primaryKey)} L ${x(points.length - 1)} ${height - pad.bottom} L ${x(0)} ${height - pad.bottom} Z`;
  const ticks = Array.from({ length: 5 }, (_, index) => min + (max - min) * index / 4).reverse();
  const dateIndexes = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];
  const lastPoint = points.at(-1);
  return <>
    <div className="chart-wrap"><svg className="chart-svg" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="权益曲线">
      <defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#d8ff6b" stopOpacity=".14" /><stop offset="100%" stopColor="#d8ff6b" stopOpacity="0" /></linearGradient></defs>
      {ticks.map((tick) => <g key={tick}><line className="chart-grid" x1={pad.left} y1={y(tick)} x2={width - pad.right} y2={y(tick)} /><text className="chart-axis" x={pad.left - 7} y={y(tick) + 3} textAnchor="end">{compact(tick)}</text></g>)}
      {dateIndexes.map((index) => <text key={index} className="chart-axis" x={x(index)} y={height - 8} textAnchor={index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'}>{dateTime((points[index] as Record<string, unknown>)?.timestamp)}</text>)}
      <path className="chart-area" d={area} style={{ fill: `url(#${gradientId})` }} />
      <path className="chart-line-primary" d={path(primaryKey)} />
      {secondaryKey && <path className="chart-line-secondary" d={path(secondaryKey)} />}
      <circle className="chart-dot" cx={x(points.length - 1)} cy={y(get(lastPoint, primaryKey))} r="4" />
    </svg></div>
    <div className="chart-legend"><span><i />{labels[0]}</span>{secondaryKey && labels[1] && <span><i className="secondary" />{labels[1]}</span>}</div>
  </>;
}

export function FactorBars({ metrics }: { metrics?: FactorMetric[] | undefined }) {
  if (!metrics?.length) return <EmptyState title="暂无 IC 数据" detail="运行多因子研究后显示各因子的截面 Rank IC。" />;
  return <div className="factor-bars">{metrics.map((metric) => {
    const value = finite(metric.meanRankIc);
    const size = Math.min(50, Math.abs(value) * 50);
    return <div className="factor-row" key={metric.factor}><label>{factorLabel(metric.factor)}</label><div className="factor-track"><span className={`factor-fill ${value >= 0 ? 'positive' : 'negative'}`} style={{ width: `${size}%` }} /></div><strong className={tone(value)}>{number(value, 3)}</strong></div>;
  })}</div>;
}

export function ScoreTable({ rows, limit = 20, onSelect }: { rows?: FactorRow[] | undefined; limit?: number; onSelect?: ((row: FactorRow) => void) | undefined }) {
  if (!rows?.length) return <EmptyState title="暂无因子评分" detail="从官方行情接口回补真实数据后刷新因子。" />;
  return <div className="table-wrap"><table className="data-table"><thead><tr><th className="left">排名 / 标的</th><th>方向</th><th>偏离</th><th>评分</th><th>动量 Z</th><th>流动性 Z</th><th>低波动 Z</th><th>Funding Z</th><th>状态</th></tr></thead><tbody>
    {rows.slice(0, limit).map((row) => <tr key={`${row.symbol}-${row.timestamp}`} data-action={onSelect ? 'select-factor' : undefined} onClick={() => onSelect?.(row)}><td className="left"><span className={`rank-pill ${row.rank > 0 && row.rank <= 3 ? 'top' : ''}`}>{row.rank || '—'}</span> <span className="symbol">{row.ticker}</span></td><td className={row.direction > 0 ? 'side-long' : 'side-short'}>{row.direction > 0 ? 'LONG' : 'SHORT'}</td><td className={tone(row.deviation)}>{percent(row.deviation, 2, false)}</td><td className="score">{number(row.score, 3)}</td><td>{number(row.momentumZ)}</td><td>{number(row.liquidityZ)}</td><td>{number(row.lowVolatilityZ)}</td><td>{number(row.fundingCarryZ)}</td><td><span className={`eligibility ${row.eligible ? 'yes' : ''}`}>{REASON_LABELS[row.eligibilityReason] || row.eligibilityReason}</span></td></tr>)}
  </tbody></table></div>;
}

export function TradeTable({ trades, limit = 100 }: { trades?: Trade[] | undefined; limit?: number }) {
  if (!trades?.length) return <EmptyState title="暂无成交" detail="当前参数没有产生交易，或尚未运行回测。" />;
  return <div className="table-wrap"><table className="data-table"><thead><tr><th className="left">标的</th><th>日期</th><th>方向</th><th>入场偏离</th><th>持有</th><th>退出原因</th><th>毛收益</th><th>费用</th><th>Funding</th><th>净收益</th></tr></thead><tbody>
    {trades.slice(0, limit).map((trade) => <tr key={trade.id}><td className="left symbol">{trade.ticker}</td><td>{trade.sessionDate}</td><td className={trade.side === 'long' ? 'side-long' : 'side-short'}>{trade.side.toUpperCase()}</td><td>{percent(trade.entryDeviationPct)}</td><td>{trade.holdBars} bars</td><td>{trade.exitReason}</td><td className={tone(trade.grossPnl)}>{money(trade.grossPnl, 2)}</td><td className="negative">-{money(finite(trade.fees) + finite(trade.slippage), 2)}</td><td className={tone(-trade.funding)}>{money(-finite(trade.funding), 2)}</td><td className={tone(trade.pnl)}>{money(trade.pnl, 2)}</td></tr>)}
  </tbody></table></div>;
}

export function SymbolSelector({ symbols, selected, onChange }: { symbols: string[]; selected: string[]; onChange: (symbols: string[]) => void }) {
  const selectedSet = new Set(selected);
  return <div className="check-grid">{symbols.map((symbol) => <label className="symbol-check" key={symbol}><input type="checkbox" checked={selectedSet.has(symbol)} onChange={(event) => onChange(event.target.checked ? [...selected, symbol] : selected.filter((item) => item !== symbol))} /><span>{symbol.replace('xyz:', '')}</span></label>)}</div>;
}
