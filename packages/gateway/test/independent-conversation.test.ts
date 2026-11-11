import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { IndependentCommandSpec, type IndependentAssistantMessage, type IndependentModelDriver, type IndependentToolDriver, type IndependentToolMessage } from '@aic/protocol';
import { openDb, type Db } from '../src/db';
import { IndependentConversationStore } from '../src/independent/conversation';
import { IndependentTurnEngine } from '../src/independent/turn-engine';
import { IndependentCommandTool } from '../src/independent/command-tool';
import { IndependentCommandExecutor, independentCommandEnv } from '../src/independent/commands';
import { IndependentToolJournal } from '../src/independent/tool-journal';
import { seed } from './fixtures/independent-journal';
import { binding, limits, user, usage, call, toolReply, finalReply } from './fixtures/independent-conversation';

const databases: Db[] = []; const directories: string[] = []; const engines: IndependentTurnEngine[] = [];
const executors: IndependentCommandExecutor[] = []; const helpers: ChildProcess[] = [];
function temporary() { const dir = mkdtempSync(path.join(tmpdir(), 'aic-conversation-')); directories.push(dir); return dir; }
function setup(replies: IndependentAssistantMessage[] = [finalReply], execute?: IndependentToolDriver['execute']) {
  const db = openDb(':memory:'); databases.push(db); seed(db);
  const store = new IndependentConversationStore(db);
  const model = { checkBinding: vi.fn(() => {}), complete: vi.fn<IndependentModelDriver['complete']>(async () => {
    const reply = replies.shift(); if (!reply) throw new Error('假模型队列已用完'); return reply;
  }) };
  const tools = { execute: vi.fn<IndependentToolDriver['execute']>(execute ?? (async (input) => ({ role: 'tool', callId: input.id, name: input.name, text: '工具已执行', outcome: 'ok' }))) };
  const engine = new IndependentTurnEngine(store, model, tools); engines.push(engine);
  const create = (patch: Partial<typeof limits> = {}, prompt = '') => store.create(binding, 'session', user, { ...limits, ...patch }, prompt);
  return { db, store, model, tools, engine, create };
}
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close().catch(() => {});
  for (const executor of executors.splice(0)) await executor.close();
  for (const helper of helpers.splice(0)) if (helper.exitCode === null && helper.signalCode === null) await new Promise<void>((resolve) => { helper.once('close', () => resolve()); helper.kill('SIGKILL'); });
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  vi.restoreAllMocks();
});

