// 输入区：待审批条 + 中断提示 + 输入框 + 工具条（附件、[Agent · 账号 · 模型 · 思考强度] 切换器、权限级别、发送 / 停止）。
import { useEffect, useMemo, useRef, useState } from 'react';
import { FeatureKey, type ApiError, type Approval, type PermissionLevel, type Task } from '@aic/protocol';
import { appStore, cancelTask, patchTask, sendPrompt, switchConfig, useApp } from '../state/app';
import { toast } from '../state/ui';
import { createStore, useStore } from '../state/store';
import type { SessionCfg } from '../state/core';
import { permInfo, permOrder } from '../lib/format';
import {
  PERM_LOCKED_REASON, agentReadiness, emptyModelsText, modelSwitchKind, permAvailable, pickEfforts, pickModels,
  profileKindText, profileSwitchKind, profileSwitchText, switchKindText, switchNeedsTurnEnd, withDefaultActions,
} from '../lib/agents';
import { AgentBadge, ErrorNotice, asApiError, choiceDialog, confirmDialog, openMenu, toastErrorOf, useAgentName } from './ui';
import { Icon } from './Icon';
import { useDismiss } from './hooks';
import { requestFocusApproval, switcherRequestStore, type SwitcherSection } from './focus';
import { TaskError } from './Chat';
import { AnnotationChip, clearAnnotations, useAnnotations } from './Annotations';
import { composeWithAnnotations } from '../lib/annotations';

/** 每个任务的草稿：切换任务时保留没发出去的内容（父组件按任务 id 重新挂载本组件） */
const drafts = new Map<string, string>();

const busyStatuses = new Set<Task['status']>(['running', 'waiting', 'queued']);

