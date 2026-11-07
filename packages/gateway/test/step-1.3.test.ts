import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createFakeAdapter } from '@aic/adapters';
import { AttachmentService, sniffAttachment } from '../src/attachments';
import { openDb, SCHEMA_VERSION } from '../src/db';
import { createGateway } from '../src/server';
import { makeProject, startGw, type TestGw } from './helpers';
let t: TestGw | null = null;
afterEach(async () => { vi.useRealTimers(); await t?.stop(); t = null; });
const png = () => { const b = Buffer.alloc(24); Buffer.from([137,80,78,71,13,10,26,10]).copy(b); b.writeUInt32BE(12,16); b.writeUInt32BE(34,20); return b; };
async function setup(extra: Parameters<typeof startGw>[0] = {}) {
  t = await startGw(extra); const token = await t.pair(); const p = await makeProject(t, token);
  const task = await t.gw.services.tasks.create({ projectId: p.id, agent: 'fake', prompt: '', permission: 'readonly', deferPrompt: true });
  return { token, task, s: t.gw.services };
}
async function upload(token: string, taskId: string, b: Buffer, name = '../截图.png', headers = {}) {
  return fetch(`http://127.0.0.1:${t!.port}/api/v1/tasks/${taskId}/attachments`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain', 'x-aic-filename': encodeURIComponent(name), ...headers }, body: new Uint8Array(b) });
}
describe('附件接口和迁移 v5', () => {
  it('迁移只追加，并能重新打开已有数据库', async () => {
    const { s } = await setup(); expect(SCHEMA_VERSION).toBe(5); expect(s.db.get<{user_version:number}>('PRAGMA user_version')?.user_version).toBe(5);
    expect(s.db.all('PRAGMA table_info(attachments)').length).toBe(11);
    const db = openDb(path.join(t!.dataDir, 'migration.db')); db.close(); const db2 = openDb(path.join(t!.dataDir, 'migration.db')); expect(db2.all('SELECT * FROM model_failures')).toEqual([]); db2.close();
  });
  it('上传按头判断、清洗名字；下载带鉴权和安全响应头', async () => {
    const { token, task } = await setup(); const r = await upload(token, task.id, png()); expect(r.status).toBe(201); const a = await r.json();
    expect(a).toMatchObject({ name: '.._截图.png', mime: 'image/png', kind: 'image', width: 12, height: 34 });
    const get = await t!.api('GET', `/tasks/${task.id}/attachments/${a.id}`, { token }); expect(get.status).toBe(200); expect(get.headers['content-type']).toBe('image/png'); expect(get.headers['x-content-type-options']).toBe('nosniff');
    expect((await t!.api('GET', `/tasks/${task.id}/attachments/${a.id}`)).status).toBe(401);
    expect((await upload(token, task.id, png(), 'x', { origin: 'https://evil.example' })).status).toBe(403);
    expect((await t!.api('POST', `/tasks/${task.id}/attachments`, {token,headers:{host:'evil.example'}})).status).toBe(403);
    const svg = await (await upload(token, task.id, Buffer.from('<svg onload="x"/>'), 'x.svg')).json(); expect(svg.kind).toBe('file');
    const download = await t!.api('GET', `/tasks/${task.id}/attachments/${svg.id}`, { token }); expect(download.headers['content-disposition']).toContain('attachment;'); expect(download.headers['content-type']).toContain('text/plain');
  });
  it('拒绝可执行文件、20 MB、图片 5 MB、50 个和 200 MB 上限', async () => {
    const { token, task, s } = await setup();
    expect((await upload(token, task.id, Buffer.from('MZ123'))).status).toBe(415);
    expect(() => sniffAttachment(Buffer.from([127,69,76,70]))).toThrow('可执行');
    expect((await t!.api('POST', `/tasks/${task.id}/attachments`, {token,headers:{'content-length':String(20*1024*1024+1)}})).status).toBe(413);
    const big = Buffer.alloc(5*1024*1024+1); png().copy(big); expect((await upload(token, task.id, big)).status).toBe(413);
    const a = s.attachments.upload(task.id, 'x', Buffer.from('abc'));
    s.db.run('UPDATE attachments SET size = ? WHERE id = ?', 200*1024*1024, a.id);
    expect(() => s.attachments.upload(task.id,'x',Buffer.from('a'))).toThrow('200 MB');
    s.db.run('UPDATE attachments SET size = 1 WHERE id = ?', a.id);
    for (let i=1;i<50;i++) s.attachments.upload(task.id,'x',Buffer.from('a'));
    expect((await upload(token, task.id, Buffer.from('a'))).status).toBe(400);
  });
  it('deferPrompt 不启动，附件纯消息、归属和看图限制', async () => {
    const { task, s } = await setup(); expect(task.status).toBe('draft'); expect(s.events.read({ after: 0, taskId: task.id, limit: 100 }).some((e) => e.type === 'message.user')).toBe(false);
    const a = s.attachments.upload(task.id,'x.png',png());
    const other = await s.tasks.create({ projectId: task.projectId, agent: 'fake', prompt: '', permission: 'readonly', deferPrompt: true });
    await expect(s.tasks.prompt(other.id,'',[a.id])).rejects.toMatchObject({ status: 404, body: { code: 'attachment.not_found' } });
    await s.tasks.switch(task.id,{ model: 'demo-deep' });
    await expect(s.tasks.prompt(task.id,'',[a.id])).rejects.toMatchObject({ status: 415, body: { code: 'attachment.unsupported' } });
    await s.tasks.switch(task.id,{ model: 'demo-fast' }); await s.tasks.prompt(task.id,'',[a.id]);
    await vi.waitFor(() => expect(s.tasks.get(task.id).status).toBe('review'));
    const events = s.events.read({ after: 0, taskId: task.id, limit: 1000 });
    expect(events.find((e) => e.type === 'message.user')?.data).toMatchObject({ text: '', attachments: [{ id: a.id }] });
    expect(JSON.stringify(events)).not.toContain('base64');
    expect(s.db.get<{used_at:number}>('SELECT used_at FROM attachments WHERE id = ?',a.id)?.used_at).toBeGreaterThan(0);
  });
  it('未引用 24 小时清理、草稿过期过滤、删除任务附件目录', async () => {
    const { token, task, s } = await setup(); const a = s.attachments.upload(task.id,'x',Buffer.from('a')); const used = s.attachments.upload(task.id,'y',Buffer.from('b'));
    const file = s.attachments.get(task.id, a.id).path; s.attachments.markUsed(task.id,[used.id]);
    await t!.api('PUT', `/tasks/${task.id}/draft`, { token, body: { text:'',annotations:[],attachments:[a.id] } });
    s.attachments.cleanup(Date.now()+24*60*60_000+100); expect(existsSync(file)).toBe(false); expect(s.attachments.get(task.id,used.id).info.id).toBe(used.id);
    expect((await t!.api('GET', `/tasks/${task.id}/draft`, { token })).json.attachments).toEqual([]);
    s.attachments.deleteTask(task.id); expect(existsSync(path.dirname(file))).toBe(false);
  });
  it('GIF、WebP、JPEG 尺寸与二进制类型', () => {
    const gif=Buffer.alloc(10);gif.write('GIF89a');gif.writeUInt16LE(10,6);gif.writeUInt16LE(20,8);expect(sniffAttachment(gif)).toMatchObject({mime:'image/gif',width:10,height:20});
    const webp=Buffer.alloc(30);webp.write('RIFF');webp.write('WEBP',8);webp.write('VP8X',12);webp.writeUIntLE(10,24,3);webp.writeUIntLE(20,27,3);expect(sniffAttachment(webp)).toMatchObject({mime:'image/webp',width:11,height:21});
    const jpeg=Buffer.from([255,216,255,192,0,9,8,0,20,0,10,0,0]);expect(sniffAttachment(jpeg)).toMatchObject({mime:'image/jpeg',width:10,height:20});
    expect(sniffAttachment(Buffer.from([0,255]))).toMatchObject({mime:'application/octet-stream',kind:'file'});
  });
});
describe('退出记录', () => {
  it('正常关闭后 hello clean=true，遗留启动记录 clean=false', async () => {
    await setup(); const dir=t!.dataDir; await t!.gw.close();
    expect(readFileSync(path.join(dir,'logs','gateway.log'),'utf8')).toContain('正常退出');
    const g=await createGateway({dataDir:dir,port:0,openBrowser:false,realAgents:false,log:()=>{}});expect(g.services.lastExit?.clean).toBe(true);await g.close();
    writeFileSync(path.join(dir,'logs','gateway.log'),new Date().toISOString()+' INFO 生命周期 '+JSON.stringify({phase:'start',pid:999,at:1,reason:'启动'})+'\n');
    const g2=await createGateway({dataDir:dir,port:0,openBrowser:false,realAgents:false,log:()=>{}});expect(g2.services.lastExit).toMatchObject({clean:false,at:1});await g2.close();
  });
});
describe('无回应计时', () => {
  it('60 秒提醒、同 id 两分钟替换、10 分钟取消并暂停', async () => {
    const fake=createFakeAdapter({speed:0});
    const {task,s}=await setup({ adapters:[{...fake,spawn:async (o)=>{const c=await fake.spawn(o);c.prompt=async (_,signal)=>new Promise((resolve)=>signal.addEventListener('abort',()=>resolve({stopReason:'cancelled'}),{once:true}));return c;}}] });
    vi.useFakeTimers(); await s.tasks.prompt(task.id,'等待'); await vi.advanceTimersByTimeAsync(0); await vi.advanceTimersByTimeAsync(60_000);
    const notices=()=>s.events.read({after:0,taskId:task.id,limit:1000}).filter((e): e is import('@aic/protocol').EventOf<'session.notice'> => e.type==='session.notice' && !!e.data.id);
    expect(notices()).toHaveLength(1);await vi.advanceTimersByTimeAsync(120_000);expect(notices()).toHaveLength(2);expect(notices()[0]!.data.id).toBe(notices()[1]!.data.id);
    await vi.advanceTimersByTimeAsync(420_000);expect(s.tasks.get(task.id).status).toBe('paused');expect(s.events.read({after:0,taskId:task.id,limit:1000}).some((e)=>e.type==='error' && e.data.error.code==='agent.no_response')).toBe(true);
  });
  it('等待审批期间不计时，处理后重新计时', async () => {
    const fake=createFakeAdapter({speed:0});
    const {task,s}=await setup({ adapters:[{...fake,spawn:async(o)=>{const c=await fake.spawn(o);c.prompt=async(_,signal)=>{await o.host.requestPermission({toolId:'tc',title:'审批',reason:'测试',detail:'',cwd:null,options:[{id:'yes',label:'允许',kind:'allow_once'}]},signal);return {stopReason:'end_turn'};};return c;}}] });
    await s.tasks.patch(task.id,{permission:'ask'});vi.useFakeTimers();await s.tasks.prompt(task.id,'审批');await vi.advanceTimersByTimeAsync(0);await vi.advanceTimersByTimeAsync(700_000);
    expect(s.tasks.get(task.id).status).toBe('waiting');expect(s.events.read({after:0,taskId:task.id,limit:1000}).some((e)=>e.type==='error')).toBe(false);await s.tasks.cancel(task.id);await vi.advanceTimersByTimeAsync(0);
  });
});
