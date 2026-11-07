import { describe, expect, it } from 'vitest';
import { IndependentRelativePath, IndependentFileWriteSpec, IndependentFileReadSpec, IndependentFileSearchSpec,
  IndependentFileApprovalDecision, IndependentFileReceipt, IndependentFileWriteOutcome } from './index';

describe('独立文件协议', () => {
  it('只接纳规范相对路径，拒绝遍历、设备别名、流与 Windows 歧义', () => {
    for (const value of ['src/世界.ts', 'assets/a-b_1.txt', 'CONSOLE.md']) expect(IndependentRelativePath.safeParse(value).success).toBe(true);
    for (const value of ['', '../a', 'a/../b', './a', '/a', 'C:/a', '//server/a', 'a\\b', 'a//b', 'a:stream', 'a.','a ',
      'a/CON.txt', 'nul', 'COM¹.txt', 'lpt9', 'a\n', 'a*', 'a/'.repeat(501)]) expect(IndependentRelativePath.safeParse(value).success, value).toBe(false);
  });
  it('创建与替换严格区分，布尔值和数字不转换', () => {
    const create = { kind: 'create', path: 'new.txt', content: '内容', createParents: false };
    expect(IndependentFileWriteSpec.parse(create)).toEqual(create);
    for (const patch of [{ createParents: 'false' }, { content: 1 }, { expectedHash: 'a'.repeat(64) }]) expect(IndependentFileWriteSpec.safeParse({ ...create, ...patch }).success).toBe(false);
    expect(IndependentFileWriteSpec.safeParse({ kind: 'replace', path: 'a', expectedHash: 'a'.repeat(64), oldText: '', newText: '' }).success).toBe(false);
    expect(IndependentFileWriteSpec.safeParse({ kind: 'replace', path: 'a', expectedHash: 'a'.repeat(64), oldText: 'x', newText: '$&' }).success).toBe(true);
  });
  it('读取、搜索与审批的上限明确，不允许模型附加放行字段', () => {
    expect(IndependentFileReadSpec.safeParse({ path: 'a', startLine: '1', maxLines: 1 }).success).toBe(false);
    expect(IndependentFileReadSpec.safeParse({ path: 'a', startLine: 1, maxLines: 1001 }).success).toBe(false);
    expect(IndependentFileSearchSpec.safeParse({ directory: null, query: 'x', caseSensitive: false, maxMatches: 201 }).success).toBe(false);
    expect(IndependentFileApprovalDecision.safeParse({ approved: true, reason: '', always: true }).success).toBe(false);
  });
  it('修改结果和备份凭据不接纳正文，未知结果保留可空摘要', () => {
    const outcome = { status: 'interrupted', path: 'a', beforeHash: 'a'.repeat(64), afterHash: null, receiptId: null, durationMs: 1, message: '核对实际结果' };
    expect(IndependentFileWriteOutcome.parse(outcome)).toEqual(outcome);
    expect(IndependentFileWriteOutcome.safeParse({ ...outcome, original: '正文' }).success).toBe(false);
    const receipt = { id: 'ifr_test', toolId: 'tool', taskId: 'task', sessionId: 'session', path: 'a', workspaceHash: 'a'.repeat(64), beforeHash: null, afterHash: 'b'.repeat(64), state: 'prepared', createdAt: 1, updatedAt: 1 };
    expect(IndependentFileReceipt.parse(receipt)).toEqual(receipt);
    expect(IndependentFileReceipt.safeParse({ ...receipt, original: '正文' }).success).toBe(false);
  });
});
