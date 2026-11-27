import { describe, expect, it } from 'vitest';
import {
  CreateMcpServerBody, McpParseResult, McpServerSummary, TaskMcpConnections,
} from './mcp';

describe('2.3 MCP 能力中心协议校验', () => {
  it('校验 CreateMcpServerBody 的 stdio 与 http 互斥字段约束', () => {
    const okStdio = CreateMcpServerBody.parse({
      name: 'demo-tools',
      transport: 'stdio',
      command: 'node',
      args: ['server.mjs'],
      envValues: { DEMO_TOKEN: 'fixture-secret-1234' },
    });
    expect(okStdio.concurrency).toBe('shared');
    expect(okStdio.enabled).toBe(true);

    const okHttp = CreateMcpServerBody.parse({
      name: 'remote-mcp',
      transport: 'http',
      url: 'https://mcp.example.com/rpc',
      headerValues: { Authorization: 'Bearer fixture-token' },
      concurrency: 'exclusive',
      agents: ['independent', 'claude'],
    });
    expect(okHttp.url).toBe('https://mcp.example.com/rpc');

    // stdio 缺少 command 或携带 url 均拒绝
    expect(CreateMcpServerBody.safeParse({ name: 'bad1', transport: 'stdio' }).success).toBe(false);
    expect(CreateMcpServerBody.safeParse({ name: 'bad2', transport: 'stdio', command: 'node', url: 'https://a.com' }).success).toBe(false);
    // http 缺少 url 或携带 command 均拒绝
    expect(CreateMcpServerBody.safeParse({ name: 'bad3', transport: 'http' }).success).toBe(false);
    expect(CreateMcpServerBody.safeParse({ name: 'bad4', transport: 'http', url: 'https://a.com', command: 'node' }).success).toBe(false);
  });

  it('校验 McpServerSummary、McpParseResult 与 TaskMcpConnections 严格结构', () => {
    const summary = McpServerSummary.parse({
      id: 'mcp_1',
      name: 'blender',
      description: '三维场景工具',
      transport: 'stdio',
      command: 'uvx',
      args: ['blender-mcp'],
      url: null,
      envSecrets: [{ key: 'BLENDER_TOKEN', hint: '7Q2c', hasValue: true }],
      headerSecrets: [],
      concurrency: 'exclusive',
      agents: [],
      enabled: true,
      status: 'ready',
      lastError: null,
      lastCheckedAt: 1000,
      lastCalledAt: 2000,
      lastCalledTool: 'get_scene_info',
      toolCount: 45,
      toolsFolded: true,
      tools: [{ name: 'get_scene_info', description: '获取场景信息', inputSchema: { type: 'object', properties: {} } }],
      createdAt: 100,
      updatedAt: 200,
    });
    expect(summary.toolsFolded).toBe(true);

    const parsed = McpParseResult.parse({
      format: 'claude_cli',
      warnings: [],
      candidates: [{
        name: 'demo',
        description: '',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@demo/mcp'],
        url: null,
        envValues: {},
        headerValues: {},
        concurrency: 'shared',
      }],
    });
    expect(parsed.candidates).toHaveLength(1);

    const conns = TaskMcpConnections.parse({
      taskId: 't_1',
      agent: 'independent',
      servers: [{
        id: 'mcp_1',
        name: 'blender',
        transport: 'stdio',
        enabled: true,
        assigned: true,
        disabledForTask: false,
        activeForTask: true,
        status: 'ready',
        concurrency: 'exclusive',
        toolCount: 45,
        toolsFolded: true,
        lastCalledAt: null,
        lastCalledTool: null,
      }],
    });
    expect(conns.servers[0]!.activeForTask).toBe(true);
  });
});
