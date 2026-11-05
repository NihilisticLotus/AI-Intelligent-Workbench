import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ErrorCode, ServerFrame, type Approval, type EventEnvelope, type Task } from '@aic/protocol';
import { allowEditApproval, isCommandApproval, makeProject, startGw, WsClient, type TestGw } from './helpers';

let t: TestGw; let token: string; let ws: WsClient; let projectId: string;

beforeEach(async () => {
  t = await startGw();
  token = await t.pair();
  projectId = (await makeProject(t, token)).id;
  ws = await WsClient.connect(t.port, token);
  await ws.call({ op: 'subscribe', data: { lastSeq: 0 } });
});
afterEach(async () => { await ws.close(); await t.stop(); });

const statusIs = (taskId: string, s: string) => (e: EventEnvelope) =>
  e.type === 'task.updated' && e.taskId === taskId && (e.data as { task: Task }).task.status === s;

async function createTask(permission: string, prompt = '把主角的跳跃调高一点') {
  const r = await t.api('POST', '/tasks', { token, body: { projectId, prompt, agent: 'fake', permission } });
  expect(r.status).toBe(201);
  return r.json as Task;
}

const ofTask = (id: string) => ws.events().filter((e) => e.taskId === id);
const types = (id: string) => ofTask(id).map((e) => e.type);

