// 启动方式解析、spawn、进程树清理（phase-1.md 6.2.1）。
// 规则：一律用 Gateway 自己的 Node 运行 js 入口（或直接运行 exe），不经 shell，不启动 .cmd / .bat。
import { execFile, execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** 会串号的环境变量：启动 Agent 前一律删掉，再叠加账号的环境变量 */
const STRIP_EXACT = new Set([
  'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_EXECUTABLE', 'NO_BROWSER', 'SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY',
  'CLAUDE_CODE_REMOTE', 'APP_SERVER_LOGS',
  // Gateway 自己跑在 Claude Code / Claude 桌面端里时（开发预览）继承的宿主变量：可能让子进程沿用宿主的登录、
  // 把自己当成子会话。联调时排查登录状态发现这些变量会传进 Agent，预防性删掉。
  'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'CLAUDE_CODE_OAUTH_SCOPES',
  'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH', 'CLAUDE_CODE_API_KEY_HELPER_TTL_MS',
]);
const STRIP_PREFIX = [
  'ANTHROPIC_', 'CLAUDE_CODE_USE_', 'OPENAI_', 'CODEX_', 'CODEBUDDY_', 'ACC_PRODUCT_CONFIG',
  'CLAUDE_CODE_HOST_', 'CLAUDE_CODE_MESSAGING_', 'CLAUDE_CODE_DESKTOP_', 'CLAUDE_AGENT_SDK_',
];

export function shouldStrip(name: string, value?: string): boolean {
  const n = name.toUpperCase();
  // Git Bash / MSYS 设置的 HOME=/c/Users/xxx：Windows 原生的 claude.exe 会把它当成 C:\c\Users\xxx，
  // 找不到登录信息而误报“未登录”（联调时发现）。删掉后它改用 USERPROFILE。
  if (n === 'HOME' && process.platform === 'win32' && value?.startsWith('/')) return true;
  return STRIP_EXACT.has(n) || STRIP_PREFIX.some((p) => n.startsWith(p));
}

/** 以 base（默认 process.env）为底，删掉会串号的变量，再叠加 overlay */
export function buildChildEnv(overlay: Record<string, string> = {}, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || shouldStrip(k, v)) continue;
    out[k] = v;
  }
  for (const [k, v] of Object.entries(overlay)) out[k] = v;
  return out;
}

export interface LaunchSpec {
  /** 可执行文件：默认 process.execPath（Node） */
  command?: string;
  /** js 入口（command 为 Node 时） */
  entry?: string;
  args: string[];
}

/** 拒绝 .cmd / .bat：Node 24 不经 shell 启动会报 EINVAL，shell:true 又有注入风险 */
export function assertLaunchable(spec: LaunchSpec) {
  const cmd = spec.command ?? process.execPath;
  if (/\.(cmd|bat)$/i.test(cmd)) throw new Error(`不能直接启动 ${path.basename(cmd)}，请改为它最终执行的 js 入口或 exe`);
  if (spec.entry && !existsSync(spec.entry)) throw new Error(`找不到 Agent 入口文件：${spec.entry}`);
}

export function spawnAgent(spec: LaunchSpec, opts: { cwd: string; env: Record<string, string> }): ChildProcessWithoutNullStreams {
  assertLaunchable(spec);
  const cmd = spec.command ?? process.execPath;
  const args = spec.entry ? [spec.entry, ...spec.args] : spec.args;
  return spawn(cmd, args, { shell: false, windowsHide: true, stdio: 'pipe', cwd: opts.cwd, env: opts.env });
}

/** 进程是否还在 */
export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** 结束进程树（异步）。Windows 用 taskkill /T /F；其他平台 SIGKILL */
export function killTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (!isAlive(pid)) return resolve();
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 }, () => resolve());
    } else {
      try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ }
      resolve();
    }
  });
}

/** 结束进程树（同步）：Gateway 退出时用 */
export function killTreeSync(pid: number) {
  if (!isAlive(pid)) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10_000 });
    else process.kill(pid, 'SIGKILL');
  } catch { /* 已退出或无权限 */ }
}

const POWERSHELL = 'powershell.exe';
const psArgs = (script: string) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script];

function runPs(script: string, timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve) => {
    execFile(POWERSHELL, psArgs(script), { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (_err, stdout) => resolve(String(stdout ?? '')));
  });
}

/** 列出 pid 的全部子孙进程（Windows；其他平台返回空）。用于关闭前留一份快照，父进程先退出时也能找到孙进程 */
export async function descendants(pid: number): Promise<number[]> {
  if (process.platform !== 'win32' || !Number.isInteger(pid)) return [];
  const script = `$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId; `
    + `$q = New-Object System.Collections.Queue; $q.Enqueue(${pid}); $out = @(); `
    + `while ($q.Count -gt 0) { $p = $q.Dequeue(); foreach ($c in $all) { if ($c.ParentProcessId -eq $p -and $c.ProcessId -ne $p) { $out += $c.ProcessId; $q.Enqueue($c.ProcessId) } } }; `
    + `$out -join ','`;
  const out = (await runPs(script)).trim();
  return out ? out.split(',').map((s) => Number(s)).filter((n) => Number.isInteger(n) && n > 0) : [];
}

/** 查询进程的启动时间（毫秒时间戳）。只用于核对 pid 有没有被复用 */
export async function processStartTimes(pids: number[]): Promise<Map<number, number>> {
  const res = new Map<number, number>();
  const list = pids.filter((p) => Number.isInteger(p) && p > 0);
  if (process.platform !== 'win32' || list.length === 0) return res;
  const filter = list.map((p) => `ProcessId=${p}`).join(' OR ');
  const script = `Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { "$($_.ProcessId) $($_.CreationDate.ToUniversalTime().ToFileTimeUtc())" }`;
  for (const line of (await runPs(script)).split(/\r?\n/)) {
    const m = /^(\d+)\s+(\d+)$/.exec(line.trim());
    if (m) res.set(Number(m[1]), Math.round((Number(m[2]) - 116444736000000000) / 10_000));
  }
  return res;
}

/**
 * 运行一个短命令（版本、登录状态），带超时。输出只返回给调用方，不写日志。
 * 只接受 exe 或 Node + js 入口，不经 shell。
 */
export function runCli(spec: LaunchSpec, opts: { env: Record<string, string>; cwd?: string; timeoutMs?: number; input?: string }): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnAgent(spec, { cwd: opts.cwd ?? process.cwd(), env: opts.env });
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: e instanceof Error ? e.message : String(e), timedOut: false });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const cap = 256 * 1024;
    child.stdout.on('data', (d: Buffer) => { if (stdout.length < cap) stdout += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { if (stderr.length < cap) stderr += d.toString('utf8'); });
    child.on('error', (e) => { stderr += String(e.message); });
    const t = setTimeout(() => { timedOut = true; void killTree(child.pid ?? 0); }, opts.timeoutMs ?? 20_000);
    child.on('close', (code) => { clearTimeout(t); resolve({ code, stdout, stderr, timedOut }); });
    if (opts.input !== undefined) child.stdin.end(opts.input); else child.stdin.end();
  });
}
