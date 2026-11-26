// 1.8-D 离线集成测试：验证新增的 antigravity 与接入桥接后的 zcode、新版 codex 之间自动交接（H2～H4）与工作副本协作闭环。
import { closeSync, openSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeAdapter } from '@aic/adapters';
import { makeProject, startGw, WsClient, type TestGw } from './helpers';

let gw: TestGw | undefined;
afterEach(async () => { await gw?.stop(); gw = undefined; });

describe('1.8-D：Antigravity ↔ ZCode ↔ Codex 多 Agent 自动交接', { timeout: 45_000 }, () => {
  it('同一任务依次经 Antigravity → ZCode → Codex 交接续做，保留前序账本且不丢失上下文', async () => {
    const received: { agent: string; resources: string[]; text: string }[] = [];
    const makeTracked = (id: 'antigravity' | 'zcode' | 'codex', displayName: string) => {
      const base = createFakeAdapter({ speed: 0 });
      return {
        ...base,
        id,
        displayName,
        real: true,
        usesNativeConfig: true,
        permissionLevels: ['readonly', 'ask'] as ('readonly' | 'ask')[],
        async spawn(opts: Parameters<typeof base.spawn>[0]) {
          const conn = await base.spawn(opts);
          const origPrompt = conn.prompt.bind(conn);
          conn.prompt = async (input: Parameters<typeof origPrompt>[0], signal: AbortSignal) => {
            received.push({
              agent: id,
              resources: (input.resources ?? []).map((r: { text: string }) => r.text),
              text: input.text,
            });
            return origPrompt({ text: `${displayName} 已处理：${input.text}` }, signal);
          };
          return conn;
        },
      };
    };

    gw = await startGw({
      adapters: [
        makeTracked('antigravity', 'Antigravity'),
        makeTracked('zcode', 'ZCode'),
        makeTracked('codex', 'Codex'),
      ],
    });
    const token = await gw.pair();
    const project = await makeProject(gw, token);
    for (const kind of ['antigravity', 'zcode', 'codex']) {
      const en = await gw.api('PATCH', `/agents/${kind}`, { token, body: { enabled: true } });
      expect(en.status).toBe(200);
    }

    const ws = await WsClient.connect(gw.port, token);
    try {
      await ws.call({ op: 'subscribe', data: { lastSeq: 0 } });

      // 1. 先由 Antigravity 开启任务
      const created = await gw.api('POST', '/tasks', {
        token,
        body: { projectId: project.id, agent: 'antigravity', permission: 'readonly', prompt: '第一棒：梳理战斗数值表结构' },
      });
      expect(created.status).toBe(201);
      const taskId = created.json.id as string;
      await gw.gw.services.tasks.idle();

      // 2. 指定 target.agent = zcode 发送消息，自动触发 H2 交接
      const ack2 = await ws.call({
        op: 'prompt',
        data: { taskId, text: '第二棒：请继续核对暴击率上限', target: { agent: 'zcode' } },
      });
      expect(ack2.ok).toBe(true);
      await gw.gw.services.tasks.idle();

      // 3. 再指定 target.agent = codex 发送消息，自动触发第二次 H2 交接
      const ack3 = await ws.call({
        op: 'prompt',
        data: { taskId, text: '第三棒：汇总前两步结论', target: { agent: 'codex' } },
      });
      expect(ack3.ok).toBe(true);
      await gw.gw.services.tasks.idle();

      expect(received.map((r) => r.agent)).toEqual(['antigravity', 'zcode', 'codex']);
      // ZCode 与 Codex 收到交接资料包（含前序对话/任务账本）
      const zcodeContext = `${received[1]!.resources.join('\n')}\n${received[1]!.text}`;
      const codexContext = `${received[2]!.resources.join('\n')}\n${received[2]!.text}`;
      expect(zcodeContext).toContain('梳理战斗数值表结构');
      expect(codexContext).toContain('核对暴击率上限');

      const events = gw.gw.services.events.read({ taskId, after: 0, limit: 1000 });
      const handoffs = events.filter((e) => e.type === 'session.handoff');
      expect(handoffs).toHaveLength(2);
      expect(handoffs[0]!.data).toMatchObject({ from: 'antigravity', to: 'zcode', level: 'H2' });
      expect(handoffs[1]!.data).toMatchObject({ from: 'zcode', to: 'codex', level: 'H2' });
    } finally {
      await ws.close();
    }
  });

  it('POST /agents/zcode/test 在探测子进程短暂占用临时目录句柄时仍返回 200 而非 500', async () => {
    const base = createFakeAdapter({ speed: 0 });
    let heldFd: number | null = null;
    try {
      gw = await startGw({
        adapters: [
          {
            ...base,
            id: 'zcode',
            displayName: 'ZCode',
            real: true,
            usesNativeConfig: true,
            permissionLevels: ['readonly', 'ask'],
            async probe({ cwd }) {
              heldFd = openSync(path.join(cwd, 'app-server-cwd.lock'), 'w');
              return {
                ok: true,
                steps: [{ ts: Date.now(), label: 'ACP session/new', ok: true, ms: 12 }],
                caps: {
                  loadSession: true,
                  resume: true,
                  list: true,
                  close: true,
                  fork: false,
                  modelSwitch: 'configOption',
                  thoughts: true,
                  modes: [{ id: 'plan', name: 'Plan' }, { id: 'build', name: 'Build' }],
                  prompt: { image: true, audio: false, embeddedContext: true },
                  mcp: { http: false, sse: false },
                  extensions: [],
                },
                config: {
                  model: 'GLM-5.3',
                  effort: null,
                  mode: 'plan',
                  models: [{ id: 'GLM-5.3', name: 'GLM-5.3', contextWindow: null }],
                  efforts: null,
                  modes: [{ id: 'plan', name: 'Plan' }, { id: 'build', name: 'Build' }],
                  source: 'configOptions',
                  ids: { model: 'model', effort: null, mode: 'mode' },
                },
                authMethods: [],
              };
            },
          },
        ],
      });
      const token = await gw.pair();
      await gw.api('PATCH', '/agents/zcode', { token, body: { enabled: true } });
      const res = await gw.api('POST', '/agents/zcode/test', { token, body: {} });
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ ok: true });
    } finally {
      if (heldFd !== null) {
        try { closeSync(heldFd); } catch { /* 忽略 */ }
      }
    }
  });
});
