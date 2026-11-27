// 能力中心技能库（Skills）路由（第 2.4 步）：全部走 /api/v1，写操作、扫描与导入均限制在本机执行。
import { Hono } from 'hono';
import {
  CreateSkillBody, ImportLocalSkillsBody, PatchSkillBody, PutTaskSkillOverridesBody,
  ScanLocalSkillsBody, ScanSkillContentBody,
} from '@aic/protocol';
import type { Services } from '../services';
import { requireLocal } from './access-guard';
import { readBody, type Env } from './app';

export function skillRoutes(s: Services) {
  const r = new Hono<Env>();

  r.get('/skills', (c) => c.json({ items: s.skills.list(), nextCursor: null }));

  r.post('/skills/scan-content', async (c) => {
    requireLocal(c, '请在这台电脑上扫描并添加技能');
    const body = await readBody(c, ScanSkillContentBody);
    return c.json(s.skills.scanContent(body));
  });

  r.post('/skills/scan-local', async (c) => {
    requireLocal(c, '请在这台电脑上扫描本机技能目录');
    const body = await readBody(c, ScanLocalSkillsBody);
    return c.json(s.skills.scanLocal(body));
  });

  r.post('/skills/import-local', async (c) => {
    requireLocal(c, '请在这台电脑上导入本机技能');
    const body = await readBody(c, ImportLocalSkillsBody);
    return c.json(s.skills.importLocal(body));
  });

  r.get('/skills/:id', (c) => c.json(s.skills.get(c.req.param('id'))));

  r.post('/skills', async (c) => {
    requireLocal(c, '请在这台电脑上添加技能');
    const body = await readBody(c, CreateSkillBody);
    return c.json(s.skills.create(body), 201);
  });

  r.patch('/skills/:id', async (c) => {
    requireLocal(c, '请在这台电脑上修改技能设置');
    const body = await readBody(c, PatchSkillBody);
    return c.json(s.skills.patch(c.req.param('id'), body));
  });

  r.delete('/skills/:id', (c) => {
    requireLocal(c, '请在这台电脑上删除技能');
    s.skills.delete(c.req.param('id'));
    return c.json({ ok: true });
  });

  r.get('/tasks/:id/skills', (c) => {
    const row = s.tasks.getRow(c.req.param('id'));
    return c.json(s.skills.taskSkills(row.id, row.agent));
  });

  r.put('/tasks/:id/skills', async (c) => {
    const row = s.tasks.getRow(c.req.param('id'));
    const body = await readBody(c, PutTaskSkillOverridesBody);
    return c.json(s.skills.setTaskOverrides(row.id, row.agent, body.disabledSkillIds));
  });

  return r;
}
