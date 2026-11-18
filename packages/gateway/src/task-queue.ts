// 只管理内存中的等待顺序；释放名额时先占位再唤醒，取消不会释放别人的名额。
import { AbortError, Errors } from './util';

export class TaskQueue {
  private active = new Map<string, string[]>();
  private waiting = new Map<string, Array<{ id: string; start(): void; cancel(): void }>>();
  constructor(private limit: (key: string) => number, private changed: (key: string, ids: string[]) => void = () => {}) {}

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
    this.notify(current.key);
  }
  private notify(key: string, extra: string[] = []) {
    this.changed(key, [...new Set([...extra, ...(this.active.get(key) ?? []), ...(this.waiting.get(key)?.map(item => item.id) ?? [])])]);
  }
  private reserve(key: string, id: string) {
    const ids = this.active.get(key) ?? []; ids.push(id); this.active.set(key, ids);
  }
  private release(key: string, id: string) {
    let released = false;
    return () => {
      if (released) return; released = true;
      const ids = this.active.get(key);
      if (ids) {
        const index = ids.indexOf(id);
        if (index >= 0) ids.splice(index,1);
        if (!ids.length) this.active.delete(key);
      }
      this.drain(key); this.notify(key, [id]);
    };
  }
  drain(key: string) {
    const items = this.waiting.get(key);
    while (items?.length && this.running(key) < this.limit(key)) {
      const item = items.shift()!; this.reserve(key, item.id); item.start();
    }
    if (!items?.length) this.waiting.delete(key);
    this.notify(key);
  }
  async acquire(key: string, id: string, onQueued?: () => void, signal?: AbortSignal, wait = true, parkedSource = false): Promise<(() => void) | null> {
    if (signal?.aborted) throw new AbortError();
    if (this.position(id) || (!parkedSource && [...this.active.values()].some(ids => ids.includes(id)))) throw Errors.conflict('任务已经占用或等待名额');
    if (this.running(key) < this.limit(key)) { this.reserve(key, id); this.notify(key); return this.release(key, id); }
    if (!wait) return null;
    await new Promise<void>((resolve, reject) => {
      const items = this.waiting.get(key) ?? []; this.waiting.set(key, items);
      const item = { id,
        start: () => { signal?.removeEventListener('abort', item.cancel); resolve(); },
        cancel: () => {
          const index = items.indexOf(item); if (index < 0) return;
          items.splice(index, 1); signal?.removeEventListener('abort', item.cancel);
          if (!items.length) this.waiting.delete(key);
          this.notify(key, [id]); reject(new AbortError());
        },
      };
      items.push(item); signal?.addEventListener('abort', item.cancel, { once: true });
      onQueued?.(); this.notify(key);
      if (signal?.aborted) item.cancel();
    });
    return this.release(key, id);
  }
}
