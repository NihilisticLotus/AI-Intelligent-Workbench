// 从已提交事件生成任务账本。游标与条目在同一事务落库，重启后可接续旧任务。
import { EventEnvelope, TaskMemoryItem, type AddTaskConstraint, type EventOf, type MemoryCommandResult, type MemoryFact, type ToolFile } from '@aic/protocol';
import { redact } from '@aic/adapters';
import type { Db } from './db';
import { Errors, newId } from './util';

type EventRow = { seq: number; session_id: string | null; type: string; payload: string; ts: number };
const memoryEvents = "'task.created','plan.update','tool.end','approval.resolved'";
const projectEvent = (taskId: string, row: EventRow) => EventEnvelope.parse({
  taskId, seq: row.seq, sessionId: row.session_id, type: row.type, data: JSON.parse(row.payload), ts: row.ts,
});

export function outputExcerpt(text: string): string {
  const lines = text.split(/\r?\n/);
  const excerpt = lines.length <= 40 ? text : [...lines.slice(0,20),'…（中间输出已省略）',...lines.slice(-20)].join('\n');
  return excerpt.length <= 8192 ? excerpt : excerpt.slice(0,4080) + '\n…（已截断）\n' + excerpt.slice(-4080);
}

export class TaskMemory {
  constructor(private db: Db, private secrets: (taskId: string) => readonly string[] = () => []) {}

  private put(taskId: string, sessionId: string | null, seq: number | null, at: number, key: string, fact: MemoryFact, user = false) {
    this.db.run(`INSERT INTO task_memory(id,task_id,session_id,kind,content,source,source_seq,pinned,created_at,updated_at,item_key)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(task_id,item_key) DO UPDATE SET
      session_id=excluded.session_id, content=excluded.content, source_seq=excluded.source_seq, updated_at=excluded.updated_at`,
      newId('mem'), taskId, sessionId, fact.kind, JSON.stringify(fact.content), user ? 'user' : 'auto', seq,
      user ? 1 : 0, at, at, key);
  }

  private tool(taskId: string, end: EventOf<'tool.end'>) {
    if (end.data.rejected) return;
    const args = [taskId, end.sessionId, end.data.toolId, end.seq] as const;
    const start = this.db.get<EventRow>(`SELECT * FROM events WHERE task_id=? AND session_id IS ?
      AND json_extract(payload,'$.toolId')=? AND seq<? AND replay=0 AND type='tool.start' ORDER BY seq DESC LIMIT 1`, ...args);
    if (!start) return;
    const initial = projectEvent(taskId,start);
    if (initial.type !== 'tool.start') return;
    let { kind, target, title } = initial.data;
    const files = new Map<string,ToolFile>();
    const chunks: string[] = [];
    const updates = this.db.all<EventRow>(`SELECT * FROM events WHERE task_id=? AND session_id IS ?
      AND json_extract(payload,'$.toolId')=? AND seq<? AND seq>? AND replay=0 AND type IN ('tool.update','tool.output') ORDER BY seq`,...args,start.seq);
    for (const row of updates) {
      const update = projectEvent(taskId,row);
      if (update.type === 'tool.output') chunks.push(update.data.text);
      if (update.type !== 'tool.update') continue;
      kind = update.data.kind ?? kind;
      title = update.data.title ?? title;
      if (update.data.target !== undefined) target = update.data.target;
      for (const file of update.data.files ?? []) files.set(file.path,file);
    }
    if (kind === 'execute') {
      this.command(taskId,end.sessionId,end.seq,end.ts,{command:target || title,ok:end.data.ok,output:chunks.join('') || end.data.summary || ''});
    }
    if (!end.data.ok || (kind !== 'edit' && kind !== 'create' && kind !== 'delete')) return;
    if (!files.size && target) files.set(target,{path:target,added:null,removed:null,created:kind === 'create'});
    for (const file of files.values()) {
      this.put(taskId,end.sessionId,end.seq,end.ts,'file:'+file.path,{kind:'file',content:{...file,operation:file.created?'create':kind}});
    }
  }

