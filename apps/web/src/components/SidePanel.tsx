// 右侧面板：可拖动宽度（拖动条可用方向键）、可收起（Ctrl+J）；标签“计划”和“改动”。
import { useRef } from 'react';
import type { EventOf, Task } from '@aic/protocol';
import { setPref, usePref, type SideTab } from '../state/prefs';
import { permInfo } from '../lib/format';
import { useApp } from '../state/app';
import { PlanList } from './Chat';
import { Icon } from './Icon';
import { useAgentName } from './ui';
import type { SessionCfg } from '../state/core';
import { isRealAgent } from '../lib/agents';
import { effortLabel } from '../lib/picker';

const MIN_W = 320;
const maxW = () => Math.round(window.innerWidth * 0.62);
const clampW = (v: number) => Math.round(Math.max(MIN_W, Math.min(v, maxW())));

export function Resizer() {
  const width = usePref('sideWidth');
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref} className="resizer" role="separator" aria-orientation="vertical" aria-label="调整右侧面板宽度"
      aria-valuenow={width} aria-valuemin={MIN_W} aria-valuemax={typeof window === 'undefined' ? 1200 : maxW()} tabIndex={0}
      onPointerDown={(e) => {
        const el = ref.current!;
        el.setPointerCapture(e.pointerId);
        el.classList.add('dragging');
        const move = (ev: PointerEvent) => setPref('sideWidth', clampW(window.innerWidth - ev.clientX));
        const up = () => { el.classList.remove('dragging'); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
      }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') { e.preventDefault(); setPref('sideWidth', clampW(width + 24)); }
        if (e.key === 'ArrowRight') { e.preventDefault(); setPref('sideWidth', clampW(width - 24)); }
      }} />
  );
}

export function SidePanel({ task, plan, config }: { task: Task; plan: EventOf<'plan.update'> | null; config: SessionCfg }) {
  const tab = usePref('sideTab');
  const project = useApp((s) => s.projects.find((p) => p.id === task.projectId));
  const agentName = useAgentName(task.agent);
  const modelName = useApp((s) => s.agents.find((a) => a.kind === task.agent)?.models.find((m) => m.id === config.model)?.name) ?? config.models?.find((m) => m.id === config.model)?.name ?? config.model;
  const profileId = config.profileId ?? task.profileId ?? null;
  const profileName = useApp((s) => {
    const list = s.agents.find((a) => a.kind === task.agent)?.profiles;
    return (profileId ? list?.find((p) => p.id === profileId) : list?.find((p) => p.isDefault))?.name ?? null;
  });
  const tabs: Array<[SideTab, string]> = [['plan', '计划'], ['diff', '改动']];
  const select = (t: SideTab) => setPref('sideTab', t);
  return (
    <aside className="side" aria-label="上下文面板">
      <div className="side-head">
        <div className="tabs" role="tablist" aria-label="上下文面板"
          onKeyDown={(e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            const i = tabs.findIndex(([k]) => k === tab);
            const n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]![0];
            select(n);
            document.getElementById('st-' + n)?.focus();
          }}>
          {tabs.map(([k, label]) => (
            <button key={k} type="button" role="tab" id={'st-' + k} aria-controls={'sp-' + k} aria-selected={tab === k}
              tabIndex={tab === k ? 0 : -1} onClick={() => select(k)}>
              {label}{k === 'plan' && plan ? <span className="count">{plan.data.items.filter((x) => x.status === 'completed').length}/{plan.data.items.length}</span> : null}
            </button>
          ))}
        </div>
        <span className="grow" />
        <button type="button" className="btn ghost icon sm" aria-label="收起右侧面板" title="收起 Ctrl+J" onClick={() => setPref('sideOpen', false)}><Icon name="x" /></button>
      </div>

      <div className="side-body pane-pad" id="sp-plan" role="tabpanel" aria-labelledby="st-plan" hidden={tab !== 'plan'}>
        {plan ? <PlanList items={plan.data.items} /> : (
          <div className="empty" style={{ padding: 'var(--sp-5) 0' }}><h3>还没有计划</h3><p>Agent 给出步骤计划后会显示在这里，并随进度更新。</p></div>
        )}
        <h3 className="side-h3">上下文</h3>
        <dl className="ctx">
          <dt>项目</dt><dd title={project?.path}>{project?.name ?? '—'}</dd>
          <dt>Agent</dt><dd>{agentName}</dd>
          <dt>模型</dt><dd>{modelName ?? '默认'}{config.effort ? `，思考强度 ${effortLabel(config.effort)}` : ''}</dd>
          {profileName ? <><dt>账号</dt><dd>{profileName}</dd></> : null}
          {config.usage && config.usage.size > 0 ? (
            <><dt>上下文</dt><dd>已用 {Math.round((config.usage.used / config.usage.size) * 100)}%（{fmtTokens(config.usage.used)} / {fmtTokens(config.usage.size)}）
              {config.usage.cost ? `，花费 ${config.usage.cost.amount.toFixed(2)} ${config.usage.cost.currency}` : ''}</dd></>
          ) : null}
          <dt>权限</dt><dd>{permInfo[task.permission].label}</dd>
          <dt>工作区</dt><dd>{isRealAgent(task.agent) ? '直接在项目目录里修改；独立工作副本将在后续版本提供' : '独立工作副本将在后续版本提供'}</dd>
        </dl>
      </div>

      <div className="side-body" id="sp-diff" role="tabpanel" aria-labelledby="st-diff" hidden={tab !== 'diff'}>
        <div className="empty"><h3>改动面板在有了独立工作副本后提供</h3><p>那时 Agent 的每处修改都会先进这里，看完 diff 再决定合并、丢弃或回滚。</p></div>
      </div>
    </aside>
  );
}

/** 上下文用量：1234 → 1.2k，1234567 → 1.2M */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(Math.round(n));
}
