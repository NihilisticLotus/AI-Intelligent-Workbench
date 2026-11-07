// 独立执行器选型验证：依赖只装在 .aic-data，默认 npm test 不加载候选包。
// 本脚本使用假模型和受限文件工具，不是正式 Agent，也不证明任意命令已形成系统沙箱。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), '../..');
const directory = path.join(root, '.aic-data/independent-agent-poc');
const packages = ['pi-agent-core', 'pi-ai', 'pi-schema'];

if (!process.argv.includes('--worker')) {
  // 准备和启动只由外层执行；受限子进程没有启动其他进程的权限。
  const lock = JSON.parse(fs.readFileSync(path.join(directory, 'package-lock.json'), 'utf8'));
  for (const name of packages) {
    const entry = lock.packages[`node_modules/@earendil-works/${name}`];
    assert.equal(entry?.version, '1.5.0', '候选包必须固定到已核查版本');
    assert.ok(entry.integrity?.startsWith('sha512-'), '锁文件必须记录发行包完整性');
    assert.ok(!entry.hasInstallScript, '不能在验证中运行候选安装脚本');
  }
  const workspace = fs.mkdtempSync(path.join(directory, 'run-'));
  const environment = Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP'].flatMap((key) =>
    process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  const child = spawn(process.execPath, [
    '--permission',
    `--allow-fs-read=${path.join(directory, 'node_modules')}`,
    `--allow-fs-read=${path.join(directory, 'package.json')}`,
    `--allow-fs-read=${workspace}`,
    `--allow-fs-read=${script}`,
    `--allow-fs-write=${workspace}`,
    script, '--worker', workspace,
  ], {
    cwd: workspace, stdio: 'inherit', windowsHide: true,
    env: {
      ...environment,
      HOME: path.join(directory, 'forbidden-global'),
      USERPROFILE: path.join(directory, 'forbidden-global'),
      OPENAI_API_KEY: 'poc-ambient-decoy',
      ANTHROPIC_API_KEY: 'poc-ambient-decoy',
      OPENAI_BASE_URL: 'https://ambient.invalid/v1',
    },
  });
  const timer = setTimeout(() => child.kill(), 45_000);
  child.on('error', () => { clearTimeout(timer); process.exitCode = 1; });
  child.on('exit', (code) => {
    clearTimeout(timer); process.exitCode = code ?? 1;
    if (code !== 0) return;
    try {
      const report = JSON.parse(fs.readFileSync(path.join(workspace, 'result.json'), 'utf8'));
      report.packages = packages.map((name) => {
        const entry = lock.packages[`node_modules/@earendil-works/${name}`];
        return { name: `@earendil-works/${name}`, version: entry.version, integrity: entry.integrity };
      });
      report.lockSha256 = createHash('sha256').update(fs.readFileSync(path.join(directory, 'package-lock.json'))).digest('hex');
      report.lockPackageCount = Object.keys(lock.packages).length - 1;
      fs.writeFileSync(path.join(directory, 'last-report.json'), `${JSON.stringify(report, null, 2)}\n`);
    } catch {
      console.error('无法保存独立执行器验证报告'); process.exitCode = 1;
    }
  });
} else {
  await verify(process.argv.at(-1));
}

