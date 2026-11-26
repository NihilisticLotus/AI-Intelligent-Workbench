// 独立目录经统一鉴权 REST；元数据网络和解密由独立发现服务处理。
import { Hono } from 'hono';
import { CreateIndependentServiceBody, PatchIndependentServiceBody, CreateIndependentModelBody, PatchIndependentModelBody, PatchIndependentOverridesBody, IndependentDefault, IndependentNetworkSettings, DiscoverIndependentModelsBody, ImportIndependentModelsBody } from '@aic/protocol';
import type { Services } from '../services';
import { readBody, type Env } from './app';
import { requireLocal } from './access-guard';

const LOCAL_KEY = '请在这台电脑上填写或修改 Key 与授权地址';

export function independentRoutes(s: Services) {
  const r = new Hono<Env>(); const catalog = s.independent;
  r.get('/independent/services', (c) => c.json({ items: catalog.listServices(), nextCursor: null }));
  r.post('/independent/services', async (c) => {
    requireLocal(c, LOCAL_KEY);
    const body = await readBody(c, CreateIndependentServiceBody);
    return c.json(await catalog.createService(body, c.get('device').id), 201);
  });
  r.get('/independent/services/:serviceId', (c) => c.json(catalog.getService(c.req.param('serviceId'))));
  r.patch('/independent/services/:serviceId', async (c) => {
    const id = c.req.param('serviceId');
    const body = await readBody(c, PatchIndependentServiceBody);
    const service = catalog.getService(id);
    if (body.apiKey !== undefined || (body.baseUrl !== undefined && body.baseUrl !== service.baseUrl) ||
      (body.authentication !== undefined && body.authentication !== service.authentication) ||
      (body.protocol !== undefined && body.protocol !== service.protocol)) requireLocal(c, LOCAL_KEY);
    return c.json(await catalog.patchService(id, body, c.get('device').id));
  });
  r.delete('/independent/services/:serviceId', (c) => {
    requireLocal(c, LOCAL_KEY);
    const id = c.req.param('serviceId');
    catalog.deleteService(id, c.get('device').id);
    return c.json({ ok: true });
  });
  r.get('/independent/services/:serviceId/models', (c) => c.json({ items: catalog.listModels(c.req.param('serviceId')), nextCursor: null }));
  r.get('/independent/services/:serviceId/discovery', (c) => c.json(s.independentDiscovery.state(c.req.param('serviceId'))));
  r.post('/independent/services/:serviceId/discovery', async (c) => c.json(await s.independentDiscovery.refresh(c.req.param('serviceId'),await readBody(c, DiscoverIndependentModelsBody))));
  r.post('/independent/services/:serviceId/models/import', async (c) => c.json(s.independentDiscovery.import(c.req.param('serviceId'),await readBody(c, ImportIndependentModelsBody),c.get('device').id)));
  r.post('/independent/services/:serviceId/models', async (c) => c.json(catalog.createModel(c.req.param('serviceId'), await readBody(c, CreateIndependentModelBody), c.get('device').id), 201));
  r.get('/independent/services/:serviceId/models/:modelId', (c) => c.json(catalog.getModel(c.req.param('serviceId'), c.req.param('modelId'))));
  r.patch('/independent/services/:serviceId/models/:modelId', async (c) => c.json(catalog.patchModel(c.req.param('serviceId'), c.req.param('modelId'), await readBody(c, PatchIndependentModelBody), c.get('device').id)));
  r.delete('/independent/services/:serviceId/models/:modelId', (c) => { catalog.deleteModel(c.req.param('serviceId'), c.req.param('modelId'), c.get('device').id); return c.json({ ok: true }); });
  r.patch('/independent/services/:serviceId/models/:modelId/overrides', async (c) => c.json(catalog.overrides(c.req.param('serviceId'), c.req.param('modelId'), await readBody(c, PatchIndependentOverridesBody), c.get('device').id)));
  r.get('/independent/default', (c) => c.json(catalog.getDefault()));
  r.put('/independent/default', async (c) => { requireLocal(c, LOCAL_KEY); return c.json(catalog.setDefault(await readBody(c, IndependentDefault), c.get('device').id)); });
  r.get('/independent/network', (c) => c.json(catalog.getNetwork()));
  r.put('/independent/network', async (c) => { requireLocal(c, LOCAL_KEY); return c.json(catalog.setNetwork(await readBody(c, IndependentNetworkSettings), c.get('device').id)); });
  return r;
}