describe('完整独立会话与循环', () => {
  it.each([false, true])('完整绑定时间变化 %s 时按实际身份决定私有续传，原始记录不变', (changed) => {
    const { store, create } = setup(); const first = create(), owner = store.acquire(first.id);
    store.claimModel(first.id, owner); store.assistant(first.id, owner, { ...finalReply, continuation: '合成私有续传' }); store.finish(first.id, owner, 'completed');
    const original = store.entries('session');
    const next = store.create({ ...binding, createdAt: binding.createdAt + (changed ? 1 : 0) }, 'session', user, limits);
    const reply = store.context(next.id).messages.find((m) => m.role === 'assistant');
    expect(reply).toMatchObject({ text: finalReply.text });
    if (changed) expect(reply).not.toHaveProperty('continuation'); else expect(reply).toHaveProperty('continuation', '合成私有续传');
    expect(store.entries('session').slice(0, original.length)).toEqual(original);
  });
  it('换模型必须核对旧绑定与历史尾摘要，原始续传保留但不交给新模型', () => {
    const { store, create } = setup(); const first = create(), owner = store.acquire(first.id);
    store.claimModel(first.id, owner); store.assistant(first.id, owner, { ...finalReply, continuation: '旧模型专用续传资料' }); store.finish(first.id, owner, 'completed');
    const next = { ...binding, modelId: 'new-model', modelRevision: 2 }, tail = store.entries('session').at(-1)!;
    expect(() => store.create(next, 'session', user, limits)).toThrow('明确核对');
    expect(() => store.create(next, 'session', user, limits, '', { previousBinding: binding, tailHash: 'f'.repeat(64) })).toThrow('明确核对');
    expect(() => store.create(next, 'session', user, limits, '', { previousBinding: next, tailHash: tail.hash })).toThrow('明确核对');
    expect(store.entries('session')).toHaveLength(2);
    const second = store.create(next, 'session', user, limits, '', { previousBinding: binding, tailHash: tail.hash });
    expect(store.context(second.id).messages.find((m) => m.role === 'assistant')).not.toHaveProperty('continuation');
    expect(store.entries('session')[1]!.message).toHaveProperty('continuation', '旧模型专用续传资料');
  });
  it('项目规则或工具开关变化后不再带上旧私有续传，相同时保留（ISSUE-0056）', () => {
    const { store } = setup(); const first = store.create(binding, 'session', user, limits, '规则甲'), owner = store.acquire(first.id);
    store.claimModel(first.id, owner); store.assistant(first.id, owner, { ...finalReply, continuation: '规则甲下的续传' }); store.finish(first.id, owner, 'completed');
    const original = store.entries('session');
    const assistantOf = (id: string) => store.context(id).messages.find((m) => m.role === 'assistant');
    const finish = (id: string) => store.finish(id, store.acquire(id), 'cancelled');
    const same = store.create(binding, 'session', user, limits, '规则甲');
    expect(assistantOf(same.id)).toHaveProperty('continuation', '规则甲下的续传'); finish(same.id);
    const changed = store.create(binding, 'session', user, limits, '规则乙');
    expect(assistantOf(changed.id)).toMatchObject({ text: finalReply.text }); expect(assistantOf(changed.id)).not.toHaveProperty('continuation'); finish(changed.id);
    const noTools = store.create(binding, 'session', user, { ...limits, maxToolCalls: 0 }, '规则甲');
    expect(assistantOf(noTools.id)).not.toHaveProperty('continuation'); finish(noTools.id);
    // 规则改回原样后，原续传重新适用；原始记录始终不改写
    const back = store.create(binding, 'session', user, limits, '规则甲');
    expect(assistantOf(back.id)).toHaveProperty('continuation', '规则甲下的续传');
    expect(store.entries('session').slice(0, original.length)).toEqual(original);
  });
  it('人工总结保存在中间位置时，总结之前产生的后续消息不再带旧私有续传（ISSUE-0056）', () => {
    let clock = 1_800_000_000_000; vi.spyOn(Date, 'now').mockImplementation(() => clock += 10);
    const { store, create } = setup();
    const run = (continuation: string) => { const turn = create(), owner = store.acquire(turn.id);
      store.claimModel(turn.id, owner); store.assistant(turn.id, owner, { ...finalReply, continuation }); store.finish(turn.id, owner, 'completed'); };
    run('第一回合续传'); run('第二回合续传');
    store.checkpoint('session', 2, '第一回合的人工总结', store.entries('session').at(-1)!.hash);
    const third = create(), owner = store.acquire(third.id); let context = store.context(third.id);
    expect(context.checkpoint?.throughSeq).toBe(2);
    expect(context.messages.filter((m) => m.role === 'assistant')).toHaveLength(1);
    expect(context.messages.find((m) => m.role === 'assistant')).not.toHaveProperty('continuation');
    // 总结之后产生的消息在同一总结下生成，续传保留
    store.claimModel(third.id, owner); store.assistant(third.id, owner, { ...finalReply, continuation: '总结之后的续传' }); store.finish(third.id, owner, 'completed');
    context = store.context(create().id);
    expect(context.messages.filter((m) => m.role === 'assistant').map((m) => (m as { continuation?: string }).continuation)).toEqual([undefined, '总结之后的续传']);
    expect(store.entries('session')[3]!.message).toHaveProperty('continuation', '第二回合续传');
  });
  it('只有助手正文落盘成功后才通知宿主确认消息，持久化失败不发布成功', async () => {
    const { db, store, model, tools, create } = setup(); const observed = vi.fn(() => { expect(db.all('SELECT seq FROM independent_messages')).toHaveLength(2); });
    const engine = new IndependentTurnEngine(store, model, tools, { assistant: observed }); engines.push(engine);
    await engine.run(create().id); expect(observed).toHaveBeenCalledTimes(1);
    const other = setup(); const unpublished = vi.fn();
    const failing = new IndependentTurnEngine(other.store, other.model, other.tools, { assistant: unpublished }); engines.push(failing);
    vi.spyOn(other.store, 'assistant').mockImplementation(() => { throw Error('落盘故障'); });
    await expect(failing.run(other.create().id)).rejects.toThrow('落盘故障'); expect(unpublished).not.toHaveBeenCalled();
  });
  it('多轮工具调用先保存回复与结果，再发送下一请求，保留原样参数和剩余预算', async () => {
    const { engine, store, model, tools, create } = setup([toolReply, { ...toolReply, toolCalls: [{ ...call, id: 'call-2' }] }, finalReply]);
    const turn = create({}, '项目规则：使用中文');
    expect(await engine.run(turn.id)).toMatchObject({ status: 'completed', modelCalls: 3, toolCalls: 2, outputTokens: 6 });
    expect(model.complete.mock.calls.map(([r]) => r.messages.map((m) => m.role))).toEqual([
      ['user'], ['user', 'assistant', 'tool'], ['user', 'assistant', 'tool', 'assistant', 'tool'],
    ]);
    expect(model.complete.mock.calls.map(([r]) => r.maxOutputTokens)).toEqual([100, 98, 96]);
    expect(model.complete.mock.calls[0]![0].systemPrompt).toBe('项目规则：使用中文');
    expect(tools.execute).toHaveBeenCalledTimes(2);
    expect(store.entries('session').map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  });
  it('工具拒绝保存原因，模型能看到拒绝并完成本轮', async () => {
    const { engine, store, create } = setup([toolReply, finalReply], async (input) => ({ role: 'tool', callId: input.id, name: input.name, text: '用户拒绝修改', outcome: 'rejected' }));
    expect((await engine.run(create().id)).status).toBe('completed');
    expect(store.entries('session')[2]!.message).toMatchObject({ outcome: 'rejected', text: '用户拒绝修改' });
  });
  it('工具明确返回中断结果时停止续传，不能让模型自动再次请求未定操作', async () => {
    const { engine, model, create, store } = setup([toolReply, finalReply], async (input) => ({ role: 'tool', callId: input.id, name: input.name, text: '副作用未知，需要人工核对', outcome: 'interrupted' }));
    const turn = create(); expect(await engine.run(turn.id)).toMatchObject({ stop: 'tool_error', status: 'failed' });
    expect(model.complete).toHaveBeenCalledTimes(1); expect(store.pending(turn.id)).toEqual([]);
    expect(store.entries('session')[2]!.message).toMatchObject({ outcome: 'interrupted' });
  });
  it('工具严格校验拿到数字原值，失败不会将其转换后执行或自动重试', async () => {
    let effects = 0;
    const { engine, store, create, tools } = setup([{ ...toolReply, toolCalls: [{ ...call, arguments: { program: 123, args: [], timeoutMs: 1000, maxOutputBytes: 4096 } }] }], async (input) => {
      expect(input.arguments.program).toBe(123); IndependentCommandSpec.parse(input.arguments); effects++;
      return { role: 'tool', callId: input.id, name: input.name, text: '', outcome: 'ok' };
    });
    expect(await engine.run(create().id)).toMatchObject({ stop: 'tool_error' });
    expect(effects).toBe(0); expect(tools.execute).toHaveBeenCalledTimes(1);
    expect(store.entries('session')[2]!.message).toMatchObject({ outcome: 'interrupted' });
  });
  it('未知 output usage 不补零，不执行后续工具或再次计费请求', async () => {
    const { engine, store, model, tools, create } = setup([{ ...toolReply, usage: { ...usage, outputTokens: null } }]);
    expect(await engine.run(create().id)).toMatchObject({ stop: 'usage_unknown', outputTokens: null, modelCalls: 1, toolCalls: 0 });
    expect(model.complete).toHaveBeenCalledTimes(1); expect(tools.execute).not.toHaveBeenCalled();
    expect(store.pending(store.entries('session')[0]!.turnId)).toEqual([]);
    expect(store.entries('session')[2]!.message).toMatchObject({ outcome: 'budget_exceeded' });
  });
  it('最终回复可保留未知用量，完成状态不伪造为零费用', async () => {
    const { engine, create } = setup([{ ...finalReply, usage: { ...usage, outputTokens: null } }]);
    expect(await engine.run(create().id)).toMatchObject({ status: 'completed', outputTokens: null });
  });
  it.each(['error', 'length', 'cancelled'] as const)('助手 %s 终态不会被正常返回的 promise 当作成功', async (stopReason) => {
    const { engine, store, create } = setup([{ ...finalReply, stopReason }]); const turn = create();
    const result = await engine.run(turn.id); expect(result.status).not.toBe('completed');
    expect(result.stop).toBe(stopReason === 'error' ? 'model_error' : stopReason === 'length' ? 'output_limit' : 'cancelled');
    expect(store.entries('session')[1]!.message).toMatchObject({ stopReason });
  });
  it('模型请求异常保留尝试计数与未知用量，不自动重试或保存原始异常', async () => {
    const { engine, store, model, create, db } = setup();
    model.complete.mockRejectedValue(new Error('fixture-sensitive-response'));
    expect(await engine.run(create().id)).toMatchObject({ stop: 'model_error', modelCalls: 1, outputTokens: null });
    expect(model.complete).toHaveBeenCalledTimes(1); expect(store.entries('session')).toHaveLength(1);
    expect(JSON.stringify(db.all('SELECT * FROM independent_turns'))).not.toContain('fixture-sensitive-response');
  });
  it('模型调用次数上限持久执行，达到上限后不发下一请求', async () => {
    const { engine, model, tools, create, store } = setup([toolReply, finalReply]); const turn = create({ maxModelCalls: 1 });
    expect(await engine.run(turn.id)).toMatchObject({ stop: 'model_limit', modelCalls: 1, toolCalls: 1 });
    expect(model.complete).toHaveBeenCalledTimes(1); expect(tools.execute).toHaveBeenCalledTimes(1); expect(store.pending(turn.id)).toEqual([]);
  });
  it.each([0, 1])('工具上限 %s 中止剩余项并保存配对结果', async (maxToolCalls) => {
    const { engine, tools, create, store } = setup([{ ...toolReply, toolCalls: [call, { ...call, id: 'call-2' }] }]); const turn = create({ maxToolCalls });
    expect(await engine.run(turn.id)).toMatchObject({ stop: 'tool_limit', toolCalls: maxToolCalls });
    expect(tools.execute).toHaveBeenCalledTimes(maxToolCalls); expect(store.pending(turn.id)).toEqual([]);
    expect(store.entries('session').at(-1)!.message).toMatchObject({ outcome: 'budget_exceeded' });
  });
  it('超过已知输出上限时保留报告值和回复，不继续工具与模型', async () => {
    const { engine, tools, create, store } = setup([{ ...toolReply, usage: { ...usage, outputTokens: 101 } }]); const turn = create();
    expect(await engine.run(turn.id)).toMatchObject({ stop: 'output_limit', outputTokens: 101 });
    expect(tools.execute).not.toHaveBeenCalled(); expect(store.entries('session')).toHaveLength(3);
  });
  it('上下文 JSON 字节保护在请求前停止，不能冒充模型 token 窗口', async () => {
    const { engine, model, create } = setup();
    expect(await engine.run(create({ maxContextBytes: 1024 }, '文'.repeat(1000)).id)).toMatchObject({ stop: 'context_limit', modelCalls: 0 });
    expect(model.complete).not.toHaveBeenCalled();
  });
  it('另一运行器和同会话新回合均不能重复取得请求权', async () => {
    const { engine, model, create, store } = setup(); const turn = create(); let reply!: (value: IndependentAssistantMessage) => void;
    model.complete.mockImplementation(() => new Promise((resolve) => { reply = resolve; }));
    const pending = engine.run(turn.id); await vi.waitFor(() => expect(model.complete).toHaveBeenCalledTimes(1));
    const second = new IndependentTurnEngine(store, model, { execute: vi.fn() }); engines.push(second);
    expect(() => second.run(turn.id)).toThrow('已有运行器'); expect(() => create()).toThrow('已有运行回合');
    reply(finalReply); expect((await pending).status).toBe('completed');
  });
  it('绑定在首次请求前失效则零调用，工具派发前失效不使用默认服务兜底', async () => {
    const first = setup(); first.model.checkBinding.mockImplementation(() => { throw new Error('配置修订已变化'); });
    expect(await first.engine.run(first.create().id)).toMatchObject({ stop: 'configuration_changed', modelCalls: 0 });
    expect(first.model.complete).not.toHaveBeenCalled();
    const next = setup([toolReply]); next.model.checkBinding.mockImplementationOnce(() => {}).mockImplementation(() => { throw new Error('停用'); });
    expect(await next.engine.run(next.create().id)).toMatchObject({ stop: 'configuration_changed', modelCalls: 1, toolCalls: 0 });
    expect(next.tools.execute).not.toHaveBeenCalled(); expect(next.model.complete).toHaveBeenCalledTimes(1);
  });
  it('模型等待中取消隔离迟到回复，不覆写终态或请求下一轮', async () => {
    const { engine, model, store, create } = setup(); const turn = create(); const abort = new AbortController(); let reply!: (value: IndependentAssistantMessage) => void;
    model.complete.mockImplementation(() => new Promise((resolve) => { reply = resolve; }));
    const pending = engine.run(turn.id, abort.signal); await vi.waitFor(() => expect(model.complete).toHaveBeenCalledTimes(1));
    const signal = model.complete.mock.calls[0]![1]; abort.abort();
    expect(await pending).toMatchObject({ status: 'cancelled', outputTokens: null }); expect(signal.aborted).toBe(true);
    reply(toolReply); await Promise.resolve(); expect(store.entries('session')).toHaveLength(1); expect(store.get(turn.id).status).toBe('cancelled');
  });
  it('等待工具审批期间取消，保存中断配对，迟到批准不能继续模型', async () => {
    const { engine, model, tools, store, create } = setup([toolReply], async (_call, _identity, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('审批已取消')), { once: true });
    }));
    const turn = create(); const abort = new AbortController(); const pending = engine.run(turn.id, abort.signal);
    await vi.waitFor(() => expect(tools.execute).toHaveBeenCalledTimes(1)); abort.abort();
    expect(await pending).toMatchObject({ status: 'cancelled', toolCalls: 1 });
    expect(tools.execute.mock.calls[0]![2].aborted).toBe(true); expect(model.complete).toHaveBeenCalledTimes(1);
    expect(store.pending(turn.id)).toEqual([]); expect(store.entries('session')[2]!.message).toMatchObject({ outcome: 'cancelled' });
  });
  it('取消必须等工具资源收尾后才结束回合，期间不能开下一回合', async () => {
    let cleaned = false; let cleanup!: () => void;
    const { engine, create, tools, store } = setup([toolReply], async (_call, _identity, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { cleanup = () => { cleaned = true; reject(new Error('资源已关闭')); }; }, { once: true });
    }));
    const abort = new AbortController(); const turn = create(); const pending = engine.run(turn.id, abort.signal);
    await vi.waitFor(() => expect(tools.execute).toHaveBeenCalledTimes(1)); abort.abort(); await Promise.resolve();
    expect(cleaned).toBe(false); expect(store.get(turn.id).status).toBe('running'); expect(() => create()).toThrow('已有运行回合');
    cleanup(); expect(await pending).toMatchObject({ status: 'cancelled' }); expect(cleaned).toBe(true);
  });
  it('已超过整体时限的回合不会因计时器尚未触发而先发请求', async () => {
    const { engine, create, db, model } = setup(); const turn = create();
    db.run('UPDATE independent_turns SET created_at=? WHERE id=?', Date.now() - limits.timeoutMs - 1, turn.id);
    expect(await engine.run(turn.id)).toMatchObject({ stop: 'timed_out', modelCalls: 0 }); expect(model.complete).not.toHaveBeenCalled();
  });
  it('整体超时和宿主关闭均中止等待，关闭后不能启动新回合', async () => {
    const timeout = setup(); timeout.model.complete.mockImplementation(async () => new Promise(() => {}));
    expect(await timeout.engine.run(timeout.create({ timeoutMs: 10 }).id)).toMatchObject({ stop: 'timed_out' });
    const shutdown = setup(); shutdown.model.complete.mockImplementation(async () => new Promise(() => {})); const pending = shutdown.engine.run(shutdown.create().id);
    await vi.waitFor(() => expect(shutdown.model.complete).toHaveBeenCalledTimes(1)); await shutdown.engine.close();
    expect(await pending).toMatchObject({ stop: 'interrupted' }); await expect(shutdown.engine.run('missing')).rejects.toThrow('已关闭');
  });
  it('绑定核对同步触发关闭也先登记回合，关闭不会漏掉首次请求前的执行器', async () => {
    const { engine, model, create } = setup(); let closing: Promise<void> | undefined;
    model.checkBinding.mockImplementation(() => { closing = engine.close(); });
    expect(await engine.run(create().id)).toMatchObject({ stop: 'interrupted', modelCalls: 0 });
    await closing; expect(model.complete).not.toHaveBeenCalled();
  });
  it('错误工具身份停止循环，不把未知副作用当作普通错误重试', async () => {
    const { engine, model, store, create } = setup([toolReply], async () => ({ role: 'tool', name: 'write', callId: 'wrong', text: '不可信成功', outcome: 'ok' }));
    const turn = create(); expect(await engine.run(turn.id)).toMatchObject({ stop: 'tool_error' });
    expect(model.complete).toHaveBeenCalledTimes(1); expect(store.entries('session')[2]!.message).toMatchObject({ callId: call.id, outcome: 'interrupted' });
  });
  it('重复远端 call ID 不能再次执行，保留未完成状态交由恢复', async () => {
    const { engine, store, tools, create } = setup([toolReply, toolReply]); const turn = create();
    await expect(engine.run(turn.id)).rejects.toThrow('重复使用'); expect(tools.execute).toHaveBeenCalledTimes(1);
    expect(store.get(turn.id).status).toBe('running'); expect(store.recover()[0]).toMatchObject({ status: 'interrupted', outputTokens: null });
  });
  it.each(['claim', 'assistant', 'tool'])('%s 持久化失败不会越过屏障继续请求或执行', async (stage) => {
    const { engine, store, db, model, tools, create } = setup([toolReply, finalReply]); const turn = create(); const original = db.run.bind(db); let failed = false;
    vi.spyOn(db, 'run').mockImplementation((sql, ...args) => {
      const match = stage === 'claim' ? sql.includes('model_calls=model_calls+1') : sql.startsWith('INSERT INTO independent_messages') && String(args[3]).includes(stage === 'assistant' ? '"role":"assistant"' : '"role":"tool"');
      if (match && !failed) { failed = true; throw new Error('fixture-disk-failure'); } return original(sql, ...args);
    });
    await expect(engine.run(turn.id)).rejects.toThrow('fixture-disk-failure'); expect(failed).toBe(true);
    expect(model.complete).toHaveBeenCalledTimes(stage === 'claim' ? 0 : 1); expect(tools.execute).toHaveBeenCalledTimes(stage === 'tool' ? 1 : 0);
    expect(store.get(turn.id).status).toBe('running'); expect(store.recover()[0]!.status).toBe('interrupted');
    expect(store.pending(turn.id)).toEqual([]);
  });
});

