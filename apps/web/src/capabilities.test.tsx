// 2.3 能力中心（MCP 工具管家）与右侧“详细 → 连接”网页单测
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FeatureKey, PROTOCOL_VERSION,
  type Hello, type McpServerSummary, type TaskMcpConnections,
} from '@aic/protocol';
import { appStore } from './state/app';
import { CapabilitiesPage } from './pages/CapabilitiesPage';
import { ConnectionDetails } from './components/details/connection';

function makeHello(lanConnection: boolean): Hello {
  return {
    server: 'ai-console-gateway',
    version: '0.1.0',
    protocol: PROTOCOL_VERSION,
    features: {
      [FeatureKey.TaskUsage]: true,
      [FeatureKey.FakeAgent]: true,
      [FeatureKey.RealAgents]: true,
      [FeatureKey.Profiles]: true,
      [FeatureKey.Approvals]: true,
      [FeatureKey.Groups]: true,
      [FeatureKey.FsBrowse]: !lanConnection,
      [FeatureKey.Worktrees]: true,
      [FeatureKey.Handoff]: true,
      [FeatureKey.TaskMemory]: true,
      [FeatureKey.Lan]: true,
      [FeatureKey.SideChat]: false,
      [FeatureKey.AgentToggle]: true,
      [FeatureKey.Drafts]: true,
      [FeatureKey.IndependentCatalog]: true,
      [FeatureKey.IndependentDiscovery]: true,
      [FeatureKey.IndependentRuntime]: true,
      [FeatureKey.PageAssets]: false,
      [FeatureKey.PageGenerate]: false,
      [FeatureKey.PageAutomations]: false,
      [FeatureKey.PageMonitor]: true,
      [FeatureKey.PageCapabilities]: true,
    },
    machine: { id: 'm-1', name: 'STUDIO-PC', os: 'windows' },
    device: { id: 'd-1', name: lanConnection ? '手机浏览' : '本机浏览器', kind: 'browser', source: lanConnection ? 'lan' : 'local' },
    lastSeq: 0,
    bootId: 'boot-1',
    lastExit: null,
    lanConnection,
  };
}

const sampleServer: McpServerSummary = {
  id: 'mcp_1',
  name: 'blender',
  description: '三维场景与材质工具',
  transport: 'stdio',
  command: 'uvx',
  args: ['blender-mcp'],
  url: null,
  envSecrets: [{ key: 'BLENDER_TOKEN', hint: '9x8y', hasValue: true }],
  headerSecrets: [],
  concurrency: 'exclusive',
  agents: [],
  enabled: true,
  status: 'ready',
  lastError: null,
  lastCheckedAt: Date.parse('2026-11-27T06:00:00Z'),
  lastCalledAt: null,
  lastCalledTool: null,
  toolCount: 45,
  toolsFolded: true,
  tools: [{ name: 'get_scene_info', description: '读取场景节点', inputSchema: { type: 'object', properties: {} } }],
  createdAt: 1,
  updatedAt: 2,
};

const initialState = appStore.get();
afterEach(() => {
  appStore.set(() => initialState);
});

describe('2.3 能力中心与连接详情网页渲染', () => {
  it('空状态显示添加引导，有数据时展示独占锁、折叠徽章与 DPAPI 加密计数', () => {
    appStore.set((s) => ({ ...s, hello: makeHello(false) }));
    const emptyHtml = renderToStaticMarkup(createElement(CapabilitiesPage, { initialServers: [] }));
    expect(emptyHtml).toContain('还没有配置 MCP 工具连接');
    expect(emptyHtml).toContain('添加第一个 MCP');

    const listHtml = renderToStaticMarkup(createElement(CapabilitiesPage, { initialServers: [sampleServer] }));
    expect(listHtml).toContain('blender');
    expect(listHtml).toContain('独占锁');
    expect(listHtml).toContain('45 个工具');
    expect(listHtml).toContain('已自动折叠');
    expect(listHtml).toContain('已通过 DPAPI 加密保存 1 项');
  });

  it('局域网访问（remote = true）下禁用添加、启停、测试、编辑与删除按钮并显示本机提示', () => {
    appStore.set((s) => ({ ...s, hello: makeHello(true) }));
    const lanHtml = renderToStaticMarkup(createElement(CapabilitiesPage, { initialServers: [sampleServer] }));
    expect(lanHtml).toContain('请到运行 AI Console 的电脑上操作（管理与测试 MCP 工具连接仅限本机）。');
    expect(lanHtml).toMatch(/<button[^>]*disabled=""[^>]*>.*?添加 MCP/);
    expect(lanHtml).toMatch(/<button[^>]*role="switch"[^>]*disabled=""/);
    expect(lanHtml).toMatch(/<button[^>]*disabled=""[^>]*>测试连接<\/button>/);
    expect(lanHtml).toMatch(/<button[^>]*disabled=""[^>]*>编辑<\/button>/);
    expect(lanHtml).toMatch(/<button[^>]*disabled=""[^>]*>删除<\/button>/);
  });

  it('右侧“详细 → 连接”面板展示已挂载 MCP 列表、折叠状态与任务级启停开关', () => {
    const mcp: TaskMcpConnections = {
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
    };
    const html = renderToStaticMarkup(createElement(ConnectionDetails, {
      historyAvailable: false,
      mcp,
      onToggleServer: () => {},
    }));
    expect(html).toContain('blender');
    expect(html).toContain('45 个工具（已折叠）');
    expect(html).toContain('已挂载');
    expect(html).toContain('打开能力中心');
  });
});
