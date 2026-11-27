// 能力中心 MCP 服务路由（全部走 /api/v1，写操作与测试连接均限制在本机执行）。
import { Hono } from 'hono';
import {
  CreateMcpServerBody, McpParseRequestBody, PatchMcpServerBody, PutTaskMcpOverridesBody,
} from '@aic/protocol';
import type { Services } from '../services';
import { parseMcpInput } from '../mcp/parser';
import { requireLocal } from './access-guard';
import { readBody, type Env } from './app';

export function mcpRoutes(s: Services) {
  const r = new Hono<Env>();

  r.get('/mcp/servers', (c) => c.json({ items: s.mcp.list(), nextCursor: null }));

  r.post('/mcp/parse', async (c) => {
    requireLocal(c, '请在这台电脑上解析并添加 MCP 配置');
    const body = await readBody(c, McpParseRequestBody);
    return c.json(parseMcpInput(body.input));
  });

  r.post('/mcp/servers', async (c) => {
    requireLocal(c, '请在这台电脑上添加 MCP 服务');
    const body = await readBody(c, CreateMcpServerBody);
    return c.json(await s.mcp.create(body), 201);
  });

  r.patch('/mcp/servers/:id', async (c) => {
    requireLocal(c, '请在这台电脑上修改 MCP 服务设置');
    const body = await readBody(c, PatchMcpServerBody);
    return c.json(await s.mcp.patch(c.req.param('id'), body));
  });

  r.delete('/mcp/servers/:id', (c) => {
    requireLocal(c, '请在这台电脑上删除 MCP 服务');
    s.mcp.delete(c.req.param('id'));
    return c.json({ ok: true });
  });

  r.post('/mcp/servers/:id/test', async (c) => {
    requireLocal(c, '请在这台电脑上测试 MCP 连接');
    return c.json(await s.mcp.test(c.req.param('id'), c.req.raw.signal));
  });

  r.get('/tasks/:id/mcp', (c) => {
    const row = s.tasks.getRow(c.req.param('id'));
    return c.json(s.mcp.taskConnections(row.id, row.agent));
  });

  r.put('/tasks/:id/mcp', async (c) => {
    const row = s.tasks.getRow(c.req.param('id'));
    const body = await readBody(c, PutTaskMcpOverridesBody);
    return c.json(s.mcp.setTaskOverrides(row.id, row.agent, body.disabledServerIds));
  });

  r.post('/internal/mcp/rpc', async (c) => {
    const grant = s.mcp.authenticateBridge(c.req.header('authorization'));
    let raw: unknown;
    try { raw = await c.req.json(); } catch { raw = {}; }
    const body = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    return c.json(await s.mcp.handleBridgeRpc(grant, body, c.req.raw.signal));
  });

  return r;
}
