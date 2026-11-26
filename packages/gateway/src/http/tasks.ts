// 任务、事件、Agent、审批
import { MergeWorkspaceBody, PrepareWorkspaceBody, RestoreWorkspaceFileBody, MoveQueuedTaskBody } from '@aic/protocol';
import { Hono } from 'hono';
import { ApprovalsQuery, CreateTaskBody, EventsQuery, PatchTaskBody, PutTaskDraftBody, TasksQuery, type TaskDraft } from '@aic/protocol';
import { IndependentTaskOptions, PutIndependentTaskBody, IndependentRecoveryBody, IndependentHistoryQuery, IndependentCheckpointBody } from '@aic/protocol';
import type { Services } from '../services';
import { Errors } from '../util';
import { parseQuery, readBody, type Env } from './app';
import { taskUsage } from '../usage';
import { taskFiles } from '../task-files';
import { AddTaskConstraint, HandoffTarget, HandoffReturnBody } from '@aic/protocol';
import { previewHandoff } from '../handoff/preview';
import { confirmRemote, requireLocal } from './access-guard';

export function taskRoutes(s: Services) {
  const r = new Hono<Env>();

  r.get('/tasks', (c) => c.json(s.tasks.list(parseQuery(c, TasksQuery))));
  r.post('/tasks', async (c) => {
    const body = await readBody(c, CreateTaskBody);
    if (body.permission === 'workspace' || body.permission === 'full') await confirmRemote(c, s, 'task.permission', body.projectId);
    return c.json(await s.tasks.create(body), 201);
  });
  r.get('/tasks/:id', (c) => c.json(s.tasks.get(c.req.param('id'))));
  r.post('/tasks/:id/handoff/preview', async c => c.json(await previewHandoff(s,c.req.param('id'),await readBody(c,HandoffTarget))));
  r.get('/tasks/:id/handoff/:handoffId',c=>c.json(s.tasks.handoffs!.get(c.req.param('id'),c.req.param('handoffId'))));
  r.get('/tasks/:id/handoff/:handoffId/restore',async c=>c.json(await s.tasks.previewReturn(c.req.param('id'),c.req.param('handoffId'))));
  r.post('/tasks/:id/handoff/:handoffId/return',async c=>{
    const {restoreRevision,...confirmation}=await readBody(c,HandoffReturnBody);
    if (restoreRevision !== undefined) await confirmRemote(c, s, 'workspace.restore_handoff', c.req.param('id'));
    return c.json(await s.tasks.returnHandoff(c.req.param('id'),c.req.param('handoffId'),restoreRevision,confirmation));
  });
  r.delete('/tasks/:id/handoff/:handoffId',async c=>c.json(await s.tasks.cancelHandoff(c.req.param('id'),c.req.param('handoffId'))));
  r.post('/tasks/:id/handoff/:handoffId/redo',async c=>c.json(await s.tasks.redoHandoff(c.req.param('id'),c.req.param('handoffId'),await readBody(c,HandoffReturnBody.omit({restoreRevision:true})))));
  r.get('/tasks/:id/memory', c => c.json({items:s.tasks.memory.list(c.req.param('id'))}));
  r.post('/tasks/:id/memory', async c => {
    const id = c.req.param('id'), input = await readBody(c,AddTaskConstraint);
    return c.json(await s.tasks.updateMemory(id,()=>s.tasks.memory.constrain(id,input)));
  });
  r.delete('/tasks/:id/memory/:itemId', async c => {
    const id=c.req.param('id');
    return c.json(await s.tasks.updateMemory(id,()=>s.tasks.memory.remove(id,c.req.param('itemId'))));
  });
  r.post('/tasks/:id/queue', async c => c.json(s.tasks.moveQueuedTask(c.req.param('id'), (await readBody(c, MoveQueuedTaskBody)).position)));
  r.delete('/tasks/:id', async (c) => {
    const id = c.req.param('id');
    await confirmRemote(c, s, 'workspace.delete_task', id);
    return c.json(await s.tasks.deleteTask(id));
  });
  r.post('/tasks/:id/merge', async (c) => {
    const id = c.req.param('id');
    const body = await readBody(c, MergeWorkspaceBody);
    await confirmRemote(c, s, s.workspaces.get(id)?.kind === 'copy' ? 'workspace.apply' : 'workspace.merge', id);
    return c.json(await s.tasks.finishWorkspace(id, 'merge', body));
  });
  r.post('/tasks/:id/discard', async (c) => {
    const id = c.req.param('id');
    await confirmRemote(c, s, 'workspace.discard', id);
    return c.json(await s.tasks.finishWorkspace(id, 'discard'));
  });
  r.post('/tasks/:id/rollback', async (c) => {
    const id = c.req.param('id');
    await confirmRemote(c, s, 'workspace.rollback', id);
    return c.json(await s.tasks.finishWorkspace(id, 'rollback'));
  });
  r.post('/tasks/:id/workspace/open', async (c) => {
    requireLocal(c, '请在这台电脑上打开资源管理器');
    return c.json(await s.tasks.finishWorkspace(c.req.param('id'), 'open'));
  });
  r.post('/tasks/:id/workspace/prepare', async (c) => { await readBody(c, PrepareWorkspaceBody); return c.json(await s.tasks.confirmWorkspace(c.req.param('id'))); });
  r.get('/tasks/:id/changes', async c => { const id = c.req.param('id'); return c.json(await s.tasks.workspaceOperation(id, manager => manager.diff(id))); });
  r.get('/tasks/:id/changes/file', async c => { const id = c.req.param('id'); return c.json(await s.tasks.workspaceOperation(id, manager => manager.fileDiff(id, c.req.query('path') ?? ''))); });
  r.post('/tasks/:id/changes/restore', async (c) => {
    const id = c.req.param('id');
    const body = await readBody(c, RestoreWorkspaceFileBody);
    await confirmRemote(c, s, 'workspace.restore_file', id);
    return c.json(await s.tasks.restoreWorkspaceFile(id, body.path));
  });
  r.get('/tasks/:id/usage', (c) => c.json(taskUsage(s.db, c.req.param('id'))));
  r.get('/tasks/:id/files', (c) => c.json({ items: taskFiles(s.db, c.req.param('id')), nextCursor: null }));
  r.patch('/tasks/:id', async (c) => {
    const id = c.req.param('id');
    const body = await readBody(c, PatchTaskBody);
    if (body.permission === 'workspace' || body.permission === 'full' || body.autoAllowLowRisk || body.autoMergeOnPass) {
      await confirmRemote(c, s, 'task.permission', id);
    }
    return c.json(await s.tasks.patch(id, body));
  });
  r.get('/tasks/:id/independent', (c) => c.json(s.independentRuntime.state(c.req.param('id'))));
  r.post('/tasks/:id/independent',async c=>c.json(await s.tasks.updateIndependent(c.req.param('id'),'configure',await readBody(c,IndependentTaskOptions)),201));
  r.put('/tasks/:id/independent', async (c) => {
    const body = await readBody(c, PutIndependentTaskBody);
    return c.json(await s.tasks.updateIndependent(c.req.param('id'), 'configure', body.options, body.expectedRevision));
  });
  r.post('/tasks/:id/independent/recover', async (c) => c.json(await s.tasks.updateIndependent(c.req.param('id'), 'recover', await readBody(c, IndependentRecoveryBody))));
  r.get('/tasks/:id/independent/history', (c) => {
    const q = parseQuery(c, IndependentHistoryQuery);
    return c.json(s.independentRuntime.history(c.req.param('id'), q.after, q.limit));
  });
  r.post('/tasks/:id/independent/checkpoint', async (c) => c.json(await s.tasks.updateIndependent(c.req.param('id'), 'checkpoint', await readBody(c, IndependentCheckpointBody))));
  r.get('/tasks/:id/independent/approvals/:toolId', (c) => c.json(s.independentRuntime.approval(c.req.param('id'), c.req.param('toolId'))));

  r.post('/tasks/:id/attachments', async (c) => {
    s.tasks.getRow(c.req.param('id'));
    let name: string;
    try { name = decodeURIComponent(c.req.header('X-AIC-Filename') ?? '附件'); } catch { throw Errors.badRequest('附件文件名编码无效'); }
    const a = s.attachments.upload(c.req.param('id'), name, Buffer.from(await c.req.arrayBuffer()));
    return c.json(a, 201);
  });
  r.get('/tasks/:id/attachments/:attId', async (c) => {
    const a = await s.attachments.read(c.req.param('id'), c.req.param('attId'), c.req.raw.signal);
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
    if (attachments.length !== ids.length) s.db.run('UPDATE task_drafts SET attachments_json = ? WHERE task_id = ?', JSON.stringify(attachments), id);
    return c.json({ text: row?.text ?? '', annotations, ...(row?.attachments_json ? { attachments } : {}), ...(attachments.length !== ids.length ? { expiredAttachments: true } : {}), updatedAt: row?.updated_at ?? null } satisfies TaskDraft);
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
