// Agent 与账号（phase-1.md 6.6.2）。请求体里的 apiKey 只在这里出现一次，交给 ProfileService 立即加密，不进日志、不进审计详情。
import { Hono } from 'hono';
import {
  AgentKind, AgentLoginBody, AgentLoginCodeBody, AgentTestBody, CreateProfileBody, PatchAgentBody, PatchProfileBody, ProfilesQuery,
  type AgentLoginResult, type DeleteProfileResult, type OkResult, RedetectResult,
} from '@aic/protocol';
import type { z } from 'zod';
import type { Services } from '../services';
import { Errors } from '../util';
import { parseQuery, readBody, type Ctx, type Env } from './app';
import { requireLocal } from './access-guard';
import { MetadataHttpError, readMetadataJson, type AddressPolicy } from '../independent/metadata-http';

const LOCAL_LOGIN = '请在这台电脑上登录第三方 Agent';
const LOCAL_KEY = '请在这台电脑上填写或修改 Key 与授权地址';

const kindOf = (c: Ctx) => {
  const r = AgentKind.safeParse(c.req.param('kind'));
  if (!r.success) throw Errors.notFound('没有这个 Agent');
  if (r.data === 'independent') throw Errors.badRequest('独立 Agent 的 API 与模型请在工作台自有服务中配置');
  return r.data;
};

export function agentRoutes(s: Services) {
  const r = new Hono<Env>();

  // 读缓存，不触发探测（第一次请求时等待启动检测完成）
  r.get('/agents', async (c) => c.json({ items: [...await s.agentSvc.list(), s.independentRuntime.info()], nextCursor: null }));

  r.post('/agents/redetect', async (c) => {
    const out: z.infer<typeof RedetectResult> = { items: [...await s.agentSvc.redetect(), s.independentRuntime.info()] };
    return c.json(out);
  });

  r.patch('/agents/:kind', async (c) => {
    requireLocal(c, '请在这台电脑上修改 Agent 设置');
    return c.json(await s.agentSvc.patch(kindOf(c), await readBody(c, PatchAgentBody)));
  });

  r.post('/agents/:kind/login', async (c) => {
    requireLocal(c, LOCAL_LOGIN);
    const kind = kindOf(c);
    const out: z.infer<typeof AgentLoginResult> = await s.agentSvc.login(kind, await readBody(c, AgentLoginBody), c.get('device').id);
    return c.json(out, 202);
  });

  r.post('/agents/:kind/login/:loginId/cancel', (c) => {
    requireLocal(c, LOCAL_LOGIN);
    s.agentSvc.cancelLogin(kindOf(c), c.req.param('loginId'));
    return c.json({ ok: true } satisfies OkResult);
  });

  r.post('/agents/:kind/login/:loginId/code', async (c) => {
    requireLocal(c, LOCAL_LOGIN);
    const kind = kindOf(c);
    const body = await readBody(c, AgentLoginCodeBody);
    s.agentSvc.submitCode(kind, c.req.param('loginId'), body.code);
    return c.json({ ok: true } satisfies OkResult);
  });

  r.post('/agents/:kind/test', async (c) => {
    requireLocal(c, '请在这台电脑上测试 Agent 连接');
    const kind = kindOf(c);
    const ct = c.req.header('content-type') ?? '';
    const body = ct ? await readBody(c, AgentTestBody) : {};
    return c.json(await s.agentSvc.test(kind, body));
  });

  // ---------- 账号 ----------

  r.get('/profiles', (c) => {
    const q = parseQuery(c, ProfilesQuery);
    if (!q.agent) for (const a of s.agents.all()) if (a.real) s.profiles.ensureLocal(a.id);
    return c.json({ items: s.profiles.list(q.agent), nextCursor: null });
  });

  r.post('/profiles', async (c) => {
    const body = await readBody(c, CreateProfileBody);
    if (body.apiKey !== undefined) requireLocal(c, LOCAL_KEY);
    const p = await s.profiles.create(body, c.get('device').id);
    s.agentSvc.pushStatus(p.agent);
    return c.json(p, 201);
  });

  r.get('/profiles/:id', (c) => c.json(s.profiles.get(c.req.param('id'))));

  r.delete('/profiles/:id/secret', (c) => {
    requireLocal(c, LOCAL_KEY);
    const p = s.profiles.clearRetiredSecret(c.req.param('id'), (id) => s.tasks.profileInUse(id), c.get('device').id);
    return c.json(p);
  });

  r.patch('/profiles/:id', async (c) => {
    const id = c.req.param('id');
    const before = s.profiles.row(id);
    const body = await readBody(c, PatchProfileBody);
    if (body.apiKey !== undefined || (body.baseUrl !== undefined && body.baseUrl !== before.base_url) ||
      (body.authHeader !== undefined && body.authHeader !== (before.auth_header ?? 'x-api-key'))) requireLocal(c, LOCAL_KEY);
    if (body.configDir !== undefined && body.configDir !== before.config_dir && s.tasks.profileInUse(id)) {
      throw Errors.profileInUse('这个账号还有正在运行的会话', '请先停止使用这个账号的任务，再修改配置目录');
    }
    const p = await s.profiles.patch(id, body, c.get('device').id);
    // 改了密钥、地址或默认账号：能力缓存和登录状态都要重新检测
    if (body.apiKey !== undefined || body.baseUrl !== undefined || body.isDefault || body.configDir !== undefined) {
      s.db.run('DELETE FROM agent_caps WHERE profile_id = ?', id);
      if (body.isDefault || p.isDefault) await s.agentSvc.detect(p.agent, true).catch(() => {});
    }
    s.agentSvc.pushStatus(p.agent);
    return c.json(s.profiles.get(id));
  });

  r.delete('/profiles/:id', async (c) => {
    const id = c.req.param('id');
    const row = s.profiles.row(id);
    if (row.secret_id) requireLocal(c, LOCAL_KEY);
    const out = s.profiles.delete(id, (pid) => s.tasks.profileInUse(pid), c.get('device').id);
    if (row.is_default) await s.agentSvc.detect(row.agent, true).catch(() => {});
    s.agentSvc.pushStatus(row.agent);
    // isolated 的目录保留，界面提示可以手动删除（避免误删会话记录）
    return c.json({ ok: true, keptDir: !!out.keptDir } satisfies DeleteProfileResult);
  });

  r.post('/profiles/:id/models/refresh', async (c) => {
    const id = c.req.param('id');
    const row = s.profiles.row(id);
    if (row.kind !== 'customEndpoint' || !row.base_url) throw Errors.badRequest('只有自定义地址的账号可以刷新模型列表');
    const secret = await s.profiles.secretOf(row);
    const models = await fetchModels(
      row.base_url,
      row.auth_header ?? 'x-api-key',
      secret,
      s.independent.getNetwork(),
      () => (s.port() > 0 ? [s.port()] : []),
    );
    s.profiles.setModels(id, models);
    s.agentSvc.pushStatus(row.agent);
    return c.json(s.profiles.get(id));
  });

  return r;
}

