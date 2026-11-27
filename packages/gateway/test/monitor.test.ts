// 2.2 监控告警、调用账本与花费上限阀门综合测试（全程离线 + 演示 Agent，零付费模型调用）
import { afterEach, describe, expect, it } from 'vitest';
import {
  ErrorActionKey, ErrorCode, FeatureKey, MonitorOverview, UsageCapEvaluation,
} from '@aic/protocol';
import { MonitorService } from '../src/monitor';
import { LAN_ALIAS, LAN_SELECTION, startLanGateway } from './fixtures/lan-gateway';
import { makeProject, startGw, type TestGw } from './helpers';

let gw: TestGw | undefined;

afterEach(async () => {
  await gw?.stop();
  gw = undefined;
});

function insertTurnUsage(
  tGw: TestGw,
  opts: { taskId: string; sessionId?: string | null; messageId: string; at: number; usage: Record<string, number | null> },
) {
  tGw.gw.services.db.run(
    'INSERT INTO turn_usage (task_id, session_id, message_id, usage_json, at) VALUES (?, ?, ?, ?, ?)',
    opts.taskId,
    opts.sessionId ?? null,
    opts.messageId,
    JSON.stringify({
      source: 'agent',
      inputTokens: null,
      outputTokens: null,
      thoughtTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      totalTokens: null,
      ...opts.usage,
    }),
    opts.at,
  );
}

