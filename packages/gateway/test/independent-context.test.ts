import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type RequestListener } from 'node:http';
import { type IndependentApiProtocol, type IndependentCapabilityValues, type IndependentContextReport, type IndependentModel, type IndependentModelDriverConfig, type IndependentModelRequest } from '@aic/protocol';
import { openDb, type Db } from '../src/db';
import { EventBus, EventStore } from '../src/events';
import { MemorySecretStore, SecretService } from '../src/secrets';
import { IndependentCatalog } from '../src/independent/catalog';
import { IndependentApiDriver } from '../src/independent/model-driver';
import { contextInput, contextReport } from '../src/independent/context';
import { modelBody } from '../src/independent/model-http';
import { IndependentConversationStore } from '../src/independent/conversation';
import { IndependentTurnEngine } from '../src/independent/turn-engine';
import { seed } from './fixtures/independent-journal';
import { limits, user } from './fixtures/independent-conversation';

const servers: Server[] = [], databases: Db[] = [];
const seen: { url: string; headers: Record<string, any>; body: any }[] = [];
const protocols = ['chat_completions', 'responses', 'anthropic_messages'] as const;
const countPath = (protocol: IndependentApiProtocol) => protocol === 'responses' ? 'responses/input_tokens' : 'messages/count_tokens';
const generationReply = (protocol: IndependentApiProtocol) => protocol === 'responses' ? { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '完成' }] }], usage: { input_tokens: 10, output_tokens: 1 } }
  : protocol === 'anthropic_messages' ? { type: 'message', role: 'assistant', content: [{ type: 'text', text: '完成' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 1 } }
    : { choices: [{ index: 0, message: { role: 'assistant', content: '完成' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1 } };
async function fixture(protocol: IndependentApiProtocol, caps: Partial<IndependentCapabilityValues> = {}, handler?: RequestListener) {
  const server = createServer((req, res) => { void (async () => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    seen.push({ url: req.url!, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
    if (handler) return handler(req, res);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url!.endsWith(countPath(protocol)) ? { ...(protocol === 'responses' ? { object: 'response.input_tokens' } : {}), input_tokens: 20 } : generationReply(protocol)));
  })().catch(() => res.destroy()); }); servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const db = openDb(':memory:'); databases.push(db); seed(db);
  const catalog = new IndependentCatalog(db, new SecretService(db, new MemorySecretStore()), new EventStore(db, new EventBus()));
  const service = await catalog.createService({ name: '仅回环计数夹具', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/custom/v1`,
    protocol, apiVersion: '2023-06-01', authentication: 'api_key', apiKey: 'fixture-counter-secret', providerId: null, plan: null, enabled: true });
  let model = catalog.createModel(service.id, { name: '不猜 tokenizer', remoteModelId: 'original/fixture' });
  model = catalog.overrides(service.id, model.id, { expectedRevision: model.revision, values: { inputLimit: 100_000, contextWindow: 200_000, outputLimit: 500, tools: true, imageInput: true, ...caps } });
  const binding = catalog.bind('task', { serviceId: service.id, modelId: model.id });
  const request: IndependentModelRequest = { binding, systemPrompt: '中文项目规则', checkpoint: null, messages: [{ role: 'user', text: '执行', attachments: [] }], maxOutputTokens: 1000 };
  const reports: IndependentContextReport[] = [];
  return { catalog, service, model, binding, request, reports, db, signal: new AbortController().signal,
    driver: (config: IndependentModelDriverConfig = {}) => new IndependentApiDriver(catalog, { context: { mode: 'local', safetyTokens: 10 }, onContext: (_binding, report) => reports.push(report), ...config }) };
}
const body = (protocol: IndependentApiProtocol, text = '中文🚀') => ({ model: 'fixture',
  [protocol === 'responses' ? 'input' : 'messages']: [{ role: 'user', content: [{ type: protocol === 'responses' ? 'input_text' : 'text', text }] }],
  ...(protocol === 'responses' ? { instructions: '规则', max_output_tokens: 100 } : { system: '规则', max_tokens: 100 }), stream: false });
afterEach(async () => { vi.restoreAllMocks(); seen.length = 0; for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } for (const db of databases.splice(0)) db.close(); });

describe('发送前的上下文检查', () => {
  it.each(protocols)('%s 本地估算完整输入包装，输出只计入总窗口预留，不发额外请求', async (protocol) => {
    const f = await fixture(protocol); expect((await f.driver().complete(f.request, f.signal)).text).toBe('完成');
    expect(seen).toHaveLength(1); expect(f.reports[0]).toMatchObject({ method: 'local_bytes', outputTokens: 500, safetyTokens: 10, counterRequests: 0, status: 'ready' });
    expect(f.reports[0]!.estimatedInputTokens).toBe(Buffer.byteLength(JSON.stringify(contextInput(protocol, seen[0]!.body))));
  });
  it('输入限制与总窗口分别检查，边界相等允许，输出按实际发送上限预留', async () => {
    const f = await fixture('responses'), b = body('responses'), base = contextReport('responses', b, f.model, { mode: 'local', safetyTokens: 10 });
    const estimated = base.estimatedInputTokens!;
    const model = (input: number | null, window: number | null) => ({ ...f.model, capabilities: f.model.capabilities.map((c) => c.field === 'inputLimit' ? { ...c, value: input } : c.field === 'contextWindow' ? { ...c, value: window } : c) }) as IndependentModel;
    expect(contextReport('responses', b, model(estimated + 10, estimated + 110), { mode: 'local', safetyTokens: 10 }).status).toBe('ready');
    expect(contextReport('responses', b, model(estimated + 9, null), { mode: 'local', safetyTokens: 10 }).status).toBe('input_exceeded');
    expect(contextReport('responses', b, model(null, estimated + 109), { mode: 'local', safetyTokens: 10 }).status).toBe('window_exceeded');
  });
  it.each(['local','endpoint'] as const)('%s 模型窗口 / 输入与本地限额均未知时不传正文到计数或生成接口', async (mode) => {
    const f = await fixture('responses', { inputLimit: null, contextWindow: null });
    await expect(f.driver({ context: { mode } }).complete(f.request, f.signal)).rejects.toMatchObject({ reason: 'context' });
    expect(seen).toHaveLength(0); expect(f.reports[0]).toMatchObject({ status: 'limits_unknown', modelInputLimit: null, contextWindow: null, counterRequests: 0 });
  });
  it('冲突能力不用作窗口；过期能力按原值使用（ISSUE-0059）；明确的本地上限不写回模型规格', async () => {
    const f = await fixture('responses');
    const conflicted = { ...f.model, capabilities: f.model.capabilities.map((c) => ({ ...c, conflict: c.field === 'inputLimit' || c.field === 'contextWindow' })) };
    expect(contextReport('responses', body('responses'), conflicted, { mode: 'local' }).status).toBe('limits_unknown');
    expect(contextReport('responses', body('responses'), conflicted, { mode: 'local', localInputLimit: 10_000 })).toMatchObject({ status: 'ready', modelInputLimit: null, contextWindow: null, localInputLimit: 10_000 });
    // 2026-11-11 前的规则是过期即不用；按用户决定改为继续使用并在界面提示复核
    const stale = { ...f.model, capabilities: f.model.capabilities.map((c) => ({ ...c, stale: c.field === 'inputLimit', conflict: c.field === 'contextWindow' })) };
    expect(contextReport('responses', body('responses'), stale, { mode: 'local' })).toMatchObject({ status: 'ready', modelInputLimit: 100_000, contextWindow: null });
  });
  it.each(protocols)('%s 图片按出现次数算，未知成本停止，编码长度不伪装为图像 token', async (protocol) => {
    const f = await fixture(protocol), b: any = body(protocol), content = b[protocol === 'responses' ? 'input' : 'messages'][0].content;
    const image = protocol === 'responses' ? { type: 'input_image', image_url: 'data:image/png;base64,' + 'A'.repeat(10000) }
      : protocol === 'chat_completions' ? { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(10000) } }
        : { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(10000) } };
    content.push(image, structuredClone(image)); const before = JSON.stringify(b);
    expect(contextReport(protocol, b, f.model, { mode: 'local' })).toMatchObject({ imageCount: 2, estimatedInputTokens: null, status: 'input_unknown' });
    const report = contextReport(protocol, b, f.model, { mode: 'local', imageTokensPerImage: 2000, safetyTokens: 0 });
    expect(report.estimatedInputTokens).toBeGreaterThan(4000); expect(report.estimatedInputTokens).toBeLessThan(5000); expect(report.imageTokensPerImage).toBe(2000); expect(JSON.stringify(b)).toBe(before);
  });
  it('规则、工具 schema、文本附件包装和原始推理续传计入输入', async () => {
    const f = await fixture('responses'), b: any = body('responses'), options = { mode: 'local' as const, safetyTokens: 0 };
    const baseline = contextReport('responses', b, f.model, options).estimatedInputTokens!;
    b.tools = [{ type: 'function', name: 'test', description: '很长的工具说明'.repeat(100), parameters: { type: 'object', properties: { type: { const: 'input_image' }, image_url: { const: '不能删除 schema 原文' } } } }];
    b.input.push({ type: 'reasoning', encrypted_content: '原始加密续传'.repeat(100) });
    b.input[0].content.push({ type: 'input_text', text: '附件包装\n<attachment>\n附件原文\n</attachment>' });
    expect(contextReport('responses', b, f.model, options).estimatedInputTokens! - baseline).toBeGreaterThan(3000);
  });
  it.each(['responses','anthropic_messages'] as const)('%s 显式计数只走固定服务，先完整计数再生成，保留原协议参数', async (protocol) => {
    const f = await fixture(protocol); expect((await f.driver({ context: { mode: 'endpoint', safetyTokens: 10 } }).complete({ ...f.request, tools: [{ name: 'read', description: '读取', parameters: { type: 'object' } }] }, f.signal)).text).toBe('完成');
    expect(seen.map((s) => s.url)).toEqual([`/custom/v1/${countPath(protocol)}`, `/custom/v1/${protocol === 'responses' ? 'responses' : 'messages'}`]);
    const counted = seen[0]!, generated = seen[1]!;
    expect(counted.body).toEqual(contextInput(protocol, generated.body)); expect(counted.body.stream).toBeUndefined(); expect(counted.body.max_tokens).toBeUndefined();
    expect(counted.body.max_output_tokens).toBeUndefined(); expect(counted.body.model).toBe('original/fixture'); expect(counted.body.tools).toHaveLength(1);
    expect(counted.headers[protocol === 'responses' ? 'authorization' : 'x-api-key']).toBe(protocol === 'responses' ? 'Bearer fixture-counter-secret' : 'fixture-counter-secret');
    expect(counted.headers.cookie).toBeUndefined(); expect(counted.headers['anthropic-beta']).toBeUndefined();
    expect(f.reports[0]).toMatchObject({ estimatedInputTokens: 20, imageTokensPerImage: null, method: 'endpoint', counterRequests: 1, status: 'ready' });
    expect(JSON.stringify(f.reports)).not.toContain('fixture-counter-secret'); expect(JSON.stringify(f.reports)).not.toContain('中文项目规则');
  });
  it('Chat 不擅自改用 Responses 计数，不存在的计数接口不回退', async () => {
    const f = await fixture('chat_completions'); await expect(f.driver({ context: { mode: 'endpoint' } }).complete(f.request, f.signal)).rejects.toMatchObject({ reason: 'request' }); expect(seen).toHaveLength(0);
  });
  it.each([{}, { input_tokens: -1 }, { input_tokens: 1.5 }, { input_tokens: '20' }, { input_tokens: 1e13 }, { input_tokens: 20, object: 'wrong' }])('计数坏内容 %j 不发生成请求', async (reply) => {
    const f = await fixture('responses', {}, (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(reply)); });
    await expect(f.driver({ context: { mode: 'endpoint' } }).complete(f.request, f.signal)).rejects.toMatchObject({ reason: 'protocol' }); expect(seen).toHaveLength(1); expect(f.reports).toHaveLength(0);
  });
  it('真实零计数保留，超输入 / 总窗口时只计数不生成', async () => {
    for (const value of [0, 500_000]) {
      const f = await fixture('responses', {}, (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(seen.at(-1)!.url.endsWith('input_tokens') ? { object: 'response.input_tokens', input_tokens: value } : generationReply('responses'))); });
      if (value === 0) expect((await f.driver({ context: { mode: 'endpoint' } }).complete(f.request, f.signal)).text).toBe('完成');
      else await expect(f.driver({ context: { mode: 'endpoint' } }).complete(f.request, f.signal)).rejects.toMatchObject({ reason: 'context' });
      expect(f.reports[0]!.estimatedInputTokens).toBe(value); expect(f.reports[0]!.status).toBe(value ? 'input_exceeded' : 'ready'); seen.length = 0;
    }
  });
  it.each([302,401,429,500])('计数 HTTP %i 不重试、不跟随和不生成，原始错误正文不外露', async (status) => {
    const f = await fixture('responses', {}, (_req, res) => { res.writeHead(status, { Location: '/other-billing-service' }); res.end('不能泄露的错误正文'); });
    const error = await f.driver({ context: { mode: 'endpoint' } }).complete(f.request, f.signal).catch((e) => e); expect(error.message).not.toContain('不能泄露'); expect(error.status).toBe(status); expect(seen).toHaveLength(1);
  });
  it('计数后配置修订停止，不把旧计数用于新模型', async () => {
    const f = await fixture('responses'), driver = f.driver({ context: { mode: 'endpoint' }, onContext: () => { f.catalog.overrides(f.service.id, f.model.id, { expectedRevision: f.model.revision, values: { inputLimit: 50_000 } }); } });
    await expect(driver.complete(f.request, f.signal)).rejects.toMatchObject({ reason: 'request' }); expect(seen).toHaveLength(1);
  });
  it('报告持久化失败或试图修改报告不能放行超量输入', async () => {
    const f = await fixture('responses', { inputLimit: 1 });
    await expect(f.driver({ onContext: (_binding, report) => { report.status = 'ready'; } }).complete(f.request, f.signal)).rejects.toMatchObject({ reason: 'context' });
    await expect(f.driver({ onContext: () => { throw Error('持久化故障'); } }).complete(f.request, f.signal)).rejects.toMatchObject({ reason: 'protocol' }); expect(seen).toHaveLength(0);
  });
  it('计数期间取消等待实际连接关闭，不生成和不残留调用资格', async () => {
    const f = await fixture('responses', {}, () => {}), driver = f.driver({ context: { mode: 'endpoint' } }), abort = new AbortController();
    const request = driver.complete(f.request, abort.signal); const rejected = expect(request).rejects.toMatchObject({ reason: 'cancelled' });
    await vi.waitFor(() => expect(seen).toHaveLength(1)); abort.abort(); await rejected; await driver.waitForIdle(f.binding); expect(seen).toHaveLength(1);
    expect(await new Promise<number>((resolve, reject) => servers.at(-1)!.getConnections((error, count) => error ? reject(error) : resolve(count)))).toBe(0);
  });
  it('计数与生成共享连接总时限，计数后剩余时限不重新满额', async () => {
    const f = await fixture('responses', {}, (req, res) => { setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(req.url!.endsWith('input_tokens') ? { object: 'response.input_tokens', input_tokens: 20 } : generationReply('responses'))); }, 120); });
    await expect(f.driver({ context: { mode: 'endpoint' }, timeoutMs: 200 }).complete(f.request, f.signal)).rejects.toMatchObject({ reason: 'timed_out' }); expect(seen).toHaveLength(2);
  });
  it('上下文拒绝保留 context_limit 停止原因，不调工具或反复请求', async () => {
    const f = await fixture('responses', { inputLimit: 1 }), store = new IndependentConversationStore(f.db), engine = new IndependentTurnEngine(store, f.driver(), { execute: async () => { throw Error('不应调用工具'); } });
    try { const turn = store.create(f.binding, 'session', user, limits); expect(await engine.run(turn.id)).toMatchObject({ status: 'failed', stop: 'context_limit', modelCalls: 1, toolCalls: 0 }); expect(seen).toHaveLength(0); }
    finally { await engine.close(); }
  });
  it('有界 JSON 与普通编码一致，重复大内容在继续编码前停止', () => {
    const value = { text: '中文🚀\n"\\', missing: undefined, values: [null, 1, true, { nested: '内容' }] };
    expect(modelBody(value)).toBe(JSON.stringify(value)); expect(() => modelBody(value, Buffer.byteLength(JSON.stringify(value)) - 1)).toThrow();
    let reads = 0; const repeated = Array.from({ length: 100 }, () => ({ get data() { reads++; return 'a'.repeat(1024); } }));
    expect(() => modelBody(repeated, 4096)).toThrow(); expect(reads).toBeLessThan(6);
  });
  it.each(['responses','anthropic_messages'] as const)('%s 图片和文本附件原样参与接口计数，估算报告不含附件内容', async (protocol) => {
    const f = await fixture(protocol), bytes = Buffer.alloc(24); Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes); bytes.writeUInt32BE(1,16); bytes.writeUInt32BE(1,20);
    const request = { ...f.request, checkpoint: { id: 'checkpoint', sessionId: 'session', throughSeq: 1, sourceHash: 'a'.repeat(64), summary: '历史压缩摘要夹具', createdAt: 1 },
      messages: [{ role: 'user' as const, text: '看附件', attachments: [{ attachmentId: 'image' }, { attachmentId: 'text' }] }] };
    const driver = f.driver({ context: { mode: 'endpoint' }, loadAttachment: async (_task, id) => ({ attachmentId: id, name: '上传夹具',
      kind: id === 'image' ? 'image' : 'text', mime: id === 'image' ? 'image/png' : 'text/plain', base64: (id === 'image' ? bytes : Buffer.from('不能进入报告的文本附件')).toString('base64') }) });
    expect((await driver.complete(request, f.signal)).text).toBe('完成');
    expect(JSON.stringify(seen[0]!.body)).toContain(bytes.toString('base64')); expect(JSON.stringify(seen[0]!.body)).toContain('不能进入报告的文本附件'); expect(JSON.stringify(seen[0]!.body)).toContain('历史压缩摘要夹具');
    expect(f.reports[0]).toMatchObject({ imageCount: 1, estimatedInputTokens: 20, imageTokensPerImage: null, method: 'endpoint' });
    expect(JSON.stringify(f.reports)).not.toContain(bytes.toString('base64')); expect(JSON.stringify(f.reports)).not.toContain('不能进入报告');
  });
  it.each(['responses','anthropic_messages'] as const)('%s 计数不丢推理续传与拒绝理由，每轮重新计算后才生成', async (protocol) => {
    let generated = 0;
    const first = protocol === 'responses' ? { status: 'completed', output: [{ type: 'reasoning', id: 'rs-fixture', summary: [], encrypted_content: '私有续传夹具' }, { type: 'function_call', call_id: 'call-one', name: 'read', arguments: '{}' }], usage: { input_tokens: 10, output_tokens: 1 } }
      : { type: 'message', role: 'assistant', content: [{ type: 'thinking', thinking: '思考夹具', signature: '私有续传夹具' }, { type: 'tool_use', id: 'call-one', name: 'read', input: {} }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 1 } };
    const f = await fixture(protocol, {}, (req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(req.url!.endsWith(countPath(protocol))
      ? { ...(protocol === 'responses' ? { object: 'response.input_tokens' } : {}), input_tokens: 20 } : ++generated === 1 ? first : generationReply(protocol))); });
    const store = new IndependentConversationStore(f.db), driver = f.driver({ context: { mode: 'endpoint', safetyTokens: 0 }, tools: [{ name: 'read', description: '读取', parameters: { type: 'object' } }] });
    const engine = new IndependentTurnEngine(store, driver, { execute: async (call) => ({ role: 'tool', callId: call.id, name: call.name, text: '用户拒绝本次读取', outcome: 'rejected' }) });
    try {
      const turn = store.create(f.binding, 'session', user, limits, '项目规则'); expect(await engine.run(turn.id)).toMatchObject({ status: 'completed', modelCalls: 2, toolCalls: 1, outputTokens: 2 });
      expect(seen).toHaveLength(4); expect(JSON.stringify(seen[2]!.body)).toContain('私有续传夹具'); expect(JSON.stringify(seen[2]!.body)).toContain('用户拒绝本次读取');
      expect(f.reports).toHaveLength(2); expect(f.reports[1]!.requestHash).not.toBe(f.reports[0]!.requestHash); expect(JSON.stringify(f.reports)).not.toContain('私有续传夹具');
    } finally { await engine.close(); }
  });
  it('最终请求体超限在计数前停止，重复大附件引用不先拼出无限 JSON', async () => {
    const f = await fixture('responses'), bytes = Buffer.alloc(5 * 1024 * 1024); Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes); bytes.writeUInt32BE(1,16); bytes.writeUInt32BE(1,20);
    const driver = f.driver({ context: { mode: 'endpoint' }, loadAttachment: async (_task, attachmentId) => ({ attachmentId, name: '大图头夹具', kind: 'image', mime: 'image/png', base64: bytes.toString('base64') }) });
    await expect(driver.complete({ ...f.request, messages: Array.from({ length: 100 }, () => ({ role: 'user' as const, text: '', attachments: [{ attachmentId: 'image' }] })) }, f.signal)).rejects.toMatchObject({ reason: 'limit' });
    expect(seen).toHaveLength(0); expect(f.reports).toHaveLength(0);
  });
  it('报告指纹绑定最终输出预留与完整请求，不把同输入的旧决定复用于新上限', async () => {
    const f = await fixture('responses'), b = body('responses'), options = { mode: 'local' as const, safetyTokens: 0 };
    const before = contextReport('responses', b, f.model, options), after = contextReport('responses', { ...b, max_output_tokens: 200 }, f.model, options);
    expect(after.estimatedInputTokens).toBe(before.estimatedInputTokens); expect(after.requestHash).not.toBe(before.requestHash); expect(after.outputTokens).toBe(200);
  });
});
