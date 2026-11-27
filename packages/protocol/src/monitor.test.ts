import { describe, expect, it } from 'vitest';
import { MonitorOverview, TaskSource, UpsertUsageCapBody, UsageCapEvaluation, UsageCapRule } from './index';

describe('监控与花费上限协议', () => {
  it('校验 TaskSource 与 UsageCapRule 合法与非法组合', () => {
    for (const src of ['manual', 'automation', 'webhook', 'delegated'] as const) {
      expect(TaskSource.parse(src)).toBe(src);
    }
    expect(TaskSource.safeParse('unknown').success).toBe(false);

    const validGlobal = UpsertUsageCapBody.parse({
      scope: 'global',
      agent: null,
      period: 'daily',
      maxTokens: 100_000,
      maxCostMicros: null,
      currency: 'USD',
      enforcement: 'block_unattended',
      enabled: true,
    });
    expect(validGlobal.scope).toBe('global');

    const validAgent = UpsertUsageCapBody.parse({
      scope: 'agent',
      agent: 'claude',
      period: 'monthly',
      maxTokens: null,
      maxCostMicros: 20_000_000,
      currency: 'USD',
      enforcement: 'block_all',
      enabled: true,
    });
    expect(validAgent.agent).toBe('claude');

    // 全工作台不能指定 agent
    expect(UpsertUsageCapBody.safeParse({ ...validGlobal, agent: 'codex' }).success).toBe(false);
    // 按 Agent 必须指定 agent
    expect(UpsertUsageCapBody.safeParse({ ...validAgent, agent: null }).success).toBe(false);
    // Token 与费用不能同时为空
    expect(UpsertUsageCapBody.safeParse({ ...validGlobal, maxTokens: null, maxCostMicros: null }).success).toBe(false);
    // 非法币种或多余字段
    expect(UpsertUsageCapBody.safeParse({ ...validGlobal, currency: 'usd' }).success).toBe(false);
    expect(UpsertUsageCapBody.safeParse({ ...validGlobal, extra: true }).success).toBe(false);
  });

  it('校验 MonitorOverview 与 UsageCapEvaluation 严格结构', () => {
    const emptyTotals = {
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
    const rule = UsageCapRule.parse({
      id: 'cap_1',
      scope: 'global',
      agent: null,
      period: 'daily',
      maxTokens: 50000,
      maxCostMicros: null,
      currency: 'USD',
      enforcement: 'block_unattended',
      enabled: true,
      createdAt: 1000,
      updatedAt: 1000,
    });
    const capEval = UsageCapEvaluation.parse({
      rule,
      windowStart: 0,
      windowEnd: 86_400_000,
      usedTokens: 42000,
      usedCostMicros: null,
      tokenRatio: 0.84,
      costRatio: null,
      level: 'warn',
      blockingUnattended: false,
      blockingManual: false,
    });
    const overview = MonitorOverview.parse({
      generatedAt: 2000,
      timezoneOffsetMinutes: -480,
      counts: { runningTasks: 1, queuedTasks: 0, pendingApprovals: 0, todayFailedEvents: 0 },
      today: emptyTotals,
      month: emptyTotals,
      byAgentToday: [],
      byAgentMonth: [],
      byProjectToday: [],
      byProjectMonth: [],
      dailySeries: [{ date: '2026-11-27', totalTokens: 0, byAgent: {}, byProject: {}, turns: 0, failedEvents: 0 }],
      caps: [capEval],
      capAlertLevel: 'warn',
      agents: [],
      recentEvents: [],
    });
    expect(overview.capAlertLevel).toBe('warn');
  });
});
