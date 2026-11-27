// 监控概览、调用账本与花费/Token 上限阀门路由（全部走 /api/v1，写操作仅限本机电脑）。
import { Hono } from 'hono';
import { UpsertUsageCapBody } from '@aic/protocol';
import type { Services } from '../services';
import { readBody, type Env } from './app';
import { requireLocal } from './access-guard';

export function monitorRoutes(s: Services) {
  const r = new Hono<Env>();

  r.get('/monitor/overview', async (c) => c.json(await s.monitor.overview()));

  r.get('/monitor/caps', (c) => c.json({ items: s.monitor.evaluateCaps(), nextCursor: null }));

  r.put('/monitor/caps', async (c) => {
    requireLocal(c, '请在这台电脑上修改监控上限设置');
    const body = await readBody(c, UpsertUsageCapBody);
    return c.json(s.monitor.upsertRule(body));
  });

  r.delete('/monitor/caps/:id', (c) => {
    requireLocal(c, '请在这台电脑上删除监控上限设置');
    s.monitor.deleteRule(c.req.param('id'));
    return c.json({ ok: true });
  });

  return r;
}
