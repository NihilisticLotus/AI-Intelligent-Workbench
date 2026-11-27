// 2.3 能力中心（MCP 工具管家）与右侧“详细 → 连接”网页单测
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FeatureKey, PROTOCOL_VERSION,
  type Hello, type McpServerSummary, type SkillSummary, type TaskMcpConnections, type TaskSkillsState,
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
    const lanHtml = renderToStaticMarkup(createElement(CapabilitiesPage, { initialServers: [sampleServer], initialSkills: [] }));
    expect(lanHtml).toContain('请到运行 AI Console 的电脑上操作（管理与导入 MCP 工具连接和技能包仅限本机）。');
    expect(lanHtml).toMatch(/<button[^>]*disabled=""[^>]*>.*?添加 MCP/);
    expect(lanHtml).toMatch(/<button[^>]*role="switch"[^>]*disabled=""/);
    expect(lanHtml).toMatch(/<button[^>]*disabled=""[^>]*>测试连接<\/button>/);
    expect(lanHtml).toMatch(/<button[^>]*disabled=""[^>]*>编辑<\/button>/);
    expect(lanHtml).toMatch(/<button[^>]*disabled=""[^>]*>删除<\/button>/);
  });

  it('2.4 技能包（Skills）标签页展示空态、安全/高危待确认拦截栏与局域网只读锁', () => {
    appStore.set((s) => ({ ...s, hello: makeHello(false) }));
    const emptySkills = renderToStaticMarkup(createElement(CapabilitiesPage, { initialServers: [], initialSkills: [], initialTab: 'skills' }));
    expect(emptySkills).toContain('还没有配置工作台技能包（Skills）');
    expect(emptySkills).toContain('本机只读导入');

    const riskySkill: SkillSummary = {
      id: 'sk_1',
      slug: 'asset-audit',
      name: '资产脚本检查',
      description: '附带检查脚本的资产审计技能',
      version: '1.0',
      contentHash: 'a'.repeat(64),
      sourceKind: 'agents_public',
      sourceLabel: '跨工具公共技能目录（~/.agents/skills）',
      agents: [],
      enabled: false,
      requiresApproval: true,
      risksApproved: false,
      hasScripts: true,
      scriptFiles: ['scripts/check.py'],
      files: [
        { path: 'SKILL.md', kind: 'skill', size: 120 },
        { path: 'scripts/check.py', kind: 'script', size: 60 },
      ],
      scan: {
        riskLevel: 'danger',
        hasScripts: true,
        scriptFiles: ['scripts/check.py'],
        findings: [{
          severity: 'danger',
          category: 'approval_bypass',
          file: 'SKILL.md',
          line: 4,
          title: '诱导关闭或绕过人工审批',
          detail: '存在风险',
          excerpt: 'bypass approval',
        }],
        scannedFiles: 2,
        scannedAt: 1000,
      },
      createdAt: 1000,
      updatedAt: 1000,
    };

    const localSkillHtml = renderToStaticMarkup(createElement(CapabilitiesPage, { initialServers: [], initialSkills: [riskySkill], initialTab: 'skills' }));
    expect(localSkillHtml).toContain('资产脚本检查');
    expect(localSkillHtml).toContain('待风险确认');
    expect(localSkillHtml).toContain('含 1 个脚本');
    expect(localSkillHtml).toContain('我已核对风险并启用');

    appStore.set((s) => ({ ...s, hello: makeHello(true) }));
    const lanSkillHtml = renderToStaticMarkup(createElement(CapabilitiesPage, { initialServers: [], initialSkills: [riskySkill], initialTab: 'skills' }));
    expect(lanSkillHtml).toMatch(/<button[^>]*disabled=""[^>]*>.*?新建技能/);
    expect(lanSkillHtml).toMatch(/<button[^>]*disabled=""[^>]*>.*?本机只读导入/);
    expect(lanSkillHtml).toMatch(/<button[^>]*disabled=""[^>]*>我已核对风险并启用<\/button>/);
  });

  it('右侧“详细 → 连接”面板展示已挂载 MCP 与技能包列表及任务级启停开关', () => {
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
    const skills: TaskSkillsState = {
      taskId: 't_1',
      agent: 'independent',
      skills: [{
        id: 'sk_1',
        slug: 'plan-review',
        name: '策划案检查清单',
        description: '审阅策划文档',
        enabled: true,
        assigned: true,
        disabledForTask: false,
        activeForTask: true,
        riskLevel: 'safe',
        hasScripts: false,
        requiresApproval: false,
        risksApproved: true,
      }],
    };
    const html = renderToStaticMarkup(createElement(ConnectionDetails, {
      historyAvailable: false,
      mcp,
      onToggleServer: () => {},
      skills,
      onToggleSkill: () => {},
    }));
    expect(html).toContain('blender');
    expect(html).toContain('45 个工具（已折叠）');
    expect(html).toContain('策划案检查清单');
    expect(html).toContain('技能包 · 已挂载');
    expect(html).toContain('已挂载');
    expect(html).toContain('打开能力中心');
  });
});
