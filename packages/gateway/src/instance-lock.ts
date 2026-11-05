// 单实例锁：同一个数据目录只能有一个 Gateway 在运行。
// 必须在打开数据库、执行 recoverOnStartup 之前获取，否则第二个进程会把第一个进程正在运行的任务改成“已中断”。
// 端口顺延只用于端口被其他程序占用的情况，不用于同一数据目录开第二个实例。
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { request } from 'node:http';
import path from 'node:path';
import { API_BASE } from '@aic/protocol';

const LOCK_FILE = 'gateway.lock';
/** 锁文件里还没写端口（实例还在启动）时，超过这个时间就当作残留 */
const STARTING_GRACE_MS = 60_000;

interface LockInfo { pid: number; port: number | null; startedAt: number }

/** 已经有一个实例在用这个数据目录 */
export class AlreadyRunningError extends Error {
  constructor(readonly pid: number, readonly port: number | null) {
    super(port ? `AI Console 已经在运行（端口 ${port}）` : 'AI Console 已经在运行（正在启动）');
    this.name = 'AlreadyRunningError';
  }
}

export interface InstanceLock {
  /** 开始监听后写入端口，第二个实例据此找到已有实例 */
  setPort(port: number): void;
  release(): void;
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** 确认端口上确实是 AI Console（未带令牌访问 /hello 会得到协议里的 ApiError） */
export function probeGateway(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path: `${API_BASE}/hello`, method: 'GET', headers: { host: `127.0.0.1:${port}` }, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (body.length < 4096) body += c; });
      res.on('end', () => {
        try { resolve(typeof (JSON.parse(body) as { code?: unknown }).code === 'string'); } catch { resolve(false); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

function readInfo(file: string): { info: LockInfo | null; ageMs: number } {
  let ageMs = Infinity;
  try { ageMs = Date.now() - statSync(file).mtimeMs; } catch { /* 刚被删掉 */ }
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as Partial<LockInfo>;
    if (typeof j.pid === 'number') return { info: { pid: j.pid, port: typeof j.port === 'number' ? j.port : null, startedAt: Number(j.startedAt) || 0 }, ageMs };
  } catch { /* 内容不完整 */ }
  return { info: null, ageMs };
}

/** 锁文件对应的实例是否还活着 */
async function holderAlive(info: LockInfo | null, ageMs: number): Promise<boolean> {
  if (!info) return ageMs < 5_000; // 对方刚创建、还没写完
  if (!pidAlive(info.pid)) return false;
  if (info.port === null) return ageMs < STARTING_GRACE_MS;
  // 进程号可能被系统复用：再确认端口上真的是 AI Console
  return probeGateway(info.port);
}

export async function acquireInstanceLock(dataDir: string): Promise<InstanceLock> {
  mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, LOCK_FILE);
  let info: LockInfo = { pid: process.pid, port: null, startedAt: Date.now() };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(file, 'wx');
      try { writeSync(fd, JSON.stringify(info)); } finally { closeSync(fd); }
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        process.off('exit', release);
        // 只删自己的锁
        try { if (readInfo(file).info?.pid === process.pid) unlinkSync(file); } catch { /* 已经没了 */ }
      };
      process.on('exit', release);
      return {
        setPort(port) {
          info = { ...info, port };
          try { writeFileSync(file, JSON.stringify(info)); } catch { /* 写不进去不影响运行，只影响第二个实例找到我们 */ }
        },
        release,
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const cur = readInfo(file);
      if (await holderAlive(cur.info, cur.ageMs)) throw new AlreadyRunningError(cur.info?.pid ?? 0, cur.info?.port ?? null);
      // 上次没有正常退出留下的锁：清掉再试
      try { unlinkSync(file); } catch { /* 别人先删了 */ }
    }
  }
  throw new Error(`无法获取数据目录的运行锁：${file}`);
}
