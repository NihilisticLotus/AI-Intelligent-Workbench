import type { AccessOperation } from '@aic/protocol';
import type { Services } from '../services';
import { Errors, toApiError } from '../util';
import { isLocalRequest, type Ctx } from './app';

export function requireLocal(c: Ctx, message: string) {
  if (!isLocalRequest(c)) throw Errors.forbidden(message);
}

export function confirmRemote(c: Ctx, s: Services, operation: AccessOperation, objectId?: string) {
  const device = c.get('device');
  return s.accessConfirmation.require({ id: device.id, name: device.name, ip: c.get('ip'), remote: !isLocalRequest(c) },
    operation, objectId, c.req.raw.signal);
}

export async function auditAccess<T>(c: Ctx, s: Services, action: string, objectId: string | undefined, run: () => T | Promise<T>): Promise<T> {
  const actor = { id: c.get('device')?.id ?? null, ip: c.get('ip') || null };
  try {
    const result = await run();
    s.accessAudit.write(action, actor, 'ok', objectId);
    return result;
  } catch (error) {
    s.accessAudit.write(action, actor, toApiError(error).status === 403 ? 'denied' : 'failed', objectId);
    throw error;
  }
}
