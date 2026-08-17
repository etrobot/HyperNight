import { useEffect, useRef, useState, type FormEvent } from 'react';

import type { StrategyConfig } from '../types';
import { factorLabel } from './Primitives';

function cloneConfig(config: StrategyConfig): StrategyConfig {
  return { ...config, factorWeights: { ...config.factorWeights } };
}

interface ConfigDialogProps {
  open: boolean;
  config: StrategyConfig;
  defaults: StrategyConfig;
  onClose: () => void;
  onSave: (config: StrategyConfig) => string | null;
}

export function ConfigDialog({ open, config, defaults, onClose, onSave }: ConfigDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState(() => cloneConfig(config));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open) {
      setDraft(cloneConfig(config));
      setError(null);
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) dialog.close();
  }, [open, config]);

  const setString = (key: 'windowStartEt' | 'windowEndEt' | 'referenceMode', value: string) => setDraft((current) => ({ ...current, [key]: value } as StrategyConfig));
  const setNumber = (key: keyof StrategyConfig, value: string) => setDraft((current) => ({ ...current, [key]: Number(value) }));
  const setWeight = (key: keyof StrategyConfig['factorWeights'], value: string) => setDraft((current) => ({ ...current, factorWeights: { ...current.factorWeights, [key]: Number(value) } }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const message = onSave(draft);
    if (message) setError(message);
    else onClose();
  };

  const field = (name: keyof StrategyConfig, label: string, options: { step?: string; min?: number; max?: number } = {}) => <div className="field" key={name}>
    <label>{label}</label>
    <input type="number" value={String(draft[name])} step={options.step} min={options.min} max={options.max} onChange={(event) => setNumber(name, event.target.value)} />
  </div>;

  return <dialog ref={ref} className="config-dialog" onClose={onClose} onMouseDown={(event) => { if (event.target === ref.current) onClose(); }}>
    <form className="config-panel" onSubmit={submit}>
      <div className="dialog-head"><div><span className="kicker">STRATEGY CONFIG</span><h2>休市多因子参数</h2></div><button type="button" className="dialog-close" aria-label="关闭" onClick={onClose}>×</button></div>
      <div className="config-scroll">
        <section className="config-section"><h3>SESSION & SIGNAL</h3><div className="config-grid">
          <div className="field"><label>窗口开始（ET）</label><input type="time" value={draft.windowStartEt} onChange={(event) => setString('windowStartEt', event.target.value)} /></div>
          <div className="field"><label>窗口结束（ET）</label><input type="time" value={draft.windowEndEt} onChange={(event) => setString('windowEndEt', event.target.value)} /></div>
          <div className="field"><label>参照价</label><select value={draft.referenceMode} onChange={(event) => setString('referenceMode', event.target.value)}><option value="stock_close">正股收盘</option><option value="hl_session_close">HL 收盘</option></select></div>
          {field('entryDeviation', '开仓偏离', { step: '.001', min: 0, max: 1 })}
          {field('exitDeviation', '退出偏离', { step: '.001', min: 0, max: 1 })}
          {field('minScore', '最低综合分', { step: '.05', min: -100, max: 100 })}
        </div></section>
        <section className="config-section"><h3>FACTOR ENGINE</h3><div className="config-grid">
          {field('momentumBars', '动量窗口（bars）', { step: '1', min: 1 })}
          {field('volatilityBars', '波动窗口（bars）', { step: '1', min: 2 })}
          {field('liquidityBars', '流动性窗口（bars）', { step: '1', min: 1 })}
          {(Object.entries(draft.factorWeights) as Array<[keyof StrategyConfig['factorWeights'], number]>).map(([key, value]) => <div className="field" key={key}><label>{factorLabel(key)}权重</label><input type="number" value={value} step=".01" min="0" max="1" onChange={(event) => setWeight(key, event.target.value)} /></div>)}
        </div></section>
        <section className="config-section"><h3>PORTFOLIO & RISK</h3><div className="config-grid">
          {field('initialCapital', '初始资金', { step: '1000', min: 1 })}{field('maxPositions', '最大仓位数', { step: '1', min: 1 })}{field('grossNotionalPct', '毛名义倍数', { step: '.1', min: 0 })}
          {field('maxCoreNotional', '单仓核心名义', { step: '500', min: 1 })}{field('maxNotional', '单仓最大名义', { step: '500', min: 1 })}{field('takeProfit', '止盈比例', { step: '.001', min: 0 })}
          {field('stopLoss', '止损比例', { step: '.001', min: 0 })}{field('maxHoldBars', '最长持有（bars）', { step: '1', min: 1 })}{field('hedgeStep', '对冲触发步长', { step: '.001', min: 0 })}
          {field('hedgeFraction', '单次对冲比例', { step: '.05', min: 0, max: 1 })}{field('maxHedgeRatio', '最大对冲比例', { step: '.05', min: 0, max: 1 })}{field('feeRate', 'Taker 费率', { step: '.00001', min: 0, max: 1 })}
          {field('slippageBps', '滑点（bps）', { step: '.1', min: 0 })}{field('maxFunding', '最大 Funding', { step: '.0001', min: 0, max: 1 })}{field('minBarNotional', '最低 5m 名义量', { step: '1000', min: 0 })}
          {field('minExpectedEdge', '最低预期边际', { step: '.001', min: 0, max: 1 })}{field('referenceMismatchLimit', '参照错配上限', { step: '.001', min: 0, max: 1 })}{field('minSessionCoverage', '最低会话覆盖率', { step: '.05', min: 0, max: 1 })}
        </div></section>
        {error && <div className="config-error">{error}</div>}
      </div>
      <div className="dialog-actions"><button type="button" className="button ghost" onClick={() => { setDraft(cloneConfig(defaults)); setError(null); }}>恢复默认</button><button type="submit" className="button primary">应用参数</button></div>
    </form>
  </dialog>;
}
