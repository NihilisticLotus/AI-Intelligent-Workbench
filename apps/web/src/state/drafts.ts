// 任务草稿：输入框里没发出去的文字和注释，按任务存在 Gateway（GET / PUT /tasks/:id/draft，design.md 15.2）。
// 刷新、切换任务、换设备打开都在。改动后约 0.8 秒保存一次；离开页面前立即保存。
// 老 Gateway 没有 tasks.draft 功能时只在本页内存里保留（和以前一样）。
import { FeatureKey, type DraftAnnotation, type TaskDraft } from '@aic/protocol';
import { api, appStore } from './app';

const SAVE_DELAY = 800;
const local = new Map<string, { text: string; annotations: DraftAnnotation[] }>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const loaded = new Map<string, Promise<TaskDraft | null>>();

const enabled = () => !!appStore.get().hello?.features[FeatureKey.Drafts];

/** 本页内存里的草稿（同步，挂载输入框时先用它，避免闪一下空白） */
export function localDraft(taskId: string) { return local.get(taskId) ?? null; }

/** 从 Gateway 读草稿（每个任务每次打开页面只读一次）；读不到返回 null */
export function loadDraft(taskId: string): Promise<TaskDraft | null> {
  if (!enabled()) return Promise.resolve(null);
  let p = loaded.get(taskId);
  if (!p) {
    p = api.getDraft(taskId).catch(() => null);
    loaded.set(taskId, p);
  }
  return p;
}

async function flush(taskId: string) {
  timers.delete(taskId);
  const d = local.get(taskId);
  if (!d || !enabled()) return;
  try {
    const r = await api.putDraft(taskId, d);
    loaded.set(taskId, Promise.resolve(r));
  } catch { /* 保存失败不打扰用户：内存里还在，下次改动再试 */ }
}

/** 记下最新草稿，稍后保存 */
export function saveDraft(taskId: string, d: { text: string; annotations: DraftAnnotation[] }) {
  local.set(taskId, d);
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
  const ids = taskId ? [taskId] : [...timers.keys()];
  return Promise.all(ids.map((id) => { const t = timers.get(id); if (t) clearTimeout(t); return flush(id); }));
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => { void flushNow(); });
}
