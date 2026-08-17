import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';

import { ConfigDialog } from './components/ConfigDialog';
import { Layout } from './components/Layout';
import {
  EmptyState,
  FACTORS,
  FactorBars,
  LineChart,
  REASON_LABELS,
  ScoreTable,
  SymbolSelector,
  TradeTable,
  WarningList,
  factorLabel
} from './components/Primitives';
import { postJson, requestJson } from './lib/api';
import { compact, dateTime, finite, isoDate, money, number, percent, tone } from './lib/format';
import type {
  BackfillResult,
  BacktestResult,
  BootstrapPayload,
  FactorRow,
  FactorSnapshot,
  OptimizationResponse,
  PaperTickResponse,
  ResearchResult,
  StrategyConfig,
  View
} from './types';

const CORE_SYMBOLS = ['xyz:AAPL', 'xyz:MSFT', 'xyz:NVDA', 'xyz:TSLA', 'xyz:META'];

function cloneConfig(config: StrategyConfig): StrategyConfig {
  return { ...config, factorWeights: { ...config.factorWeights } };
}

function validateConfig(config: StrategyConfig): string | null {
  const ranges: Partial<Record<keyof StrategyConfig, [number, number]>> = {
    entryDeviation: [0, 1], exitDeviation: [0, 1], minScore: [-100, 100], momentumBars: [1, 1_000],
    volatilityBars: [2, 1_000], liquidityBars: [1, 1_000], maxPositions: [1, 1_000], grossNotionalPct: [0.000001, 100],
    maxCoreNotional: [0.01, Infinity], maxNotional: [0.01, Infinity], takeProfit: [0, 10], stopLoss: [0, 10],
    maxHoldBars: [1, 100_000], hedgeStep: [0.000001, 10], hedgeFraction: [0.000001, 1], maxHedgeRatio: [0, 1],
    maxFunding: [0, 1], minBarNotional: [0, Infinity], minExpectedEdge: [0, 1], feeRate: [0, 1],
    slippageBps: [0, 100_000], initialCapital: [0.01, Infinity], referenceMismatchLimit: [0, 1], minSessionCoverage: [0, 1]
  };
  for (const [key, range] of Object.entries(ranges) as Array<[keyof StrategyConfig, [number, number]]>) {
    const value = Number(config[key]);
    if (!Number.isFinite(value) || value < range[0] || value > range[1]) return `策略参数 ${key} 超出允许范围`;
  }
  if (config.exitDeviation >= config.entryDeviation) return '退出偏离必须小于开仓偏离';
  if (config.maxCoreNotional > config.maxNotional) return '单仓核心名义不得高于单仓最大名义';
  for (const key of ['momentumBars', 'volatilityBars', 'liquidityBars', 'maxPositions', 'maxHoldBars'] as const) {
    if (!Number.isInteger(config[key])) return `${key} 必须是整数`;
  }
  const weights = Object.values(config.factorWeights);
  if (weights.some((value) => !Number.isFinite(value) || value < 0)) return '因子权重必须是非负有限数';
  const weightSum = weights.reduce((sum, value) => sum + value, 0);
  if (Math.abs(weightSum - 1) > 1e-9) return `五个因子权重之和必须为 1，当前为 ${number(weightSum, 3)}`;
  return null;
}

function dateRange(start: string, end: string): { startTime?: number; endTime?: number } {
  return {
    ...(start ? { startTime: Date.parse(`${start}T00:00:00Z`) } : {}),
    ...(end ? { endTime: Date.parse(`${end}T23:59:59.999Z`) } : {})
  };
}

function positionPnl(position: BootstrapPayload['paper']['positions'][number]): number {
  return finite(position.cashFlow) + (finite(position.coreQty) + finite(position.hedgeQty)) * finite(position.lastMarkPrice) - finite(position.fees) - finite(position.slippage) - finite(position.funding);
}