describe('2.2 监控告警、调用账本与花费上限阀门', () => {
  it('跨自然日与跨自然月正确清零并按诚实口径汇总（订阅制不伪造 $0，已报告费用不重复叠加）', async () => {
    gw = await startGw({ fakeSpeed: 0 });
    const token = await gw.pair('本机测试');
    const project = await makeProject(gw, token, '战棋原型');

    const tRes = await gw.api('POST', '/tasks', {
      token,
      body: {
        projectId: project.id,
        groupId: null,
        prompt: '统计测试任务',
        agent: 'fake',
        permission: 'readonly',
        deferPrompt: true,
      },
    });
    expect(tRes.status).toBe(201);
    const taskId = tRes.json.id as string;

    // 东八区（tzOffsetMinutes = -480）：
    // 2026-11-30 23:59:59+08:00 = 2026-11-30T15:59:59Z
    // 2026-12-01 00:00:00+08:00 = 2026-11-30T16:00:00Z
    const nov30End = Date.parse('2026-11-30T15:59:59.000Z');
    const dec01Start = Date.parse('2026-11-30T16:00:00.000Z');
    const dec01Noon = Date.parse('2026-12-01T04:00:00.000Z');

    // 11 月 30 日最后一秒的订阅制调用（无费用，不报告 thought/cache）
    insertTurnUsage(gw, {
      taskId,
      messageId: 'm-nov30',
      at: nov30End,
      usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
    });
    // 12 月 1 日 00:00:00 的调用（跨日且跨月）
    insertTurnUsage(gw, {
      taskId,
      messageId: 'm-dec01',
      at: dec01Start,
      usage: { inputTokens: 400, outputTokens: 200, totalTokens: 600 },
    });

    // 模拟第三方 ACP session.usage 同一会话上报两次累计金额（0.10 -> 0.25 USD），应取最大值 0.25 而不相加为 0.35
    gw.gw.services.db.run(
      "INSERT INTO sessions (id, task_id, agent_id, status, started_at) VALUES ('s-acp-1', ?, 'claude', 'ended', ?)",
      taskId,
      dec01Start,
    );
    gw.gw.services.db.run(
      "INSERT INTO events (ts, task_id, session_id, type, payload, replay) VALUES (?, ?, 's-acp-1', 'session.usage', ?, 0)",
      dec01Start + 1000,
      taskId,
      JSON.stringify({ used: 500, size: 100000, cost: { amount: 0.10, currency: 'USD' } }),
    );
    gw.gw.services.db.run(
      "INSERT INTO events (ts, task_id, session_id, type, payload, replay) VALUES (?, ?, 's-acp-1', 'session.usage', ?, 0)",
      dec01Start + 2000,
      taskId,
      JSON.stringify({ used: 900, size: 100000, cost: { amount: 0.25, currency: 'USD' } }),
    );

    // 模拟独立摘要请求的一笔实际预留费用（0.05 USD）
    gw.gw.services.db.run(
      `INSERT INTO handoff_summary_requests (id, task_id, ordinal, attempt_json, state, reserved_micros, created_at, updated_at, binding_json, currency)
       VALUES ('hsr-1', ?, 1, '{}', 'succeeded', 50000, ?, ?, '{}', 'USD')`,
      taskId,
      dec01Start + 3000,
      dec01Start + 3000,
    );

    let fakeNow = nov30End;
    const monitor = new MonitorService(gw.gw.services.db, {
      listAgents: async () => [...await gw!.gw.services.agentSvc.list(), gw!.gw.services.independentRuntime.info()],
      now: () => fakeNow,
      tzOffsetMinutes: () => -480,
    });

    // 在 11-30 23:59:59 视角：只看到 11-30 的 1500 Token，且订阅制没有费用（reportedCosts 为空，不伪造 $0）
    const ovNov = await monitor.overview();
    expect(ovNov.today.totalTokens).toBe(1500);
    expect(ovNov.today.thoughtTokens).toBeNull();
    expect(ovNov.today.reportedCosts).toEqual([]);
    expect(ovNov.month.totalTokens).toBe(1500);
    expect(ovNov.dailySeries).toHaveLength(7);
    expect(ovNov.dailySeries[6]!.date).toBe('2026-11-30');
    expect(ovNov.dailySeries[6]!.totalTokens).toBe(1500);

    // 在 12-01 12:00:00 视角：今日和本月均已清零，只计 12-01 的 600 Token；
    // 7 天趋势仍保留 11-30 (1500) 和 12-01 (600)；
    // 已报告费用 = 0.25 (ACP 去重后最大值) + 0.05 (独立摘要) = 0.30 USD (300_000 micros)
    fakeNow = dec01Noon;
    const ovDec = await monitor.overview();
    expect(ovDec.today.totalTokens).toBe(600);
    expect(ovDec.month.totalTokens).toBe(600);
    expect(ovDec.today.reportedCosts).toEqual([{ currency: 'USD', micros: 300_000 }]);
    expect(ovDec.byAgentToday.find((x) => x.agent === 'fake')?.usage.reportedCosts).toEqual([]);
    expect(ovDec.byAgentToday.find((x) => x.agent === 'claude')?.usage.reportedCosts).toEqual([{ currency: 'USD', micros: 250_000 }]);
    expect(ovDec.byAgentToday.find((x) => x.agent === 'independent')?.usage.reportedCosts).toEqual([{ currency: 'USD', micros: 50_000 }]);
    expect(ovDec.dailySeries[5]!.date).toBe('2026-11-30');
    expect(ovDec.dailySeries[5]!.totalTokens).toBe(1500);
    expect(ovDec.dailySeries[6]!.date).toBe('2026-12-01');
    expect(ovDec.dailySeries[6]!.totalTokens).toBe(600);
  });

  it('80% 黄色告警不拦截，100% 默认只拦无人值守放行手动，block_all 拦全部，且绝不中断已运行回合', async () => {
    gw = await startGw({ fakeSpeed: 0 });
    const token = await gw.pair('本机测试');
    const project = await makeProject(gw, token, '阀门测试');

    // 先建一个草稿任务并写入今日已用 850 Token
    const baseTaskRes = await gw.api('POST', '/tasks', {
      token,
      body: {
        projectId: project.id,
        groupId: null,
        prompt: '基线任务',
        agent: 'fake',
        permission: 'readonly',
        deferPrompt: true,
      },
    });
    const baseTaskId = baseTaskRes.json.id as string;
    insertTurnUsage(gw, {
      taskId: baseTaskId,
      messageId: 'm-used-850',
      at: Date.now(),
      usage: { inputTokens: 600, outputTokens: 250, totalTokens: 850 },
    });

    // 1. 设全工作台每日上限 1000 Token（850/1000 = 85% -> warn，不拦截）
    const putWarn = await gw.api('PUT', '/monitor/caps', {
      token,
      body: {
        scope: 'global',
        agent: null,
        period: 'daily',
        maxTokens: 1000,
        maxCostMicros: null,
        currency: 'USD',
        enforcement: 'block_unattended',
        enabled: true,
      },
    });
    expect(putWarn.status).toBe(200);
    const evalWarn = UsageCapEvaluation.parse(putWarn.json);
    expect(evalWarn.level).toBe('warn');
    expect(evalWarn.blockingUnattended).toBe(false);
    expect(evalWarn.blockingManual).toBe(false);

    // 85% 时，自动化来源仍可正常创建任务
    const autoOk = await gw.api('POST', '/tasks', {
      token,
      body: {
        projectId: project.id,
        groupId: null,
        prompt: '无人值守 85% 放行检查',
        agent: 'fake',
        permission: 'readonly',
        source: 'automation',
      },
    });
    expect(autoOk.status).toBe(201);

    // 2. 调低上限到 800 Token（已用 >= 850 -> 100%+ exceeded，策略 block_unattended）
    const putExceeded = await gw.api('PUT', '/monitor/caps', {
      token,
      body: {
        id: evalWarn.rule.id,
        scope: 'global',
        agent: null,
        period: 'daily',
        maxTokens: 800,
        maxCostMicros: null,
        currency: 'USD',
        enforcement: 'block_unattended',
        enabled: true,
      },
    });
    expect(putExceeded.status).toBe(200);
    const evalExceeded = UsageCapEvaluation.parse(putExceeded.json);
    expect(evalExceeded.level).toBe('exceeded');
    expect(evalExceeded.blockingUnattended).toBe(true);
    expect(evalExceeded.blockingManual).toBe(false);

    // 无人值守来源（automation / webhook / delegated）全部被 429 拦截，且带查看监控动作
    for (const src of ['automation', 'webhook', 'delegated'] as const) {
      const blocked = await gw.api('POST', '/tasks', {
        token,
        body: {
          projectId: project.id,
          groupId: null,
          prompt: `被拦任务-${src}`,
          agent: 'fake',
          permission: 'readonly',
          source: src,
        },
      });
      expect(blocked.status).toBe(429);
      const err = blocked.json as { code: string; actions: Array<{ action: string }> };
      expect(err.code).toBe(ErrorCode.UsageCapExceeded);
      expect(err.actions.some((a) => a.action === ErrorActionKey.OpenMonitor)).toBe(true);
    }

    // 制作人手动来源仍然放行
    const manualAllowed = await gw.api('POST', '/tasks', {
      token,
      body: {
        projectId: project.id,
        groupId: null,
        prompt: '制作人手动任务必须放行',
        agent: 'fake',
        permission: 'readonly',
        source: 'manual',
      },
    });
    expect(manualAllowed.status).toBe(201);

    // 上限拦截不会把 Agent 误判为故障，但会在最近动态里留痕为 cap 类型
    const ovCheck = await gw.api('GET', '/monitor/overview', { token });
    expect(ovCheck.status).toBe(200);
    const parsedOv = MonitorOverview.parse(ovCheck.json);
    expect(parsedOv.counts.todayFailedEvents).toBe(0);
    expect(parsedOv.recentEvents.some((e) => e.kind === 'cap')).toBe(true);

    // 3. 验证“正在运行中的回合不会被中途打断”：
    const slowGw = await startGw({ fakeSpeed: 0.25 });
    try {
      const slowToken = await slowGw.pair('运行中保护');
      const slowProj = await makeProject(slowGw, slowToken, '运行中保护');
      const runTaskRes = await slowGw.api('POST', '/tasks', {
        token: slowToken,
        body: {
          projectId: slowProj.id,
          groupId: null,
          prompt: '运行中不应被打断',
          agent: 'fake',
          permission: 'readonly',
        },
      });
      expect(runTaskRes.status).toBe(201);
      const runTaskId = runTaskRes.json.id as string;

      // 在回合进行中立刻设置 block_all 的 10 Token 上限，并写入已有 100 Token 消耗
      insertTurnUsage(slowGw, {
        taskId: runTaskId,
        messageId: 'm-pre',
        at: Date.now(),
        usage: { totalTokens: 100 },
      });
      const putBlockAll = await slowGw.api('PUT', '/monitor/caps', {
        token: slowToken,
        body: {
          scope: 'global',
          agent: null,
          period: 'daily',
          maxTokens: 10,
          maxCostMicros: null,
          currency: 'USD',
          enforcement: 'block_all',
          enabled: true,
        },
      });
      expect(putBlockAll.status).toBe(200);

      // 此时新发手动任务会被 block_all 拦下
      const blockedManual = await slowGw.api('POST', '/tasks', {
        token: slowToken,
        body: {
          projectId: slowProj.id,
          groupId: null,
          prompt: 'block_all 下拦截手动任务',
          agent: 'fake',
          permission: 'readonly',
          source: 'manual',
        },
      });
      expect(blockedManual.status).toBe(429);

      // 但已经在跑的 runTaskId 会正常跑完进入 review，而不是 failed/interrupted
      const deadline = Date.now() + 8000;
      let finalStatus = 'running';
      while (Date.now() < deadline) {
        const st = await slowGw.api('GET', `/tasks/${runTaskId}`, { token: slowToken });
        finalStatus = st.json.status as string;
        if (finalStatus !== 'running' && finalStatus !== 'queued') break;
        await new Promise((r) => setTimeout(r, 60));
      }
      expect(finalStatus).toBe('review');
    } finally {
      await slowGw.stop();
    }

    // 4. 删除上限规则后恢复放行
    const delRes = await gw.api('DELETE', `/monitor/caps/${evalWarn.rule.id}`, { token });
    expect(delRes.status).toBe(200);
    const afterDel = await gw.api('POST', '/tasks', {
      token,
      body: {
        projectId: project.id,
        groupId: null,
        prompt: '删除上限后恢复放行',
        agent: 'fake',
        permission: 'readonly',
        source: 'automation',
      },
    });
    expect(afterDel.status).toBe(201);
  });

  it('HTTP 接口鉴权、/hello 功能开关开启，以及局域网只读边界（GET 200，PUT/DELETE 403）', async () => {
    const lanGw = await startLanGateway();
    gw = lanGw;
    const localToken = await lanGw.pair('本机浏览器');
    const remoteToken = await lanGw.pair('远端设备');

    // 1. /hello 开放 pages.monitor
    const helloRes = await lanGw.api('GET', '/hello', { token: localToken });
    expect(helloRes.status).toBe(200);
    expect(helloRes.json.features[FeatureKey.PageMonitor]).toBe(true);

    // 2. 未鉴权调用返回 401
    const unauth = await lanGw.api('GET', '/monitor/overview');
    expect(unauth.status).toBe(401);

    // 3. 本机可读写上限与读取概览
    const localOverviewRes = await lanGw.api('GET', '/monitor/overview', { token: localToken });
    expect(localOverviewRes.status).toBe(200);
    const localOverview = MonitorOverview.parse(localOverviewRes.json);
    expect(localOverview.capAlertLevel).toBe('ok');

    const createCap = await lanGw.api('PUT', '/monitor/caps', {
      token: localToken,
      body: {
        scope: 'global',
        agent: null,
        period: 'daily',
        maxTokens: 50000,
        maxCostMicros: null,
        currency: 'USD',
        enforcement: 'block_unattended',
        enabled: true,
      },
    });
    expect(createCap.status).toBe(200);
    const cap = UsageCapEvaluation.parse(createCap.json);

    // 4. 开启局域网，并用局域网回环模拟远端访问
    expect((await lanGw.api('PUT', '/access/lan', { token: localToken, body: LAN_SELECTION })).status).toBe(200);

    // 局域网 GET 概览与上限均 200
    const lanOv = await lanGw.api('GET', '/monitor/overview', { token: remoteToken, loopback: LAN_ALIAS });
    expect(lanOv.status).toBe(200);
    expect(MonitorOverview.parse(lanOv.json).caps).toHaveLength(1);

    const lanCaps = await lanGw.api('GET', '/monitor/caps', { token: remoteToken, loopback: LAN_ALIAS });
    expect(lanCaps.status).toBe(200);

    // 局域网 PUT/DELETE 上限全部 403
    const lanPut = await lanGw.api('PUT', '/monitor/caps', {
      token: remoteToken,
      loopback: LAN_ALIAS,
      body: {
        id: cap.rule.id,
        scope: 'global',
        agent: null,
        period: 'daily',
        maxTokens: 999999,
        maxCostMicros: null,
        currency: 'USD',
        enforcement: 'block_unattended',
        enabled: true,
      },
    });
    expect(lanPut.status).toBe(403);

    const lanDel = await lanGw.api('DELETE', `/monitor/caps/${cap.rule.id}`, {
      token: remoteToken,
      loopback: LAN_ALIAS,
    });
    expect(lanDel.status).toBe(403);
  });
});
