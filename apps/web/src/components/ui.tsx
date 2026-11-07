// 通用小组件：对话框、确认框、菜单、错误提示（把 ApiError.actions 渲染成按钮）、徽标、状态标记、提示条、读屏播报。
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ErrorActionKey, type AgentKind, type ApiError } from '@aic/protocol';
import { Icon } from './Icon';
import { createStore, useStore } from '../state/store';
import { announceStore, dismissAlert, errorAlertStore, navigate, showError, toast, toastStore } from '../state/ui';
import { agentFallback, type StatusShape } from '../lib/format';
import { TASK_SEND_ACTIONS } from '../lib/agents';
import { appStore, cancelTask, sendPrompt, startLogin, useApp } from '../state/app';
import { lastUserText } from '../state/core';
import { requestAgentTest, requestOpenSwitcher } from './focus';

// ---------------------------------------------------------------------
// 对话框：原生 <dialog>，Esc 关闭，焦点由浏览器管理并在关闭后还原
// ---------------------------------------------------------------------
export function Dialog({ title, onClose, children, footer, wide, initialFocus }: {
  title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean;
  /** 打开后聚焦的元素选择器（默认第一个可聚焦元素） */
  initialFocus?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useLayoutEffect(() => {
    const d = ref.current!;
    const opener = document.activeElement as HTMLElement | null;
    if (!d.open) d.showModal();
    if (initialFocus) d.querySelector<HTMLElement>(initialFocus)?.focus();
    const onCancel = (e: Event) => { e.preventDefault(); closeRef.current(); };
    d.addEventListener('cancel', onCancel);
    return () => { d.removeEventListener('cancel', onCancel); if (d.open) d.close(); opener?.focus?.(); };
  }, [initialFocus]);
  return (
    <dialog ref={ref} className={'dlg' + (wide ? ' wide' : '')} aria-label={title}
      onMouseDown={(e) => { if (e.target === ref.current) onClose(); }}>
      <div className="dlg-head"><h2>{title}</h2><span className="grow" />
        <button type="button" className="btn ghost icon sm" aria-label="关闭" onClick={onClose}><Icon name="x" /></button>
      </div>
      <div className="dlg-body">{children}</div>
      {footer ? <div className="dlg-foot">{footer}</div> : null}
    </dialog>
  );
}

// 命令式对话框：菜单等地方需要“确认一下”“输入名称”时用
type DialogEntry = { id: number; node: (close: () => void) => ReactNode };
const dialogStore = createStore<DialogEntry[]>([]);
let dialogSeq = 0;
export function openDialog(node: (close: () => void) => ReactNode) {
  const id = ++dialogSeq;
  dialogStore.set((l) => [...l, { id, node }]);
  return () => dialogStore.set((l) => l.filter((x) => x.id !== id));
}
export function DialogHost() {
  const list = useStore(dialogStore, (l) => l);
  return <>{list.map((d) => <DialogSlot key={d.id} entry={d} />)}</>;
}
function DialogSlot({ entry }: { entry: DialogEntry }) {
  const close = () => dialogStore.set((l) => l.filter((x) => x.id !== entry.id));
  return <>{entry.node(close)}</>;
}

export function confirmDialog(opts: { title: string; body: ReactNode; ok: string; danger?: boolean; cancel?: string }): Promise<boolean> {
  return new Promise((resolve) => {
    openDialog((close) => {
      const done = (v: boolean) => { close(); resolve(v); };
      return (
        <Dialog title={opts.title} onClose={() => done(false)} initialFocus="[data-cancel]"
          footer={<>
            <button type="button" className="btn" data-cancel onClick={() => done(false)}>{opts.cancel ?? '取消'}</button>
            <button type="button" className={'btn ' + (opts.danger ? 'danger' : 'primary')} onClick={() => done(true)}>{opts.ok}</button>
          </>}>
          {opts.body}
        </Dialog>
      );
    });
  });
}

/** 多个选项的确认框（例如“等当前步骤完成 / 立即中断”）；取消时返回 null */
export function choiceDialog<V extends string>(opts: { title: string; body: ReactNode; choices: { value: V; label: string; primary?: boolean; danger?: boolean }[]; cancel?: string }): Promise<V | null> {
  return new Promise((resolve) => {
    openDialog((close) => {
      const done = (v: V | null) => { close(); resolve(v); };
      return (
        <Dialog title={opts.title} onClose={() => done(null)} initialFocus="[data-cancel]"
          footer={<>
            <button type="button" className="btn" data-cancel onClick={() => done(null)}>{opts.cancel ?? '取消'}</button>
            {opts.choices.map((c) => (
              <button key={c.value} type="button" className={'btn' + (c.danger ? ' danger' : c.primary ? ' primary' : '')} onClick={() => done(c.value)}>{c.label}</button>
            ))}
          </>}>
          {opts.body}
        </Dialog>
      );
    });
  });
}

/** 输入一个名称（新建分组、重命名）；onSave 抛错时对话框保持打开并显示错误 */
export function nameDialog(opts: { title: string; label: string; value?: string; hint?: string; ok: string; placeholder?: string; onSave: (v: string) => Promise<void> }) {
  openDialog((close) => <NameDialog {...opts} close={close} />);
}
function NameDialog({ title, label, value = '', hint, ok, placeholder, onSave, close }: Parameters<typeof nameDialog>[0] & { close: () => void }) {
  const [v, setV] = useState(value);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const submit = async () => {
    const t = v.trim();
    if (!t || busy) return;
    setBusy(true);
    try { await onSave(t); close(); } catch (e) { setErr(asApiError(e)); setBusy(false); }
  };
  return (
    <Dialog title={title} onClose={close} initialFocus="#nd-n"
      footer={<>
        <button type="button" className="btn" onClick={close}>取消</button>
        <button type="button" className="btn primary" aria-busy={busy} disabled={!v.trim()} onClick={submit}>{ok}</button>
      </>}>
      {err ? <ErrorNotice error={err} /> : null}
      <div className="form-row"><label htmlFor="nd-n">{label}</label>
        <input id="nd-n" className="input" value={v} maxLength={100} placeholder={placeholder}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); } }}
          onFocus={(e) => e.currentTarget.select()} />
      </div>
      {hint ? <p style={{ margin: 0, color: 'var(--fg-3)' }}>{hint}</p> : null}
    </Dialog>
  );
}

