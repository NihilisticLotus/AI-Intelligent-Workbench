import { afterEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFakeAdapter } from '../src/fake';
import { quotaHint, textResponseError, TEXT_ERROR_PATTERNS } from '../src/acp/errors';
import { fakeAdapter, RecordingHost, scenario } from './helpers';
import { parseConfigState, configSignature } from '../src/acp/config';
import { createSpecAdapter } from '../src/generic';
import { FIXTURE } from './helpers';
const close: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const f of close.splice(0).reverse()) await f(); });
async function open(sc: Record<string, unknown>, kind: 'claude' | 'codex' = 'claude') {
  const s = scenario(kind === 'codex' ? { config: { models: [{ value: 'alpha', name: 'Alpha' }] }, ...sc } : sc); close.push(() => s.cleanup()); const host = new RecordingHost();
  const adapter = kind === 'codex' ? createSpecAdapter({ kind, displayName: '假 Codex', entry: FIXTURE, env: s.env }, { log: () => {} }) : fakeAdapter(s);
  const c = await adapter.spawn({ cwd: s.dir, model: null, effort: null, permission: 'ask', host });
  close.push(() => c.close()); c.ready?.(); return { s, c, host };
}
describe('1.3 适配器', () => {
  const proxyError = "CC Switch local proxy failed while handling Codex endpoint /responses. Provider: OpenAI Official; model: alpha; upstream_status: HTTP 400; cause: The 'alpha' model is not supported when using Codex with a ChatGPT account.";
  it('代理封套只识别完整且一致的模型不支持错误', () => {
    expect(textResponseError(proxyError, 'codex', 'Codex')).toMatchObject({ reason: 'invalid_value' });
    for (const reply of ['说明：' + proxyError, proxyError + ' 这是示例。', proxyError.replace("The 'alpha'", "The 'beta'"), proxyError.replace('HTTP 400', 'HTTP 401'), proxyError.replace('HTTP 400', 'HTTP 429'), proxyError + 'x'.repeat(600)]) expect(textResponseError(reply, 'codex', 'Codex')).toBeNull();
    expect(textResponseError(proxyError, 'claude', 'Claude')).toBeNull();
  });
  it('Codex 自动压缩后的分片代理错误仍失败并保留消息原文', async () => {
    const { c, host } = await open({ turns: [{ steps: [
      { update: { sessionUpdate: 'tool_call', toolCallId: 'compact', kind: 'think', title: 'Compact conversation' } },
      { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: proxyError.slice(0, 80) } } },
      { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: proxyError.slice(80) + '\n\n' } } },
    ] }] }, 'codex');
    await expect(c.prompt({ text: '只回复 OK' }, new AbortController().signal)).rejects.toMatchObject({ reason: 'invalid_value', body: { code: 'agent.failed' } });
    expect(host.of('message').map(m => m.text).join('')).toBe(proxyError + '\n\n');
    expect(host.requests).toHaveLength(0);
  });
  it.each(['execute', 'changed-kind', 'changed-title', 'changed-target', 'other-thinking', 'wrong-model', 'generic-error', 'normal-reply', 'multiple-messages'])('代理检测不扩大到 %s', async (mode) => {
    const update = (u: Record<string, unknown>) => ({ update: u });
    const tool = { sessionUpdate: 'tool_call', toolCallId: 'compact', kind: mode === 'execute' ? 'execute' : 'think', title: mode === 'other-thinking' ? '其他思考' : 'Compact conversation' };
    const steps: Record<string, unknown>[] = [update(tool)];
    if (mode.startsWith('changed-')) steps.push(update({ sessionUpdate: 'tool_call_update', toolCallId: 'compact', ...(mode === 'changed-kind' ? { kind: 'execute' } : mode === 'changed-title' ? { title: '运行命令' } : { locations: [{ path: '/project/file' }] }) }));
    const reply = mode === 'wrong-model' ? proxyError.replaceAll('alpha', 'beta') : mode === 'generic-error' ? "The 'alpha' model is not supported" : mode === 'normal-reply' ? '说明：' + proxyError : proxyError;
    steps.push(update({ sessionUpdate: 'agent_message_chunk', messageId: 'one', content: { type: 'text', text: reply } }));
    if (mode === 'multiple-messages') steps.push(update({ sessionUpdate: 'agent_message_chunk', messageId: 'two', content: { type: 'text', text: '另一段说明' } }));
    const { c } = await open({ turns: [{ steps }] }, 'codex');
    await expect(c.prompt({ text: '合成反例' }, new AbortController().signal)).resolves.toEqual({ stopReason: 'end_turn' });
  });
  it('只采用明确的模型图片元数据，兼容配置项和旧模型列表', () => {
    const availableModels = [{ modelId: 'a', _meta: { supportsImages: true } }, { modelId: 'b', _meta: { supportsImages: false } }, { modelId: 'deepseek' }];
    const legacy = parseConfigState({ models: { availableModels } });
    expect(legacy.models.map((m) => m.vision)).toEqual([true,false,undefined]);
    const configOptions = [{ id: 'model', category: 'model', type: 'select', options: availableModels.map((m) => ({ value: m.modelId })) }];
    const unknown = parseConfigState({ configOptions });
    const enriched = parseConfigState({ configOptions, models: { availableModels } });
    expect(enriched.models.map((m) => m.vision)).toEqual([true,false,undefined]);
    expect(parseConfigState({configOptions},enriched).models.map((m)=>m.vision)).toEqual([true,false,undefined]);
    expect(configSignature(enriched)).not.toBe(configSignature(unknown));
    expect(parseConfigState({ configOptions: [{ ...configOptions[0], options: [{ value: 'a', _meta: { supportsImages: false } }] }] }).models[0]?.vision).toBe(false);
  });
  it('额度原文不误当时间，并识别明确时间', () => {
    expect(quotaHint('API Error: Request rejected (429) · upstream account quota usage limit has been reached; wait for quota to reset or use an account with available quota')).toBe('额度或调用频率达到上限，可以稍后再试，或换个模型 / 账号');
    for (const t of ['resets at 2026-11-09T12:00:00Z', 'retry in 3 minutes', 'try again at 14:30 UTC', 'retry 2 h', 'reset after Monday']) expect(quotaHint(t)).toContain(t.replace(/^(?:resets?|retry|try again)\s+(?:at\s+)?/, ''));
  });
  it.each(["The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account", 'upstream_status: HTTP 400 bad request', 'API Error: Request rejected (429) quota'])('短错误正文被识别 %s', (s) => {
    expect(TEXT_ERROR_PATTERNS.some((p) => p.test(s))).toBe(true);
    expect(textResponseError(s, 'codex', 'Codex')).not.toBe(null);
    expect(textResponseError('说明：' + s, 'codex', 'Codex')).toBe(null);
    expect(textResponseError(s + 'x'.repeat(600), 'codex', 'Codex')).toBe(null);
  });
  it('工具更新只发送变化字段，正文错误使回合失败', async () => {
    const { c, host } = await open({ turns: [{ steps: [
      { update: { sessionUpdate: 'tool_call', toolCallId: 't', title: 'Preparing file…', kind: 'edit' } },
      { update: { sessionUpdate: 'tool_call_update', toolCallId: 't', title: '写入 hello.txt' } },
      { update: { sessionUpdate: 'tool_call_update', toolCallId: 't', title: '写入 hello.txt' } },
    ] }, { steps: [{ update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: "The 'x' model is not supported" } } }] }] });
    await c.prompt({ text: 'x' }, new AbortController().signal);
    expect(host.of('tool_update')).toHaveLength(1);
    expect(host.of('tool_update')[0]).toMatchObject({ title: '写入 hello.txt' });
    await expect(c.prompt({ text: 'x' }, new AbortController().signal)).rejects.toMatchObject({ body: { code: 'agent.failed' } });
  });
  it('ACP 内容数组：文字、图片 base64、资源链接和小文本资源', async () => {
    const { s, c } = await open({ promptCapabilities: { image: true, embeddedContext: true } });
    const path = join(s.dir, 'content'); writeFileSync(path, Buffer.from('hello'));
    const a = { path, uri: pathToFileURL(path).href, name: '附件', width: null, height: null };
    await c.prompt({ text: '看附件', attachments: [{ ...a, kind: 'image', mime: 'image/png' }, { ...a, kind: 'file', mime: 'application/octet-stream' }, { ...a, kind: 'file', mime: 'text/plain' }] }, new AbortController().signal);
    const content = s.log().find((x) => x.method === 'session/prompt')!.params.prompt;
    expect(content.map((x: { type: string }) => x.type)).toEqual(['text', 'image', 'resource_link', 'resource']);
    expect(content[1].data).toBe(Buffer.from('hello').toString('base64'));
    expect(content[3].resource.text).toBe('hello');
  });
  it('未声明图片能力在发请求前拒绝', async () => {
    const { s, c } = await open({ promptCapabilities: { image: false } });
    await expect(c.prompt({ text: '', attachments: [{ kind: 'image', mime: 'image/png', name: '图', path: join(s.dir, 'missing'), uri: 'file:///image', width: 1, height: 1 }] }, new AbortController().signal)).rejects.toMatchObject({ body: { code: 'attachment.unsupported' } });
    expect(s.log().some((x) => x.method === 'session/prompt')).toBe(false);
  });
  it('演示 Agent 回复图片信息', async () => {
    const host = new RecordingHost(); const c = await createFakeAdapter({ speed: 0 }).spawn({ cwd: '.', model: null, effort: null, permission: 'readonly', host });
    await c.prompt({ text: '', attachments: [{ kind: 'image', mime: 'image/png', name: '图.png', path: '', uri: '', width: 12, height: 34 }] }, new AbortController().signal);
    expect(host.of('message').map((m) => m.text).join('')).toBe('收到 1 张图片：图.png、12 × 34');
  });
});
