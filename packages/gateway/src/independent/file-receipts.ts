// 修改前在同一私有数据库保存原字节；不提供原文事件，不自动恢复或再次执行。
import { createHash } from 'node:crypto';
import { IndependentFileReceipt, type IndependentToolRecord } from '@aic/protocol';
import type { Db, Row } from '../db';
import { Errors, newId, now } from '../util';

export class IndependentFileReceipts {
  constructor(private db: Db) {}
  private record(r: Row): IndependentFileReceipt {
    return IndependentFileReceipt.parse({ id: r.id, toolId: r.tool_id, taskId: r.task_id, sessionId: r.session_id, path: r.path,
      workspaceHash: r.workspace_hash, beforeHash: r.before_hash, afterHash: r.after_hash, state: r.state, createdAt: r.created_at, updatedAt: r.updated_at });
  }
  get(id: string) {
    const row = this.db.get('SELECT * FROM independent_file_receipts WHERE id=?', id);
    if (!row) throw Errors.notFound('找不到文件修改凭据'); return this.record(row);
  }
  create(tool: IndependentToolRecord, input: { path: string; workspaceHash: string; beforeHash: string | null; afterHash: string; original: Uint8Array | null }) {
    return this.db.tx(() => {
      const current = this.db.get('SELECT state,task_id,session_id FROM independent_tool_calls WHERE id=?', tool.id);
      if (!current || current.state !== 'running' || current.task_id !== tool.taskId || current.session_id !== tool.sessionId) throw Errors.invalidState('文件工具尚未登记执行');
      if (input.original === null ? input.beforeHash !== null : input.original.length > 512 * 1024 || createHash('sha256').update(input.original).digest('hex') !== input.beforeHash) throw Errors.badRequest('原始备份与修改基准不一致');
      const receipt = IndependentFileReceipt.parse({ id: newId('ifr'), toolId: tool.id, taskId: tool.taskId, sessionId: tool.sessionId,
        path: input.path, workspaceHash: input.workspaceHash, beforeHash: input.beforeHash, afterHash: input.afterHash, state: 'prepared', createdAt: now(), updatedAt: now() });
      this.db.run('INSERT INTO independent_file_receipts(id,tool_id,task_id,session_id,path,workspace_hash,before_hash,after_hash,original,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        receipt.id, tool.id, tool.taskId, tool.sessionId, receipt.path, receipt.workspaceHash, receipt.beforeHash, receipt.afterHash, input.original, receipt.state, receipt.createdAt, receipt.updatedAt);
      return receipt;
    });
  }
  mark(id: string, state: 'written' | 'unknown') {
    return this.db.tx(() => {
      const current = this.get(id);
      if (current.state !== 'prepared') throw Errors.invalidState('文件修改凭据已收尾，不能覆写');
      this.db.run('UPDATE independent_file_receipts SET state=?,updated_at=? WHERE id=? AND state=?', state, now(), id, 'prepared');
      return this.get(id);
    });
  }
  backup(id: string) {
    const receipt = this.get(id); const row = this.db.get('SELECT original FROM independent_file_receipts WHERE id=?', id)!;
    if (row.original === null) return null;
    const bytes = Buffer.from(row.original as Uint8Array);
    if (createHash('sha256').update(bytes).digest('hex') !== receipt.beforeHash) throw Errors.invalidState('原始备份摘要不一致，停止恢复');
    return bytes;
  }
  recover(sessionId?: string) {
    return this.db.tx(() => {
      const rows = this.db.all("SELECT id FROM independent_file_receipts WHERE state='prepared'" + (sessionId ? ' AND session_id=?' : ''), ...(sessionId ? [sessionId] : []));
      return rows.map((r) => this.mark(String(r.id), 'unknown'));
    });
  }
}
