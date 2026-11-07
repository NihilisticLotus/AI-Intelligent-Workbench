// 创建 / 替换的审批接缝：基准、规则与权限均绑定指纹；备份提交成功后才允许文件写入。
import { createHash } from 'node:crypto';
import { IndependentFileWriteSpec, IndependentFileProposal, type IndependentFileWriteOutcome, type IndependentToolIntent } from '@aic/protocol';
import { Errors } from '../util';
import { IndependentFiles } from './files';
import { IndependentFileError } from './file-host';
import { IndependentFileReceipts } from './file-receipts';
import { IndependentToolJournal } from './tool-journal';
import { independentWorkspace, workspaceRelative } from './workspace';

export class IndependentFileTool {
  constructor(private files: IndependentFiles, private journal: IndependentToolJournal, private receipts: IndependentFileReceipts) {}
  private async plan(input: IndependentFileWriteSpec, approvalBasis: string, signal?: AbortSignal) {
    const spec = IndependentFileWriteSpec.parse(input); workspaceRelative(spec.path);
    const workspace = independentWorkspace(this.files.host.workspace.root);
    if (workspace.fingerprint !== this.files.host.workspace.fingerprint) throw Errors.conflict('工作区身份已变化，请重新核对');
    const rules = await this.files.rules(spec.path, signal);
    if (!rules.complete) throw Errors.invalidState('项目规则未完整读取，暂不能修改文件');
    let original: Buffer | null = null; let beforeHash: string | null = null; let beforeText: string | null = null; let afterText: string;
    if (spec.kind === 'replace') {
      const snapshot = await this.files.host.read(spec.path, signal); original = snapshot.bytes; beforeHash = snapshot.hash;
      if (snapshot.hash !== spec.expectedHash) throw Errors.conflict('文件已变化，未覆盖，请重新读取并审批');
      beforeText = new TextDecoder('utf-8', { fatal: true }).decode(original);
      const position = beforeText.indexOf(spec.oldText);
      if (position < 0 || beforeText.indexOf(spec.oldText, position + 1) >= 0) throw Errors.conflict('替换原文必须且只能匹配一处，请重新读取');
      afterText = beforeText.slice(0, position) + spec.newText + beforeText.slice(position + spec.oldText.length);
    } else {
      try { await this.files.host.read(spec.path, signal); throw Errors.conflict('创建目标已经存在，未覆盖，请重新核对'); }
      catch (error) { if (!(error instanceof IndependentFileError) || error.reason !== 'not_found') throw error; }
      afterText = spec.content;
    }
    const bom = original?.subarray(0, 3).equals(Buffer.from([239, 187, 191]));
    const after = Buffer.concat([bom ? Buffer.from([239, 187, 191]) : Buffer.alloc(0), Buffer.from(afterText)]);
    if (Buffer.from(afterText).toString('utf8') !== afterText) throw Errors.badRequest('修改文本含不完整的 Unicode 字符');
    if (after.length > 512 * 1024 || after.includes(0)) throw Errors.tooLarge('仅支持不含空字符且不超过 512 KiB 的 UTF-8 文本修改');
    const afterHash = createHash('sha256').update(after).digest('hex');
    const inputHash = createHash('sha256').update(JSON.stringify([spec, workspace.fingerprint, rules.fingerprint, approvalBasis, beforeHash, afterHash])).digest('hex');
    return { spec, workspace, rules, original, beforeHash, beforeText, afterText, after, afterHash, inputHash };
  }
  async prepare(identity: Omit<IndependentToolIntent, 'toolName' | 'inputHash'>, input: IndependentFileWriteSpec, approvalBasis: string, signal?: AbortSignal): Promise<IndependentFileProposal> {
    const plan = await this.plan(input, approvalBasis, signal);
    const record = this.journal.create({ ...identity, toolName: 'file_write', inputHash: plan.inputHash });
    return IndependentFileProposal.parse({ record, kind: plan.spec.kind, path: plan.spec.path, beforeText: plan.beforeText, afterText: plan.afterText,
      beforeHash: plan.beforeHash, afterHash: plan.afterHash, workspaceHash: plan.workspace.fingerprint, rulesFingerprint: plan.rules.fingerprint });
  }
  async execute(id: string, input: IndependentFileWriteSpec, approvalBasis: string, signal?: AbortSignal): Promise<IndependentFileWriteOutcome> {
    const at = performance.now();
    if (signal?.aborted) { this.journal.cancel(id); return { status: 'cancelled', path: IndependentFileWriteSpec.parse(input).path, beforeHash: null, afterHash: null, receiptId: null, durationMs: performance.now() - at, message: '文件修改已取消，未派发写入' }; }
    const plan = await this.plan(input, approvalBasis, signal); const record = this.journal.get(id);
    if (record.toolName !== 'file_write' || record.inputHash !== plan.inputHash) throw Errors.conflict('修改内容、项目规则或审批基准已变化，请重新审批');
    const running = this.journal.start(id);
    const receipt = this.receipts.create(running, { path: plan.spec.path, workspaceHash: plan.workspace.fingerprint,
      beforeHash: plan.beforeHash, afterHash: plan.afterHash, original: plan.original });
    let result: IndependentFileWriteOutcome;
    try {
      await this.files.host.write(plan.spec.path, plan.after, { expectedHash: plan.beforeHash,
        createParents: plan.spec.kind === 'create' && plan.spec.createParents, signal, onStarted: (process) => { this.journal.setProcess(id, process.pid, process.startedAt); } });
      result = { status: 'written', path: plan.spec.path, beforeHash: plan.beforeHash, afterHash: plan.afterHash,
        receiptId: receipt.id, durationMs: performance.now() - at, message: '文件修改完成，原始备份与修改凭据已保留' };
    } catch (error: unknown) {
      const conflict = error instanceof IndependentFileError && ['conflict', 'not_found', 'busy', 'forbidden'].includes(error.reason);
      result = { status: conflict ? 'conflict' : 'interrupted', path: plan.spec.path, beforeHash: plan.beforeHash, afterHash: null,
        receiptId: receipt.id, durationMs: performance.now() - at,
        message: conflict ? '文件目标冲突或不可安全打开，未覆盖原文件；已请求的父目录可能保留' : '修改未可靠完成，请核对实际文件与原始备份，不会自动重做' };
    }
    // 结果持久化故障必须向宿主传播；原文备份与 prepared 凭据留待核对，不能报成功。
    this.receipts.mark(receipt.id, result.status === 'written' ? 'written' : 'unknown');
    this.journal.finishFile(id, result); return result;
  }
}