  command(taskId: string, sessionId: string | null, seq: number, at: number, result: MemoryCommandResult) {
    const secrets = this.secrets(taskId);
    const command = redact(result.command,secrets);
    const sensitive = /(?:^|[\s/\\"'])\.env(?:\.[^\s/\\]+)?(?=$|[\s"'])/i.test(command);
    const output = sensitive ? '（环境文件内容已打码）' : outputExcerpt(redact(result.output,secrets));
    this.put(taskId,sessionId,seq,at,'command:'+seq,{kind:'command',content:{command,ok:result.ok,output}});
  }

  sync(taskId: string) {
    const task = this.db.get<{prompt:string;created_at:number}>('SELECT prompt,created_at FROM tasks WHERE id=?',taskId);
    if (!task) throw Errors.notFound('找不到这个任务');
    this.db.tx(() => {
      let cursor = this.db.get<{seq:number}>('SELECT seq FROM task_memory_cursors WHERE task_id=?',taskId)?.seq;
      if (cursor === undefined) this.put(taskId,null,null,task.created_at,'goal',{kind:'goal',content:task.prompt});
      for (;;) {
        const rows = this.db.all<EventRow>(`SELECT * FROM events WHERE task_id=? AND seq>? AND replay=0 AND type IN (${memoryEvents}) ORDER BY seq LIMIT 256`,taskId,cursor ?? 0);
        for (const row of rows) {
          const e = projectEvent(taskId,row);
          if (e.type === 'task.created') this.put(taskId,null,e.seq,e.ts,'goal',{kind:'goal',content:e.data.task.prompt});
          if (e.type === 'plan.update') this.put(taskId,e.sessionId,e.seq,e.ts,'plan',{kind:'plan',content:e.data.items});
          if (e.type === 'tool.end') this.tool(taskId,e);
          if (e.type === 'approval.resolved' && e.data.status === 'rejected') {
            const approval = this.db.get<{request_json:string}>('SELECT request_json FROM approvals WHERE id=? AND task_id=?',e.data.approvalId,taskId);
            if (approval) {
              const a = JSON.parse(approval.request_json) as {title:string;detail:string;note?:string};
              const content = ['已拒绝：'+a.title,a.detail,a.note && '理由：'+a.note].filter(Boolean).join('\n');
              this.put(taskId,e.sessionId,e.seq,e.ts,'reject:'+e.data.approvalId,{kind:'constraint',content});
            }
          }
          cursor=e.seq;
        }
        if (rows.length < 256) break;
      }
      this.db.run('INSERT INTO task_memory_cursors(task_id,seq) VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET seq=excluded.seq WHERE seq<>excluded.seq',taskId,cursor ?? 0);
    });
  }

  list(taskId: string): TaskMemoryItem[] {
    this.sync(taskId);
    const rows = this.db.all<{content:string;pinned:number}>(`SELECT id,task_id AS taskId,session_id AS sessionId,kind,content,source,
      source_seq AS sourceSeq,pinned,superseded_by AS supersededBy,created_at AS createdAt,updated_at AS updatedAt
      FROM task_memory WHERE task_id=? AND superseded_by IS NULL ORDER BY created_at,rowid`,taskId);
    return rows.map(r=>TaskMemoryItem.parse({...r,content:JSON.parse(r.content),pinned:Boolean(r.pinned)}));
  }

  constrain(taskId: string, input: AddTaskConstraint) {
    this.sync(taskId);
    if ('sourceSeq' in input) {
      const row = this.db.get<EventRow>("SELECT * FROM events WHERE task_id=? AND seq=? AND replay=0 AND type='message.user'",taskId,input.sourceSeq);
      if (!row) throw Errors.badRequest('找不到本任务的这条用户消息');
      const event = projectEvent(taskId,row);
      if (event.type === 'message.user') this.put(taskId,event.sessionId,event.seq,Date.now(),'user:'+event.seq,{kind:'constraint',content:event.data.text},true);
    } else this.put(taskId,null,null,Date.now(),newId('user'),{kind:'constraint',content:input.content},true);
  }

  remove(taskId: string, itemId: string) {
    if (!this.db.run("DELETE FROM task_memory WHERE task_id=? AND id=? AND source='user'",taskId,itemId).changes) {
      throw Errors.badRequest('只能移除本任务中用户添加的约束');
    }
  }
}
