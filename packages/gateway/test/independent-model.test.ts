import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type RequestListener, type Server } from 'node:http';
import type { lookup } from 'node:dns';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { IndependentApiProtocol, IndependentModelRequest, IndependentModelDriverConfig, IndependentCapabilityValues } from '@aic/protocol';
import { openDb, type Db } from '../src/db';
import { EventStore, EventBus } from '../src/events';
import { MemorySecretStore, SecretService } from '../src/secrets';
import { IndependentCatalog } from '../src/independent/catalog';
import { IndependentApiDriver } from '../src/independent/model-driver';
import { ModelTransportError, ModelSse, postModel } from '../src/independent/model-http';
import { IndependentConversationStore } from '../src/independent/conversation';
import { IndependentTurnEngine } from '../src/independent/turn-engine';
import { seed } from './fixtures/independent-journal';
import { independentModelTools } from '../src/independent/tool-definitions';

const servers: Server[] = [], databases: Db[] = [], dirs: string[] = [];
const calls: { url: string; headers: Record<string, any>; body: any }[] = [];
const tool = { name: 'read_file', description: '读取项目文本', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } };
const chat = (extra: Record<string, any> = {}) => ({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '完成' } }], usage: { prompt_tokens: 9, completion_tokens: 2 }, ...extra });
const sse = (data: unknown, event = '') => (event ? `event: ${event}\n` : '') + 'data: ' + (typeof data === 'string' ? data : JSON.stringify(data)) + '\n\n';
const messages = (content: unknown[], stop_reason = 'end_turn') => ({ type: 'message', role: 'assistant', content, stop_reason, usage: { input_tokens: 7, output_tokens: 3 } });
const responses = (output: unknown[], status = 'completed') => ({ id: 'resp-fixture', status, output, usage: { input_tokens: 8, output_tokens: 4 } });
const fn = { type: 'function_call', id: 'fc-fixture', call_id: 'call-one', name: 'read_file', arguments: '{"path":123}', status: 'completed' };

