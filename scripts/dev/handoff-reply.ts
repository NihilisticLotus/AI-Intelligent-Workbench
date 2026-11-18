import type { Db } from '../../packages/gateway/src/db';

/** 在任务空闲后读取本回合已结束的助手消息；原生适配器的结束事件可以只带编号。 */
export function completedReplies(db: Db, task: string, session: string, after: number): string[] {
  const rows = db.all<{type:string; payload:string}>(
    `SELECT type,payload FROM events WHERE task_id=? AND session_id=? AND seq>? AND replay=0
     AND type IN ('message.delta','message.done') ORDER BY seq`,
    task, session, after,
  );
  const pieces = new Map<string, string>();
  const finished = new Map<string, string | undefined>();
  for (const row of rows) {
    const { messageId, text } = JSON.parse(row.payload);
    if (row.type === 'message.delta') {
      pieces.set(messageId, (pieces.get(messageId) ?? '') + text);
    } else {
      finished.set(messageId, text);
    }
  }
  // 脱敏缓冲区可能在结束事件之后发布尾片。带完整正文的结束事件优先，避免重复拼接。
  return Array.from(finished, ([id, final]) => final ?? pieces.get(id) ?? '');
}