describe('原始记录、压缩和跨进程恢复', () => {
  it('压缩只在完整终态回合边界，来源可核查且原始消息不丢失', async () => {
    const { engine, store, model, create } = setup([toolReply, finalReply, finalReply]); const turn = create(); await engine.run(turn.id);
    const original = store.entries('session'); const tail = original.at(-1)!;
    expect(() => store.checkpoint('session', 2, '总结', tail.hash)).toThrow('完整终态');
    expect(() => store.checkpoint('session', tail.seq, '总结', '0'.repeat(64))).toThrow('已变化');
    expect(() => store.checkpoint('session', tail.seq, ' ', tail.hash)).toThrow('总结不能为空');
    const checkpoint = store.checkpoint('session', tail.seq, '用户拒绝的操作不得补做；原文见来源记录', tail.hash);
    const next = create(); expect(store.entries('session').slice(0, original.length)).toEqual(original);
    expect(() => store.checkpoint('session', tail.seq, '覆盖', store.entries('session').at(-1)!.hash)).toThrow('运行中');
    await engine.run(next.id); const request = model.complete.mock.calls.at(-1)![0];
    expect(request.checkpoint).toEqual(checkpoint); expect(request.messages).toEqual([user]);
    expect(store.entries('session')).toHaveLength(original.length + 2);
  });
  it('下一回合不能悄悄更换已有会话的模型或配置修订', async () => {
    const { engine, store, create } = setup(); await engine.run(create().id);
    for (const change of [{ modelId: 'other' }, { serviceId: 'other' }, { configRevision: 2 }, { modelRevision: 2 }]) {
      expect(() => store.create({ ...binding, ...change }, 'session', user, limits)).toThrow('须明确核对');
    }
    expect(store.entries('session')).toHaveLength(2);
  });
  it('消息超限会原子回滚新回合，原始记录保留且不触发模型', () => {
    const { store, db, model } = setup();
    expect(() => store.create(binding, 'session', { ...user, text: '文'.repeat(800_000) }, limits)).toThrow('容量限制');
    expect(store.entries('session')).toEqual([]); expect(db.all('SELECT id FROM independent_turns')).toEqual([]); expect(model.complete).not.toHaveBeenCalled();
  });
  it('原始记录接近总容量时在新请求前暂停，压缩仍保留原文且不绕过容量', async () => {
    const large = { ...finalReply, text: 'x'.repeat(1024 * 1024) };
    const { engine, store, model, db, create } = setup(Array.from({ length: 30 }, () => large));
    let stopped = false; let completed = 0;
    for (let i = 0; i < 30; i++) {
      const result = await engine.run(create().id);
      if (result.stop === 'context_limit') { stopped = true; break; }
      expect(result.status).toBe('completed'); completed++;
      const tail = store.entries('session').at(-1)!; store.checkpoint('session', tail.seq, '保留原文，仅缩短发送上下文', tail.hash);
    }
    expect(stopped).toBe(true); expect(completed).toBeGreaterThan(15); expect(model.complete).toHaveBeenCalledTimes(completed);
    const size = db.get<{ size: number }>('SELECT sum(length(CAST(message_json AS BLOB))) AS size FROM independent_messages')!.size;
    expect(size).toBeLessThanOrEqual(24 * 1024 * 1024); expect(size).toBeGreaterThan(20 * 1024 * 1024);
    expect(store.entries('session').filter((e) => e.message.role === 'assistant')).toHaveLength(completed);
  });
  it('原始记录被修改或缺行会停止，压缩摘要也必须对应原始来源', async () => {
    const { engine, store, db, create } = setup(); const turn = create(); await engine.run(turn.id);
    const tail = store.entries('session').at(-1)!; store.checkpoint('session', tail.seq, '总结', tail.hash);
    db.run('UPDATE independent_checkpoints SET source_hash=?', 'a'.repeat(64)); expect(() => store.context(turn.id)).toThrow('来源摘要不一致');
    db.run('UPDATE independent_messages SET message_json=? WHERE seq=1', JSON.stringify({ ...user, text: '已改写' }));
    expect(() => store.entries('session')).toThrow('记录摘要不一致');
    db.run('UPDATE independent_messages SET message_json=? WHERE seq=1', JSON.stringify(user)); db.run('DELETE FROM independent_messages WHERE seq=1');
    expect(() => store.entries('session')).toThrow('记录摘要不一致');
  });
  it('结果顺序严格匹配、未派发结果与错误归属不能落盘', () => {
    const { store, create } = setup(); const turn = create(); const owner = store.acquire(turn.id); store.claimModel(turn.id, owner);
    store.assistant(turn.id, owner, { ...toolReply, toolCalls: [call, { ...call, id: 'second' }] });
    const result: IndependentToolMessage = { role: 'tool', callId: call.id, name: call.name, text: '', outcome: 'ok' };
    expect(() => store.tool(turn.id, owner, result)).toThrow('未派发'); store.claimTool(turn.id, owner);
    expect(() => store.tool(turn.id, owner, { ...result, callId: 'second' })).toThrow('身份已变化');
    expect(() => store.tool(turn.id, owner, { ...result, name: 'other' })).toThrow('顺序');
    store.tool(turn.id, owner, result); expect(store.pending(turn.id).map((c) => c.id)).toEqual(['second']);
    expect(() => store.finish(turn.id, owner, 'completed')).toThrow('尚未完成');
    expect(() => store.create({ ...binding, taskId: 'other' }, 'session', user, limits)).toThrow('与任务不一致');
  });
  it('大工具结果按真实序列化字节截断并提示，保留后续中断结果空间', () => {
    const { store, create } = setup(); const turn = create(); const owner = store.acquire(turn.id); store.claimModel(turn.id, owner);
    store.assistant(turn.id, owner, { ...toolReply, toolCalls: [call, { ...call, id: 'second' }] }); store.claimTool(turn.id, owner);
    const result = store.tool(turn.id, owner, { role: 'tool', callId: call.id, name: call.name, text: '文'.repeat(1024 * 1024), outcome: 'ok' });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(2 * 1024 * 1024); expect(result.text).toContain('截断');
    store.finish(turn.id, owner, 'interrupted'); expect(store.pending(turn.id)).toEqual([]);
  });
  it('v8 升至当前版本保留旧草稿、会话与发现表，重开不重复迁移', () => {
    const file = path.join(temporary(), 'migration.db'); const current = openDb(file); seed(current);
    current.run("INSERT INTO task_drafts(task_id,text,annotations_json,updated_at) VALUES ('task','原草稿','[]',1)"); current.close();
    const old = new DatabaseSync(file); old.exec('DROP TABLE independent_task_settings; DROP TABLE independent_request_attempts; DROP TABLE independent_request_budgets; DROP TABLE independent_file_receipts; ALTER TABLE independent_tool_calls DROP COLUMN file_outcome_json; DROP TABLE independent_checkpoints; DROP TABLE independent_messages; DROP TABLE independent_turns; PRAGMA user_version=8;'); old.close();
    for (let i = 0; i < 2; i++) { const db = openDb(file); expect(db.get('PRAGMA user_version')).toEqual({ user_version: 12 });
      expect(db.get('SELECT text FROM task_drafts')).toEqual({ text: '原草稿' }); expect(db.all('SELECT * FROM independent_discoveries')).toEqual([]);
      expect(db.get('SELECT id FROM sessions')).toEqual({ id: 'session' });
      expect(new IndependentConversationStore(db).entries('session')).toEqual([]); db.close(); }
  });
  it.each(['requested', 'assistant', 'effect', 'result'])('跨进程在 %s 后崩溃，重开只记录中断、不重放副作用', async (stage) => {
    const directory = temporary(); const ready = path.join(directory, 'ready');
    const fixture = fileURLToPath(new URL('./fixtures/independent-conversation.ts', import.meta.url));
    const tsx = new URL('../../../node_modules/tsx/dist/loader.mjs', import.meta.url).href;
    const helper = spawn(process.execPath, ['--import', tsx, fixture, directory, stage], { windowsHide: true, stdio: 'ignore', env: independentCommandEnv(directory) }); helpers.push(helper);
    await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 10_000 });
    const { turnId, pid } = JSON.parse(readFileSync(ready, 'utf8')) as { turnId: string; pid: number }; expect(pid).toBe(helper.pid);
    await new Promise<void>((resolve) => { helper.once('close', () => resolve()); helper.kill('SIGKILL'); });
    const db = openDb(path.join(directory, 'conversation.db')); databases.push(db); const store = new IndependentConversationStore(db);
    expect(store.recover()[0]).toMatchObject({ id: turnId, status: 'interrupted', modelCalls: 1, outputTokens: stage === 'requested' ? null : 2 });
    expect(store.pending(turnId)).toEqual([]); expect(store.recover()).toEqual([]); expect(() => store.acquire(turnId)).toThrow('已结束');
    const effect = path.join(directory, 'effect.txt'); expect(existsSync(effect)).toBe(['effect', 'result'].includes(stage));
    if (existsSync(effect)) expect(readFileSync(effect, 'utf8')).toBe('只执行一次');
    const result = store.entries('session').at(-1)!.message;
    if (stage !== 'requested') expect(result).toMatchObject({ role: 'tool', outcome: stage === 'result' ? 'ok' : 'interrupted' });
  });
});

