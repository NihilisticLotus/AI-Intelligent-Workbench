// 事件库（只追加，seq 全局递增）+ 事件总线。
// 顺序固定：先写库，再推送。这样断线补发时数据一定一致（design.md 10.2）。
import { EventEnvelope, type NewEvent } from '@aic/protocol';
import type { Db } from './db';
import { now } from './util';
import { errorLogText } from './error-log';

export type Listener = (e: EventEnvelope) => void;

export class EventBus {
  private listeners = new Set<Listener>();
  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
  emit(e: EventEnvelope) {
    for (const fn of this.listeners) {
      // 某个订阅者出错不影响其他订阅者，也不影响写库
      try { fn(e); } catch (err) { console.error('[events] 订阅者处理事件出错', errorLogText(err)); }
    }
  }
}

type EventRow = { seq: number; task_id: string | null; session_id: string | null; type: string; payload: string; ts: number };

function rowToEvent(r: EventRow): EventEnvelope {
  return { seq: r.seq, ts: r.ts, taskId: r.task_id, sessionId: r.session_id, type: r.type, data: JSON.parse(r.payload) } as EventEnvelope;
}

export class EventStore {
  constructor(private db: Db, readonly bus: EventBus) {}

  /** 同步写库、分配 seq，再交给总线分发 */
  append(input: NewEvent): EventEnvelope {
    const ev = this.persist(input);
    this.db.afterCommit(() => this.bus.emit(ev));
    return ev;
  }

  /** 供业务事务使用：先与业务一起提交，再由调用方推送 bus，回滚时不能提前通知。 */
  persist(input: NewEvent): EventEnvelope {
    const ts = input.ts ?? now();
    const { seq: _s, ts: _t, ...rest } = input as NewEvent & { seq?: number };
    // 边界校验：写进库里的每个事件都必须符合协议（seq 先用占位值 1 校验）
    const checked = EventEnvelope.parse({ ...rest, ts, seq: 1 });
    const r = this.db.run(
      'INSERT INTO events (task_id, session_id, type, payload, ts) VALUES (?, ?, ?, ?, ?)',
      checked.taskId, checked.sessionId, checked.type, JSON.stringify(checked.data), ts,
    );
    const ev = { ...checked, seq: r.lastInsertRowid } as EventEnvelope;
    return ev;
  }

  /** 读取 seq > after 的事件；taskId 给定时只读该任务 */
  read(opts: { after: number; limit: number; taskId?: string }): EventEnvelope[] {
    const rows = opts.taskId
      ? this.db.all<EventRow>('SELECT * FROM events WHERE task_id = ? AND seq > ? ORDER BY seq LIMIT ?', opts.taskId, opts.after, opts.limit)
      : this.db.all<EventRow>('SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?', opts.after, opts.limit);
    return rows.map(rowToEvent);
  }

  lastSeq(): number {
    return Number(this.db.get<{ m: number | null }>('SELECT MAX(seq) AS m FROM events')?.m ?? 0);
  }
}
