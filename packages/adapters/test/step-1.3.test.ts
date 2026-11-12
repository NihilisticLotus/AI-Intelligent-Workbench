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
  it('错误开头后追加解释、示例或引用时仍是正常回答', () => {
    for (const reply of [
      "The 'alpha' model is not supported 表示当前账号没有这个模型的访问权限。",
      "The 'alpha' model is not supported when using Codex with a ChatGPT account. 这句话是报错示例。",
      'model is not supported means the selected model cannot be used.',
      'model is not supported\n请核对模型 ID。',
      'upstream_status: HTTP 400 bad request 表示请求格式有问题。',
      'upstream_status: HTTP 400: 这是你贴出的日志，不是本轮调用失败。',
      'API Error: Request rejected (429) quota 说明额度不足，可以等待恢复。',
      'API Error: Request rejected (429) · upstream account quota usage limit has been reached; 这是说明文字。',
      'API Error: Request rejected\n例如请求参数不正确时会这样显示。',
    ]) expect(textResponseError(reply, 'codex', 'Codex'), reply).toBeNull();
  });
  it('完整模型拒绝与真实额度句式保留，固定 Codex 代理封套规则不变', () => {
    for (const reply of ["The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account", "The 'x' model is not supported.", 'model is not supported', 'upstream_status: HTTP 400 bad request']) expect(textResponseError(reply, 'codex', 'Codex')).toMatchObject({ reason: 'invalid_value' });
    for (const reply of ['API Error: Request rejected (429) · upstream account quota usage limit has been reached', 'API Error: Request rejected (429) · upstream account quota usage limit has been reached; wait for quota to reset or use an account with available quota']) expect(textResponseError(reply, 'claude', 'Claude Code')).toMatchObject({ reason: 'quota' });
    expect(textResponseError(proxyError.replaceAll('alpha', 'gpt-5.5'), 'codex', 'Codex')).toMatchObject({ reason: 'invalid_value' });
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

// ISSUE-0052：子进程被外部结束时，父进程还在写 stdin 会 EPIPE。没有监听时 Node 把流错误当未捕获异常，整个 Gateway 退出。
describe('子进程管道错误不会让宿主退出', () => {
  // 用独立 Node 进程模拟 Gateway：子进程被结束后持续写入 stdin；未处理的错误会让它非零退出
  const script = (guard: string) => `
    const { spawn, execFileSync } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'pipe', windowsHide: true });
    ${guard}
    child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
    setTimeout(() => { if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); else child.kill('SIGKILL'); }, 200);
    let n = 0; const w = () => { if (n++ > 120) { console.log('ALIVE'); process.exit(0); } child.stdin.write('y'.repeat(65536), () => {}); setTimeout(w, 5); }; w();
  `;
  const run = async (guard: string) => {
    const { spawn } = await import('node:child_process');
    return new Promise<{ code: number | null; out: string }>((resolve) => {
      const p = spawn(process.execPath, ['-e', script(guard)], { stdio: 'pipe', windowsHide: true });
      let out = ''; p.stdout.on('data', (d: Buffer) => { out += d; }); p.stderr.on('data', (d: Buffer) => { out += d; });
      p.on('close', (code) => resolve({ code, out }));
    });
  };
  it('对照：没有监听时持续写入已结束的子进程，宿主因 EPIPE 退出', async () => {
    const r = await run('');
    expect(r.code).not.toBe(0); expect(r.out).toContain('EPIPE');
  }, 30_000);
  it('与 guardStdio 相同的监听下，宿主保持运行', async () => {
    const r = await run("for (const s of ['stdin','stdout','stderr']) child[s].on('error', () => {});");
    expect(r.code).toBe(0); expect(r.out).toContain('ALIVE');
  }, 30_000);
  it('spawnAgent 返回的子进程三条管道都已有 error 监听；guardStdio 把错误交给回调', async () => {
    const { spawnAgent, guardStdio } = await import('../src/acp/launch');
    const child = spawnAgent({ args: ['-e', 'process.exit(0)'] }, { cwd: process.cwd(), env: { ...process.env } as Record<string, string> });
    for (const s of ['stdin', 'stdout', 'stderr'] as const) expect(child[s].listenerCount('error')).toBeGreaterThan(0);
    await new Promise((r) => child.on('close', r));
    const { EventEmitter } = await import('node:events'); const seen: string[] = [];
    const fake = { stdin: new EventEmitter(), stdout: new EventEmitter(), stderr: new EventEmitter() };
    guardStdio(fake, (name, e) => seen.push(`${name}:${e.message}`));
    fake.stdin.emit('error', new Error('write EPIPE'));
    expect(seen).toEqual(['stdin:write EPIPE']);
  });
});
