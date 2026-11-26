// 1.8 专项契约测试：Codex 2.12.0 升级、Google Antigravity 官方 agy acp 接入、ZCode 受控桥接（ISSUE-0181、ISSUE-0009、ISSUE-0020）。
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentError, ANTIGRAVITY_CLI_MISSING_WITH_APP, ANTIGRAVITY_NOT_FOUND, buildChildEnv, buildNativeEnv, codexPaths,
  createAdapters, createAntigravityAdapter, createCodexAdapter, createZcodeAdapter, findAntigravity, isVerified,
  normalizePermission, zcodeBridgeEnv, zcodeBridgePaths, type AgentConnection,
} from '../src/index';
import { FIXTURE, LogSink, RecordingHost, scenario, type Scenario } from './helpers';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });
const use = (sc: Scenario) => { cleanups.push(() => sc.cleanup()); return sc; };
const track = (c: AgentConnection) => { cleanups.push(() => c.close()); return c; };
const tempDir = (prefix: string) => { const d = mkdtempSync(path.join(tmpdir(), prefix)); cleanups.push(() => { try { rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ } }); return d; };

/** 生成模拟 agy 入口：--version 打印版本号，其余参数原样转交给假 ACP Agent 子进程 */
function makeFakeAgy(version = '1.5.18'): string {
  const dir = tempDir('aic-fake-agy-');
  const file = path.join(dir, 'agy.mjs');
  writeFileSync(file, [
    `if (process.argv.includes('--version')) { console.log(${JSON.stringify(version)}); process.exit(0); }`,
    `await import(${JSON.stringify(`file://${FIXTURE.replace(/\\/g, '/')}`)});`,
  ].join('\n'));
  return file;
}

/** 生成模拟 zcode.cjs 入口：--version 打印版本号 */
function makeFakeZcodeJs(version = '0.17.1'): string {
  const dir = tempDir('aic-fake-zcode-');
  const file = path.join(dir, 'zcode.cjs');
  writeFileSync(file, `if (process.argv.includes('--version')) { console.log(${JSON.stringify(version)}); process.exit(0); }\n`);
  return file;
}

describe('1.8-A：新版 Codex 升级与认证通知脱敏', () => {
  it('锁定 codex-acp 2.12.0 与内置 codex 0.171.0，列入已验证版本表', () => {
    const p = codexPaths();
    expect(p.adapterVersion).toBe('2.12.0');
    expect(p.engineVersion).toBe('0.171.0');
    expect(p.entry && existsSync(p.entry)).toBe(true);
    expect(p.codexJs && existsSync(p.codexJs)).toBe(true);
    expect(isVerified('codex', '2.12.0', '0.171.0')).toBe(true);
    expect(isVerified('codex', '2.5.0', '0.165.0')).toBe(false);
  });

  it('清理宿主嵌套的 CODEX / ANTIGRAVITY / AGY / ZCODE_ACP 会话变量', () => {
    const base = {
      PATH: 'C:\\Windows',
      CODEX_HOME: 'C:\\Users\\u\\.codex',
      CODEX_SESSION_ID: 'host-sess',
      CODEX_THREAD_ID: 'host-thread',
      CODEX_APP_TOOLS_PIPE_PATH: '\\\\.\\pipe\\codex',
      ANTIGRAVITY_CONVERSATION_ID: 'agy-conv',
      ANTIGRAVITY_CSRF_TOKEN: 'secret-csrf',
      AGY_BROWSER_ACTIVE_PORT_FILE: 'port',
      ZCODE_ACP_REMOTE: '1',
    };
    expect(buildNativeEnv({}, base)).toEqual({ PATH: 'C:\\Windows', CODEX_HOME: 'C:\\Users\\u\\.codex' });
    expect(buildChildEnv({}, base)).toEqual({ PATH: 'C:\\Windows' });
  });

  it('createAdapters 同时注册 codex、antigravity、zcode 且真实 Agent 仅开放只读与需审批', () => {
    const list = createAdapters({ log: () => {} });
    for (const id of ['claude', 'codex', 'antigravity', 'codebuddy', 'workbuddy', 'zcode']) {
      const a = list.find((x) => x.id === id);
      expect(a).toBeDefined();
      expect(a!.permissionLevels).toEqual(['readonly', 'ask']);
    }
    expect(createCodexAdapter({ log: () => {} }).usesNativeConfig).toBe(true);
  });
});

