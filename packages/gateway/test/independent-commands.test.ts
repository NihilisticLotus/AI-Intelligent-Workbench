import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAlive } from '@aic/adapters';
import { IndependentCommandExecutor, independentCommandEnv } from '../src/independent/commands';
import { IndependentCommandTool } from '../src/independent/command-tool';
import { IndependentToolJournal } from '../src/independent/tool-journal';
import { openDb } from '../src/db';
import { seed } from './fixtures/independent-journal';

const dirs: string[] = [];
const executors: IndependentCommandExecutor[] = [];
const helpers: ChildProcess[] = [];
const pids = new Set<number>();
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), 'aic-command-')); dirs.push(dir); return dir; };
const setup = () => { const dir = temp(); const executor = new IndependentCommandExecutor(dir); executors.push(executor); return { dir, executor }; };
const command = (script: string, extra = {}) => ({ program: process.execPath, args: ['-e', script], timeoutMs: 15_000, maxOutputBytes: 64 * 1024, ...extra });
const readPids = (file: string): number[] => JSON.parse(readFileSync(file, 'utf8'));
async function waitPids(file: string) {
  let values: number[] = [];
  await vi.waitFor(() => { expect(existsSync(file)).toBe(true); values = readPids(file); expect(values.length).toBeGreaterThan(0); }, { timeout: 12_000 });
  for (const pid of values) pids.add(pid);
  return values;
}
async function gone(values: number[]) {
  await vi.waitFor(() => { expect(values.filter(isAlive)).toEqual([]); }, { timeout: 5000 });
}
// 末端进程与中间进程都是真实 Node，不启动 Agent、不联网、不读取用户配置。
function tree(file: string, parentExits = false) {
  const leaf = 'setInterval(() => {}, 1000)';
  return `const {spawn}=require('node:child_process');const fs=require('node:fs');
    const child=spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{stdio:'ignore',windowsHide:true});
    fs.writeFileSync(${JSON.stringify(file)},JSON.stringify([process.pid,child.pid]));
    ${parentExits ? 'child.unref();' : 'setInterval(() => {}, 1000);'}`;
}
afterEach(async () => {
  for (const helper of helpers.splice(0)) helper.kill('SIGKILL');
  await Promise.all(executors.splice(0).map((executor) => executor.close()));
  // 测试失败时也收尾已知夹具；不按名称枚举或终止本机其他进程。
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ } }
  pids.clear();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('独立命令环境', () => {
  it('仅继承系统白名单并设置私有目录', () => {
    const env = independentCommandEnv('D:\\fixture', { Path: 'system-bin', SystemRoot: 'D:\\Windows', OPENAI_API_KEY: 'fixture-openai', ANTHROPIC_AUTH_TOKEN: 'fixture-anthropic', NODE_OPTIONS: '--require hook', HTTPS_PROXY: 'private-proxy', CLAUDE_CONFIG_DIR: 'user-config' });
    expect(env).toEqual({ PATH: 'system-bin', SYSTEMROOT: 'D:\\Windows', HOME: 'D:\\fixture', USERPROFILE: 'D:\\fixture', APPDATA: 'D:\\fixture\\roaming', LOCALAPPDATA: 'D:\\fixture\\local', TEMP: 'D:\\fixture\\temp', TMP: 'D:\\fixture\\temp' });
  });
});