async function verify(workspace) {
  assert.ok(process.permission, '必须通过外层脚本启动受限验证进程');
  assert.equal(process.permission.has('child'), false, '验证进程不能启动其他程序');
  assert.equal(process.permission.has('fs.read', path.join(directory, 'forbidden-global')), false, '禁止读取模拟全局配置目录');
  const checks = [];
  const check = (name, execute) => test(name, async () => {
    const result = { name, passed: false }; checks.push(result);
    await execute(); result.passed = true;
  });
  const forbiddenReads = [];
  const networkAttempts = [];
  const saveReport = async () => {
    await fsp.writeFile(path.join(workspace, 'result.json'), `${JSON.stringify({
      schemaVersion: 1, checkedAt: new Date().toISOString(), node: process.version, platform: process.platform,
      mode: '离线候选验证，非正式执行器验收', checks,
      monitoredFileViolations: forbiddenReads.length, monitoredNetworkAttempts: networkAttempts.length,
      childProcessAllowed: process.permission.has('child'),
      unverified: ['Windows 命令及进程树取消', 'worker / Gateway 崩溃恢复与副作用核对', '多任务并发与路径攻击',
        '压缩质量与真实 token 预算', '图片及推理参数', '真实网络、账号、模型与费用', '正式接口、数据库与界面集成', '操作系统网络沙箱'],
    }, null, 2)}\n`);
  };
  const allowed = [workspace, path.join(directory, 'node_modules'), path.join(directory, 'package.json'), script];
  const within = (candidate, base) => {
    const relative = path.relative(base, candidate);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
  };
  const inspectRead = (target) => {
    if (typeof target === 'number') return;
    if (target instanceof URL) target = fileURLToPath(target);
    if (Buffer.isBuffer(target)) target = target.toString();
    if (typeof target !== 'string') return;
    const absolute = path.resolve(target);
    if (!allowed.some((base) => within(absolute, base))) {
      forbiddenReads.push(absolute);
      throw new Error('候选包尝试访问验证范围以外的文件');
    }
  };
  for (const object of [fs, fsp]) {
    for (const name of ['readFile', 'readFileSync', 'open', 'openSync', 'access', 'accessSync',
      'stat', 'statSync', 'lstat', 'lstatSync', 'realpath', 'realpathSync', 'readdir', 'readdirSync', 'createReadStream', 'watch']) {
      if (typeof object[name] !== 'function') continue;
      const original = object[name];
      object[name] = function (target, ...args) { inspectRead(target); return original.call(this, target, ...args); };
    }
  }
  const prohibitNetwork = () => {
    networkAttempts.push('blocked');
    throw new Error('离线验证禁止真实网络');
  };
  globalThis.fetch = prohibitNetwork;
  for (const [object, names] of [
    [http, ['request', 'get']], [https, ['request', 'get']],
    [net, ['connect', 'createConnection']], [tls, ['connect']], [dgram, ['createSocket']],
    [net.Socket.prototype, ['connect']],
  ]) for (const name of names) object[name] = prohibitNetwork;
  syncBuiltinESMExports();

  const load = async (specifier) => {
    // 候选仅导出 ESM import；不能用 require.resolve 的 require 条件寻找入口。
    const [, name, suffix = ''] = /^(@[^/]+\/[^/]+)(.*)$/.exec(specifier);
    const location = path.join(directory, 'node_modules', name);
    const manifest = JSON.parse(await fsp.readFile(path.join(location, 'package.json'), 'utf8'));
    const subpath = suffix ? `.${suffix}` : '.';
    let entry = manifest.exports[subpath]?.import;
    if (!entry) {
      for (const [pattern, conditions] of Object.entries(manifest.exports)) {
        if (!pattern.endsWith('/*') || !subpath.startsWith(pattern.slice(0, -1))) continue;
        entry = conditions.import.replace('*', subpath.slice(pattern.length - 1)); break;
      }
    }
    assert.ok(entry?.startsWith('./dist/'), '验证只加载候选声明的 ESM 导出');
    return import(pathToFileURL(path.join(location, entry)).href);
  };
  const { Agent } = await load('@earendil-works/pi-agent-core');
  const { AssistantMessageEventStream } = await load('@earendil-works/pi-ai/utils/event-stream');
  const chat = await load('@earendil-works/pi-ai/api/openai-completions');
  const responses = await load('@earendil-works/pi-ai/api/openai-responses');
  const anthropic = await load('@earendil-works/pi-ai/api/anthropic-messages');
  const model = {
    id: 'poc-model', name: '离线假模型', api: 'openai-completions', provider: 'aic-poc-a',
    baseUrl: 'https://service-a.invalid/custom/v1', reasoning: false, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 512,
  };
  const usage = () => ({ input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
  const message = (content, stopReason = 'stop') => ({
    role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
    stopReason, usage: usage(), timestamp: Date.now(),
  });
  const toolCall = (name, args, id = name) => ({ type: 'toolCall', id, name, arguments: args });
  const textResult = (text) => ({ content: [{ type: 'text', text }] });
  const textOf = (value) => value.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
  const streamResult = (result) => {
    const stream = new AssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: 'start', partial: result });
      if (['error', 'aborted'].includes(result.stopReason))
        stream.push({ type: 'error', reason: result.stopReason, error: result });
      else stream.push({ type: 'done', reason: result.stopReason, message: result });
    });
    return stream;
  };
  const scripted = (steps, observe = () => {}) => {
    let index = 0;
    return (_model, context) => {
      observe(context, index);
      assert.ok(index < steps.length, '假模型调用次数超过脚本上限');
      return streamResult(steps[index++]);
    };
  };
  const make = (options) => new Agent({
    toolExecution: 'sequential', identity: { attribution: null },
    ...options, initialState: { model, ...options.initialState },
  });
  const schema = { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false };
  const define = (name, execute) => ({ name, label: name, description: '离线验证工具', parameters: schema, execute });
  const target = path.join(workspace, 'fixture.txt');
  await fsp.writeFile(target, '旧内容\r\n', 'utf8');

  await check('搜索、读取和实际编辑形成连续工具闭环，结果进入下一次请求', async () => {
    const seen = [];
    const tools = [
      define('search', async () => textResult((await fsp.readdir(workspace)).filter((name) => name.endsWith('.txt')).join('\n'))),
      define('read', async () => textResult(await fsp.readFile(target, 'utf8'))),
      define('edit', async (_id, { value }) => {
        assert.equal(await fsp.readFile(target, 'utf8'), '旧内容\r\n');
        await fsp.writeFile(target, value, 'utf8'); return textResult('已修改');
      }),
    ];
    const agent = make({ initialState: { tools }, streamFn: scripted([
      message([toolCall('search', { value: '' })], 'toolUse'),
      message([toolCall('read', { value: '' })], 'toolUse'),
      message([toolCall('edit', { value: '新内容\r\n' })], 'toolUse'),
      message([{ type: 'text', text: '完成' }]),
    ], (context) => seen.push(structuredClone(context.messages))) });
    await agent.prompt('搜索后读取并修改临时文件');
    assert.equal(await fsp.readFile(target, 'utf8'), '新内容\r\n');
    assert.equal(seen.length, 4);
    assert.equal(seen.at(-1).filter((m) => m.role === 'toolResult').length, 3);
    assert.match(textOf(seen[2].find((m) => m.role === 'toolResult' && m.toolName === 'read')), /旧内容/);
    assert.equal(agent.state.isStreaming, false);
  });

  await check('审批等待前保存调用；拒绝不执行且理由进入后续模型上下文', async () => {
    let executed = false;
    const entered = Promise.withResolvers();
    const decision = Promise.withResolvers();
    const journal = [];
    const agent = make({
      initialState: { tools: [define('edit', async () => { executed = true; return textResult('不应执行'); })] },
      beforeToolCall: async ({ toolCall: call }) => {
        journal.push({ id: call.id, state: 'pending' });
        await fsp.writeFile(path.join(workspace, 'approval.json'), JSON.stringify(journal));
        entered.resolve();
        await decision.promise;
        return { block: true, reason: '用户拒绝：保留原文件' };
      },
      streamFn: scripted([message([toolCall('edit', { value: '替换' })], 'toolUse'), message([{ type: 'text', text: '保留' }])], (context, index) => {
        if (index === 1) assert.match(textOf(context.messages.find((m) => m.role === 'toolResult')), /用户拒绝：保留原文件/);
      }),
    });
    const running = agent.prompt('请求修改');
    await entered.promise;
    assert.equal(executed, false);
    assert.equal(JSON.parse(await fsp.readFile(path.join(workspace, 'approval.json'), 'utf8'))[0].state, 'pending');
    decision.resolve(); await running;
    assert.equal(executed, false);
    assert.equal(agent.state.messages.find((m) => m.role === 'toolResult').isError, true);
  });

  await check('审批期间文件变动由宿主冲突检查阻断，候选循环保留错误结果', async () => {
    const expected = await fsp.readFile(target, 'utf8');
    const agent = make({
      initialState: { tools: [define('edit', async () => {
        if (await fsp.readFile(target, 'utf8') !== expected) throw new Error('文件已变化，请重新审批');
        await fsp.writeFile(target, '不应覆盖'); return textResult('完成');
      })] },
      beforeToolCall: async () => { await fsp.writeFile(target, '用户的新修改'); },
      streamFn: scripted([message([toolCall('edit', { value: '修改' })], 'toolUse'), message([{ type: 'text', text: '停止覆盖' }])]),
    });
    await agent.prompt('请求修改');
    assert.equal(await fsp.readFile(target, 'utf8'), '用户的新修改');
    assert.match(textOf(agent.state.messages.find((m) => m.role === 'toolResult')), /文件已变化/);
  });

  await check('原始循环会将数字强制转换成字符串，宿主不能仅依赖其校验', async () => {
    let received;
    const agent = make({ initialState: { tools: [define('edit', async (_id, args) => { received = args.value; return textResult('已观察'); })] },
      streamFn: scripted([message([toolCall('edit', { value: 123 })], 'toolUse'), message([])]) });
    await agent.prompt('观察候选默认转换');
    assert.equal(received, '123');
  });

  await check('宿主严格检查原始参数后，类型错误和未注册工具不触发执行', async () => {
    let executed = false;
    const agent = make({
      initialState: { tools: [define('edit', async () => { executed = true; return textResult('不应执行'); })] },
      beforeToolCall: async ({ toolCall: call }) => {
        if (typeof call.arguments.value !== 'string') return { block: true, reason: '原始参数类型无效' };
      },
      streamFn: scripted([message([toolCall('edit', { value: 123 }), toolCall('unknown', {})], 'toolUse'), message([])]),
    });
    await agent.prompt('无效工具请求');
    assert.equal(executed, false);
    const results = agent.state.messages.filter((m) => m.role === 'toolResult');
    assert.equal(results.length, 2); assert.ok(results.every((m) => m.isError));
  });

  await check('截断的工具调用即使参数完整也不执行', async () => {
    let executed = false;
    const agent = make({ initialState: { tools: [define('edit', async () => { executed = true; return textResult('不应执行'); })] },
      streamFn: scripted([message([toolCall('edit', { value: '修改' })], 'length'), message([])]) });
    await agent.prompt('模拟输出截断');
    assert.equal(executed, false);
  });

  await check('异步事件订阅可在工具开始前完成持久化', async () => {
    const journal = [];
    const agent = make({ initialState: { tools: [define('edit', async (_id) => {
      const stored = JSON.parse(await fsp.readFile(path.join(workspace, 'intent.json'), 'utf8'));
      assert.equal(stored.id, 'edit'); journal.push('execute'); return textResult('完成');
    })] }, streamFn: scripted([message([toolCall('edit', { value: '修改' })], 'toolUse'), message([])]) });
    agent.subscribe(async (event) => {
      if (event.type === 'tool_execution_start') {
        await fsp.writeFile(path.join(workspace, 'intent.json'), JSON.stringify({ id: event.toolCallId }));
        journal.push('persist');
      }
    });
    await agent.prompt('先记录后执行'); assert.deepEqual(journal, ['persist', 'execute']);
  });

  await check('记录失败阻止执行但返回 error 终态；不以 Promise resolve 当作成功', async () => {
    let executed = false;
    const agent = make({ initialState: { tools: [define('edit', async () => { executed = true; return textResult('不应执行'); })] },
      streamFn: scripted([message([toolCall('edit', { value: '修改' })], 'toolUse')]) });
    agent.subscribe((event) => { if (event.type === 'tool_execution_start') throw new Error('模拟记录失败'); });
    await agent.prompt('记录失败');
    await agent.waitForIdle(); assert.equal(executed, false); assert.equal(agent.state.isStreaming, false);
    assert.equal(agent.state.messages.at(-1).stopReason, 'error');
    assert.match(agent.state.errorMessage, /模拟记录失败/);
    // SDK 不自动填补这个中断位置的工具结果；生产适配层必须结合事务记录恢复。
    assert.equal(agent.state.messages.filter((m) => m.role === 'toolResult').length, 0);
  });

  await check('串行配置确保同轮副作用按调用顺序执行', async () => {
    const order = [];
    const agent = make({ initialState: { tools: [define('edit', async (id) => {
      order.push(`start:${id}`); await new Promise((resolve) => setTimeout(resolve, 5)); order.push(`end:${id}`); return textResult(id);
    })] }, streamFn: scripted([message([toolCall('edit', { value: '一' }, 'one'), toolCall('edit', { value: '二' }, 'two')], 'toolUse'), message([])]) });
    await agent.prompt('串行修改'); assert.deepEqual(order, ['start:one', 'end:one', 'start:two', 'end:two']);
  });

  await check('等待审批时取消可经 AbortSignal 结束且工具不执行', async () => {
    const entered = Promise.withResolvers(); let executed = false;
    const agent = make({ initialState: { tools: [define('edit', async () => { executed = true; return textResult('不应执行'); })] },
      beforeToolCall: async (_context, signal) => {
        entered.resolve();
        await new Promise((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
        return { block: true, reason: '用户取消', terminate: true };
      }, streamFn: scripted([message([toolCall('edit', { value: '修改' })], 'toolUse')]) });
    const running = agent.prompt('等待审批'); await entered.promise; agent.abort(); await running; await agent.waitForIdle();
    assert.equal(executed, false); assert.equal(agent.state.isStreaming, false); assert.equal(agent.state.pendingToolCalls.size, 0);
  });

  await check('模型慢流取消后保留 aborted 终态并返回空闲', async () => {
    const entered = Promise.withResolvers();
    const agent = make({ streamFn: (_model, _context, options) => {
      const stream = new AssistantMessageEventStream();
      const aborted = () => {
        const result = { ...message([], 'aborted'), errorMessage: '已取消' };
        stream.push({ type: 'error', reason: 'aborted', error: result });
      };
      options.signal.addEventListener('abort', aborted, { once: true }); entered.resolve(); return stream;
    } });
    const running = agent.prompt('模拟慢流'); await entered.promise; agent.abort(); await running;
    assert.equal(agent.state.messages.at(-1).stopReason, 'aborted'); assert.equal(agent.state.isStreaming, false);
  });

  await check('取消正在执行的协作工具，不再执行同批排队工具', async () => {
    const entered = Promise.withResolvers(); const executed = [];
    const agent = make({ initialState: { tools: [define('edit', async (id, _args, signal) => {
      executed.push(id); entered.resolve();
      await new Promise((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
      throw new Error('工具已取消');
    })] }, streamFn: scripted([message([toolCall('edit', { value: '一' }, 'one'), toolCall('edit', { value: '二' }, 'two')], 'toolUse')]) });
    const running = agent.prompt('执行中取消'); await entered.promise; agent.abort(); await running;
    assert.deepEqual(executed, ['one']); assert.equal(agent.state.pendingToolCalls.size, 0);
  });

  await check('宿主可在每次模型请求前阻断超预算输入', async () => {
    let calls = 0;
    const agent = make({ prepareRequest: async () => { throw new Error('上下文预算不足'); },
      streamFn: () => { calls++; return streamResult(message([])); } });
    await agent.prompt('需要预算检查');
    assert.equal(calls, 0); assert.equal(agent.state.messages.at(-1).stopReason, 'error');
    assert.match(agent.state.errorMessage, /上下文预算不足/);
  });

  await check('已完成工具的记录可恢复到新实例，续聊不重放副作用', async () => {
    let executed = 0;
    const tool = define('edit', async () => { executed++; return textResult('执行一次'); });
    const first = make({ initialState: { tools: [tool] }, streamFn: scripted([message([toolCall('edit', { value: '一次' })], 'toolUse'), message([])]) });
    await first.prompt('执行');
    const history = path.join(workspace, 'history.json'); await fsp.writeFile(history, JSON.stringify(first.state.messages));
    const restored = make({ initialState: { tools: [tool], messages: JSON.parse(await fsp.readFile(history, 'utf8')) },
      streamFn: scripted([message([{ type: 'text', text: '已知此前结果' }])], (context) => {
        assert.equal(context.messages.filter((m) => m.role === 'toolResult').length, 1);
      }) });
    await restored.prompt('继续说明'); assert.equal(executed, 1);
  });

  const context = { messages: [{ role: 'user', content: '离线请求', timestamp: Date.now() }] };
  const sse = () => new Response([
    { id: 'poc', object: 'chat.completion.chunk', created: 1, model: model.id, choices: [{ index: 0, delta: { role: 'assistant', content: '离线回复' }, finish_reason: null }] },
    { id: 'poc', object: 'chat.completion.chunk', created: 1, model: model.id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
  ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });

  await check('同名模型在两个显式服务下不串地址、Key 和模型请求', async () => {
    for (const service of ['a', 'b']) {
      const selected = { ...model, provider: `aic-poc-${service}`, baseUrl: `https://service-${service}.invalid/custom/v1` };
      let calls = 0;
      const result = await chat.stream(selected, context, { apiKey: `poc-explicit-${service}`, maxRetries: 0, identity: { attribution: null },
        fetch: async (url, options) => {
          calls++; assert.equal(String(url), `${selected.baseUrl}/chat/completions`);
          assert.equal(new Headers(options.headers).get('authorization'), `Bearer poc-explicit-${service}`);
          assert.equal(JSON.parse(options.body).model, model.id); return sse();
        } }).result();
      assert.equal(calls, 1); assert.equal(result.stopReason, 'stop'); assert.equal(result.usage.totalTokens, 12);
    }
  });

  await check('直接协议适配器缺 Key 时不回退到诱饵环境认证', async () => {
    let calls = 0;
    const result = await chat.stream(model, context, { fetch: async () => { calls++; return sse(); }, maxRetries: 0 }).result();
    assert.equal(calls, 0); assert.equal(result.stopReason, 'error');
  });

  await check('401 不自动切服务，明确关闭重试后只请求一次', async () => {
    let calls = 0;
    const result = await chat.stream(model, context, { apiKey: 'poc-explicit-a', maxRetries: 0,
      fetch: async (url) => { calls++; assert.equal(String(url), `${model.baseUrl}/chat/completions`);
        return new Response(JSON.stringify({ error: { message: '离线模拟认证失败' } }), { status: 401, headers: { 'content-type': 'application/json' } });
      } }).result();
    assert.equal(calls, 1); assert.equal(result.stopReason, 'error');
  });

  await check('真实协议解析的工具分片可驱动工具执行与第二轮续传', async () => {
    let rounds = 0; let executed = 0;
    const toolSse = () => new Response([
      { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'wire-call', type: 'function', function: { name: 'edit', arguments: '{"value":' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"协议结果"}' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ].map((chunk) => `data: ${JSON.stringify({ id: 'poc-wire', object: 'chat.completion.chunk', created: 1, model: model.id, ...chunk })}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    const agent = make({ initialState: { tools: [define('edit', async (_id, { value }) => {
      await fsp.writeFile(path.join(workspace, 'wire.txt'), value); executed++; return textResult('工具已执行');
    })] }, streamFn: (selected, transcript, options) => chat.stream(selected, transcript, {
      ...options, apiKey: 'poc-explicit-a', maxRetries: 0,
      fetch: async (_url, request) => {
        const body = JSON.parse(request.body);
        if (rounds++ === 0) { assert.equal(body.tools[0].function.name, 'edit'); return toolSse(); }
        assert.equal(rounds, 2);
        assert.ok(body.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'wire-call' && m.content.includes('工具已执行')));
        return sse();
      },
    }) });
    await agent.prompt('通过协议调用工具');
    assert.equal(executed, 1); assert.equal(rounds, 2);
    assert.equal(await fsp.readFile(path.join(workspace, 'wire.txt'), 'utf8'), '协议结果');
  });

  await check('原始适配器缺地址会同步抛错，宿主必须先校验并统一错误', () => {
    let called = false;
    assert.throws(() => chat.stream({ ...model, baseUrl: undefined }, context, { apiKey: 'poc-explicit-a', maxRetries: 0,
      fetch: async () => { called = true; return sse(); } }), TypeError);
    assert.equal(called, false);
  });

  // 仅用于验证可插入约束的位置。生产实现应复用正式协议校验和错误类型。
  const boundFetch = (selected, key, transport) => {
    assert.ok(typeof key === 'string' && key.trim(), '必须显式提供 Key');
    assert.ok(typeof selected.baseUrl === 'string' && selected.baseUrl.trim(), '必须显式提供地址');
    const endpoint = new URL(`${selected.baseUrl.replace(/\/$/, '')}/chat/completions`);
    assert.equal(endpoint.protocol, 'https:', '本验证仅允许 HTTPS');
    assert.ok(!endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash);
    return async (url, options) => {
      assert.equal(String(url), endpoint.href, '不能越过所选服务和路径');
      assert.equal(new Headers(options.headers).get('authorization'), `Bearer ${key}`, '认证必须属于所选服务');
      const response = await transport(url, { ...options, redirect: 'error' });
      assert.ok(response.status < 300 || response.status >= 400, '不能接受重定向');
      assert.ok(!response.redirected && (!response.url || response.url === endpoint.href), '不能接受跨地址结果');
      return response;
    };
  };

  await check('宿主边界拒绝缺地址、缺 Key、跨地址和认证替换', async () => {
    assert.throws(() => boundFetch({ ...model, baseUrl: '' }, 'poc-explicit-a', sse), /必须显式提供地址/);
    assert.throws(() => boundFetch(model, '', sse), /必须显式提供 Key/);
    let calls = 0;
    const fetch = boundFetch(model, 'poc-explicit-a', async () => { calls++; return sse(); });
    await assert.rejects(fetch('https://other.invalid/chat/completions', {}), /不能越过/);
    await assert.rejects(fetch(`${model.baseUrl}/chat/completions`, { headers: { authorization: 'Bearer poc-wrong' } }), /认证必须/);
    assert.equal(calls, 0);
  });

  await check('SDK 可注入禁止重定向的传输；302 不重试或改走另一服务', async () => {
    let calls = 0;
    const result = await chat.stream(model, context, { apiKey: 'poc-explicit-a', maxRetries: 0,
      fetch: boundFetch(model, 'poc-explicit-a', async (_url, options) => {
        calls++; assert.equal(options.redirect, 'error');
        return new Response(null, { status: 302, headers: { location: 'https://other.invalid/' } });
      }),
    }).result();
    assert.equal(calls, 1); assert.equal(result.stopReason, 'error');
  });

  await check('流缺 usage 时 SDK 返回零；宿主需另记是否报告，不能当作实际零用量', async () => {
    let reported = false;
    const result = await chat.stream(model, context, { apiKey: 'poc-explicit-a', maxRetries: 0,
      onProviderStreamEvent: (event) => { if (event.usage) reported = true; },
      fetch: async () => new Response(`data: ${JSON.stringify({ id: 'missing-usage', object: 'chat.completion.chunk', created: 1, model: model.id,
        choices: [{ index: 0, delta: { content: '无用量报告' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } }),
    }).result();
    assert.equal(result.stopReason, 'stop'); assert.equal(result.usage.totalTokens, 0); assert.equal(reported, false);
  });

  await check('Responses 显式服务与 Key 支持无 DONE 标记的终态流', async () => {
    const selected = { ...model, api: 'openai-responses', provider: 'aic-poc-responses' };
    const item = { id: 'poc-item', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '离线回复', annotations: [] }] };
    const events = [
      { type: 'response.created', response: { id: 'poc-response', status: 'in_progress' } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
      { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: '离线回复' },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: 'poc-response', status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } },
    ];
    let calls = 0;
    const result = await responses.stream(selected, context, { apiKey: 'poc-responses', maxRetries: 0,
      fetch: async (url, options) => {
        calls++; assert.equal(String(url), `${model.baseUrl}/responses`);
        assert.equal(new Headers(options.headers).get('authorization'), 'Bearer poc-responses');
        return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
      },
    }).result();
    assert.equal(calls, 1); assert.equal(result.stopReason, 'stop', result.errorMessage); assert.equal(textOf(result), '离线回复'); assert.equal(result.usage.totalTokens, 12);
  });

  await check('Anthropic Messages 显式服务与 Key 可解析消息流和用量', async () => {
    const selected = { ...model, api: 'anthropic-messages', provider: 'aic-poc-messages', baseUrl: 'https://service-c.invalid/custom' };
    const events = [
      { type: 'message_start', message: { id: 'poc-anthropic', type: 'message', role: 'assistant', model: model.id, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '离线回复' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ];
    let calls = 0; let requestUrl; let requestKey;
    const result = await anthropic.stream(selected, context, { apiKey: 'poc-messages', maxRetries: 0,
      fetch: async (url, options) => {
        calls++; requestUrl = String(url); requestKey = new Headers(options.headers).get('x-api-key');
        return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
      },
    }).result();
    assert.equal(requestUrl, `${selected.baseUrl}/v1/messages?beta=true`); assert.equal(requestKey, 'poc-messages');
    assert.equal(calls, 1); assert.equal(result.stopReason, 'stop', result.errorMessage); assert.equal(textOf(result), '离线回复'); assert.equal(result.usage.totalTokens, 12);
  });

  for (const [api, adapter] of [['openai-responses', responses], ['anthropic-messages', anthropic]]) {
    await check(`${api} 缺显式 Key 时不使用宿主诱饵认证`, async () => {
      let calls = 0;
      const result = await adapter.stream({ ...model, api }, context, { maxRetries: 0,
        fetch: async () => { calls++; return sse(); } }).result();
      assert.equal(calls, 0); assert.equal(result.stopReason, 'error');
    });
  }

  await check('导入及上述场景的监控未发现越界读文件或真实网络尝试', () => {
    assert.deepEqual(forbiddenReads, []); assert.deepEqual(networkAttempts, []);
    assert.equal(process.permission.has('child'), false);
    assert.equal(process.permission.has('fs.read', path.join(directory, 'forbidden-global')), false);
  });
  await saveReport();
}
