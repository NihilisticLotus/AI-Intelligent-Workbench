// 真实 Agent 冒烟测试（phase-1.md 6.8）：只在 AIC_REAL_AGENTS=1 时运行，默认的 npm test 跳过。
// 会启动本机真实的 Claude Code / Codex / CodeBuddy，并发少量消息（会产生少量费用）。运行前在验收记录里注明。
// 可用 AIC_REAL_AGENTS_ONLY=claude,codex 只跑一部分；AIC_REAL_AGENTS_REPORT=<文件> 把结果写成 JSON（写进验收记录用）。
//
// 每个 Agent 最多 3 条极短的消息（联调时约定的预算）：
//   detect → initialize → session/new（空的临时目录，“需审批”，注入 aic-echo 只检查能否拉起）
//   → ①“只回复 OK” → ② 新建 hello.txt（应出现一次审批，允许后文件确实生成）
//   → 会话内切换模型和思考强度 → ③“只回复 OK” → close → resume（不再发消息，只看能否恢复）。
// 让模型调用 aic-echo 工具、恢复后是否记得上下文，本步不再花钱验证（记为未验证，见 ISSUE-0001）。
// 6.9 的未验证项用 expect.soft 记录，不让一项失败挡住后面的检查。
// 安全：不读取任何凭据文件；日志经适配器脱敏；报告里只有布尔值、版本号、模型 id、审批标题和耗时。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createClaudeAdapter, createCodebuddyAdapter, createCodexAdapter, type AgentAdapter, type AgentConnection, type AgentUpdate,
  type PermissionOutcome, type PermissionRequest, type SessionHost,
} from '../src/index';

const ENABLED = process.env.AIC_REAL_AGENTS === '1';
const ONLY = (process.env.AIC_REAL_AGENTS_ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const ECHO = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'echo-mcp.mjs');
const STEP_MS = 5 * 60_000;
const OK_PROMPT = '只回复 OK 两个字母，不要使用任何工具。';
const FILE_PROMPT = '在当前目录新建 hello.txt，内容为 hi';

const logs: string[] = [];
const rt = { log: (level: string, msg: string) => { if (level !== 'debug') logs.push(`${level} ${msg}`); } };
const KINDS: { kind: string; name: string; make: () => AgentAdapter }[] = [
  { kind: 'claude', name: 'Claude Code', make: () => createClaudeAdapter(rt) },
  { kind: 'codex', name: 'Codex', make: () => createCodexAdapter(rt) },
  { kind: 'codebuddy', name: 'CodeBuddy', make: () => createCodebuddyAdapter({ ...rt, enginePath: null }) },
];
const report: Record<string, Record<string, unknown>> = {};

afterAll(() => {
  const file = process.env.AIC_REAL_AGENTS_REPORT;
  if (ENABLED && file) writeFileSync(file, JSON.stringify(report, null, 2));
  if (ENABLED) console.log(JSON.stringify(report, null, 2));
});

/** 记录回复文本和审批；allowWrites 为 true 时放行（选 allow_once），否则一律拒绝 */
class SmokeHost implements SessionHost {
  text = '';
  updates: AgentUpdate[] = [];
  requests: PermissionRequest[] = [];
  allowWrites = false;
  update(u: AgentUpdate) { this.updates.push(u); if (u.kind === 'message') this.text += u.text; }
  async requestPermission(req: PermissionRequest): Promise<PermissionOutcome> {
    this.requests.push(req);
    const pick = req.options.find((o) => (this.allowWrites ? o.kind === 'allow_once' : o.kind.startsWith('reject')));
    return pick ? { outcome: 'selected', optionId: pick.id } : { outcome: 'cancelled' };
  }
  reset() { this.text = ''; this.updates = []; }
  tools() { return this.updates.filter((u) => u.kind === 'tool_start').map((u) => (u as { title: string }).title); }
}

const timed = async <T>(fn: () => Promise<T>): Promise<[T, number]> => { const t = Date.now(); const r = await fn(); return [r, Date.now() - t]; };
const signal = () => new AbortController().signal;

