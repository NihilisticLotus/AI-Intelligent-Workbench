// 对话流：用户消息、Agent 消息（含思考过程）、工具调用、计划、审批卡片、系统提示。
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ApiError, Approval, Task } from '@aic/protocol';
import type { PlanEntry, ResolvedInfo, TimelineItem, ToolItem } from '../state/core';
import { approve, loadDevices, useApp } from '../state/app';
import { usePref } from '../state/prefs';
import { useStore } from '../state/store';
import { clock, durationText, permInfo, toolVerb } from '../lib/format';
import { modelSwitchKind, switchKindText, withDefaultActions } from '../lib/agents';
import { AgentBadge, ErrorNotice, actionNeedsIdle, toastErrorOf, useAgentName } from './ui';
import { Icon } from './Icon';
import { useNow } from './hooks';
import { focusApprovalStore } from './focus';

const busyStatuses = new Set<Task['status']>(['running', 'waiting', 'queued']);

/**
 * 任务里的错误：统一格式，actions 渲染成按钮（重新登录、继续、换模型……）；Gateway 没给按钮时按错误码补上默认的。
 * stale：后面已经有新的消息了，会发消息的按钮（继续、再试一次）不再显示，免得点了旧错误重复发送
 */
export function TaskError({ error, task, compact, stale }: { error: ApiError; task: Task; compact?: boolean; stale?: boolean }) {
  let e = withDefaultActions(error, { taskId: task.id, kind: task.agent });
  if (stale) e = { ...e, actions: e.actions.filter((a) => !actionNeedsIdle(a.action)) };
  return <ErrorNotice error={e} compact={compact} ctx={{ taskId: task.id, kind: task.agent, busy: busyStatuses.has(task.status) }} />;
}

export function Stream({ task, items, loading, onOpenPlan }: { task: Task; items: TimelineItem[]; loading: boolean; onOpenPlan: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  /** 最后一条用户消息的位置：它之后的错误才是“当前的” */
  const lastUserIdx = useMemo(() => { for (let i = items.length - 1; i >= 0; i--) if (items[i]!.kind === 'user') return i; return -1; }, [items]);
  // 用户在底部附近时，新内容到来自动滚到底；往上翻看时不打扰
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items]);
  useEffect(() => { stick.current = true; }, [task.id]);

  // 用户主动跳转到某个审批时聚焦它（新审批到来不抢焦点）
  const focusReq = useStore(focusApprovalStore, (s) => s);
  useEffect(() => {
    if (!focusReq) return;
    const el = document.getElementById('ap-' + focusReq.id);
    if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.focus({ preventScroll: true }); focusApprovalStore.set(() => null); }
  }, [focusReq, items]);

  return (
    <div className="stream" ref={ref} tabIndex={0} aria-label="对话记录"
      onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
      <div className="stream-inner">
        {!items.length ? (
          <div className="empty stream-empty">{loading ? <p>正在载入对话…</p> : <><h3>还没有消息</h3><p>在下面的输入框里告诉 Agent 要做什么。</p></>}</div>
        ) : items.map((it, i) => <Item key={it.key} it={it} task={task} onOpenPlan={onOpenPlan} live={i > lastUserIdx} />)}
      </div>
    </div>
  );
}

function Item({ it, task, onOpenPlan, live }: { it: TimelineItem; task: Task; onOpenPlan: () => void; live: boolean }) {
  switch (it.kind) {
    case 'user': return <UserMsg text={it.text} ts={it.ts} />;
    case 'agent': return <AgentMsg it={it} fallbackAgent={task.agent} />;
    case 'tools': return <div className="tools-group">{it.tools.map((t) => <ToolRow key={t.id} t={t} />)}</div>;
    case 'plan': return <PlanInline items={it.items} onOpen={onOpenPlan} />;
    case 'approval': return <ApprovalCard approval={it.approval} resolvedInLog={it.resolved} task={task} />;
    case 'note': return <div className={'sysnote' + (it.level === 'warn' ? ' warn' : '')} role="note"><span>{it.level === 'warn' ? <Icon name="warn" size={13} /> : null}{it.text}</span></div>;
    case 'config': return <ConfigNote it={it} fallbackAgent={task.agent} />;
    case 'error': return <div className="stream-alert"><TaskError error={it.error} task={task} stale={!live} /></div>;
  }
}

