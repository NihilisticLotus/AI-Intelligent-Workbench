// Gateway 入口：打开数据库、组装服务、监听 127.0.0.1（端口被占用时顺延）、托管网页、打开浏览器。
import { outgoingRedactor } from './handoff/history';
import { limitTaskSummary } from './task-summary';
import { spawn } from 'node:child_process';
import type { Server } from 'node:http';
import type { Socket } from 'node:net';
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
import { acquireInstanceLock, AlreadyRunningError, probeGateway, type InstanceLock } from './instance-lock';
import { EventBus, EventStore } from './events';
import { createApp } from './http/app';
import { GroupService, ProjectService } from './projects';
import type { Services } from './services';
import { AttachmentService } from './attachments';
import { IndependentCatalog } from './independent/catalog';
import { IndependentDiscovery } from './independent/discovery';
import { IndependentTaskRuntime } from './independent/task-runtime';
import type { readMetadataJson } from './independent/metadata-http';
import { TaskService } from './tasks';
import { MonitorService } from './monitor';
import { HistoryAccess } from './handoff/history-access';
import { HandoffExecution } from './handoff/execution';
import { Git } from './git';
import { WorkspaceManager } from './workspaces';
import { newId } from './util';

const delay = (ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); t.unref?.(); });
import { attachWs } from './ws';
import { gatewayLog, installCrashHandlers, readLastExit, lifecycle } from './crash-log';
import { errorLogText } from './error-log';
import { LanSettings, type LanDependencies } from './lan/settings';
import { LanPairing, type LanPairingOptions } from './lan/pairing';
import { AccessAudit } from './lan/audit';
import { AccessConfirmation } from './lan/confirmation';

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
  /** 离线验收注入网卡与防火墙执行器。 */
  lan?: Partial<LanDependencies>;
  lanPairing?: LanPairingOptions;
  /** 离线验收可缩短本机确认的等待时间。 */
  accessConfirmationTtlMs?: number;
  /**
   * 开发模式（默认看 AIC_DEV=1，且 NODE_ENV 不是 production）：把启动时的配对码写进数据目录的
   * dev-pairing-code.txt，供预览工具读取。只有启动时那一个码会写入；启动脚本 start.mjs 会清掉这些开发变量。
   */
  dev?: boolean;
  approvalTimeoutMs?: number;
  /** 演示 Agent 的节奏倍率，测试里设为 0 */
  fakeSpeed?: number;
  /** 离线测试注入隔离全局配置的 git；正式启动自行从 PATH 定位。 */
  git?: Git;
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
  noResponseToolCancelMs?: number;
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
      await bind(server, port, HOST);
      const addr = server.address();
      return typeof addr === 'object' && addr ? addr.port : port;
    } catch (e) {
      lastErr = e;
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
    }
  }
  throw new Error(`端口 ${start}～${start + attempts - 1} 都被占用了，请关闭占用端口的程序后重试（${String(lastErr)}）`);
}

function bind(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onErr = (error: Error) => { server.off('listening', onOk); reject(error); };
    const onOk = () => { server.off('error', onErr); resolve(); };
    server.once('error', onErr);
    server.once('listening', onOk);
    server.listen(port, host);
  });
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
  const dataDir = opts.dataDir ?? defaultDataDir();
  // 单实例：必须在打开数据库、恢复任务状态之前确认没有别的实例在用这个数据目录
  const lock = await acquireInstanceLock(dataDir);
  const rollback: Array<() => void | Promise<unknown>> = [() => lock.release()];
  try { return await startGateway(opts, dataDir, lock, rollback); }
  catch (error) {
    for (const release of rollback.reverse()) {
      try { await release(); } catch { /* 保留启动错误，继续释放其余资源。 */ }
    }
    throw error;
  }
}

