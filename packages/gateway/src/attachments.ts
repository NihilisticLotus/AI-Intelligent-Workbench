// 附件只按服务端生成的 id 存盘；类型和尺寸来自内容，客户端 MIME 不参与判断。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ErrorCode, AttachmentSnapshot, type AttachmentInfo, type PromptAttachment } from '@aic/protocol';
import { redact } from '@aic/adapters';
import type { Db } from './db';
import { AppError, Errors, newId } from './util';
import { AttachmentFileReader } from './attachment-reader';
import { IndependentCommandExecutor } from './independent/commands';
const MB = 1024 * 1024;
export const attachmentError = (status: number, code: string, message: string) => new AppError(status, { code, message, actions: [] });
export function cleanFilename(raw: string): string {
  return redact(raw).replace(/[\\/<>:"|?*\x00-\x1f\x7f]/g, '_').replace(/[. ]+$/g, '').slice(0, 255) || '附件';
}
export function sniffAttachment(b: Buffer): Pick<AttachmentInfo, 'kind' | 'mime' | 'width' | 'height'> {
  if (b.subarray(0, 2).toString() === 'MZ' || b.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))) throw attachmentError(415, ErrorCode.AttachmentBadType, '不能上传可执行文件');
  let mime = '', width = 0, height = 0;
  if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) { mime = 'image/png'; width = b.readUInt32BE(16); height = b.readUInt32BE(20); }
  else if (b.length >= 10 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString())) { mime = 'image/gif'; width = b.readUInt16LE(6); height = b.readUInt16LE(8); }
  else if (b.length >= 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const tag = b.toString('ascii', 12, 16);
    if (tag === 'VP8X') { width = b.readUIntLE(24, 3) + 1; height = b.readUIntLE(27, 3) + 1; }
    if (tag === 'VP8 ' && b[23] === 0x9d && b[24] === 1 && b[25] === 0x2a) { width = b.readUInt16LE(26) & 0x3fff; height = b.readUInt16LE(28) & 0x3fff; }
    if (tag === 'VP8L' && b[20] === 0x2f) { const bits = b.readUInt32LE(21); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1; }
    mime = 'image/webp';
  } else if (b.length > 3 && b[0] === 255 && b[1] === 216) {
    mime = 'image/jpeg';
    for (let i = 2; i + 8 < b.length;) {
      if (b[i] !== 255) { i++; continue; } const marker = b[i + 1]!;
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0xd8 || marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const n = b.readUInt16BE(i + 2); if (n < 2 || i + 2 + n > b.length) break;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) { height = b.readUInt16BE(i + 5); width = b.readUInt16BE(i + 7); break; } i += 2 + n;
    }
  }
  if (mime) {
    if (!width || !height) throw attachmentError(415, ErrorCode.AttachmentBadType, '图片文件头无效，无法读取宽高');
    if (b.length > 5 * MB) throw attachmentError(413, ErrorCode.AttachmentTooLarge, '图片太大，最大 5 MB');
    return { kind: 'image', mime, width, height };
  }
  let text = false; try { new TextDecoder('utf-8', { fatal: true }).decode(b); text = !b.includes(0); } catch { /* 二进制文件 */ }
  return { kind: 'file', mime: text ? 'text/plain; charset=utf-8' : 'application/octet-stream', width: null, height: null };
}
type Row = { id: string; task_id: string; name: string; mime: string; size: number; kind: AttachmentInfo['kind']; width: number | null; height: number | null; created_at: number };
const info = (r: Row): AttachmentInfo => ({ id: r.id, name: r.name, mime: r.mime, size: r.size, kind: r.kind, width: r.width, height: r.height, createdAt: r.created_at });
export class AttachmentService {
  private root: string;
  private reader?: AttachmentFileReader;
  private closed = false;
  private stopping = new AbortController();
  constructor(private db: Db, private dataDir: string, private executor?: IndependentCommandExecutor) { this.root = path.resolve(dataDir, 'attachments'); }
  private file(taskId: string, id: string) {
    if (!/^[\w-]+$/.test(taskId) || !/^att_[\w-]+$/.test(id)) throw attachmentError(404, ErrorCode.AttachmentNotFound, '找不到附件');
    return path.join(this.root, taskId, id);
  }
  upload(taskId: string, name: string, b: Buffer): AttachmentInfo {
    if (!this.db.get('SELECT id FROM tasks WHERE id = ?', taskId)) throw Errors.notFound('找不到任务');
    if (b.length > 20 * MB) throw attachmentError(413, ErrorCode.AttachmentTooLarge, '附件太大，最大 20 MB');
    const shape = sniffAttachment(b), id = newId('att'), file = this.file(taskId, id);
    return this.db.tx(() => {
      const quota = this.db.get<{ n: number; size: number }>('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS size FROM attachments WHERE task_id = ?', taskId)!;
      if (quota.n >= 50 || quota.size + b.length > 200 * MB) throw attachmentError(400, ErrorCode.AttachmentTooMany, '每个任务最多 50 个附件，总大小不超过 200 MB');
      const a = { id, name: cleanFilename(name), size: b.length, ...shape, createdAt: Date.now() };
      mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, b, { flag: 'wx' });
      try { this.db.run('INSERT INTO attachments (id,task_id,name,mime,size,kind,width,height,sha256,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', id, taskId, a.name, a.mime, a.size, a.kind, a.width, a.height, createHash('sha256').update(b).digest('hex'), a.createdAt); }
      catch (e) { rmSync(file, { force: true }); throw e; }
      return a;
    });
  }
  get(taskId: string, id: string) {
    const row = this.db.get<Row>('SELECT * FROM attachments WHERE id = ? AND task_id = ?', id, taskId);
    const file = this.file(taskId, id);
    if (!row || !existsSync(file)) throw attachmentError(404, ErrorCode.AttachmentNotFound, '附件不存在或已过期，请重新添加');
    return { info: info(row), path: file };
  }
  /** 只查询本任务上传的元数据，独立宿主不通过 get / read 跟随磁盘路径。 */
  snapshot(taskId: string, id: string) {
    this.file(taskId, id);
    const row = this.db.get<Row & { sha256: string }>('SELECT * FROM attachments WHERE id=? AND task_id=?', id, taskId);
    if (!row) throw attachmentError(404, ErrorCode.AttachmentNotFound, '附件不存在或已过期，请重新添加');
    return AttachmentSnapshot.parse({ info: info(row), sha256: row.sha256 });
  }
  async read(taskId: string, id: string, signal = new AbortController().signal, maxBytes = 20 * MB) {
    const snapshot = this.snapshot(taskId, id);
    signal = AbortSignal.any([signal, this.stopping.signal]);
    try {
      if (this.closed || signal.aborted) throw new Error('附件读取已停止');
      this.executor ??= new IndependentCommandExecutor(this.dataDir);
      this.reader ??= new AttachmentFileReader(this.dataDir, this.executor);
      const bytes = await this.reader.read(taskId, snapshot, signal, maxBytes);
      if (this.closed || signal.aborted || JSON.stringify(this.snapshot(taskId, id)) !== JSON.stringify(snapshot)) throw new Error('附件身份变化');
      return { info: snapshot.info, bytes };
    } catch {
      throw attachmentError(409, ErrorCode.AttachmentReadFailed, signal.aborted ? '附件读取已取消' : '附件内容已变化、被占用或无法安全读取，请重新添加');
    }
  }
  async close() { this.closed = true; this.stopping.abort(); await this.executor?.close(); }
  resolve(taskId: string, ids: string[] = []): { infos: AttachmentInfo[]; inputs: PromptAttachment[] } {
    if (ids.length > 10) throw attachmentError(400, ErrorCode.AttachmentTooMany, '每条消息最多 10 个附件');
    const found = [...new Set(ids)].map((id) => this.get(taskId, id));
    return { infos: found.map((a) => a.info), inputs: found.map((a) => ({ ...a.info, attachmentId: a.info.id, path: a.path, uri: pathToFileURL(a.path).href })) };
  }
  markUsed(taskId: string, ids: string[]) { for (const id of ids) this.db.run('UPDATE attachments SET used_at = ? WHERE id = ? AND task_id = ?', Date.now(), id, taskId); }
  cleanup(at = Date.now()) {
    for (const r of this.db.all<Row>('SELECT * FROM attachments WHERE used_at IS NULL AND created_at < ?', at - 24 * 60 * 60_000)) {
      rmSync(this.file(r.task_id, r.id), { force: true }); this.db.run('DELETE FROM attachments WHERE id = ?', r.id);
    }
  }
  deleteTask(taskId: string) {
    // 路径必须位于本服务的附件根目录下。
    if (!/^[\w-]+$/.test(taskId)) throw Errors.badRequest('任务编号无效');
    const target = path.resolve(this.root, taskId);
    if (path.dirname(target) !== this.root) throw Errors.badRequest('任务编号无效');
    rmSync(target, { recursive: true, force: true }); this.db.run('DELETE FROM attachments WHERE task_id = ?', taskId);
  }
}
