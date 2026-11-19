import { Hono } from 'hono';
import { PutLanBody } from '@aic/protocol';
import type { Services } from '../services';
import { Errors } from '../util';
import { isLocalRequest, readBody, type Ctx, type Env } from './app';

function requireLocalAccess(c: Ctx) {
  if (!isLocalRequest(c)) throw Errors.forbidden('请在这台电脑上管理局域网访问');
}

export function accessRoutes(s: Services) {
  const r = new Hono<Env>();
  r.get('/access/lan', async (c) => c.json(await s.lan.state()));
  r.put('/access/lan', async (c) => {
    requireLocalAccess(c);
    return c.json(await s.lan.put(await readBody(c, PutLanBody)));
  });
  r.post('/access/lan/firewall', async (c) => {
    requireLocalAccess(c);
    return c.json(await s.lan.updateFirewall());
  });
  return r;
}
