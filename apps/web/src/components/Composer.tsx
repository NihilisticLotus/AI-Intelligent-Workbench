// 输入区：待审批条 + 输入框 + 工具条（附件、[Agent · 模型 · 思考强度] 切换器、权限级别、发送 / 停止）。
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Approval, PermissionLevel, Task } from '@aic/protocol';
import { cancelTask, patchTask, sendPrompt, switchConfig, useApp } from '../state/app';
import { toast } from '../state/ui';
import { permInfo, permOrder } from '../lib/format';
import { AgentBadge, confirmDialog, openMenu, toastErrorOf, useAgentName } from './ui';
import { Icon } from './Icon';
import { useDismiss } from './hooks';
import { requestFocusApproval } from './focus';

/** 每个任务的草稿：切换任务时保留没发出去的内容（父组件按任务 id 重新挂载本组件） */
const drafts = new Map<string, string>();

const busyStatuses = new Set<Task['status']>(['running', 'waiting', 'queued']);

export function Composer({ task, pending, config }: { task: Task; pending: Approval[]; config: { model: string | null; effort: string | null } }) {
  const conn = useApp((s) => s.conn);
  const online = conn === 'online' || conn === 'replaying';
  const [text, setText] = useState(() => drafts.get(task.id) ?? '');
  const [sending, setSending] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { drafts.set(task.id, text); }, [task.id, text]);

  const working = busyStatuses.has(task.status);
  const canSend = online && !working && !sending && text.trim().length > 0;

  const send = async () => {
    if (!canSend) return;
    const body = text.trim();
    setSending(true);
    try {
      await sendPrompt(task.id, body);
      setText('');
      drafts.delete(task.id);
    } catch (e) {
      toastErrorOf(e); // 发送失败时保留输入内容
    } finally {
      setSending(false);
      ta.current?.focus();
    }
  };
  const stop = async () => {
    try { await cancelTask(task.id); toast('已请求停止，Agent 会在当前步骤结束后停下'); } catch (e) { toastErrorOf(e); }
  };

  const placeholder = !online ? '正在重新连接，恢复后可以继续发送'
    : task.status === 'waiting' ? '有审批等你处理，处理后 Agent 会继续'
    : working ? 'Agent 正在工作，完成后可以继续对话；需要时可以点“停止”'
    : '继续对话，或补充要求。Enter 发送，Shift+Enter 换行';

  return (
    <div className="composer">
      <div className="composer-inner">
        {!online ? (
          <div className="offline-note" role="status"><Icon name="refresh" />和服务的连接断开了，正在重新连接…恢复后会自动补齐对话。</div>
        ) : null}
        {pending.length ? (
          <div className="pending-strip" role="status">
            <Icon name="shield" />
            <span>有 {pending.length} 项审批等你处理：{pending[0]!.title}</span>
            <span className="grow" />
            <button type="button" className="btn sm ghost" onClick={() => requestFocusApproval(pending[0]!.id)}>跳到审批</button>
          </div>
        ) : null}
        <div className="compose-box">
          <label htmlFor="prompt" className="sr-only">给 Agent 发消息</label>
          <textarea id="prompt" ref={ta} value={text} placeholder={placeholder} maxLength={100_000}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // 输入法组字时的回车不算发送
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
            }} />
          <div className="compose-bar">
            <button type="button" className="btn ghost icon sm" aria-label="添加附件（第 1.3 步提供）" title="添加附件：第 1.3 步提供" disabled><Icon name="clip" /></button>
            <Switcher task={task} config={config} online={online} />
            <span className="grow" />
            <PermChip task={task} online={online} />
            {working ? (
              <button type="button" className="btn" style={{ order: 7 }} onClick={stop} disabled={!online} aria-label="停止 Agent"><Icon name="stop" />停止</button>
            ) : null}
            <button type="button" className="btn primary" aria-label="发送" disabled={!canSend} aria-busy={sending} onClick={send}><Icon name="send" />发送</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// [Agent · 模型 · 思考强度] 切换器（ui-design.md 6.5）