describe('1.8-B：Google Antigravity 官方 agy acp 接入', () => {
  it('未找到 agy 时按是否安装桌面版返回对应中文指引，自动检索 %LOCALAPPDATA%\\agy\\bin', async () => {
    const empty = tempDir('aic-empty-');
    const missing = createAntigravityAdapter({ log: () => {}, enginePath: path.join(empty, 'missing-agy.exe') });
    const d = await missing.detect({ force: true });
    expect(d.installed).toBe(false);
    expect([ANTIGRAVITY_CLI_MISSING_WITH_APP, ANTIGRAVITY_NOT_FOUND]).toContain(d.message);

    if (process.platform === 'win32') {
      const fakeLocal = tempDir('aic-localapp-');
      const binDir = path.join(fakeLocal, 'agy', 'bin');
      const agyExe = path.join(binDir, 'agy.exe');
      rmSync(binDir, { recursive: true, force: true });
      writeFileSync(path.join(fakeLocal, 'placeholder'), '');
      expect(findAntigravity(null, { LOCALAPPDATA: fakeLocal, PATH: empty })).toBeNull();
      const { mkdirSync } = await import('node:fs');
      mkdirSync(binDir, { recursive: true });
      writeFileSync(agyExe, '');
      expect(findAntigravity(null, { LOCALAPPDATA: fakeLocal, PATH: empty })).toBe(agyExe);
    }
  });

  it('检测登录状态：session/new 成功判已登录，返回 -32000 Authentication required 判未登录', async () => {
    const agy = makeFakeAgy('1.5.18');
    const okSc = use(scenario({
      config: {
        models: [{ value: 'gemini-4-neon', name: 'Gemini 4 Neon' }],
        efforts: ['low', 'medium', 'high', 'xhigh'],
        modes: [{ value: 'default', name: 'Default' }, { value: 'accept-edits', name: 'Accept edits' }, { value: 'plan', name: 'Plan' }],
        currentMode: 'default',
      },
    }));
    const okAdapter = createAntigravityAdapter({ log: () => {}, enginePath: agy });
    const d1 = await okAdapter.detect({ force: true, env: okSc.env });
    expect(d1).toMatchObject({ installed: true, version: '1.5.18', engineVersion: '1.5.18', verified: true, loggedIn: true, loginCheck: 'acp', message: null });

    const unauthSc = use(scenario({ newError: { code: -32000, message: 'Authentication required' } }));
    const unauthAdapter = createAntigravityAdapter({ log: () => {}, enginePath: agy });
    const d2 = await unauthAdapter.detect({ force: true, env: unauthSc.env });
    expect(d2).toMatchObject({ installed: true, loggedIn: false, loginCheck: 'acp' });
    expect(d2.message).toContain('还没有登录');
  });

  it('启动固定传 acp --disable-telemetry（绝不传 --dangerously-skip-permissions），支持思考强度切换与审批拒绝', async () => {
    const agy = makeFakeAgy('1.5.18');
    const sc = use(scenario({
      config: {
        models: [{ value: 'gemini-4-neon', name: 'Gemini 4 Neon' }, { value: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' }],
        efforts: ['low', 'medium', 'high', 'xhigh'],
        modes: [{ value: 'default', name: 'Default' }, { value: 'accept-edits', name: 'Accept edits' }, { value: 'plan', name: 'Plan' }],
        currentMode: 'accept-edits',
      },
      turns: [{
        steps: [{
          permission: {
            toolCall: { toolCallId: 'tc_agy_1', title: '修改 config.json', kind: 'edit', rawInput: { path: 'config.json' } },
            options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }],
          },
          then: {
            allow: [{ update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '已写入' } } }],
            reject: [{ update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '已按拒绝停止修改' } } }],
          },
        }],
      }],
    }));
    const host = new RecordingHost();
    host.decide = async (req) => {
      const rej = req.options.find((o) => o.kind === 'reject_once');
      return rej ? { outcome: 'selected', optionId: rej.id } : { outcome: 'cancelled' };
    };
    const adapter = createAntigravityAdapter({ log: new LogSink().fn, enginePath: agy });
    const conn = track(await adapter.spawn({ cwd: sc.dir, env: sc.env, model: 'gemini-4-neon', effort: 'xhigh', permission: 'ask', host }));
    conn.ready?.();
    const startLog = sc.log().find((x) => x.event === 'start');
    expect(startLog?.argv).toEqual(['acp', '--disable-telemetry']);
    expect(startLog?.argv).not.toContain('--dangerously-skip-permissions');
    // 初始即使在 accept-edits，也会在发消息前被收紧为 default（需审批）
    expect(conn.config?.().mode).toBe('default');
    expect(conn.config?.().effort).toBe('xhigh');
    const res = await conn.prompt({ text: '试着改文件' }, new AbortController().signal);
    expect(res.stopReason).toBe('end_turn');
    expect(host.requests).toHaveLength(1);
    expect(host.of('message').map((m) => m.text).join('')).toContain('已按拒绝停止修改');

    // 验证 Antigravity PascalCase 字段（CommandLine / toolSummary / Path）完整映射进权限规则结构
    const norm = normalizePermission({
      toolCall: {
        toolCallId: 'call_cmd_1',
        kind: 'execute',
        title: 'node -v',
        rawInput: { CommandLine: 'git push origin main', toolSummary: 'Push changes' },
      },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }],
    }, { agentName: 'Antigravity', cwd: sc.dir });
    expect(norm.request.operation).toMatchObject({ tool: 'shell', command: 'git push origin main', complete: true });
    expect(norm.request.reason).toBe('Push changes');
  });
});

