import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { PermissionContext, PermissionOperation, PermissionRule } from '@aic/protocol';
import { openDb, type Db } from '../src/db';
import { evaluatePermission, PermissionBroker, permissionGlob, relativePermissionPath } from '../src/permission-rules';

const context:PermissionContext={projectId:'p',root:'C:\\work\\copy',original:'C:\\project',level:'ask',isolated:true};
const edit=(...paths:string[]):PermissionOperation=>({tool:'edit',command:null,paths,complete:true,deletion:false});
const shell=(command:string):PermissionOperation=>({...edit(),tool:'shell',command});
const rule=(action:PermissionRule['action'],extra:Partial<PermissionRule>={}):PermissionRule=>({id:'r',projectId:'p',ord:0,action,tool:'any',match:null,path:null,source:'manual',createdAt:1,...extra});

describe('全自动不放行无法核对范围的命令（ISSUE-0096）',()=>{
  const full={...context,level:'full' as const};
  it.each([
    String.raw`powershell -Command "Remove-Item -Recurse -Force C:\Users\me\Documents\x"`,
    String.raw`cmd /c "echo x > C:\project\a.txt"`,
    String.raw`del %USERPROFILE%\notes.txt`,
    `node -e "require('fs').rmSync('C:/project',{recursive:true})"`,
  ])('%s 改为需要审批',command=>{
    expect(evaluatePermission(shell(command),full,[]).action).not.toBe('allow');
  });
  it('能核对范围的简单命令和工作副本内修改仍自动放行',()=>{
    expect(evaluatePermission(shell('npm test'),full,[]).action).toBe('allow');
    expect(evaluatePermission(edit('src/a.ts'),full,[]).action).toBe('allow');
  });
});
describe('权限规则优先级与路径',()=>{
  it('按顺序命中即停，询问可以挡住后续允许',()=>{
    expect(evaluatePermission(shell('npm test'),context,[rule('ask'),rule('allow')]).action).toBe('ask');
    expect(evaluatePermission(shell('npm test'),context,[rule('allow'),rule('deny')]).action).toBe('allow');
    expect(evaluatePermission(shell('npm test'),context,[rule('deny',{tool:'edit'}),rule('allow')]).action).toBe('allow');
  });
  it.each(['git push origin main','git -C . fetch','git config user.name x','git remote add x y','format C:','rm -rf C:\\','del ..\\outside.txt'])('始终禁止不能被全自动及项目允许覆盖：%s',command=>{
    expect(evaluatePermission(shell(command),{...context,level:'full'},[rule('allow')]).action).toBe('deny');
  });
  it.each(['C:\\Windows\\x','C:\\project\\x','C:\\work\\copy\\.git\\config','C:\\Users\\a\\.codex\\auth.json'])('敏感或原项目写入不能放行：%s',target=>{
    expect(evaluatePermission(edit(target),context,[rule('allow')]).action).toBe('deny');
  });
  it('Windows 大小写、分隔符和目录边界',()=>{
    expect(relativePermissionPath(context.root,'c:/WORK/copy/Src/A.ts')).toBe('src/a.ts');
    expect(relativePermissionPath(context.root,'C:\\work\\copy-other\\a')).toBeNull();
    expect(relativePermissionPath(context.root,'D:\\a')).toBeNull();
    expect(relativePermissionPath(context.root,'C:relative')).toBeNull();
    expect(evaluatePermission(edit('SRC\\sub\\A.ts'),context,[rule('allow',{path:'src/**'})]).action).toBe('allow');
  });
  it('单层星号不跨目录，双星号包含零层目录，正则字符按原文',()=>{
    expect(permissionGlob('src/*','src/sub/a',true)).toBe(false);
    expect(permissionGlob('src/**/*.ts','src/a.ts',true)).toBe(true);
    expect(permissionGlob('src/**/*.ts','src/sub/a.ts',true)).toBe(true);
    expect(permissionGlob('npm test [x]','npm test [x]')).toBe(true);
    expect(permissionGlob('src/?.ts','src/ab.ts',true)).toBe(false);
    expect(permissionGlob('**/foo','abcfoo',true)).toBe(false);
    expect(permissionGlob('**/foo','abc/foo',true)).toBe(true);
  });
  it('多星号失败匹配具有有界工作量，不触发正则回溯',()=>{
    expect(permissionGlob('*a'.repeat(100)+'b','a'.repeat(2000))).toBe(false);
  });
  it.each(['C:\\project','"C:\\project"',"'C:\\project'"])('等号形式的命令选项不能隐藏原项目目标：%s',target=>{
    expect(evaluatePermission(shell('npm install --prefix='+target),context,[rule('allow')]).action).toBe('deny');
  });
  it('越界、不完整和复合脚本只能询问，不能由 allow 放行',()=>{
    for(const operation of [edit('../outside'),{...edit('a'),complete:false},shell('npm test && del x')])expect(evaluatePermission(operation,context,[rule('allow')]).action).toBe('ask');
    expect(evaluatePermission(edit('src/a','../outside'),context,[rule('allow',{path:'src/**'})]).action).toBe('ask');
  });
  it('只读硬边界不可放宽；读取可被项目 deny 收紧',()=>{
    expect(evaluatePermission(edit('a'),{...context,level:'readonly'},[rule('allow')]).action).toBe('deny');
    expect(evaluatePermission({...edit('a'),tool:'read'},context,[rule('deny',{tool:'read'})]).action).toBe('deny');
    expect(evaluatePermission({...edit('a'),tool:'read'},context,[]).action).toBe('allow');
  });
});

