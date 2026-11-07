// 进程级的兜底错误处理：把没被捕获的错误完整写进 logs/gateway.log，并在终端里给出中文说明。
// 背景：2026-11-07 用户遇到 Gateway 无故退出，终端窗口已关，没有留下任何错误信息（ISSUE-0015）。
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { redact } from '@aic/adapters';

export interface CrashLogOptions {
  dataDir: string;
  /** 打印到终端（默认 console.error） */
  print?: (msg: string) => void;
  /** 发生无法继续运行的错误时调用（通常是收尾并退出） */
  onFatal: (err: unknown) => void;
}

export const GATEWAY_LOG = 'gateway.log';

const describe = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ''}` : String(e));

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
 *   Node 默认会把它当成致命错误直接退出，这正是这次“意外停止”最可能的来源。
 */
export function installCrashHandlers(opts: CrashLogOptions) {
  const print = opts.print ?? ((m: string) => console.error(m));
  const logFile = path.join(opts.dataDir, 'logs', GATEWAY_LOG);
  let fatal = false;

  const onRejection = (reason: unknown) => {
    gatewayLog(opts.dataDir, 'ERROR', `未处理的 Promise 拒绝（已忽略，服务继续运行）：${describe(reason)}`);
    print(`[警告] 后台出现一个未处理的错误，已记录到 ${logFile}，服务继续运行。`);
  };
  const onException = (err: unknown) => {
    gatewayLog(opts.dataDir, 'FATAL', `未捕获的异常，服务即将退出：${describe(err)}`);
    if (fatal) return;
    fatal = true;
    print('');
    print(`AI Console 遇到无法恢复的错误：${err instanceof Error ? err.message : String(err)}`);
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
