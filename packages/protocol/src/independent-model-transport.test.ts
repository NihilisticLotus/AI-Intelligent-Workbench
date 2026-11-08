import { describe, expect, it } from 'vitest';
import { IndependentGenerationOptions, IndependentModelToolDefinition, IndependentModelRequest, IndependentModelAttachment, IndependentModelDelta } from './index';

describe('独立模型传输协议', () => {
  it('旧请求无需新增选项仍可解析，未知参数和隐式环境被拒绝', () => {
    const request = { binding: { taskId: 'task', serviceId: 'service', modelId: 'model', configRevision: 1, modelRevision: 1, createdAt: 1 },
      systemPrompt: '', checkpoint: null, messages: [{ role: 'user', text: '继续', attachments: [] }], maxOutputTokens: 100 };
    expect(IndependentModelRequest.parse(request)).toEqual(request);
    for (const extra of [{ apiKey: '不得内联密钥' }, { baseUrl: 'https://example.com' }, { env: {} }, { maxOutputTokens: '100' }]) expect(IndependentModelRequest.safeParse({ ...request, ...extra }).success).toBe(false);
  });
  it('档位原样保留，预算不接受字符串 / 小数，协议参数不自动转换', () => {
    expect(IndependentGenerationOptions.parse({ effort: '自定义档位', thinking: { mode: 'enabled', budgetTokens: 2048 }, chatTokenLimitField: 'max_tokens' })).toMatchObject({ effort: '自定义档位' });
    for (const input of [{ stream: 'true' }, { thinking: { mode: 'enabled', budgetTokens: '2048' } }, { thinking: { mode: 'enabled', budgetTokens: 1024.5 } }, { chatTokenLimitField: 'auto' }]) expect(IndependentGenerationOptions.safeParse(input).success).toBe(false);
  });
  it('工具定义有界且仅对象 schema，不含可执行实现或默认放行', () => {
    const tool = { name: 'read_file', description: '读取', parameters: { type: 'object' } };
    expect(IndependentModelToolDefinition.parse(tool)).toEqual(tool);
    for (const extra of [{ execute: '自动执行' }, { approved: true }, { parameters: { type: 'string' } }, { parameters: JSON.parse('{"type":"object","__proto__":{}}') }]) expect(IndependentModelToolDefinition.safeParse({ ...tool, ...extra }).success).toBe(false);
  });
  it('附件只接收宿主提供的身份与有界正文，拒绝路径、URL 和坏 base64', () => {
    const a = { attachmentId: 'attachment', name: '图', kind: 'image', mime: 'image/png', base64: 'AAAA' };
    expect(IndependentModelAttachment.parse(a)).toEqual(a);
    for (const extra of [{ path: '不可传路径' }, { url: 'https://example.com/a.png' }, { base64: 'not base64' }]) expect(IndependentModelAttachment.safeParse({ ...a, ...extra }).success).toBe(false);
  });
  it('增量只包含展示文本，不接受签名、原始工具参数或密钥字段', () => {
    const delta = { type: 'text_delta', text: '片段' };
    expect(IndependentModelDelta.parse(delta)).toEqual(delta);
    for (const extra of [{ signature: '不能展示' }, { apiKey: '不能展示' }, { arguments: {} }]) expect(IndependentModelDelta.safeParse({ ...delta, ...extra }).success).toBe(false);
  });
});
