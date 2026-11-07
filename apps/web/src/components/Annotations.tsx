// 对话注释（对照 Codex，用户 2026-11-07）
// 1. 选中对话里的文字 → 小菜单 [添加到对话]
// 2. 选中处上方出现评论框“添加可选评论…”，输入框上方出现“N 条注释”
// 3. 原文旁边显示编号圆点：悬停看评论，点击可以修改、删除
// 4. 发送消息时注释附在后面一起发出（lib/annotations.ts），发送后清空
// 5. 没发出去的注释和输入框文字一起存成任务草稿（Composer 负责读写 /tasks/:id/draft），刷新、切换任务、换设备都在
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FeatureKey } from '@aic/protocol';
import { useApp } from '../state/app';
import { createStore, useStore } from '../state/store';
import { clipSelection, locate, offsetIn, type AnnotationData } from '../lib/annotations';
import type { DraftAnnotation } from '@aic/protocol';
import { Icon } from './Icon';

export interface Annotation extends AnnotationData {
  /** 原文在页面里的位置；页面重建后按 raw / pos 重新定位，找不到时只是不显示圆点，注释照常发送 */
  range: Range | null;
  /** 选中时的完整原文和它在对话文字里的偏移（草稿里保存，用来恢复位置） */
  raw: string;
  pos: number;
}

const annotationStore = createStore<Record<string, Annotation[]>>({});
/** 正在编辑的注释：isNew 为刚添加（显示简洁的评论框） */
const editorStore = createStore<{ taskId: string; id: string; isNew: boolean } | null>(null);

let seq = 0;
/** 注释改动的监听（Composer 用来保存草稿）；restore 时不触发 */
const listeners = new Set<(taskId: string) => void>();
export function onAnnotationsChanged(fn: (taskId: string) => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }
const setList = (taskId: string, f: (l: Annotation[]) => Annotation[]) => {
  annotationStore.set((m) => ({ ...m, [taskId]: f(m[taskId] ?? []) }));
  for (const l of listeners) l(taskId);
};
/** 草稿里读回来的注释：位置等对话渲染后再定位 */
export function restoreAnnotations(taskId: string, list: readonly DraftAnnotation[]) {
  const cur = annotationStore.get()[taskId];
  if (cur?.length) return; // 本页已经有（例如刚切回来），以本页为准
  annotationStore.set((m) => ({ ...m, [taskId]: list.map((a) => ({ id: a.id, text: a.text, comment: a.comment, raw: a.raw ?? a.text, pos: a.pos ?? -1, range: null })) }));
  for (const a of list) { const n = Number(a.id.replace(/^D+/, '')); if (n > seq) seq = n; }
}
export function draftAnnotations(taskId: string): DraftAnnotation[] {
  return getAnnotations(taskId).map(({ id, text, comment, raw, pos }) => ({ id, text, comment, raw, pos }));
}

export function useAnnotations(taskId: string): Annotation[] {
  return useStore(annotationStore, (m) => m[taskId]) ?? EMPTY;
}
const EMPTY: Annotation[] = [];
export function getAnnotations(taskId: string): Annotation[] { return annotationStore.get()[taskId] ?? EMPTY; }
export function clearAnnotations(taskId: string) {
  setList(taskId, () => []);
  if (editorStore.get()?.taskId === taskId) editorStore.set(() => null);
}
function removeAnnotation(taskId: string, id: string) {
  setList(taskId, (l) => l.filter((a) => a.id !== id));
  if (editorStore.get()?.id === id) editorStore.set(() => null);
}
function setComment(taskId: string, id: string, comment: string) {
  setList(taskId, (l) => l.map((a) => (a.id === id ? { ...a, comment } : a)));
}
function openEditor(taskId: string, id: string, isNew = false) {
  editorStore.set(() => ({ taskId, id, isNew }));
}

const alive = (r: Range | null): r is Range => !!r && r.startContainer.isConnected && r.endContainer.isConnected;

/** 用浏览器的自定义高亮标出正在编辑的原文，不改动页面结构 */
function useHighlight(range: Range | null) {
  useEffect(() => {
    const reg = typeof CSS !== 'undefined' ? CSS.highlights : undefined;
    if (!reg || typeof Highlight === 'undefined' || !alive(range)) return;
    reg.set('aic-anno', new Highlight(range));
    return () => { reg.delete('aic-anno'); };
  }, [range]);
}