function ConfigNote({ it, fallbackAgent }: { it: Extract<TimelineItem, { kind: 'config' }>; fallbackAgent: string }) {
  const kind = it.agent ?? fallbackAgent;
  const modelName = useApp((s) => s.agents.find((a) => a.kind === kind)?.models.find((m) => m.id === it.model)?.name) ?? it.model;
  const caps = useApp((s) => s.agents.find((a) => a.kind === kind)?.caps);
  const parts = [modelName ? `模型 ${modelName}` : null, it.effort ? `思考强度 ${it.effort}` : null].filter(Boolean);
  // 只换思考强度总是会话内完成；换模型按 Agent 的能力：会话内切换或恢复会话
  const how = it.model ? switchKindText[modelSwitchKind(caps)] : switchKindText.in_session;
  return <div className="sysnote" role="note"><span>已切换为{parts.join('，')}（{how.replace('（', '，').replace('）', '')}），从下一条消息生效</span></div>;
}

function UserMsg({ text, ts }: { text: string; ts: number }) {
  return (
    <article className="msg user" aria-label="你的消息">
      <div className="who"><span className="me" aria-hidden="true">你</span></div>
      <div>
        <div className="head"><b>你</b><span>{clock(ts)}</span></div>
        <div className="text"><RichText text={text} /></div>
      </div>
    </article>
  );
}

function AgentMsg({ it, fallbackAgent }: { it: Extract<TimelineItem, { kind: 'agent' }>; fallbackAgent: string }) {
  const kind = it.agent ?? fallbackAgent;
  const name = useAgentName(kind);
  // 事件里是模型 id，显示时换成 /agents 给的名称
  const modelName = useApp((s) => s.agents.find((a) => a.kind === kind)?.models.find((m) => m.id === it.model)?.name) ?? it.model;
  return (
    // 同一轮回复的后续片段不再重复头像和名称：整轮看起来是一条回复（用户报告：分段显示和常见 Agent 软件差别太大）
    <article className={'msg' + (it.cont ? ' cont' : '')} aria-label={it.cont ? `${name} 的回复（续）` : `${name} 的消息`}>
      <div className="who">{it.cont ? null : <AgentBadge kind={kind} />}</div>
      <div>
        {it.cont ? null : <div className="head"><b>{name}</b>{modelName ? <span>{modelName}</span> : null}<span>{clock(it.ts)}</span></div>}
        {it.thought ? <Thought it={it} /> : null}
        <div className="text">
          {it.text ? <RichText text={it.text} /> : null}
          {!it.done && !it.thought && !it.text ? <p className="thinking" aria-label="正在生成">正在回复</p> : null}
          {!it.done && it.text ? <span className="thinking" aria-hidden="true" /> : null}
        </div>
      </div>
    </article>
  );
}

/** 思考过程：思考时实时显示“正在思考…”；结束后按设置默认折叠成“思考了 N 秒”。箭头朝右为折叠、朝下为展开 */
function Thought({ it }: { it: Extract<TimelineItem, { kind: 'agent' }> }) {
  const mode = usePref('thought');
  const thinking = !it.done && !it.text;
  const [open, setOpen] = useState<boolean | null>(null);
  if (mode === 'hidden') return null;
  const isOpen = open ?? (thinking || mode === 'expanded');
  const secs = it.thoughtStart !== null && it.thoughtEnd !== null ? durationText(Math.max(1000, it.thoughtEnd - it.thoughtStart)) : null;
  return (
    <details className="thought" open={isOpen}
      onToggle={(e) => { const o = (e.currentTarget as HTMLDetailsElement).open; if (o !== isOpen) setOpen(o); }}>
      <summary aria-label={(thinking ? '正在思考' : `思考了 ${secs ?? '一会儿'}`) + (isOpen ? '，点击折叠' : '，点击展开')}>
        <Icon name="bulb" />{thinking ? <span className="thinking">正在思考</span> : <span>思考了 {secs ?? '一会儿'}</span>}<Icon name="right" />
      </summary>
      <div className="thought-body"><RichText text={it.thought} /></div>
    </details>
  );
}

