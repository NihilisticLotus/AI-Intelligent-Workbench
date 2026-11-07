// SDK 无关的命令接缝：审批绑定输入，意图先落盘，登记成功后再执行，结果保存失败不报成功。
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { IndependentCommandSpec, type IndependentCommandResult, type IndependentToolIntent } from '@aic/protocol';
import { Errors } from '../util';
import { IndependentCommandExecutor } from './commands';
import { IndependentToolJournal } from './tool-journal';

function fingerprint(input: IndependentCommandSpec, cwd: string, approvalBasis: string) {
  const spec = IndependentCommandSpec.parse(input);
  if (!path.isAbsolute(cwd) || !path.isAbsolute(spec.program) || /\.(cmd|bat)$/i.test(spec.program)) throw Errors.badRequest('命令与工作区必须使用已确认的绝对路径');
  const canonicalCwd = realpathSync(cwd);
  const inputHash = createHash('sha256').update(JSON.stringify({ program: spec.program, args: spec.args,
    timeoutMs: spec.timeoutMs, maxOutputBytes: spec.maxOutputBytes, cwd: canonicalCwd, approvalBasis })).digest('hex');
  return { spec, cwd: canonicalCwd, inputHash };
}

export class IndependentCommandTool {
  constructor(private journal: IndependentToolJournal, private executor: IndependentCommandExecutor) {}

  /** approvalBasis 由权限层提供，包含这次审批采用的权限与工作区基准。 */
  prepare(identity: Omit<IndependentToolIntent, 'toolName' | 'inputHash'>, input: IndependentCommandSpec, cwd: string, approvalBasis: string) {
    const { inputHash } = fingerprint(input, cwd, approvalBasis);
    return this.journal.create({ ...identity, toolName: 'command', inputHash });
  }

  async execute(id: string, input: IndependentCommandSpec, options: {
    cwd: string; approvalBasis: string; signal?: AbortSignal; redact?: readonly string[];
  }): Promise<IndependentCommandResult> {
    const { spec, cwd, inputHash } = fingerprint(input, options.cwd, options.approvalBasis);
    const record = this.journal.get(id);
    if (record.toolName !== 'command' || record.inputHash !== inputHash) throw Errors.conflict('命令或审批基准已变化，请重新审批');
    this.journal.start(id);
    let result: IndependentCommandResult;
    try {
      result = await this.executor.run(spec, { cwd, signal: options.signal, redact: options.redact,
        onStarted: ({ pid, startedAt }) => { this.journal.setProcess(id, pid, startedAt); } });
    } catch {
      // 规范化后的启动异常不能把原始 argv 或系统错误带入事件。
      result = { reason: 'start_failed', exitCode: null, outputBytes: 0, truncated: false,
        durationMs: 0, stdout: '', stderr: '命令未能启动，请检查工作区与命令宿主' };
    }
    // 失败时保留 running，交给重启恢复核对；不能向模型报告已可靠保存。
    this.journal.finish(id, result);
    return result;
  }
}
