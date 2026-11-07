// 正式文件工具路由接缝。审批 callback 只由 Gateway 提供，模型不能设置放行策略。
import {
  IndependentFileApprovalDecision, IndependentFileListSpec, IndependentFileReadSpec, IndependentFileSearchSpec,
  IndependentFileWriteSpec, IndependentProjectRulesSpec, type IndependentFileProposal,
  type IndependentToolCall, type IndependentToolDriver, type IndependentToolMessage,
} from '@aic/protocol';
import { AppError } from '../util';
import { IndependentFiles } from './files';
import { IndependentFileTool } from './file-tool';
import { IndependentToolJournal } from './tool-journal';
import { IndependentFileError } from './file-host';

export class IndependentFileDriver implements IndependentToolDriver {
  constructor(private files: IndependentFiles, private writes: IndependentFileTool, private journal: IndependentToolJournal,
    private approvalBasis: string,
    private approve: (proposal: IndependentFileProposal, signal: AbortSignal) => Promise<IndependentFileApprovalDecision>) {}
  async execute(call: IndependentToolCall, identity: { taskId: string; sessionId: string; turnId: string }, signal: AbortSignal): Promise<IndependentToolMessage> {
    const reply = (outcome: IndependentToolMessage['outcome'], text: string): IndependentToolMessage => ({ role: 'tool', callId: call.id, name: call.name, outcome, text });
    if (signal.aborted) return reply('cancelled', '文件操作已取消，未执行');
    const schema = call.name === 'list_files' ? IndependentFileListSpec : call.name === 'read_file' ? IndependentFileReadSpec
      : call.name === 'search_files' ? IndependentFileSearchSpec : call.name === 'read_rules' ? IndependentProjectRulesSpec : call.name === 'write_file' ? IndependentFileWriteSpec : null;
    if (!schema || !schema.safeParse(call.arguments).success) return reply('error', '工具名称或参数不符合严格规范，未执行');
    let prepared: IndependentFileProposal | undefined;
    try {
      if (call.name === 'list_files') return reply('ok', JSON.stringify(await this.files.list(IndependentFileListSpec.parse(call.arguments), signal)));
      if (call.name === 'read_file') return reply('ok', JSON.stringify(await this.files.read(IndependentFileReadSpec.parse(call.arguments), signal)));
      if (call.name === 'search_files') return reply('ok', JSON.stringify(await this.files.search(IndependentFileSearchSpec.parse(call.arguments), signal)));
      if (call.name === 'read_rules') return reply('ok', JSON.stringify(await this.files.rules(IndependentProjectRulesSpec.parse(call.arguments).target, signal)));
      const spec = IndependentFileWriteSpec.parse(call.arguments);
      prepared = await this.writes.prepare({ ...identity, callId: call.id }, spec, this.approvalBasis, signal);
      if (signal.aborted) { this.journal.cancel(prepared.record.id); return reply('cancelled', '文件修改已取消，未发起审批'); }
      let removeAbort = () => {};
      const cancelled = new Promise<never>((_resolve, reject) => {
        const abort = () => reject(new IndependentFileError('cancelled'));
        signal.addEventListener('abort', abort, { once: true }); removeAbort = () => signal.removeEventListener('abort', abort);
        if (signal.aborted) abort();
      });
      let decision: IndependentFileApprovalDecision;
      try { decision = IndependentFileApprovalDecision.parse(await Promise.race([this.approve(prepared, signal), cancelled])); }
      finally { removeAbort(); }
      if (signal.aborted) { this.journal.cancel(prepared.record.id); return reply('cancelled', '审批已取消，不接受迟到放行'); }
      if (!decision.approved) { this.journal.reject(prepared.record.id); return reply('rejected', decision.reason || '用户拒绝本次文件修改'); }
      this.journal.approve(prepared.record.id);
      const result = await this.writes.execute(prepared.record.id, spec, this.approvalBasis, signal);
      return reply(result.status === 'written' ? 'ok' : result.status === 'interrupted' ? 'interrupted' : result.status === 'cancelled' ? 'cancelled' : 'error', JSON.stringify(result));
    } catch (error) {
      if (prepared) {
        const record = this.journal.get(prepared.record.id);
        if (record.state === 'running') throw error;
        if (record.state === 'pending' || record.state === 'approved') this.journal.cancel(record.id);
      }
      if (signal.aborted) return reply('cancelled', '文件操作已取消，未派发后续写入');
      if (error instanceof AppError) return reply('error', error.body.message);
      if (error instanceof IndependentFileError) return reply('error', '文件不满足访问、类型或容量条件，未继续执行：' + error.reason);
      throw error;
    }
  }
}
