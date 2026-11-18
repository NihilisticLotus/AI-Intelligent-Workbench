import { expect, it } from 'vitest';
import { openDb } from '../src/db';
import { completedReplies } from '../../../scripts/dev/handoff-reply';

it('验收读取本轮已结束的流式回复，排除旧轮、回放和其他会话', () => {
  const db = openDb(':memory:');
  const add = (type: string, id: string, text?: string, session = 'source', replay = 0) =>
    db.run('INSERT INTO events(task_id,session_id,type,payload,ts,replay) VALUES (?,?,?,?,1,?)',
      'task', session, type, JSON.stringify({messageId:id, text}), replay).lastInsertRowid;
  try {
    const before = add('message.done', 'old', '上轮回复');
    add('message.delta', 'answer', '北');
    add('message.delta', 'answer', '其他会话', 'other');
    add('message.delta', 'answer', '回放', 'source', 1);
    add('message.delta', 'answer', '门');
    expect(completedReplies(db, 'task', 'source', before)).toEqual([]);
    add('message.done', 'answer');
    add('message.delta', 'unfinished', '尚未完成');
    expect(completedReplies(db, 'task', 'source', before)).toEqual(['北门']);
    add('message.delta', 'answer', '通行');
    expect(completedReplies(db, 'task', 'source', before)).toEqual(['北门通行']);
    add('message.delta', 'last', '草稿');
    add('message.done', 'last', '最终正文');
    expect(completedReplies(db, 'task', 'source', before)).toEqual(['北门通行', '最终正文']);
    add('message.done', 'last', '');
    expect(completedReplies(db, 'task', 'source', before)).toEqual(['北门通行', '']);
  } finally { db.close(); }
});
