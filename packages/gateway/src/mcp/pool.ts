// 常驻 Stdio MCP 进程池（第 2.3-R 步）：
// - 单实例复用：每个启用中的 Stdio MCP 服务最多维护一份常驻进程，多任务/多轮调用共享握手状态；
// - 生命周期托管：空闲自动回收（默认 10 分钟）、单次请求超时看门狗强杀并自愈、崩溃后下次自动拉起；
// - 安全防线：Windows 下将 npx/npm 及标准 npm .cmd 垫片解析为 node.exe 直接启动（严禁 shell:true）、
//   2.1 环境变量白名单隔离、stdout 单行 2 MB 体积上限防 OOM、ProcessRegistry 登记与 killTree 整树清理。
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { killTree, redactExact } from '@aic/adapters';
import type { ProcessRegistry } from '../processes';
import { buildIsolatedSubprocessEnv } from '../security/env-policy';
import { Errors } from '../util';

export const MCP_STDIO_IDLE_TTL_MS = 10 * 60_000;
export const MCP_MAX_STDOUT_LINE_BYTES = 2 * 1024 * 1024;
export const MCP_PROTOCOL_VERSION = '2025-06-18';

export interface StdioRuntimeSpec {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface StdioCallOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

interface JsonRpcResponse {
  id?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  cleanupAbort?: () => void;
}

const NODE_BUILTIN_CLI: Record<string, string> = {
  npx: path.join('node_modules', 'npm', 'bin', 'npx-cli.js'),
  npm: path.join('node_modules', 'npm', 'bin', 'npm-cli.js'),
  corepack: path.join('node_modules', 'corepack', 'dist', 'corepack.js'),
};

function isFile(filePath: string): boolean {
  try { return statSync(filePath).isFile(); } catch { return false; }
}

/**
 * 解析标准 npm / corepack Windows `.cmd` 垫片所指向的 Node JS 入口脚本，
 * 以便直接通过 `node.exe`（shell: false）安全启动，彻底避免 cmd.exe 注入与 Node 24 CVE-2024-27980 EINVAL。
 */
export function resolveNpmCmdShim(
  shimPath: string,
  nodeExecPath: string = process.execPath,
): { command: string; args: string[] } | null {
  let content: string;
  try {
    content = readFileSync(shimPath, 'utf8');
  } catch {
    return null;
  }
  const dir = path.dirname(shimPath);
  const baseName = path.basename(shimPath).toLowerCase().replace(/\.(cmd|bat)$/i, '');

  // 1) 官方 Node 安装目录下的 npx.cmd / npm.cmd / corepack.cmd
  const builtinRel = NODE_BUILTIN_CLI[baseName];
  if (builtinRel) {
    const candidate = path.resolve(dir, builtinRel);
    if (isFile(candidate)) return { command: nodeExecPath, args: [candidate] };
  }

  // 2) npm 全局/本地生成的标准 .cmd 垫片："%_prog%"  "%dp0%\node_modules\pkg\bin.js" %*
  const match = /"%dp0%[\\/]([^"\r\n]+?\.(?:m?js|cjs))"/i.exec(content)
    ?? /"%~dp0[\\/]([^"\r\n]+?\.(?:m?js|cjs))"/i.exec(content);
  if (!match?.[1]) return null;
  const resolved = path.resolve(dir, match[1]);
  const rel = path.relative(dir, resolved);
  // 防止路径穿越出垫片所在目录
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  if (!isFile(resolved)) return null;
  return { command: nodeExecPath, args: [resolved] };
}

/**
 * Windows 无 Shell 安全启动命令解析：
 * - 非 Windows 原样返回；
 * - Windows 下自动定位 PATH 中的 `.exe` / `.com`，并将 `npx`/`npm`/标准 npm `.cmd` 垫片转为 `node.exe <script.js>`；
 * - 拒绝非 Node 垫片的任意 `.cmd`/`.bat` 批处理脚本（给出明确中文提示而非底层的 EINVAL）。
 */