/** 对话区里的注释层：选中菜单、编号圆点、评论框。位置跟着滚动和尺寸变化重算 */
export function AnnotationLayer({ container, taskId }: { container: React.RefObject<HTMLDivElement | null>; taskId: string }) {
  const list = useAnnotations(taskId);
  const editor = useStore(editorStore, (e) => (e && e.taskId === taskId ? e : null));
  const [, setTick] = useState(0);
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const bump = () => setTick((n) => n + 1);
    el.addEventListener('scroll', bump, { passive: true });
    window.addEventListener('resize', bump);
    const ro = new ResizeObserver(bump);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => { el.removeEventListener('scroll', bump); window.removeEventListener('resize', bump); ro.disconnect(); };
  }, [container]);

  const box = container.current?.getBoundingClientRect() ?? null;
  // 页面重建过（刷新、切换任务、对话重新渲染）：按原文重新定位，不改动 store（位置只是界面状态）
  const root = container.current;
  if (root) for (const a of list) if (!alive(a.range) && a.raw) a.range = locate(root, a.raw, a.pos);
  const editing = editor ? list.find((a) => a.id === editor.id) ?? null : null;
  useHighlight(editing?.range ?? null);

  return (
    <>
      <SelectionMenu container={container} taskId={taskId} />
      {box ? list.map((a, i) => <Badge key={a.id} a={a} n={i + 1} box={box} taskId={taskId} active={editing?.id === a.id} />) : null}
      {editing && editor ? <Editor key={editing.id} a={editing} isNew={editor.isNew} taskId={taskId} box={box} /> : null}
    </>
  );
}

function Badge({ a, n, box, taskId, active }: { a: Annotation; n: number; box: DOMRect; taskId: string; active: boolean }) {
  if (!alive(a.range)) return null;
  const rects = a.range.getClientRects();
  const last = rects[rects.length - 1];
  if (!last) return null;
  const x = last.right, y = last.top;
  if (y < box.top || y > box.bottom - 10) return null; // 滚出对话区就不画
  const tip = a.comment.trim() || a.text;
  return (
    <button type="button" className={'anno-badge' + (active ? ' on' : '')} style={{ left: x, top: y }}
      aria-label={`注释 ${n}：${tip}，点击修改`} onMouseDown={(e) => e.preventDefault()} onClick={() => openEditor(taskId, a.id)}>
      {n}<span className="anno-tip" role="tooltip">{tip.length > 120 ? tip.slice(0, 120) + '…' : tip}</span>
    </button>
  );
}

function Editor({ a, isNew, taskId, box }: { a: Annotation; isNew: boolean; taskId: string; box: DOMRect | null }) {
  const [text, setText] = useState(a.comment);
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const close = () => editorStore.set(() => null);
  const save = () => { setComment(taskId, a.id, text.trim()); close(); };
  // 点评论框以外的地方：新添加的注释保留已经输入的评论；修改中的注释等于取消
  const saveRef = useRef(save); saveRef.current = save;
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) (isNew ? saveRef.current : close)(); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [isNew]);
  useLayoutEffect(() => { const el = input.current; if (el) { el.focus(); el.selectionStart = el.selectionEnd = el.value.length; } }, []);

  const pos = useMemo(() => {
    const r = alive(a.range) ? a.range.getClientRects()[0] : null;
    if (!r || !box) return { left: '50%', top: '40%', below: false };
    const below = r.top - box.top < 120; // 上方放不下就放到下面
    const left = Math.max(box.left + 8, Math.min(r.left - 24, box.right - 440));
    return { left, top: below ? r.bottom + 8 : r.top - 8, below };
  }, [a.range, box]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); isNew ? save() : close(); }
    else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); save(); }
  };
  return (
    <div className={'anno-editor' + (isNew ? ' new' : '') + (pos.below ? ' below' : '')} ref={ref} role="dialog"
      aria-label={isNew ? '给这段选中的内容加评论' : '修改注释'} style={{ left: pos.left, top: pos.top }}>
      <textarea ref={input} rows={isNew ? 1 : 2} value={text} maxLength={2000} placeholder="添加可选评论…"
        aria-label="评论（可以不填）" onChange={(e) => setText(e.target.value)} onKeyDown={onKey} />
      {isNew ? (
        <button type="button" className="anno-send" aria-label="完成" title="完成（Enter）" onClick={save}><Icon name="up" /></button>
      ) : (
        <div className="anno-acts">
          <button type="button" className="btn ghost icon sm" aria-label="删除这条注释" title="删除" onClick={() => removeAnnotation(taskId, a.id)}><Icon name="trash" /></button>
          <span className="grow" />
          <button type="button" className="btn sm" onClick={close}>取消</button>
          <button type="button" className="btn sm primary" onClick={save}>保存</button>
        </div>
      )}
    </div>
  );
}

/**
 * 选中对话里的文字后出现的小菜单：
 * - [添加到对话]：1.2 提供
 * - [在侧边聊天中提问]：侧边聊天上线后才显示（功能开关 chat.side，design.md 第 26 节）
 */