export function Composer({ task, pending, config, blocking }: { task: Task; pending: Approval[]; config: SessionCfg; blocking?: ApiError | null }) {
  const conn = useApp((s) => s.conn);
  const online = conn === 'online' || conn === 'replaying';
  const [text, setText] = useState(() => drafts.get(task.id) ?? '');
  const [sending, setSending] = useState(false);
  const [sendErr, setSendErr] = useState<ApiError | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { drafts.set(task.id, text); }, [task.id, text]);

  // 对话里选中文字添加的注释：发送时附在消息后面（Annotations.tsx）
  const annos = useAnnotations(task.id);

  const working = busyStatuses.has(task.status);
  const canSend = online && !working && !sending && (text.trim().length > 0 || annos.length > 0);

  const send = async () => {
    if (!canSend) return;
    const body = composeWithAnnotations(text, annos);
    setSending(true);
    setSendErr(null);
    try {
      await sendPrompt(task.id, body);
      setText('');
      drafts.delete(task.id);
      clearAnnotations(task.id);
    } catch (e) {
      setSendErr(withDefaultActions(asApiError(e), { taskId: task.id, kind: task.agent })); // 发送失败时保留输入内容，错误连同按钮显示在输入框上方
    } finally {
      setSending(false);
      ta.current?.focus();
    }
  };
  const stop = async () => {
    try { await cancelTask(task.id); toast('已请求停止，Agent 会在当前步骤结束后停下'); } catch (e) { toastErrorOf(e, { taskId: task.id, kind: task.agent }); }
  };

  const placeholder = !online ? '正在重新连接，恢复后可以继续发送'
    : task.status === 'waiting' ? '有审批等你处理，处理后 Agent 会继续'
    : working ? 'Agent 正在工作，完成后可以继续对话；需要时可以点“停止”'
    : blocking ? '处理上面的提示后，发一条消息就能继续（会自动恢复会话）'
    : task.status === 'interrupted' ? '任务中断了：发一条消息就能继续（会自动恢复会话）'
    : '继续对话，或补充要求。Enter 发送，Shift+Enter 换行';

  return (
    <div className="composer">
      <div className="composer-inner">
        {!online ? (
          <div className="offline-note" role="status"><Icon name="refresh" />和服务的连接断开了，正在重新连接…恢复后会自动补齐对话。</div>
        ) : null}
        {blocking && !working ? <div className="composer-error"><TaskError error={blocking} task={task} compact /></div> : null}
        {sendErr ? <div className="composer-error"><ErrorNotice error={sendErr} ctx={{ taskId: task.id, kind: task.agent, busy: working }} onDismiss={() => setSendErr(null)} onAction={() => setSendErr(null)} /></div> : null}
        {pending.length ? (
          <div className="pending-strip" role="status">
            <Icon name="shield" />
            <span>有 {pending.length} 项审批等你处理：{pending[0]!.title}</span>
            <span className="grow" />
            <button type="button" className="btn sm ghost" onClick={() => requestFocusApproval(pending[0]!.id)}>跳到审批</button>
          </div>
        ) : null}
        <div className="compose-box">
          <AnnotationChip taskId={task.id} />
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
// [Agent · 账号 · 模型 · 思考强度] 切换器（ui-design.md 6.5，phase-1.md 6.7）
// 选项以当前会话的 session.config（models / efforts）为准，没有会话时用 /agents 的缓存。
// 切换后等服务端 ack；失败时界面仍显示原值（值来自事件），并提示 Agent 给的说明。
// ---------------------------------------------------------------------
type Busy = 'model' | 'effort' | 'profile' | null;
type SwitchPatch = { model?: string; effort?: string; profileId?: string };

// 本轮结束后再执行的切换（用户选了“等当前步骤完成”或“立即中断”）：按任务记一条，任务不再忙时执行。
// 放在模块里而不是组件里：用户切到别的任务再回来也不会丢。
interface PendingSwitch { kind: Exclude<Busy, null>; patch: SwitchPatch; label: string }
const pendingSwitchStore = createStore<Record<string, PendingSwitch>>({});
let pendingWatch: (() => void) | null = null;
function queueSwitchAfterTurn(taskId: string, p: PendingSwitch) {
  pendingSwitchStore.set((m) => ({ ...m, [taskId]: p }));
  if (pendingWatch) return;
  const check = () => {
    const all = pendingSwitchStore.get();
    for (const [id, sw] of Object.entries(all)) {
      const t = appStore.get().tasks[id];
      if (!t) { pendingSwitchStore.set((m) => { const n = { ...m }; delete n[id]; return n; }); continue; }
      if (busyStatuses.has(t.status)) continue;
      pendingSwitchStore.set((m) => { const n = { ...m }; delete n[id]; return n; });
      switchConfig(id, sw.patch).then(
        () => toast(`这一轮已结束，${sw.label}`),
        (e) => toastErrorOf(e, { taskId: id, kind: t.agent }),
      );
    }
    if (!Object.keys(pendingSwitchStore.get()).length && pendingWatch) { pendingWatch(); pendingWatch = null; }
  };
  pendingWatch = appStore.subscribe(check);
  check();
}
function cancelPendingSwitch(taskId: string) {
  pendingSwitchStore.set((m) => { if (!m[taskId]) return m; const n = { ...m }; delete n[taskId]; return n; });
}

function Switcher({ task, config, online }: { task: Task; config: SessionCfg; online: boolean }) {
  const agents = useApp((s) => s.agents);
  const profilesOn = useApp((s) => !!s.hello?.features[FeatureKey.Profiles]);
  const info = agents.find((a) => a.kind === task.agent);
  const agentName = useAgentName(task.agent);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  /** 切换失败：在弹出层里显示“发生了什么 + 怎么处理 + 按钮”，不只是一条会消失的提示 */
  const [swErr, setSwErr] = useState<ApiError | null>(null);
  const pendingSw = useStore(pendingSwitchStore, (m) => m[task.id] ?? null);
  const pop = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const focusSection = useRef<SwitcherSection | null>(null);
  const close = useMemo(() => () => setOpen(false), []);
  useDismiss(open, pop, close, anchor);
  useEffect(() => {
    if (!open) return;
    const sel = focusSection.current ? `[data-section="${focusSection.current}"] ` : '';
    focusSection.current = null;
    (pop.current?.querySelector<HTMLElement>(`${sel}[aria-selected="true"]:not([disabled]), ${sel}button:not([disabled])`)
      ?? pop.current?.querySelector<HTMLElement>('button:not([disabled])'))?.focus();
  }, [open]);
  useEffect(() => { if (!open) setSwErr(null); }, [open]);

  // 错误按钮“换模型”“换账号”：打开切换器并跳到对应一栏
  const req = useStore(switcherRequestStore, (s) => s);
  useEffect(() => {
    if (!req || req.taskId !== task.id) return;
    switcherRequestStore.set(() => null);
    focusSection.current = req.section;
    setOpen(true);
  }, [req, task.id]);

  const models = pickModels(info, config);
  const efforts = pickEfforts(info, config);
  const how = modelSwitchKind(info?.caps);
  const profiles = info?.profiles ?? [];
  const showProfiles = profilesOn && profiles.length > 1;
  const curProfileId = config.profileId ?? task.profileId ?? profiles.find((p) => p.isDefault)?.id ?? null;
  const curProfile = profiles.find((p) => p.id === curProfileId) ?? null;
  const modelName = models.find((m) => m.id === config.model)?.name ?? config.model ?? 'Agent 默认模型';

  const doneText = (kind: Exclude<Busy, null>) => (kind === 'effort' ? '已调整思考强度，从下一条消息生效'
    : kind === 'profile' ? '已换账号：发下一条消息时会用新账号恢复原来的会话；恢复不了时对话里会提示'
    : how === 'in_session' ? '已切换模型，从下一条消息生效'
    : '已切换模型：发下一条消息时会恢复会话并生效');

  const doSwitch = async (kind: Exclude<Busy, null>, patch: SwitchPatch, label: string) => {
    if (busy) return;
    setSwErr(null);
    // Agent 正在执行：换账号、需要重启进程的换模型先问“等当前步骤完成 / 立即中断”（ui-design.md 6.5）
    if (switchNeedsTurnEnd(task.status, kind, how)) {
      const choice = await choiceDialog({
        title: `Agent 正在执行，要${label}吗？`,
        body: <p style={{ margin: 0 }}>{kind === 'profile' ? '换账号' : '换这个模型'}要先结束 Agent 进程再恢复会话。可以等当前这一轮结束后自动切换，也可以立即中断（和点 [停止] 一样）后切换。</p>,
        choices: [{ value: 'wait', label: '等当前步骤完成', primary: true }, { value: 'interrupt', label: '立即中断', danger: true }],
      });
      if (!choice) return;
      queueSwitchAfterTurn(task.id, { kind, patch, label });
      setOpen(false);
      if (choice === 'interrupt') {
        try { await cancelTask(task.id); toast(`已请求停止，停下后会${label}`); } catch (e) { cancelPendingSwitch(task.id); toastErrorOf(e, { taskId: task.id, kind: task.agent }); }
      } else {
        toast(`这一轮结束后会${label}`);
      }
      return;
    }
    setBusy(kind);
    try {
      await switchConfig(task.id, patch);
      toast(busyStatuses.has(task.status) ? `${doneText(kind).replace(/[：:].*$/, '')}，从下一条消息生效` : doneText(kind));
      setOpen(false);
    } catch (e) {
      // 界面仍显示原值（值来自事件）；错误连同按钮留在弹出层里
      setSwErr(withDefaultActions(asApiError(e), { taskId: task.id, kind: task.agent }));
    } finally {
      setBusy(null);
    }
  };

  const disabled = !online || busy !== null;
  const hint = how === 'in_session' ? '换模型和思考强度保留完整上下文，从下一条消息生效。'
    : how === 'resume' ? '这个 Agent 换模型时会先结束进程，再恢复原来的会话，对话不会丢。'
    : '这个 Agent 不能恢复会话：换模型会新建会话，Agent 不记得之前的对话。';

  return (
    <div style={{ position: 'relative' }}>
      <div className="switcher" role="group" aria-label="当前 Agent、账号、模型与思考强度" ref={anchor}>
        <button type="button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)} aria-label={`切换 Agent，当前 ${agentName}`}>
          <AgentBadge kind={task.agent} size="sm" />{agentName}<Icon name="down" />
        </button>
        {showProfiles ? (
          <button type="button" aria-haspopup="dialog" aria-expanded={open} className="hide-narrow"
            onClick={() => { focusSection.current = 'profile'; setOpen(!open); }}
            aria-label={`切换账号，当前 ${curProfile?.name ?? '默认账号'}`}>
            {curProfile?.name ?? '默认账号'}<Icon name="down" />
          </button>
        ) : null}
        <button type="button" aria-haspopup="dialog" aria-expanded={open} onClick={() => { focusSection.current = 'model'; setOpen(!open); }}
          aria-label={`切换模型和思考强度，当前 ${modelName}${config.effort ? '，思考强度' + config.effort : ''}`} aria-busy={busy !== null}>
          {busy ? <span className="muted">正在切换…</span> : <>{modelName}{config.effort && efforts ? <span className="muted">· {config.effort}</span> : null}</>}<Icon name="down" />
        </button>
      </div>
      {open ? (
        <div className="popover switch-pop" ref={pop} role="dialog" aria-label="切换 Agent、账号、模型与思考强度">
          {swErr ? <ErrorNotice error={swErr} ctx={{ taskId: task.id, kind: task.agent, busy: busyStatuses.has(task.status) }}
            onDismiss={() => setSwErr(null)} onAction={() => { setSwErr(null); setOpen(false); }} /> : null}
          {pendingSw ? (
            <div className="hint" role="status">这一轮结束后会{pendingSw.label}。
              <button type="button" className="linkish" onClick={() => { cancelPendingSwitch(task.id); toast('已取消待执行的切换'); }}>不换了</button></div>
          ) : null}
          <div className="group-label">Agent</div>
          {agents.map((a) => {
            const cur = a.kind === task.agent;
            const r = agentReadiness(a);
            return (
              <button key={a.kind} type="button" className="opt" aria-selected={cur} aria-disabled={!cur} disabled={!cur}
                title={cur ? undefined : r.ready ? '换 Agent 需要交接，第 1.4 步提供' : r.reason ?? undefined}>
                <AgentBadge kind={a.kind} />{a.displayName}<span className="meta">{cur ? '当前' : r.ready ? '交接：第 1.4 步提供' : r.reason ? '未就绪' : ''}</span>
              </button>
            );
          })}
          {showProfiles ? (
            <div data-section="profile">
              <div className="group-label">账号</div>
              {profiles.map((p) => {
                const cur = p.id === curProfileId;
                // 会话存放位置不同的账号（例如本机登录 ↔ 独立配置目录）：换过去原来的会话一定恢复不了，需要交接
                const sk = profileSwitchKind(curProfile, p);
                const blocked = !cur && sk === 'handoff';
                return (
                  <button key={p.id} type="button" className="opt" aria-selected={cur} disabled={disabled || blocked}
                    title={blocked ? '这个账号的会话存在别的地方，换过去 Agent 会不记得之前的对话；交接在第 1.4 步提供，现在可以用它新建任务' : undefined}
                    onClick={() => { if (!cur) void doSwitch('profile', { profileId: p.id }, `换成账号“${p.name}”`); else setOpen(false); }}>
                    {p.name}<span className="meta">{cur ? '当前' : p.loggedIn === false ? '未登录' : `${profileKindText[p.kind]} · ${profileSwitchText[sk]}`}</span>
                  </button>
                );
              })}
            </div>
          ) : null}
          <div data-section="model">
            <div className="group-label">模型</div>
            {models.length ? models.map((m) => {
              const cur = m.id === config.model;
              return (
                <button key={m.id} type="button" className="opt" aria-selected={cur} disabled={disabled}
                  onClick={() => { if (!cur) void doSwitch('model', { model: m.id }, `换成模型 ${m.name}`); else setOpen(false); }}>
                  {m.name}<span className="meta">{cur ? '当前' : switchKindText[how]}</span>
                </button>
              );
            }) : <div className="opt" aria-disabled="true">Agent 默认模型<span className="meta">{emptyModelsText(info)}</span></div>}
            <div className="group-label" id="eff-l">思考强度</div>
            {efforts ? (
              <div className="seg" role="radiogroup" aria-labelledby="eff-l">
                {efforts.map((x) => (
                  <button key={x} type="button" role="radio" aria-checked={x === config.effort} disabled={disabled}
                    onClick={() => { if (x !== config.effort) void doSwitch('effort', { effort: x }, `把思考强度改为 ${x}`); }}>{x}</button>
                ))}
              </div>
            ) : <div className="opt" aria-disabled="true">思考强度由模型自己决定</div>}
          </div>
          <div className="hint">{hint}换到其他 Agent 会走交接，第 1.4 步提供。</div>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------
// 权限级别：只读=眼睛、需审批=盾牌、工作区内自动=带勾的盾牌、全自动=打开的锁（琥珀色，二次确认）
// 能选哪几档以 Gateway 给的 AgentInfo.permissionLevels 为准（审查第 13 条）
// ---------------------------------------------------------------------
function PermChip({ task, online }: { task: Task; online: boolean }) {
  const info = permInfo[task.permission];
  const agentInfo = useApp((s) => s.agents.find((a) => a.kind === task.agent));
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
    } catch (e) { toastErrorOf(e, { taskId: task.id, kind: task.agent }); }
  };
  return (
    <button type="button" className="perm-chip" data-level={info.level} aria-haspopup="menu" disabled={!online}
      aria-label={`权限级别：${info.label}，点击修改`} title={`权限级别：${info.label}（点击修改）`}
      onClick={(e) => openMenu(e.currentTarget, permOrder.map((p) => {
        const ok = permAvailable(task.agent, p, agentInfo);
        return {
          label: `${p === task.permission ? '✓ ' : ''}${permInfo[p].label}${p === 'full' && ok ? '…' : ''}：${ok ? permInfo[p].desc : PERM_LOCKED_REASON}`,
          danger: p === 'full' && ok,
          disabled: !ok,
          onSelect: () => void set(p),
        };
      }))}>
      <Icon name={info.icon} />{info.label}
    </button>
  );
}
