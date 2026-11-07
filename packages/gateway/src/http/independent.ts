// 独立目录配置只经统一鉴权 REST，不在这里调用上游或解密密钥。
import { Hono } from 'hono';
import { CreateIndependentServiceBody, PatchIndependentServiceBody, CreateIndependentModelBody, PatchIndependentModelBody, PatchIndependentOverridesBody, IndependentDefault } from '@aic/protocol';
import type { Services } from '../services';
import { readBody, type Env } from './app';

export function independentRoutes(s: Services) {
  const r = new Hono<Env>(); const catalog = s.independent;
  r.get('/independent/services', (c) => c.json({ items: catalog.listServices(), nextCursor: null }));
  r.post('/independent/services', async (c) => c.json(await catalog.createService(await readBody(c, CreateIndependentServiceBody), c.get('device').id), 201));
  r.get('/independent/services/:serviceId', (c) => c.json(catalog.getService(c.req.param('serviceId'))));
  r.patch('/independent/services/:serviceId', async (c) => c.json(await catalog.patchService(c.req.param('serviceId'), await readBody(c, PatchIndependentServiceBody), c.get('device').id)));
  r.delete('/independent/services/:serviceId', (c) => { catalog.deleteService(c.req.param('serviceId'), c.get('device').id); return c.json({ ok: true }); });
  r.get('/independent/services/:serviceId/models', (c) => c.json({ items: catalog.listModels(c.req.param('serviceId')), nextCursor: null }));
  r.post('/independent/services/:serviceId/models', async (c) => c.json(catalog.createModel(c.req.param('serviceId'), await readBody(c, CreateIndependentModelBody), c.get('device').id), 201));
  r.get('/independent/services/:serviceId/models/:modelId', (c) => c.json(catalog.getModel(c.req.param('serviceId'), c.req.param('modelId'))));
  r.patch('/independent/services/:serviceId/models/:modelId', async (c) => c.json(catalog.patchModel(c.req.param('serviceId'), c.req.param('modelId'), await readBody(c, PatchIndependentModelBody), c.get('device').id)));
  r.delete('/independent/services/:serviceId/models/:modelId', (c) => { catalog.deleteModel(c.req.param('serviceId'), c.req.param('modelId'), c.get('device').id); return c.json({ ok: true }); });
  r.patch('/independent/services/:serviceId/models/:modelId/overrides', async (c) => c.json(catalog.overrides(c.req.param('serviceId'), c.req.param('modelId'), await readBody(c, PatchIndependentOverridesBody), c.get('device').id)));
  r.get('/independent/default', (c) => c.json(catalog.getDefault()));
  r.put('/independent/default', async (c) => c.json(catalog.setDefault(await readBody(c, IndependentDefault), c.get('device').id)));
  return r;
}
