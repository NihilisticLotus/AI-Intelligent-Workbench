// 持久化故障位置夹具：只访问调用方指定的临时数据库与标记文件。
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { openDb, type Db } from '../../src/db';
import { IndependentToolJournal } from '../../src/independent/tool-journal';

export function seed(db: Db) {
  db.run(`INSERT INTO tasks (id,project_id,title,prompt,status,permission_level,agent,last_activity_at,created_at,updated_at)
    VALUES ('task','project','测试','','running','ask','fake',1,1,1)`);
  db.run(`INSERT INTO sessions (id,task_id,agent_id,status,started_at) VALUES ('session','task','fake','running',1)`);
}
export const intent = { taskId: 'task', sessionId: 'session', turnId: 'turn', callId: 'call', toolName: 'command', inputHash: 'a'.repeat(64) };
export const success = { reason: 'completed' as const, exitCode: 0, outputBytes: 0, truncated: false, durationMs: 1 };

if (process.argv[1]?.endsWith('independent-journal.ts')) {
  const [dir, stage] = process.argv.slice(2);
  if (!dir || !stage) throw new Error('缺少夹具参数');
  const db = openDb(path.join(dir, 'journal.db')); seed(db);
  const journal = new IndependentToolJournal(db); const call = journal.create(intent);
  if (stage !== 'pending') journal.approve(call.id);
  if (['running', 'effect', 'finished'].includes(stage)) journal.start(call.id);
  if (['effect', 'finished'].includes(stage)) writeFileSync(path.join(dir, 'effect.txt'), '只执行一次');
  if (stage === 'finished') journal.finish(call.id, success);
  writeFileSync(path.join(dir, 'ready'), JSON.stringify({ id: call.id, pid: process.pid }));
  setInterval(() => {}, 1000);
}
