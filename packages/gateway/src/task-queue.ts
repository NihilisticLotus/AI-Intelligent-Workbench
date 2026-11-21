// 只管理内存中的等待顺序；释放名额时先占位再唤醒，取消不会释放别人的名额。
import { AbortError, Errors } from './util';

export class TaskQueue {
  private active = new Map<string, string[]>();
  private waiting = new Map<string, Array<{ id: string; start(): void; cancel(): void }>>();
  constructor(private limit: (key: string) => number, private changed: (key: string, ids: string[]) => void = () => {},
    private report: (message: string) => void = console.error) {}

  running(key: string) { return this.active.get(key)?.length ?? 0; }
  queued(key: string) { return this.waiting.get(key)?.length ?? 0; }
  position(id: string) {
    for (const [key, items] of this.waiting) {
      const index = items.findIndex(item => item.id === id);
      if (index >= 0) return { key, position: index + 1, total: items.length };
    }
    return undefined;
  }
  move(id: string, position: number) {
    const current = this.position(id);
    if (!current) throw Errors.invalidState('任务已不在等待队列，请刷新后查看');
    const items = this.waiting.get(current.key)!;
    if (!Number.isInteger(position) || position < 1 || position > items.length) throw Errors.badRequest('排队位置超出当前队列');
    const [item] = items.splice(current.position - 1, 1); items.splice(position - 1, 0, item!);
    try { this.notify(current.key); }
    catch (error) {
      items.splice(position - 1, 1);
      items.splice(current.position - 1, 0, item!);
      throw error;
    }
  }
  private notify(key: string, extra: string[] = []) {
    this.changed(key, [...new Set([...extra, ...(this.active.get(key) ?? []), ...(this.waiting.get(key)?.map(item => item.id) ?? [])])]);
  }
  private reserve(key: string, id: string) {
    const ids = this.active.get(key) ?? []; ids.push(id); this.active.set(key, ids);
  }
  private unreserve(key: string, id: string) {
    const ids = this.active.get(key);
    if (!ids) return;
    const index = ids.indexOf(id);
    if (index >= 0) ids.splice(index, 1);
    if (!ids.length) this.active.delete(key);
  }
  private release(key: string, id: string) {
    let released = false;
    return () => {
      if (released) return; released = true;
      this.unreserve(key, id);
      this.drain(key, [id]);
    };
  }
  drain(key: string, removed: string[] = []) {
    const items = this.waiting.get(key);
    while (items?.length && this.running(key) < this.limit(key)) {
      const item = items.shift()!; this.reserve(key, item.id); item.start();
    }
    if (!items?.length) this.waiting.delete(key);
    this.notifyAfterRemoval(key, removed);
  }
  private notifyAfterRemoval(key: string, removed: string[]) {
    // 名额已交给下一任务，通知失败也必须完成释放或取消。
    try { this.notify(key, removed); }
    catch { this.report('队列位置已更新，本次状态通知保存失败。'); }
  }
  async acquire(key: string, id: string, onQueued?: () => void, signal?: AbortSignal, wait = true, parkedSource = false): Promise<(() => void) | null> {
    if (signal?.aborted) throw new AbortError();
    if (this.position(id) || (!parkedSource && [...this.active.values()].some(ids => ids.includes(id)))) throw Errors.conflict('任务已经占用或等待名额');
    if (this.running(key) < this.limit(key)) {
      this.reserve(key, id);
      try { this.notify(key); }
      catch (error) { this.unreserve(key, id); throw error; }
      return this.release(key, id);
    }
    if (!wait) return null;
    await new Promise<void>((resolve, reject) => {
      const items = this.waiting.get(key) ?? []; this.waiting.set(key, items);
      const removeWaiter = () => {
        const index = items.indexOf(item);
        if (index < 0) return false;
        items.splice(index, 1);
        signal?.removeEventListener('abort', item.cancel);
        if (!items.length) this.waiting.delete(key);
        return true;
      };
      const item = { id,
        start: () => { signal?.removeEventListener('abort', item.cancel); resolve(); },
        cancel: () => {
          if (!removeWaiter()) return;
          reject(new AbortError());
          this.notifyAfterRemoval(key, [id]);
        },
      };
      items.push(item); signal?.addEventListener('abort', item.cancel, { once: true });
      try { onQueued?.(); this.notify(key); }
      catch (error) { removeWaiter(); reject(error); return; }
      if (signal?.aborted) item.cancel();
    });
    return this.release(key, id);
  }
}