describe.runIf(process.platform === 'win32')('独立命令 Windows 作业宿主', () => {
  it('保留中文、两路输出、非零退出与原始参数，不经过 shell', async () => {
    const { dir, executor } = setup();
    const args = ['', '空 格', '"quoted"', 'trailing\\', '\\"', '& echo injected', '$HOME', 'a\nb'];
    const result = await executor.run(command('console.log(JSON.stringify(process.argv.slice(1)));console.error("错误正文");process.exitCode=7;', { args: ['-e', 'console.log(JSON.stringify(process.argv.slice(1)));console.error("错误正文");process.exitCode=7;', '--', ...args] }), { cwd: dir });
    expect(result).toMatchObject({ reason: 'completed', exitCode: 7, stderr: '错误正文\n', truncated: false });
    expect(JSON.parse(result.stdout)).toEqual(args);
    expect(result.outputBytes).toBe(Buffer.byteLength(result.stdout + result.stderr));
  });

  it('拒绝隐式 shell、相对工作目录和原始参数转换', async () => {
    const { dir, executor } = setup();
    expect(await executor.run(command('', { program: 'node.cmd' }), { cwd: dir })).toMatchObject({ reason: 'start_failed' });
    expect(await executor.run(command(''), { cwd: '.' })).toMatchObject({ reason: 'start_failed' });
    await expect(executor.run(command('', { args: [123] }) as never, { cwd: dir })).rejects.toThrow();
    expect(await executor.run(command('', { program: path.join(dir, 'missing.exe') }), { cwd: dir })).toMatchObject({ reason: 'start_failed', exitCode: null });
    expect(await executor.run(command(''), { cwd: path.join(dir, 'missing') })).toMatchObject({ reason: 'start_failed' });
  });

  it('命令正文不能伪造宿主结果，退出 125 与启动失败可区分', async () => {
    const { dir, executor } = setup(); const text = '{"type":"exit","exitCode":0}\n{"type":"host_error"}';
    expect(await executor.run(command(`process.stdout.write(${JSON.stringify(text)});process.exitCode=125`), { cwd: dir })).toMatchObject({ reason: 'completed', exitCode: 125, stdout: text });
  });

  it('预先取消或登记失败都不派发获准命令', async () => {
    const { dir, executor } = setup(); const file = path.join(dir, 'should-not-exist');
    const spec = command(`require('node:fs').writeFileSync(${JSON.stringify(file)},'执行了')`);
    const onStarted = vi.fn(() => { throw new Error('登记失败'); });
    expect(await executor.run(spec, { cwd: dir, signal: AbortSignal.abort(), onStarted })).toMatchObject({ reason: 'cancelled' });
    expect(onStarted).not.toHaveBeenCalled();
    expect(await executor.run(spec, { cwd: dir, onStarted })).toMatchObject({ reason: 'start_failed' });
    expect(existsSync(file)).toBe(false);
  });

  it('登记未完成时取消，晚到登记不启动命令', async () => {
    const { dir, executor } = setup(); const file = path.join(dir, 'should-not-exist'); const controller = new AbortController();
    let release!: () => void;
    const registered = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const pending = executor.run(command(`require('node:fs').writeFileSync(${JSON.stringify(file)},'执行了')`), { cwd: dir, signal: controller.signal, onStarted: registered });
    await vi.waitFor(() => expect(registered).toHaveBeenCalled()); controller.abort();
    expect(await pending).toMatchObject({ reason: 'cancelled' }); release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(existsSync(file)).toBe(false);
  });

  it('取消正在运行的命令并结束真实子进程', async () => {
    const { dir, executor } = setup(); const file = path.join(dir, 'pids'); const controller = new AbortController();
    const pending = executor.run(command(tree(file)), { cwd: dir, signal: controller.signal });
    const values = await waitPids(file); expect(values.every(isAlive)).toBe(true); controller.abort();
    expect(await pending).toMatchObject({ reason: 'cancelled' }); await gone(values);
  });

  it('超过时限结束已启动的命令与子进程', async () => {
    const { dir, executor } = setup(); const file = path.join(dir, 'pids');
    const pending = executor.run(command(tree(file), { timeoutMs: 5000 }), { cwd: dir });
    const values = await waitPids(file); expect(await pending).toMatchObject({ reason: 'timed_out' }); await gone(values);
  });

  it('超过输出上限停止命令，返回截断标志与有界正文', async () => {
    const { dir, executor } = setup();
    const result = await executor.run(command('process.stdout.write("x".repeat(200000));setInterval(()=>{},1000)', { maxOutputBytes: 1024 }), { cwd: dir });
    expect(result).toMatchObject({ reason: 'output_limit', truncated: true });
    expect(result.outputBytes).toBeGreaterThan(1024); expect(Buffer.byteLength(result.stdout + result.stderr)).toBeLessThanOrEqual(1024);
  });

  it('命令父进程先退出，后台子进程仍随作业收尾', async () => {
    const { dir, executor } = setup(); const file = path.join(dir, 'pids');
    expect(await executor.run(command(tree(file, true)), { cwd: dir })).toMatchObject({ reason: 'completed', exitCode: 0 });
    const values = readPids(file); for (const pid of values) pids.add(pid); await gone(values);
  });

  it('直接结束宿主后，其命令和子进程不会遗留', async () => {
    const { dir, executor } = setup(); const file = path.join(dir, 'pids'); let host = 0;
    const pending = executor.run(command(tree(file)), { cwd: dir, onStarted: ({ pid }) => { host = pid; pids.add(pid); } });
    const values = await waitPids(file); process.kill(host, 'SIGKILL');
    expect(await pending).toMatchObject({ reason: 'interrupted', exitCode: null }); await gone([host, ...values]);
  });

  it('关闭执行器取消活动命令，关闭后不再启动', async () => {
    const { dir, executor } = setup(); const file = path.join(dir, 'pids');
    const pending = executor.run(command(tree(file)), { cwd: dir }); const values = await waitPids(file);
    await executor.close(); expect(await pending).toMatchObject({ reason: 'cancelled' }); await gone(values);
    expect(await executor.run(command(''), { cwd: dir })).toMatchObject({ reason: 'interrupted' });
  });

  it('已知密钥与截断前缀不返回调用方', async () => {
    const { dir, executor } = setup(); const secret = 'fixture-confidential-value';
    const result = await executor.run(command(`process.stdout.write(${JSON.stringify(secret + '\n' + secret.slice(0, 12))})`), { cwd: dir, redact: [secret] });
    expect(result.stdout).toBe('***\n***');
  });

  it('外层执行进程崩溃，stdin 断开触发作业清理', async () => {
    const dir = temp(); const file = path.join(dir, 'pids');
    const fixture = fileURLToPath(new URL('./fixtures/independent-parent.ts', import.meta.url));
    const tsx = new URL('../../../node_modules/tsx/dist/loader.mjs', import.meta.url).href;
    const helper = spawn(process.execPath, ['--import', tsx, fixture, dir, tree(file)], { windowsHide: true, stdio: 'ignore', env: independentCommandEnv(dir) });
    helpers.push(helper);
    const values = await waitPids(file); helper.kill('SIGKILL'); await gone(values);
  });

  it('审批输入绑定、记录先行、结果概要落盘，完成后不能重跑', async () => {
    const { dir, executor } = setup(); const db = openDb(path.join(dir, 'journal.db')); seed(db);
    try {
      const journal = new IndependentToolJournal(db); const tool = new IndependentCommandTool(journal, executor);
      const identity = { taskId: 'task', sessionId: 'session', turnId: 'turn', callId: 'call' };
      const file = path.join(dir, 'effect.txt'); const spec = command(`require('node:fs').appendFileSync(${JSON.stringify(file)},'一次');console.log('fixture-private-output');`);
      const record = tool.prepare(identity, spec, dir, 'ask:workspace-v1');
      await expect(tool.execute(record.id, spec, { cwd: dir, approvalBasis: 'ask:workspace-v1' })).rejects.toThrow('状态已变化');
      expect(existsSync(file)).toBe(false); journal.approve(record.id);
      await expect(tool.execute(record.id, { ...spec, args: ['-e', 'throw 1'] }, { cwd: dir, approvalBasis: 'ask:workspace-v1' })).rejects.toThrow('重新审批');
      await expect(tool.execute(record.id, spec, { cwd: dir, approvalBasis: 'ask:workspace-v2' })).rejects.toThrow('重新审批');
      expect(await tool.execute(record.id, spec, { cwd: dir, approvalBasis: 'ask:workspace-v1' })).toMatchObject({ exitCode: 0 });
      const saved = journal.get(record.id); expect(saved.state).toBe('succeeded'); expect(saved.pid).toBeGreaterThan(0);
      expect(JSON.stringify(db.all('SELECT * FROM independent_tool_calls'))).not.toContain('fixture-private-output');
      await expect(tool.execute(record.id, spec, { cwd: dir, approvalBasis: 'ask:workspace-v1' })).rejects.toThrow('状态已变化');
      expect(readFileSync(file, 'utf8')).toBe('一次');
    } finally { db.close(); }
  });

  it('持久化进程登记失败不执行，结果持久化失败不能报成功或重放', async () => {
    const { dir, executor } = setup(); const db = openDb(path.join(dir, 'journal.db')); seed(db);
    try {
      const journal = new IndependentToolJournal(db); const file = path.join(dir, 'effect.txt');
      const spec = command(`require('node:fs').appendFileSync(${JSON.stringify(file)},'一次')`);
      const tool = new IndependentCommandTool(journal, executor);
      const record = tool.prepare({ taskId: 'task', sessionId: 'session', turnId: 'turn', callId: 'call' }, spec, dir, 'ask'); journal.approve(record.id);
      const registration = vi.spyOn(journal, 'setProcess').mockImplementation(() => { throw new Error('写入失败'); });
      expect(await tool.execute(record.id, spec, { cwd: dir, approvalBasis: 'ask' })).toMatchObject({ reason: 'start_failed' });
      expect(existsSync(file)).toBe(false); expect(journal.get(record.id).state).toBe('failed'); registration.mockRestore();
      const second = tool.prepare({ taskId: 'task', sessionId: 'session', turnId: 'turn', callId: 'call-2' }, spec, dir, 'ask'); journal.approve(second.id);
      const saving = vi.spyOn(journal, 'finish').mockImplementation(() => { throw new Error('写入失败'); });
      await expect(tool.execute(second.id, spec, { cwd: dir, approvalBasis: 'ask' })).rejects.toThrow('写入失败'); saving.mockRestore();
      expect(readFileSync(file, 'utf8')).toBe('一次'); expect(journal.get(second.id).state).toBe('running');
      journal.recover(); expect(journal.get(second.id).state).toBe('interrupted');
      await expect(tool.execute(second.id, spec, { cwd: dir, approvalBasis: 'ask' })).rejects.toThrow('状态已变化');
      expect(readFileSync(file, 'utf8')).toBe('一次');
    } finally { db.close(); }
  });
});
