// Gateway 入口：打开数据库、组装服务、监听 127.0.0.1（端口被占用时顺延）、托管网页、打开浏览器。
import { spawn } from 'node:child_process';
import type { Server } from 'node:http';
import { hostname } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createAdaptorServer } from '@hono/node-server';
import { createAdapters, type AcpRuntime, type AcpTimeouts, type AgentAdapter, type LogFn } from '@aic/adapters';
import { AgentRegistry } from './agents/registry';
import { createFakeAdapter } from './agents/fake';
import { AgentService } from './agents/service';
import { ProcessRegistry } from './processes';
import { ProfileService } from './profiles';
import { defaultSecretStore, SecretService, type SecretStore } from './secrets';
import { AuthService, type AuthOptions } from './auth';
import { openDb } from './db';
import { acquireInstanceLock, AlreadyRunningError, probeGateway } from './instance-lock';
import { EventBus, EventStore } from './events';
import { createApp } from './http/app';
import { GroupService, ProjectService } from './projects';
import type { Services } from './services';
import { AttachmentService } from './attachments';
import { IndependentCatalog } from './independent/catalog';
import { IndependentDiscovery } from './independent/discovery';
import type { readMetadataJson } from './independent/metadata-http';
import { TaskService } from './tasks';
import { newId } from './util';

const delay = (ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); t.unref?.(); });
import { attachWs } from './ws';
import { gatewayLog, installCrashHandlers, readLastExit, lifecycle } from './crash-log';

export const VERSION = '0.1.0';

/**
 * Agent 日志：写进数据目录的 logs/agents.log（stderr 已脱敏）；info 及以上同时打印到终端。
 * 超过 10MB 时轮换成 agents.log.1。
 */
