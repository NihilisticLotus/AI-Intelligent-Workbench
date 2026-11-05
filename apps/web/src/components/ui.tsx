// 通用小组件：对话框、确认框、菜单、错误提示（把 ApiError.actions 渲染成按钮）、徽标、状态标记、提示条、读屏播报。
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { AgentKind, ApiError } from '@aic/protocol';
import { Icon } from './Icon';
import { createStore, useStore } from '../state/store';
import { announceStore, navigate, toast, toastError, toastStore } from '../state/ui';
import { agentFallback, type StatusShape } from '../lib/format';
import { useApp } from '../state/app';

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

/** 认识的 action 直接执行；不认识的提示用户更新界面 */
export function runErrorAction(action: string, onRetry?: () => void) {
  switch (action) {
    case 'retry': if (onRetry) onRetry(); else location.reload(); return;
    case 'reload': location.reload(); return;
    case 'open_agents': navigate({ page: 'agents' }); return;
    case 'open_settings': navigate({ page: 'settings' }); return;
    case 'pair': case 're_pair': location.hash = ''; location.reload(); return;
    default: toast('这个操作需要更新后的界面才能完成，先刷新页面试试', 'attn');
  }
}

export function ErrorNotice({ error, onRetry, kind = 'err' }: { error: ApiError; onRetry?: () => void; kind?: 'err' | 'attn' }) {
  return (
    <div className={'alert ' + kind} role="alert">
      <Icon name="warn" />
      <div className="body">
        <strong>{error.message}</strong>
        {error.hint ? <p>{error.hint}</p> : null}
        {error.actions.length ? (
          <div className="err-actions">
            {error.actions.map((a, i) => (
              <button key={i} type="button" className="btn sm" onClick={() => runErrorAction(a.action, onRetry)}>{a.label}</button>
            ))}
          </div>
        ) : null}
      </div>
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

export function toastErrorOf(e: unknown) { toastError(asApiError(e)); }