// ---------------------------------------------------------------------
// 菜单：方向键移动、Enter 选择、Esc 关闭并把焦点还给触发按钮
// ---------------------------------------------------------------------
export interface MenuItem { label: string; onSelect: () => void; danger?: boolean; disabled?: boolean }
interface MenuState { anchor: HTMLElement; items: MenuItem[]; x?: number; y?: number }
const menuStore = createStore<MenuState | null>(null);
export function openMenu(anchor: HTMLElement, items: MenuItem[], at?: { x: number; y: number }) {
  menuStore.set(() => ({ anchor, items, x: at?.x, y: at?.y }));
}
export function MenuHost() {
  const m = useStore(menuStore, (s) => s);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!m || !ref.current) { setPos(null); return; }
    const r = m.anchor.getBoundingClientRect();
    const el = ref.current;
    const top = Math.min(m.y ?? r.bottom + 4, innerHeight - el.offsetHeight - 8);
    const left = Math.min(m.x ?? r.left, innerWidth - el.offsetWidth - 8);
    setPos({ top: Math.max(8, top), left: Math.max(8, left) });
    el.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
  }, [m]);
  useEffect(() => {
    if (!m) return;
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) menuStore.set(() => null); };
    const t = setTimeout(() => document.addEventListener('mousedown', off), 0);
    return () => { clearTimeout(t); document.removeEventListener('mousedown', off); };
  }, [m]);
  if (!m) return null;
  const close = (refocus: boolean) => { menuStore.set(() => null); if (refocus) m.anchor.focus(); };
  const onKey = (e: React.KeyboardEvent) => {
    const btns = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])];
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); btns[(i + 1) % btns.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length]?.focus(); }
    else if (e.key === 'Tab') { close(false); }
  };
  return (
    <div ref={ref} className="menu" role="menu" onKeyDown={onKey}
      style={pos ? { top: pos.top, left: pos.left } : { top: -9999, left: -9999 }}>
      {m.items.map((it, i) => (
        <button key={i} type="button" role="menuitem" className={it.danger ? 'danger' : undefined} disabled={it.disabled}
          onClick={() => { close(true); it.onSelect(); }}>{it.label}</button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------
// 错误提示：发生了什么 + 怎么处理 + 按钮（来自 ApiError.actions）
// ---------------------------------------------------------------------
export function asApiError(e: unknown): ApiError {
  if (e && typeof e === 'object' && 'error' in e) return (e as { error: ApiError }).error;
  return { code: 'client.unknown', message: '出了点问题', hint: e instanceof Error ? e.message : String(e), actions: [] };
}

/** 错误按钮执行时的上下文：在哪个任务里、哪个 Agent、任务是否正忙（忙时不能再发消息） */
export interface ErrorActionContext {
  taskId?: string | null;
  kind?: string | null;
  busy?: boolean;
  onRetry?: () => void;
}
type ActionLike = { action: string; args?: Record<string, unknown> | undefined };

const argStr = (args: Record<string, unknown> | undefined, ...keys: string[]): string | undefined => {
  for (const k of keys) { const v = args?.[k]; if (typeof v === 'string' && v) return v; }
  return undefined;
};

/** 会发一条消息的按钮：任务正忙或断线时不能点 */
export function actionNeedsIdle(action: string) { return TASK_SEND_ACTIONS.has(action); }

/** 认识的 action 直接执行；不认识的提示用户更新界面。第一个参数可以是 action 字符串，也可以是带 args 的 ErrorAction */
export function runErrorAction(a: string | ActionLike, onRetryOrCtx?: (() => void) | ErrorActionContext) {
  const { action, args } = typeof a === 'string' ? { action: a, args: undefined } : a;
  const ctx: ErrorActionContext = typeof onRetryOrCtx === 'function' ? { onRetry: onRetryOrCtx } : onRetryOrCtx ?? {};
  const taskId = argStr(args, 'taskId') ?? ctx.taskId ?? undefined;
  const kind = argStr(args, 'kind', 'agent') ?? ctx.kind ?? undefined;
  switch (action) {
    case 'retry': if (ctx.onRetry) ctx.onRetry(); else location.reload(); return;
    case 'reload': location.reload(); return;
    case 'open_agents': navigate(kind ? { page: 'agents', agent: kind } : { page: 'agents' }); return;
    case 'open_settings': navigate({ page: 'settings' }); return;
    case 'pair': case 're_pair': case 'pairing.start': location.hash = ''; location.reload(); return;
    // 1.2：真实 Agent 的错误按钮（protocol 的 ErrorActionKey；同时认几个常见的别名）
    case 'agents.login': case 'agent.login': case 'login': {
      const profileId = argStr(args, 'profileId');
      navigate(kind ? (profileId ? { page: 'agents', agent: kind, profileId } : { page: 'agents', agent: kind }) : { page: 'agents' });
      return;
    }
    case 'agents.test': case 'agent.test':
      navigate(kind ? { page: 'agents', agent: kind } : { page: 'agents' });
      if (kind) requestAgentTest(kind);
      return;
    case 'task.cancel':
      if (taskId) cancelTask(taskId).then(() => toast('已请求停止'), toastErrorOf);
      return;
    case 'task.continue': case 'task.resume': case 'continue': case 'resume':
      if (!taskId) break;
      if (ctx.busy) { toast('Agent 正在工作，等这一轮结束再继续', 'attn'); return; }
      sendPrompt(taskId, '继续').then(() => toast('已发送“继续”，会自动恢复会话'), toastErrorOf);
      return;
    case 'task.retry': {
      if (!taskId) break;
      if (ctx.busy) { toast('Agent 正在工作，等这一轮结束再试', 'attn'); return; }
      const text = lastUserText(appStore.get().logs[taskId] ?? []);
      if (!text) { toast('没有找到上一条消息，直接在输入框里重新发送吧', 'attn'); return; }
      sendPrompt(taskId, text).then(() => toast('已重新发送上一条消息'), toastErrorOf);
      return;
    }
    case 'task.switch_model': case 'switch_model':
      if (!taskId) break;
      navigate({ page: 'task', taskId });
      requestOpenSwitcher(taskId, 'model');
      return;
    case 'task.switch_profile': case 'switch_profile': {
      if (!taskId) break;
      const t = appStore.get().tasks[taskId];
      const others = t ? (appStore.get().agents.find((x) => x.kind === t.agent)?.profiles ?? []).length > 1 : false;
      if (t && others) { navigate({ page: 'task', taskId }); requestOpenSwitcher(taskId, 'profile'); }
      else { navigate(t ? { page: 'agents', agent: t.agent } : { page: 'agents' }); toast('这个 Agent 只有一个账号，先在这里添加一个', 'attn'); }
      return;
    }
    case ErrorActionKey.LoginForce: {
      // 确认后强制登录（CodeBuddy 已登录时换账号会同时退出 WorkBuddy 里的账号）
      const methodId = argStr(args, 'methodId');
      if (!kind || !methodId) break;
      const profileId = argStr(args, 'profileId');
      void confirmDialog({
        title: '退出现在的账号并重新登录？', ok: '退出并重新登录', danger: true,
        body: <p style={{ margin: 0 }}>重新登录会替换现在的登录。</p>,
      }).then((ok) => {
        if (!ok) return;
        navigate(profileId ? { page: 'agents', agent: kind, profileId } : { page: 'agents', agent: kind });
        startLogin(kind as AgentKind, { methodId, ...(profileId ? { profileId } : {}), force: true })
          .then(() => toast('已开始重新登录，按 Agent 页里的提示完成'), (e) => toastErrorOf(e, { kind }));
      });
      return;
    }
    default: break;
  }
  toast('这个操作需要更新后的界面才能完成，先刷新页面试试', 'attn');
}

export function ErrorNotice({ error, onRetry, kind = 'err', ctx, compact, onDismiss, onAction }: {
  error: ApiError; onRetry?: () => void; kind?: 'err' | 'attn';
  /** 1.2：按钮执行时的上下文（任务、Agent） */
  ctx?: ErrorActionContext;
  /** 紧凑：只显示一行标题和按钮（输入框上方的提示条用） */
  compact?: boolean;
  /** 有关闭按钮（页面里的 alert 块、切换器里的错误） */
  onDismiss?: () => void;
  /** 点了任一按钮之后（例如收起提示） */
  onAction?: () => void;
}) {
  const conn = useApp((s) => s.conn);
  const online = conn === 'online' || conn === 'replaying';
  const c: ErrorActionContext = { ...ctx, onRetry: onRetry ?? ctx?.onRetry };
  return (
    <div className={'alert ' + kind + (compact ? ' compact' : '')} role="alert">
      <Icon name="warn" />
      <div className="body">
        <strong>{error.message}</strong>
        {error.hint && !compact ? <p>{error.hint}</p> : null}
        {error.actions.length ? (
          <div className="err-actions">
            {error.actions.map((a, i) => {
              const needsIdle = actionNeedsIdle(a.action);
              return (
                <button key={i} type="button" className="btn sm" disabled={needsIdle && (!online || !!c.busy)}
                  title={needsIdle && c.busy ? 'Agent 正在工作，等这一轮结束' : undefined}
                  onClick={() => { runErrorAction(a, c); onAction?.(); }}>{a.label}</button>
              );
            })}
          </div>
        ) : null}
      </div>
      {onDismiss ? <button type="button" className="btn ghost icon sm alert-close" aria-label="关闭这条提示" onClick={onDismiss}><Icon name="x" /></button> : null}
    </div>
  );
}

/** 页面里的错误块（带按钮的错误，见 state/ui.ts 的 showError）：固定在右下角提示条上方，不自动消失 */
export function ErrorAlerts() {
  const list = useStore(errorAlertStore, (l) => l);
  if (!list.length) return null;
  return (
    <div className="error-alerts">
      {list.map((a) => (
        <ErrorNotice key={a.id} error={a.error} ctx={{ taskId: a.taskId, kind: a.kind }}
          onDismiss={() => dismissAlert(a.id)} onAction={() => dismissAlert(a.id)} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------
// 徽标与状态
// ---------------------------------------------------------------------
export function useAgentName(kind: AgentKind | string | null | undefined): string {
  const agents = useApp((s) => s.agents);
  if (!kind) return 'Agent';
  return agents.find((a) => a.kind === kind)?.displayName ?? agentFallback[kind as AgentKind]?.name ?? kind;
}

export function AgentBadge({ kind, size, className }: { kind: AgentKind | string; size?: 'sm' | 'lg'; className?: string }) {
  const name = useAgentName(kind);
  const mono = agentFallback[kind as AgentKind]?.mono ?? kind.slice(0, 1).toUpperCase();
  const style = size === 'sm' ? { width: 16, height: 16, fontSize: 9 } : undefined;
  return <span className={`ag ${kind}${size === 'lg' ? ' lg' : ''}${className ? ' ' + className : ''}`} title={name} aria-label={name} role="img" style={style}>{mono}</span>;
}

export function StatusMark({ shape, text, className }: { shape: StatusShape; text: string; className?: string }) {
  return <span className={`status ${shape}${className ? ' ' + className : ''}`}><span className="dot" aria-hidden="true" />{text}</span>;
}

// ---------------------------------------------------------------------
// 提示条与读屏播报
// ---------------------------------------------------------------------
export function Toasts() {
  const list = useStore(toastStore, (l) => l);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => <div key={t.id} className={'toast ' + t.kind}>{t.text}</div>)}
    </div>
  );
}

export function Announcer() {
  const a = useStore(announceStore, (s) => s);
  // 用 key 让同样的文字也能再次被播报
  return <div className="sr-only" aria-live="polite" aria-atomic="true">{a.n ? <span key={a.n}>{a.text}</span> : null}</div>;
}

/** 操作失败：有按钮的错误进页面里的 alert 块，没有按钮的用提示条（审查第 19 条） */
export function toastErrorOf(e: unknown, ctx: { taskId?: string | null; kind?: string | null } = {}) { showError(asApiError(e), ctx); }
