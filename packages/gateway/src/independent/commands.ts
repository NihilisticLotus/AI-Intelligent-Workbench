// 独立命令执行基础。调用方完成审批和 running 记录后才调用；这里不决定权限。
// 仅支持 Windows 作业宿主，不以普通 spawn 降级冒充进程树收尾，也不声称它是系统沙箱。
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndependentCommandSpec, type IndependentCommandResult } from '@aic/protocol';
import { redact } from '@aic/adapters';

/** 只取工具运行需要的系统项，不继承 API Key、代理认证、Node hooks 或 Agent 配置。 */
export function independentCommandEnv(home: string, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && ['SYSTEMROOT', 'WINDIR', 'PATH', 'PATHEXT', 'COMSPEC', 'LANG', 'LC_ALL'].includes(name.toUpperCase())) result[name.toUpperCase()] = value;
  }
  return { ...result, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'roaming'),
    LOCALAPPDATA: path.join(home, 'local'), TEMP: path.join(home, 'temp'), TMP: path.join(home, 'temp') };
}

export class IndependentCommandExecutor {
  private active = new Set<{ stop(): void; done: Promise<IndependentCommandResult> }>();
  private closed = false;
  constructor(private dataDir: string) {}

  async run(input: IndependentCommandSpec, options: {
    cwd: string; signal?: AbortSignal; redact?: readonly string[];
    /** 完成持久化登记后才向宿主发送命令；失败或取消则不发送。 */
    onStarted?(process: { pid: number; startedAt: number }): void | Promise<void>;
  }): Promise<IndependentCommandResult> {
    const spec = IndependentCommandSpec.parse(input);
    const at = performance.now();
    const empty = (reason: IndependentCommandResult['reason'], stderr = ''): IndependentCommandResult =>
      ({ reason, exitCode: null, stdout: '', stderr, outputBytes: 0, truncated: false, durationMs: performance.now() - at });
    if (this.closed) return empty('interrupted', '命令执行器已关闭');
    if (options.signal?.aborted) return empty('cancelled');
    if (process.platform !== 'win32') return empty('start_failed', '当前命令宿主只支持 Windows');
    if (!path.isAbsolute(spec.program) || /\.(cmd|bat)$/i.test(spec.program)) return empty('start_failed', '需要已确认的绝对可执行文件，不能隐式运行批处理');
    if (!path.isAbsolute(options.cwd)) return empty('start_failed', '需要 Gateway 提供的绝对工作目录');
    let cwd: string;
    try { cwd = realpathSync(options.cwd); } catch { return empty('start_failed', '命令工作目录不可用'); }
    const base = path.join(this.dataDir, 'independent', 'commands');
    mkdirSync(base, { recursive: true });
    const home = mkdtempSync(path.join(base, 'run-'));
    for (const dir of ['roaming', 'local', 'temp']) mkdirSync(path.join(home, dir));
    const env = independentCommandEnv(home);
    const cleanup = () => {
      // home 只能来自上面的 mkdtemp，不能接受命令参数中的目录。失败时留待本机清理，不影响结果收尾。
      try { rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* 保留临时目录，不把清理失败伪装成命令失败 */ }
    };
    const systemRoot = env.SYSTEMROOT ?? env.WINDIR;
    if (!systemRoot) { cleanup(); return empty('start_failed', '没有找到 Windows 系统目录'); }
    const host = fileURLToPath(new URL('./command-host.ps1', import.meta.url));
    // Windows PowerShell 5.1 不默认按 UTF-8 读取无 BOM 的脚本，显式读取，避免改仓库编码规则。
    const bootstrap = `& ([scriptblock]::Create([IO.File]::ReadAllText('${host.replaceAll("'", "''")}',[Text.Encoding]::UTF8)))`;
    const child = spawn(path.join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), [
      '-NoProfile', '-NonInteractive', '-InputFormat', 'Text', '-OutputFormat', 'Text', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(bootstrap, 'utf16le').toString('base64'),
    ], { cwd, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let resolveCompletion!: (result: IndependentCommandResult) => void;
    const completion = new Promise<IndependentCommandResult>((resolve) => { resolveCompletion = resolve; });
    let stopReason: IndependentCommandResult['reason'] | undefined;
    let settled = false;
    let accepted = 0;
    let observed = 0;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let startupError = '';
    let frameBuffer = '';
    let commandStarted = false;
    let commandExit: number | undefined;
    let hostError = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (reason: IndependentCommandResult['reason']) => {
      if (settled || stopReason) return;
      stopReason = reason;
      child.stdin.end();
      forceTimer = setTimeout(() => { child.kill('SIGKILL'); }, 1000);
    };
    const entry = { stop: () => stop('cancelled'), done: completion };
    this.active.add(entry);
    const abort = () => stop('cancelled');
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const timer = setTimeout(() => stop('timed_out'), spec.timeoutMs);
    child.stdin.on('error', () => { /* 宿主提前退出时管道可能关闭；以 close 事件收尾。 */ });
    const capture = (target: 'stdout' | 'stderr', chunk: Buffer) => {
      if (settled) return;
      observed += chunk.length;
      const part = chunk.subarray(0, Math.max(0, spec.maxOutputBytes - accepted));
      accepted += part.length;
      if (target === 'stdout') stdout = Buffer.concat([stdout, part]); else stderr = Buffer.concat([stderr, part]);
      if (observed > spec.maxOutputBytes) stop('output_limit');
    };
    // 宿主把命令输出编码成帧，命令无法用正文伪造退出消息，也不会与 PowerShell 诊断混流。
    child.stdout.on('data', (chunk: Buffer) => {
      frameBuffer += chunk.toString('ascii');
      let end: number;
      while ((end = frameBuffer.indexOf('\n')) >= 0) {
        const line = frameBuffer.slice(0, end).replace(/\r$/, ''); frameBuffer = frameBuffer.slice(end + 1);
        try {
          const frame = JSON.parse(line) as Record<string, unknown>;
          if (frame.type === 'started' && !commandStarted && commandExit === undefined) commandStarted = true;
          else if ((frame.type === 'stdout' || frame.type === 'stderr') && commandStarted && commandExit === undefined && typeof frame.data === 'string' && frame.data.length <= 10_924 && /^[A-Za-z0-9+/]*={0,2}$/.test(frame.data)) capture(frame.type, Buffer.from(frame.data, 'base64'));
          else if (frame.type === 'exit' && commandStarted && commandExit === undefined && typeof frame.exitCode === 'number' && Number.isInteger(frame.exitCode)) commandExit = frame.exitCode;
          else if (frame.type === 'host_error') { hostError = true; startupError = '无法启动或完成受控命令，请检查本机命令宿主'; }
          else throw new Error('无效命令宿主消息');
        } catch { stop('interrupted'); }
      }
      if (frameBuffer.length > 16_384) { frameBuffer = ''; stop('interrupted'); }
    });
    child.stderr.on('data', (chunk: Buffer) => capture('stderr', chunk));
    child.once('error', () => { startupError = '无法启动命令宿主'; stop('start_failed'); });
    child.once('spawn', () => {
      void (async () => {
        await options.onStarted?.({ pid: child.pid!, startedAt: Date.now() });
        if (settled || stopReason || this.closed) { child.stdin.end(); return; }
        child.stdin.write(`${JSON.stringify({ program: spec.program, args: spec.args, cwd })}\n`);
      })().catch(() => { startupError = '命令启动登记失败，未派发命令'; stop('start_failed'); });
    });
    child.once('close', (code) => {
      settled = true; clearTimeout(timer); clearTimeout(forceTimer);
      options.signal?.removeEventListener('abort', abort);
      this.active.delete(entry);
      cleanup();
      const clean = (buffer: Buffer) => {
        let text = redact(buffer.toString('utf8'), options.redact);
        // 上限或中断可能把密钥截成前缀，不能把已知密钥的这段尾巴返回调用方。
        for (const secret of options.redact ?? []) {
          if (secret.length < 6) continue;
          for (let n = Math.min(secret.length - 1, text.length); n > 0; n--) {
            if (text.endsWith(secret.slice(0, n))) { text = `${text.slice(0, -n)}***`; break; }
          }
        }
        return text;
      };
      resolveCompletion({ reason: stopReason ?? (hostError ? commandStarted ? 'interrupted' : 'start_failed' : code === 0 && commandExit !== undefined ? 'completed' : 'interrupted'), exitCode: commandExit ?? null,
        stdout: clean(stdout), stderr: startupError || clean(stderr), outputBytes: observed,
        truncated: observed > spec.maxOutputBytes, durationMs: performance.now() - at });
    });
    return completion;
  }

  async close(): Promise<void> {
    this.closed = true;
    const entries = [...this.active];
    for (const entry of entries) entry.stop();
    await Promise.all(entries.map((entry) => entry.done));
  }
}
