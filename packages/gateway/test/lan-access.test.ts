import { AccessAuditEntry, AccessConfirmRequest, ErrorCode, type AccessOperation, type Approval } from '@aic/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemorySecretStore } from '../src/secrets';
import { LAN_ALIAS, LAN_SELECTION, startLanGateway } from './fixtures/lan-gateway';
import { isCommandApproval, makeProject, WsClient, type TestGw } from './helpers';

describe('局域网操作保护与审计', () => {
  let t: TestGw | undefined;
  afterEach(async () => { vi.restoreAllMocks(); await t?.stop(); t = undefined; });

  async function setup(accessConfirmationTtlMs?: number) {
    const gw = await startLanGateway({ secretStore: new MemorySecretStore(), accessConfirmationTtlMs });
    t = gw;
    const token = await gw.pair('本机浏览器');
    const remoteToken = await gw.pair('离线手机');
    expect((await gw.api('PUT', '/access/lan', { token, body: LAN_SELECTION })).status).toBe(200);
    const request = (method: string, url: string, body?: unknown) => gw.api(method, url, { loopback: LAN_ALIAS, token: remoteToken, body });
    const socket = async (loopback?: typeof LAN_ALIAS) => {
      const ws = await WsClient.connect(gw.port, loopback ? remoteToken : token, {}, undefined, loopback);
      await ws.call({ op: 'subscribe', data: { lastSeq: 0 } });
      return ws;
    };
    const decide = (id: string, allow: boolean) => gw.api('POST', `/access/confirmations/${id}/decision`, { token, body: { allow } });
    const findConfirm = async (ws: WsClient, after = 0) => AccessConfirmRequest.parse((await ws.waitEvent((event) =>
      event.type === 'access.confirm_requested' && event.seq > after)).data);
    return { gw, token, request, socket, decide, findConfirm };
  }

  it('敏感 REST 操作都先等电脑确认，本机操作直接执行，允许的请求执行一次', async () => {
    const { gw, token, request, socket, decide, findConfirm } = await setup();
    const project = await makeProject(gw, token, '测试项目');
    const spare = await makeProject(gw, token, '待删除测试项目');
    const device = await gw.pairBrowser('待吊销测试设备');
    const row = await gw.api('POST', '/tasks', { token, body: { projectId: project.id, prompt: '离线测试', agent: 'fake', deferPrompt: true } });
    expect(row.status).toBe(201);
    const task: string = row.json.id;
    const services = gw.gw.services;
    expect(services.workspaces.get(task)?.kind).toBe('copy');
    const finish = vi.spyOn(services.tasks, 'finishWorkspace');
    const restoreFile = vi.spyOn(services.tasks, 'restoreWorkspaceFile');
    const restoreHandoff = vi.spyOn(services.tasks, 'returnHandoff');
    const deleteTask = vi.spyOn(services.tasks, 'deleteTask');
    const putRules = vi.spyOn(services.tasks.permissions, 'put');
    const updateTask = vi.spyOn(services.tasks, 'patch');
    const removeProject = vi.spyOn(services.projects, 'delete');
    const revoke = vi.spyOn(services.auth, 'revoke');
    const createTask = vi.spyOn(services.tasks, 'create');
    const local = await socket();
    try {
      for (const [method, url, operation, payload] of [
        ['POST', '/tasks', 'task.permission', { projectId: project.id, prompt: '开工作区内自动权限', agent: 'fake', permission: 'workspace' }],
        ['POST', '/tasks', 'task.permission', { projectId: project.id, prompt: '开全自动权限', agent: 'fake', permission: 'full' }],
        ['PATCH', `/tasks/${task}`, 'task.permission', { permission: 'full' }],
        ['PUT', `/projects/${project.id}/rules`, 'project.permissions', { revision: 0, items: [] }],
        ['DELETE', `/projects/${spare.id}`, 'project.delete'],
        ['DELETE', `/devices/${device.deviceId}`, 'device.revoke'],
        ['POST', `/tasks/${task}/merge`, 'workspace.apply', { strategy: 'squash', message: '应用测试改动' }],
        ['POST', '/tasks/t_abcdefghijkl/merge', 'workspace.merge', { strategy: 'squash', message: '合并测试改动' }],
        ['POST', `/tasks/${task}/rollback`, 'workspace.rollback'],
        ['POST', `/tasks/${task}/discard`, 'workspace.discard'],
        ['POST', `/tasks/${task}/changes/restore`, 'workspace.restore_file', { path: '离线替身.txt' }],
        ['POST', `/tasks/${task}/handoff/h_abcdefghijkl/return`, 'workspace.restore_handoff', { restoreRevision: '离线版本' }],
        ['DELETE', `/tasks/${task}`, 'workspace.delete_task'],
      ] satisfies Array<[string, string, AccessOperation, unknown?]>) {
        const lastSeq = services.events.lastSeq();
        const running = request(method, url, payload);
        const event = await findConfirm(local, lastSeq);
        expect(event.operation).toBe(operation);
        expect(event.deviceName).toBe('离线手机');
        expect((await request('POST', `/access/confirmations/${event.id}/decision`, { allow: true })).status).toBe(403);
        expect((await decide(event.id, false)).status).toBe(200);
        expect((await running).json).toMatchObject({ code: ErrorCode.AccessConfirmationRequired, message: '请在电脑上确认' });
      }
      for (const fn of [createTask, updateTask, putRules, removeProject, revoke, finish, restoreFile, restoreHandoff, deleteTask]) {
        expect(fn).not.toHaveBeenCalled();
      }
      const lastSeq = services.events.lastSeq();
      const running = request('DELETE', `/projects/${spare.id}`);
      const event = await findConfirm(local, lastSeq);
      expect(event).toMatchObject({ operation: 'project.delete', objectId: spare.id, objectName: '待删除测试项目' });
      expect(removeProject).not.toHaveBeenCalled();
      expect((await decide(event.id, true)).status).toBe(200);
      expect((await decide(event.id, true)).status).toBe(409);
      expect((await running).status).toBe(200);
      expect(removeProject).toHaveBeenCalledExactlyOnceWith(spare.id);
      expect((await gw.api('PUT', `/projects/${project.id}/rules`, { token, body: { revision: 0, items: [] } })).status).toBe(200);
      expect(putRules).toHaveBeenCalledTimes(1);
    } finally { await local.close(); }
  });

  it('普通发消息、审批和停止可从第二监听完成，总是允许才需要电脑确认', async () => {
    const { gw, token, request, socket, decide, findConfirm } = await setup();
    const project = await makeProject(gw, token);
    const created = await request('POST', '/tasks', { projectId: project.id, prompt: '离线普通任务', agent: 'fake', deferPrompt: true });
    expect(created.status).toBe(201);
    const taskId = created.json.id as string;
    const local = await socket();
    const remote = await socket(LAN_ALIAS);
    try {
      expect((await remote.call({ op: 'prompt', data: { taskId, text: '请用演示 Agent 修改测试场景' } })).ok).toBe(true);
      const event = await remote.waitEvent((ev) => ev.type === 'approval.requested' && ev.taskId === taskId);
      const approval = (event.data as { approval: Approval }).approval;
      const approve = vi.spyOn(gw.gw.services.tasks, 'approve');
      const payload = { approvalId: approval.id, optionId: 'allow', alwaysAllow: { revision: 0 } };
      const first = remote.call({ op: 'approve', id: '重复确认指令', data: payload });
      const repeated = remote.call({ op: 'approve', id: '重复确认指令', data: payload });
      const waiting = await findConfirm(local);
      expect(waiting.operation).toBe('project.permissions');
      expect(approve).not.toHaveBeenCalled();
      expect((await decide(waiting.id, false)).status).toBe(200);
      expect((await first).error?.code).toBe(ErrorCode.AccessConfirmationRequired);
      expect((await repeated).error?.code).toBe(ErrorCode.AccessConfirmationRequired);
      expect(local.events().filter((ev) => ev.type === 'access.confirm_requested')).toHaveLength(1);
      expect(approve).not.toHaveBeenCalled();
      expect((await remote.call({ op: 'approve', data: { approvalId: approval.id, optionId: 'allow' } })).ok).toBe(true);
      expect(approve).toHaveBeenCalledTimes(1);
      await remote.waitEvent(isCommandApproval(taskId));
      expect((await remote.call({ op: 'cancel', data: { taskId } })).ok).toBe(true);
      await vi.waitFor(async () => expect((await request('GET', `/tasks/${taskId}`)).json.status).not.toBe('waiting'));
      await remote.call({ op: 'subscribe', data: { lastSeq: 0 } });
      expect(remote.events().filter((ev) => ev.type.startsWith('access.confirm_'))).toHaveLength(0);
    } finally { await Promise.all([local.close(), remote.close()]); }
  });

  it('确认超时、本机页面关闭或不存在时，挂起请求不会执行', async () => {
    const { gw, token, request, socket, decide, findConfirm } = await setup(200);
    const project = await makeProject(gw, token);
    const remove = vi.spyOn(gw.gw.services.projects, 'delete');
    const local = await socket();
    try {
      const timed = request('DELETE', `/projects/${project.id}`);
      const first = await findConfirm(local);
      expect((await timed).json.hint).toContain('没有收到电脑确认');
      expect((await decide(first.id, true)).status).toBe(409);
      const lastSeq = gw.gw.services.events.lastSeq();
      const dropped = request('DELETE', `/projects/${project.id}`);
      await findConfirm(local, lastSeq);
      await local.close();
      expect((await dropped).json.hint).toContain('打开已连接的工作台');
      expect((await request('DELETE', `/projects/${project.id}`)).json.hint).toContain('打开已连接的工作台');
      expect(remove).not.toHaveBeenCalled();
    } finally { await local.close(); }
  });

  it('拦截 Key、授权地址、第三方登录和桌面操作，按游标查看脱敏审计并清理旧记录', async () => {
    const { gw, token, request } = await setup();
    const secret = 'offline-secret-never-in-audit';
    const config = { name: '离线服务', protocol: 'chat_completions', baseUrl: 'https://service.example.test/v1', authentication: 'api_key',
      apiVersion: null, providerId: null, plan: null, enabled: true, apiKey: secret };
    expect((await request('POST', '/independent/services', config)).status).toBe(403);
    const realService = await gw.api('POST', '/independent/services', { token, body: config });
    expect(realService.status).toBe(201);
    const service: string = realService.json.id;
    for (const [method, url, body] of [
      ['POST', '/profiles', { agent: 'fake', name: '离线账号', kind: 'customEndpoint', baseUrl: 'https://service.example.test', apiKey: secret }],
      ['DELETE', '/profiles/pf_abcdefghijkl/secret'],
      ['PATCH', `/independent/services/${service}`, { expectedRevision: 1, apiKey: null }],
      ['PATCH', `/independent/services/${service}`, { expectedRevision: 1, baseUrl: 'https://different.example.test' }],
      ['DELETE', `/independent/services/${service}`],
      ['POST', '/agents/fake/login', { methodId: 'offline' }],
      ['POST', '/agents/fake/login/l_abcdefghijkl/code', { code: secret }],
      ['POST', '/agents/fake/login/l_abcdefghijkl/cancel'],
      ['POST', '/tasks/t_abcdefghijkl/workspace/open'],
    ] as Array<[string, string, unknown?]>) expect((await request(method, url, body)).status, url).toBe(403);
    expect((await request('GET', `/independent/services/${service}`)).json).toMatchObject({ hasSecret: true, baseUrl: config.baseUrl });
    expect((await request('POST', '/groups', { name: '普通写入正文也不入审计' })).status).toBe(201);

    const { db, accessAudit } = gw.gw.services;
    const old = db.run('INSERT INTO audit_log (device_id, action, detail, ts) VALUES (NULL, ?, ?, ?)', 'access.offline_old', '{}', Date.now() - 91 * 24 * 60 * 60_000);
    const migration = db.run("INSERT INTO audit_log (action, ts) VALUES ('migration.v2', ?)", Date.now() - 91 * 24 * 60 * 60_000);
    accessAudit.prune();
    expect(db.get('SELECT id FROM audit_log WHERE id = ?', old.lastInsertRowid)).toBeUndefined();
    expect(db.get('SELECT action FROM audit_log WHERE id = ?', migration.lastInsertRowid)).toEqual({ action: 'migration.v2' });
    db.run('INSERT INTO audit_log (device_id, action, detail, ts) VALUES (NULL, ?, ?, ?)', 'offline.legacy', '旧自由文本', Date.now());
    const first = await request('GET', '/access/audit?limit=2');
    expect(first.status).toBe(200);
    expect(first.json.items).toHaveLength(2);
    const second = await request('GET', `/access/audit?limit=2&cursor=${first.json.nextCursor}`);
    expect(second.json.items).toHaveLength(2);
    expect(first.json.items.every((it: { id: string }) => !second.json.items.some((other: { id: string }) => other.id === it.id))).toBe(true);
    const all = AccessAuditEntry.array().parse((await request('GET', '/access/audit?limit=100')).json.items);
    expect(all).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'http.POST /groups', result: 'ok' }),
      expect.objectContaining({ action: 'http.PATCH /independent/services/:serviceId', objectId: service, result: 'denied' }),
      expect.objectContaining({ action: 'firewall.add', result: 'ok' }),
    ]));
    expect(JSON.stringify(db.all("SELECT detail FROM audit_log WHERE action GLOB 'access.*'"))).not.toMatch(/offline-secret|普通写入正文|different\.example/);
    expect(JSON.stringify(all)).not.toContain('旧自由文本');
  });
});
