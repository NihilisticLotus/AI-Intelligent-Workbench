import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startGw, makeProject, type TestGw } from './helpers';
import { projectBranch } from '../src/project-branch';
import { TaskFile } from '@aic/protocol';

let t: TestGw | undefined;
afterEach(async () => { await t?.stop(); t = undefined; });
async function setup() { t = await startGw(); const token = await t.pair(), project = await makeProject(t, token); return { token, project, s: t.gw.services }; }

describe('详细面板数据', () => {
  it('分支读取支持普通 HEAD、分离头和一层 gitdir；拒绝超大、乱码与异常引用', async () => {
    const { project } = await setup(); const root = project.path;
    expect(projectBranch(root)).toBeNull(); mkdirSync(path.join(root, '.git'));
    const head = path.join(root, '.git', 'HEAD');
    for (const [text, expected] of [['ref: refs/heads/feature/中文', 'feature/中文'], ['a'.repeat(40), 'aaaaaaa'], ['ref: refs/heads/../secret', null], ['ref: refs/heads/bad.lock', null], ['x'.repeat(4097), null]]) {
      writeFileSync(head, text!); expect(projectBranch(root)).toBe(expected);
    }
    writeFileSync(head, Buffer.from([0xff,0xfe,0x41])); expect(projectBranch(root)).toBeNull();
    const linked = path.join(t!.dataDir, 'linked'); mkdirSync(linked); writeFileSync(path.join(linked,'.git'), 'gitdir: ../project/.git');
    // 指针路径用实际项目目录构造，兼容测试辅助函数的目录名。
    writeFileSync(path.join(linked,'.git'), `gitdir: ${path.relative(linked,path.join(root,'.git'))}`);
    writeFileSync(head,'ref: refs/heads/main'); expect(projectBranch(linked)).toBe('main');
    writeFileSync(path.join(linked,'.git'), 'gitdir: missing'); expect(projectBranch(linked)).toBeNull();
  });
  it('常用环境增删、上限、项目级联与鉴权，保存不改变实际分支', async () => {
    const { token, project } = await setup();
    const body = { name: '验收环境', projectId: project.id, branch: 'main' };
    expect((await t!.api('GET','/environments')).status).toBe(401);
    expect((await t!.api('POST','/environments',{token,body,headers:{origin:'https://invalid.example'}})).status).toBe(403);
    expect((await t!.api('GET','/environments',{token,headers:{host:'invalid.example'}})).status).toBe(403);
    expect((await t!.api('POST','/environments',{token,body:{...body,projectId:'missing'}})).status).toBe(404);
    let id = '';
    for(let i=0;i<50;i++) { const r = await t!.api('POST','/environments',{token,body}); expect(r.status).toBe(201); id=r.json.id; }
    expect((await t!.api('POST','/environments',{token,body})).status).toBe(409);
    expect((await t!.api('GET','/environments',{token})).json.items).toHaveLength(50);
    expect((await t!.api('DELETE',`/environments/${id}`,{token})).status).toBe(200);
    expect((await t!.api('DELETE',`/environments/${id}`,{token})).status).toBe(404);
    expect(projectBranch(project.path)).toBeNull();
    expect((await t!.api('DELETE',`/projects/${project.id}`,{token})).status).toBe(200);
    expect((await t!.api('GET','/environments',{token})).json.items).toEqual([]);
  });
  it('输出按会话路径合并、重复快照不翻倍，失败与未完成工具不算文件', async () => {
    const { token, project, s } = await setup();
    const task = await s.tasks.create({projectId:project.id,agent:'fake',permission:'readonly',prompt:'',deferPrompt:true});
    for (const id of ['s1','s2']) s.db.run("INSERT INTO sessions(id,task_id,agent_id,model,status,started_at) VALUES (?,?, 'fake',NULL,'idle',1)",id,task.id);
    let ts=1;
    const tool = (sessionId:string,id:string,target:string,ok:boolean|null,structured:boolean) => {
      const base={taskId:task.id,sessionId};
      s.events.append({...base,ts:ts++,type:'tool.start',data:{toolId:id,kind:'edit',title:'修改夹具',target}});
      if(structured) for(let i=0;i<2;i++) s.events.append({...base,ts:ts++,type:'tool.update',data:{toolId:id,files:[{path:target,added:2,removed:1,created:false}]}});
      if(ok!==null)s.events.append({...base,ts:ts++,type:'tool.end',data:{toolId:id,ok,summary:null}});
    };
    tool('s1','a','src/a.ts',true,true); tool('s1','b','src/a.ts',true,true);
    tool('s1','bad','failed.ts',false,true); tool('s1','pending','pending.ts',null,true);
    tool('s2','a','src/a.ts',true,false);
    const r=await t!.api('GET',`/tasks/${task.id}/files`,{token}); expect(r.status).toBe(200);
    const files=r.json.items.map((v:unknown)=>TaskFile.parse(v)); expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({sessionId:'s2',added:null,removed:null,name:'a.ts',source:'agent'});
    expect(files[1]).toMatchObject({sessionId:'s1',added:4,removed:2,name:'a.ts'});
    expect((await t!.api('GET',`/tasks/${task.id}/files`)).status).toBe(401);
    expect((await t!.api('GET',`/tasks/${task.id}/files`,{token,headers:{origin:'https://invalid.example'}})).status).toBe(403);
    expect((await t!.api('GET','/tasks/missing/files',{token})).status).toBe(404);
  });
});
