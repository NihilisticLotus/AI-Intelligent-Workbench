import { describe, expect, it } from 'vitest';
import { IndependentCommandSpec, IndependentCommandResult, IndependentToolIntent, IndependentToolRecord } from './index';

const spec = { program: 'node.exe', args: ['-e', 'process.exit(0)'], timeoutMs: 1000, maxOutputBytes: 4096 };
const intent = { taskId: 't', sessionId: 's', turnId: 'turn', callId: 'call', toolName: 'command', inputHash: 'a'.repeat(64) };
describe('独立工具协议', () => {
  it('保留 argv 原样，拒绝类型转换、空字符和注入环境', () => {
    expect(IndependentCommandSpec.parse(spec)).toEqual(spec);
    for (const change of [{ args: [123] }, { program: '' }, { args: ['x\0y'] }, { timeoutMs: '1000' },
      { maxOutputBytes: 10 }, { env: { API_KEY: '虚构值' } }, { cwd: 'D:/unexpected' }]) {
      expect(IndependentCommandSpec.safeParse({ ...spec, ...change }).success).toBe(false);
    }
  });
  it('结果区分退出码、取消与截断，不把非零码当成启动失败', () => {
    const result = { reason: 'completed', exitCode: 2, stdout: '', stderr: '验证失败', outputBytes: 12, truncated: false, durationMs: 100 };
    expect(IndependentCommandResult.parse(result)).toEqual(result);
    expect(IndependentCommandResult.safeParse({ ...result, reason: 'cancelled', exitCode: null }).success).toBe(true);
    expect(IndependentCommandResult.safeParse({ ...result, outputBytes: -1 }).success).toBe(false);
  });
  it('意图只保存身份和指纹，不能混入原始参数或密钥', () => {
    expect(IndependentToolIntent.parse(intent)).toEqual(intent);
    expect(IndependentToolIntent.safeParse({ ...intent, inputHash: '未知' }).success).toBe(false);
    expect(IndependentToolIntent.safeParse({ ...intent, args: '附件内容' }).success).toBe(false);
    expect(IndependentToolIntent.safeParse({ ...intent, apiKey: '虚构密钥' }).success).toBe(false);
    const record = { ...intent, id: 'operation', state: 'interrupted', createdAt: 1, updatedAt: 2,
      pid: null, processStartedAt: null, outcome: null };
    expect(IndependentToolRecord.parse(record)).toEqual(record);
  });
});
