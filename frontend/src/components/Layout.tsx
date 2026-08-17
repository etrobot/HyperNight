import { useEffect, useState, type ReactNode } from 'react';

import { compact, finite } from '../lib/format';
import type { View } from '../types';

const VIEW_META: Record<View, { code: string; title: string; label: string }> = {
  overview: { code: 'OVERVIEW', title: '休市策略控制台', label: '总览' },
  factors: { code: 'FACTOR SCORE', title: '最新 5m 因子评分', label: '因子评分' },
  research: { code: 'RESEARCH LAB', title: 'Rank IC 与前向收益', label: '因子研究' },
  backtest: { code: 'PORTFOLIO', title: '核心仓 + 动态对冲', label: '组合回测' },
  paper: { code: 'PAPER ENGINE', title: '可恢复模拟交易', label: '模拟交易' },
  data: { code: 'MARKET DATA', title: '行情回补与覆盖审计', label: '行情数据' }
};

function NavGlyph({ view }: { view: View }) {
  const common = { fill: 'none', stroke: 'currentColor', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, strokeWidth: 1.7 };
  if (view === 'overview') return <svg viewBox="0 0 24 24" aria-hidden="true"><path {...common} d="M4 4h6v6H4zM14 4h6v10h-6zM4 14h6v6H4zM14 18h6v2h-6z" /></svg>;
  if (view === 'factors') return <svg viewBox="0 0 24 24" aria-hidden="true"><path {...common} d="m12 3 8 9-8 9-8-9 8-9Z" /><path {...common} d="m8.5 12 2.2 2.2 4.8-5" /></svg>;
  if (view === 'research') return <svg viewBox="0 0 24 24" aria-hidden="true"><path {...common} d="M9 3h6M10 3v6l-5 8.2A2.5 2.5 0 0 0 7.1 21h9.8a2.5 2.5 0 0 0 2.1-3.8L14 9V3" /><path {...common} d="M8 15h8" /></svg>;
  if (view === 'backtest') return <svg viewBox="0 0 24 24" aria-hidden="true"><path {...common} d="M4 19V5M4 19h16" /><path {...common} d="m7 15 4-4 3 2 5-7" /></svg>;
  if (view === 'paper') return <svg viewBox="0 0 24 24" aria-hidden="true"><path {...common} d="M4 12h3l2-5 4 10 2-5h5" /><path {...common} d="M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" /></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><ellipse {...common} cx="12" cy="5" rx="7" ry="3" /><path {...common} d="M5 5v6c0 1.7 3.1 3 7 3s7-1.3 7-3V5M5 11v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" /></svg>;
}

function UtilityGlyph({ kind }: { kind: 'docs' | 'engine' }) {
  if (kind === 'docs') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4.5A2.5 2.5 0 0 1 7.5 2H20v17H7.5A2.5 2.5 0 0 0 5 21.5v-17Z" /><path d="M5 4.5v17M9 7h7M9 11h7" /></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h3l2-5 4 10 2-5h5" /></svg>;
}

interface LayoutProps {
  view: View;
  onView: (view: View) => void;
  sidebarOpen: boolean;
  onSidebarOpen: (open: boolean) => void;
  busy: boolean;
  activeTask: string | null;
  counts: Record<string, number>;
  notice: string[];
  actions: ReactNode;
  onRefresh: () => void;
  children: ReactNode;
}

export function Layout({
  view,
  onView,
  sidebarOpen,
  onSidebarOpen,
  busy,
  activeTask,
  counts,
  notice,
  actions,
  onRefresh,
  children
}: LayoutProps) {
  const [clock, setClock] = useState('--:--:--');
  const meta = VIEW_META[view];
  const running = busy || Boolean(activeTask);

  useEffect(() => {
    const update = () => setClock(new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Hong_Kong',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(new Date()));
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const totalRows = Object.values(counts).reduce((sum, value) => sum + finite(value), 0);
  const warnings = [...new Set(notice.filter(Boolean))];

  return <div className="app-shell">
    <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
      <div className="brand">
        <div className="brand-mark"><span>H</span><i>N</i></div>
        <div className="brand-copy"><strong>HyperNight</strong><small>OFF-HOURS QUANT</small></div>
      </div>
      <nav className="nav-list" aria-label="主导航">
        {(Object.entries(VIEW_META) as Array<[View, typeof meta]>).map(([key, item]) => <button
          key={key}
          className={`nav-item ${view === key ? 'active' : ''}`}
          onClick={() => { onView(key); onSidebarOpen(false); }}
          aria-label={item.label}
          aria-current={view === key ? 'page' : undefined}
        >
          <span className="nav-icon"><NavGlyph view={key} /></span>
          <span className="nav-label"><strong>{item.label}</strong><small>{item.code}</small></span>
          <span className="nav-tooltip"><strong>{item.label}</strong><small>{item.title}</small></span>
          {view === key && <i className="nav-active-marker" />}
        </button>)}
      </nav>
      <div className="sidebar-foot">
        <a className="sidebar-utility" href="/README.md" target="_blank" rel="noreferrer" aria-label="操作文档">
          <UtilityGlyph kind="docs" />
          <span className="nav-tooltip"><strong>操作文档</strong><small>在新窗口打开 README</small></span>
        </a>
        <div className={`sidebar-utility engine ${running ? 'busy' : ''}`} aria-label={running ? activeTask || '计算中' : '本地引擎就绪'}>
          <UtilityGlyph kind="engine" /><span className={`status-dot ${running ? 'busy' : ''}`} />
          <span className="nav-tooltip"><strong>{running ? activeTask || '计算中' : '本地引擎就绪'}</strong><small>{compact(counts.candles_5m || 0)} 根 5m K · {totalRows.toLocaleString()} 行</small></span>
        </div>
      </div>
    </aside>

    <button className={`sidebar-scrim ${sidebarOpen ? 'open' : ''}`} aria-label="关闭菜单" onClick={() => onSidebarOpen(false)} />

    <main className="workspace">
      <header className="topbar">
        <div className="topbar-left">
          <button className="mobile-menu" aria-label="打开菜单" onClick={() => onSidebarOpen(true)}>☰</button>
          <div><span className="breadcrumb">HYPERNIGHT / <b>{meta.code}</b></span><h1>{meta.title}</h1></div>
        </div>
        <div className="topbar-right">
          <div className="market-clock"><small>HONG KONG</small><strong>{clock}</strong></div>
          <div className="top-status"><span className={`pulse ${running ? 'busy' : ''}`} /><div><small>ENGINE</small><strong>{running ? 'RUNNING' : 'READY'}</strong></div></div>
          <div className="topbar-actions">{actions}</div>
          <button className={`icon-button ${busy ? 'spinning' : ''}`} aria-label="刷新" onClick={onRefresh}>↻</button>
        </div>
      </header>
      {warnings.length > 0 && <div className="notice-bar">{warnings.join('  ·  ')}</div>}
      <section className="view-root" data-view={view} aria-live="polite">{children}</section>
    </main>
  </div>;
}

export { VIEW_META };