function ToolRow({ t }: { t: ToolItem }) {
  const verb = toolVerb[t.kind] ?? '操作';
  const failed = t.state === 'failed';
  // 用户拒绝的不是故障：中性颜色、不自动展开
  const rejected = t.state === 'rejected';
  const [all, setAll] = useState(false);
  const lines = t.output ? t.output.replace(/\n$/, '').split('\n') : [];
  const shown = all ? lines : lines.slice(-200);
  const hasDetail = lines.length > 0 || !!t.summary;
  const dur = t.endTs ? durationText(t.endTs - t.startTs) : null;
  return (
    <details className={'tool' + (failed ? ' failed' : '') + (rejected ? ' rejected' : '')} open={failed ? true : undefined}>
      <summary>
        <Icon name="right" className="chev" />
        <span className="verb">{failed ? `${verb}失败` : rejected ? '未执行（已拒绝）' : verb}</span>
        <span className="target" title={t.target ?? t.title}>{t.target ?? t.title}</span>
        <span className="end">
          {t.state === 'running' ? <span className="running">进行中…</span> : null}
          {t.state === 'ok' ? <span>{t.summary ?? '完成'}{dur && t.kind === 'execute' ? ` · ${dur}` : ''}</span> : null}
          {failed ? <span className="stat-del">{t.summary ?? '失败'}</span> : null}
          {rejected ? <span>{t.summary ?? '已拒绝'}</span> : null}
        </span>
      </summary>
      <div className="detail">
        {t.title && t.target ? <div className="out-head">{t.title}</div> : null}
        {hasDetail ? (
          <>
            {lines.length ? <pre>{shown.join('\n')}</pre> : <pre>{t.summary}</pre>}
            {lines.length > 200 ? (
              <div className="foot">{all ? `共 ${lines.length} 行` : `显示最后 200 行，共 ${lines.length} 行`}<span className="grow" />
                <button type="button" className="btn sm ghost" onClick={() => setAll(!all)}>{all ? '只看最后 200 行' : '展开全部'}</button>
              </div>
            ) : null}
          </>
        ) : <pre>{t.state === 'running' ? '还在进行…' : '没有输出'}</pre>}
      </div>
    </details>
  );
}

export function PlanList({ items }: { items: PlanEntry[] }) {
  return (
    <ol className="plan" aria-label="Agent 计划">
      {items.map((p, i) => (
        <li key={i} className={p.status === 'completed' ? 'done' : p.status === 'in_progress' ? 'now' : undefined}>
          <span className="mk" aria-hidden="true">{p.status === 'completed' ? <Icon name="check" /> : null}</span>
          <span>{p.text}<span className="sr-only">{p.status === 'completed' ? '（已完成）' : p.status === 'in_progress' ? '（进行中）' : '（未开始）'}</span></span>
        </li>
      ))}
    </ol>
  );
}

function PlanInline({ items, onOpen }: { items: PlanEntry[]; onOpen: () => void }) {
  const done = items.filter((x) => x.status === 'completed').length;
  return (
    <div className="stream-plan" role="group" aria-label="计划">
      <div className="ph"><span>计划 · 已完成 {done}/{items.length}</span><span className="grow" />
        <button type="button" className="btn sm ghost" onClick={onOpen}>在右侧查看</button></div>
      <PlanList items={items} />
    </div>
  );
}

