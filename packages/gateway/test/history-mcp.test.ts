import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { afterEach,describe,expect,it } from 'vitest';
import { HandoffPreview } from '@aic/protocol';
import { createFakeAdapter, type SpawnOptions } from '@aic/adapters';
import { makeProject,startGw,type TestGw } from './helpers';
import { readFileSync,writeFileSync } from 'node:fs';
import path from 'node:path';

let gw:TestGw|undefined;
afterEach(async()=>{await gw?.stop();gw=undefined;});
describe('只读历史 MCP',()=>{
 it('交接会话通过 stdio 列出并使用四个工具，阻止跨任务、浏览器和过期令牌',async()=>{
  const fake=createFakeAdapter({speed:0});
  const seen:SpawnOptions[]=[];
  let queryFromAgent: (()=>Promise<void>) | undefined;
  gw=await startGw({adapters:[{...fake,async spawn(options){
    seen.push(options);
    const connection=await fake.spawn(options);
    if(options.mcpServers?.some(server=>server.name==='aic-history')) {
      const original=connection.prompt.bind(connection);
      connection.prompt=async(...args)=>{
        await queryFromAgent?.();
        return original(...args);
      };
    }
    return connection;
  }}]});
  const token=await gw.pair(), p=await makeProject(gw,token), s=gw.gw.services;
  writeFileSync(path.join(p.path,'notes.txt'),'检查点原文\n');
  writeFileSync(path.join(p.path,'large.txt'),'开头'+String.fromCharCode(9,34,92).repeat(100_000)+'结尾');
  const create=async(prompt:string)=>(await gw!.api('POST','/tasks',{token,body:{projectId:p.id,agent:'fake',permission:'readonly',prompt,deferPrompt:true}})).json.id as string;
  const id=await create('关卡尺寸'), other=await create('禁止返回的另外任务内容');
  const handoffId='ho_local';
  const cp='refs/aic/checkpoints/'+id+'/1';
  const w=s.workspaces.get(id)!;
  await s.workspaces.git.checked(['update-ref',cp,w.snapshotAfter!],{cwd:w.path,gitDir:w.gitDir!,workTree:w.path});
  writeFileSync(path.join(w.path,'notes.txt'),'随后修改\n');
  for(const name of ['Town.unity','Level1.txt']) writeFileSync(path.join(w.path,name),'关卡文件');
  s.events.append({type:'tool.start',taskId:id,sessionId:null,data:{toolId:'env-map',kind:'read',target:'.env.local',title:'读配置'}});
  s.events.append({type:'tool.output',taskId:id,sessionId:null,data:{toolId:'env-map',text:'DEBUG=1\nSCENE_FILE=Town.unity'}});
  s.events.append({type:'message.user',taskId:id,sessionId:null,data:{messageId:'map',text:'关卡改动 Town.unity 和 Level1.txt'}});
  const preview=HandoffPreview.parse((await gw.api('POST','/tasks/'+id+'/handoff/preview',{token,body:{agent:'codex'}})).json);
  preview.document.meta.checkpoint=cp;
  expect(preview.document.vcs.changed.map(file=>file.path)).toEqual(expect.arrayContaining(['已隐藏路径 1','Level1.txt']));
  expect(preview.quality.coveragePassed).toBe(true);
  expect(JSON.stringify(preview)).not.toContain('Town.unity');
  expect(preview.markdown).toContain('关卡改动 已隐藏路径 1 和 Level1.txt');
  expect((await s.workspaces.handoffChanges(id)).files.map(file=>file.path)).toContain('Town.unity');
  s.db.run('INSERT INTO handoffs(id,task_id,from_session_id,to_session_id,level,content_md,document_json,quality_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)',handoffId,id,null,null,'H2',preview.markdown,JSON.stringify(preview.document),JSON.stringify(preview.quality),Date.now());
  await s.tasks.prompt(other,'独立的普通会话');
  await s.tasks.idle();
  expect(seen).toHaveLength(1);
  expect(seen[0]?.mcpServers).toBeUndefined();
  const {sessionId}=await s.tasks.startHandoffRuntime(id,handoffId,{agent:'fake'});
  expect(seen.at(-1)?.cwd).toBe(w.path);
  expect(seen.at(-1)?.mcpServers?.map(m=>m.name)).toEqual(['aic-history']);
  s.events.append({type:'message.user',taskId:id,sessionId:sessionId,data:{messageId:'m',text:'关卡核对，Bearer artificial-history-token'}});
  s.events.append({type:'message.user',taskId:other,sessionId:null,data:{messageId:'m',text:'禁止返回的另外任务内容'}});
  await s.tasks.updateMemory(id,()=>s.tasks.memory.constrain(id,{kind:'constraint',content:'保留原始比例'}));
  const spec=seen.at(-1)!.mcpServers![0]!, env=Object.fromEntries(spec.env.map(e=>[e.name,e.value]));
  const child=spawn(spec.command,spec.args,{env,stdio:['pipe','pipe','ignore'],windowsHide:true});
  const exit=new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('exit',()=>resolve());});
  const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
  let requestId=0;
  async function rpc(method:string,params:unknown={}) {
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:++requestId,method,params})+'\n');
    const reply=await lines.next();
    if(reply.done)throw Error('历史查询子进程提前退出');
    return JSON.parse(reply.value);
  }
  const call=async(name:string,args:unknown)=> (await rpc('tools/call',{name,arguments:args})).result;
  try {
    let agentReply: {server:string; tools:string[]; text:string} | undefined;
    queryFromAgent=async()=>{
      const hello=await rpc('initialize');
      const catalog=await rpc('tools/list');
      const search=await call('search',{query:'关卡'});
      agentReply={server:hello.result.serverInfo.name,tools:catalog.result.tools.map((t:{name:string})=>t.name),text:search.content[0].text};
    };
    await s.tasks.prompt(id,'用历史查询核对关卡尺寸');
    await s.tasks.idle();
    expect(agentReply).toEqual({server:'aic-history',tools:['search','get_events','get_file_at','list_decisions'],text:expect.stringContaining('关卡核对')});
    const history=(await call('get_events',{fromSeq:1,toSeq:100000})).content[0].text;
    expect(history).not.toContain('artificial-history-token');expect(history).not.toContain('禁止返回的另外任务内容');
    expect(history).toContain('关卡改动 已隐藏路径 1 和 Level1.txt');
    expect(history).not.toContain('Town.unity');
    expect((await call('get_file_at',{checkpoint:cp,path:'notes.txt'})).content[0].text).toContain('检查点原文');
    expect((await call('list_decisions',{})).content[0].text).toContain('保留原始比例');
    const large=(await call('get_file_at',{checkpoint:cp,path:'large.txt'})).content[0].text;
    expect(Buffer.byteLength(large)).toBeLessThanOrEqual(32768);
    expect(JSON.parse(large)).toMatchObject({truncated:true});
    expect(JSON.parse(large).text).toMatch(/^开头[\s\S]*结尾$/);
    for(let i=0;i<12;i++)s.events.append({type:'message.done',taskId:id,sessionId:sessionId,data:{messageId:'long'+i,text:'合成历史'.repeat(1500)}});
    s.events.append({type:'tool.start',taskId:id,sessionId,data:{toolId:'envfile',kind:'read',title:'读文件',target:'.env.local'}});
    s.events.append({type:'tool.output',taskId:id,sessionId,data:{toolId:'envfile',text:'MATERIAL_ID=synthetic-only-value\n无赋值的环境文件内容'}});
    s.events.append({type:'message.user',taskId:id,sessionId,data:{messageId:'ref',text:'再次出现 synthetic-only-value 和无赋值的环境文件内容'}});
    const masked=(await call('search',{query:'再次出现'})).content[0].text;
    expect(masked).toContain('再次出现');expect(masked).not.toContain('synthetic-only-value');
    expect(masked).not.toContain('无赋值的环境文件内容');
    const limited=(await call('get_events',{fromSeq:1,toSeq:100000})).content[0].text;
    expect(Buffer.byteLength(limited)).toBeLessThanOrEqual(32768);
    expect(JSON.parse(limited).truncated).toBe(true);
    expect((await call('get_file_at',{checkpoint:cp,path:'../notes.txt'})).isError).toBe(true);
    expect((await call('get_file_at',{checkpoint:'refs/aic/checkpoints/'+other+'/1',path:'notes.txt'})).isError).toBe(true);
    expect((await call('search',{query:'关卡',taskId:other})).isError).toBe(true);
    const url='/internal/history/read', body={name:'list_decisions',arguments:{}};
    expect((await gw.api('POST',url,{token,body})).status).toBe(401);
    expect((await gw.api('POST',url,{token:env.AIC_HISTORY_TOKEN,body,headers:{origin:'http://127.0.0.1:'+gw.port}})).status).toBe(403);
    expect((await gw.api('POST',url,{token:env.AIC_HISTORY_TOKEN,body,headers:{host:'example.invalid'}})).status).toBe(403);
    expect((await gw.api('GET','/tasks',{token:env.AIC_HISTORY_TOKEN})).status).toBe(401);
    expect(s.db.get<{n:number}>("SELECT json_extract(quality_json,'$.historyCalls') AS n FROM handoffs WHERE id=?",handoffId)?.n).toBe(7);
    s.events.append({type:'session.ended',taskId:id,sessionId:sessionId,data:{reason:'closed'}});
    expect((await call('list_decisions',{})).isError).toBe(true);
    expect(readFileSync(path.join(w.path,'notes.txt'),'utf8')).toBe('随后修改\n');
    const replacement='ho_delete';
    s.db.run("INSERT INTO handoffs(id,task_id,level,content_md,document_json,quality_json,created_at) VALUES(?,?,'H4','',?,'{}',?)",replacement,other,JSON.stringify(preview.document),Date.now());
    const otherSession=s.db.get<{id:string}>('SELECT id FROM sessions WHERE task_id=?',other)!.id;
    s.db.run('UPDATE sessions SET handoff_id=? WHERE id=?',replacement,otherSession);
    const access=s.history.serverFor({taskId:other,sessionId:otherSession,handoffId:replacement});
    const otherToken=access.env.find(e=>e.name==='AIC_HISTORY_TOKEN')!.value;
    expect((await gw.api('POST',url,{token:otherToken,body})).status).toBe(200);
    expect((await gw.api('DELETE','/tasks/'+other,{token})).status).toBe(200);
    expect((await gw.api('POST',url,{token:otherToken,body})).status).toBe(401);
  } finally {child.stdin.end();await exit;}
 },60000);
});
