import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { IndependentTaskState, type IndependentTaskOptions } from '@aic/protocol';
import { startGw, type TestGw } from './helpers';
import { SCHEMA_VERSION, openDb } from '../src/db';
import { MemorySecretStore } from '../src/secrets';

let gateway: TestGw | undefined, server: Server | undefined;
const directories: string[] = [];
const temporary = () => { const dir = mkdtempSync(path.join(tmpdir(), 'aic-runtime-')); directories.push(dir); return dir; };
afterEach(async () => {
  await gateway?.stop(); gateway = undefined;
  await new Promise<void>((resolve) => { if (!server) return resolve(); server.closeAllConnections(); server.close(() => resolve()); }); server = undefined;
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const done = (text: string) => ({ choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
async function setup(respond: (n: number, body: any) => unknown = () => done('已完成'), fileToolVersion: IndependentTaskOptions['fileToolVersion'] = 'combined_v1') {
  let count = 0; const bodies: any[] = [];
  server = createServer((req, res) => { void (async () => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); bodies.push(body); const output = respond(++count, body);
    if (typeof output === 'string') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(output); }
    else if (output !== undefined) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(output)); }
  })().catch(() => res.destroy()); });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  // 与开发预览相同的敏感目录名，覆盖登记副本在审批规划和执行时的完整路径。
  gateway = await startGw({ secretStore: new MemorySecretStore() }, path.join(temporary(), '.aic-data')); const token = await gateway.pair(), s = gateway.gw.services;
  const workspace = temporary(); writeFileSync(path.join(workspace, 'AGENTS.md'), '请用中文回答。');
  const project = await gateway.api('POST', '/projects', { token, body: { name: '独立任务夹具', path: workspace } });
  const service = await s.independent.createService({ name: '本机离线夹具', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    protocol: 'chat_completions', authentication: 'none', enabled: true, providerId: null, plan: null, apiVersion: null });
  const model = s.independent.createModel(service.id, { name: '夹具模型', remoteModelId: 'fixture' });
  s.independent.overrides(service.id, model.id, { expectedRevision: model.revision, values: { tools: true, contextWindow: 100_000 } });
  const options: IndependentTaskOptions = { selection: { serviceId: service.id, modelId: model.id }, generation: { stream: false }, fileToolVersion,
    context: { mode: 'local' }, limits: { maxModelCalls: 3, maxToolCalls: 3, maxOutputTokens: 1000, maxContextBytes: 1024 * 1024, timeoutMs: 60_000 }, requestBudget: { maxRequests: 10, money: null } };
  const created = await gateway.api('POST', '/tasks', { token, body: { projectId: project.json.id, prompt: '完成测试', agent: 'independent', permission: 'ask', deferPrompt: true, independent: options } });
  expect(created.status).toBe(201);
  return { token, s, options, task: created.json, workspace: created.json.workspace.path as string, originalWorkspace: workspace, bodies, count: () => count,
    state: () => s.independentRuntime.state(created.json.id),
    wait: async () => { await expect.poll(() => s.tasks.get(created.json.id).status, { timeout: 30_000 }).not.toMatch(/^(running|waiting|queued)$/); } };
}