function agentLogger(dataDir: string, print: (m: string) => void): LogFn {
  const dir = path.join(dataDir, 'logs');
  const file = path.join(dir, 'agents.log');
  try { mkdirSync(dir, { recursive: true }); } catch { /* 下面写入时再报 */ }
  let n = 0;
  return (level, msg) => {
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${msg}\n`;
    try {
      if (++n % 200 === 0 && statSync(file).size > 10 * 1024 * 1024) renameSync(file, `${file}.1`);
      appendFileSync(file, line);
    } catch { /* 日志写不进去不影响运行 */ }
    if (level !== 'debug' || process.env.AIC_DEBUG === '1') print(msg);
  };
}
export const DEFAULT_PORT = 17890;
const PORT_ATTEMPTS = 10;
const HOST = '127.0.0.1';

const here = path.dirname(fileURLToPath(import.meta.url));

export interface GatewayOptions {
  /** 数据目录；默认 AIC_DATA_DIR，其次 %APPDATA%\AI_Console */
  dataDir?: string;
  /** 起始端口；0 表示让系统随机分配（测试用） */
  port?: number;
  webDist?: string;
  /** 启动后是否打开浏览器（默认看 AIC_NO_BROWSER） */
  openBrowser?: boolean;
  devOrigin?: string;
  pairing?: Pick<AuthOptions, 'pairingTtlMs' | 'limits' | 'onPairingCode'>;
  /**
   * 开发模式（默认看 AIC_DEV=1，且 NODE_ENV 不是 production）：把启动时的配对码写进数据目录的
   * dev-pairing-code.txt，供预览工具读取。只有启动时那一个码会写入；启动脚本 start.mjs 会清掉这些开发变量。
   */
  dev?: boolean;
  approvalTimeoutMs?: number;
  /** 演示 Agent 的节奏倍率，测试里设为 0 */
  fakeSpeed?: number;
  /**
   * 1.2：是否注册真实 Agent（Claude Code、Codex、CodeBuddy）。默认注册；设 AIC_NO_REAL_AGENTS=1 或传 false 时只有演示 Agent。
   * 测试里默认不注册，不启动任何真实 Agent（phase-1.md 6.8）。
   */
  realAgents?: boolean;
  /** 额外注册的适配器（测试里注入接假 ACP Agent 的适配器） */
  adapters?: AgentAdapter[] | ((rt: AcpRuntime) => AgentAdapter[]);
  /** 密钥存储；默认 Windows 用 DPAPI，其他平台不支持 */
  secretStore?: SecretStore;
  /** 离线测试注入元数据响应；正式启动不从环境加载替代客户端。 */
  metadataReader?: typeof readMetadataJson;
  /** 会话空闲多久后关闭 Agent 进程，默认 30 分钟 */
  idleTimeoutMs?: number;
  noResponseNoticeMs?: number;
  noResponseCancelMs?: number;
  /** ACP 各阶段超时（测试里改小） */
  agentTimeouts?: Partial<AcpTimeouts>;
  log?: (msg: string) => void;
}

export interface Gateway {
  port: number;
  url: string;
  services: Services;
  /**
   * 关闭。deadlineMs：给“正常收尾”（停止回合、关闭会话）的时间上限，到点后先同步结束所有 Agent 进程树，
   * 再写库收尾。关闭控制台窗口（SIGHUP）时系统约 10 秒后强制结束 Node，必须先保证进程树被结束。
   */
  close(opts?: { deadlineMs?: number; reason?: string; code?: number }): Promise<void>;
}

export const DEV_CODE_FILE = 'dev-pairing-code.txt';
export { AlreadyRunningError };

export function defaultDataDir(): string {
  if (process.env.AIC_DATA_DIR) return path.resolve(process.env.AIC_DATA_DIR);
  const base = process.env.APPDATA ?? path.join(process.env.HOME ?? process.cwd(), '.config');
  return path.join(base, 'AI_Console');
}

/** 依次尝试端口，被占用时顺延，最多试 10 次 */
async function listen(server: Server, start: number): Promise<number> {
  const attempts = start === 0 ? 1 : PORT_ATTEMPTS;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    const port = start === 0 ? 0 : start + i;
    try {
      await new Promise<void>((resolve, reject) => {
        const onErr = (e: Error) => { server.off('listening', onOk); reject(e); };
        const onOk = () => { server.off('error', onErr); resolve(); };
        server.once('error', onErr);
        server.once('listening', onOk);
        server.listen(port, HOST);
      });
      const addr = server.address();
      return typeof addr === 'object' && addr ? addr.port : port;
    } catch (e) {
      lastErr = e;
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
    }
  }
  throw new Error(`端口 ${start}～${start + attempts - 1} 都被占用了，请关闭占用端口的程序后重试（${String(lastErr)}）`);
}

/** 用系统默认浏览器打开地址。只接受我们自己拼出的本机地址，避免命令注入 */
export function openBrowser(url: string) {
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}\/(#[A-Za-z0-9=_-]*)?$/.test(url)) {
    throw new Error(`拒绝打开不安全的地址：${url}`);
  }
  if (process.platform === 'win32') {
    // start 的第一个带引号参数是窗口标题，所以先给一个空标题；URL 用引号包住，cmd 不会解析其中的 & | 等字符
    spawn('cmd', ['/d', '/s', '/c', `start "" "${url}"`], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

export async function createGateway(opts: GatewayOptions = {}): Promise<Gateway> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const dataDir = opts.dataDir ?? defaultDataDir();
  // 单实例：必须在打开数据库、恢复任务状态之前确认没有别的实例在用这个数据目录
  const lock = await acquireInstanceLock(dataDir);
  const lastExit = readLastExit(dataDir);
  const startedAt = Date.now();
  if (lastExit?.clean === false) gatewayLog(dataDir, 'WARN', lastExit.reason ?? '上次运行没有正常退出');
  lifecycle(dataDir, 'start', startedAt, '启动');
  const db = (() => {
    try { return openDb(path.join(dataDir, 'data.db')); } catch (e) { lock.release(); throw e; }
  })();

  let machineId = db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'machine_id'")?.value;
  if (!machineId) { machineId = newId('mc'); db.run("INSERT INTO meta (key, value) VALUES ('machine_id', ?)", machineId); }
  // 实例标识：决定 Cookie 名，不同数据目录的 Gateway（开发实例和正式实例）不会互相覆盖 Cookie
  const instanceId = createHash('sha256').update(machineId).digest('hex').slice(0, 8);
  const bootId = newId('boot');

  const dev = opts.dev ?? (process.env.AIC_DEV === '1' && process.env.NODE_ENV !== 'production');
  const devCodeFile = path.join(dataDir, DEV_CODE_FILE);
  if (dev) log('【开发模式】启动时的配对码会写进数据目录的 dev-pairing-code.txt，只用于开发调试。');

  let port = 0;
  const auth = new AuthService(db, {
    devOrigin: opts.devOrigin ?? process.env.AIC_DEV_ORIGIN,
    ...opts.pairing,
    instanceId,
  });
  const events = new EventStore(db, new EventBus());
  const agentLog = agentLogger(dataDir, log);
  const processes = new ProcessRegistry(db, log);
  const agents = new AgentRegistry();
  const real = opts.realAgents ?? process.env.AIC_NO_REAL_AGENTS !== '1';
  const rt: AcpRuntime = { log: agentLog, tracker: processes, ...(opts.agentTimeouts ? { timeouts: opts.agentTimeouts } : {}) };
  if (real) for (const a of createAdapters({ ...rt, fakeSpeed: opts.fakeSpeed ?? 1 })) agents.register(a);
  else agents.register(createFakeAdapter({ speed: opts.fakeSpeed ?? 1 }));
  for (const a of typeof opts.adapters === 'function' ? opts.adapters(rt) : opts.adapters ?? []) agents.register(a);
  const audit = (deviceId: string | null, action: string, detail: string) => {
    try { db.run('INSERT INTO audit_log (device_id, action, detail, ts) VALUES (?, ?, ?, ?)', deviceId, action, detail, Date.now()); } catch { /* 忽略 */ }
  };
  const secrets = new SecretService(db, opts.secretStore ?? defaultSecretStore(db));
  const independent = new IndependentCatalog(db, secrets, events);
  const independentDiscovery = new IndependentDiscovery(db, independent, opts.metadataReader);
  const agentSvc = new AgentService(db, events, agents, { dataDir, log, audit });
  const profiles = new ProfileService(db, secrets, {
    dataDir, audit,
    adapter: (k) => agents.get(k),
    loggedIn: (id) => agentSvc.profileLoggedIn(id),
  });
  agentSvc.attach(profiles);
  const tasks = new TaskService(db, events, agents, {
    ...(opts.approvalTimeoutMs !== undefined ? { approvalTimeoutMs: opts.approvalTimeoutMs } : {}),
    ...(opts.idleTimeoutMs !== undefined ? { idleTimeoutMs: opts.idleTimeoutMs } : {}),
    ...(opts.noResponseNoticeMs !== undefined ? { noResponseNoticeMs: opts.noResponseNoticeMs } : {}),
    ...(opts.noResponseCancelMs !== undefined ? { noResponseCancelMs: opts.noResponseCancelMs } : {}),
    log,
  });
  const attachments = new AttachmentService(db, dataDir);
  attachments.cleanup();
  const cleanupTimer = setInterval(() => { try { attachments.cleanup(); } catch (e) { log('附件清理失败：' + String(e)); } }, 60 * 60_000);
  cleanupTimer.unref?.();
  tasks.attachments = attachments;
  tasks.agentSvc = agentSvc;
  tasks.recoverOnStartup();
  // 上次遗留的 Agent 进程（核对启动时间后结束进程树）；不在启动时预先拉起 Agent
  void processes.cleanupOrphans().catch((e) => log(`清理遗留的 Agent 进程失败：${String(e)}`));
  const projects = new ProjectService(db);
  const groups = new GroupService(db, tasks);

  const services: Services = {
    db, attachments, independent, independentDiscovery, lastExit, auth, events, agents, agentSvc, profiles, secrets, processes, projects, groups, tasks,
    port: () => port,
    machine: { id: machineId, name: hostname(), os: process.platform === 'win32' ? 'windows' : process.platform },
    version: VERSION,
    bootId,
  };

  const webDist = opts.webDist ?? path.resolve(here, '../../../apps/web/dist');
  const app = createApp(services, { webDist });
  const server = createAdaptorServer({ fetch: app.fetch }) as Server;
  const ws = attachWs(server, services);

  try {
    port = await listen(server, opts.port ?? Number(process.env.AIC_PORT ?? DEFAULT_PORT));
  } catch (e) {
    db.close();
    lock.release();
    throw e;
  }
  auth.setPort(port);
  lock.setPort(port);
  // 检测全部 Agent（后台进行；GET /agents 会等它完成）
  void agentSvc.startup().catch((e) => log(`检测 Agent 失败：${String(e)}`));
  const url = `http://${HOST}:${port}/`;

  const shouldOpen = opts.openBrowser ?? process.env.AIC_NO_BROWSER !== '1';
  // 启动时生成一次性配对码，并带着它打开浏览器
  const { code } = auth.newPairingCode();
  if (dev) {
    try { writeFileSync(devCodeFile, `${code}\n${port}\n`, { mode: 0o600 }); } catch (e) { log(`写入开发用配对码文件失败：${String(e)}`); }
  }
  if (shouldOpen) {
    try { openBrowser(`${url}#pair=${code}`); } catch (e) { log(`打开浏览器失败：${String(e)}，请手动打开 ${url}`); }
  }

  let closed = false;
  return {
    port, url, services,
    async close(opts: { deadlineMs?: number; reason?: string; code?: number } = {}) {
      if (closed) return;
      closed = true;
      clearInterval(cleanupTimer);
      independentDiscovery.close();
      ws.close();
      agentSvc.shutdown();
      const graceful = Promise.all([tasks.shutdown(), attachments.close()]);
      if (opts.deadlineMs !== undefined) {
        // 两段式：正常收尾最多等 deadlineMs，到点就先同步结束所有 Agent 进程树，再给写库收尾一点时间
        const timedOut = await Promise.race([graceful.then(() => false), delay(opts.deadlineMs).then(() => true)]);
        processes.killAllSync();
        if (timedOut) await Promise.race([graceful, delay(2000)]);
      } else {
        await graceful;
      }
      // 兜底：还活着的 Agent 进程一律结束进程树
      processes.killAllSync();
      await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections?.(); });
      db.close();
      if (dev) rmSync(devCodeFile, { force: true });
      lifecycle(dataDir, 'exit', startedAt, opts.reason ?? '正常退出', opts.code ?? 0);
      lock.release();
    },
  };
}