describe.skipIf(!ENABLED)('真实 Agent 冒烟（AIC_REAL_AGENTS=1）', () => {
  for (const k of KINDS) {
    const run = ONLY.length === 0 || ONLY.includes(k.kind);
    it.skipIf(!run)(k.name, async () => {
      const a = k.make();
      const r: Record<string, unknown> = {};
      report[a.id] = r;
      const dir = mkdtempSync(path.join(tmpdir(), `aic-smoke-${a.id}-`));
      const echoLog = path.join(dir, 'echo.log');
      const work = path.join(dir, 'work');
      const conns: AgentConnection[] = [];
      try {
        // detect
        const [d, detectMs] = await timed(() => a.detect({ force: true }));
        Object.assign(r, { detectMs, installed: d.installed, loggedIn: d.loggedIn, adapterVersion: d.adapterVersion, engineVersion: d.engineVersion, verified: d.verified, loginCheck: d.loginCheck });
        expect(d.installed).toBe(true);
        if (!d.loggedIn) { r.skipped = '未登录（需要登录），跳过会话步骤'; return; }

        // initialize → session/new（注入 aic-echo）
        mkdirSync(work, { recursive: true });
        const host = new SmokeHost();
        const mcpServers = [{ name: 'aic-echo', command: process.execPath, args: [ECHO], env: [{ name: 'ECHO_LOG', value: echoLog }] }];
        const [conn, newMs] = await timed(() => a.spawn({ cwd: work, model: null, effort: null, permission: 'ask', host, mcpServers, sessionLabel: 'smoke' }));
        conns.push(conn);
        conn.ready?.();
        const cfg = conn.config!();
        Object.assign(r, { sessionNewMs: newMs, caps: conn.caps, models: cfg.models.map((m) => m.id), model: cfg.model, efforts: cfg.efforts, effort: cfg.effort, mode: cfg.mode });
        expect(conn.agentSessionId).toBeTruthy();
        // 注入的 MCP 在建会话时就被拉起（ISSUE-0001 实测结论；Codex 在后台启动，稍等）
        const until = Date.now() + 15_000;
        while (!existsSync(echoLog) && Date.now() < until) await new Promise((res) => setTimeout(res, 200));
        r.mcpStarted = existsSync(echoLog);
        expect.soft(r.mcpStarted).toBe(true);

        // ① 只回复 OK
        host.reset();
        const [p1, p1Ms] = await timed(() => conn.prompt({ text: OK_PROMPT }, signal()));
        Object.assign(r, { ok1Stop: p1.stopReason, ok1Ms: p1Ms, ok1Replied: /OK/i.test(host.text), ok1Tools: host.tools() });
        expect(p1.stopReason).toBe('end_turn');
        expect.soft(r.ok1Replied).toBe(true);

        // ② 一次审批：新建 hello.txt，允许后文件应确实生成
        host.reset();
        host.allowWrites = true;
        const before = host.requests.length;
        const [p2, p2Ms] = await timed(() => conn.prompt({ text: FILE_PROMPT }, signal()));
        host.allowWrites = false;
        const hello = path.join(work, 'hello.txt');
        const newReqs = host.requests.slice(before);
        Object.assign(r, {
          fileStop: p2.stopReason, fileMs: p2Ms, fileTools: host.tools(),
          approvals: newReqs.map((q) => ({ title: q.title, options: q.options.map((o) => o.kind) })),
          fileCreated: existsSync(hello), fileContent: existsSync(hello) ? readFileSync(hello, 'utf8').trim() : null,
        });
        expect.soft(newReqs.length).toBeGreaterThan(0);
        expect.soft(r.fileCreated).toBe(true);

        // 会话内切换模型和思考强度（H0）
        const otherModel = cfg.models.find((m) => m.id !== conn.config!().model)?.id;
        if (otherModel) {
          try { await conn.setConfig({ model: otherModel }); r.switchModel = conn.config!().model === otherModel; } catch (e) { r.switchModel = `失败：${(e as Error).message}`; }
          r.switchedTo = otherModel;
          expect.soft(r.switchModel).toBe(true);
        } else r.switchModel = '只有一个模型，无法切换';
        const st = conn.config!();
        const otherEffort = st.efforts?.find((x) => x !== st.effort);
        if (otherEffort) {
          try { await conn.setConfig({ effort: otherEffort }); r.switchEffort = conn.config!().effort === otherEffort; } catch (e) { r.switchEffort = `失败：${(e as Error).message}`; }
          r.effortTo = otherEffort;
          expect.soft(r.switchEffort).toBe(true);
        } else r.switchEffort = '不能调节或只有一个选项';

        // ③ 换完再发一条“只回复 OK”
        host.reset();
        const [p3, p3Ms] = await timed(() => conn.prompt({ text: OK_PROMPT }, signal()));
        Object.assign(r, { ok2Stop: p3.stopReason, ok2Ms: p3Ms, ok2Replied: /OK/i.test(host.text), configAfter: { model: conn.config!().model, effort: conn.config!().effort } });
        expect.soft(p3.stopReason).toBe('end_turn');
        expect.soft(r.ok2Replied).toBe(true);

        // close → resume（不发消息；只看已有对话的会话能否恢复、恢复后的模型）
        const sid = conn.agentSessionId;
        await conn.close();
        const host2 = new SmokeHost();
        const [conn2, resumeMs] = await timed(() => a.spawn({ cwd: work, model: null, effort: null, permission: 'ask', host: host2, resume: { agentSessionId: sid }, sessionLabel: 'smoke-resume' }));
        conns.push(conn2);
        conn2.ready?.();
        Object.assign(r, { resumeMs, resumed: conn2.resumed ?? false, resumeFailure: conn2.resumeFailure ?? null, resumedModel: conn2.config!().model, resumedEffort: conn2.config!().effort });
        expect.soft(conn2.resumed).toBe(true);
      } finally {
        for (const c of conns) await c.close().catch(() => {});
        // 日志只用于排查，已经过适配器脱敏
        r.warnings = logs.filter((l) => (l.startsWith('warn') || l.startsWith('error')) && l.includes(a.id)).slice(-20);
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 上偶尔被占用 */ }
      }
    }, STEP_MS * 3);
  }
});