function SelectionMenu({ container, taskId }: { container: React.RefObject<HTMLDivElement | null>; taskId: string }) {
  const sideChat = useApp((s) => !!s.hello?.features[FeatureKey.SideChat]);
  const [sel, setSel] = useState<{ text: string; range: Range; x: number; y: number } | null>(null);
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const update = () => {
      const s = window.getSelection();
      const text = s && !s.isCollapsed ? s.toString().trim() : '';
      if (!s || !text || s.rangeCount === 0 || !el.contains(s.anchorNode) || !el.contains(s.focusNode)) { setSel(null); return; }
      const range = s.getRangeAt(0);
      // 只在对话内容里出现：输入框、按钮里的选中不算
      const host = range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
      if (host?.closest('textarea, input, button, .anno-editor')) { setSel(null); return; }
      const r = range.getClientRects()[0] ?? range.getBoundingClientRect();
      setSel({ text, range: range.cloneRange(), x: r.left, y: r.top });
    };
    const onUp = () => setTimeout(update, 0);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSel(null); else if (e.shiftKey) setTimeout(update, 0); };
    const hide = () => setSel(null);
    el.addEventListener('mouseup', onUp);
    el.addEventListener('keyup', onKey);
    el.addEventListener('scroll', hide);
    const onSelChange = () => { if (window.getSelection()?.isCollapsed) hide(); };
    document.addEventListener('selectionchange', onSelChange);
    return () => {
      el.removeEventListener('mouseup', onUp); el.removeEventListener('keyup', onKey); el.removeEventListener('scroll', hide);
      document.removeEventListener('selectionchange', onSelChange);
    };
  }, [container]);
  if (!sel) return null;
  const add = () => {
    const id = `an${++seq}`;
    const raw = sel.range.toString();
    const pos = container.current ? offsetIn(container.current, sel.range) : -1;
    setList(taskId, (l) => [...l, { id, text: clipSelection(sel.text), comment: '', range: sel.range, raw: raw.length > 4000 ? '' : raw, pos }]);
    window.getSelection()?.removeAllRanges();
    setSel(null);
    openEditor(taskId, id, true);
  };
  return (
    <div className="sel-menu" role="toolbar" aria-label="选中内容的操作" style={{ left: sel.x, top: sel.y }}
      onMouseDown={(e) => e.preventDefault()}>
      <button type="button" onClick={add}>添加到对话</button>
      {sideChat ? <button type="button" disabled title="侧边聊天在后续阶段提供">在侧边聊天中提问</button> : null}
    </div>
  );
}

/** 输入框上方的“N 条注释”：悬停或点开看列表，每条可以修改、删除；× 清空全部 */
export function AnnotationChip({ taskId }: { taskId: string }) {
  const list = useAnnotations(taskId);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  useEffect(() => { if (!list.length) setOpen(false); }, [list.length]);
  if (!list.length) return null;
  const enter = () => { window.clearTimeout(timer.current); setOpen(true); };
  const leave = () => { timer.current = window.setTimeout(() => setOpen(false), 250); };
  const edit = (a: Annotation) => {
    setOpen(false);
    if (alive(a.range)) a.range.startContainer.parentElement?.scrollIntoView({ block: 'center' });
    requestAnimationFrame(() => openEditor(taskId, a.id));
  };
  return (
    <div className="anno-chip-wrap" ref={wrap} onMouseEnter={enter} onMouseLeave={leave}>
      <div className="anno-chip">
        <button type="button" className="anno-chip-main" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}>
          <Icon name="chat" size={13} />{list.length} 条注释
        </button>
        <button type="button" className="anno-chip-x" aria-label="清空全部注释" title="清空全部注释" onClick={() => clearAnnotations(taskId)}><Icon name="x" size={12} /></button>
      </div>
      {open ? (
        <div className="anno-list" role="dialog" aria-label="这条消息附带的注释">
          {list.map((a, i) => (
            <div className="anno-item" key={a.id}>
              <span className="n">{i + 1}.</span>
              <div className="body">
                <div className="lbl">所选文本：</div>
                <div className="quote">{a.text}</div>
                {a.comment ? <><div className="lbl">用户评论：</div><div>{a.comment}</div></> : null}
              </div>
              <div className="acts">
                <button type="button" className="btn ghost icon sm" aria-label={`修改注释 ${i + 1}`} title={alive(a.range) ? '修改' : '原文已不在页面上，只能删除'} disabled={!alive(a.range)} onClick={() => edit(a)}><Icon name="edit" /></button>
                <button type="button" className="btn ghost icon sm" aria-label={`删除注释 ${i + 1}`} title="删除" onClick={() => removeAnnotation(taskId, a.id)}><Icon name="trash" /></button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
