// 任务草稿：输入框里没发出去的文字和注释，按任务存在 Gateway（GET / PUT /tasks/:id/draft，design.md 15.2）。
// 刷新、切换任务、换设备打开都在。改动后约 0.8 秒保存一次；离开页面前立即保存。
// 老 Gateway 没有 tasks.draft 功能时只在本页内存里保留（和以前一样）。
import { FeatureKey, type PutTaskDraftBody, type TaskDraft } from '@aic/protocol';
import { api, appStore } from './app';

const SAVE_DELAY = 800;
const local = new Map<string, PutTaskDraftBody>();
const confirmed = new Map<string, PutTaskDraftBody>();
// 原稿尚未读回时，本页输入先独立保留。离开任务也不会把未恢复的字段当成空值写回。
const edits = new Map<string, Partial<PutTaskDraftBody>>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const loaded = new Map<string, Promise<TaskDraft | null>>();
const writing = new Map<string, Promise<void>>();
let generation = 0;

const enabled = () => !!appStore.get().hello?.features[FeatureKey.Drafts];

/** 本页内存里的草稿（同步，挂载输入框时先用它，避免闪一下空白） */
export function localDraft(taskId: string) { return local.get(taskId) ?? null; }

export function pendingDraftEdits(taskId: string) { return edits.get(taskId); }
export function keepDraftEdits(taskId: string, changes: Partial<PutTaskDraftBody>) {
  edits.set(taskId, { ...edits.get(taskId), ...changes });
}

/** 同时打开合并读取，重新进入则读取其他设备可能保存的新内容。 */
export function loadDraft(taskId: string): Promise<TaskDraft | null> {
  if (!enabled()) return Promise.resolve(null);
  const pending = local.get(taskId);
  if (pending) return Promise.resolve({ ...pending, updatedAt: null });
  let p = loaded.get(taskId);
  if (!p) {
    const version = generation;
    p = api.getDraft(taskId).then(draft => {
      if (version === generation && !local.has(taskId)) confirmed.set(taskId, draft);
      return draft;
    }).finally(() => { if (loaded.get(taskId) === p) loaded.delete(taskId); });
    loaded.set(taskId, p);
  }
  return p;
}

function flush(taskId: string): Promise<void> {
  timers.delete(taskId);
  const active = writing.get(taskId);
  if (active) return active;
  const version = generation;
  const save = async () => {
    while (version === generation && enabled()) {
      const draft = local.get(taskId);
      if (!draft) return;
      try { await api.putDraft(taskId, draft); }
      catch {
        if (local.get(taskId) !== draft) continue;
        return; // 保留这一版，下一次编辑或离开页面时重试。
      }
      if (version !== generation) return;
      confirmed.set(taskId, draft);
      if (local.get(taskId) === draft) { local.delete(taskId); return; }
    }
  };
  const pending = save().finally(() => { if (writing.get(taskId) === pending) writing.delete(taskId); });
  writing.set(taskId, pending);
  return pending;
}

function sameDraft(a: PutTaskDraftBody | undefined, b: PutTaskDraftBody) {
  return a?.text === b.text && JSON.stringify(a.attachments ?? []) === JSON.stringify(b.attachments ?? [])
    && a.annotations.length === b.annotations.length && a.annotations.every((x, i) => {
      const y = b.annotations[i]!;
      return x.id === y.id && x.text === y.text && x.comment === y.comment && (x.raw ?? x.text) === (y.raw ?? y.text) && (x.pos ?? -1) === (y.pos ?? -1);
    });
}

/** 记下最新草稿，稍后保存 */
export function saveDraft(taskId: string, d: PutTaskDraftBody) {
  edits.delete(taskId);
  if (!local.has(taskId) && sameDraft(confirmed.get(taskId), d)) return;
  local.set(taskId, d);
  if (!enabled()) return;
  const t = timers.get(taskId);
  if (t) clearTimeout(t);
  timers.set(taskId, setTimeout(() => void flush(taskId), SAVE_DELAY));
}

/** 发送成功后清空（立即保存空草稿，Gateway 会删除这条记录） */
export function clearDraft(taskId: string) {
  saveDraft(taskId, { text: '', annotations: [] });
  void flushNow(taskId);
}

export function flushNow(taskId?: string) {
  const ids = taskId ? [taskId] : [...local.keys()];
  return Promise.all(ids.map((id) => { const t = timers.get(id); if (t) clearTimeout(t); return flush(id); }));
}

export function discardSessionDrafts() {
  generation++;
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear(); loaded.clear(); writing.clear(); local.clear(); confirmed.clear(); edits.clear();
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => { void flushNow(); });
}
