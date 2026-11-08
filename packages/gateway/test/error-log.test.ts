import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeAdapter } from '@aic/adapters';
import { ErrorCode, type EventEnvelope } from '@aic/protocol';
import { errorLogText } from '../src/error-log';
import { EventBus } from '../src/events';
import { makeProject, startGw, WsClient, type TestGw } from './helpers';

const synthetic = 'only-a-synthetic-bearer-value';
const attached = '此合成附件内容不应进入错误日志';
const failure = () => Object.assign(new Error(`合成故障 Authorization: Bearer ${synthetic}`), { request: { attachment: attached } });
let t: TestGw | undefined;
let ws: WsClient | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await ws?.close(); ws = undefined;
  await t?.stop(); t = undefined;
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('兜底终端日志脱敏（ISSUE-0049）', () => {
  it('保留脱敏堆栈并隐藏已知密钥，不展开 Error 附带对象', () => {
    const known = 'another-synthetic-injected-value';
    const error = failure(); error.stack += `\n合成调用位置 ${known}`;
    const output = errorLogText(error, [known]);
    expect(output).toContain('合成故障'); expect(output).toContain('合成调用位置');
    for (const value of [synthetic, known, attached]) expect(output).not.toContain(value);
  });

  it('非 Error 对象不展开，也不调用其自定义字符串转换', () => {
    const toString = vi.fn(() => attached);
    expect(errorLogText({ request: { token: synthetic }, toString })).not.toContain(synthetic);
    expect(toString).not.toHaveBeenCalled();
  });

  it('订阅者抛错不泄露合成凭据，也不阻断后续订阅者', () => {
    const print = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bus = new EventBus(); const next = vi.fn();
    bus.on(() => { throw failure(); }); bus.on(next);
    const event: EventEnvelope = { seq: 1, ts: 1, type: 'message.done', taskId: 't', sessionId: null, data: { messageId: 'm' } };
    bus.emit(event);
    expect(next).toHaveBeenCalledWith(event);
    expect(print).toHaveBeenCalledOnce();
    const output = JSON.stringify(print.mock.calls);
    expect(output).toContain('合成故障'); expect(output).not.toContain(synthetic); expect(output).not.toContain(attached);
  });

  it('HTTP 内部错误保留 500 与通用错误体，终端不展开异常对象', async () => {
    t = await startGw(); const token = await t.pair();
    const print = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(t.gw.services.projects, 'list').mockImplementation(() => { throw failure(); });
    const result = await t.api('GET', '/projects', { token });
    expect(result.status).toBe(500); expect(result.json).toMatchObject({ code: ErrorCode.Internal, message: '服务内部错误' });
    const output = JSON.stringify(print.mock.calls);
    expect(output).toContain('[http]'); expect(output).toContain('合成故障');
    expect(output).not.toContain(synthetic); expect(output).not.toContain(attached);
    expect(result.text).not.toContain(synthetic);
  });

  it('WebSocket 内部错误保留失败 ack，终端不展开异常对象', async () => {
    t = await startGw(); const token = await t.pair(); ws = await WsClient.connect(t.port, token);
    const print = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(t.gw.services.tasks, 'cancel').mockImplementation(() => { throw failure(); });
    const result = await ws.call({ op: 'cancel', data: { taskId: 'synthetic-task' } });
    expect(result).toMatchObject({ ok: false, error: { code: ErrorCode.Internal, message: '服务内部错误' } });
    const output = JSON.stringify(print.mock.calls);
    expect(output).toContain('[ws]'); expect(output).toContain('合成故障');
    expect(output).not.toContain(synthetic); expect(output).not.toContain(attached);
    expect(JSON.stringify(result)).not.toContain(synthetic);
  });

  it.each([true, false])('任务启动异常保留失败状态和脱敏事件（Error=%s）', async (asError) => {
    const fake = createFakeAdapter({ speed: 0 });
    t = await startGw({ adapters: [{ ...fake, spawn: async () => { throw asError ? failure() : failure().message; } }] });
    const token = await t.pair(); const project = await makeProject(t, token);
    const print = vi.spyOn(console, 'error').mockImplementation(() => {});
    const task = await t.gw.services.tasks.create({ projectId: project.id, agent: 'fake', prompt: '合成离线任务', permission: 'readonly' });
    await t.gw.services.tasks.idle();
    expect(t.gw.services.tasks.get(task.id).status).toBe('failed');
    const events = t.gw.services.events.read({ after: 0, taskId: task.id, limit: 1000 });
    expect(events.find(e => e.type === 'error')).toMatchObject({ data: { error: { code: 'agent.failed', message: expect.stringContaining('合成故障') } } });
    const output = JSON.stringify(print.mock.calls);
    expect(output).toContain('[tasks]'); expect(output).toContain('合成故障');
    expect(output).not.toContain(synthetic); expect(output).not.toContain(attached);
    expect(JSON.stringify(events)).not.toContain(synthetic);
  });

  it('真实 Gateway 入口在数据目录无效时退出 1，启动终端脱敏且不启动 Agent', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aic-startup-log-')); dirs.push(dir);
    const invalid = path.join(dir, `token=${synthetic}`); writeFileSync(invalid, '合成文件占据数据目录');
    const tsx = fileURLToPath(new URL('../../../node_modules/tsx/dist/cli.mjs', import.meta.url));
    const entry = fileURLToPath(new URL('../src/server.ts', import.meta.url));
    const result = await new Promise<{ code: unknown; stdout: string; stderr: string }>(resolve => {
      execFile(process.execPath, [tsx, '--disable-warning=ExperimentalWarning', entry], {
        windowsHide: true, timeout: 10_000,
        env: { ...process.env, AIC_DATA_DIR: invalid, AIC_NO_REAL_AGENTS: '1', AIC_NO_BROWSER: '1' },
      }, (error, stdout, stderr) => resolve({ code: (error as NodeJS.ErrnoException | null)?.code, stdout, stderr }));
    });
    expect(result.code).toBe(1); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('AI Console 启动失败'); expect(result.stderr).toContain('***');
    expect(result.stderr).not.toContain(synthetic);
  });
});
