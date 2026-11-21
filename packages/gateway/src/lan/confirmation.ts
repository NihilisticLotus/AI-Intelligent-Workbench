import { ErrorCode, type AccessConfirmOutcome, type AccessConfirmRequest, type AccessOperation } from '@aic/protocol';
import type { Db } from '../db';
import type { AuthService } from '../auth';
import type { EventStore } from '../events';
import { AppError, Errors, newId } from '../util';
import { type AccessAudit, auditObjectId } from './audit';
import type { LanPairing } from './pairing';

export interface AccessActor { id: string; name: string; ip: string; remote: boolean }

interface Pending {
  seq: number;
  request: AccessConfirmRequest;
  actor: AccessActor;
  timer: ReturnType<typeof setTimeout>;
  complete: (result: AccessConfirmOutcome) => void;
  detach: () => void;
}

export class AccessConfirmation {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly db: Db, private readonly auth: AuthService, private readonly events: EventStore,
    private readonly pairing: LanPairing, private readonly audit: AccessAudit, private readonly log: (message: string) => void,
    private readonly timeoutMs = 120_000) {
    pairing.onNoLocalPage(() => this.cancelAll());
    auth.onRevoke((id) => {
      for (const entry of this.pending.values()) if (entry.actor.id === id) this.resolve(entry, 'unavailable');
    });
  }

  async require(actor: AccessActor, operation: AccessOperation, rawId?: string, signal?: AbortSignal): Promise<void> {
    if (!actor.remote) return;
    const objectId = auditObjectId(rawId);
    if (signal?.aborted || !this.pairing.hasLocalPage()) {
      this.audit.write(`confirm.${operation}`, actor, 'unavailable', objectId);
      throw this.rejected('unavailable');
    }
    if (this.pending.size >= 64) throw Errors.rateLimited('电脑上待确认的操作太多', '请先处理已有请求');
    const id = newId('access');
    const request = { id, operation, objectId, objectName: this.objectName(operation, objectId),
      deviceId: actor.id, deviceName: actor.name, ip: actor.ip, expiresAt: Date.now() + this.timeoutMs };
    const result = await new Promise<AccessConfirmOutcome>((complete, reject) => {
      const onAbort = () => { const entry = this.pending.get(id); if (entry) this.resolve(entry, 'unavailable'); };
      const timer = setTimeout(() => { const entry = this.pending.get(id); if (entry) this.resolve(entry, 'expired'); }, this.timeoutMs);
      timer.unref();
      const entry = { seq: 0, request, actor, complete, timer, detach: () => signal?.removeEventListener('abort', onAbort) };
      this.pending.set(id, entry);
      signal?.addEventListener('abort', onAbort, { once: true });
      try { entry.seq = this.events.append({ taskId: null, sessionId: null, type: 'access.confirm_requested', data: request }).seq; }
      catch (error) { this.take(entry); reject(error); }
    });
    if (result !== 'allowed') throw this.rejected(result);
    const device = this.auth.deviceRow(actor.id);
    if (signal?.aborted || !device || device.revoked) throw this.rejected('unavailable');
  }

  decide(id: string, allow: boolean) {
    const entry = this.pending.get(id);
    if (!entry) throw Errors.invalidState('这条确认请求已处理或已失效');
    if (entry.request.expiresAt <= Date.now()) {
      this.resolve(entry, 'expired');
      throw Errors.invalidState('这条确认请求已超时');
    }
    this.resolve(entry, allow ? 'allowed' : 'denied');
  }

  isPending(id: string): boolean {
    const request = this.pending.get(id)?.request;
    return !!request && request.expiresAt > Date.now();
  }

  cancelAll() {
    for (const entry of this.pending.values()) this.resolve(entry, 'unavailable');
  }

  pendingPrompts() {
    return [...this.pending.values()].filter(entry => this.isPending(entry.request.id))
      .map(entry => ({ seq: entry.seq, prompt: { kind: 'operation' as const, request: entry.request } }));
  }

  private take(entry: Pending) {
    this.pending.delete(entry.request.id);
    clearTimeout(entry.timer);
    entry.detach();
  }

  private resolve(entry: Pending, result: AccessConfirmOutcome) {
    this.take(entry);
    const { id, objectId, operation } = entry.request;
    this.audit.write(`confirm.${operation}`, entry.actor, result, objectId);
    try { this.events.append({ taskId: null, sessionId: null, type: 'access.confirm_resolved', data: { id, result } }); }
    catch { this.log('无法记录远程确认结果'); }
    entry.complete(result);
  }

  private rejected(result: Exclude<AccessConfirmOutcome, 'allowed'>) {
    const hint = { denied: '电脑上已拒绝这项操作', expired: '两分钟内没有收到电脑确认', unavailable: '请在电脑上打开已连接的工作台后再试' }[result];
    return new AppError(409, { code: ErrorCode.AccessConfirmationRequired, message: '请在电脑上确认', hint, actions: [] });
  }

  private objectName(operation: AccessOperation, id: string | null): string | null {
    if (!id) return null;
    if (operation === 'device.revoke') return this.auth.deviceName(id);
    if (operation === 'project.permissions' && id.startsWith('a_')) {
      return this.db.get<{ name: string }>('SELECT p.name FROM approvals a JOIN tasks t ON a.task_id = t.id JOIN projects p ON t.project_id = p.id WHERE a.id = ?', id)?.name ?? null;
    }
    if (operation.startsWith('project.') || operation === 'task.permission' && id.startsWith('p_')) {
      return this.db.get<{ name: string }>('SELECT name FROM projects WHERE id = ?', id)?.name ?? null;
    }
    return this.db.get<{ title: string }>('SELECT title FROM tasks WHERE id = ?', id)?.title ?? null;
  }
}