// ---------- 直接运行时（npm start / npm run dev） ----------

function printCode(code: string, expiresAt: number) {
  const mins = Math.max(1, Math.round((expiresAt - Date.now()) / 60_000));
  console.log('');
  console.log(`  配对码：${code}（${mins} 分钟内有效，只能用一次）`);
  console.log('');
}

/** 退出码 3：已经有实例在运行（start.mjs 据此显示对应的提示） */
export const EXIT_ALREADY_RUNNING = 3;

/** 已有实例：让它在自己的终端窗口里打印配对码，然后打开浏览器到它的地址 */
async function openExisting(port: number) {
  if (!(await probeGateway(port))) return false;
  await fetch(`http://${HOST}:${port}/api/v1/pairing/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => {});
  if (process.env.AIC_NO_BROWSER !== '1') {
    try { openBrowser(`http://${HOST}:${port}/`); } catch { /* 下面会打印地址 */ }
  }
  return true;
}

async function main() {
  const dataDir = defaultDataDir();
  const startedAt = Date.now();
  process.on('exit', (code) => gatewayLog(dataDir, 'INFO', '进程退出 ' + JSON.stringify({ code, pid: process.pid, uptimeMs: Date.now() - startedAt })));
  let gwRef: Gateway | null = null;
  // 兜底：没接住的错误写进 logs/gateway.log（ISSUE-0015）；致命错误时尽量收尾，最多等 3 秒
  installCrashHandlers({
    dataDir,
    onFatal: () => {
      const done = () => process.exit(1);
      const t = setTimeout(done, 3000); t.unref?.();
      if (gwRef) void gwRef.close({ deadlineMs: 2500, reason: '未捕获异常', code: 1 }).catch(() => {}).finally(done); else done();
    },
  });
  gatewayLog(dataDir, 'INFO', `启动 v${VERSION}，Node ${process.version}，pid ${process.pid}`);
  let gw: Gateway;
  try {
    gw = await createGateway({ pairing: { onPairingCode: printCode } });
  } catch (e) {
    if (e instanceof AlreadyRunningError) {
      const opened = e.port ? await openExisting(e.port) : false;
      console.log('');
      console.log(e.port
        ? `AI Console 已经在运行：http://${HOST}:${e.port}/${opened ? '，已为你打开浏览器。' : ''}`
        : 'AI Console 已经在另一个窗口里启动，请稍等片刻后再打开。');
      console.log('需要配对码的话，请看最早打开的那个 AI Console 窗口。这个窗口可以关闭。');
      process.exit(EXIT_ALREADY_RUNNING);
    }
    throw e;
  }
  gwRef = gw;
  gatewayLog(dataDir, 'INFO', `已启动：${gw.url}`);
  console.log(`AI Console 已启动：${gw.url}`);
  console.log('浏览器没有自动打开的话，请手动打开上面的地址。关闭这个窗口即可退出。');
  let stopping = false;
  const stop = async (deadlineMs: number, reason: string) => {
    if (stopping) return;
    stopping = true;
    console.log('正在退出……');
    gatewayLog(dataDir, 'INFO', reason + ' ' + JSON.stringify({ pid: process.pid, uptimeMs: Date.now() - startedAt }));
    await gw.close({ deadlineMs, reason });
    process.exit(0);
  };
  // 都设上限：Agent 卡在启动或取消无响应时，先结束进程树，不至于等很久
  process.on('SIGINT', () => void stop(8000, '按了 Ctrl+C'));
  process.on('SIGBREAK', () => void stop(8000, '按了 Ctrl+Break'));
  process.on('SIGTERM', () => void stop(5000, '收到结束信号'));
  // Windows 上关闭控制台窗口时 Node 收到的是 SIGHUP，约 10 秒后进程会被强制结束：
  // 先在 3 秒内结束所有 Agent 进程树（否则孙进程 claude.exe / codex app-server 会留下来），再写库收尾
  process.on('SIGHUP', () => void stop(3000, '控制台窗口被关闭'));
}

const isEntry = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isEntry) {
  main().catch((e) => {
    gatewayLog(defaultDataDir(), 'FATAL', `启动失败：${e instanceof Error ? `${e.message}
${e.stack ?? ''}` : String(e)}`);
    console.error('AI Console 启动失败：', e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
