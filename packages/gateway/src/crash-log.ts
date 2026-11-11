// 进程级的兜底错误处理：把没被捕获的错误完整写进 logs/gateway.log，并在终端里给出中文说明。
// 背景：2026-11-07 用户遇到 Gateway 无故退出，终端窗口已关，没有留下任何错误信息（ISSUE-0015）。
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { redact } from '@aic/adapters';
import { errorLogText } from './error-log';

export interface CrashLogOptions {
  dataDir: string;
  /** 打印到终端（默认 console.error） */
  print?: (msg: string) => void;
  /** 发生无法继续运行的错误时调用（通常是收尾并退出） */
  onFatal: (err: unknown) => void;
}

export const GATEWAY_LOG = 'gateway.log';

/** 写一条到 logs/gateway.log；写不进去不影响运行 */
export function gatewayLog(dataDir: string, level: 'INFO' | 'WARN' | 'ERROR' | 'FATAL', msg: string) {
  try {
    const dir = path.join(dataDir, 'logs');
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, GATEWAY_LOG), `${new Date().toISOString()} ${level} ${redact(msg)}\n`);
  } catch { /* 忽略 */ }
}

/**
 * - uncaughtException：程序状态已不可信，记录后调用 onFatal（收尾退出）。
 * - unhandledRejection：多半是某个后台 Promise 没有接住错误，记录并继续运行，避免一个边缘错误让整个工作台停掉。
 *   Node 默认可能因此退出；记录此类错误不能反推 ISSUE-0015 原始退出的原因。
 */
export function installCrashHandlers(opts: CrashLogOptions) {
  const output = opts.print ?? ((m: string) => console.error(m));
  const print = (message: string) => output(redact(message));
  const logFile = path.join(opts.dataDir, 'logs', GATEWAY_LOG);
  let fatal = false;

  const onRejection = (reason: unknown) => {
    gatewayLog(opts.dataDir, 'ERROR', `未处理的 Promise 拒绝（已忽略，服务继续运行）：${errorLogText(reason)}`);
    print(`[警告] 后台出现一个未处理的错误，已记录到 ${logFile}，服务继续运行。`);
  };
  const onException = (err: unknown) => {
    gatewayLog(opts.dataDir, 'FATAL', `未捕获的异常，服务即将退出：${errorLogText(err)}`);
    if (fatal) return;
    fatal = true;
    print('');
    print(`AI Console 遇到无法恢复的错误：${err instanceof Error ? err.message : typeof err === 'string' ? err : '非 Error 异常（已省略附带数据）'}`);
    print(`详细信息已写入 ${logFile}，把这个文件发给开发者即可定位问题。`);
    opts.onFatal(err);
  };
  process.on('unhandledRejection', onRejection);
  process.on('uncaughtException', onException);
  return () => {
    process.off('unhandledRejection', onRejection);
    process.off('uncaughtException', onException);
  };
}

/** 独立生命周期记录，避免错误堆栈多行影响最后一次运行判断。 */
export function readLastExit(dataDir: string): import('@aic/protocol').Hello['lastExit'] {
  try {
    const lines = readFileSync(path.join(dataDir, 'logs', GATEWAY_LOG), 'utf8').trim().split('\n');
    const last = lines.findLast((l) => l.includes('生命周期 '));
    if (last) {
      const r = JSON.parse(last.slice(last.indexOf('生命周期 ') + 5)) as { phase: string; pid: number; at: number; reason: string | null; code?: number };
      return { clean: r.phase === 'exit' && (r.code ?? 0) === 0, at: r.at, reason: r.phase === 'exit' ? r.reason : '上次运行没有正常退出（pid ' + r.pid + '）' };
    }
    // 旧格式日志没有生命周期记录。本次进程在调用前已写入自己的“启动 v…pid”一行，必须排除，否则每次都判成上次没有正常退出（ISSUE-0057）。
    const own = `，pid ${process.pid}`;
    const legacy = lines.findLast((l) => /启动|退出/.test(l) && !(l.includes(' 启动 v') && l.trimEnd().endsWith(own)));
    return legacy ? { clean: /正常退出/.test(legacy), at: Date.parse(legacy.slice(0, 24)) || Date.now(), reason: /正常退出/.test(legacy) ? '正常退出' : '上次运行没有正常退出' } : null;
  } catch { return null; }
}
export function lifecycle(dataDir: string, phase: 'start' | 'exit', startedAt: number, reason: string | null, code?: number) {
  gatewayLog(dataDir, 'INFO', '生命周期 ' + JSON.stringify({ phase, pid: process.pid, at: Date.now(), uptimeMs: Date.now() - startedAt, reason, ...(code === undefined ? {} : { code }) }));
}
