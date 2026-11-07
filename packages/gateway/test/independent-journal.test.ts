import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openDb, type Db } from '../src/db';
import { IndependentToolJournal } from '../src/independent/tool-journal';
import { independentCommandEnv } from '../src/independent/commands';
import { intent, seed, success } from './fixtures/independent-journal';

const dbs: Db[] = []; const dirs: string[] = []; const helpers: ChildProcess[] = [];
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), 'aic-journal-')); dirs.push(dir); return dir; };
function setup() { const db = openDb(':memory:'); dbs.push(db); seed(db); return { db, journal: new IndependentToolJournal(db) }; }
afterEach(async () => {
  for (const helper of helpers.splice(0)) {
    if (helper.exitCode === null && helper.signalCode === null) await new Promise<void>((resolve) => { helper.once('close', () => resolve()); helper.kill('SIGKILL'); });
  }
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('独立工具持久意图', () => {
  it('同一身份幂等，参数指纹或工具变化报冲突，不允许跨任务归属', () => {
    const { journal } = setup(); const record = journal.create(intent);
    expect(journal.create(intent)).toEqual(record);
    expect(() => journal.create({ ...intent, inputHash: 'b'.repeat(64) })).toThrow('内容发生变化');
    expect(() => journal.create({ ...intent, toolName: 'edit' })).toThrow('内容发生变化');
    expect(() => journal.create({ ...intent, taskId: 'other-task' })).toThrow('会话与任务不一致');
    expect(() => journal.create({ ...intent, sessionId: 'unknown' })).toThrow('会话与任务不一致');
    expect(journal.create({ ...intent, turnId: 'another-turn' }).id).not.toBe(record.id);
    expect(() => journal.create({ ...intent, argv: ['private-data'] } as never)).toThrow();
  });

  it('必须先获准，重复执行和晚到审批不能启动第二次', () => {
    const { db, journal } = setup(); const { id } = journal.create(intent);
    expect(() => journal.start(id)).toThrow('状态已变化');
    const approved = journal.approve(id); expect(journal.approve(id)).toEqual(approved);
    expect(journal.start(id).state).toBe('running');
    const second = new IndependentToolJournal(db);
    expect(() => second.start(id)).toThrow('状态已变化');
    expect(() => second.approve(id)).toThrow('状态已变化');
    expect(() => journal.cancel(id)).toThrow('状态已变化');
  });

  it('拒绝与待执行取消都是终态，不能再获准或执行', () => {
    const { journal } = setup(); const rejected = journal.create(intent);
    journal.reject(rejected.id); expect(journal.reject(rejected.id).state).toBe('rejected');
    const cancelled = journal.create({ ...intent, callId: 'cancelled' }); journal.approve(cancelled.id); journal.cancel(cancelled.id);
    for (const record of [rejected, cancelled]) {
      expect(() => journal.approve(record.id)).toThrow('状态已变化');
      expect(() => journal.start(record.id)).toThrow('状态已变化');
      expect(() => journal.finish(record.id, success)).toThrow('不能覆写');
    }
    expect(journal.recover()).toEqual([]);
  });

  it('进程身份只在执行中登记，不能替换或复用另一 PID', () => {
    const { journal } = setup(); const { id } = journal.create(intent);
    expect(() => journal.setProcess(id, 1, 1)).toThrow('不在执行状态');
    journal.approve(id); journal.start(id);
    expect(journal.setProcess(id, 42, 123)).toMatchObject({ pid: 42, processStartedAt: 123 });
    expect(journal.setProcess(id, 42, 123).pid).toBe(42);
    expect(() => journal.setProcess(id, 43, 123)).toThrow('其他进程');
    expect(() => journal.setProcess(id, 42, 124)).toThrow('其他进程');
    expect(() => journal.setProcess(id, -1, 1)).toThrow();
  });

  it.each([
    [success, 'succeeded'], [{ ...success, exitCode: 3 }, 'failed'],
    [{ ...success, reason: 'cancelled' }, 'cancelled'], [{ ...success, reason: 'timed_out' }, 'failed'],
    [{ ...success, reason: 'interrupted' }, 'interrupted'], [{ ...success, reason: 'output_limit' }, 'failed'],
    [{ ...success, reason: 'start_failed', exitCode: null }, 'failed'],
  ] as const)('结果概要 %j 映射到 %s，正文不会落表', (outcome, state) => {
    const { db, journal } = setup(); const { id } = journal.create(intent); journal.approve(id); journal.start(id);
    expect(journal.finish(id, { ...outcome, stdout: 'fixture-private-output', stderr: 'fixture-private-error' } as never)).toMatchObject({ state, outcome });
    const raw = JSON.stringify(db.all('SELECT * FROM independent_tool_calls'));
    expect(raw).not.toContain('fixture-private'); expect(raw).not.toContain('stdout');
    expect(() => journal.finish(id, success)).toThrow('不能覆写');
    expect(journal.recover()).toEqual([]);
  });

  it('恢复只标记遗留意图，保留进程身份并阻断晚到结果', () => {
    const { journal } = setup();
    const records = ['pending', 'approved', 'running', 'succeeded'].map((callId) => journal.create({ ...intent, callId }));
    journal.approve(records[1]!.id);
    for (const record of records.slice(2)) { journal.approve(record.id); journal.start(record.id); }
    journal.setProcess(records[2]!.id, 42, 100); journal.finish(records[3]!.id, success);
    const recovered = journal.recover('session'); expect(recovered).toHaveLength(3);
    expect(recovered.every((record) => record.state === 'interrupted' && record.outcome === null)).toBe(true);
    expect(journal.get(records[2]!.id)).toMatchObject({ pid: 42, processStartedAt: 100 });
    expect(() => journal.finish(records[2]!.id, success)).toThrow('不能覆写');
    expect(() => journal.start(records[2]!.id)).toThrow('状态已变化');
    expect(journal.get(records[3]!.id).state).toBe('succeeded'); expect(journal.recover()).toEqual([]);
  });

  it('按会话恢复不误标其他会话', () => {
    const { db, journal } = setup();
    db.run("INSERT INTO sessions (id,task_id,agent_id,status,started_at) VALUES ('session-other','task','fake','running',1)");
    const first = journal.create(intent); const second = journal.create({ ...intent, sessionId: 'session-other' });
    expect(journal.recover('session').map((record) => record.id)).toEqual([first.id]); expect(journal.get(second.id).state).toBe('pending');
  });

  it('v5 升 v6 保留旧草稿和会话，重开不重复迁移', () => {
    const file = path.join(temp(), 'migration.db'); const db = openDb(file); seed(db);
    db.run("INSERT INTO task_drafts(task_id,text,annotations_json,updated_at) VALUES ('task','原草稿','[]',1)"); db.close();
    const old = new DatabaseSync(file); old.exec('DROP TABLE independent_file_receipts; DROP TABLE independent_checkpoints; DROP TABLE independent_messages; DROP TABLE independent_turns; DROP TABLE independent_discoveries; DROP TABLE independent_task_models; DROP TABLE independent_models; DROP TABLE independent_services; DROP TABLE independent_tool_calls; PRAGMA user_version=5;'); old.close();
    for (let i = 0; i < 2; i++) {
      const current = openDb(file);
      expect(current.get('SELECT text FROM task_drafts')).toEqual({ text: '原草稿' });
      expect(current.get('SELECT id FROM sessions')).toEqual({ id: 'session' });
      expect(current.get('PRAGMA user_version')).toEqual({ user_version: 10 });
      expect(current.all('SELECT * FROM independent_tool_calls')).toEqual([]); current.close();
    }
  });

  it.each(['pending', 'approved', 'running', 'effect', 'finished'])('进程在 %s 后崩溃，跨进程重开不重放副作用', async (stage) => {
    const dir = temp(); const ready = path.join(dir, 'ready');
    const fixture = fileURLToPath(new URL('./fixtures/independent-journal.ts', import.meta.url));
    const tsx = new URL('../../../node_modules/tsx/dist/loader.mjs', import.meta.url).href;
    const helper = spawn(process.execPath, ['--import', tsx, fixture, dir, stage], { windowsHide: true, stdio: 'ignore', env: independentCommandEnv(dir) }); helpers.push(helper);
    await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 10_000 });
    const { id, pid } = JSON.parse(readFileSync(ready, 'utf8')) as { id: string; pid: number };
    expect(pid).toBe(helper.pid);
    await new Promise<void>((resolve) => { helper.once('close', () => resolve()); helper.kill('SIGKILL'); });
    const db = openDb(path.join(dir, 'journal.db')); dbs.push(db); const journal = new IndependentToolJournal(db);
    const effects = path.join(dir, 'effect.txt'); const didExecute = ['effect', 'finished'].includes(stage);
    expect(existsSync(effects)).toBe(didExecute);
    if (didExecute) expect(readFileSync(effects, 'utf8')).toBe('只执行一次');
    const recovered = journal.recover(); expect(recovered).toHaveLength(stage === 'finished' ? 0 : 1);
    expect(journal.get(id).state).toBe(stage === 'finished' ? 'succeeded' : 'interrupted');
    expect(journal.create(intent).id).toBe(id);
    expect(() => journal.start(id)).toThrow('状态已变化');
    expect(existsSync(effects)).toBe(didExecute); if (didExecute) expect(readFileSync(effects, 'utf8')).toBe('只执行一次');
  });
});
