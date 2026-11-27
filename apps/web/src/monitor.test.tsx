// 2.2 监控页网页单测：覆盖空状态、诚实口径明细、80% 警告、100% 超限与局域网只读锁。
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { FeatureKey, PROTOCOL_VERSION, type Hello, type MonitorOverview } from '@aic/protocol';
import { appStore } from './state/app';
import { MonitorPage } from './pages/MonitorPage';

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

function emptyTotals() {
  return {
    turns: 0,
    reportedTurns: 0,
    inputTokens: null,
    outputTokens: null,
    thoughtTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens: null,
    reportedCosts: [],
  };
}

function baseOverview(patch: Partial<MonitorOverview> = {}): MonitorOverview {
  return {
    generatedAt: Date.parse('2026-11-27T05:00:00.000Z'),
    timezoneOffsetMinutes: -480,
    counts: { runningTasks: 0, queuedTasks: 0, pendingApprovals: 0, todayFailedEvents: 0 },
    today: emptyTotals(),
    month: emptyTotals(),
    byAgentToday: [],
    byAgentMonth: [],
    byProjectToday: [],
    byProjectMonth: [],
    dailySeries: [
      { date: '2026-11-21', totalTokens: 0, byAgent: {}, byProject: {}, turns: 0, failedEvents: 0 },
      { date: '2026-11-22', totalTokens: 0, byAgent: {}, byProject: {}, turns: 0, failedEvents: 0 },
      { date: '2026-11-23', totalTokens: 0, byAgent: {}, byProject: {}, turns: 0, failedEvents: 0 },
      { date: '2026-11-24', totalTokens: 0, byAgent: {}, byProject: {}, turns: 0, failedEvents: 0 },
      { date: '2026-11-25', totalTokens: 0, byAgent: {}, byProject: {}, turns: 0, failedEvents: 0 },
      { date: '2026-11-26', totalTokens: 0, byAgent: {}, byProject: {}, turns: 0, failedEvents: 0 },
      { date: '2026-11-27', totalTokens: 0, byAgent: {}, byProject: {}, turns: 0, failedEvents: 0 },
    ],
    caps: [],
    capAlertLevel: 'ok',
    agents: [
      {
        kind: 'fake',
        displayName: '演示 Agent',
        enabled: true,
        status: 'ready',
        runningSessions: 0,
        concurrencyLimit: 2,
        lastCheckedAt: null,
        recentFailureCount: 0,
        lastError: null,
        todayUsage: emptyTotals(),
        monthUsage: emptyTotals(),
        quickAction: 'test',
      },
      {
        kind: 'claude',
        displayName: 'Claude Code',
        enabled: true,
        status: 'needs_login',
        runningSessions: 0,
        concurrencyLimit: 2,
        lastCheckedAt: null,
        recentFailureCount: 0,
        lastError: null,
        todayUsage: emptyTotals(),
        monthUsage: emptyTotals(),
        quickAction: 'login',
      },
    ],
    recentEvents: [],
    ...patch,
  };
}

const initialState = appStore.get();
afterEach(() => {
  appStore.set(() => initialState);
});

describe('2.2 监控页网页渲染与状态检查', () => {
  it('空状态下显示友好引导且不伪造 $0 金额', () => {
    appStore.set((s) => ({ ...s, hello: makeHello(false) }));
    const html = renderToStaticMarkup(createElement(MonitorPage, { initialOverview: baseOverview() }));
    expect(html).toContain('还没有调用记录');
    expect(html).toContain('未报告金额（订阅制不估价）');
    expect(html).not.toContain('$0');
    expect(html).toContain('新增上限');
  });

  it('有调用记录时展示 7 天 SVG 图表、诚实未报告字段与 80% 黄色告警条', () => {
    appStore.set((s) => ({ ...s, hello: makeHello(false) }));
    const ov = baseOverview({
      counts: { runningTasks: 1, queuedTasks: 2, pendingApprovals: 1, todayFailedEvents: 0 },
      today: {
        turns: 3,
        reportedTurns: 3,
        inputTokens: 6000,
        outputTokens: 2500,
        thoughtTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        totalTokens: 8500,
        reportedCosts: [],
      },
      byAgentToday: [
        {
          key: 'fake',
          label: '演示 Agent',
          kind: 'agent',
          agent: 'fake',
          tasks: 2,
          usage: {
            turns: 3,
            reportedTurns: 3,
            inputTokens: 6000,
            outputTokens: 2500,
            thoughtTokens: null,
            cacheReadTokens: null,
            cacheWriteTokens: null,
            totalTokens: 8500,
            reportedCosts: [],
          },
        },
      ],
      dailySeries: [
        { date: '2026-11-27', totalTokens: 8500, byAgent: { fake: 8500 }, byProject: {}, turns: 3, failedEvents: 0 },
      ],
      caps: [
        {
          rule: {
            id: 'cap-1',
            scope: 'global',
            agent: null,
            period: 'daily',
            maxTokens: 10000,
            maxCostMicros: null,
            currency: 'USD',
            enforcement: 'block_unattended',
            enabled: true,
            createdAt: 1,
            updatedAt: 1,
          },
          windowStart: 1,
          windowEnd: 2,
          usedTokens: 8500,
          usedCostMicros: null,
          tokenRatio: 0.85,
          costRatio: null,
          level: 'warn',
          blockingUnattended: false,
          blockingManual: false,
        },
      ],
      capAlertLevel: 'warn',
    });

    const html = renderToStaticMarkup(createElement(MonitorPage, { initialOverview: ov }));
    expect(html).toContain('接近花费或 Token 上限');
    expect(html).toContain('meter hot');
    expect(html).toContain('8,500 / 10,000');
    expect(html).toContain('未报告');
    expect(html).toContain('去处理');
    expect(html).toContain('<svg');
  });

  it('100% 达限时显示红色超限横幅与 .meter.over，并在局域网下温和锁定上限编辑与登录操作', () => {
    appStore.set((s) => ({ ...s, hello: makeHello(true) }));
    const ov = baseOverview({
      caps: [
        {
          rule: {
            id: 'cap-2',
            scope: 'global',
            agent: null,
            period: 'daily',
            maxTokens: 1000,
            maxCostMicros: 5_000_000,
            currency: 'USD',
            enforcement: 'block_unattended',
            enabled: true,
            createdAt: 1,
            updatedAt: 1,
          },
          windowStart: 1,
          windowEnd: 2,
          usedTokens: 1200,
          usedCostMicros: 2_500_000,
          tokenRatio: 1.2,
          costRatio: 0.5,
          level: 'exceeded',
          blockingUnattended: true,
          blockingManual: false,
        },
      ],
      capAlertLevel: 'exceeded',
    });

    const html = renderToStaticMarkup(createElement(MonitorPage, { initialOverview: ov }));
    expect(html).toContain('已触及花费或 Token 上限');
    expect(html).toContain('已自动暂停后台无人值守任务，你亲手发送的消息不受影响');
    expect(html).toContain('meter over');
    expect(html).toContain('$2.50 / $5.00');
    expect(html).toContain('请到运行 AI Console 的电脑上操作');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*?新增上限/);
    expect(html).toMatch(/<button[^>]*role="switch"[^>]*disabled=""/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>去登录<\/button>/);
  });
});