describe('循环整合真实 Windows 命令与审批', () => {
  it.each([false, true])('用户允许为 %s：拒绝零副作用，允许后命令落盘只执行一次', async (allowed) => {
    const directory = temporary(); const effect = path.join(directory, 'effect.txt');
    const context = setup([toolReply, finalReply]); const journal = new IndependentToolJournal(context.db);
    const executor = new IndependentCommandExecutor(directory); executors.push(executor); const command = new IndependentCommandTool(journal, executor);
    const spec = IndependentCommandSpec.parse({ program: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(effect)},'命令实操成功');process.stdout.write('已验证')`], timeoutMs: 10_000, maxOutputBytes: 4096 });
    context.tools.execute.mockImplementation(async (input, identity, signal) => {
      const intent = command.prepare({ ...identity, callId: input.id }, spec, directory, '用户逐次审批');
      if (!allowed) { journal.reject(intent.id); return { role: 'tool', callId: input.id, name: input.name, text: '用户拒绝执行命令', outcome: 'rejected' }; }
      journal.approve(intent.id); const result = await command.execute(intent.id, spec, { cwd: directory, approvalBasis: '用户逐次审批', signal });
      return { role: 'tool', callId: input.id, name: input.name, text: result.stdout, outcome: result.reason === 'completed' && result.exitCode === 0 ? 'ok' : 'error' };
    });
    const turn = context.create(); expect((await context.engine.run(turn.id)).status).toBe('completed');
    expect(existsSync(effect)).toBe(allowed); if (allowed) expect(readFileSync(effect, 'utf8')).toBe('命令实操成功');
    expect(context.store.entries('session')[2]!.message).toMatchObject({ outcome: allowed ? 'ok' : 'rejected' });
    expect(context.db.all('SELECT state FROM independent_tool_calls')).toEqual([{ state: allowed ? 'succeeded' : 'rejected' }]);
    expect(JSON.stringify(context.db.all('SELECT * FROM independent_tool_calls'))).not.toContain('命令实操成功');
  });
  it('命令执行期间取消，循环等宿主退出后才保存取消终态', async () => {
    const directory = temporary(); const marker = path.join(directory, 'pid.txt'); const context = setup([toolReply]);
    const journal = new IndependentToolJournal(context.db); const executor = new IndependentCommandExecutor(directory); executors.push(executor);
    const command = new IndependentCommandTool(journal, executor);
    const spec = IndependentCommandSpec.parse({ program: process.execPath,
      args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`], timeoutMs: 10_000, maxOutputBytes: 4096 });
    let cleaned = false;
    context.tools.execute.mockImplementation(async (input, identity, signal) => {
      const record = command.prepare({ ...identity, callId: input.id }, spec, directory, '逐次审批'); journal.approve(record.id);
      const result = await command.execute(record.id, spec, { cwd: directory, approvalBasis: '逐次审批', signal }); cleaned = true;
      return { role: 'tool', callId: input.id, name: input.name, text: result.stdout, outcome: 'cancelled' };
    });
    const turn = context.create(); const abort = new AbortController(); const pending = context.engine.run(turn.id, abort.signal);
    await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 10_000 });
    const pid = Number(readFileSync(marker, 'utf8')); abort.abort(); expect((await pending).status).toBe('cancelled'); expect(cleaned).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(context.db.all('SELECT state FROM independent_tool_calls')).toEqual([{ state: 'cancelled' }]);
    expect(context.store.pending(turn.id)).toEqual([]); expect(context.model.complete).toHaveBeenCalledTimes(1);
  });
});

