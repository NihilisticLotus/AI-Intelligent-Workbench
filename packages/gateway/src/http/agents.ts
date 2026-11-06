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

const kindOf = (c: Ctx) => {
  const r = AgentKind.safeParse(c.req.param('kind'));
  if (!r.success) throw Errors.notFound('没有这个 Agent');
  return r.data;
};

export function agentRoutes(s: Services) {
  const r = new Hono<Env>();

  // 读缓存，不触发探测（第一次请求时等待启动检测完成）
  r.get('/agents', async (c) => c.json({ items: await s.agentSvc.list(), nextCursor: null }));

  r.post('/agents/redetect', async (c) => {
    const out: z.infer<typeof RedetectResult> = { items: await s.agentSvc.redetect() };
    return c.json(out);
  });

  r.patch('/agents/:kind', async (c) => c.json(await s.agentSvc.patch(kindOf(c), await readBody(c, PatchAgentBody))));

  r.post('/agents/:kind/login', async (c) => {
    const kind = kindOf(c);
    const out: z.infer<typeof AgentLoginResult> = await s.agentSvc.login(kind, await readBody(c, AgentLoginBody), c.get('device').id);
    return c.json(out, 202);
  });

  r.post('/agents/:kind/login/:loginId/cancel', (c) => {
    s.agentSvc.cancelLogin(kindOf(c), c.req.param('loginId'));
    return c.json({ ok: true } satisfies OkResult);
  });

  r.post('/agents/:kind/login/:loginId/code', async (c) => {
    const kind = kindOf(c);
    const body = await readBody(c, AgentLoginCodeBody);
    s.agentSvc.submitCode(kind, c.req.param('loginId'), body.code);
    return c.json({ ok: true } satisfies OkResult);
  });

  r.post('/agents/:kind/test', async (c) => {
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
    const p = await s.profiles.create(await readBody(c, CreateProfileBody), c.get('device').id);
    s.agentSvc.pushStatus(p.agent);
    return c.json(p, 201);
  });

  r.get('/profiles/:id', (c) => c.json(s.profiles.get(c.req.param('id'))));

  r.patch('/profiles/:id', async (c) => {
    const id = c.req.param('id');
    const before = s.profiles.row(id);
    const body = await readBody(c, PatchProfileBody);
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
    const models = await fetchModels(row.base_url, row.auth_header ?? 'x-api-key', secret);
    s.profiles.setModels(id, models);
    s.agentSvc.pushStatus(row.agent);
    return c.json(s.profiles.get(id));
  });

  return r;
}

/** 请求 <baseUrl>/models（10 秒超时，带同一个密钥）。地址已在创建账号时校验过（https 或本机 http） */
async function fetchModels(baseUrl: string, header: 'x-api-key' | 'bearer', secret: string | null) {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (secret) {
    if (header === 'bearer') headers.authorization = `Bearer ${secret}`;
    else { headers['x-api-key'] = secret; headers['anthropic-version'] = '2023-06-01'; }
  }
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000), redirect: 'error' });
  } catch {
    throw Errors.badRequest('拉取模型列表失败：连不上这个地址', '请检查 Base URL；拉不到的话可以手动填写模型列表');
  }
  if (!res.ok) throw Errors.badRequest(`拉取模型列表失败（HTTP ${res.status}）`, '请检查 API Key；拉不到的话可以手动填写模型列表');
  let j: unknown;
  try { j = await res.json(); } catch { throw Errors.badRequest('模型列表不是 JSON', '可以手动填写模型列表'); }
  const raw = Array.isArray(j) ? j : (j as { data?: unknown; models?: unknown })?.data ?? (j as { models?: unknown })?.models;
  if (!Array.isArray(raw)) throw Errors.badRequest('看不懂这个地址返回的模型列表', '可以手动填写模型列表');
  const models = raw
    .map((m) => (typeof m === 'string' ? { id: m } : (m as { id?: unknown; display_name?: unknown; name?: unknown })))
    .filter((m): m is { id: string; display_name?: unknown; name?: unknown } => typeof m?.id === 'string')
    .slice(0, 200)
    .map((m) => ({ id: m.id, name: typeof m.display_name === 'string' ? m.display_name : typeof m.name === 'string' ? m.name : m.id, contextWindow: null }));
  return models;
}
