// 2.1 网络安全加固基线网页单测：覆盖“安全防护状态”卡片在本机/局域网下渲染，以及局域网下各管理页温和只读锁对齐。
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FeatureKey, PROTOCOL_VERSION,
  type AgentInfo, type HandoffSettings, type Hello, type SecurityStatus,
} from '@aic/protocol';
import { appStore } from './state/app';
import { SecurityStatusSection } from './pages/security-status-section';
import { IndependentAgentPanel, type IndependentPanelSnapshot } from './pages/independent-agent-panel';
import { AgentsPage } from './pages/AgentsPage';
import { WorkspaceSettingsSection } from './pages/workspace-settings';
import { HandoffSettingsSection } from './pages/handoff-settings';
import { NetworkSettingsSection } from './pages/network-settings';

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
      [FeatureKey.PageMonitor]: false,
      [FeatureKey.PageCapabilities]: false,
    },
    machine: { id: 'm-1', name: 'STUDIO-PC', os: 'windows' },
    device: { id: 'd-1', name: lanConnection ? '手机浏览' : '本机浏览器', kind: 'browser', source: lanConnection ? 'lan' : 'local' },
    lastSeq: 0,
    bootId: 'boot-1',
    lastExit: null,
    lanConnection,
  };
}

const initialState = appStore.get();
afterEach(() => {
  appStore.set(() => initialState);
});

describe('2.1 设置与局域网只读锁网页渲染', () => {
  it('SecurityStatusSection 在本机和局域网视角下正确渲染通俗中文状态与各项保护说明', () => {
    const localStatus: SecurityStatus = {
      provenanceFence: { active: true, tiers: ['producer', 'delegated', 'external_data'] },
      subprocessEnvIsolation: { active: true },
      egressGuard: { active: true, allowFakeIpProxy: false, blockedLocalPortsCount: 1 },
      secretStorage: { mode: 'dpapi', encryptedCount: 3 },
      lanBoundary: { lanEnabled: false, currentConnection: 'local', localOnlyWriteGuard: true },
      markdownSafety: { blockRemoteImages: true, blockNonHttpLinks: true },
    };
    const localHtml = renderToStaticMarkup(createElement(SecurityStatusSection, { initialStatus: localStatus }));
    expect(localHtml).toContain('安全防护状态');
    expect(localHtml).toContain('已开启');
    expect(localHtml).toContain('Windows 系统加密（DPAPI）妥善保存 3 项密钥');
    expect(localHtml).toContain('本机电脑');
    expect(localHtml).toContain('默认拦截联网请求探测本机、局域网与工作台自身端口');

    const lanStatus: SecurityStatus = {
      ...localStatus,
      egressGuard: { active: true, allowFakeIpProxy: true, blockedLocalPortsCount: 1 },
      lanBoundary: { lanEnabled: true, currentConnection: 'lan', localOnlyWriteGuard: true },
    };
    const lanHtml = renderToStaticMarkup(createElement(SecurityStatusSection, { initialStatus: lanStatus }));
    expect(lanHtml).toContain('局域网访问已开启');
    expect(lanHtml).toContain('局域网设备');
    expect(lanHtml).toContain('198.18.x');
  });

  it('局域网连接（remote = true）下独立服务、Agent 管理与各系统设置面板展示温和锁定并禁用仅本机写按钮', () => {
    const sampleAgents: AgentInfo[] = [
      {
        kind: 'claude',
        displayName: 'Claude Code',
        status: 'ready',
        enabled: true,
        version: '2.1.0',
        verified: true,
        models: [{ id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', contextWindow: 200000 }],
        efforts: ['low', 'medium', 'high'],
        concurrencyLimit: 2,
        message: null,
      },
      {
        kind: 'codex',
        displayName: 'Codex',
        status: 'ready',
        enabled: false,
        version: '0.1.0',
        verified: true,
        models: [],
        efforts: null,
        message: null,
      },
    ];
    appStore.set((s) => ({
      ...s,
      hello: makeHello(true),
      agents: sampleAgents,
      profiles: { claude: [] },
    }));

    const snapshot: IndependentPanelSnapshot = {
      services: [
        {
          id: 'svc_test_1',
          name: '示例服务',
          protocol: 'chat_completions',
          baseUrl: 'https://api.example.com/v1',
          authentication: 'api_key',
          hasSecret: false,
          secretHint: null,
          apiVersion: null,
          providerId: null,
          plan: null,
          enabled: true,
          configRevision: 1,
          revision: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      models: {
        svc_test_1: [
          {
            id: 'mod_test_1',
            serviceId: 'svc_test_1',
            remoteModelId: 'gpt-demo',
            name: '示例模型',
            enabled: true,
            capabilities: [],
            evidence: [],
            revision: 1,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      },
      selection: { serviceId: 'svc_test_1', modelId: 'mod_test_1' },
    };

    const panelHtml = renderToStaticMarkup(createElement(IndependentAgentPanel, { initialSnapshot: snapshot }));
    expect(panelHtml).toContain('请到运行 AI Console 的电脑上操作');
    expect(panelHtml).toMatch(/<button class="btn primary" disabled=""[^>]*>添加 API 服务<\/button>/);
    expect(panelHtml).toMatch(/<button class="btn ghost" disabled=""[^>]*>清空默认值<\/button>/);
    expect(panelHtml).toMatch(/<button class="btn danger" disabled=""[^>]*>删除服务<\/button>/);
    expect(panelHtml).toMatch(/<button class="btn" disabled=""[^>]*>设为默认<\/button>/);

    const agentsHtml = renderToStaticMarkup(createElement(AgentsPage));
    expect(agentsHtml).toContain('请到运行 AI Console 的电脑上操作');
    expect(agentsHtml).toMatch(/role="switch"[^>]*disabled=""/);
    expect(agentsHtml).toMatch(/disabled=""[^>]*>(?:正在测试…|再测一次|测试连接)<\/button>/);
    expect(agentsHtml).toMatch(/<select id="dm-claude" class="select" disabled=""/);

    const wsHtml = renderToStaticMarkup(createElement(WorkspaceSettingsSection));
    expect(wsHtml).toContain('请到运行 AI Console 的电脑上操作');
    expect(wsHtml).toMatch(/<input id="workspace-days"[^>]*disabled=""/);

    const handoffSettings: HandoffSettings = { confirmBeforeSend: true, summaryModel: null };
    const handoffHtml = renderToStaticMarkup(createElement(HandoffSettingsSection, { initialSettings: handoffSettings }));
    expect(handoffHtml).toContain('请到运行 AI Console 的电脑上操作');
    expect(handoffHtml).toContain('<fieldset disabled=""');

    const netHtml = renderToStaticMarkup(createElement(NetworkSettingsSection));
    expect(netHtml).toContain('请到运行 AI Console 的电脑上操作');
    expect(netHtml).toMatch(/<input type="checkbox" disabled=""/);
  });
});