export function resolveStdioSpawn(
  command: string,
  args: readonly string[],
  opts: { platform?: NodeJS.Platform; pathEnv?: string; nodeExecPath?: string } = {},
): { command: string; args: string[] } {
  const platform = opts.platform ?? process.platform;
  const nodeExec = opts.nodeExecPath ?? process.execPath;
  if (platform !== 'win32') return { command, args: [...args] };

  const trimmed = command.trim();
  const hasSep = /[\\/]/.test(trimmed);
  const ext = path.extname(trimmed).toLowerCase();

  // 显式绝对/相对路径
  if (hasSep) {
    if (ext === '.cmd' || ext === '.bat') {
      const shim = resolveNpmCmdShim(trimmed, nodeExec);
      if (shim) return { command: shim.command, args: [...shim.args, ...args] };
      throw Errors.badRequest(`安全策略禁止在无 Shell 模式下直接执行批处理脚本（${path.basename(trimmed)}），请改用可执行程序（如 node、python、uvx）`);
    }
    return { command: trimmed, args: [...args] };
  }

  const lowerName = trimmed.toLowerCase();
  const bareNoExt = lowerName.replace(/\.(exe|com|cmd|bat)$/i, '');
  const nodeDir = path.dirname(nodeExec);
  const pathDirs = [
    ...(opts.pathEnv ?? process.env.PATH ?? '').split(path.delimiter).filter(Boolean),
    nodeDir,
  ];

  // 1) 优先匹配内置 Node CLI（npx / npm / corepack），零额外子进程，兼容任意安装目录
  const builtinRel = NODE_BUILTIN_CLI[bareNoExt];
  if (builtinRel && (ext === '' || ext === '.cmd')) {
    for (const dir of [nodeDir, ...pathDirs]) {
      const cli = path.resolve(dir, builtinRel);
      if (isFile(cli)) {
        return { command: nodeExec, args: [cli, ...args] };
      }
    }
  }

  // 2) 若显式带 .exe / .com 或在 PATH 中能找到同名 .exe / .com，优先返回原生可执行文件
  if (ext === '.exe' || ext === '.com') {
    for (const dir of pathDirs) {
      const full = path.join(dir, trimmed);
      if (isFile(full)) return { command: full, args: [...args] };
    }
    return { command: trimmed, args: [...args] };
  }

  if (ext === '') {
    for (const dir of pathDirs) {
      for (const candExt of ['.exe', '.com']) {
        const full = path.join(dir, trimmed + candExt);
        if (isFile(full)) return { command: full, args: [...args] };
      }
    }
  }

  // 3) 检查 PATH 中的 .cmd 垫片（如全局安装的 mcp-server-xxx.cmd），若为标准 npm JS 垫片则转为 node.exe 执行
  const cmdFile = ext === '.cmd' || ext === '.bat' ? trimmed : `${trimmed}.cmd`;
  for (const dir of pathDirs) {
    const full = path.join(dir, cmdFile);
    if (!isFile(full)) continue;
    const shim = resolveNpmCmdShim(full, nodeExec);
    if (shim) return { command: shim.command, args: [...shim.args, ...args] };
    throw Errors.badRequest(`命令「${trimmed}」在 Windows 上是批处理垫片且无法映射为 Node 脚本，请改填实际可执行程序或 node 入口文件`);
  }

  // 未找到时交由 spawn 报出清晰 ENOENT
  return { command: trimmed, args: [...args] };
}

function configFingerprint(spec: StdioRuntimeSpec): string {
  const sortedEnv = Object.entries(spec.env).sort(([a], [b]) => a.localeCompare(b));
  return createHash('sha256')
    .update(JSON.stringify({ command: spec.command, args: spec.args, env: sortedEnv }))
    .digest('hex');
}

class PooledStdioClient {
  readonly fingerprint: string;
  private child: ChildProcess;
  readonly pid: number | undefined;
  private home: string;
  private secrets: string[];
  private nextId = 1;
  private pending = new Map<number, PendingRpc>();
  private stderrTail = '';
  private stdoutBuf: Buffer = Buffer.alloc(0);
  private alive = true;
  private closing = false;
  private idleTimer: NodeJS.Timeout | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(
    private spec: StdioRuntimeSpec,
    private opts: {
      processes?: ProcessRegistry;
      idleTtlMs: number;
      maxStdoutLineBytes: number;
      onDead: (client: PooledStdioClient) => void;
    },
  ) {
    this.fingerprint = configFingerprint(spec);
    this.secrets = Object.values(spec.env).filter(Boolean);
    const resolved = resolveStdioSpawn(spec.command, spec.args);
    this.home = mkdtempSync(path.join(tmpdir(), 'aic-mcp-'));
    const env = buildIsolatedSubprocessEnv({ home: this.home, extraVars: spec.env });

    try {
      this.child = spawn(resolved.command, resolved.args, {
        cwd: this.home,
        env,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.cleanupHome();
      throw err;
    }

    this.pid = this.child.pid;
    if (this.pid) {
      this.opts.processes?.started({
        pid: this.pid,
        agent: 'independent',
        sessionId: `mcp:${spec.id}`,
        startedAt: Date.now(),
      });
    }

    this.child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-800);
    });
    this.child.stdin?.on('error', () => { /* 进程提前退出时的 EPIPE 由 exit/error 统一处理 */ });
    this.child.stdout?.on('data', (chunk: Buffer) => this.handleStdoutChunk(chunk));

