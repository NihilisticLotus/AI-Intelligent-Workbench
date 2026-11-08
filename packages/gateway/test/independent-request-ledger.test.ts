import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer, type Server, type RequestListener } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { IndependentApiProtocol, IndependentModelDriverConfig, IndependentModelRequest, IndependentRequestBudget } from '@aic/protocol';
import { openDb, type Db } from '../src/db';
import { EventStore, EventBus } from '../src/events';
import { MemorySecretStore, SecretService } from '../src/secrets';
import { IndependentCatalog } from '../src/independent/catalog';
import { IndependentApiDriver } from '../src/independent/model-driver';
import { IndependentRequestLedger } from '../src/independent/request-ledger';
import { IndependentConversationStore } from '../src/independent/conversation';
import { IndependentTurnEngine } from '../src/independent/turn-engine';
import { independentCommandEnv } from '../src/independent/commands';
import { seed } from './fixtures/independent-journal';
import { binding, usage, limits, user } from './fixtures/independent-conversation';

const databases: Db[] = [], dirs: string[] = [], servers: Server[] = [], helpers: ChildProcess[] = [];
const seen: { url: string; body: string }[] = [];
const policy: IndependentRequestBudget = { maxRequests: 3, money: { currency: 'CNY', maxReservedMicros: 25, modelCeilingMicros: 10, counterCeilingMicros: 5 } };
const attempt = { kind: 'model' as const, requestHash: 'a'.repeat(64) };
const failed = { outcome: 'failed' as const, failure: 'network' as const, usage: null, countedInputTokens: null };
const success = { outcome: 'succeeded' as const, failure: null, usage, countedInputTokens: null };
const temporary = () => { const dir = mkdtempSync(path.join(tmpdir(), 'aic-request-ledger-')); dirs.push(dir); return dir; };
function setup(file = ':memory:') {
  const db = openDb(file); databases.push(db); seed(db); const ledger = new IndependentRequestLedger(db); ledger.create(binding, policy);
  return { db, ledger };
}
const reply = (protocol: IndependentApiProtocol) => protocol === 'chat_completions'
  ? { choices: [{ index: 0, message: { role: 'assistant', content: '完成' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }
  : protocol === 'responses' ? { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '完成' }] }], usage: { input_tokens: 10, output_tokens: 2 } }
    : { type: 'message', role: 'assistant', content: [{ type: 'text', text: '完成' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2 } };
async function fixture(protocol: IndependentApiProtocol = 'responses', budget = policy, handler?: RequestListener) {
  const server = createServer((req, res) => { void (async () => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    seen.push({ url: req.url!, body: Buffer.concat(chunks).toString() });
    if (handler) return handler(req, res);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(/(?:input_tokens|count_tokens)$/.test(req.url!)
      ? { ...(protocol === 'responses' ? { object: 'response.input_tokens' } : {}), input_tokens: 0 } : reply(protocol)));
  })().catch(() => res.destroy()); }); servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const db = openDb(':memory:'); databases.push(db); seed(db);
  const catalog = new IndependentCatalog(db, new SecretService(db, new MemorySecretStore()), new EventStore(db, new EventBus()));
  const service = await catalog.createService({ name: '仅本机请求记账夹具', protocol, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/custom/v1`,
    authentication: 'api_key', apiKey: 'fixture-ledger-secret', apiVersion: '2023-06-01', enabled: true, providerId: null, plan: null });
  let model = catalog.createModel(service.id, { name: '模型', remoteModelId: 'original/fixture' });
  model = catalog.overrides(service.id, model.id, { expectedRevision: model.revision, values: { contextWindow: 100_000, tools: true } });
  const selected = catalog.bind('task', { serviceId: service.id, modelId: model.id });
  const ledger = new IndependentRequestLedger(db); ledger.create(selected, budget);
  const request: IndependentModelRequest = { binding: selected, systemPrompt: '规则', checkpoint: null, messages: [user], maxOutputTokens: 100 };
  const driver = (config: IndependentModelDriverConfig = {}) => new IndependentApiDriver(catalog,
    { context: { mode: 'local', safetyTokens: 0 }, accounting: ledger.accounting('task'), ...config });
  return { db, ledger, catalog, service, model, request, binding: selected, driver, signal: new AbortController().signal };
}
afterEach(async () => {
  vi.restoreAllMocks(); seen.length = 0;
  for (const helper of helpers.splice(0)) if (helper.exitCode === null && helper.signalCode === null) await new Promise<void>((resolve) => { helper.once('close', () => resolve()); helper.kill('SIGKILL'); });
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  for (const db of databases.splice(0)) db.close();
  for (const dir of dirs.splice(0)) {
    const target = path.resolve(dir);
    if (path.dirname(target) !== path.resolve(tmpdir()) || !path.basename(target).startsWith('aic-request-ledger-')) throw Error('拒绝范围外清理');
    rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe('持久请求预算', () => {
  it('重复装配不清空预算，不允许换绑定或策略重置额度', () => {
    const { ledger } = setup(); const id = ledger.reserve(binding, attempt);
    expect(ledger.create(binding, policy)).toMatchObject({ attemptedRequests: 1, reservedMicros: 10, remainingMicros: 15, actualCostMicros: null });
    expect(() => ledger.create(binding, { ...policy, maxRequests: 100 })).toThrow('不能通过');
    expect(() => ledger.create({ ...binding, modelId: 'another' }, policy)).toThrow('不能通过');
    expect(ledger.get(id).status).toBe('reserved');
  });
  it('相同正文再次调用仍占次数；失败和成功都不退回人工预留', () => {
    const { ledger } = setup(); ledger.settle(ledger.reserve(binding, attempt), failed);
    ledger.settle(ledger.reserve(binding, attempt), success);
    expect(ledger.snapshot('task')).toMatchObject({ attemptedRequests: 2, pendingRequests: 0, remainingRequests: 1, reservedMicros: 20, remainingMicros: 5, actualCostMicros: null });
    expect(() => ledger.reserve(binding, attempt)).toThrow('预留不足');
    expect(ledger.entries('task').map((r) => r.status)).toEqual(['failed', 'succeeded']);
  });
  it('计数费用未知时金额限额阻止计数，不暗填零；明确零可保留', () => {
    const { db } = setup(); db.run('DELETE FROM independent_request_budgets'); const ledger = new IndependentRequestLedger(db);
    ledger.create(binding, { maxRequests: 2, money: { ...policy.money!, counterCeilingMicros: null, modelCeilingMicros: 0 } });
    expect(() => ledger.reserve(binding, { ...attempt, kind: 'counter' })).toThrow('预留不足');
    const id = ledger.reserve(binding, attempt); expect(ledger.get(id)).toMatchObject({ currency: 'CNY', reservedMicros: 0 });
    expect(ledger.snapshot('task').actualCostMicros).toBeNull();
  });
  it('不设置金额限制仍严格限制请求次数，未知金额保持 null', () => {
    const { db } = setup(); db.run('DELETE FROM independent_request_budgets'); const ledger = new IndependentRequestLedger(db);
    ledger.create(binding, { maxRequests: 1, money: null }); ledger.reserve(binding, attempt);
    expect(ledger.snapshot('task')).toMatchObject({ reservedMicros: null, remainingMicros: null, remainingRequests: 0, actualCostMicros: null });
    expect(() => ledger.reserve(binding, attempt)).toThrow('预留不足');
  });
  it('两条数据库连接共享次数与金额余额；事务回滚不吞额度', () => {
    const file = path.join(temporary(), 'requests.db'), { db, ledger } = setup(file);
    const secondDb = openDb(file); databases.push(secondDb); const other = new IndependentRequestLedger(secondDb);
    expect(() => db.tx(() => { ledger.reserve(binding, attempt); throw Error('回滚'); })).toThrow('回滚');
    expect(other.snapshot('task').attemptedRequests).toBe(0);
    ledger.reserve(binding, attempt); other.reserve(binding, attempt);
    expect(() => ledger.reserve(binding, attempt)).toThrow('预留不足');
    expect(other.snapshot('task')).toMatchObject({ attemptedRequests: 2, reservedMicros: 20 });
  });
  it('终态只允许相同结算幂等，拒绝迟到结果及计数 / 生成串账', () => {
    const { ledger } = setup(); const id = ledger.reserve(binding, attempt);
    expect(() => ledger.settle(id, { ...success, usage: null, countedInputTokens: 0 })).toThrow('不能互换');
    ledger.settle(id, failed); expect(ledger.settle(id, failed).status).toBe('failed');
    expect(() => ledger.settle(id, success)).toThrow('已有终态');
    const count = ledger.reserve(binding, { ...attempt, kind: 'counter' });
    expect(() => ledger.settle(count, success)).toThrow('不能互换');
    expect(ledger.settle(count, { ...success, usage: null, countedInputTokens: 0 }).settlement?.countedInputTokens).toBe(0);
  });
  it('任务绑定及专用记账对象不能串到其他任务', () => {
    const { ledger } = setup(); const accounting = ledger.accounting('task');
    expect(() => ledger.reserve({ ...binding, configRevision: 2 }, attempt)).toThrow('不一致');
    expect(() => accounting.reserve({ ...binding, taskId: 'other' }, attempt)).toThrow('不属于');
    expect(ledger.snapshot('task').attemptedRequests).toBe(0);
  });
  it('显式调整保留历史绑定、币种和占额，不能用缩小或换币种清账', () => {
    const { ledger } = setup(); const id = ledger.reserve(binding, attempt); ledger.settle(id, failed);
    const changed = { ...binding, modelId: 'another-model', modelRevision: 2 };
    const next = ledger.adjust(changed, { ...policy, maxRequests: 8 }, 1);
    expect(next).toMatchObject({ revision: 2, attemptedRequests: 1, reservedMicros: 10 });
    expect(ledger.get(id)).toMatchObject({ binding, currency: 'CNY', reservedMicros: 10 });
    expect(() => ledger.adjust(changed, policy, 1)).toThrow('已变化');
    expect(() => ledger.adjust(changed, { ...policy, money: { ...policy.money!, currency: 'USD' } }, 2)).toThrow('币种');
    expect(() => ledger.adjust(changed, { ...policy, money: { ...policy.money!, maxReservedMicros: 9 } }, 2)).toThrow('已占用预留');
    expect(() => ledger.adjust(changed, { ...policy, money: null }, 2)).toThrow('记账方式');
    const pending = ledger.reserve(changed, attempt); expect(() => ledger.adjust(changed, policy, 2)).toThrow('尚未核对');
    ledger.settle(pending, failed); expect(ledger.snapshot('task').attemptedRequests).toBe(2);
  });
  it('外层事务未提交不能取得可发送的请求身份，回滚后额度完整', () => {
    const { db, ledger } = setup(), accounting = ledger.accounting('task');
    expect(() => db.tx(() => accounting.reserve(binding, attempt))).toThrow('外层事务');
    expect(ledger.snapshot('task').attemptedRequests).toBe(0);
    const id = accounting.reserve(binding, attempt);
    expect(() => db.tx(() => accounting.settle(id, success))).toThrow('外层事务');
    expect(ledger.get(id).status).toBe('reserved'); accounting.settle(id, success);
    expect(ledger.get(id).status).toBe('succeeded');
  });
  it('恢复只标未知中断，不恢复次数或金额，已结算的零和未知用量均保留', () => {
    const { ledger } = setup(); const id = ledger.reserve(binding, attempt);
    ledger.settle(ledger.reserve(binding, attempt), { ...success, usage: { inputTokens: 0, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: 0 } });
    expect(ledger.recover('task').map((r) => r.id)).toEqual([id]); expect(ledger.recover()).toEqual([]);
    expect(ledger.get(id)).toMatchObject({ status: 'interrupted', settlement: { failure: 'interrupted', usage: null } });
    expect(ledger.entries('task')[1]!.settlement?.usage).toEqual({ inputTokens: 0, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: 0 });
    expect(ledger.snapshot('task')).toMatchObject({ attemptedRequests: 2, reservedMicros: 20, actualCostMicros: null });
    expect(() => ledger.settle(id, success)).toThrow('已有终态');
  });
  it('v10 增量升级保留原会话和草稿，重复打开不重建表', () => {
    const directory = temporary(), file = path.join(directory, 'migration.db'); const { db } = setup(file);
    db.run("INSERT INTO task_drafts(task_id,text,annotations_json,updated_at) VALUES ('task','原草稿','[]',1)");
    databases.splice(databases.indexOf(db), 1); db.close();
    const old = new DatabaseSync(file); old.exec('DROP TABLE independent_task_settings; DROP TABLE independent_request_attempts; DROP TABLE independent_request_budgets; PRAGMA user_version=10;'); old.close();
    for (let i = 0; i < 2; i++) { const migrated = openDb(file);
      expect(migrated.get('PRAGMA user_version')).toEqual({ user_version: 12 }); expect(migrated.get('SELECT text FROM task_drafts')).toEqual({ text: '原草稿' });
      expect(migrated.get('SELECT id FROM sessions')).toEqual({ id: 'session' }); expect(migrated.all('SELECT * FROM independent_request_attempts')).toEqual([]); migrated.close(); }
  });
  it('预留后子进程崩溃，重开数据库仍耗尽额度，不产生重发', async () => {
    const directory = temporary(), ready = path.join(directory, 'ready');
    const fixture = fileURLToPath(new URL('./fixtures/independent-request-ledger.ts', import.meta.url));
    const tsx = new URL('../../../node_modules/tsx/dist/loader.mjs', import.meta.url).href;
    const helper = spawn(process.execPath, ['--import', tsx, fixture, directory], { windowsHide: true, stdio: 'ignore', env: independentCommandEnv(directory) }); helpers.push(helper);
    await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 10_000 });
    const record = JSON.parse(readFileSync(ready, 'utf8')) as { id: string; pid: number }; expect(record.pid).toBe(helper.pid);
    await new Promise<void>((resolve) => { helper.once('close', () => resolve()); helper.kill('SIGKILL'); });
    const db = openDb(path.join(directory, 'requests.db')); databases.push(db); const ledger = new IndependentRequestLedger(db);
    expect(ledger.get(record.id).status).toBe('reserved'); ledger.recover();
    expect(() => ledger.reserve(binding, attempt)).toThrow('预留不足');
    expect(ledger.snapshot('task')).toMatchObject({ attemptedRequests: 1, reservedMicros: 10, pendingRequests: 0 });
  });
});

describe('正式传输的逐 POST 记账接缝', () => {
  it.each(['chat_completions', 'responses', 'anthropic_messages'] as const)('%s 每次生成发送前已落盘，摘要匹配最终正文，usage 不冒充费用', async (protocol) => {
    let f: Awaited<ReturnType<typeof fixture>>;
    f = await fixture(protocol, policy, (_req, res) => {
      expect(f.ledger.entries('task')[0]!.status).toBe('reserved');
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(reply(protocol)));
    });
    await f.driver().complete(f.request, f.signal);
    expect(f.ledger.entries('task')[0]).toMatchObject({ attempt: { kind: 'model', requestHash: createHash('sha256').update(seen[0]!.body).digest('hex') },
      status: 'succeeded', settlement: { usage: { inputTokens: 10, outputTokens: 2 } }, reservedMicros: 10 });
    expect(f.ledger.snapshot('task').actualCostMicros).toBeNull();
    const raw = JSON.stringify(f.db.all('SELECT * FROM independent_request_attempts'));
    expect(raw).not.toContain('fixture-ledger-secret'); expect(raw).not.toContain('验证独立回合'); expect(raw).not.toContain('original/fixture');
  });
  it.each(['responses', 'anthropic_messages'] as const)('%s 计数与生成分别占用预算，真实计数零保留', async (protocol) => {
    const f = await fixture(protocol); await f.driver({ context: { mode: 'endpoint', safetyTokens: 0 } }).complete(f.request, f.signal);
    expect(f.ledger.entries('task').map((r) => [r.attempt.kind, r.reservedMicros, r.status])).toEqual([['counter', 5, 'succeeded'], ['model', 10, 'succeeded']]);
    expect(f.ledger.entries('task')[0]!.settlement).toMatchObject({ countedInputTokens: 0, usage: null });
    expect(f.ledger.snapshot('task')).toMatchObject({ attemptedRequests: 2, reservedMicros: 15, remainingRequests: 1 });
  });
  it.each([
    { maxRequests: 1, money: null },
    { maxRequests: 3, money: { ...policy.money!, maxReservedMicros: 5 } },
  ])('计数后次数或金额不足，不发送生成请求', async (budget) => {
    const f = await fixture('responses', budget);
    await expect(f.driver({ context: { mode: 'endpoint' } }).complete(f.request, f.signal)).rejects.toMatchObject({ reason: 'budget' });
    expect(seen).toHaveLength(1); expect(f.ledger.entries('task').map((r) => r.attempt.kind)).toEqual(['counter']);
  });
  it('金额限额下计数预留未知，正文不发送，不自动改成本地估算', async () => {
    const f = await fixture('responses', { ...policy, money: { ...policy.money!, counterCeilingMicros: null } });
    await expect(f.driver({ context: { mode: 'endpoint' } }).complete(f.request, f.signal)).rejects.toMatchObject({ reason: 'budget' });
    expect(seen).toHaveLength(0); expect(f.ledger.entries('task')).toEqual([]);
  });
  it('两个驱动争用唯一次数，网络中只出现一条请求', async () => {
    const f = await fixture('responses', { maxRequests: 1, money: null });
    const results = await Promise.allSettled([f.driver().complete(f.request, f.signal), f.driver().complete(f.request, f.signal)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { reason: 'budget' } });
    expect(seen).toHaveLength(1); expect(f.ledger.snapshot('task').attemptedRequests).toBe(1);
  });
  it('计数后宿主记录预检失败，计数记录仍结算，不偷偷发生成', async () => {
    const f = await fixture();
    await expect(f.driver({ context: { mode: 'endpoint' }, onContext: () => { throw Error('模拟预检记录失败'); } }).complete(f.request, f.signal)).rejects.toBeDefined();
    expect(seen).toHaveLength(1); expect(f.ledger.entries('task')[0]).toMatchObject({ attempt: { kind: 'counter' }, status: 'succeeded' });
    expect(f.ledger.snapshot('task').reservedMicros).toBe(5);
  });
  it.each([401, 429, 500])('HTTP %s 保留失败尝试与预留，再次调用继续占额度', async (status) => {
    const f = await fixture('responses', policy, (_req, res) => { res.writeHead(status); res.end('禁止记录的上游正文'); });
    const driver = f.driver(); await expect(driver.complete(f.request, f.signal)).rejects.toBeDefined();
    await expect(driver.complete(f.request, f.signal)).rejects.toBeDefined();
    await expect(driver.complete(f.request, f.signal)).rejects.toMatchObject({ reason: 'budget' });
    expect(seen).toHaveLength(2); expect(f.ledger.entries('task').every((r) => r.status === 'failed' && r.settlement?.usage === null)).toBe(true);
    expect(JSON.stringify(f.ledger.entries('task'))).not.toContain('禁止记录');
  });
  it('计数坏结果保留失败记录，不发生成', async () => {
    const f = await fixture('responses', policy, (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"input_tokens":"0"}'); });
    await expect(f.driver({ context: { mode: 'endpoint' } }).complete(f.request, f.signal)).rejects.toMatchObject({ reason: 'protocol' });
    expect(seen).toHaveLength(1); expect(f.ledger.entries('task')[0]).toMatchObject({ status: 'failed', settlement: { failure: 'protocol', usage: null } });
  });
  it.each(['cancelled', 'timed_out'] as const)('%s 等实际连接收尾后留下未知费用的失败记录', async (reason) => {
    const abort = new AbortController(); const f = await fixture('responses', policy, () => { if (reason === 'cancelled') abort.abort(); });
    const driver = f.driver({ timeoutMs: reason === 'timed_out' ? 80 : 1000 });
    await expect(driver.complete(f.request, abort.signal)).rejects.toMatchObject({ reason }); await driver.waitForIdle(f.binding);
    expect(f.ledger.entries('task')[0]).toMatchObject({ status: 'failed', settlement: { failure: reason, usage: null }, reservedMicros: 10 });
    expect(f.ledger.snapshot('task').pendingRequests).toBe(0);
  });
  it('流只返回半条消息便断开，记录失败与未知用量，不能记成免费或成功', async () => {
    const f = await fixture('chat_completions', policy, (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: {"choices":[{"index":0,"delta":{"content":"半条"},"finish_reason":null}]}\n\n');
    });
    await expect(f.driver({ generation: { stream: true } }).complete(f.request, f.signal)).rejects.toMatchObject({ reason: 'protocol' });
    expect(f.ledger.entries('task')[0]).toMatchObject({ status: 'failed', settlement: { usage: null }, reservedMicros: 10 });
  });
  it('协议完整但 usage 缺失，成功记录保留未知 token，实际费用仍未知', async () => {
    const f = await fixture('responses', policy, (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' }); const result = reply('responses'); delete (result as any).usage; res.end(JSON.stringify(result));
    });
    await f.driver().complete(f.request, f.signal);
    expect(f.ledger.entries('task')[0]).toMatchObject({ status: 'succeeded', settlement: { usage: { inputTokens: null, outputTokens: null } } });
    expect(f.ledger.snapshot('task')).toMatchObject({ reservedMicros: 10, actualCostMicros: null });
  });
  it('预留落盘失败没有网络副作用，结算失败留给恢复且不重发或假写终态', async () => {
    const f = await fixture(); const accounting = f.ledger.accounting('task');
    const reserve = vi.spyOn(accounting, 'reserve').mockImplementation(() => { throw Error('模拟写盘失败'); });
    await expect(f.driver({ accounting }).complete(f.request, f.signal)).rejects.toBeDefined(); expect(seen).toHaveLength(0);
    reserve.mockRestore(); vi.spyOn(accounting, 'settle').mockImplementation(() => { throw Error('模拟结算失败'); });
    await expect(f.driver({ accounting }).complete(f.request, f.signal)).rejects.toBeDefined();
    expect(seen).toHaveLength(1); expect(f.ledger.entries('task')[0]!.status).toBe('reserved');
    f.ledger.recover(); expect(f.ledger.entries('task')[0]!.status).toBe('interrupted');
  });
  it('工具续传累计至同一任务额度，耗尽后保留会话且不再调用工具', async () => {
    const f = await fixture('chat_completions', { maxRequests: 1, money: null }, (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: '',
        tool_calls: [{ id: 'call-one', type: 'function', function: { name: 'read_file', arguments: '{}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
    const store = new IndependentConversationStore(f.db), tools = { execute: vi.fn(async () => ({ role: 'tool' as const, callId: 'call-one', name: 'read_file', text: '用户拒绝', outcome: 'rejected' as const })) };
    const driver = f.driver({ tools: [{ name: 'read_file', description: '夹具', parameters: { type: 'object', properties: {} } }] });
    const engine = new IndependentTurnEngine(store, driver, tools), turn = store.create(f.binding, 'session', user, limits);
    expect(await engine.run(turn.id)).toMatchObject({ status: 'failed', stop: 'request_budget', modelCalls: 2, toolCalls: 1 });
    expect(seen).toHaveLength(1); expect(tools.execute).toHaveBeenCalledTimes(1);
    expect(store.entries('session').map((r) => r.message.role)).toEqual(['user', 'assistant', 'tool']);
    expect(f.ledger.snapshot('task').attemptedRequests).toBe(1); await engine.close();
  });
});