/** 请求 <baseUrl>/models（经统一出站防内网门禁、10 秒超时与响应体积上限）。 */
async function fetchModels(
  baseUrl: string,
  header: 'x-api-key' | 'bearer',
  secret: string | null,
  addressPolicy: AddressPolicy,
  blockedLocalPorts: () => readonly number[],
) {
  let base: URL;
  let url: URL;
  try {
    base = new URL(baseUrl);
    url = new URL(`${base.href.replace(/\/+$/, '')}/models`);
  } catch {
    throw Errors.badRequest('拉取模型列表失败：地址格式无效', '请检查 Base URL；拉不到的话可以手动填写模型列表');
  }
  const headers: Record<string, string> = {};
  if (secret) {
    if (header === 'bearer') headers.Authorization = `Bearer ${secret}`;
    else { headers['x-api-key'] = secret; headers['anthropic-version'] = '2023-06-01'; }
  }
  let j: unknown;
  try {
    const result = await readMetadataJson({
      base,
      url,
      publicCatalog: false,
      headers,
      timeoutMs: 10_000,
      maxBytes: 4 * 1024 * 1024,
      addressPolicy,
      blockedLocalPorts,
    });
    j = result.json;
  } catch (error) {
    if (error instanceof MetadataHttpError) {
      if (error.status !== null && error.status !== 200) {
        throw Errors.badRequest(`拉取模型列表失败（HTTP ${error.status}）`, '请检查 API Key；拉不到的话可以手动填写模型列表');
      }
      if (error.message.includes('JSON') || error.message.includes('内容无法识别')) {
        throw Errors.badRequest('模型列表不是 JSON', '可以手动填写模型列表');
      }
      throw Errors.badRequest(`拉取模型列表失败：${error.message}`, '请检查 Base URL；拉不到的话可以手动填写模型列表');
    }
    throw Errors.badRequest('拉取模型列表失败：连不上这个地址', '请检查 Base URL；拉不到的话可以手动填写模型列表');
  }
  const raw = Array.isArray(j) ? j : (j as { data?: unknown; models?: unknown })?.data ?? (j as { models?: unknown })?.models;
  if (!Array.isArray(raw)) throw Errors.badRequest('看不懂这个地址返回的模型列表', '可以手动填写模型列表');
  const models = raw
    .map((m) => (typeof m === 'string' ? { id: m } : (m as { id?: unknown; display_name?: unknown; name?: unknown })))
    .filter((m): m is { id: string; display_name?: unknown; name?: unknown } => typeof m?.id === 'string')
    .slice(0, 200)
    .map((m) => ({ id: m.id, name: typeof m.display_name === 'string' ? m.display_name : typeof m.name === 'string' ? m.name : m.id, contextWindow: null }));
  return models;
}
