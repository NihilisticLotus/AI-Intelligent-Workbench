// 私有附件读取同时用于下载与独立模型；正文只经受控管道，不进入请求文件、事件或日志。
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { IndependentAttachmentHostRequest, IndependentAttachmentHostReply, type AttachmentSnapshot } from '@aic/protocol';
import { IndependentCommandExecutor } from './independent/commands';

export class AttachmentFileReader {
  private root: string;
  private active = 0;
  private waiting = new Set<() => void>();
  constructor(dataDirectory: string, private executor: IndependentCommandExecutor) { this.root = realpathSync.native(dataDirectory); }
  private async acquire(signal: AbortSignal) {
    if (signal.aborted) throw new Error('附件读取已取消');
    if (this.active < 2) this.active++;
    else await new Promise<void>((resolve, reject) => {
      if (this.waiting.size >= 32) { reject(new Error('附件读取等待已满')); return; }
      const abort = () => { this.waiting.delete(ready); signal.removeEventListener('abort', abort); reject(new Error('附件读取已取消')); };
      const ready = () => { this.waiting.delete(ready); signal.removeEventListener('abort', abort); if (signal.aborted) reject(new Error('附件读取已取消')); else { this.active++; resolve(); } };
      this.waiting.add(ready); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    });
    return () => { this.active--; this.waiting.values().next().value?.(); };
  }
  async read(taskId: string, snapshot: AttachmentSnapshot, signal: AbortSignal, maxBytes: number): Promise<Buffer> {
    const release = await this.acquire(signal);
    try { return await this.readLocked(taskId, snapshot, signal, maxBytes); } finally { release(); }
  }
  private async readLocked(taskId: string, snapshot: AttachmentSnapshot, signal: AbortSignal, maxBytes: number): Promise<Buffer> {
    if (signal.aborted) throw new Error('附件读取已取消');
    const request = IndependentAttachmentHostRequest.parse({ dataDirectory: this.root, taskId, attachmentId: snapshot.info.id, sha256: snapshot.sha256, size: snapshot.info.size, maxBytes });
    if (request.size > maxBytes) throw new Error('附件超过读取限额');
    const base = path.join(this.root, 'independent/attachment-requests'); mkdirSync(base, { recursive: true });
    const directory = mkdtempSync(path.join(base, 'run-')), file = path.join(directory, 'request.json');
    const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;
    const host = fileURLToPath(new URL('./independent/attachment-host.ps1', import.meta.url)), source = fileURLToPath(new URL('./independent/file-guard.cs', import.meta.url));
    const bootstrap = `& ([scriptblock]::Create([IO.File]::ReadAllText(${quote(host)},[Text.Encoding]::UTF8))) ${quote(file)} ${quote(source)}`;
    try {
      writeFileSync(file, JSON.stringify(request), { flag: 'wx', mode: 0o600 });
      const systemRoot = process.env.SystemRoot ?? process.env.WINDIR; if (!systemRoot) throw new Error('附件宿主不可用');
      const result = await this.executor.run({ program: path.join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(bootstrap, 'utf16le').toString('base64')], timeoutMs: 30_000, maxOutputBytes: 1024 * 1024 },
      { cwd: this.root, signal, captureLimitBytes: Math.min(32 * 1024 * 1024, Math.max(1024, Math.ceil(maxBytes / 3) * 4 + 4096)) });
      if (signal.aborted || result.reason !== 'completed' || result.exitCode !== 0) throw new Error('附件宿主未完成读取');
      const reply = IndependentAttachmentHostReply.parse(JSON.parse(result.stdout));
      if (!reply.ok) throw new Error('附件无法安全读取');
      const bytes = Buffer.from(reply.data, 'base64');
      if (bytes.length !== snapshot.info.size || bytes.length > maxBytes || reply.hash !== snapshot.sha256 || createHash('sha256').update(bytes).digest('hex') !== snapshot.sha256) throw new Error('附件上传摘要不一致');
      return bytes;
    } finally {
      if (path.dirname(directory) !== base || !path.basename(directory).startsWith('run-')) throw new Error('附件私有请求目录无效');
      try { rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* 只留私有身份请求，调用方不把清理失败当作读取成功的证据。 */ }
    }
  }
}
