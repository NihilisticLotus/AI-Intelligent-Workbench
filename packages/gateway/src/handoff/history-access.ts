import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { McpServerSpec } from '@aic/adapters';
import type { HistoryGrant } from '@aic/protocol';
import type { Db } from '../db';
import type { EventBus } from '../events';
import { Errors } from '../util';

const fingerprint = (token: string) => createHash('sha256').update(token).digest('hex');

/** 内存中只保存令牌摘要。进程重启、会话结束和任务删除都会使原授权失效。 */
export class HistoryAccess {
  private grants = new Map<string, HistoryGrant>();

  constructor(private db: Db, private port: () => number, events: EventBus) {
    events.on(event => {
      if (event.type === 'session.ended' && event.sessionId) this.revoke(event.sessionId);
      if (event.type === 'task.deleted') {
        for (const [key, grant] of this.grants) {
          if (grant.taskId === event.data.id) this.grants.delete(key);
        }
      }
    });
  }

  serverFor(grant: HistoryGrant): McpServerSpec {
    const handoff = this.db.get('SELECT id FROM handoffs WHERE id=? AND task_id=?', grant.handoffId, grant.taskId);
    if (!handoff) throw Errors.notFound('没有本任务的交接记录');
    this.revoke(grant.sessionId);
    const token = randomBytes(32).toString('base64url');
    this.grants.set(fingerprint(token), { ...grant });
    return {
      name: 'aic-history', command: process.execPath,
      args: [fileURLToPath(new URL('./history-mcp.mjs', import.meta.url))],
      env: [{ name: 'AIC_HISTORY_PORT', value: String(this.port()) }, { name: 'AIC_HISTORY_TOKEN', value: token }],
    };
  }

  revoke(sessionId: string) {
    for (const [key, grant] of this.grants) {
      if (grant.sessionId === sessionId) this.grants.delete(key);
    }
  }

  authenticate(header: string | undefined): HistoryGrant {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header ?? '');
    const grant = match && this.grants.get(fingerprint(match[1]!));
    const active = grant && this.db.get(
      `SELECT 1 FROM sessions s JOIN handoffs h ON h.id=s.handoff_id AND h.task_id=s.task_id
       JOIN tasks t ON t.id=s.task_id WHERE s.id=? AND s.task_id=? AND s.handoff_id=? AND s.status='active'`,
      grant.sessionId, grant.taskId, grant.handoffId,
    );
    if (!grant || !active) throw Errors.unauthorized('历史查询会话无效或已经结束');
    return grant;
  }
}
