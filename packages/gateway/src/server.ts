// Gateway 入口：打开数据库、组装服务、监听 127.0.0.1（端口被占用时顺延）、托管网页、打开浏览器。
import { spawn } from 'node:child_process';
import type { Server } from 'node:http';
import { hostname } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { realpathSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createAdaptorServer } from '@hono/node-server';
import { AgentRegistry } from './agents/registry';
import { createFakeAdapter } from './agents/fake';
import { AuthService, type AuthOptions } from './auth';
import { openDb } from './db';
import { acquireInstanceLock, AlreadyRunningError, probeGateway } from './instance-lock';
import { EventBus, EventStore } from './events';
import { createApp } from './http/app';
import { GroupService, ProjectService } from './projects';
import type { Services } from './services';
import { TaskService } from './tasks';
import { newId } from './util';
import { attachWs } from './ws';

export const VERSION = '0.1.0';
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
  log?: (msg: string) => void;
}

export interface Gateway {
  port: number;
  url: string;
  services: Services;
  close(): Promise<void>;
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
  const agents = new AgentRegistry();
  agents.register(createFakeAdapter({ speed: opts.fakeSpeed ?? 1 }));
  const tasks = new TaskService(db, events, agents, opts.approvalTimeoutMs !== undefined ? { approvalTimeoutMs: opts.approvalTimeoutMs } : {});
  tasks.recoverOnStartup();
  const projects = new ProjectService(db);
  const groups = new GroupService(db, tasks);

  const services: Services = {
    db, auth, events, agents, projects, groups, tasks,
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
    async close() {
      if (closed) return;
      closed = true;
      ws.close();
      await tasks.shutdown();
      await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections?.(); });
      db.close();
      if (dev) rmSync(devCodeFile, { force: true });
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
  console.log(`AI Console 已启动：${gw.url}`);
  console.log('浏览器没有自动打开的话，请手动打开上面的地址。关闭这个窗口即可退出。');
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    console.log('正在退出……');
    await gw.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  // Windows 上关闭控制台窗口时 Node 收到的是 SIGHUP，几秒后进程会被强制结束：同样要正常收尾
  process.on('SIGHUP', stop);
}

const isEntry = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isEntry) {
  main().catch((e) => {
    console.error('AI Console 启动失败：', e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