describe('正式独立任务的离线接口与闭环', () => {
  it('零工具长会话自动交接已核实的事实，实收正文说明不能回查', async () => {
    const f = await setup(() => done('接下来核对 Level.txt。'));
    const task = await f.s.tasks.create({projectId:f.task.projectId, agent:'fake', permission:'readonly', prompt:'核对北门', deferPrompt:true});
    const options = {...f.options, limits:{...f.options.limits, maxToolCalls:0}};
    await f.s.tasks.updateIndependent(task.id,'configure',options);
    writeFileSync(path.join(task.workspace!.path!, 'Level.txt'), '北门');
    const base = {taskId:task.id, sessionId:null};
    f.s.events.append({...base,type:'message.done',data:{messageId:'previous',text:'较早的巡视细节。'.repeat(6000)}});
    f.s.events.append({...base,type:'tool.start',data:{toolId:'check',kind:'execute',title:'执行',target:'npm test'}});
    f.s.events.append({...base,type:'tool.end',data:{toolId:'check',ok:false,summary:'北门断言失败'}});
    await f.s.tasks.prompt(task.id,'复述目标',[],{agent:'independent'});
    await f.s.tasks.idle();
    const receipt = f.s.events.read({after:0,taskId:task.id,limit:1000}).find(e=>e.type==='session.handoff');
    expect(receipt?.data).toMatchObject({to:'independent',level:'H4'});
    expect(f.bodies).toHaveLength(1);
    expect(f.bodies[0].tools ?? []).toHaveLength(0);
    const received = JSON.stringify(f.bodies[0].messages);
    for (const fact of ['核对北门','Level.txt','失败：npm test']) expect(received).toContain(fact);
    expect(received).toContain('本次不能回查省略的细节');
    expect(received).not.toMatch(/aic_history|先读 \.aic\/TASK\.md|较早的巡视细节/);
    expect(receipt?.data).toMatchObject({quality:{historyAvailable:false,coveragePassed:true}});
  },60000);
  it('独立会话与演示 Agent 双向交接，沿用同一预算且开启独立的新会话',async()=>{
    const f=await setup(()=>done('已了解交接目标'));
    const {id}=f.task;
    await f.s.tasks.patch(id,{permission:'readonly'});
    await f.s.tasks.prompt(id,'先说明任务');await f.s.tasks.idle();
    await f.s.tasks.prompt(id,'交给演示继续',[],{agent:'fake'});await f.s.tasks.idle();
    expect(f.s.tasks.get(id).agent).toBe('fake');
    await f.s.tasks.prompt(id,'回到独立模型核对',[],{agent:'independent'});await f.s.tasks.idle();
    expect(f.s.tasks.get(id).agent).toBe('independent');
    expect(f.count()).toBe(2);
    const sessions=f.s.db.all<{id:string;parent_session_id:string|null;handoff_id:string|null}>('SELECT * FROM sessions WHERE task_id=? ORDER BY started_at,rowid',id);
    expect(sessions).toHaveLength(3);expect(sessions[2]?.parent_session_id).toBe(sessions[1]?.id);
    expect(sessions[2]?.handoff_id).toBeTruthy();expect(JSON.stringify(f.bodies[1])).toContain('回到独立模型核对');
    expect(f.state().budget.attemptedRequests).toBe(2);
  },60000);
  it.each(['readonly','ask','workspace','full'] as const)('独立文件工具在 %s 档经统一规则决定',async permission=>{
    const f=await setup(n=>n===1?{choices:[{index:0,message:{role:'assistant',content:'',tool_calls:[{id:'auto-file',type:'function',function:{name:'create_file',arguments:JSON.stringify({path:'auto.txt',content:'自动权限测试',createParents:false})}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:5,completion_tokens:5}}:done('完成'),'separate_v2');
    await f.s.tasks.patch(f.task.id,{permission});await f.s.tasks.prompt(f.task.id,'验证文件权限');
    if(permission==='ask'){
      await expect.poll(()=>({status:f.s.tasks.get(f.task.id).status,pending:f.s.tasks.listApprovals('pending').length,errors:f.s.events.read({after:0,taskId:f.task.id,limit:1000}).filter(e=>e.type==='error'||e.type==='session.notice')}),{timeout:30000}).toMatchObject({pending:1});await f.s.tasks.approve(f.s.tasks.listApprovals('pending')[0]!.id,'reject',undefined,'test');
    }
    await f.wait();expect(existsSync(path.join(f.workspace,'auto.txt'))).toBe(permission==='workspace'||permission==='full');
    expect(existsSync(path.join(f.originalWorkspace,'auto.txt'))).toBe(false);
    const approvals=f.s.events.read({after:0,taskId:f.task.id,limit:1000}).filter(e=>e.type==='approval.requested');expect(approvals).toHaveLength(permission==='ask'?1:0);
  },60000);
  it.each(['workspace','full','forbidden'] as const)('独立命令 %s：规则外审批、全自动执行、固定禁止拒绝',async mode=>{
    // 禁止文本只放在输出字符串中；即使保护回归，也不会实际启动 git 或访问网络。
    // 全自动只放行能核对范围的命令，所以这里用 --version；带 -e 内联脚本的情况见下一个用例（ISSUE-0096）。
    const f=await setup(n=>n===1?{choices:[{index:0,message:{role:'assistant',content:'',tool_calls:[{id:'auto-command',type:'function',function:{name:'command',arguments:JSON.stringify({program:process.execPath,args:mode==='forbidden'?['-e','process.stdout.write("git push")']:mode==='full'?['--version']:['-e','process.stdout.write("离线自动命令")'],timeoutMs:10000,maxOutputBytes:4096})}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:5,completion_tokens:5}}:done('完成'));
    await f.s.tasks.patch(f.task.id,{permission:mode==='workspace'?'workspace':'full'});await f.s.tasks.prompt(f.task.id,'验证命令权限');
    if(mode==='workspace'){
      await expect.poll(()=>f.s.tasks.listApprovals('pending').length,{timeout:30000}).toBe(1);await f.s.tasks.approve(f.s.tasks.listApprovals('pending')[0]!.id,'reject',undefined,'test');
    }
    await f.wait();expect(f.state().tools[0]?.state).toBe(mode==='full'?'succeeded':'rejected');
    const result=f.s.independentRuntime.history(f.task.id,0,100).items.find(e=>e.message.role==='tool')?.message;
    expect(result).toMatchObject({outcome:mode==='full'?'ok':'rejected'});expect(f.s.processes.livePids()).toEqual([]);
    if(mode==='forbidden')expect(JSON.stringify(result)).toContain('始终禁止');
  },60000);
  it('全自动下带 -e 内联脚本的独立命令改为审批（ISSUE-0096）',async()=>{
    const f=await setup(n=>n===1?{choices:[{index:0,message:{role:'assistant',content:'',tool_calls:[{id:'inline',type:'function',function:{name:'command',arguments:JSON.stringify({program:process.execPath,args:['-e','process.stdout.write("x")'],timeoutMs:10000,maxOutputBytes:4096})}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:10,completion_tokens:5}}:done('完成'));
    await f.s.tasks.patch(f.task.id,{permission:'full'});await f.s.tasks.prompt(f.task.id,'内联脚本');
    await expect.poll(()=>f.s.tasks.listApprovals('pending').length,{timeout:30000}).toBe(1);await f.s.tasks.approve(f.s.tasks.listApprovals('pending')[0]!.id,'reject',undefined,'test');
    await f.wait();expect(f.state().tools[0]?.state).toBe('rejected');
  },60000);
  it('独立旧任务拒绝自动档，不能直接绕过任务服务开启',async()=>{
    const f=await setup();f.s.db.run('UPDATE tasks SET workspace_kind=NULL WHERE id=?',f.task.id);
    await expect(f.s.tasks.patch(f.task.id,{permission:'full'})).rejects.toThrow('旧任务');
    const host={update:()=>{},requestPermission:async()=>({outcome:'cancelled' as const})};
    await expect(f.s.independentRuntime.open(f.task.id,'unused',f.originalWorkspace,'full',host,false)).rejects.toThrow('旧任务');
  });
  it.each(['allow','deny'] as const)('文件写入遵循项目 %s 规则且不弹审批',async action=>{
    const f=await setup(n=>n===1?{choices:[{index:0,message:{role:'assistant',content:'',tool_calls:[{id:'rule-write',type:'function',function:{name:'create_file',arguments:JSON.stringify({path:'rule.txt',content:'规则测试',createParents:false})}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:10,completion_tokens:5}}:done('完成'),'separate_v2');
    f.s.tasks.permissions.put(f.task.projectId,{revision:0,items:[{action,tool:'edit',match:null,path:'rule.txt'}]});
    await f.s.tasks.prompt(f.task.id,'验证写入规则');await f.wait();
    expect(f.s.tasks.listApprovals('pending')).toEqual([]);expect(existsSync(path.join(f.workspace,'rule.txt'))).toBe(action==='allow');
    expect(f.state().tools[0]?.state).toBe(action==='allow'?'succeeded':'rejected');
    expect(existsSync(path.join(f.originalWorkspace,'rule.txt'))).toBe(false);
  });
  it('读取工具不能绕过项目禁止规则',async()=>{
    const f=await setup(n=>n===1?{choices:[{index:0,message:{role:'assistant',content:'',tool_calls:[{id:'rule-read',type:'function',function:{name:'read_file',arguments:JSON.stringify({path:'private.txt',startLine:1,maxLines:10})}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:10,completion_tokens:5}}:done('完成'),'separate_v2');
    writeFileSync(path.join(f.workspace,'private.txt'),'离线私有测试内容');
    f.s.tasks.permissions.put(f.task.projectId,{revision:0,items:[{action:'deny',tool:'read',match:null,path:'private.txt'}]});
    await f.s.tasks.prompt(f.task.id,'验证读取规则');await f.wait();
    expect(JSON.stringify(f.bodies.at(-1))).not.toContain('离线私有测试内容');
    const messages=f.s.independentRuntime.history(f.task.id,0,100).items.map(e=>e.message);
    expect(messages.find(m=>m.role==='tool')).toMatchObject({outcome:'rejected'});
  });
  it('三轮独立 HTTP 用量不串轮，保留上游报告的总量和思考', async () => {
    const f = await setup(() => ({ ...done('用量夹具'), usage: { prompt_tokens: 10, completion_tokens: 3,
      total_tokens: 13, completion_tokens_details: { reasoning_tokens: 2 } } }));
    for (let i = 0; i < 3; i++) { await f.s.tasks.prompt(f.task.id, `第 ${i + 1} 轮`); await f.s.tasks.idle(); }
    const result = (await gateway!.api('GET', `/tasks/${f.task.id}/usage`, { token: f.token })).json;
    expect(result).toMatchObject({ turns: 3, reportedTurns: 3, total: { inputTokens: 30, outputTokens: 9, thoughtTokens: 6, totalTokens: 39, cacheReadTokens: null } });
    expect(f.count()).toBe(3);
  }, 60_000);
  it('同模型补预算保留绑定与私有续传，下一回合实际 HTTP 成功且账本不重置', async () => {
    const f = await setup(() => ({ choices: [{ index: 0, message: { role: 'assistant', content: '已完成', reasoning_content: '合成思考资料' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
    await f.s.tasks.prompt(f.task.id, '第一轮'); await f.wait();
    const before = f.state(); const sessionId = before.lastTurn!.sessionId; const original = f.s.independentRuntime.store.entries(sessionId);
    expect(original.some((e) => e.message.role === 'assistant' && e.message.continuation)).toBe(true);
    await f.s.tasks.updateIndependent(f.task.id, 'configure', { ...before.options, requestBudget: { ...before.options.requestBudget, maxRequests: 11 } }, before.revision);
    expect(f.state().binding).toEqual(before.binding); expect(f.state().budget.attemptedRequests).toBe(1);
    await f.s.tasks.prompt(f.task.id, '继续'); await f.wait();
    expect(f.count()).toBe(2); expect(f.state().requests.map((r) => r.status)).toEqual(['succeeded', 'succeeded']);
    expect(f.bodies[1].messages.find((m: any) => m.role === 'assistant').reasoning_content).toBe('合成思考资料');
    expect(f.s.independentRuntime.store.entries(sessionId).slice(0, original.length)).toEqual(original);
    const usage = (await gateway!.api('GET', `/tasks/${f.task.id}/usage`, { token: f.token })).json;
    expect(usage).toMatchObject({ turns: 2, reportedTurns: 2, total: { source: 'independent', inputTokens: 20, outputTokens: 4, totalTokens: null } });
    expect(usage.segments).toHaveLength(1);
  }, 60_000);
  it('新任务缺省持久化分开工具；历史无版本配置保持合并，旧客户端更新不降级新版本', async () => {
    const f = await setup(); const { fileToolVersion: _version, ...oldOptions } = f.options;
    const fresh = await gateway!.api('POST', '/tasks', { token: f.token, body: { projectId: f.task.projectId, prompt: '新任务', agent: 'independent', permission: 'ask', deferPrompt: true, independent: oldOptions } });
    expect(fresh.status).toBe(201); const freshId = fresh.json.id;
    expect(f.s.independentRuntime.state(freshId).options.fileToolVersion).toBe('separate_v2');
    await f.s.tasks.updateIndependent(freshId, 'configure', oldOptions, f.s.independentRuntime.state(freshId).revision);
    expect(f.s.independentRuntime.state(freshId).options.fileToolVersion).toBe('separate_v2');
    f.s.db.run('UPDATE independent_task_settings SET options_json=? WHERE task_id=?', JSON.stringify(oldOptions), f.task.id);
    await f.s.tasks.updateIndependent(f.task.id, 'configure', oldOptions, f.state().revision);
    expect(f.state().options.fileToolVersion).toBeUndefined(); expect(f.count()).toBe(0);
  });
  it('分开工具完成创建、分段读取、摘要约束替换与模型继续，审批仍绑定原私有正文', async () => {
    const content = '分开工具的原文', replacement = '分开工具的新文';
    const response = (name: string, args: unknown) => ({ choices: [{ index: 0, message: { role: 'assistant', content: '', tool_calls: [
      { id: name + '-one', type: 'function', function: { name, arguments: JSON.stringify(args) } },
    ] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    const f = await setup((n) => n === 1 ? response('create_file', { path: 'separate.txt', content, createParents: false })
      : n === 2 ? response('read_file', { path: 'separate.txt', startLine: 1, maxLines: 10 })
      : n === 3 ? response('replace_text', { path: 'separate.txt', expectedHash: createHash('sha256').update(content).digest('hex'), oldText: content, newText: replacement }) : done('创建与替换均完成'), 'separate_v2');
    await f.s.tasks.updateIndependent(f.task.id, 'configure', { ...f.options, limits: { ...f.options.limits, maxModelCalls: 5, maxToolCalls: 5 } }, f.state().revision);
    await f.s.tasks.prompt(f.task.id, '创建并改为新文');
    const device = f.s.db.get<{ id: string }>('SELECT id FROM devices LIMIT 1')!;
    for (const kind of ['create', 'replace']) {
      await expect.poll(() => f.s.tasks.listApprovals('pending').length, { timeout: 30_000 }).toBe(1);
      const approval = f.s.tasks.listApprovals('pending')[0]!;
      const detail = await gateway!.api('GET', `/tasks/${f.task.id}/independent/approvals/${approval.independentToolId}`, { token: f.token });
      expect(detail.json.proposal.kind).toBe(kind); expect(detail.json.proposal.afterText).toBe(kind === 'create' ? content : replacement);
      await f.s.tasks.approve(approval.id, 'allow', undefined, device.id);
    }
    await f.wait(); expect(f.count()).toBe(4); expect(readFileSync(path.join(f.workspace, 'separate.txt'), 'utf8')).toBe(replacement);
    const files = (await gateway!.api('GET', `/tasks/${f.task.id}/files`, { token: f.token })).json.items;
    expect(files).toHaveLength(1); expect(files[0]).toMatchObject({ name: 'separate.txt', created: true, added: null, removed: null, source: 'independent' });
    expect(f.state().budget.attemptedRequests).toBe(4);
    const raw = f.s.independentRuntime.history(f.task.id, 0, 100).items;
    expect(raw.map((e) => e.message).filter((message) => message.role === 'tool').map((message) => message.name)).toEqual(['create_file', 'read_file', 'replace_text']);
    expect(JSON.stringify(f.s.events.read({ taskId: f.task.id, after: 0, limit: 500 }))).not.toContain(content);
    const before = f.state();
    await expect(f.s.tasks.updateIndependent(f.task.id, 'configure', { ...before.options, fileToolVersion: 'combined_v1' }, before.revision)).rejects.toThrow('已使用原文件工具');
    expect(f.state()).toEqual(before);
  }, 90_000);
  it.each(['empty', 'extra', 'wrong-tool', 'readonly'])('分开工具 %s 不绕过参数、声明范围或只读权限', async (mode) => {
    const f = await setup((n) => n === 1 ? { choices: [{ index: 0, message: { role: 'assistant', content: '', tool_calls: [
      { id: 'invalid-one', type: 'function', function: { name: mode === 'wrong-tool' ? 'write_file' : 'create_file', arguments: JSON.stringify(mode === 'empty' ? {} : { path: 'must-not-exist.txt', content: '未获准', createParents: false, ...(mode === 'extra' ? { approved: true } : mode === 'wrong-tool' ? { kind: 'create' } : {}) }) } },
    ] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } } : done('未执行文件修改'), 'separate_v2');
    if (mode === 'readonly') await f.s.tasks.patch(f.task.id, { permission: 'readonly' });
    await f.s.tasks.prompt(f.task.id, '不应执行'); await f.wait();
    expect(f.s.tasks.listApprovals('pending')).toEqual([]); expect(existsSync(path.join(f.workspace, 'must-not-exist.txt'))).toBe(false);
    const results = f.s.independentRuntime.history(f.task.id, 0, 100).items.filter((e) => e.message.role === 'tool');
    if (mode === 'wrong-tool') {
      expect(f.count()).toBe(1); expect(results).toEqual([]);
      expect(f.state().requests[0]).toMatchObject({ status: 'failed', settlement: { failure: 'protocol' } }); return;
    }
    expect(f.count()).toBe(2);
    expect(results).toHaveLength(1); expect(results[0]!.message).toMatchObject({ outcome: mode === 'readonly' ? 'rejected' : 'error' });
  }, 90_000);
  it('正式附件以任务身份读取并编码；不支持图片时在发布用户消息和请求前拒绝', async () => {
    const f = await setup(), id = f.task.id;
    const image = f.s.attachments.upload(id, 'pixel.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64'));
    const text = f.s.attachments.upload(id, 'note.txt', Buffer.from('只通过本任务受限附件读取的内容'));
    const selection = f.options.selection;
    let model = f.s.independent.getModel(selection.serviceId, selection.modelId);
    f.s.independent.overrides(model.serviceId, model.id, { expectedRevision: model.revision, values: { imageInput: false } });
    await f.s.tasks.updateIndependent(id, 'configure', f.options, f.state().revision);
    await expect(f.s.tasks.prompt(id, '不支持时阻断', [image.id])).rejects.toMatchObject({ status: 415 });
    expect(f.count()).toBe(0); expect(f.s.independentRuntime.history(id, 0, 100).items).toEqual([]);
    model = f.s.independent.getModel(selection.serviceId, selection.modelId);
    f.s.independent.overrides(model.serviceId, model.id, { expectedRevision: model.revision, values: { imageInput: true } });
    await f.s.tasks.updateIndependent(id, 'configure', { ...f.options, context: { ...f.options.context, imageTokensPerImage: 100 } }, f.state().revision);
    await f.s.tasks.prompt(id, '核对附件', [image.id, text.id]); await f.wait();
    expect(f.count()).toBe(1);
    const encoded = JSON.stringify(f.bodies[0].messages);
    expect(encoded).toContain('data:image/png;base64,'); expect(encoded).toContain('只通过本任务受限附件读取的内容');
    const raw = JSON.stringify(f.s.independentRuntime.history(id, 0, 100));
    expect(raw).toContain(image.id); expect(raw).not.toContain('data:image'); expect(raw).not.toContain('只通过本任务受限附件读取的内容');
    expect(JSON.stringify(f.s.events.read({ taskId: id, after: 0, limit: 500 }))).not.toContain('只通过本任务受限附件读取的内容');
  }, 90_000);
  it('流片段仅在完整终态后确认；坏流不落助手原文，下一次回复换身份', async () => {
    const sse = (value: unknown) => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
    const f = await setup((n) => sse({ choices: [{ index: 0, delta: { content: n === 1 ? '未完成片段' : '完整回复' }, finish_reason: n === 1 ? null : 'stop' }] })
      + (n === 1 ? '' : sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } }) + sse('[DONE]')));
    await f.s.tasks.updateIndependent(f.task.id, 'configure', { ...f.options, generation: { stream: true } }, f.state().revision);
    await f.s.tasks.prompt(f.task.id, '第一轮坏流'); await f.wait();
    expect(f.state().requests[0]!.status).toBe('failed');
    expect(JSON.stringify(f.s.independentRuntime.history(f.task.id, 0, 100))).not.toContain('未完成片段');
    const first = f.s.events.read({ taskId: f.task.id, after: 0, limit: 500 }).filter((e) => e.type === 'message.delta');
    await f.s.tasks.prompt(f.task.id, '第二轮完整流'); await f.wait();
    const completed = f.s.events.read({ taskId: f.task.id, after: 0, limit: 500 }).filter((e) => e.type === 'message.done');
    expect(completed).toHaveLength(1); expect(completed[0]!.data).toMatchObject({ text: '完整回复' });
    expect(completed[0]!.data.messageId).not.toBe(first[0]!.data.messageId); expect(f.count()).toBe(2);
    expect(JSON.stringify(f.s.independentRuntime.history(f.task.id, 0, 100))).toContain('完整回复');
  }, 90_000);
  it('必须显式配置；目录不碰第三方账号，所有新增入口继续鉴权', async () => {
    const f = await setup(); expect(f.count()).toBe(0);
    expect(f.task.independent).toMatchObject({ ...f.options.selection, revision: 1 });
    expect((await gateway!.api('GET', '/agents', { token: f.token })).json.items.find((a: any) => a.kind === 'independent').usesNativeConfig).toBe(false);
    const route = `/tasks/${f.task.id}/independent`;
    expect((await gateway!.api('GET', route)).status).toBe(401);
    expect((await gateway!.api('GET', route, { token: f.token, headers: { Host: 'attacker.example' } })).status).toBe(403);
    expect((await gateway!.api('GET', route, { token: f.token, headers: { Origin: 'https://attacker.example' } })).status).toBe(403);
    expect(IndependentTaskState.safeParse((await gateway!.api('GET', route, { token: f.token })).json).success).toBe(true);
    const invalid = await gateway!.api('POST', '/tasks', { token: f.token, body: { projectId: f.task.projectId, prompt: '测试', agent: 'independent', permission: 'ask' } });
    expect(invalid.status).toBe(400); expect(f.s.db.all('SELECT id FROM agent_profiles WHERE agent=?', 'independent')).toEqual([]);
  });
  it('真实 HTTP driver → 项目文件审批 → 完整工具结果 → 模型继续，正文不写事件', async () => {
    const content = '仅存私有会话与审批详情的文件正文';
    const f = await setup((n) => n === 1 ? { choices: [{ index: 0, message: { role: 'assistant', content: '', tool_calls: [
      { id: 'file-1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ kind: 'create', path: 'answer.txt', content, createParents: false }) } },
    ] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 12, completion_tokens: 20 } } : done('文件已完成'));
    await f.s.tasks.prompt(f.task.id, '请创建文件');
    await expect.poll(() => f.s.tasks.listApprovals('pending').length, { timeout: 30_000 }).toBe(1);
    const approval = f.s.tasks.listApprovals('pending')[0]!;
    expect(approval.independentToolId).toBeTruthy(); expect(JSON.stringify(approval)).not.toContain(content);
    const detail = await gateway!.api('GET', `/tasks/${f.task.id}/independent/approvals/${approval.independentToolId}`, { token: f.token });
    expect(detail.json.proposal.afterText).toBe(content);
    const device = f.s.db.get<{ id: string }>('SELECT id FROM devices LIMIT 1')!;
    await f.s.tasks.approve(approval.id, 'allow', undefined, device.id); await f.wait();
    expect(f.s.tasks.get(f.task.id).status).toBe('review'); expect(readFileSync(path.join(f.workspace, 'answer.txt'), 'utf8')).toBe(content);
    expect(f.count()).toBe(2); expect(f.bodies[1].messages.some((m: any) => m.role === 'tool')).toBe(true);
    expect(f.state().budget).toMatchObject({ attemptedRequests: 2, actualCostMicros: null });
    expect(JSON.stringify(f.s.events.read({ taskId: f.task.id, after: 0, limit: 500 }))).not.toContain(content);
    expect((await gateway!.api('GET', `/tasks/${f.task.id}/independent/approvals/${approval.independentToolId}`, { token: f.token })).status).toBe(404);
  }, 90_000);
  it('停止待审批操作后不写文件，迟到放行失败，下一条消息保留历史', async () => {
    const f = await setup((n) => n === 1 ? { choices: [{ index: 0, message: { role: 'assistant', content: '', tool_calls: [
      { id: 'file-1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ kind: 'create', path: 'cancelled.txt', content: '不应写入', createParents: false }) } },
    ] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 2, completion_tokens: 3 } } : done('继续完成'));
    await f.s.tasks.prompt(f.task.id, '等待审批');
    await expect.poll(() => f.s.tasks.listApprovals('pending').length, { timeout: 30_000 }).toBe(1);
    const approval = f.s.tasks.listApprovals('pending')[0]!;
    await f.s.tasks.cancel(f.task.id); await f.wait();
    await expect(f.s.tasks.approve(approval.id, 'allow', undefined, 'device')).rejects.toThrow('已经处理');
    expect(f.s.tasks.get(f.task.id).status).toBe('paused');
    expect(f.state().tools[0]!.state).toBe('cancelled');
    await f.s.tasks.prompt(f.task.id, '继续'); await f.wait();
    expect(f.count()).toBe(2); expect(f.bodies[1].messages.filter((m: any) => m.role === 'user')).toHaveLength(2);
    expect(f.s.db.all('SELECT id FROM sessions WHERE task_id=?', f.task.id)).toHaveLength(1);
  }, 90_000);
  it('应用配置保留预算与历史请求绑定；过期修订、运行中修改和隐式换模型被拒绝', async () => {
    const f = await setup(); await f.s.tasks.prompt(f.task.id, '第一条'); await f.wait(); const before = f.state();
    const other = f.s.independent.createModel(f.options.selection.serviceId, { name: '第二模型', remoteModelId: 'fixture-2' });
    f.s.independent.overrides(f.options.selection.serviceId, other.id, { expectedRevision: other.revision, values: { tools: true, contextWindow: 100_000 } });
    const next = { ...f.options, selection: { ...f.options.selection, modelId: other.id }, requestBudget: { maxRequests: 12, money: null } };
    await expect(f.s.tasks.switch(f.task.id, { model: other.id })).rejects.toThrow('明确应用');
    await f.s.tasks.updateIndependent(f.task.id, 'configure', next, before.revision);
    const config = f.s.events.read({ taskId: f.task.id, after: 0, limit: 500 }).filter((event) => event.type === 'session.config').at(-1);
    expect(config?.data).toMatchObject({ model: other.id, effort: null, permission: 'ask' });
    expect(f.state().budget.attemptedRequests).toBe(1); expect(f.state().requests[0]!.binding.modelId).toBe(f.options.selection.modelId);
    await expect(f.s.tasks.updateIndependent(f.task.id, 'configure', next, before.revision)).rejects.toThrow('已变化');
    await f.s.tasks.prompt(f.task.id, '第二条');
    await expect(f.s.tasks.updateIndependent(f.task.id, 'configure', next, f.state().revision)).rejects.toThrow('空闲'); await f.wait();
    expect(f.bodies[1].model).toBe('fixture-2'); expect(f.bodies[1].messages.filter((m: any) => m.role === 'user')).toHaveLength(2);
    expect(f.state().requests[1]!.binding.modelId).toBe(other.id); expect(f.state().budget.attemptedRequests).toBe(2);
  }, 90_000);
  it('未知上下文先预检拒绝，没有真实请求，也不把费用显示为零', async () => {
    const f = await setup(); const model = f.s.independent.getModel(f.options.selection.serviceId, f.options.selection.modelId);
    f.s.independent.overrides(model.serviceId, model.id, { expectedRevision: model.revision, values: { contextWindow: null } });
    await f.s.tasks.updateIndependent(f.task.id, 'configure', f.options, 1);
    await f.s.tasks.prompt(f.task.id, '输入'); await f.wait();
    expect(f.count()).toBe(0); expect(f.state().context?.status).toBe('limits_unknown');
    expect(f.state().budget).toMatchObject({ attemptedRequests: 0, actualCostMicros: null });
  }, 60_000);
  it('启动检测只标记需核对，显式恢复保留未知占额且不发送请求', async () => {
    const f = await setup(); const state = f.state();
    f.s.independentRuntime.ledger.reserve(state.binding, { kind: 'model', requestHash: 'b'.repeat(64) });
    f.s.independentRuntime.recoverOnStartup(); expect(f.state().recoveryRequired).toBe(true);
    await expect(f.s.tasks.prompt(f.task.id, '重发')).rejects.toThrow('中断');
    await f.s.tasks.updateIndependent(f.task.id, 'recover', { expectedRevision: state.revision });
    expect(f.state()).toMatchObject({ recoveryRequired: false, budget: { attemptedRequests: 1, pendingRequests: 0, actualCostMicros: null } });
    expect(f.state().requests[0]!.status).toBe('interrupted'); expect(f.count()).toBe(0);
  });
  it('真实命令审批后停止，等待作业与登记进程收尾后才释放任务', async () => {
    const f = await setup((n) => n === 1 ? { choices: [{ index: 0, message: { role: 'assistant', content: '', tool_calls: [
      { id: 'command-1', type: 'function', function: { name: 'command', arguments: JSON.stringify({ program: process.execPath,
        args: ['-e', 'process.stdout.write("开始等待");setInterval(()=>{},1000)'], timeoutMs: 60_000, maxOutputBytes: 4096 }) } },
    ] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 10 } } : done('继续'));
    await f.s.tasks.prompt(f.task.id, '命令');
    await expect.poll(() => f.s.tasks.listApprovals('pending').length, { timeout: 30_000 }).toBe(1);
    const approval = f.s.tasks.listApprovals('pending')[0]!, device = f.s.db.get<{ id: string }>('SELECT id FROM devices LIMIT 1')!;
    expect(f.s.independentRuntime.approval(f.task.id, approval.independentToolId!).kind).toBe('command');
    await f.s.tasks.approve(approval.id, 'allow', undefined, device.id);
    await expect.poll(() => f.state().tools[0]?.pid, { timeout: 10_000 }).toBeTypeOf('number');
    await f.s.tasks.cancel(f.task.id); await f.wait();
    expect(f.state().tools[0]!.state).toBe('cancelled'); expect(f.s.processes.livePids()).toEqual([]);
    expect(f.s.db.all('SELECT pid FROM agent_processes')).toEqual([]);
    expect(f.state().budget.attemptedRequests).toBe(1); expect(f.state().recoveryRequired).toBe(false);
    await f.s.tasks.prompt(f.task.id, '继续'); await f.wait(); expect(f.count()).toBe(2);
  }, 90_000);
  it('只读任务不会放行文件，恢复确认和配置均不绕过忙碌保护', async () => {
    const f = await setup((n) => n === 1 ? { choices: [{ index: 0, message: { role: 'assistant', content: '', tool_calls: [
      { id: 'readonly-1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ kind: 'create', path: 'readonly.txt', content: '不能写', createParents: false }) } },
    ] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1 } } : done('没有修改'));
    await f.s.tasks.patch(f.task.id, { permission: 'readonly' }); await f.s.tasks.prompt(f.task.id, '只读');
    await expect(f.s.tasks.updateIndependent(f.task.id, 'recover', { expectedRevision: 1 })).rejects.toThrow('空闲');
    await f.wait(); expect(f.state().tools[0]!.state).toBe('rejected'); expect(existsSync(path.join(f.workspace, 'readonly.txt'))).toBe(false);
    expect(f.s.tasks.listApprovals('pending')).toEqual([]); expect(f.bodies[1].messages.some((m: any) => m.role === 'tool' && String(m.content).includes('只读'))).toBe(true);
    expect((await f.s.tasks.patch(f.task.id, { permission: 'full' })).permission).toBe('full');
  }, 90_000);
  it('人工总结保留原记录，历史按页读取且只在完整回合边界压缩', async () => {
    const f = await setup(); await f.s.tasks.prompt(f.task.id, '第一轮原文'); await f.wait();
    const history = f.s.independentRuntime.history(f.task.id, 0, 1); expect(history.items).toHaveLength(1); expect(history.nextCursor).toBe(1);
    const all = f.s.independentRuntime.history(f.task.id, 0, 100), tail = all.items.at(-1)!;
    await expect(f.s.tasks.updateIndependent(f.task.id, 'checkpoint', { throughSeq: 1, summary: '总结', expectedTailHash: tail.hash })).rejects.toThrow('完整终态回合');
    await f.s.tasks.updateIndependent(f.task.id, 'checkpoint', { throughSeq: tail.seq, summary: '已完成第一轮', expectedTailHash: tail.hash });
    await f.s.tasks.prompt(f.task.id, '继续第二轮'); await f.wait();
    expect(JSON.stringify(f.bodies[1].messages)).toContain('已完成第一轮'); expect(JSON.stringify(f.bodies[1].messages)).not.toContain('第一轮原文');
    expect(JSON.stringify(f.s.independentRuntime.history(f.task.id, 0, 100))).toContain('第一轮原文');
  }, 90_000);
  it('v11 请求迁移补入历史绑定快照，并且可重复打开', async () => {
    const f = await setup(); f.s.independentRuntime.ledger.reserve(f.state().binding, { kind: 'model', requestHash: 'c'.repeat(64) });
    // 用 SQLite 的备份语句生成独立副本，避免读取实际用户数据。
    const file = path.join(temporary(), 'old.sqlite'); f.s.db.run('VACUUM INTO ?', file);
    const old = new DatabaseSync(file); old.exec('DROP TABLE handoff_summary_requests; DROP TABLE handoff_checkpoints; DROP TABLE handoff_path_aliases; DROP TABLE handoffs; DROP TABLE workspace_artifacts; DROP TABLE task_memory_cursors; DROP TABLE task_memory; DROP TABLE permission_rules; DROP TABLE permission_rule_sets; DROP TABLE workspace_operations; DROP TABLE workspace_preparations; ALTER TABLE projects DROP COLUMN carry_globs; DROP TABLE workspace_records; ALTER TABLE tasks DROP COLUMN workspace_large_files; DROP TABLE saved_environments; DROP TABLE turn_usage; DROP TABLE independent_task_settings; ALTER TABLE independent_request_attempts DROP COLUMN binding_json; ALTER TABLE independent_request_attempts DROP COLUMN currency; ALTER TABLE independent_request_budgets DROP COLUMN revision; PRAGMA user_version=11;'); old.close();
    for (let i = 0; i < 2; i++) { const migrated = openDb(file); try {
      expect(migrated.get('PRAGMA user_version')).toEqual({ user_version: SCHEMA_VERSION });
      const row = migrated.get('SELECT binding_json,currency FROM independent_request_attempts')!;
      expect(JSON.parse(String(row.binding_json))).toEqual(f.state().binding); expect(row.currency).toBe(null);
    } finally { migrated.close(); } }
  });
});