// 2026-11-10：等待用户审批的时间不计入回合时限（真实补验中一次未处理的审批让回合超时失败）
describe('审批等待不计入回合时限', () => {
  it('工具在审批中暂停计时：等待超过时限后批准，回合照常完成', async () => {
    const { engine, create } = setup([toolReply, finalReply], async (input, _identity, _signal, ...rest: unknown[]) => {
      const clock = rest[0] as { pause(): void; resume(): void } | undefined;
      clock?.pause(); await new Promise((r) => setTimeout(r, 120)); clock?.resume();
      return { role: 'tool', callId: input.id, name: input.name, text: '已批准并执行', outcome: 'ok' };
    });
    expect(await engine.run(create({ timeoutMs: 60 }).id)).toMatchObject({ stop: 'completed', toolCalls: 1 });
  });
  it('对照：工具不暂停计时时，同样的等待会让回合超时', async () => {
    const { engine, create } = setup([toolReply, finalReply], async (input) => {
      await new Promise((r) => setTimeout(r, 120));
      return { role: 'tool', callId: input.id, name: input.name, text: '已执行', outcome: 'ok' };
    });
    expect(await engine.run(create({ timeoutMs: 60 }).id)).toMatchObject({ stop: 'timed_out' });
  });
  it('审批结束后恢复计时，后续耗时仍受时限约束', async () => {
    const { engine, model, create } = setup([toolReply], async (input, _identity, _signal, ...rest: unknown[]) => {
      const clock = rest[0] as { pause(): void; resume(): void } | undefined;
      clock?.pause(); await new Promise((r) => setTimeout(r, 120)); clock?.resume();
      return { role: 'tool', callId: input.id, name: input.name, text: 'ok', outcome: 'ok' };
    });
    model.complete.mockImplementationOnce(async () => toolReply).mockImplementationOnce(async () => new Promise(() => {}));
    expect(await engine.run(create({ timeoutMs: 80 }).id)).toMatchObject({ stop: 'timed_out', toolCalls: 1 });
  });
});
