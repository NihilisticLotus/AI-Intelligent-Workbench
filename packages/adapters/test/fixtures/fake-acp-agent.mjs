// 假 ACP Agent 进程（phase-1.md 6.8）：用 @agentclientprotocol/sdk 2.4.0 的 Agent 端写成真正的子进程，
// 走和真实 Agent 一样的 AcpConnection（spawn、NDJSON、stderr、超时、进程树清理）。
// 剧本经环境变量 AIC_FAKE_SCENARIO=<剧本 JSON 路径> 传入；收到的请求逐行记进 AIC_FAKE_LOG，供测试断言。
import * as acp from '@agentclientprotocol/sdk/unstable';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';

const sc = JSON.parse(readFileSync(process.env.AIC_FAKE_SCENARIO, 'utf8'));
const logFile = process.env.AIC_FAKE_LOG;
const log = (o) => { if (logFile) appendFileSync(logFile, `${JSON.stringify(o)}\n`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 启动时：记下看到的环境变量（只记“有没有”），用来验证删除清单和账号变量
const watch = sc.watchEnv ?? [];
log({ event: 'start', pid: process.pid, argv: process.argv.slice(2), env: Object.fromEntries(watch.map((k) => [k, process.env[k] ?? null])) });
for (const l of sc.stderrOnStart ?? []) process.stderr.write(`${l}\n`);
for (const l of sc.stdoutNoiseOnStart ?? []) process.stdout.write(`${l}\n`);
if (sc.grandchild) {
  const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  log({ event: 'grandchild', pid: g.pid });
}
// 顽固：stdin 关闭后也不退出（验证进程树清理）
if (sc.stubborn) setInterval(() => {}, 1000);

// ---------- 配置状态 ----------
const cfg = sc.config ?? {};
const state = {
  model: cfg.currentModel ?? cfg.models?.[0]?.value ?? null,
  effort: cfg.currentEffort ?? null,
  mode: cfg.currentMode ?? cfg.modes?.[0]?.value ?? 'default',
};
const effortsOf = (m) => (Array.isArray(cfg.efforts) ? cfg.efforts : cfg.efforts?.[m] ?? null);
if (state.effort === null) { const e = effortsOf(state.model); state.effort = e ? e[Math.floor(e.length / 2)] : null; }

function configOptions() {
  const out = [];
  if (cfg.modes) out.push({ type: 'select', id: 'mode', name: 'Mode', category: 'mode', currentValue: state.mode, options: cfg.modes.map((m) => ({ value: m.value, name: m.name ?? m.value })) });
  if (cfg.models && !sc.legacy) out.push({ type: 'select', id: cfg.modelId ?? 'model', name: 'Model', category: 'model', currentValue: state.model, options: cfg.models });
  const eff = effortsOf(state.model);
  if (eff && !sc.legacy) out.push({ type: 'select', id: cfg.effortId ?? 'effort', name: 'Effort', category: 'thought_level', currentValue: state.effort, options: eff.map((v) => ({ value: v, name: v })) });
  return out;
}
function configResponse() {
  const r = {};
  if (!sc.legacy) r.configOptions = configOptions();
  if (sc.legacy || sc.legacyModels) {
    if (sc.legacyCombo) {
      const eff = effortsOf(state.model) ?? [];
      r.models = { availableModels: cfg.models.flatMap((m) => eff.map((e) => ({ modelId: `${m.value}[${e}]`, name: `${m.name} (${e})` }))), currentModelId: `${state.model}[${state.effort}]` };
    } else {
      r.models = { availableModels: cfg.models.map((m) => ({ modelId: m.value, name: m.name })), currentModelId: state.model };
    }
  }
  if (cfg.modes) r.modes = { availableModes: cfg.modes.map((m) => ({ id: m.value, name: m.name ?? m.value })), currentModeId: state.mode };
  return r;
}

const err = (e) => new acp.RequestError(e.code ?? -32603, e.message ?? 'Internal error', e.data);

let n = 0;
// persistTurns：回合计数跨进程保留（崩溃重启后接着下一个回合，而不是从头再来）
const turnFile = sc.persistTurns && logFile ? `${logFile}.turn` : null;
let turn = 0;
if (turnFile) { try { turn = Number(readFileSync(turnFile, 'utf8')) || 0; } catch { turn = 0; } }
let cancelWaiters = [];
let conn;
const update = (sessionId, u) => conn.client.notify('session/update', { sessionId, update: u });

async function runSteps(sessionId, steps, client) {
  for (const s of steps) {
    if (s.update) await update(sessionId, s.update);
    else if (s.notify) await client.notify(s.notify.method, s.notify.params);
    else if (s.sleep) await sleep(s.sleep);
    else if (s.crash !== undefined) { log({ event: 'crash' }); process.exit(s.crash); }
    else if (s.noise) process.stdout.write(`${s.noise}\n`);
    else if (s.stderr) process.stderr.write(`${s.stderr}\n`);
    else if (s.error) throw err(s.error);
    else if (s.mode) { state.mode = s.mode; await update(sessionId, { sessionUpdate: 'current_mode_update', currentModeId: s.mode }); }
    else if (s.waitCancel) {
      if (sc.ignoreCancel) await new Promise(() => {});
      await new Promise((r) => cancelWaiters.push(r));
      return 'cancelled';
    } else if (s.parallelPermissions) {
      // 并行的工具调用：同时发出多条审批请求（Claude 会这样做）
      const rs = await Promise.all(s.parallelPermissions.map((p) => client.request('session/request_permission', { sessionId, ...p })));
      for (const r of rs) log({ event: 'permission_response', response: r });
    } else if (s.permission) {
      const r = await client.request('session/request_permission', { sessionId, ...s.permission });
      log({ event: 'permission_response', response: r });
      const picked = r?.outcome?.outcome === 'selected' ? s.permission.options.find((o) => o.optionId === r.outcome.optionId) : null;
      const allowed = !!picked && String(picked.kind).startsWith('allow');
      const next = allowed ? s.then?.allow : s.then?.reject;
      if (next) { const st = await runSteps(sessionId, next, client); if (st) return st; }
    }
  }
  return null;
}

const app = acp.agent({ name: 'fake-acp-agent' })
  .onRequest('initialize', async ({ params }) => {
    log({ method: 'initialize', params });
    if (sc.hangInitialize) await new Promise(() => {});
    return sc.initialize ?? {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: sc.loadSession ?? false,
        sessionCapabilities: sc.sessionCapabilities ?? { resume: {}, close: {} },
        promptCapabilities: { image: true, embeddedContext: true },
        mcpCapabilities: { http: true, sse: false },
      },
      agentInfo: { name: 'fake-acp-agent', version: '9.9.9' },
      authMethods: [],
    };
  })
  .onRequest('session/new', async ({ params }) => {
    log({ method: 'session/new', params });
    if (sc.newError) throw err(sc.newError);
    const sessionId = `sess-${++n}`;
    for (const u of sc.afterNew ?? []) setTimeout(() => void update(sessionId, u), 0);
    return { sessionId, ...configResponse() };
  })
  .onRequest('session/resume', async ({ params }) => {
    log({ method: 'session/resume', params });
    if (sc.resume === 'notfound') throw err({ code: -32002, message: 'Resource not found', data: { sessionId: params.sessionId } });
    if (sc.resume === 'hang') await new Promise(() => {});
    // 恢复后配置回到默认值（实测 Codex 没跑过回合时如此）
    state.model = cfg.currentModel ?? cfg.models?.[0]?.value ?? null;
    return configResponse();
  })
  .onRequest('session/load', async ({ params }) => {
    log({ method: 'session/load', params });
    if (sc.load === 'notfound') throw err({ code: -32002, message: 'Resource not found' });
    for (const u of sc.loadReplay ?? []) await update(params.sessionId, u);
    return configResponse();
  })
  .onRequest('session/set_config_option', async ({ params }) => {
    log({ method: 'session/set_config_option', params });
    const { configId, value } = params;
    const bad = sc.setErrors?.[`${configId}:${value}`];
    if (bad) throw err(bad);
    if (configId === (cfg.modelId ?? 'model')) {
      if (!cfg.models.some((m) => m.value === value)) throw err({ code: -32602, message: `Invalid params: Invalid value for config option model: ${value}` });
      state.model = value;
      const eff = effortsOf(value);
      if (eff && !eff.includes(state.effort)) state.effort = eff[0];
    } else if (configId === (cfg.effortId ?? 'effort')) {
      const eff = effortsOf(state.model) ?? [];
      if (!eff.includes(value)) throw err({ code: -32603, message: 'Internal error', data: { details: `Current model does not support ${value}` } });
      state.effort = value;
    } else if (configId === 'mode') {
      // stickyMode：接受请求但模式不变（模拟 Agent 不认这个模式、或 settings 里的 defaultMode 覆盖了它）
      if (!sc.stickyMode) state.mode = value;
      await update(params.sessionId, { sessionUpdate: 'current_mode_update', currentModeId: state.mode });
    }
    // 推送连发（CodeBuddy 式）
    for (let i = 0; i < (sc.pushConfigTimes ?? 0); i++) await update(params.sessionId, { sessionUpdate: 'config_option_update', configOptions: configOptions() });
    return { configOptions: configOptions() };
  })
  .onRequest('session/set_mode', async ({ params }) => {
    log({ method: 'session/set_mode', params });
    if (sc.setModeError) throw err(sc.setModeError);
    if (!sc.stickyMode) state.mode = params.modeId;
    return {};
  })
  .onRequest('session/close', async ({ params }) => { log({ method: 'session/close', params }); return {}; })
  .onRequest('authenticate', async ({ params }) => { log({ method: 'authenticate', params }); return {}; })
  .onRequest('session/prompt', async ({ params, client }) => {
    log({ method: 'session/prompt', params });
    const turns = sc.turns ?? [{ steps: [{ update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' } } }] }];
    const t = turns[Math.min(turn, turns.length - 1)];
    turn++;
    if (turnFile) writeFileSync(turnFile, String(turn));
    const st = await runSteps(params.sessionId, t.steps ?? [], client);
    return { stopReason: st ?? t.stop ?? 'end_turn' };
  })
  .onNotification('session/cancel', ({ params }) => {
    log({ method: 'session/cancel', params });
    const w = cancelWaiters; cancelWaiters = [];
    for (const r of w) r();
  })
  .onRequest('*', async ({ method, params }) => {
    log({ method, params });
    if (method === 'session/set_model') { state.model = String(params.modelId).replace(/\[.*\]$/, ''); const m = /\[(.*)\]$/.exec(String(params.modelId)); if (m) state.effort = m[1]; return {}; }
    if (method === '_codebuddy.ai/getUserInfo') return sc.userInfo ?? {};
    throw acp.RequestError.methodNotFound(method);
  });

conn = app.connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
conn.closed.then(() => { log({ event: 'closed' }); if (!sc.stubborn) process.exit(0); });