// ---------------------------------------------------------------------
function Switcher({ task, config, online }: { task: Task; config: { model: string | null; effort: string | null }; online: boolean }) {
  const agents = useApp((s) => s.agents);
  const info = agents.find((a) => a.kind === task.agent);
  const agentName = useAgentName(task.agent);
  const [open, setOpen] = useState(false);
  const pop = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const close = useMemo(() => () => setOpen(false), []);
  useDismiss(open, pop, close, anchor);
  useEffect(() => { if (open) pop.current?.querySelector<HTMLElement>('[aria-selected="true"], button:not([disabled])')?.focus(); }, [open]);

  const modelName = info?.models.find((m) => m.id === config.model)?.name ?? config.model ?? '默认模型';
  const doSwitch = async (patch: { model?: string; effort?: string }) => {
    try {
      await switchConfig(task.id, patch);
      toast(patch.model ? `已切换模型，从下一条消息生效` : `已调整思考强度，从下一条消息生效`);
    } catch (e) { toastErrorOf(e); }
  };

  return (
    <div style={{ position: 'relative' }}>
      <div className="switcher" role="group" aria-label="当前 Agent、模型与思考强度" ref={anchor}>
        <button type="button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)} aria-label={`切换 Agent，当前 ${agentName}`}>
          <AgentBadge kind={task.agent} size="sm" />{agentName}<Icon name="down" />
        </button>
        <button type="button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}
          aria-label={`切换模型和思考强度，当前 ${modelName}${config.effort ? '，思考强度' + config.effort : ''}`}>
          {modelName}{config.effort ? <span className="muted">· {config.effort}</span> : null}<Icon name="down" />
        </button>
      </div>
      {open ? (
        <div className="popover switch-pop" ref={pop} role="dialog" aria-label="切换 Agent、模型与思考强度">
          <div className="group-label">Agent</div>
          {agents.map((a) => {
            const cur = a.kind === task.agent;
            return (
              <button key={a.kind} type="button" className="opt" aria-selected={cur} aria-disabled={!cur} disabled={!cur}
                title={cur ? undefined : '换 Agent 需要交接，第 1.4 步提供'}>
                <AgentBadge kind={a.kind} />{a.displayName}<span className="meta">{cur ? '当前' : '交接：第 1.4 步提供'}</span>
              </button>
            );
          })}
          <div className="group-label">模型</div>
          {info?.models.length ? info.models.map((m) => {
            const cur = m.id === config.model;
            return (
              <button key={m.id} type="button" className="opt" aria-selected={cur} disabled={!online}
                onClick={() => { if (!cur) void doSwitch({ model: m.id }); setOpen(false); }}>
                {m.name}<span className="meta">{cur ? '当前' : '会话内切换（无损）'}</span>
              </button>
            );
          }) : <div className="opt" aria-disabled="true">这个 Agent 没有可选的模型</div>}
          <div className="group-label" id="eff-l">思考强度</div>
          {info?.efforts?.length ? (
            <div className="seg" role="radiogroup" aria-labelledby="eff-l">
              {info.efforts.map((x) => (
                <button key={x} type="button" role="radio" aria-checked={x === config.effort} disabled={!online}
                  onClick={() => { if (x !== config.effort) void doSwitch({ effort: x }); }}>{x}</button>
              ))}
            </div>
          ) : <div className="opt" aria-disabled="true">思考强度由模型自己决定</div>}
          <div className="hint">换模型和思考强度保留完整上下文，从下一条消息生效。换到其他 Agent 会走交接，第 1.4 步提供。</div>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------
// 权限级别：只读=眼睛、需审批=盾牌、工作区内自动=带勾的盾牌、全自动=打开的锁（琥珀色，二次确认）
// ---------------------------------------------------------------------
function PermChip({ task, online }: { task: Task; online: boolean }) {
  const info = permInfo[task.permission];
  const set = async (p: PermissionLevel) => {
    if (p === task.permission) return;
    if (p === 'full') {
      const ok = await confirmDialog({
        title: '开启全自动？', ok: '开启全自动', danger: true,
        body: <><p>除了“始终禁止”清单里的操作（例如删除工作区外的文件），Agent 的所有操作都不再询问你。</p><p style={{ margin: 0 }}>建议只在可以随时丢弃的任务上使用。</p></>,
      });
      if (!ok) return;
    }
    try {
      await patchTask(task.id, { permission: p });
      toast(`本任务权限改为“${permInfo[p].label}”，从下一步开始生效`);
    } catch (e) { toastErrorOf(e); }
  };
  return (
    <button type="button" className="perm-chip" data-level={info.level} aria-haspopup="menu" disabled={!online}
      aria-label={`权限级别：${info.label}，点击修改`} title={`权限级别：${info.label}（点击修改）`}
      onClick={(e) => openMenu(e.currentTarget, permOrder.map((p) => ({
        label: `${p === task.permission ? '✓ ' : ''}${permInfo[p].label}${p === 'full' ? '…' : ''}：${permInfo[p].desc}`,
        danger: p === 'full',
        onSelect: () => void set(p),
      })))}>
      <Icon name={info.icon} />{info.label}
    </button>
  );
}
