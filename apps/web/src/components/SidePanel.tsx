// 右侧详细面板：六节、设备折叠偏好与定位请求；拖宽行为保持不变。
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { EventOf, IndependentTaskState, Task, TaskFile, TaskUsage } from '@aic/protocol';
import { setPref, usePref, type SideTab } from '../state/prefs';
import { api, useApp } from '../state/app';
import { Icon } from './Icon';
import { useAgentName, asApiError } from './ui';
import type { SessionCfg } from '../state/core';
import { useStore } from '../state/store';
import { detailFocus } from '../state/details';
import { contextValue, contextSummary, type DetailSection } from '../lib/details';
import { formatTokens } from '../lib/tokens';
import { EnvironmentDetails } from './details/environment';
import { PlanDetails } from './details/plan';
import { ContextDetails } from './details/context';
import { UsageDetails } from './details/usage';
import { ConnectionDetails } from './details/connection';
import { OutputDetails } from './details/output';

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
  const tab = usePref('sideTab'), opened = usePref('detailOpen');
  const project = useApp((s) => s.projects.find((p) => p.id === task.projectId));
  const agent = useApp((s) => s.agents.find((a) => a.kind === task.agent));
  const conn = useApp((s) => s.conn);
  const usageRevision = useApp((s) => s.logs[task.id]?.filter((e) => e.type === 'turn.usage').at(-1)?.seq);
  const fileRevision = useApp((s) => s.logs[task.id]?.filter((e) => e.type === 'tool.end').at(-1)?.seq);
  const independentRevision = useApp((s) => s.logs[task.id]?.filter((e) => e.type === 'independent.task_changed').at(-1)?.seq);
  const agentName = useAgentName(task.agent);
  const modelName = agent?.models.find((m) => m.id === config.model)?.name ?? config.models?.find((m) => m.id === config.model)?.name ?? config.model;
  const profileId = config.profileId ?? task.profileId ?? null;
  const profileName = (profileId ? agent?.profiles?.find((p) => p.id === profileId) : agent?.profiles?.find((p) => p.isDefault))?.name ?? null;
  const [usage, setUsage] = useState<TaskUsage | null>(null), [files, setFiles] = useState<TaskFile[] | null>(null);
  const [independent, setIndependent] = useState<IndependentTaskState | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null), [fileError, setFileError] = useState<string | null>(null), [independentError, setIndependentError] = useState<string | null>(null);
  useEffect(() => { let live = true; void api.taskUsage(task.id).then((v) => { if (live) { setUsage(v); setUsageError(null); } }).catch((e) => { if (live) setUsageError(asApiError(e).message); }); return () => { live = false; }; }, [task.id, usageRevision, conn]);
  useEffect(() => { let live = true; void api.taskFiles(task.id).then((v) => { if (live) { setFiles(v); setFileError(null); } }).catch((e) => { if (live) setFileError(asApiError(e).message); }); return () => { live = false; }; }, [task.id, fileRevision, independentRevision, conn]);
  useEffect(() => { if (task.agent !== 'independent') return; let live = true; void api.independentTask(task.id).then((v) => { if (live) { setIndependent(v); setIndependentError(null); } }).catch((e) => { if (live) setIndependentError(asApiError(e).message); }); return () => { live = false; }; }, [task.id, task.agent, task.status, independentRevision, conn]);
  const focus = useStore(detailFocus, (s) => s);
  useEffect(() => { if (!focus || tab !== 'plan') return; const el = document.getElementById('detail-' + focus.section); if (el) { el.scrollIntoView({ block: 'nearest' }); el.focus({ preventScroll: true }); detailFocus.set(() => null); } }, [focus, tab]);
  const value = contextValue(config.usage, independent?.context);
  const sections: Array<{ key: DetailSection; title: string; summary: string; body: ReactNode }> = [
    { key: 'environment', title: '环境', summary: project?.name ?? '未报告', body: <EnvironmentDetails project={project} task={task} profileName={profileName} /> },
    { key: 'plan', title: '计划', summary: plan ? `${plan.data.items.filter((x) => x.status === 'completed').length} / ${plan.data.items.length}` : '未报告', body: <PlanDetails plan={plan} /> },
    { key: 'context', title: '上下文', summary: contextSummary(value, agentName, modelName), body: <><ContextDetails value={value} agent={agentName} model={modelName} config={config} />{independentError ? <p className="d-note" role="alert">{independentError}</p> : null}</> },
    { key: 'usage', title: '会话 token 用量', summary: usage ? `${formatTokens(usage.total.totalTokens)} · ${usage.turns} 轮` : usageError ? '读取失败' : '正在读取', body: <UsageDetails usage={usage} independent={independent} config={config} error={usageError} /> },
    { key: 'connection', title: '连接', summary: '未报告', body: <ConnectionDetails agent={agent} /> },
    { key: 'output', title: '输出', summary: files ? `${files.length} 个文件` : fileError ? '读取失败' : '正在读取', body: <OutputDetails files={files} error={fileError} /> },
  ];
  const tabs: Array<[SideTab, string]> = [['plan', '详细'], ['diff', '改动']];
  return <aside className="side" aria-label="详细面板"><div className="side-head">
    <div className="tabs" role="tablist" aria-label="详细面板" onKeyDown={(e) => { if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return; e.preventDefault(); const next = tab === 'plan' ? 'diff' : 'plan'; setPref('sideTab', next); document.getElementById('st-' + next)?.focus(); }}>
      {tabs.map(([key, title]) => <button key={key} type="button" role="tab" id={'st-' + key} aria-controls={'sp-' + key} aria-selected={tab === key} tabIndex={tab === key ? 0 : -1} onClick={() => setPref('sideTab', key)}>{title}</button>)}
    </div><span className="grow" /><button type="button" className="btn ghost icon sm" aria-label="收起右侧面板" title="收起 Ctrl+J" onClick={() => setPref('sideOpen', false)}><Icon name="x" /></button>
  </div><div className="side-body pane-pad" id="sp-plan" role="tabpanel" aria-labelledby="st-plan" hidden={tab !== 'plan'}>
    {sections.map((section) => { const open = opened.includes(section.key); return <section key={section.key} id={'detail-' + section.key} className={'d-section' + (open ? ' open' : '')} tabIndex={-1} aria-label={section.title}>
      <h3><button type="button" className="d-toggle" aria-expanded={open} aria-controls={'detail-body-' + section.key} onClick={() => setPref('detailOpen', open ? opened.filter((x) => x !== section.key) : [...opened, section.key])}><Icon name="right" /><span>{section.title}</span><span className="sub" title={section.summary}>{section.summary}</span></button></h3>
      <div className="d-body" id={'detail-body-' + section.key} hidden={!open}>{section.body}</div>
    </section>; })}
  </div><div className="side-body" id="sp-diff" role="tabpanel" aria-labelledby="st-diff" hidden={tab !== 'diff'}><div className="empty"><h3>改动面板</h3><p>之后的版本提供。</p></div></div></aside>;
}