export default function App(): ReactElement {
  const [view, setViewState] = useState<View>('backtest');
  const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null);
  const [config, setConfig] = useState<StrategyConfig | null>(null);
  const [selectedSymbols, setSelectedSymbols] = useState<string[] | null>(null);
  const [factors, setFactors] = useState<FactorSnapshot | null>(null);
  const [selectedFactor, setSelectedFactor] = useState<string | null>(null);
  const [backtestMode, setBacktestMode] = useState<'hedged' | 'shadow'>('hedged');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [task, setTask] = useState<{ title: string; detail: string } | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [researchStart, setResearchStart] = useState('');
  const [researchEnd, setResearchEnd] = useState('');
  const [backtestStart, setBacktestStart] = useState('');
  const [backtestEnd, setBacktestEnd] = useState('');
  const [backfillDays, setBackfillDays] = useState(17);
  const toastTimer = useRef<number | null>(null);
  const initialized = useRef(false);

  const notify = useCallback((message: string, type: 'success' | 'error' = 'success') => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    setToast({ message, type });
    toastTimer.current = window.setTimeout(() => setToast(null), 4_200);
  }, []);

  const applyBootstrap = useCallback((data: BootstrapPayload) => {
    setBootstrap(data);
    setConfig((current) => current || cloneConfig(data.config));
    setSelectedSymbols((current) => {
      const source = Array.isArray(current) ? current : data.symbols;
      return [...new Set(source)].filter((symbol) => data.symbols.includes(symbol));
    });
    setResearchStart((current) => current || isoDate(data.research?.startTime));
    setResearchEnd((current) => current || isoDate(data.research?.endTime));
    setBacktestStart((current) => current || isoDate(data.backtest?.startTime));
    setBacktestEnd((current) => current || isoDate(data.backtest?.endTime));
  }, []);

  const loadBootstrap = useCallback(async () => {
    try {
      setLoadError(null);
      applyBootstrap(await requestJson<BootstrapPayload>('/api/bootstrap'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLoadError(message);
      notify(message, 'error');
    }
  }, [applyBootstrap, notify]);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    void loadBootstrap();
  }, [loadBootstrap]);

  useEffect(() => () => { if (toastTimer.current) window.clearTimeout(toastTimer.current); }, []);

  const selection = selectedSymbols || [];
  const selectionKey = selection.join(',');

  const loadFactors = useCallback(async () => {
    if (!selection.length) {
      setFactors({ timestamp: null, rows: [], sessionStatuses: {}, warnings: ['请先选择至少一个标的。'] });
      return;
    }
    try {
      const snapshot = await requestJson<FactorSnapshot>(`/api/factors/latest?symbols=${encodeURIComponent(selection.join(','))}`);
      setFactors(snapshot);
      setSelectedFactor((current) => current && snapshot.rows.some((row) => row.symbol === current) ? current : snapshot.rows.find((row) => row.eligible)?.symbol || snapshot.rows[0]?.symbol || null);
    } catch (error) {
      setFactors({ timestamp: null, rows: [], sessionStatuses: {}, warnings: [error instanceof Error ? error.message : String(error)] });
    }
  }, [selectionKey]);

  useEffect(() => {
    if (view === 'factors' && bootstrap) void loadFactors();
  }, [view, bootstrap, loadFactors]);

  const setView = (next: View) => {
    setViewState(next);
    setSidebarOpen(false);
  };

  const updateSelection = (symbols: string[]) => {
    if (!bootstrap) return;
    setSelectedSymbols([...new Set(symbols)].filter((symbol) => bootstrap.symbols.includes(symbol)).sort());
    setFactors(null);
  };

  const requireSymbols = (): string[] | null => {
    if (selection.length) return selection;
    notify('请至少选择一个标的', 'error');
    return null;
  };

  const execute = async (title: string, detail: string, work: () => Promise<void>) => {
    setTask({ title, detail });
    try { await work(); }
    catch (error) { notify(error instanceof Error ? error.message : String(error), 'error'); }
    finally { setTask(null); }
  };

  const runResearch = () => {
    const symbols = requireSymbols();
    if (!symbols || !config) return;
    void execute('正在运行多因子研究', 'Polars 正在计算滚动特征、截面标准化与 Rank IC...', async () => {
      const result = await postJson<ResearchResult>('/api/research', { symbols, config, ...dateRange(researchStart, researchEnd) });
      setFactors(null);
      await loadBootstrap();
      notify(`研究完成：${result.eligibleCount} 条可交易因子记录`);
    });
  };

  const runBacktest = () => {
    const symbols = requireSymbols();
    if (!symbols || !config) return;
    void execute('正在运行组合回测', '逐根推进核心仓、动态对冲、Funding 与无对冲影子组合...', async () => {
      const result = await postJson<BacktestResult>('/api/backtest', { symbols, config, ...dateRange(backtestStart, backtestEnd) });
      await loadBootstrap();
      notify(`回测完成：${result.portfolio.tradeCount} 笔交易，净收益 ${money(result.portfolio.totalPnl, 2)}`);
    });
  };

  const runOptimization = () => {
    const symbols = requireSymbols();
    if (!symbols || !config) return;
    void execute('正在优化参数并生成正式回测', '60 组候选 × 3 个时间验证折；最后一段独立测试，并执行 0/2/5 bps 成本压力...', async () => {
      const response = await postJson<OptimizationResponse>('/api/optimization', {
        symbols,
        config,
        trials: 60,
        folds: 3,
        seed: 7,
        costScenariosBps: [0, 2, 5],
        ...dateRange(backtestStart, backtestEnd)
      });
      setConfig(cloneConfig(response.optimization.bestConfig));
      setFactors(null);
      await loadBootstrap();
      notify(`优化与正式回测完成：${response.optimization.trials.length} 组候选，净收益 ${money(response.backtest.portfolio.totalPnl, 2)}`);
    });
  };

  const runBackfill = () => {
    const symbols = requireSymbols();
    if (!symbols) return;
    void execute('正在回补市场行情', `采集 ${symbols.length} 个 HIP-3 标的的 5m、1d、Funding 与正股日 K...`, async () => {
      const result = await postJson<BackfillResult>('/api/data/backfill', { symbols, days: backfillDays });
      const failures = result.results.filter((item) => item.error);
      setFactors(null);
      await loadBootstrap();
      notify(failures.length ? `回补完成，${failures.length} 个标的失败` : `回补完成：${result.results.length} 个标的`, failures.length ? 'error' : 'success');
    });
  };

  const initializePaper = (replay: boolean) => {
    const symbols = requireSymbols();
    if (!symbols || !bootstrap || !config) return;
    if (bootstrap.paper.account && !window.confirm('这会清空当前模拟账户、仓位、交易与权益记录。继续吗？')) return;
    void execute(replay ? '正在回放历史模拟盘' : '正在初始化模拟账户', replay ? '账户将从本地最早可用休市段开始。' : '账户将从最新已存 5m K 之后开始。', async () => {
      await postJson('/api/paper/init', { symbols, config, replay });
      if (replay) await postJson<PaperTickResponse>('/api/paper/tick', { symbols, refresh: false });
      await loadBootstrap();
      notify(replay ? '历史模拟盘回放完成' : '模拟账户已初始化');
    });
  };

  const tickPaper = (refresh: boolean) => {
    const symbols = requireSymbols();
    if (!symbols) return;
    void execute('正在推进模拟盘', refresh ? '先刷新最近行情，再从 lastProcessedTimestamp 继续。' : '仅处理 SQLite 中尚未消费的已收盘 5m K。', async () => {
      const response = await postJson<PaperTickResponse>('/api/paper/tick', { symbols, refresh, days: 3 });
      await loadBootstrap();
      notify(`模拟盘完成：开仓 ${response.result.openedPositions}，平仓 ${response.result.closedTrades}`);
    });
  };

  const saveConfig = (next: StrategyConfig): string | null => {
    const error = validateConfig(next);
    if (error) return error;
    const saved = cloneConfig(next);
    setConfig(saved);
    setFactors(null);
    notify('策略参数已应用');
    return null;
  };

  const notice = useMemo(() => {
    if (!bootstrap) return [];
    if (view === 'factors') return factors?.warnings || [];
    if (view === 'research') return bootstrap.research?.warnings || [];
    if (view === 'backtest') return [...(bootstrap.optimization?.warnings || []), ...(bootstrap.backtest?.warnings || [])];
    if (view === 'overview') return [...(bootstrap.optimization?.warnings || []), ...(bootstrap.research?.warnings || []), ...(bootstrap.backtest?.warnings || [])];
    return [];
  }, [bootstrap, factors, view]);

  if (!bootstrap || !config) {
    return <div className="boot-screen"><div className="boot-card"><div className="brand-mark"><span>H</span><i>N</i></div><span className="kicker">HYPERNIGHT REACT WORKSTATION</span><h1>{loadError ? '无法连接本地 API' : '正在启动量化工作台'}</h1><p>{loadError || '读取 SQLite、策略参数与最近运行结果。'}</p>{loadError && <button className="button primary" onClick={() => void loadBootstrap()}>重试连接</button>}</div></div>;
  }

  const research = bootstrap.research;
  const optimization = bootstrap.optimization;
  const backtest = bootstrap.backtest;
  const paper = bootstrap.paper;
  const counts = bootstrap.database.counts;
  const hasData = finite(counts.candles_5m) > 0 && bootstrap.database.audit.syntheticRows === 0;

  const overviewPage = () => {
    const latestPaper = paper.equity[0];
    const availableSymbols = bootstrap.database.coverage.length;
    const coveragePct = Math.min(100, availableSymbols / Math.max(1, bootstrap.symbols.length) * 100);
    return <div className="page overview-page">
      <div className="overview-workspace">
        <section className="panel overview-status-panel"><div className="panel-head"><div className="panel-title"><h3>策略与数据状态</h3><small>LOCAL ENGINE / DATA READINESS</small></div><span className={`tag ${hasData ? 'live' : ''}`}>{hasData ? 'REAL DATA' : 'EMPTY'}</span></div><div className="panel-body flush"><div className="overview-coverage"><div><span>SYMBOL COVERAGE</span><strong>{number(coveragePct, 0)}%</strong></div><div className="coverage-track"><span style={{ width: `${coveragePct}%` }} /></div><small>{availableSymbols} / {bootstrap.symbols.length} 个 HIP-3 标的已落库</small></div><div className="overview-kpi-list"><div><span><small>5M CANDLES</small><b>{availableSymbols} 个标的</b></span><strong>{compact(counts.candles_5m || 0)}</strong></div><div><span><small>VALID SESSIONS</small><b>{research ? `${compact(research.rowCount)} 条记录` : '等待研究'}</b></span><strong>{research?.sessionCount ?? '—'}</strong></div><div><span><small>OPTIMIZATION</small><b>{optimization ? `${optimization.trials.length} 组 · ${optimization.sessionCount} 个休市段` : '等待参数优化'}</b></span><strong>{optimization?.recommendationStatus.toUpperCase() ?? '—'}</strong></div><div><span><small>BACKTEST RETURN</small><b>{backtest ? `${backtest.portfolio.tradeCount} 笔 · DD ${number(backtest.portfolio.maxDrawdownPct)}%` : '等待回测'}</b></span><strong className={backtest ? tone(backtest.portfolio.totalPnl) : ''}>{backtest ? percent(backtest.portfolio.totalReturnPct) : '—'}</strong></div><div><span><small>PAPER EQUITY</small><b>{paper.account ? `${paper.positions.length} 个开放仓位` : '账户未初始化'}</b></span><strong>{latestPaper ? money(latestPaper.equity) : paper.account ? money(paper.account.cash) : '—'}</strong></div></div><div className="terminal-list"><div><span>SESSION WINDOW</span><strong>{config.windowStartEt} → {config.windowEndEt} ET</strong></div><div><span>ENTRY / EXIT</span><strong>{percent(config.entryDeviation, 1, false)} / {percent(config.exitDeviation, 1, false)}</strong></div><div><span>LAST 5M BAR</span><strong>{dateTime(bootstrap.database.candleBounds5m?.endTime)}</strong></div></div></div></section>
        <section className="panel overview-equity-panel"><div className="panel-head"><div className="panel-title"><h3>组合权益</h3><small>HEDGED PORTFOLIO VS CORE-ONLY SHADOW</small></div><button className="button compact" onClick={() => setView('backtest')}>查看明细</button></div>{backtest ? <LineChart points={backtest.equity} primaryKey="equity" secondaryKey="noHedgeEquity" /> : <EmptyState title="等待首轮优化与回测" detail="回补真实行情后运行参数优化，系统会自动持久化正式回测。" action={<button className="button primary compact" onClick={runOptimization}>优化并回测</button>} />}</section>
        <section className="panel overview-scores-panel"><div className="panel-head"><div className="panel-title"><h3>最新评分榜</h3><small>{research ? `AS OF ${dateTime(research.endTime)}` : 'NO FACTOR SNAPSHOT'}</small></div><button className="button compact" onClick={() => setView('factors')}>全部评分</button></div><ScoreTable rows={research?.latestScores} limit={30} /></section>
        <section className="panel overview-factors-panel"><div className="panel-head"><div className="panel-title"><h3>因子有效性</h3><small>MEAN CROSS-SECTIONAL RANK IC</small></div><span className="tag">{research?.factorMetrics.find((item) => item.factor === 'score')?.observations || 0} OBS</span></div><div className="panel-body"><FactorBars metrics={research?.factorMetrics} /></div></section>
        <section className="panel overview-runtime-panel"><div className="panel-head"><div className="panel-title"><h3>本地运行状态</h3><small>REACT + VITE + SQLITE ENGINE</small></div><span className="tag live">READY</span></div><div className="panel-body"><div className="terminal-list"><div><span>SQLITE</span><strong title={bootstrap.database.path}>{bootstrap.database.path.split('/').at(-1)}</strong></div><div><span>DATA SOURCE</span><strong>{bootstrap.database.audit.syntheticRows === 0 ? 'REAL ONLY' : `${bootstrap.database.audit.syntheticRows} SYNTHETIC`}</strong></div><div><span>DAILY K</span><strong>{compact(counts.candles_1d || 0)}</strong></div><div><span>FUNDING</span><strong>{compact(counts.funding_rates || 0)}</strong></div><div><span>RUNS</span><strong>{compact(counts.runs || 0)}</strong></div></div><WarningList warnings={[...(optimization?.warnings || []), ...(research?.warnings || []), ...(backtest?.warnings || [])]} /></div></section>
      </div>
    </div>;
  };

  const factorsPage = () => {
    const rows = factors?.rows || research?.latestScores || [];
    const selected = rows.find((row) => row.symbol === selectedFactor) || rows.find((row) => row.eligible) || rows[0];
    return <div className="page factors-page">
      {selected && <section className="panel"><div className="panel-body"><div className="score-hero"><div className="score-orb"><div><strong>{number(selected.score, 3)}</strong><small>COMPOSITE SCORE</small></div></div><div className="score-copy"><span className="kicker">RANK #{selected.rank || '—'} · {selected.sessionDate}</span><h3>{selected.ticker} <span className={selected.direction > 0 ? 'side-long' : 'side-short'}>{selected.direction > 0 ? 'LONG' : 'SHORT'}</span></h3><p>当前偏离 {percent(selected.deviation, 2, false)}，参照价 {money(selected.referencePrice, 2)}。{selected.eligible ? '已通过成本、Funding、流动性与最低分过滤。' : `当前不可交易：${REASON_LABELS[selected.eligibilityReason] || selected.eligibilityReason}。`}</p><div className="factor-chip-grid">{FACTORS.map(([, label, field]) => <div className="factor-chip" key={field}><small>{label.toUpperCase()}</small><strong className={tone(selected[field])}>{number(selected[field])} Z</strong></div>)}</div></div></div></div></section>}
      <div className="content-grid"><section className="panel span-12"><div className="panel-head"><div className="panel-title"><h3>截面排行榜</h3><small>{factors?.timestamp ? `SNAPSHOT ${dateTime(factors.timestamp)}` : 'LATEST RESEARCH SNAPSHOT'}</small></div><span className="tag">{rows.filter((row) => row.eligible).length} ELIGIBLE</span></div><ScoreTable rows={rows} limit={60} onSelect={(row) => setSelectedFactor(row.symbol)} /></section>
        <section className="panel span-6"><div className="panel-head"><div className="panel-title"><h3>因子暴露</h3><small>SELECTED SYMBOL Z-SCORES</small></div></div><div className="panel-body">{selected ? <div className="factor-bars">{FACTORS.map(([, label, field]) => { const value = finite(selected[field]); return <div className="factor-row" key={field}><label>{label}</label><div className="factor-track"><span className={`factor-fill ${value >= 0 ? 'positive' : 'negative'}`} style={{ width: `${Math.min(50, Math.abs(value) / 3 * 50)}%` }} /></div><strong className={tone(value)}>{number(value)}</strong></div>; })}</div> : <EmptyState title="无可用标的" detail="请先回补行情。" />}</div></section>
        <section className="panel span-6"><div className="panel-head"><div className="panel-title"><h3>会话审计</h3><small>REFERENCE / COVERAGE GUARDS</small></div></div><div className="panel-body">{factors ? <><div className="trade-detail">{Object.entries(factors.sessionStatuses).map(([status, count]) => <div key={status}><small>{status.toUpperCase()}</small><strong>{count}</strong></div>)}</div><WarningList warnings={factors.warnings} /></> : <EmptyState title="正在读取因子快照" detail="Polars 正在加载本地休市段数据。" />}</div></section>
      </div></div>;
  };

  const researchPage = () => <div className="page research-page">
    <section className="panel"><div className="panel-head"><div className="panel-title"><h3>研究范围</h3><small>OPTIONAL DATE FILTERS · DEFAULT USES ALL LOCAL DATA</small></div></div><div className="panel-body"><div className="control-grid"><div className="field"><label>开始日期（可选）</label><input type="date" value={researchStart} onChange={(event) => setResearchStart(event.target.value)} /></div><div className="field"><label>结束日期（可选）</label><input type="date" value={researchEnd} onChange={(event) => setResearchEnd(event.target.value)} /></div><div className="field"><label>候选标的</label><input value={`${selection.length} / ${bootstrap.symbols.length}`} disabled /></div><div className="field"><label>特征引擎</label><input value="nodejs-polars" disabled /></div></div><div style={{ marginTop: 10 }}><SymbolSelector symbols={bootstrap.symbols} selected={selection} onChange={updateSelection} /></div></div></section>
    <div className="content-grid"><section className="panel span-6"><div className="panel-head"><div className="panel-title"><h3>平均 Rank IC</h3><small>CROSS-SECTIONAL SPEARMAN CORRELATION</small></div><span className="tag">{research?.sessionCount ?? 0} SESSIONS</span></div><div className="panel-body"><FactorBars metrics={research?.factorMetrics} /></div></section><section className="panel span-6"><div className="panel-head"><div className="panel-title"><h3>正 IC 比例</h3><small>POSITIVE CROSS-SECTION RATE</small></div><span className={`tag ${research ? tone(research.topScoreForwardReturnPct) : ''}`}>TOP-N {research?.topScoreForwardReturnPct == null ? '—' : percent(research.topScoreForwardReturnPct, 3)}</span></div><div className="panel-body">{research?.factorMetrics.length ? <div className="factor-bars">{research.factorMetrics.map((metric) => { const value = finite(metric.positiveIcRate); return <div className="factor-row" key={metric.factor}><label>{factorLabel(metric.factor)}</label><div className="factor-track"><span className="factor-fill positive" style={{ width: `${Math.min(50, value * 50)}%` }} /></div><strong>{percent(value, 1, false)}</strong></div>; })}</div> : <EmptyState title="暂无研究结果" detail="点击运行多因子研究。" />}</div></section><section className="panel span-12"><div className="panel-head"><div className="panel-title"><h3>最新研究评分</h3><small>{research ? `${compact(research.rowCount)} ROWS · ${compact(research.eligibleCount)} ELIGIBLE · ${research.strategyVersion} · ${research.featureEngineVersion}` : 'NO COMPLETED RUN'}</small></div></div><ScoreTable rows={research?.latestScores} limit={50} /></section></div><WarningList warnings={research?.warnings} /></div>;

  const backtestPage = () => {
    const metrics = backtestMode === 'hedged' ? backtest?.portfolio : backtest?.noHedgePortfolio;
    const trades = backtestMode === 'hedged' ? backtest?.trades : backtest?.noHedgeTrades;
    return <div className="page backtest-page">
      <section className="panel"><div className="panel-head"><div className="panel-title"><h3>最新参数优化与正式回测</h3><small>TIME-SPLIT VALIDATION · INDEPENDENT TEST · PERSISTED SQLITE RUNS</small></div><span className={`tag ${optimization?.recommendationStatus === 'recommended' ? 'live' : ''}`}>{optimization?.recommendationStatus.toUpperCase() ?? 'NOT RUN'}</span></div><div className="panel-body"><div className="backtest-control-layout"><div><div className="control-grid"><div className="field"><label>开始日期（可选）</label><input type="date" value={backtestStart} onChange={(event) => setBacktestStart(event.target.value)} /></div><div className="field"><label>结束日期（可选）</label><input type="date" value={backtestEnd} onChange={(event) => setBacktestEnd(event.target.value)} /></div><div className="field"><label>初始资金</label><input value={money(config.initialCapital)} disabled /></div><div className="field"><label>组合容量</label><input value={`${config.maxPositions} positions / ${money(config.maxNotional)} reserve`} disabled /></div></div><div style={{ marginTop: 10 }}><SymbolSelector symbols={bootstrap.symbols} selected={selection} onChange={updateSelection} /></div></div><div className="optimization-summary">{optimization ? <><div className="optimization-summary-head"><span>{dateTime(Date.parse(optimization.generatedAt))}</span><strong>{optimization.trials.length} TRIALS · {optimization.validationFolds.length} FOLDS</strong></div><div className="optimization-kpis"><div><small>验证收益</small><strong className={tone(optimization.bestValidation?.totalReturnPct)}>{percent(optimization.bestValidation?.totalReturnPct)}</strong></div><div><small>独立测试</small><strong className={tone(optimization.testWindow?.totalReturnPct)}>{percent(optimization.testWindow?.totalReturnPct)}</strong></div><div><small>正式回测</small><strong className={backtest ? tone(backtest.portfolio.totalPnl) : ''}>{backtest ? percent(backtest.portfolio.totalReturnPct) : '—'}</strong></div></div><div className="optimization-config"><span>ENTRY {percent(optimization.bestConfig.entryDeviation, 2, false)}</span><span>EXIT {percent(optimization.bestConfig.exitDeviation, 2, false)}</span><span>TOP {optimization.bestConfig.maxPositions}</span><span>TP {percent(optimization.bestConfig.takeProfit, 2, false)}</span><span>SL {percent(optimization.bestConfig.stopLoss, 2, false)}</span></div><small className="optimization-dataset">{optimization.datasetVersion} · {optimization.sessionCount} SESSIONS · RUN {optimization.formalBacktestRunId.slice(0, 8)}</small></> : <EmptyState title="暂无真实参数优化结果" detail="回补行情后点击“优化并回测”；成功结果会在应用重启后自动恢复。" />}</div></div></div></section>
      <div className="content-grid"><section className="panel span-8"><div className="panel-head"><div className="panel-title"><h3>双组合权益曲线</h3><small>HEDGED VS SAME-SIGNAL CORE ONLY</small></div><div className="panel-tools"><span className={`tag ${metrics ? tone(metrics.totalPnl) : ''}`}>RET {metrics ? percent(metrics.totalReturnPct) : '—'}</span><span className="tag">MAX {backtest?.maxConcurrentPositions || 0} OPEN</span></div></div>{backtest ? <LineChart points={backtest.equity} primaryKey="equity" secondaryKey="noHedgeEquity" /> : <EmptyState title="尚无回测曲线" detail="使用本地 5m K 与正股日 K 运行组合回测。" />}</section><section className="panel span-4"><div className="panel-head"><div className="panel-title"><h3>绩效与成本</h3><small>SELECTED PORTFOLIO</small></div></div><div className="panel-body">{metrics ? <div className="trade-detail"><div><small>NET PNL</small><strong className={tone(metrics.totalPnl)}>{money(metrics.totalPnl, 2)}</strong></div><div><small>WIN RATE</small><strong>{percent(metrics.winRate, 1, false)}</strong></div><div><small>MAX DRAWDOWN</small><strong className={metrics.maxDrawdownPct > 0 ? 'negative' : ''}>{number(metrics.maxDrawdownPct)}%</strong></div><div><small>SHARPE</small><strong>{number(metrics.sharpe)}</strong></div><div><small>GROSS PNL</small><strong className={tone(metrics.grossPnl)}>{money(metrics.grossPnl, 2)}</strong></div><div><small>TAKER FEES</small><strong className="negative">-{money(metrics.fees, 2)}</strong></div><div><small>SLIPPAGE</small><strong className="negative">-{money(metrics.slippage, 2)}</strong></div><div><small>FUNDING</small><strong className={tone(-metrics.funding)}>{money(-metrics.funding, 2)}</strong></div><div><small>AVG HOLD</small><strong>{number(metrics.avgHoldBars, 1)} bars</strong></div><div><small>TRADE COUNT</small><strong>{metrics.tradeCount}</strong></div></div> : <EmptyState title="暂无绩效数据" detail="完成回测后显示。" />}</div></section><section className="panel span-12"><div className="panel-head"><div className="panel-title"><h3>交易账本</h3><small>PRICE PNL AND COSTS ARE SEPARATELY AUDITABLE</small></div><div className="segmented"><button className={backtestMode === 'hedged' ? 'active' : ''} onClick={() => setBacktestMode('hedged')}>动态对冲</button><button className={backtestMode === 'shadow' ? 'active' : ''} onClick={() => setBacktestMode('shadow')}>核心仓影子</button></div></div><TradeTable trades={trades} /></section></div><WarningList warnings={backtest?.warnings} /></div>;
  };

  const paperPage = () => {
    const account = paper.account;
    const latest = paper.equity[0];
    return <div className="page paper-page">
      {!account ? <section className="panel"><EmptyState title="创建本地模拟账户" detail="默认从数据库最新一根 5m K 之后开始；也可以从已有历史数据回放验证完整链路。" action={<div className="page-actions"><button className="button primary" onClick={() => initializePaper(false)}>从最新 K 线开始</button><button className="button ghost" onClick={() => initializePaper(true)}>历史回放</button></div>} /></section> : <div className="content-grid"><section className="panel span-8"><div className="panel-head"><div className="panel-title"><h3>模拟盘权益</h3><small>CASH + OPEN POSITION MARK-TO-MARKET</small></div><div className="panel-tools"><span className={`tag ${latest ? tone(latest.equity - account.initialCapital) : ''}`}>{latest ? money(latest.equity, 2) : money(account.cash, 2)}</span><span className="tag live">{paper.positions.length} OPEN</span></div></div><LineChart points={[...paper.equity].reverse()} primaryKey="equity" labels={['模拟账户']} /></section><section className="panel span-4"><div className="panel-head"><div className="panel-title"><h3>账户概览与成本</h3><small>PERSISTED ACCOUNT LEDGER</small></div></div><div className="panel-body"><div className="trade-detail"><div><small>ACCOUNT EQUITY</small><strong className={latest ? tone(latest.equity - account.initialCapital) : ''}>{latest ? money(latest.equity, 2) : money(account.cash, 2)}</strong></div><div><small>INITIAL CAPITAL</small><strong>{money(account.initialCapital, 2)}</strong></div><div><small>REALIZED PNL</small><strong className={tone(account.realizedPnl)}>{money(account.realizedPnl, 2)}</strong></div><div><small>CASH</small><strong>{money(account.cash, 2)}</strong></div><div><small>CLOSED TRADES</small><strong>{paper.trades.length}</strong></div><div><small>FEES</small><strong className="negative">-{money(account.feesPaid, 2)}</strong></div><div><small>SLIPPAGE</small><strong className="negative">-{money(account.slippagePaid, 2)}</strong></div><div><small>FUNDING</small><strong className={tone(-account.fundingPaid)}>{money(-account.fundingPaid, 2)}</strong></div><div><small>LAST PROCESSED</small><strong>{dateTime(account.lastProcessedTimestamp)}</strong></div><div><small>UPDATED</small><strong>{dateTime(account.updatedAt)}</strong></div></div><div style={{ marginTop: 11 }}><button className="button ghost full-width" onClick={() => tickPaper(false)}>仅处理本地 K 线</button></div></div></section><section className="panel span-12"><div className="panel-head"><div className="panel-title"><h3>开放仓位</h3><small>CORE + DYNAMIC HEDGE STATE</small></div><span className="tag">{paper.positions.length} OPEN</span></div>{paper.positions.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th className="left">标的</th><th>方向</th><th>核心数量</th><th>对冲数量</th><th>入场价</th><th>最新价</th><th>持仓盈亏</th><th>对冲次数</th><th>入场时间</th></tr></thead><tbody>{paper.positions.map((position) => <tr key={position.id}><td className="left symbol">{position.ticker}</td><td className={position.coreQty > 0 ? 'side-long' : 'side-short'}>{position.coreQty > 0 ? 'LONG' : 'SHORT'}</td><td>{number(Math.abs(position.coreQty), 4)}</td><td>{number(position.hedgeQty, 4)}</td><td>{money(position.corePrice, 2)}</td><td>{money(position.lastMarkPrice, 2)}</td><td className={tone(positionPnl(position))}>{money(positionPnl(position), 2)}</td><td>{position.hedgeCount}</td><td>{dateTime(position.entryTimestamp)}</td></tr>)}</tbody></table></div> : <EmptyState title="当前无开放仓位" detail="下一次出现满足阈值与截面排名的信号时自动开仓。" />}</section><section className="panel span-12"><div className="panel-head"><div className="panel-title"><h3>模拟成交</h3><small>RECENT CLOSED TRADES</small></div></div><TradeTable trades={paper.trades} /></section></div>}
    </div>;
  };

  const dataPage = () => <div className="page data-page">
    <section className="panel"><div className="panel-head"><div className="panel-title"><h3>回补设置</h3><small>5M {compact(counts.candles_5m || 0)} · 1D {compact(counts.candles_1d || 0)} · STOCK {compact(counts.stock_daily_candles || 0)} · FUNDING {compact(counts.funding_rates || 0)}</small></div></div><div className="panel-body"><div className="control-grid"><div className="field"><label>回补天数</label><input type="number" min="2" max="90" value={backfillDays} onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value)) setBackfillDays(Math.max(2, Math.min(90, value))); }} /></div><div className="field"><label>已选标的</label><input value={`${selection.length} / ${bootstrap.symbols.length}`} disabled /></div><div className="field"><label>数据库</label><input value={bootstrap.database.path} disabled /></div><div className="field"><label>写入模式</label><input value="SQLite UPSERT / WAL" disabled /></div></div><div style={{ marginTop: 10 }}><SymbolSelector symbols={bootstrap.symbols} selected={selection} onChange={updateSelection} /></div><div className="page-actions selection-actions"><button className="button compact" onClick={() => updateSelection(CORE_SYMBOLS)}>核心 5 标的</button><button className="button compact" onClick={() => updateSelection(bootstrap.symbols)}>全选 {bootstrap.symbols.length} 标的</button><button className="button compact" onClick={() => updateSelection([])}>清空</button></div></div></section>
    <div className="content-grid"><section className="panel span-7"><div className="panel-head"><div className="panel-title"><h3>5m K 覆盖</h3><small>LOCAL SQLITE BY SYMBOL</small></div><span className="tag">{bootstrap.database.coverage.length} SYMBOLS</span></div>{bootstrap.database.coverage.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th className="left">标的</th><th>5m 数量</th><th>首根</th><th>末根</th><th>跨度</th></tr></thead><tbody>{bootstrap.database.coverage.map((row) => <tr key={row.symbol}><td className="left symbol">{row.symbol}</td><td>{compact(row.candleCount5m)}</td><td>{dateTime(row.firstTimestamp)}</td><td>{dateTime(row.lastTimestamp)}</td><td>{number((row.lastTimestamp - row.firstTimestamp) / 86_400_000, 1)}d</td></tr>)}</tbody></table></div> : <EmptyState title="SQLite 中没有 5m K" detail="选择标的并从官方行情接口回补真实数据。" action={<button className="button primary compact" onClick={runBackfill}>回补真实行情</button>} />}</section><section className="panel span-5"><div className="panel-head"><div className="panel-title"><h3>最新市场快照</h3><small>META AND ASSET CONTEXTS</small></div></div>{bootstrap.database.marketContexts.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th className="left">标的</th><th>Mark</th><th>Funding</th><th>24h 名义量</th></tr></thead><tbody>{bootstrap.database.marketContexts.slice(0, 20).map((row) => <tr key={row.symbol}><td className="left symbol">{row.symbol}</td><td>{money(row.markPx, 2)}</td><td className={tone(-finite(row.funding))}>{percent(row.funding, 4, false)}</td><td>{compact(row.dayNotionalVolume)}</td></tr>)}</tbody></table></div> : <EmptyState title="暂无市场快照" detail="行情回补时会同步保存 metaAndAssetCtxs。" />}</section></div>
  </div>;

  const headerActions = ({
    overview: <><button className="button ghost compact" onClick={() => setView('backtest')}>回测台</button><button className="button primary compact" onClick={hasData ? runOptimization : runBackfill}>{hasData ? '优化并回测' : '回补真实行情'}</button></>,
    factors: <><button className="button ghost compact" onClick={() => void loadFactors()}>刷新评分</button><button className="button primary compact" onClick={runResearch}>运行研究</button></>,
    research: <><button className="button ghost compact" onClick={() => setConfigOpen(true)}>参数</button><button className="button primary compact" onClick={runResearch}>运行研究</button></>,
    backtest: <><button className="button ghost compact" onClick={() => setConfigOpen(true)}>参数</button><button className="button ghost compact" onClick={runBacktest}>仅回测</button><button className="button primary compact" onClick={runOptimization}>优化并回测</button></>,
    paper: <><button className="button ghost compact" onClick={() => initializePaper(false)}>{paper.account ? '重置账户' : '初始化账户'}</button><button className="button primary compact" disabled={!paper.account} onClick={() => tickPaper(true)}>推进模拟盘</button></>,
    data: <><button className="button ghost compact" onClick={() => void loadBootstrap()}>刷新统计</button><button className="button primary compact" onClick={runBackfill}>回补行情</button></>
  } as Record<View, ReactElement>)[view];

  const page = ({ overview: overviewPage, factors: factorsPage, research: researchPage, backtest: backtestPage, paper: paperPage, data: dataPage } as Record<View, () => ReactElement>)[view]();

  return <>
    <Layout view={view} onView={setView} sidebarOpen={sidebarOpen} onSidebarOpen={setSidebarOpen} busy={Boolean(task)} activeTask={bootstrap.activeTask} counts={counts} notice={notice} actions={headerActions} onRefresh={() => void loadBootstrap()}>{page}</Layout>
    <ConfigDialog open={configOpen} config={config} defaults={bootstrap.config} onClose={() => setConfigOpen(false)} onSave={saveConfig} />
    {task && <div className="task-overlay"><div className="task-card"><div className="orbit"><span /><i /></div><small>HYPERNIGHT REACT ENGINE</small><strong>{task.title}</strong><p>{task.detail}</p></div></div>}
    {toast && <div className="toast-stack"><div className={`toast ${toast.type}`}>{toast.message}</div></div>}
  </>;
}