    this.child.once('error', (err) => {
      this.markDead(new Error(`无法启动 MCP 命令（${this.spec.command}）：${err.message}`));
    });
    this.child.once('exit', (code, sig) => {
      const hint = this.stderrTail.trim() ? `：${redactExact(this.stderrTail.trim(), this.secrets).slice(0, 200)}` : '';
      this.markDead(new Error(`MCP 进程提前退出（code=${code ?? 'null'}, signal=${sig ?? 'null'}）${hint}`));
    });
  }

  isAlive(): boolean {
    return this.alive && !this.closing;
  }

  private handleStdoutChunk(chunk: Buffer): void {
    if (!this.alive) return;
    this.stdoutBuf = this.stdoutBuf.length ? Buffer.concat([this.stdoutBuf, chunk]) : chunk;

    let nlIndex = this.stdoutBuf.indexOf(0x0a); // '\n'
    while (nlIndex !== -1) {
      if (nlIndex > this.opts.maxStdoutLineBytes) {
        void this.destroy(new Error(`MCP 进程单行输出超过 ${Math.round(this.opts.maxStdoutLineBytes / (1024 * 1024))} MB 安全上限，已中止并回收进程`));
        return;
      }
      const lineBuf = this.stdoutBuf.subarray(0, nlIndex);
      this.stdoutBuf = this.stdoutBuf.subarray(nlIndex + 1);
      const line = lineBuf.toString('utf8').replace(/\r$/, '').trim();
      if (line) this.handleLine(line);
      nlIndex = this.stdoutBuf.indexOf(0x0a);
    }

    if (this.stdoutBuf.length > this.opts.maxStdoutLineBytes) {
      void this.destroy(new Error(`MCP 进程单行输出超过 ${Math.round(this.opts.maxStdoutLineBytes / (1024 * 1024))} MB 安全上限，已中止并回收进程`));
    }
  }

  private handleLine(line: string): void {
    let msg: JsonRpcResponse;
    try { msg = JSON.parse(line) as JsonRpcResponse; } catch { return; }
    if (typeof msg.id !== 'number') return;
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    entry.cleanupAbort?.();
    this.touchIdle();
    if (msg.error) {
      const m = msg.error.message ? redactExact(msg.error.message, this.secrets) : `MCP 错误 (${msg.error.code ?? -1})`;
      entry.reject(new Error(m));
    } else {
      entry.resolve(msg.result);
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private touchIdle(): void {
    this.clearIdleTimer();
    if (!this.alive || this.closing || this.pending.size > 0 || this.opts.idleTtlMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.pending.size === 0 && this.alive) {
        void this.destroy(new Error('MCP 常驻进程空闲超时已自动回收'));
      }
    }, this.opts.idleTtlMs);
    this.idleTimer.unref?.();
  }

  private rejectAll(err: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.cleanupAbort?.();
      entry.reject(err);
    }
    this.pending.clear();
  }

  private cleanupHome(): void {
    try { rmSync(this.home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* 忽略临时目录短暂占用 */ }
  }

  private markDead(err: Error): void {
    if (!this.alive) return;
    this.alive = false;
    this.clearIdleTimer();
    this.stdoutBuf = Buffer.alloc(0);
    this.rejectAll(err);
    if (this.pid) this.opts.processes?.exited(this.pid);
    this.cleanupHome();
    this.opts.onDead(this);
  }

  private notify(method: string, params?: Record<string, unknown>): void {
    if (!this.alive || !this.child.stdin || this.child.stdin.destroyed) return;
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }) + '\n');
  }

  /** 确保已完成 MCP initialize + notifications/initialized 握手（多并发请求共享同一次握手）。 */
  async ensureInitialized(callOpts: StdioCallOptions): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      await this.rawRpc('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'ai-console', version: '0.1.0' },
      }, callOpts);
      this.notify('notifications/initialized');
    })();
    try {
      await this.initPromise;
    } catch (err) {
      this.initPromise = null;
      await this.destroy(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  async rpc(method: string, params: Record<string, unknown> | undefined, callOpts: StdioCallOptions): Promise<unknown> {
    await this.ensureInitialized(callOpts);
    return this.rawRpc(method, params, callOpts);
  }

  private rawRpc(method: string, params: Record<string, unknown> | undefined, callOpts: StdioCallOptions): Promise<unknown> {
    if (!this.alive || this.closing) return Promise.reject(new Error('MCP 进程已退出'));
    if (callOpts.signal?.aborted) return Promise.reject(new Error('MCP 调用已取消'));
    this.clearIdleTimer();

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        entry.cleanupAbort?.();
        const err = new Error(`MCP 响应超过 ${Math.round(callOpts.timeoutMs / 1000)} 秒未返回，已自动中止并回收进程`);
        // 先移出进程池并强杀整棵进程树，再向调用方抛出超时错误，确保零孤儿进程残留
        void this.destroy(err).finally(() => reject(err));
      }, callOpts.timeoutMs);
      timer.unref?.();

      const onAbort = () => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        clearTimeout(entry.timer);
        const err = new Error('MCP 调用已取消');
        reject(err);
        // 如果只有这一个在途请求被取消，且服务端可能仍在阻塞，直接回收进程避免状态错位
        if (this.pending.size === 0) void this.destroy(err);
      };
      callOpts.signal?.addEventListener('abort', onAbort, { once: true });

      this.pending.set(id, {
        resolve,
        reject,
        timer,
        cleanupAbort: () => callOpts.signal?.removeEventListener('abort', onAbort),
      });

      try {
        this.child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) + '\n');
      } catch (writeErr) {
        this.pending.delete(id);
        clearTimeout(timer);
        callOpts.signal?.removeEventListener('abort', onAbort);
        const err = new Error(`写入 MCP 进程失败：${writeErr instanceof Error ? writeErr.message : String(writeErr)}`);
        reject(err);
        void this.destroy(err);
      }
    });
  }

  async destroy(reason = new Error('MCP 常驻进程已关闭')): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const wasAlive = this.alive;
    this.alive = false;
    // 同步从进程池移除，确保在 killTree 期间不会被并发调用继续复用或误计入活跃槽位
    this.opts.onDead(this);
    this.clearIdleTimer();
    this.stdoutBuf = Buffer.alloc(0);
    this.rejectAll(reason);
    if (this.pid) {
      try { await killTree(this.pid); } catch { /* 进程可能已自行退出 */ }
      if (wasAlive) this.opts.processes?.exited(this.pid);
    }
    this.cleanupHome();
  }
}

