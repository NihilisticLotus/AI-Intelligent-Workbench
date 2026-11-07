// 任务、事件、Agent、审批
import { Hono } from 'hono';
import { ApprovalsQuery, CreateTaskBody, EventsQuery, PatchTaskBody, PutTaskDraftBody, TasksQuery, type TaskDraft } from '@aic/protocol';
import type { Services } from '../services';
import { parseQuery, readBody, type Env } from './app';

export function taskRoutes(s: Services) {
  const r = new Hono<Env>();

  r.get('/tasks', (c) => c.json(s.tasks.list(parseQuery(c, TasksQuery))));
  r.post('/tasks', async (c) => c.json(await s.tasks.create(await readBody(c, CreateTaskBody)), 201));
  r.get('/tasks/:id', (c) => c.json(s.tasks.get(c.req.param('id'))));
  r.patch('/tasks/:id', async (c) => c.json(await s.tasks.patch(c.req.param('id'), await readBody(c, PatchTaskBody))));

  r.post('/tasks/:id/attachments', async (c) => {
    s.tasks.getRow(c.req.param('id'));
    let name: string;
    try { name = decodeURIComponent(c.req.header('X-AIC-Filename') ?? '附件'); } catch { throw new Error('附件文件名编码无效'); }
    const a = s.attachments.upload(c.req.param('id'), name, Buffer.from(await c.req.arrayBuffer()));
    return c.json(a, 201);
  });
  r.get('/tasks/:id/attachments/:attId', (c) => {
    const a = s.attachments.read(c.req.param('id'), c.req.param('attId'));
    c.header('Content-Type', a.info.mime); c.header('X-Content-Type-Options', 'nosniff');
    if (a.info.kind !== 'image') c.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(a.info.name)}`);
    return c.body(new Uint8Array(a.bytes));
  });
  r.get('/tasks/:id/attachments/:attId/info', (c) => c.json(s.attachments.get(c.req.param('id'), c.req.param('attId')).info));

  // 任务的事件历史：after 是 seq，nextCursor 是本页最后一个 seq（还有更多时）
  r.get('/tasks/:id/events', (c) => {
    const id = c.req.param('id');
    s.tasks.getRow(id);
    const q = parseQuery(c, EventsQuery);
    const items = s.events.read({ after: q.after, limit: q.limit, taskId: id });
    const last = items[items.length - 1];
    return c.json({ items, nextCursor: items.length === q.limit && last ? String(last.seq) : null });
  });

  // 草稿：输入框里没发出去的文字和注释（design.md 15.2）。只存在本机数据库里，不写日志
  r.get('/tasks/:id/draft', (c) => {
    const id = c.req.param('id');
    s.tasks.getRow(id);
    const row = s.db.get<{ text: string; annotations_json: string; attachments_json: string | null; updated_at: number }>('SELECT text, annotations_json, attachments_json, updated_at FROM task_drafts WHERE task_id = ?', id);
    let annotations: TaskDraft['annotations'] = [];
    try { annotations = row ? JSON.parse(row.annotations_json) : []; } catch { annotations = []; }
    const ids: string[] = row?.attachments_json ? JSON.parse(row.attachments_json) : [];
    const attachments = ids.filter((attId) => { try { s.attachments.get(id, attId); return true; } catch { return false; } });
    return c.json({ text: row?.text ?? '', annotations, ...(row?.attachments_json ? { attachments } : {}), updatedAt: row?.updated_at ?? null } satisfies TaskDraft);
  });
  r.put('/tasks/:id/draft', async (c) => {
    const id = c.req.param('id');
    s.tasks.getRow(id);
    const body = await readBody(c, PutTaskDraftBody);
    if (!body.text.trim() && !body.annotations.length && !body.attachments?.length) {
      s.db.run('DELETE FROM task_drafts WHERE task_id = ?', id);
      return c.json({ text: '', annotations: [], updatedAt: null } satisfies TaskDraft);
    }
    s.attachments.resolve(id, body.attachments);
    const t = Date.now();
    s.db.run(`INSERT INTO task_drafts (task_id, text, annotations_json, updated_at, attachments_json) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET text = excluded.text, annotations_json = excluded.annotations_json, updated_at = excluded.updated_at, attachments_json = excluded.attachments_json`,
      id, body.text, JSON.stringify(body.annotations), t, JSON.stringify(body.attachments ?? []));
    return c.json({ ...body, updatedAt: t } satisfies TaskDraft);
  });

  // GET /agents 1.2 起在 http/agents.ts（带缓存、账号、能力）

  r.get('/approvals', (c) => c.json({ items: s.tasks.listApprovals(parseQuery(c, ApprovalsQuery).status), nextCursor: null }));

  return r;
}
