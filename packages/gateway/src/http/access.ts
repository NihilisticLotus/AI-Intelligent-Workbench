import { Hono } from 'hono';
import { AccessAuditQuery, AccessConfirmDecision, AccessConfirmId, PutLanBody } from '@aic/protocol';
import type { AuditResult } from '@aic/protocol';
import type { Services } from '../services';
import { Errors } from '../util';
import { auditAccess, requireLocal } from './access-guard';
import { parseQuery, readBody, type Ctx, type Env } from './app';

function ruleAudit(c: Ctx, s: Services) {
  const actor = { id: c.get('device').id, ip: c.get('ip') };
  return (action: string, result: AuditResult) => s.accessAudit.write(`firewall.${action}`, actor, result);
}

export function accessRoutes(s: Services) {
  const r = new Hono<Env>();
  r.get('/access/lan', async (c) => c.json(await s.lan.state()));
  r.put('/access/lan', async (c) => {
    requireLocal(c, '请在这台电脑上管理局域网访问');
    const body = await readBody(c, PutLanBody);
    return c.json(await auditAccess(c, s, body.enabled ? 'lan.enable' : 'lan.disable', undefined, () => s.lan.put(body, ruleAudit(c, s))));
  });
  r.post('/access/lan/firewall', async (c) => {
    requireLocal(c, '请在这台电脑上管理局域网访问');
    return c.json(await auditAccess(c, s, 'firewall.update', undefined, () => s.lan.updateFirewall(ruleAudit(c, s))));
  });
  r.post('/access/confirmations/:id/decision', async (c) => {
    requireLocal(c, '只能在这台电脑上确认远程操作');
    const id = AccessConfirmId.safeParse(c.req.param('id'));
    if (!id.success) throw Errors.notFound('找不到这条确认请求');
    const { allow } = await readBody(c, AccessConfirmDecision);
    s.accessConfirmation.decide(id.data, allow);
    return c.json({ ok: true });
  });
  r.get('/access/audit', (c) => {
    const query = parseQuery(c, AccessAuditQuery);
    return c.json(s.accessAudit.list(query.cursor, query.limit));
  });
  return r;
}
