// 项目、文件夹浏览、分组
import { Hono } from 'hono';
import { CreateEnvironmentBody, CreateGroupBody, CreateProjectBody, FsBrowseQuery, PatchGroupBody, PatchProjectBody } from '@aic/protocol';
import { environments, saveEnvironment, deleteEnvironment } from '../environments';
import { browse } from '../fsbrowse';
import type { Services } from '../services';
import { parseQuery, readBody, type Env } from './app';

export function projectRoutes(s: Services) {
  const r = new Hono<Env>();
  r.get('/environments', (c) => c.json({ items: environments(s.db), nextCursor: null }));
  r.post('/environments', async (c) => c.json(saveEnvironment(s.db, await readBody(c, CreateEnvironmentBody)), 201));
  r.delete('/environments/:id', (c) => { deleteEnvironment(s.db, c.req.param('id')); return c.json({ ok: true }); });

  r.get('/projects', (c) => c.json({ items: s.projects.list(), nextCursor: null }));
  r.post('/projects', async (c) => c.json(s.projects.create(await readBody(c, CreateProjectBody)), 201));
  r.patch('/projects/:id', async (c) => c.json(s.projects.patch(c.req.param('id'), await readBody(c, PatchProjectBody))));
  r.delete('/projects/:id', (c) => { s.projects.delete(c.req.param('id')); return c.json({ ok: true }); });

  r.get('/fs/browse', (c) => {
    const q = parseQuery(c, FsBrowseQuery);
    return c.json(browse(q.path, { cursor: q.cursor, limit: q.limit }));
  });

  r.get('/groups', (c) => c.json({ items: s.groups.list(), nextCursor: null }));
  r.post('/groups', async (c) => c.json(s.groups.create((await readBody(c, CreateGroupBody)).name), 201));
  r.patch('/groups/:id', async (c) => c.json(s.groups.patch(c.req.param('id'), await readBody(c, PatchGroupBody))));
  r.delete('/groups/:id', (c) => { s.groups.delete(c.req.param('id')); return c.json({ ok: true }); });

  return r;
}