async function startGateway(opts: GatewayOptions, dataDir: string, lock: InstanceLock, rollback: Array<() => void | Promise<unknown>>): Promise<Gateway> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const lastExit = readLastExit(dataDir);
  const startedAt = Date.now();
  if (lastExit?.clean === false) gatewayLog(dataDir, 'WARN', lastExit.reason ?? '上次运行没有正常退出');
  lifecycle(dataDir, 'start', startedAt, '启动');
  const db = openDb(path.join(dataDir, 'data.db'));
  rollback.push(() => db.close());

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
    lanAddress: () => lan.activeAddress(),
  });
  const events = new EventStore(db, new EventBus());
  const git = opts.git ?? await Git.discover();
  const workspaces = new WorkspaceManager(db, git, dataDir);
  log(git.version ?? '未找到 git，新任务的隔离工作副本暂不可用。');
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
  const blockedLocalPorts = () => (port > 0 ? [port] : []);
  const independent = new IndependentCatalog(db, secrets, events);
  const independentDiscovery = new IndependentDiscovery(db, independent, opts.metadataReader, blockedLocalPorts);
  rollback.push(() => independentDiscovery.close());
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
    ...(opts.noResponseToolCancelMs !== undefined ? { noResponseToolCancelMs: opts.noResponseToolCancelMs } : {}),
    log,
  });
  const attachments = new AttachmentService(db, dataDir);
  rollback.push(() => tasks.shutdown(), () => attachments.close());
  const accessAudit = new AccessAudit(db, log);
  accessAudit.prune();
  const cleanAttachments = () => {
    const failed = attachments.cleanup();
    if (failed) log(`有 ${failed} 个过期附件暂时无法删除，下次清理时重试。`);
  };
  cleanAttachments();
  const cleanupTimer = setInterval(() => {
    try { cleanAttachments(); } catch (e) { log('附件清理失败：' + String(e)); }
    accessAudit.prune();
    void cleanWorkspaces();
  }, 60 * 60_000);
  cleanupTimer.unref?.();
  rollback.push(() => clearInterval(cleanupTimer));
  const history = new HistoryAccess(db, () => port, events.bus);
  tasks.history = history;
  tasks.attachments = attachments;
  tasks.agentSvc = agentSvc;
  agentSvc.onQueueChange = ids => tasks.queueChanged(ids);
  tasks.recoverOnStartup();
  // 上次遗留的 Agent 进程（核对启动时间后结束进程树）；不在启动时预先拉起 Agent
  const orphanCleanup = processes.cleanupOrphans();
  void orphanCleanup.catch(() => log('遗留进程清理失败，独立 Agent 暂停执行与恢复'));
  const independentRuntime = new IndependentTaskRuntime(db, independent, events, attachments, dataDir, processes, orphanCleanup, blockedLocalPorts);
  independentRuntime.recoverOnStartup();
  tasks.independentRuntime = independentRuntime;
  const monitor = new MonitorService(db, {
    events,
    listAgents: async () => [...await agentSvc.list(), independentRuntime.info()],
  });
  tasks.monitor = monitor;
  const projects = new ProjectService(db);
  tasks.workspaces = workspaces;
  const unresolvedWorkspaceOperations=await workspaces.recoverOperations();
  if(unresolvedWorkspaceOperations.length)log(`有 ${unresolvedWorkspaceOperations.length} 项工作区操作需要核对，已阻止重复派发。`);
  let workspaceCleanup: Promise<unknown> = Promise.resolve();
  const cleanWorkspaces=()=>{
    workspaceCleanup=workspaceCleanup.then(async()=>{
      await orphanCleanup;
      const result=await tasks.cleanupWorkspaces();if(result.failed.length)log(`工作副本清理未完成：${result.failed.length} 项，保留登记以便再次检查。`);
    }).catch(()=>log('工作副本清理失败，已保留登记。'));
    return workspaceCleanup;
  };
  void cleanWorkspaces();
  rollback.push(() => workspaceCleanup);
  const groups = new GroupService(db, tasks);
  const lan = new LanSettings(db, realpathSync(dataDir), () => port, listenLan, log, opts.lan,
    () => {
      accessAudit.write('lan.suspended', { id: null, ip: null }, 'unavailable');
      try { events.append({ type: 'access.lan_suspended', taskId: null, sessionId: null, data: {} }); }
      catch { log('无法通知本机页面刷新局域网状态'); }
    });
  const lanPairing = new LanPairing(auth, events, () => {
    const address = lan.activeAddress();
    return address ? `http://${address}:${port}/` : null;
  }, log, accessAudit, opts.lanPairing);
  const accessConfirmation = new AccessConfirmation(db, auth, events, lanPairing, accessAudit, log, opts.accessConfirmationTtlMs);

  const services: Services = {
    db, attachments, independent, independentDiscovery, independentRuntime, lastExit, auth, events, agents, agentSvc, profiles, secrets, processes, projects, groups, tasks, monitor, workspaces,
    history, port: () => port, lan, lanPairing, accessAudit, accessConfirmation,
    machine: { id: machineId, name: hostname(), os: process.platform === 'win32' ? 'windows' : process.platform },
    version: VERSION,
    bootId,
  };

  tasks.cleanSummary = async (id,body,environment) => {
    const {clean}=await outgoingRedactor(services,id,undefined,environment);
    return limitTaskSummary(await clean(body));
  };
  tasks.handoffs = new HandoffExecution(services);
  const webDist = opts.webDist ?? path.resolve(here, '../../../apps/web/dist');
  const app = createApp(services, { webDist });
  const server = createAdaptorServer({ fetch: app.fetch }) as Server;
  const ws = attachWs(server, services);
  rollback.push(() => {
    if (server.listening) return new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  });
  rollback.push(() => ws.close());

  async function listenLan(address: string) {
    const listener = createAdaptorServer({ fetch: app.fetch }) as Server;
    const sockets = new Set<Socket>();
    listener.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    const detach = ws.addServer(listener);
    try { await bind(listener, port, address); } catch (error) { detach(); throw error; }
    return () => new Promise<void>((resolve) => {
      lanPairing.invalidateAll();
      accessConfirmation.cancelAll();
      detach();
      listener.close(() => resolve());
      // Node 的 closeAllConnections 不关闭升级为 WebSocket 的连接。
      for (const socket of sockets) socket.destroy();
    });
  }

  port = await listen(server, opts.port ?? Number(process.env.AIC_PORT ?? DEFAULT_PORT));
  rollback.push(() => lan.stop());
  auth.setPort(port);
  lock.setPort(port);
  await lan.restore();
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

  // 完成同步初始化后再开始后台检测，启动失败时没有遗留的检测请求。
  void agentSvc.startup().catch((e) => log(`检测 Agent 失败：${String(e)}`));
  rollback.length = 0;
  let closing: Promise<void> | undefined;
  async function shutdown(opts: { deadlineMs?: number; reason?: string; code?: number }) {
    const errors: unknown[] = [];
    async function settle(action: () => unknown) {
      try { await action(); } catch (error) { errors.push(error); }
    }
    clearInterval(cleanupTimer);
    await settle(() => independentDiscovery.close());
    await settle(() => lan.stop());
    await settle(() => accessConfirmation.cancelAll());
    await settle(() => lanPairing.stop());
    await settle(() => ws.close());
    await settle(() => agentSvc.shutdown());
    const graceful = Promise.all([settle(() => tasks.shutdown()), settle(() => attachments.close()),
      settle(() => workspaceCleanup), settle(() => workspaces.settle())]);
    if (opts.deadlineMs !== undefined) {
      const timedOut = await Promise.race([graceful.then(() => false), delay(opts.deadlineMs).then(() => true)]);
      if (timedOut) {
        await settle(() => processes.killAllSync());
        await Promise.race([graceful, delay(2000)]);
      }
    } else {
      await graceful;
    }
    await settle(() => processes.killAllSync());
    await settle(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
    await settle(() => db.close());
    if (dev) await settle(() => rmSync(devCodeFile, { force: true }));
    await settle(() => lifecycle(dataDir, 'exit', startedAt, errors.length ? '退出收尾失败' : opts.reason ?? '正常退出', errors.length ? 1 : opts.code ?? 0));
    await settle(() => lock.release());
    if (errors.length) throw new AggregateError(errors, '工作台退出时部分资源收尾失败');
  }
  return {
    port, url, services,
    close(opts = {}) { return closing ??= shutdown(opts); },
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
    const detail = errorLogText(e);
    gatewayLog(defaultDataDir(), 'FATAL', `启动失败：${detail}`);
    console.error('AI Console 启动失败：', detail);
    process.exit(1);
  });
}