describe('规则持久化与预览',()=>{
  let base:string,db:Db,broker:PermissionBroker,ctx:PermissionContext;
  beforeEach(async()=>{
    base=await mkdtemp(path.join(tmpdir(),'aic-rules-'));await mkdir(path.join(base,'copy'));await mkdir(path.join(base,'original'));
    db=openDb(path.join(base,'test.db'));db.run('INSERT INTO projects(id,name,path,created_at) VALUES(?,?,?,?)','p','规则测试',path.join(base,'original'),1);
    broker=new PermissionBroker(db);ctx={...context,root:path.join(base,'copy'),original:path.join(base,'original')};
  });
  afterEach(async()=>{db?.close();if(base&&path.dirname(base)===tmpdir()&&path.basename(base).startsWith('aic-rules-'))await rm(base,{recursive:true,force:true});});
  it('修订冲突不会覆盖旧表，重复编号与越界路径拒绝',()=>{
    const saved=broker.put('p',{revision:0,items:[{action:'ask',tool:'shell',match:'*',path:null}]});
    expect(saved.revision).toBe(1);
    expect(()=>broker.put('p',{revision:0,items:[]})).toThrow('其他页面');
    expect(()=>broker.put('p',{revision:1,items:[saved.items[0],saved.items[0]].map(r=>({id:r!.id,action:r!.action,tool:r!.tool,match:r!.match,path:r!.path}))})).toThrow('重复');
    expect(()=>broker.put('p',{revision:1,items:[{action:'allow',tool:'edit',match:null,path:'../*'}]})).toThrow('相对');
    expect(broker.get('p')).toEqual(saved);
  });
  it('总是允许生成精确命令并插在命中询问之前，保留此前禁止',async()=>{
    broker.put('p',{revision:0,items:[{action:'deny',tool:'shell',match:'npm publish*',path:null},{action:'ask',tool:'shell',match:'*',path:null}]});
    const preview=await broker.preview(shell('npm test'),ctx);expect(preview?.rule).toEqual({action:'allow',tool:'shell',match:'npm test',path:null});
    const saved=broker.addAlways('p',preview!);expect(saved.items.map(r=>r.action)).toEqual(['deny','allow','ask']);expect(saved.items[1]?.source).toBe('always_allow');
    expect((await broker.decide(shell('npm test'),ctx)).action).toBe('allow');
    expect((await broker.decide(shell('npm test extra'),ctx)).action).toBe('ask');
    expect((await broker.decide(shell('npm publish'),ctx)).action).toBe('deny');
    expect(()=>broker.addAlways('p',preview!)).toThrow('已变化');
  });
  it('修改文件预览限定同一目录，根目录单文件不扩大到全部',async()=>{
    expect((await broker.preview(edit('src/a.ts','src/b.ts'),ctx))?.rule.path).toBe('src/**');
    expect((await broker.preview(edit('notes.txt'),ctx))?.rule.path).toBe('notes.txt');
    expect(await broker.preview(edit('a','b'),ctx)).toBeNull();
    expect(await broker.preview(shell('npm test*'),ctx)).toBeNull();
  });
  it('目录联接不允许通过相对通配自动放行或生成规则',async()=>{
    await symlink(ctx.original,path.join(ctx.root,'escape'),'junction');
    broker.put('p',{revision:0,items:[{action:'allow',tool:'any',match:null,path:'**'}]});
    expect((await broker.decide(edit('escape/new.txt'),ctx)).action).toBe('deny');
    expect(await broker.preview(edit('escape/new.txt'),ctx)).toBeNull();
  });
  it('手工编辑来源变为手动，删除后重新打开仍保留修订号',async()=>{
    let saved=broker.addAlways('p',(await broker.preview(shell('npm test'),ctx))!);
    saved=broker.put('p',{revision:saved.revision,items:saved.items.map(({id,action,tool,match,path})=>({id,action,tool,match:match+' extra',path}))});
    expect(saved.items[0]?.source).toBe('manual');broker.put('p',{revision:saved.revision,items:[]});
    db.close();db=openDb(path.join(base,'test.db'));broker=new PermissionBroker(db);expect(broker.get('p')).toMatchObject({revision:3,items:[]});
  });
});
