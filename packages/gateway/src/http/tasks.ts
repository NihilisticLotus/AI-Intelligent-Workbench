// 任务、事件、Agent、审批
import { Hono } from 'hono';
import { ApprovalsQuery, CreateTaskBody, EventsQuery, PatchTaskBody, TasksQuery } from '@aic/protocol';
import type { Services } from '../services';
import { parseQuery, readBody, type Env } from './app';

export function taskRoutes(s: Services) {
  const r = new Hono<Env>();

  r.get('/tasks', (c) => c.json(s.tasks.list(parseQuery(c, TasksQuery))));
  r.post('/tasks', async (c) => c.json(await s.tasks.create(await readBody(c, CreateTaskBody)), 201));
  r.get('/tasks/:id', (c) => c.json(s.tasks.get(c.req.param('id'))));
  r.patch('/tasks/:id', async (c) => c.json(await s.tasks.patch(c.req.param('id'), await readBody(c, PatchTaskBody))));

  // 任务的事件历史：after 是 seq，nextCursor 是本页最后一个 seq（还有更多时）
  r.get('/tasks/:id/events', (c) => {
    const id = c.req.param('id');
    s.tasks.getRow(id);
    const q = parseQuery(c, EventsQuery);
    const items = s.events.read({ after: q.after, limit: q.limit, taskId: id });
    const last = items[items.length - 1];
    return c.json({ items, nextCursor: items.length === q.limit && last ? String(last.seq) : null });
  });

  r.get('/agents', async (c) => c.json({ items: await s.agents.list(), nextCursor: null }));

  r.get('/approvals', (c) => c.json({ items: s.tasks.listApprovals(parseQuery(c, ApprovalsQuery).status), nextCursor: null }));

  return r;
}