// ---------------------------------------------------------------------
// 审批卡片（ui-design.md 6.3）：不抢焦点；卡片聚焦时 Enter 允许、Esc 打开拒绝理由
// ---------------------------------------------------------------------
function ApprovalCard({ approval, resolvedInLog, task }: { approval: Approval; resolvedInLog: ResolvedInfo | null; task: Task }) {
  const live = useApp((s) => s.approvals[approval.id]);
  const hello = useApp((s) => s.hello);
  const devices = useApp((s) => s.devices);
  const conn = useApp((s) => s.conn);
  const agentName = useAgentName(task.agent);
  const now = useNow(30_000);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const cardRef = useRef<HTMLElement>(null);
  const reasonRef = useRef<HTMLInputElement>(null);

  const status = live?.status ?? resolvedInLog?.status ?? approval.status;
  const decidedBy = live?.decidedBy ?? resolvedInLog?.decidedBy ?? null;
  const decidedByName = live?.decidedByName ?? resolvedInLog?.decidedByName ?? null;
  const allowOnce = approval.options.find((o) => o.kind === 'allow_once');
  // “总是允许 / 总是拒绝”要配合规则功能（预览将生成的规则、只作用于这一类）才有意义，规则在后续步骤提供：
  // 1.1 不显示这两类按钮，免得用户以为已经放行了同类操作
  // 拒绝是安全的方向：Agent 只给了“总是拒绝”时也用它作为拒绝按钮（1.1 按拒绝一次处理）
  const rejectOnce = approval.options.find((o) => o.kind === 'reject_once') ?? approval.options.find((o) => o.kind === 'reject_always');
  const extraOptions = approval.options.filter((o) => o !== allowOnce && o !== rejectOnce && o.kind !== 'allow_always' && o.kind !== 'reject_always');
  const online = conn === 'online' || conn === 'replaying';
  const otherDevice = status !== 'pending' && !!decidedBy && decidedBy !== hello?.device.id;

  // 旧的事件里没有设备名：需要时懒加载一次设备列表
  useEffect(() => {
    if (otherDevice && !decidedByName && devices === null) loadDevices().catch(() => { /* 退回“另一台设备” */ });
  }, [otherDevice, decidedByName, devices]);

  const decide = async (optionId: string, withNote?: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await approve(approval.id, optionId, withNote?.trim() || undefined);
      setRejecting(false);
    } catch (e) {
      toastErrorOf(e);
    } finally {
      setBusy(false);
    }
  };
  const openReject = () => { setRejecting(true); setTimeout(() => reasonRef.current?.focus(), 0); };
  const closeReject = () => { setRejecting(false); cardRef.current?.focus(); };

  if (status !== 'pending') {
    const who = !decidedBy ? null : decidedBy === hello?.device.id ? '这台设备' : decidedByName ?? devices?.find((d) => d.id === decidedBy)?.name ?? '另一台设备';
    const text = status === 'allowed' ? '已允许' : status === 'rejected' ? '已拒绝' : '已过期，任务已暂停';
    return (
      <section className={'approval resolved' + (status === 'allowed' ? '' : ' denied')} aria-label={`审批：${approval.title}，${text}`}>
        <div className="ah"><Icon name={status === 'allowed' ? 'check' : 'x'} /><span>{text}：{approval.title}</span>
          {who ? <span className="meta">由 {who} 处理</span> : null}</div>
      </section>
    );
  }

  const waited = Math.max(0, Math.round((now - approval.createdAt) / 60000));
  const left = approval.expiresAt ? Math.max(0, Math.round((approval.expiresAt - now) / 60000)) : null;
  return (
    <section ref={cardRef} className="approval" id={'ap-' + approval.id} tabIndex={0} aria-labelledby={'ap-t-' + approval.id}
      aria-describedby={'ap-k-' + approval.id}
      onKeyDown={(e) => {
        if (e.target !== cardRef.current || busy || !online) return;
        if (e.key === 'Enter' && allowOnce) { e.preventDefault(); void decide(allowOnce.id); }
        if (e.key === 'Escape' && rejectOnce) { e.preventDefault(); e.stopPropagation(); openReject(); }
      }}>
      <div className="ah"><Icon name="shield" /><span id={'ap-t-' + approval.id}>{approval.title}</span>
        <span className="meta">{waited < 1 ? '刚刚' : `已等待 ${waited} 分钟`}{left !== null ? `，${left} 分钟后自动暂停` : ''}</span></div>
      <span className="sr-only" id={'ap-k-' + approval.id}>卡片获得焦点时按 Enter 允许，按 Esc 拒绝并填写理由</span>
      {approval.reason ? <p className="why">{approval.reason}</p> : null}
      <pre className="mono">{approval.detail}</pre>
      <dl className="facts">
        {approval.cwd ? <><dt>运行位置</dt><dd className="mono" style={{ fontSize: 12 }}>{approval.cwd}</dd></> : null}
        <dt>为什么要审批</dt><dd>当前权限级别为“{permInfo[task.permission].label}”：{permInfo[task.permission].desc}</dd>
        <dt>Agent</dt><dd>{agentName}</dd>
      </dl>
      <div className="acts">
        {allowOnce ? <button type="button" className="btn attn" disabled={busy || !online} onClick={() => void decide(allowOnce.id)}>{allowOnce.label || '允许'} <kbd>Enter</kbd></button> : null}
        {extraOptions.map((o) => (
          <button key={o.id} type="button" className={'btn' + (o.kind.startsWith('reject') ? ' danger' : '')} disabled={busy || !online} onClick={() => void decide(o.id)}>{o.label}</button>
        ))}
        <span className="grow" />
        {rejectOnce ? <button type="button" className="btn danger" disabled={busy || !online} aria-expanded={rejecting} onClick={openReject}>{(rejectOnce.label || '拒绝').replace(/…$/, '')}… <kbd>Esc</kbd></button> : null}
      </div>
      {!online ? <p className="why" role="status" style={{ marginBottom: 0 }}>连接恢复后才能处理审批。</p> : null}
      {rejecting && rejectOnce ? (
        <div className="reject-reason">
          <label htmlFor={'rr-' + approval.id} className="sr-only">拒绝理由</label>
          <input ref={reasonRef} id={'rr-' + approval.id} className="input" value={note} maxLength={2000}
            placeholder="告诉 Agent 为什么拒绝、应该怎么做（可选），例如：先只跑存档相关的测试"
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void decide(rejectOnce.id, note); }
              if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeReject(); }
            }} />
          <button type="button" className="btn sm" onClick={closeReject}>取消</button>
          <button type="button" className="btn sm danger" disabled={busy || !online} onClick={() => void decide(rejectOnce.id, note)}>确认拒绝</button>
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------
// 文本渲染：段落、``` 代码块、`行内代码`。不使用 innerHTML，Agent 输出不会被当成 HTML 执行
// ---------------------------------------------------------------------
export function RichText({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const parts = text.split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const nl = part.indexOf('\n');
      const lang = nl > 0 ? part.slice(0, nl).trim() : '';
      const code = nl >= 0 && /^[\w+-]*$/.test(lang) ? part.slice(nl + 1) : part;
      blocks.push(<pre key={i} aria-label={lang ? `${lang} 代码` : '代码'}><code>{code.replace(/\n$/, '')}</code></pre>);
      return;
    }
    part.split(/\n{2,}/).forEach((para, j) => {
      if (!para.trim()) return;
      blocks.push(<p key={`${i}-${j}`}>{inline(para)}</p>);
    });
  });
  return <>{blocks}</>;
}
function inline(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  s.split(/(`[^`\n]+`)/).forEach((seg, i) => {
    if (seg.startsWith('`') && seg.endsWith('`') && seg.length > 2) out.push(<code key={i}>{seg.slice(1, -1)}</code>);
    else seg.split('\n').forEach((line, j, arr) => { out.push(<Fragment key={`${i}-${j}`}>{line}</Fragment>); if (j < arr.length - 1) out.push(<br key={`${i}-${j}-br`} />); });
  });
  return out;
}