afterEach(async () => {
  vi.restoreAllMocks(); calls.length = 0;
  for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>((r) => s.close(() => r())); }
  for (const db of databases.splice(0)) db.close();
  for (const dir of dirs.splice(0)) { const target = path.resolve(dir); if (path.dirname(target) !== path.resolve(tmpdir()) || !path.basename(target).startsWith('aic-model-')) throw Error('拒绝范围外清理'); rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
async function fixture(protocol: IndependentApiProtocol = 'chat_completions', handler?: RequestListener, capabilities: Partial<IndependentCapabilityValues> = {}) {
  const server = createServer((req, res) => { void (async () => { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    calls.push({ url: req.url!, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
    if (handler) handler(req, res); else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(chat())); }
  })().catch(() => res.destroy()); });
  servers.push(server); await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/custom/v1`;
  const directory = mkdtempSync(path.join(tmpdir(), 'aic-model-')); dirs.push(directory); const db = openDb(path.join(directory, 'state.db')); databases.push(db); seed(db);
  const catalog = new IndependentCatalog(db, new SecretService(db, new MemorySecretStore()), new EventStore(db, new EventBus()));
  const service = await catalog.createService({ name: '仅此服务', protocol, baseUrl, authentication: 'api_key', apiKey: 'fixture-model-secret', apiVersion: '2023-06-01', providerId: null, plan: null, enabled: true });
  let model = catalog.createModel(service.id, { remoteModelId: 'original/model-id', name: '不猜能力' });
  model = catalog.overrides(service.id, model.id, { expectedRevision: model.revision, values: { tools: true, streamUsage: true, ...capabilities } });
  const binding = catalog.bind('task', { serviceId: service.id, modelId: model.id });
  const request: IndependentModelRequest = { binding, systemPrompt: '项目规则', checkpoint: null, messages: [{ role: 'user', text: '执行任务', attachments: [] }], maxOutputTokens: 8192 };
  return { db, catalog, service, model, binding, request, driver: (config: IndependentModelDriverConfig = {}) => new IndependentApiDriver(catalog, config), signal: new AbortController().signal };
}

describe('独立模型三协议正式传输', () => {
  it.each(['chat_completions', 'responses', 'anthropic_messages'] as const)('%s 实际发送分开文件工具的根属性和完整必填，不使用顶层联合', async (protocol) => {
    const f = await fixture(protocol, (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(protocol === 'responses' ? responses([]) : protocol === 'anthropic_messages' ? messages([]) : chat())); });
    await f.driver({ tools: independentModelTools('separate_v2') }).complete(f.request, f.signal);
    const sent = calls[0]!.body.tools.map((entry: any) => protocol === 'chat_completions' ? entry.function
      : protocol === 'anthropic_messages' ? { name: entry.name, parameters: entry.input_schema } : entry);
    expect(sent.map((t: any) => t.name)).toEqual(['list_files', 'read_file', 'search_files', 'read_rules', 'create_file', 'replace_text', 'command']);
    for (const entry of sent) {
      expect(entry.parameters.type).toBe('object'); expect(entry.parameters.properties).toBeTruthy();
      expect(entry.parameters.oneOf).toBeUndefined(); expect(entry.parameters.anyOf).toBeUndefined();
      expect(entry.parameters.additionalProperties).toBe(false);
      expect([...entry.parameters.required].sort()).toEqual(Object.keys(entry.parameters.properties).sort());
    }
    expect(sent.find((t: any) => t.name === 'create_file').parameters.required).toEqual(['path', 'content', 'createParents']);
    expect(sent.find((t: any) => t.name === 'replace_text').parameters.required).toEqual(['path', 'expectedHash', 'oldText', 'newText']);
    expect(calls).toHaveLength(1);
  });
  it('历史版本仍导出原工具集合、原描述和完整联合分支', () => {
    const legacy = independentModelTools(); expect(legacy.map((t) => t.name)).toEqual(['list_files', 'read_file', 'search_files', 'read_rules', 'write_file', 'command']);
    const write = legacy.find((t) => t.name === 'write_file')!;
    expect(write.description).toBe('申请创建文件或唯一文本替换；用户批准后核对原内容再修改。');
    expect(write.parameters.type).toBe('object'); expect(write.parameters.properties).toBeUndefined();
    expect(write.parameters.oneOf).toHaveLength(2);
  });
  it('SSE 解析器逐字节处理 UTF-8、CR / CRLF 与多行 data，未完成帧和坏 UTF-8 不伪造事件', () => {
    const events: string[] = [], parser = new ModelSse((data) => { events.push(data); return data === '结束'; });
    const raw = Buffer.from(':注释\r\rdata: 中文\r\ndata: 第二行\r\n\r\ndata: 结束\n\n');
    for (const byte of raw) parser.push(Buffer.from([byte])); expect(events).toEqual(['中文\n第二行','结束']);
    const incomplete = new ModelSse(() => { throw Error('不能接受未封帧内容'); }); incomplete.push(Buffer.from('data: 部分')); incomplete.push(new Uint8Array(), true);
    expect(() => new ModelSse(() => false).push(Buffer.from([255]))).toThrow();
  });
  it.each(['chat_completions', 'responses', 'anthropic_messages'] as const)('%s 保留自定义路径、原模型 ID 和专属认证，不加载代理或环境凭据', async (protocol) => {
    const f = await fixture(protocol, (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(protocol === 'responses' ? responses([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '完成' }] }]) : protocol === 'anthropic_messages' ? messages([{ type: 'text', text: '完成' }]) : chat())); });
    const previous = process.env.OPENAI_API_KEY, proxy = process.env.HTTP_PROXY; process.env.OPENAI_API_KEY = '不得兜底的环境夹具'; process.env.HTTP_PROXY = 'http://127.0.0.1:1';
    try { expect(await f.driver({ tools: [tool] }).complete(f.request, f.signal)).toMatchObject({ text: '完成', stopReason: 'complete' }); }
    finally { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; if (proxy === undefined) delete process.env.HTTP_PROXY; else process.env.HTTP_PROXY = proxy; }
    expect(calls).toHaveLength(1); const sent = calls[0]!;
    expect(sent.url).toBe('/custom/v1/' + (protocol === 'chat_completions' ? 'chat/completions' : protocol === 'responses' ? 'responses' : 'messages'));
    expect(sent.body.model).toBe('original/model-id'); expect(sent.headers.cookie).toBeUndefined(); expect(sent.headers['anthropic-beta']).toBeUndefined();
    if (protocol === 'anthropic_messages') { expect(sent.headers['x-api-key']).toBe('fixture-model-secret'); expect(sent.headers['anthropic-version']).toBe('2023-06-01'); expect(sent.headers.authorization).toBeUndefined(); expect(sent.body.tools[0].input_schema.type).toBe('object'); }
    else { expect(sent.headers.authorization).toBe('Bearer fixture-model-secret'); expect(sent.headers['x-api-key']).toBeUndefined(); }
    if (protocol === 'responses') { expect(sent.body.store).toBe(false); expect(sent.body.include).toEqual(['reasoning.encrypted_content']); expect(sent.body.tools[0].strict).toBe(false); }
  });
  it('Chat 分片 UTF-8 / CRLF / 多行 data、两工具片段及流末用量正确归并，参数数字不转换', async () => {
    const deltas: string[] = []; const f = await fixture('chat_completions', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunk = (delta: unknown, finish_reason: string | null = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
      const raw = ':心跳\r\n\r\n' + sse(chunk({ role: 'assistant', content: '你好', tool_calls: [{ index: 0, id: 'call-one', type: 'function', function: { name: 'read_', arguments: '{"path":' } }] })).replaceAll('\n', '\r\n')
        + 'data: {"choices":\ndata: [{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"file","arguments":"123}"}},{"index":1,"id":"call-two","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"x\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n'
        + sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 3 } } }) + sse('[DONE]');
      for (const byte of Buffer.from(raw)) res.write(Buffer.from([byte])); res.end();
    });
    const result = await f.driver({ tools: [tool], onDelta: (_binding, d) => deltas.push(d.text) }).complete(f.request, f.signal);
    expect(deltas.join('')).toBe('你好'); expect(result).toMatchObject({ stopReason: 'tool_calls', usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 3, cacheWriteTokens: null } });
    expect(result.toolCalls.map((t) => t.arguments.path)).toEqual([123, 'x']);
  });
  it('Messages 保留有序思考签名、隐去块和严格工具参数，续传合并工具结果且拒绝理由保留', async () => {
    const content = [{ type: 'thinking', thinking: '思考摘要', signature: 'signature-fixture' }, { type: 'redacted_thinking', data: 'opaque-fixture' }, { type: 'text', text: '先读取' }, { type: 'tool_use', id: 'call-one', name: 'read_file', input: { path: 123 } }];
    const f = await fixture('anthropic_messages', (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(messages(calls.length === 1 ? content : [{ type: 'text', text: '已尊重拒绝' }], calls.length === 1 ? 'tool_use' : 'end_turn'))); });
    const driver = f.driver({ tools: [tool] }), reply = await driver.complete(f.request, f.signal);
    await driver.complete({ ...f.request, messages: [...f.request.messages, reply, { role: 'tool', callId: 'call-one', name: 'read_file', text: '用户拒绝读取', outcome: 'rejected' }] }, f.signal);
    expect(calls[1]!.body.messages[1].content).toEqual(content); expect(calls[1]!.body.messages[2]).toMatchObject({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-one', content: '用户拒绝读取', is_error: true }] });
  });
  it('Messages 流按 block 生命周期拼接签名、工具 JSON，累计 output 取最终值而非相加', async () => {
    const f = await fixture('anthropic_messages', (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const events = [{ type: 'message_start', message: { role: 'assistant', content: [], usage: { input_tokens: 7, output_tokens: 1, cache_read_input_tokens: 4 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '摘要' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } }, { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call-one', name: 'read_file', input: {} } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":123}' } }, { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 6 } }, { type: 'message_stop' }];
      res.end(events.map((e) => sse(e, e.type)).join('')); });
    const reply = await f.driver({ tools: [tool] }).complete(f.request, f.signal);
    expect(reply).toMatchObject({ stopReason: 'tool_calls', toolCalls: [{ arguments: { path: 123 } }], usage: { inputTokens: 7, outputTokens: 6, cacheReadTokens: 4 } }); expect(reply.continuation).toContain('sig');
  });
  it('Responses 仅最终完整输出授权工具，回传加密推理与原样 output item，不使用 previous_response_id', async () => {
    const output = [{ type: 'reasoning', id: 'rs-fixture', encrypted_content: 'encrypted-fixture', summary: [] }, fn];
    const f = await fixture('responses', (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(sse({ type: 'response.output_item.added', output_index: 1, item: { ...fn, arguments: '' } }, 'response.output_item.added')
      + sse({ type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"path":' }, 'response.function_call_arguments.delta')
      + sse({ type: 'response.completed', response: responses(output) }, 'response.completed')); });
    const driver = f.driver({ tools: [tool] }), reply = await driver.complete(f.request, f.signal);
    await driver.complete({ ...f.request, messages: [...f.request.messages, reply, { role: 'tool', callId: 'call-one', name: 'read_file', text: '结果', outcome: 'ok' }] }, f.signal);
    expect(reply.toolCalls[0]!.arguments.path).toBe(123); expect(calls[1]!.body.input.slice(1, 3)).toEqual(output); expect(calls[1]!.body.input[3]).toEqual({ type: 'function_call_output', call_id: 'call-one', output: '结果' }); expect(calls[1]!.body.previous_response_id).toBeUndefined();
  });
  it.each(['chat_completions','responses','anthropic_messages'] as const)('%s 缺用量为未知，真实零值仍为零', async (protocol) => {
    let absent = true; const f = await fixture(protocol, (_req, res) => { const value: any = protocol === 'chat_completions' ? chat() : protocol === 'responses' ? responses([]) : messages([]); if (absent) delete value.usage; else value.usage = protocol === 'chat_completions' ? { prompt_tokens: 0, completion_tokens: 0 } : { input_tokens: 0, output_tokens: 0 }; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); });
    const driver = f.driver(); expect((await driver.complete(f.request, f.signal)).usage.outputTokens).toBeNull(); absent = false; expect((await driver.complete(f.request, f.signal)).usage.outputTokens).toBe(0);
  });
  it.each(['chat_completions','responses','anthropic_messages'] as const)('%s 输出耗尽不执行部分工具，不冒充完成', async (protocol) => {
    const f = await fixture(protocol, (_req, res) => { const value = protocol === 'chat_completions' ? chat({ choices: [{ index: 0, finish_reason: 'length', message: { content: '部分', tool_calls: [{ function: { arguments: '{' } }] } }] })
      : protocol === 'responses' ? { ...responses([{ ...fn, arguments: '{' }], 'incomplete'), incomplete_details: { reason: 'max_output_tokens' } }
      : messages([{ type: 'tool_use', id: 'c', name: 'read_file', input: {} }], 'max_tokens'); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); });
    expect(await f.driver({ tools: [tool] }).complete(f.request, f.signal)).toMatchObject({ stopReason: 'length', toolCalls: [] });
  });
  it.each(['bad-json','no-terminal','duplicate-id','bad-args','event-error','wrong-index'])('不完整或错误流 %s 不提供可执行工具结果，且只请求一次', async (mode) => {
    const f = await fixture('chat_completions', (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const item = { id: 'same', type: 'function', function: { name: 'read_file', arguments: mode === 'bad-args' ? '{' : '{}' } };
      res.end(mode === 'bad-json' ? 'data: {\n\n' : mode === 'event-error' ? sse({ error: { message: '不得泄漏 fixture-model-secret' } }) : sse({ choices: [{ index: mode === 'wrong-index' ? 1 : 0, delta: { tool_calls: [{ ...item, index: 0 }, ...(mode === 'duplicate-id' ? [{ ...item, index: 1 }] : [])] }, finish_reason: 'tool_calls' }] }) + (mode === 'no-terminal' ? '' : sse('[DONE]'))); });
    await expect(f.driver({ tools: [tool] }).complete(f.request, f.signal)).rejects.toBeInstanceOf(ModelTransportError); expect(calls).toHaveLength(1);
  });
  it('思考档位按当前来源校验，Messages 预算与输出上限保持各自语义', async () => {
    const f = await fixture('anthropic_messages', (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(messages([]))); }, { thinking: true, thinkingCanDisable: false, effortLevels: ['low','high'], thinkingBudgetMin: 1024, thinkingBudgetMax: 4096, outputLimit: 4096 });
    const driver = f.driver();
    for (const generation of [{ effort: 'ultra' }, { thinking: { mode: 'disabled' as const } }, { thinking: { mode: 'enabled' as const, budgetTokens: 4096 } }]) await expect(driver.complete({ ...f.request, generation }, f.signal)).rejects.toBeInstanceOf(ModelTransportError);
    expect(calls).toHaveLength(0); await driver.complete({ ...f.request, generation: { effort: 'high', thinking: { mode: 'enabled', budgetTokens: 2048 } } }, f.signal);
    expect(calls[0]!.body).toMatchObject({ max_tokens: 4096, thinking: { type: 'enabled', budget_tokens: 2048 }, output_config: { effort: 'high' } });
  });
  it.each(['chat_completions','responses'] as const)('%s effort 不转换为预算或另一协议字段', async (protocol) => {
    const f = await fixture(protocol, (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(protocol === 'responses' ? responses([]) : chat())); }, { thinking: true, effortLevels: ['low','high'], outputLimit: 100 });
    await f.driver().complete({ ...f.request, generation: { effort: 'high' } }, f.signal);
    expect(calls[0]!.body).toMatchObject(protocol === 'responses' ? { reasoning: { effort: 'high' }, max_output_tokens: 100 } : { reasoning_effort: 'high', max_completion_tokens: 100 });
    expect(calls[0]!.body.thinking).toBeUndefined();
  });
  it('工具未知 / false 均不启用，关闭流有据生效，Chat token 字段显式选择', async () => {
    const f = await fixture('chat_completions', undefined, { tools: false, streaming: false });
    await expect(f.driver({ tools: [tool] }).complete(f.request, f.signal)).rejects.toBeInstanceOf(ModelTransportError);
    await expect(f.driver().complete({ ...f.request, generation: { stream: true } }, f.signal)).rejects.toBeInstanceOf(ModelTransportError);
    await f.driver().complete({ ...f.request, generation: { chatTokenLimitField: 'max_tokens' } }, f.signal);
    expect(calls).toHaveLength(1); expect(calls[0]!.body).toMatchObject({ stream: false, max_tokens: 8192 }); expect(calls[0]!.body.max_completion_tokens).toBeUndefined();
  });
  it('Chat 流用量未知时默认完整 JSON；明确选择流仍不伪造用量证据', async () => {
    const f = await fixture('chat_completions', undefined, { streamUsage: null });
    await f.driver().complete(f.request, f.signal); expect(calls[0]!.body.stream).toBe(false);
    await f.driver().complete({ ...f.request, generation: { stream: true } }, f.signal); expect(calls[1]!.body.stream).toBe(true); expect(calls[1]!.body.stream_options).toBeUndefined();
    expect(f.catalog.getModel(f.service.id, f.model.id).capabilities.find((c) => c.field === 'streamUsage')!.value).toBeNull();
  });
  it.each(['chat_completions','responses','anthropic_messages'] as const)('%s 按任务附件引用生成图片 / 文本内容，不接受路径或 URL', async (protocol) => {
    const f = await fixture(protocol, (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(protocol === 'chat_completions' ? chat() : protocol === 'responses' ? responses([]) : messages([]))); }, { imageInput: true, inputModalities: ['image/png','text'] });
    const png = Buffer.alloc(24); Buffer.from([137,80,78,71,13,10,26,10]).copy(png); png.writeUInt32BE(1,16); png.writeUInt32BE(1,20);
    const loadAttachment = vi.fn(async (taskId: string, attachmentId: string) => { expect(taskId).toBe('task'); return { attachmentId, name: '虚构附件', kind: attachmentId === 'image' ? 'image' as const : 'text' as const, mime: attachmentId === 'image' ? 'image/png' : 'text/plain', base64: (attachmentId === 'image' ? png : Buffer.from('附件正文')).toString('base64') }; });
    await f.driver({ loadAttachment }).complete({ ...f.request, messages: [{ role: 'user', text: '看附件', attachments: [{ attachmentId: 'image' }, { attachmentId: 'text' }] }] }, f.signal);
    expect(loadAttachment).toHaveBeenCalledTimes(2); const raw = JSON.stringify(calls[0]!.body); expect(raw).toContain('附件正文'); expect(raw).not.toContain('file://'); expect(raw).not.toContain('path'); expect(raw).toContain(protocol === 'anthropic_messages' ? 'media_type' : protocol === 'responses' ? 'input_image' : 'image_url');
  });
  it('图片未知时拦截，附件归属错配或坏内容不会上送', async () => {
    const f = await fixture(); const request = { ...f.request, messages: [{ role: 'user' as const, text: '', attachments: [{ attachmentId: 'image' }] }] };
    for (const attachmentId of ['image','other']) await expect(f.driver({ loadAttachment: async () => ({ attachmentId, name: '图', kind: 'image', mime: 'image/png', base64: 'AAAA' }) }).complete(request, f.signal)).rejects.toBeInstanceOf(ModelTransportError);
    expect(calls).toHaveLength(0);
  });
  it('单次附件解码总量与唯一数量有界，超限不发送模型请求', async () => {
    const f = await fixture('chat_completions', undefined, { imageInput: true });
    const bytes = Buffer.alloc(5 * 1024 * 1024); Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes); bytes.writeUInt32BE(1,16); bytes.writeUInt32BE(1,20);
    const large = vi.fn(async (_task: string, attachmentId: string) => ({ attachmentId, name: '图', kind: 'image' as const, mime: 'image/png', base64: bytes.toString('base64') }));
    await expect(f.driver({ loadAttachment: large }).complete({ ...f.request, messages: [{ role: 'user', text: '', attachments: [0,1,2,3].map((i) => ({ attachmentId: `image-${i}` })) }] }, f.signal)).rejects.toMatchObject({ reason: 'limit' });
    expect(large).toHaveBeenCalledTimes(4); expect(calls).toHaveLength(0);
    const small = vi.fn(async (_task: string, attachmentId: string) => ({ attachmentId, name: '文本', kind: 'text' as const, mime: 'text/plain', base64: 'eA==' }));
    const messages = Array.from({ length: 51 }, (_v,i) => ({ role: 'user' as const, text: '', attachments: [{ attachmentId: `text-${i}` }] }));
    await expect(f.driver({ loadAttachment: small }).complete({ ...f.request, messages }, f.signal)).rejects.toMatchObject({ reason: 'limit' }); expect(small).toHaveBeenCalledTimes(50); expect(calls).toHaveLength(0);
  });
  it('流回显密钥分片经脱敏，最终回复和工具参数含 Key 时拒绝持久化', async () => {
    const seen: string[] = []; const f = await fixture('chat_completions', (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(sse({ choices: [{ index: 0, delta: { content: 'fixture-model-' }, finish_reason: null }] }) + sse({ choices: [{ index: 0, delta: { content: 'secret' }, finish_reason: 'stop' }] }) + sse('[DONE]')); });
    await expect(f.driver({ onDelta: (_b, d) => seen.push(d.text) }).complete(f.request, f.signal)).rejects.toMatchObject({ reason: 'protocol' }); expect(seen.join('')).toBe('***');
  });
  it('真实 HTTP 401 / 429 / 重定向均不回显正文、不重试或换服务', async () => {
    for (const status of [401,429,302]) { const f = await fixture('chat_completions', (_req, res) => { res.writeHead(status, { location: 'http://127.0.0.1:1/secret' }); res.end('fixture-model-secret 附件正文'); }); const before = calls.length;
      await expect(f.driver().complete(f.request, f.signal)).rejects.toMatchObject({ status, reason: status === 401 ? 'authentication' : status === 429 ? 'quota' : 'upstream' }); expect(calls.length - before).toBe(1); }
  });
  it('取消连接确实关闭后才 settle；循环在模型资源收尾前不释放会话资格', async () => {
    let socket: import('node:net').Socket | undefined; const f = await fixture('chat_completions', (req, res) => { socket = req.socket; res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(':等待\n\n'); });
    const driver = f.driver(), store = new IndependentConversationStore(f.db), engine = new IndependentTurnEngine(store, driver, { execute: async () => { throw Error('不应执行'); } });
    const turn = store.create(f.binding, 'session', { role: 'user', text: '等待', attachments: [] }, { maxModelCalls: 2, maxToolCalls: 0, maxOutputTokens: 100, maxContextBytes: 8192, timeoutMs: 5000 }, '规则');
    let release!: () => void; const closing = new Promise<void>((r) => release = r), idle = driver.waitForIdle.bind(driver);
    const wait = vi.spyOn(driver, 'waitForIdle').mockImplementation(async (binding) => { await idle(binding); await closing; });
    const abort = new AbortController(); const running = engine.run(turn.id, abort.signal); await vi.waitFor(() => expect(socket).toBeDefined()); abort.abort();
    await vi.waitFor(() => expect(wait).toHaveBeenCalled()); expect(store.get(turn.id).status).toBe('running');
    expect(() => store.create(f.binding, 'session', { role: 'user', text: '不得并发', attachments: [] }, turn.limits)).toThrow();
    release(); expect((await running).stop).toBe('cancelled'); await vi.waitFor(() => expect(socket!.destroyed).toBe(true)); await engine.close();
  });
  it('整体超时、预先取消与同任务并发不会产生第二请求', async () => {
    const f = await fixture('chat_completions', (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(':等待\n\n'); });
    const driver = f.driver({ timeoutMs: 100 }); const pending = driver.complete(f.request, f.signal);
    await expect(driver.complete(f.request, f.signal)).rejects.toMatchObject({ reason: 'request' }); await expect(pending).rejects.toMatchObject({ reason: 'timed_out' }); expect(calls).toHaveLength(1);
    await expect(driver.complete(f.request, AbortSignal.abort())).rejects.toMatchObject({ reason: 'cancelled' }); expect(calls).toHaveLength(1);
  });
  it('配置修订、伪造绑定、旧续传与不成对历史在请求前停止', async () => {
    const f = await fixture('anthropic_messages', (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(messages([{ type: 'thinking', thinking: '摘要', signature: '签名夹具' }, { type: 'text', text: '完成' }]))); });
    const driver = f.driver(), reply = await driver.complete(f.request, f.signal);
    const before = calls.length;
    await expect(driver.complete({ ...f.request, binding: { ...f.binding, configRevision: 99 } }, f.signal)).rejects.toBeInstanceOf(ModelTransportError);
    await expect(driver.complete({ ...f.request, systemPrompt: '另一组规则', messages: [...f.request.messages, reply, { role: 'user', text: '继续', attachments: [] }] }, f.signal)).rejects.toBeInstanceOf(ModelTransportError);
    await expect(driver.complete({ ...f.request, messages: [{ role: 'tool', callId: 'missing', name: 'read_file', text: '伪造', outcome: 'ok' }] }, f.signal)).rejects.toBeInstanceOf(ModelTransportError);
    await f.catalog.patchService(f.service.id, { expectedRevision: f.service.revision, enabled: false }); await expect(driver.complete(f.request, f.signal)).rejects.toBeInstanceOf(ModelTransportError); expect(calls).toHaveLength(before);
  });
  it('模型请求同样受 fake-ip 开关约束：默认拒绝，打开后越过地址校验（ISSUE-0053）', async () => {
    const resolver = ((_host: unknown, _options: unknown, cb: Function) => cb(null, [{ address: '198.18.0.9', family: 4 }])) as typeof lookup;
    const base = { base: new URL('https://example.com/v1'), endpoint: 'responses' as const, headers: {}, body: '{}', onEvent: () => false, onJson: () => {}, lookup: resolver };
    await expect(postModel({ ...base, signal: new AbortController().signal, timeoutMs: 500 })).rejects.toMatchObject({ reason: 'network' });
    // 关闭时在地址校验处立即拒绝；打开后进入连接阶段，198.18.0.9 本机不可达，只能等到超时
    const t0 = Date.now(); await postModel({ ...base, signal: new AbortController().signal, timeoutMs: 1500 }).catch(() => {}); const offMs = Date.now() - t0;
    const t1 = Date.now(); const err = await postModel({ ...base, signal: new AbortController().signal, timeoutMs: 1500, addressPolicy: { allowFakeIpProxy: true } }).then(() => null, (e) => e as { reason?: string }); const onMs = Date.now() - t1;
    expect(offMs).toBeLessThan(500); expect(err).not.toBeNull(); expect(['timed_out', 'network']).toContain(err!.reason); expect(onMs).toBeGreaterThan(offMs);
  }, 10_000);
  it('真正的连接 DNS 检查拒绝公网 / 私网混合，正文与原始 DNS 错误不外泄', async () => {
    const resolver = ((_host: unknown, _options: unknown, cb: Function) => cb(null, [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }])) as typeof lookup;
    await expect(postModel({ base: new URL('https://example.com/v1'), endpoint: 'responses', headers: {}, body: '{}', signal: new AbortController().signal, timeoutMs: 500,
      onEvent: () => false, onJson: () => {}, lookup: resolver })).rejects.toMatchObject({ reason: 'network' });
  });
  it.each(['mime','encoding','length','frame','dangerous','deep','invalid-utf8'])('实际 HTTP 拒绝不可信响应 %s', async (mode) => {
    const f = await fixture('chat_completions', (_req, res) => {
      res.writeHead(200, { 'Content-Type': mode === 'mime' ? 'text/html' : mode === 'frame' || mode === 'invalid-utf8' ? 'text/event-stream' : 'application/json',
        ...(mode === 'encoding' ? { 'Content-Encoding': 'gzip' } : {}), ...(mode === 'length' ? { 'Content-Length': '999999999' } : {}) });
      res.end(mode === 'frame' ? 'data: ' + 'x'.repeat(1024 * 1024) : mode === 'dangerous' ? '{"__proto__":{}}' : mode === 'deep' ? '['.repeat(26)+'0'+']'.repeat(26) : mode === 'invalid-utf8' ? Buffer.from([255]) : '{}');
    });
    await expect(f.driver().complete(f.request, f.signal)).rejects.toBeInstanceOf(ModelTransportError); expect(calls).toHaveLength(1);
  });
  it('未广告的工具与缺加密推理的 Responses 工具回合拒绝执行', async () => {
    const f = await fixture('responses', (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(responses(calls.length === 1 ? [fn] : [{ type: 'reasoning', id: 'rs', summary: [] }, fn]))); });
    await expect(f.driver().complete(f.request, f.signal)).rejects.toBeInstanceOf(ModelTransportError);
    await expect(f.driver({ tools: [tool] }).complete(f.request, f.signal)).rejects.toBeInstanceOf(ModelTransportError);
  });
  it('HTTP 假模型与实际持久循环多轮连接，工具拒绝结果先保存再续传', async () => {
    const f = await fixture('chat_completions', (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(calls.length === 1
      ? chat({ choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [{ id: 'call-one', type: 'function', function: { name: 'read_file', arguments: '{"path":123}' } }] } }] }) : chat())); });
    const store = new IndependentConversationStore(f.db), driver = f.driver({ tools: [tool] });
    const toolDriver = { execute: vi.fn(async (call: any) => ({ role: 'tool' as const, callId: call.id, name: call.name, text: '用户拒绝，未执行', outcome: 'rejected' as const })) };
    const engine = new IndependentTurnEngine(store, driver, toolDriver), turn = store.create(f.binding, 'session', { role: 'user', text: '执行', attachments: [] }, { maxModelCalls: 3, maxToolCalls: 2, maxOutputTokens: 100, maxContextBytes: 8192, timeoutMs: 5000 }, '规则');
    expect(await engine.run(turn.id)).toMatchObject({ stop: 'completed', modelCalls: 2, toolCalls: 1, outputTokens: 4 }); expect(toolDriver.execute.mock.calls[0]![0].arguments.path).toBe(123);
    expect(calls[1]!.body.messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 'call-one', content: '用户拒绝，未执行' }); expect(store.entries('session')[2]!.message).toMatchObject({ outcome: 'rejected' }); await engine.close();
  });
  it.each(['no-start','open-block','bad-signature','bad-name'])('Messages 生命周期异常 %s 不返回工具授权', async (mode) => {
    const f = await fixture('anthropic_messages', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const events = [...(mode === 'no-start' ? [] : [{ type: 'message_start', message: { role: 'assistant', content: [], usage: { input_tokens: 1 } } }]),
        { type: 'content_block_start', index: 0, content_block: mode === 'bad-signature' ? { type: 'thinking', thinking: '摘要', signature: '' } : { type: 'text', text: '内容' } },
        ...(mode === 'open-block' ? [] : [{ type: 'content_block_stop', index: 0 }]), { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }, { type: 'message_stop' }];
      res.end(events.map((e) => sse(e, mode === 'bad-name' ? 'unexpected' : e.type)).join(''));
    });
    await expect(f.driver().complete(f.request, f.signal)).rejects.toBeInstanceOf(ModelTransportError);
  });
  it.each(['response.incomplete','response.failed','json-error'])('Responses %s 不得用矛盾的 completed 内容授权工具', async (type) => {
    const f = await fixture('responses', (_req, res) => { res.writeHead(200, { 'Content-Type': type === 'json-error' ? 'application/json' : 'text/event-stream' });
      res.end(type === 'json-error' ? JSON.stringify({ ...responses([fn]), error: { message: '错误夹具' } }) : sse({ type, response: responses([fn]) }, type)); });
    await expect(f.driver({ tools: [tool] }).complete(f.request, f.signal)).rejects.toMatchObject({ reason: 'protocol' });
  });
  it.each(['responses','anthropic_messages'] as const)('%s 普通长文本不被无必要的 256 KiB 续传重复限制', async (protocol) => {
    const text = 'x'.repeat(300_000), f = await fixture(protocol, (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(protocol === 'responses' ? responses([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }]) : messages([{ type: 'text', text }]))); });
    const reply = await f.driver().complete(f.request, f.signal); expect(reply.text).toBe(text); expect(reply.continuation).toBeUndefined();
  });
});

// ISSUE-0054：protocol 失败带固定细分，经真实回环 HTTP 与正式 driver；只断言分类，不带上游内容
describe('protocol 失败的固定细分', () => {
  const reasoningNoCipher = { type: 'reasoning', id: 'rs-1', summary: [] };
  const okCall = { ...fn, arguments: '{"path":"a.txt","startLine":1,"maxLines":10}' };
  it.each([
    ['unknown_item', responses([{ type: 'web_search_call', id: 'x', status: 'completed' }])],
    ['reasoning_missing', responses([reasoningNoCipher, okCall])],
    ['tool_arguments', responses([{ ...fn, arguments: '{not json' }])],
    ['status_mismatch', responses([{ ...okCall, status: 'in_progress' }])],
    ['error_payload', { ...responses([]), error: { code: 'fixture-private-code', message: 'fixture-private-text' } }],
    ['shape', { ...responses([]), output: 'fixture-private-not-a-list' }],
  ] as const)('完整响应 %s', async (detail, body) => {
    const f = await fixture('responses', (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); });
    const err = await f.driver({ tools: [tool] }).complete(f.request, f.signal).then(() => null, (e) => e as ModelTransportError);
    expect(err).toBeInstanceOf(ModelTransportError); expect(err!.reason).toBe('protocol'); expect(err!.detail).toBe(detail);
    expect(JSON.stringify(err) + String(err)).not.toContain('fixture-private');
  });
  it.each([
    ['status_mismatch', sse({ type: 'response.completed', response: responses([], 'failed') }, 'response.completed')],
    ['event_order', sse({ type: 'response.output_text.delta', delta: 'x' }, 'response.completed')],
    ['error_payload', sse({ type: 'error', message: 'fixture-private' }, 'error')],
    ['no_result', sse({ type: 'response.output_text.delta', delta: '半截' }, 'response.output_text.delta')],
    ['invalid_json', 'data: {broken\n\n'],
  ] as const)('流式 %s', async (detail, stream) => {
    const f = await fixture('responses', (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(stream); });
    const err = await f.driver({ tools: [tool] }).complete(f.request, f.signal).then(() => null, (e) => e as ModelTransportError);
    expect(err?.reason).toBe('protocol'); expect(err?.detail).toBe(detail);
  });
  it('细分写进请求账本结算；非 protocol 失败不带细分', async () => {
    const settled: unknown[] = [];
    const accounting = { reserve: () => 'r1', settle: (_id: string, s: unknown) => { settled.push(s); } };
    const f = await fixture('responses', (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(responses([reasoningNoCipher, okCall]))); });
    await f.driver({ tools: [tool], accounting } as never).complete(f.request, f.signal).catch(() => {});
    expect(settled.at(-1)).toEqual({ outcome: 'failed', failure: 'protocol', usage: null, countedInputTokens: null, protocolDetail: 'reasoning_missing' });
    const g = await fixture('responses', (_req, res) => { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{}'); });
    await g.driver({ tools: [tool], accounting } as never).complete(g.request, g.signal).catch(() => {});
    expect(settled.at(-1)).toEqual({ outcome: 'failed', failure: 'upstream', usage: null, countedInputTokens: null });
  });
});