describe('1.8-C：新版 ZCode 受控桥接与非 yolo 强制门禁', () => {
  it('zcode-acp-server 0.94.0 入口存在，受控环境变量关闭远程 hub 并显式指定模式', () => {
    const b = zcodeBridgePaths();
    expect(b.adapterVersion).toBe('0.94.0');
    expect(b.entry && existsSync(b.entry)).toBe(true);
    expect(isVerified('zcode', '0.94.0', '0.17.1')).toBe(true);
    const env = zcodeBridgeEnv('C:\\ZCode\\zcode.cjs', 'build');
    expect(env).toMatchObject({
      ZCODE_BIN: 'C:\\ZCode\\zcode.cjs',
      ZCODE_NODE: process.execPath,
      ZCODE_ACP_RUNTIME: 'node',
      ZCODE_ACP_REMOTE: '0',
      ZCODE_ACP_QUOTA_AUTO_RESUME: '0',
      ZCODE_ACP_MODE: 'build',
    });
  });

  it('根据 session/new 的 selectable 服务列表判断桌面端是否已登录，不读 ~/.zcode', async () => {
    const zjs = makeFakeZcodeJs('0.17.1');
    const unauthSc = use(scenario({
      newError: undefined,
      initialize: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'zcode-acp-server', version: '0.94.0' }, authMethods: [] },
      config: { models: [], modes: [{ value: 'plan', name: 'Plan' }, { value: 'build', name: 'Build' }], currentMode: 'plan' },
    }));
    const a1 = createZcodeAdapter({ enginePath: zjs, bridgeEntry: FIXTURE });
    const d1 = await a1.detect({ force: true, env: unauthSc.env });
    expect(d1).toMatchObject({ installed: true, adapterVersion: '0.94.0', engineVersion: '0.17.1', verified: true, loggedIn: false, loginCheck: 'acp' });
    expect(d1.unsupported).toBeUndefined();

    const okSc = use(scenario({
      config: { models: [{ value: 'GLM-5.3', name: 'GLM-5.3' }], modes: [{ value: 'plan', name: 'Plan' }, { value: 'build', name: 'Build' }], currentMode: 'build' },
    }));
    const a2 = createZcodeAdapter({ enginePath: zjs, bridgeEntry: FIXTURE });
    const d2 = await a2.detect({ force: true, env: okSc.env });
    expect(d2).toMatchObject({ installed: true, verified: true, loggedIn: true, loginCheck: 'acp', message: null });
  });

  it('需审批映射到 build（严于 edit / guarded / yolo）；若桥接器顽固停留在 guarded 或 yolo 则拒绝启动会话', async () => {
    const zjs = makeFakeZcodeJs('0.17.1');
    const stickyYolo = use(scenario({
      stickyMode: true,
      config: {
        models: [{ value: 'GLM-5.3', name: 'GLM-5.3' }],
        modes: [{ value: 'plan', name: 'Plan' }, { value: 'build', name: 'Build' }, { value: 'guarded', name: 'Guarded' }, { value: 'yolo', name: 'Yolo' }],
        currentMode: 'guarded',
      },
    }));
    const badAdapter = createZcodeAdapter({ enginePath: zjs, bridgeEntry: FIXTURE });
    await expect(badAdapter.spawn({ cwd: stickyYolo.dir, env: stickyYolo.env, model: null, effort: null, permission: 'ask', host: new RecordingHost() }))
      .rejects.toBeInstanceOf(AgentError);

    const normalSc = use(scenario({
      watchEnv: ['ZCODE_ACP_MODE', 'ZCODE_ACP_REMOTE', 'ZCODE_ACP_RUNTIME'],
      config: {
        models: [{ value: 'GLM-5.3', name: 'GLM-5.3' }],
        modes: [{ value: 'plan', name: 'Plan' }, { value: 'build', name: 'Build' }, { value: 'guarded', name: 'Guarded' }, { value: 'yolo', name: 'Yolo' }],
        currentMode: 'yolo',
      },
    }));
    const okAdapter = createZcodeAdapter({ enginePath: zjs, bridgeEntry: FIXTURE });
    const conn = track(await okAdapter.spawn({ cwd: normalSc.dir, env: normalSc.env, model: null, effort: null, permission: 'ask', host: new RecordingHost() }));
    conn.ready?.();
    expect(conn.config?.().mode).toBe('build');
    expect(normalSc.log().find((x) => x.event === 'start')?.env).toEqual({
      ZCODE_ACP_MODE: 'build',
      ZCODE_ACP_REMOTE: '0',
      ZCODE_ACP_RUNTIME: 'node',
    });
  });
});
