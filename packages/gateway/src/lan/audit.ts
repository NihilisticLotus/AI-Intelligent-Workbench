import { AuditResult, type AccessAuditEntry } from '@aic/protocol';
import type { Db } from '../db';

const EARLIEST_DAYS = 90;
const DAY = 24 * 60 * 60_000;

export interface AuditActor { id: string | null; ip: string | null }

/** 只留工作台生成的对象编号，不把用户输入的路径、正文或待领取的配对编号写进审计。 */
export function auditObjectId(value: string | null | undefined): string | null {
  return value && /^[a-z][a-z0-9]{0,20}_[A-Za-z0-9_-]{12}$/.test(value) ? value : null;
}

export class AccessAudit {
  constructor(private readonly db: Db, private readonly log: (message: string) => void) {}

  write(action: string, actor: AuditActor, result: AuditResult, objectId?: string | null) {
    try {
      this.db.run('INSERT INTO audit_log (device_id, action, detail, ts) VALUES (?, ?, ?, ?)',
        actor.id, `access.${action}`, JSON.stringify({ objectId: auditObjectId(objectId), ip: actor.ip, result }), Date.now());
    } catch { this.log('写入访问审计失败'); }
  }

  prune() {
    try { this.db.run("DELETE FROM audit_log WHERE action GLOB 'access.*' AND ts < ?", Date.now() - EARLIEST_DAYS * DAY); }
    catch { this.log('清理过期审计日志失败'); }
  }

  list(cursor: number | undefined, limit: number): { items: AccessAuditEntry[]; nextCursor: string | null } {
    const rows = this.db.all<{ id: number; ts: number; action: string; device_id: string | null; detail: string }>(`
      SELECT id, ts, action, device_id, detail FROM audit_log
      WHERE action GLOB 'access.*' AND ts >= ? AND id < ? ORDER BY id DESC LIMIT ?`,
    Date.now() - EARLIEST_DAYS * DAY, cursor ?? Number.MAX_SAFE_INTEGER, limit + 1);
    const page = rows.slice(0, limit);
    const items = page.flatMap((row): AccessAuditEntry[] => {
      try {
        const data: unknown = JSON.parse(row.detail);
        if (!data || typeof data !== 'object' || !('result' in data)) return [];
        const result = AuditResult.safeParse(data.result);
        if (!result.success) return [];
        return [{ id: String(row.id), action: row.action.slice('access.'.length), at: row.ts, deviceId: row.device_id,
          objectId: 'objectId' in data && typeof data.objectId === 'string' ? auditObjectId(data.objectId) : null,
          ip: 'ip' in data && typeof data.ip === 'string' ? data.ip : null, result: result.data }];
      } catch { return []; }
    });
    return { items, nextCursor: rows.length > limit ? String(page.at(-1)!.id) : null };
  }
}