describe('演示 Agent', () => {
  it('出现在 /agents 里，带模型和思考强度', async () => {
    const r = await t.api('GET', '/agents', { token });
    const fake = r.json.items.find((a: { kind: string }) => a.kind === 'fake');
    expect(fake.displayName).toBe('演示 Agent（无需登录）');
    expect(fake.status).toBe('ready');
    expect(fake.models.map((m: { name: string }) => m.name)).toEqual(['演示-快', '演示-深思']);
    expect(fake.efforts).toEqual(['低', '中', '高']);
  });

  it('需审批：完整流程 → 等待审批 → 允许 → 待验收', async () => {
    const task = await createTask('ask');
    // 需审批：先审批修改文件，再审批执行命令（design.md 9.1）
    await allowEditApproval(ws, task.id);
    const req = await ws.waitEvent(isCommandApproval(task.id));
    const approval = (req.data as { approval: Approval }).approval;
    expect(approval.detail).toContain('Unity');
    await ws.waitEvent(statusIs(task.id, 'waiting'));

    const ty = types(task.id);
    // 按真实节奏：思考 → 流式回复 → 工具 → 计划 → 审批
    expect(ty.indexOf('thought.delta')).toBeLessThan(ty.indexOf('message.delta'));
    expect(ty.indexOf('message.delta')).toBeLessThan(ty.indexOf('tool.start'));
    expect(ty).toContain('plan.update');
    const tools = ofTask(task.id).filter((e) => e.type === 'tool.start').map((e) => (e.data as { kind: string; target: string }));
    expect(tools.map((x) => x.kind)).toEqual(['read', 'search', 'edit', 'execute']);
    expect(tools[0]!.target).toMatch(/^Assets\/Scripts\//);

    const pending = await t.api('GET', '/approvals?status=pending', { token });
    expect(pending.json.items.map((a: Approval) => a.id)).toEqual([approval.id]);

    const ack = await ws.call({ op: 'approve', data: { approvalId: approval.id, optionId: 'allow' } });
    expect(ack.ok).toBe(true);
    await ws.waitEvent(statusIs(task.id, 'review'));
    const resolved = ofTask(task.id).find((e) => e.type === 'approval.resolved' && (e.data as { approvalId: string }).approvalId === approval.id)!;
    expect(resolved.data).toMatchObject({ approvalId: approval.id, status: 'allowed', optionId: 'allow' });
    expect((resolved.data as { decidedBy: string }).decidedBy).toBeTruthy();
    const ends = ofTask(task.id).filter((e) => e.type === 'tool.end');
    expect(ends.at(-1)!.data).toMatchObject({ ok: true });
    const text = ofTask(task.id).filter((e) => e.type === 'message.delta').map((e) => (e.data as { text: string }).text).join('');
    expect(text).toContain('完成了');
    expect((await t.api('GET', '/approvals?status=pending', { token })).json.items).toHaveLength(0);
    // 再审批一次：已处理
    const again = await ws.call({ op: 'approve', data: { approvalId: approval.id, optionId: 'allow' } });
    expect(again.ok).toBe(false);
  });

  it('拒绝：带上理由换个说法回复，任务变待验收', async () => {
    const task = await createTask('ask');
    await allowEditApproval(ws, task.id);
    const req = await ws.waitEvent(isCommandApproval(task.id));
    const approval = (req.data as { approval: Approval }).approval;
    await ws.call({ op: 'approve', data: { approvalId: approval.id, optionId: 'reject', note: '编辑器正开着，别跑批处理' } });
    await ws.waitEvent(statusIs(task.id, 'review'));
    const resolved = ofTask(task.id).find((e) => e.type === 'approval.resolved' && (e.data as { approvalId: string }).approvalId === approval.id)!;
    expect(resolved.data).toMatchObject({ status: 'rejected' });
    const lastEnd = ofTask(task.id).filter((e) => e.type === 'tool.end').at(-1)!;
    expect(lastEnd.data).toMatchObject({ ok: false });
    const text = ofTask(task.id).filter((e) => e.type === 'message.delta').map((e) => (e.data as { text: string }).text).join('');
    expect(text).toContain('编辑器正开着，别跑批处理');
    expect(text).toContain('Test Runner');
  });

  it('取消：等待审批时取消 → 审批作废，任务暂停；之后可以继续发消息', async () => {
    const task = await createTask('ask');
    const req = await ws.waitEvent((e) => e.type === 'approval.requested' && e.taskId === task.id);
    const approval = (req.data as { approval: Approval }).approval;
    expect((await ws.call({ op: 'cancel', data: { taskId: task.id } })).ok).toBe(true);
    await ws.waitEvent(statusIs(task.id, 'paused'));
    const resolved = ofTask(task.id).find((e) => e.type === 'approval.resolved')!;
    expect(resolved.data).toMatchObject({ approvalId: approval.id, status: 'expired' });
    // 所有开始的工具都已收尾
    const started = ofTask(task.id).filter((e) => e.type === 'tool.start').length;
    const ended = ofTask(task.id).filter((e) => e.type === 'tool.end').length;
    expect(ended).toBe(started);

    const ack = await ws.call({ op: 'prompt', data: { taskId: task.id, text: '继续，直接跑测试' } });
    expect(ack.ok).toBe(true);
    await ws.waitEvent((e) => e.type === 'approval.requested' && e.taskId === task.id && (e.data as { approval: Approval }).approval.id !== approval.id);
  });

  it('取消：执行中途取消', async () => {
    const slow = await startGw({ fakeSpeed: 1 });
    try {
      const tk = await slow.pair();
      const p = await makeProject(slow, tk);
      const c = await WsClient.connect(slow.port, tk);
      await c.call({ op: 'subscribe', data: { lastSeq: 0 } });
      const r = await slow.api('POST', '/tasks', { token: tk, body: { projectId: p.id, prompt: '调一下跳跃', agent: 'fake', permission: 'full' } });
      await c.waitEvent((e) => e.type === 'thought.delta');
      await c.call({ op: 'cancel', data: { taskId: r.json.id } });
      await c.waitEvent((e) => e.type === 'task.updated' && (e.data as { task: Task }).task.status === 'paused');
      expect(c.events().some((e) => e.type === 'tool.start' && (e.data as { kind: string }).kind === 'execute')).toBe(false);
      await c.close();
    } finally { await slow.stop(); }
  });

  it('全自动：不发审批，直接执行', async () => {
    const task = await createTask('full');
    await ws.waitEvent(statusIs(task.id, 'review'));
    expect(types(task.id)).not.toContain('approval.requested');
    expect(ofTask(task.id).some((e) => e.type === 'tool.end' && (e.data as { summary: string }).summary.includes('通过'))).toBe(true);
  });

  it('只读：拒绝修改类工具，并在回复里说明', async () => {
    const task = await createTask('readonly');
    await ws.waitEvent(statusIs(task.id, 'review'));
    expect(types(task.id)).not.toContain('approval.requested');
    const edit = ofTask(task.id).find((e) => e.type === 'tool.start' && (e.data as { kind: string }).kind === 'edit')!;
    const editEnd = ofTask(task.id).find((e) => e.type === 'tool.end' && (e.data as { toolId: string }).toolId === (edit.data as { toolId: string }).toolId)!;
    expect(editEnd.data).toMatchObject({ ok: false });
    expect(ofTask(task.id).some((e) => e.type === 'tool.start' && (e.data as { kind: string }).kind === 'execute')).toBe(false);
    const text = ofTask(task.id).filter((e) => e.type === 'message.delta').map((e) => (e.data as { text: string }).text).join('');
    expect(text).toContain('只读');
  });

  it('switch 换模型和思考强度时发 session.config', async () => {
    const task = await createTask('full');
    await ws.waitEvent(statusIs(task.id, 'review'));
    const ack = await ws.call({ op: 'switch', data: { taskId: task.id, model: 'demo-deep', effort: '高' } });
    expect(ack.ok).toBe(true);
    const cfg = await ws.waitEvent((e) => e.type === 'session.config' && e.taskId === task.id);
    expect(cfg.data).toMatchObject({ model: 'demo-deep', effort: '高' });
    expect((await t.api('GET', `/tasks/${task.id}`, { token })).json).toMatchObject({ model: 'demo-deep', effort: '高' });
    const bad = await ws.call({ op: 'switch', data: { taskId: task.id, model: 'gpt-x' } });
    expect(bad.ok).toBe(false);
    expect(bad.error?.code).toBe(ErrorCode.BadRequest);
  });

  it('执行中再次发送消息会被拒绝', async () => {
    const task = await createTask('ask');
    await ws.waitEvent((e) => e.type === 'approval.requested' && e.taskId === task.id);
    const ack = await ws.call({ op: 'prompt', data: { taskId: task.id, text: '再来' } });
    expect(ack.ok).toBe(false);
    expect(ack.error?.code).toBe(ErrorCode.InvalidState);
  });
});

describe('WebSocket 指令', () => {
  it('每条 op 都回 ack；重复的 id 返回第一次的结果，不重复执行', async () => {
    const task = await createTask('full');
    await ws.waitEvent(statusIs(task.id, 'review'));
    const before = ofTask(task.id).filter((e) => e.type === 'message.user').length;
    const a1 = await ws.call({ id: 'dup-1', op: 'prompt', data: { taskId: task.id, text: '再调一次' } });
    expect(a1.ok).toBe(true);
    await ws.waitEvent((e) => statusIs(task.id, 'review')(e) && e.seq > 0 && ofTask(task.id).filter((x) => x.type === 'message.user').length > before);
    await t.gw.services.tasks.idle();

    // 同一连接重发
    const a2 = await ws.call({ id: 'dup-1', op: 'prompt', data: { taskId: task.id, text: '再调一次' } });
    expect(a2).toEqual(a1);
    // 断线重连后用同一个 id 重发：依然不重复执行
    await ws.close();
    ws = await WsClient.connect(t.port, token);
    const a3 = await ws.call({ id: 'dup-1', op: 'prompt', data: { taskId: task.id, text: '再调一次' } });
    expect(a3).toEqual(a1);
    await t.gw.services.tasks.idle();
    const users = t.gw.services.events.read({ after: 0, limit: 10_000, taskId: task.id }).filter((e) => e.type === 'message.user');
    expect(users).toHaveLength(before + 1);
  });

  it('格式错误的指令回 ack ok=false；ping 回 pong', async () => {
    ws.ws.send(JSON.stringify({ id: 'bad-1', op: 'prompt', data: {} }));
    const f = await ws.waitFor((x) => x.kind === 'ack' && x.id === 'bad-1');
    expect(ServerFrame.parse(f)).toMatchObject({ ok: false, error: { code: ErrorCode.BadRequest } });
    const ack = await ws.call({ op: 'ping', data: {} });
    expect(ack.ok).toBe(true);
    expect(ws.frames.some((x) => x.kind === 'pong')).toBe(true);
  });

  it('所有服务端帧都符合协议', async () => {
    const task = await createTask('ask');
    await allowEditApproval(ws, task.id);
    const req = await ws.waitEvent(isCommandApproval(task.id));
    await ws.call({ op: 'approve', data: { approvalId: (req.data as { approval: Approval }).approval.id, optionId: 'allow' } });
    await ws.waitEvent(statusIs(task.id, 'review'));
    for (const f of ws.frames) expect(ServerFrame.safeParse(f).success).toBe(true);
  });
});