export class StdioMcpPool {
  private clients = new Map<string, PooledStdioClient>();
  private closed = false;

  constructor(
    private opts: {
      processes?: ProcessRegistry;
      idleTtlMs?: number;
      maxStdoutLineBytes?: number;
    } = {},
  ) {}

  private acquire(spec: StdioRuntimeSpec): PooledStdioClient {
    if (this.closed) throw Errors.invalidState('MCP 进程池已关闭');
    const fp = configFingerprint(spec);
    const existing = this.clients.get(spec.id);
    if (existing && existing.isAlive() && existing.fingerprint === fp) {
      return existing;
    }
    if (existing) {
      this.clients.delete(spec.id);
      void existing.destroy(new Error('MCP 配置已变更，正在重启进程'));
    }
    const created = new PooledStdioClient(spec, {
      processes: this.opts.processes,
      idleTtlMs: this.opts.idleTtlMs ?? MCP_STDIO_IDLE_TTL_MS,
      maxStdoutLineBytes: this.opts.maxStdoutLineBytes ?? MCP_MAX_STDOUT_LINE_BYTES,
      onDead: (dead) => {
        if (this.clients.get(spec.id) === dead) this.clients.delete(spec.id);
      },
    });
    this.clients.set(spec.id, created);
    return created;
  }

  async rpc(spec: StdioRuntimeSpec, method: string, params: Record<string, unknown> | undefined, callOpts: StdioCallOptions): Promise<unknown> {
    const client = this.acquire(spec);
    return client.rpc(method, params, callOpts);
  }

  async evict(serverId: string): Promise<void> {
    const existing = this.clients.get(serverId);
    if (!existing) return;
    this.clients.delete(serverId);
    await existing.destroy(new Error('MCP 服务已停用或配置变更'));
  }

  async closeAll(): Promise<void> {
    this.closed = true;
    const all = [...this.clients.values()];
    this.clients.clear();
    await Promise.allSettled(all.map((c) => c.destroy(new Error('工作台正在关闭，回收 MCP 进程'))));
  }

  activeCount(): number {
    return this.clients.size;
  }

  has(serverId: string): boolean {
    const c = this.clients.get(serverId);
    return Boolean(c && c.isAlive());
  }
}
