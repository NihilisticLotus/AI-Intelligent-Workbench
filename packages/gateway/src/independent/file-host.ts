// 复用已验证的 Windows 作业宿主与环境白名单；正文只经本次私有请求文件和管道传输。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { IndependentFileHostReadReply, IndependentFileHostSearchReply, IndependentFileHostWriteReply, IndependentFileHostRulesReply, IndependentFileHostSnapshotReply, type IndependentFileFailureReason } from '@aic/protocol';
import { IndependentCommandExecutor } from './commands';
import { independentWorkspace, workspaceRelative } from './workspace';

export class IndependentFileError extends Error {
  constructor(public reason: IndependentFileFailureReason) { super('独立文件操作未完成：' + reason); }
}
export class IndependentFileHost {
  readonly workspace: ReturnType<typeof independentWorkspace>;
  constructor(workspace: string, private dataDir: string, private executor: IndependentCommandExecutor) { this.workspace = independentWorkspace(workspace); }
  relative(input: string) {
    const relative = workspaceRelative(input); const target = path.resolve(this.workspace.root, relative).toLowerCase();
    const privateRoot = realpathSync.native(this.dataDir).toLowerCase();
    if (target === privateRoot || target.startsWith(privateRoot + path.sep)) throw new IndependentFileError('forbidden');
    return relative;
  }

  private async request(input: Record<string, unknown>, signal?: AbortSignal, onStarted?: (identity: { pid: number; startedAt: number }) => void) {
    if (signal?.aborted) throw new IndependentFileError('cancelled');
    const fresh = independentWorkspace(this.workspace.root);
    if (fresh.fingerprint !== this.workspace.fingerprint) throw new IndependentFileError('conflict');
    const root = path.resolve(this.dataDir, 'independent/file-requests'); mkdirSync(root, { recursive: true });
    const directory = mkdtempSync(path.join(root, 'run-')); const file = path.join(directory, 'request.json');
    const host = fileURLToPath(new URL('./file-host.ps1', import.meta.url));
    const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;
    const source = fileURLToPath(new URL('./file-guard.cs', import.meta.url));
    const bootstrap = `& ([scriptblock]::Create([IO.File]::ReadAllText(${quote(host)},[Text.Encoding]::UTF8))) ${quote(file)} ${quote(source)}`;
    try {
      writeFileSync(file, JSON.stringify({ ...input, root: this.workspace.root, protectedRoot: realpathSync.native(this.dataDir) }), { flag: 'wx', mode: 0o600 });
      const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
      if (!systemRoot) throw new IndependentFileError('io_error');
      const result = await this.executor.run({ program: path.join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(bootstrap, 'utf16le').toString('base64')], timeoutMs: 30_000, maxOutputBytes: 1024 * 1024 },
      // 合并快照的 base64 加元数据略超 1 MiB，仅可信宿主的内部捕获限额提高，不放宽模型命令输出。
      { cwd: this.workspace.root, signal, onStarted, ...(input.operation === 'snapshot' ? { captureLimitBytes: 2 * 1024 * 1024 } : {}) });
      if (result.reason !== 'completed' || result.exitCode !== 0) throw new IndependentFileError(result.reason === 'cancelled' ? 'cancelled' : 'interrupted');
      try { return JSON.parse(result.stdout) as unknown; } catch { throw new IndependentFileError('io_error'); }
    } finally {
      const relative = path.relative(root, directory);
      if (path.isAbsolute(relative) || relative.startsWith('..')) throw new IndependentFileError('forbidden');
      try { rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* 保留本次私有请求，不能把清理失败当作文件操作成功与否。 */ }
    }
  }
  private readReply(value: unknown) {
    const reply = IndependentFileHostReadReply.parse(value);
    if (!reply.ok) throw new IndependentFileError(reply.reason);
    const bytes = Buffer.from(reply.data, 'base64');
    if (bytes.length > 512 * 1024 || createHash('sha256').update(bytes).digest('hex') !== reply.hash) throw new IndependentFileError('io_error');
    return { bytes, hash: reply.hash, fileId: reply.fileId };
  }
  async read(relative: string, signal?: AbortSignal) {
    return this.readReply(await this.request({ operation: 'read', path: this.relative(relative) }, signal));
  }
  async snapshot(relative: string, paths: string[], signal?: AbortSignal) {
    const reply = IndependentFileHostSnapshotReply.parse(await this.request({ operation: 'snapshot', path: this.relative(relative), paths: paths.map((p) => this.relative(p)) }, signal));
    if (!reply.ok) throw new IndependentFileError(reply.reason);
    if (!reply.rules.ok) throw new IndependentFileError(reply.rules.reason);
    if (reply.rules.items.length !== paths.length || reply.rules.items.some((item, index) => item.path !== paths[index])) throw new IndependentFileError('io_error');
    const original = !reply.original.ok && reply.original.reason === 'not_found' ? null : this.readReply(reply.original);
    return { items: reply.rules.items, original };
  }
  async write(relative: string, bytes: Uint8Array, options: { expectedHash: string | null; createParents: boolean; signal?: AbortSignal; onStarted?: (identity: { pid: number; startedAt: number }) => void }) {
    if (bytes.byteLength > 512 * 1024) throw new IndependentFileError('too_large');
    const reply = IndependentFileHostWriteReply.parse(await this.request({ operation: 'write', path: this.relative(relative), data: Buffer.from(bytes).toString('base64'),
      expectedHash: options.expectedHash, create: options.expectedHash === null, createParents: options.createParents }, options.signal, options.onStarted));
    if (!reply.ok) throw new IndependentFileError(reply.reason);
    if (reply.hash !== createHash('sha256').update(bytes).digest('hex')) throw new IndependentFileError('io_error');
    return reply.hash;
  }
  async search(paths: string[], query: string, caseSensitive: boolean, maxMatches: number, signal?: AbortSignal) {
    const reply = IndependentFileHostSearchReply.parse(await this.request({ operation: 'search', paths: paths.map((p) => this.relative(p)), query, caseSensitive, maxMatches }, signal));
    if (!reply.ok) throw new IndependentFileError(reply.reason);
    return reply.found;
  }
  async rules(paths: string[], signal?: AbortSignal) {
    const reply = IndependentFileHostRulesReply.parse(await this.request({ operation: 'rules', paths: paths.map((p) => this.relative(p)) }, signal));
    if (!reply.ok) throw new IndependentFileError(reply.reason);
    if (reply.items.length !== paths.length || reply.items.some((item, index) => item.path !== paths[index])) throw new IndependentFileError('io_error');
    return reply.items;
  }
}
