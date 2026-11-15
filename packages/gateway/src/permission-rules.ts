// 权限规则只管理工作台自己的决定；不写 Agent 配置，也不替代操作系统沙箱。
import path from 'node:path';
import { realpath, lstat } from 'node:fs/promises';
import { PermissionOperation, PutPermissionRulesBody, type PermissionContext, type PermissionEvaluation, type PermissionRule, type PermissionRuleDraft, type PermissionRulePreview, type PermissionRuleSet } from '@aic/protocol';
import type { Db } from './db';
import { Errors, newId, now } from './util';

export const ALWAYS_DENIED = [
  '删除工作副本外的文件', '修改系统目录', '直接修改隔离任务的原项目文件',
  'git push / fetch、改远端或 git 配置', '格式化磁盘、删除文件系统根目录',
  '访问第三方凭据或修改工作副本的 .git 元数据',
];
const windows=(root:string)=>/^[a-z]:[\\/]|^\\\\/i.test(root);
export function relativePermissionPath(root:string,value:string):string|null {
  if(!value||/[\0\r\n]/.test(value))return null;
  const api=windows(root)?path.win32:path.posix;
  if(windows(root)&&(/^[a-z]:[^\\/]/i.test(value)||/^\\\\[?.]\\/.test(value)))return null;
  const target=api.resolve(root,value),relative=api.relative(api.resolve(root),target).replaceAll('\\','/');
  if(relative==='..'||relative.startsWith('../')||api.isAbsolute(relative))return null;
  return windows(root)?relative.toLowerCase()||'.':relative||'.';
}
export function permissionGlob(pattern:string,value:string,asPath=false,fold=false) {
  let text=asPath?pattern.replaceAll('\\','/'):pattern;
  let target=asPath?value.replaceAll('\\','/'):value;
  if(fold){text=text.toLowerCase();target=target.toLowerCase();}
  const tokens:string[]=[];
  for(let i=0;i<text.length;i++) {
    const c=text[i]!;
    if(c==='*'){if(text[i+1]==='*'){while(text[i+1]==='*')i++;if(asPath&&text[i+1]==='/'){i++;tokens.push('**/');}else tokens.push('**');}else tokens.push('*');}
    else tokens.push(c);
  }
  // 动态规划避免多个星号拼成回溯正则，输入长度与规则长度共同限定工作量。
  let next=new Uint8Array(target.length+1);next[target.length]=1;
  for(let i=tokens.length-1;i>=0;i--){
    const token=tokens[i]!,current=new Uint8Array(target.length+1);let afterSlash=0;
    for(let j=target.length;j>=0;j--){
      if(token==='**/') {if(target[j]==='/'&&next[j+1])afterSlash=1;current[j]=next[j]||afterSlash;}
      else if(token==='*'||token==='**')current[j]=next[j]||(j<target.length&&(!asPath||token==='**'||target[j]!=='/')?current[j+1]!:0);
      else if(j<target.length&&(token===target[j]||token==='?'&&(!asPath||target[j]!=='/')))current[j]=next[j+1]!;
    }
    next=current;
  }
  return !!next[0];
}
function commandPaths(command:string) {
  // 无法可靠拆解脚本、重定向、变量或多条命令时，不根据通配规则自动放行。
  const simple=!/[;&|<>`\r\n$%]/.test(command);
  const tokens=command.match(/(?:[^\s"']+|"[^"\r\n]*"|'[^'\r\n]*')+/g)??[];
  const values=tokens.slice(1).map(t=>t.replaceAll('"','').replaceAll("'",''));
  const paths=values.flatMap(v=>v.startsWith('-')?(v.includes('=')?[v.slice(v.indexOf('=')+1)]:[]):[v]).filter(v=>v&&!/^https?:\/\//i.test(v));
  return {simple:simple&&(command.match(/"/g)?.length??0)%2===0&&(command.match(/'/g)?.length??0)%2===0&&!/\s(?:-e|-c|-command|-encodedcommand)(?:\s|=)/i.test(command),paths};
}
function protectedTarget(value:string,write:boolean) {
  const target=value.replaceAll('\\','/').toLowerCase();
  if(/(?:^|\/)(?:\.claude|\.codex|\.codebuddy|\.workbuddy|\.zcode)(?:\/|$)/.test(target))return true;
  if(write&&/(?:^|\/)\.git(?:\/|$)/.test(target))return true;
  return write&&(/^[a-z]:\/(?:windows|program files(?: \(x86\))?|programdata)(?:\/|$)/.test(target)||/^\/(?:etc|usr|bin|sbin|boot|sys|proc)(?:\/|$)/.test(target));
}
export function evaluatePermission(operation:PermissionOperation,context:PermissionContext,rules:PermissionRule[]):PermissionEvaluation {
  const finish=(action:PermissionEvaluation['action'],reason:string,safeScope:boolean,ruleId?:string):PermissionEvaluation=>({action,reason,safeScope,...(ruleId?{ruleId}:{})});
  const command=operation.command??'', parsed=commandPaths(command);
  const paths=[...operation.paths,...(operation.tool==='shell'?parsed.paths:[])];
  const write=operation.tool==='edit'||operation.tool==='shell';
  const relatives=paths.map(p=>relativePermissionPath(context.root,p));
  const outside=relatives.some(p=>p===null);
  const safe=operation.complete&&!outside&&(operation.tool!=='shell'||parsed.simple);
  if(/\bgit(?:\.exe)?[\s\S]*\b(?:push|fetch|remote|config)\b/i.test(command))return finish('deny','始终禁止：推送、拉取或修改 git 远端 / 配置',false);
  if(/(?:^|[\s;&|])(?:format(?:\.com)?|format-volume|mkfs(?:\.[a-z0-9]+)?)(?:\s|$)/i.test(command)||/\b(?:rm|rmdir|rd|remove-item)\b[^\r\n]*\s["']?(?:\/|[a-z]:[\\/])["']?\s*$/i.test(command))return finish('deny','始终禁止：格式化或删除文件系统根目录',false);
  const deletion=operation.deletion||/\b(?:rm|rmdir|rd|del|erase|remove-item)(?:\.exe)?\b/i.test(command);
  if(deletion&&(outside||!operation.complete))return finish('deny','始终禁止：删除工作副本外文件或无法确认删除范围',false);
  for(const p of paths) {
    const api=windows(context.root)?path.win32:path.posix,target=api.resolve(context.root,p);
    if(protectedTarget(target,write))return finish('deny','始终禁止：系统目录、凭据或 git 元数据',false);
    if(write&&context.isolated&&relativePermissionPath(context.original,target)!==null)return finish('deny','始终禁止：直接修改原项目，请使用合并或应用结果',false);
  }
  // 只读是任务的硬边界，项目 allow 不能把只读任务变成写入任务。
  if(context.level==='readonly'&&operation.tool!=='read')return finish('deny','只读权限不允许修改文件或执行命令',safe);
  for(const rule of rules) {
    if(rule.tool!=='any'&&rule.tool!==operation.tool)continue;
    if(rule.match!==null&&!permissionGlob(rule.match,command,false,windows(context.root)))continue;
    if(rule.path!==null&&(!relatives.length||!relatives.every(p=>p!==null&&permissionGlob(rule.path!,p,true,windows(context.root)))))continue;
    if(rule.action==='allow'&&!safe)return finish('ask','匹配规则，但无法确认操作只作用于工作副本，仍需审批',false,rule.id);
    return finish(rule.action,`项目规则 ${rule.ord+1}：${rule.match??rule.path??'此类工具'}`,safe,rule.id);
  }
  if(operation.tool==='read'&&operation.complete&&!outside)return finish('allow','只读操作',safe);
  if(context.level==='full'&&operation.complete)return finish('allow','全自动权限',safe);
  if(context.level==='workspace'&&operation.tool==='edit'&&safe&&!deletion)return finish('allow','工作副本内文件修改',safe);
  return finish('ask','按当前权限需要审批',safe);
}

export class PermissionBroker {
  constructor(private db:Db) {}
  get(projectId:string):PermissionRuleSet {
    if(!this.db.get('SELECT id FROM projects WHERE id=?',projectId))throw Errors.notFound('找不到这个项目');
    const items=this.db.all<{id:string;project_id:string;ord:number;action:PermissionRule['action'];tool:PermissionRule['tool'];match:string|null;path:string|null;source:PermissionRule['source'];created_at:number}>('SELECT * FROM permission_rules WHERE project_id=? ORDER BY ord',projectId)
      .map(r=>({id:r.id,projectId:r.project_id,ord:r.ord,action:r.action,tool:r.tool,match:r.match,path:r.path,source:r.source,createdAt:r.created_at}));
    return {projectId,revision:this.db.get<{revision:number}>('SELECT revision FROM permission_rule_sets WHERE project_id=?',projectId)?.revision??0,items,alwaysDenied:ALWAYS_DENIED};
  }
  put(projectId:string,input:unknown,source:'manual'|'always_allow'='manual'):PermissionRuleSet {
    const body=PutPermissionRulesBody.parse(input);
    return this.db.tx(()=>{
      const current=this.get(projectId);if(current.revision!==body.revision)throw Errors.conflict('权限规则已被其他页面修改，请重新载入后再保存');
      const known=new Map(current.items.map(r=>[r.id,r])),ids=new Set<string>();
      const items=body.items.map((r,ord)=>{
        if(r.id&&(!known.has(r.id)||ids.has(r.id)))throw Errors.badRequest('规则编号无效或重复');
        if(r.path&&(/^[a-z]:|^[/\\]|(?:^|[/\\])\.\.(?:[/\\]|$)|[\0\r\n]/i.test(r.path)))throw Errors.badRequest('规则路径必须相对工作副本，不能包含上级目录');
        const old=r.id?known.get(r.id):undefined,id=r.id??newId('pr');ids.add(id);
        const unchanged=old&&old.action===r.action&&old.tool===r.tool&&old.match===r.match&&old.path===r.path;
        return {...r,id,projectId,ord,source:unchanged?old.source:source,createdAt:old?.createdAt??now()};
      });
      this.db.run('DELETE FROM permission_rules WHERE project_id=?',projectId);
      for(const r of items)this.db.run('INSERT INTO permission_rules(id,project_id,ord,action,tool,"match",path,source,created_at) VALUES(?,?,?,?,?,?,?,?,?)',r.id,projectId,r.ord,r.action,r.tool,r.match,r.path,r.source,r.createdAt);
      this.db.run('INSERT INTO permission_rule_sets(project_id,revision) VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision',projectId,current.revision+1);
      return this.get(projectId);
    });
  }
  async decide(input:PermissionOperation,context:PermissionContext) {
    const operation=PermissionOperation.parse(input);
    // Windows 的 TEMP 可能使用 8.3 短名称，根目录与操作目标必须采用同一种规范路径。
    let canonical:PermissionContext;
    try {canonical={...context,root:await realpath(context.root),original:await realpath(context.original)};}
    catch{return {action:'deny' as const,reason:'无法确认项目与工作副本位置，已停止操作',safeScope:false};}
    // 对已有路径及最近存在的父目录取 realpath，目录联接不能借相对路径命中 allow。
    const resolved:string[]=[];let complete=operation.complete;
    for(const value of [...operation.paths,...(operation.tool==='shell'?commandPaths(operation.command??'').paths:[])]) {
      let target=path.resolve(context.root,value),tail:string[]=[];
      try {
        while(true){try{await lstat(target);break;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;const parent=path.dirname(target);if(parent===target)throw e;tail.unshift(path.basename(target));target=parent;}}
        resolved.push(path.join(await realpath(target),...tail));
      }catch{complete=false;resolved.push(value);}
    }
    const normalized={...operation,paths:resolved,complete};
    return evaluatePermission(normalized,canonical,this.get(context.projectId).items);
  }
  async preview(operation:PermissionOperation,context:PermissionContext):Promise<PermissionRulePreview|null> {
    const decision=await this.decide(operation,context);
    if(!decision.safeScope||decision.action==='deny'||!operation.complete||operation.tool==='any')return null;
    let rule:PermissionRuleDraft;
    if(operation.tool==='shell') {
      if(!operation.command||/[?*]/.test(operation.command))return null;
      rule={action:'allow',tool:'shell',match:operation.command,path:null};
    }else {
      const targets=operation.paths.map(p=>relativePermissionPath(context.root,p));if(!targets.length||targets.some(p=>p===null||p==='.'||/[?*]/.test(p)))return null;
      const folders=[...new Set(targets.map(p=>path.posix.dirname(p!)))];if(folders.length!==1)return null;
      rule={action:'allow',tool:operation.tool,match:null,path:folders[0]==='.'?targets.length===1?targets[0]!:null:folders[0]+'/**'};
      if(!rule.path)return null;
    }
    return {revision:this.get(context.projectId).revision,rule,label:rule.tool==='shell'?`允许执行完全相同的命令：${rule.match}`:`允许${rule.tool==='edit'?'修改':'读取'}：${rule.path}`,...(decision.ruleId?{insertBefore:decision.ruleId}:{})};
  }
  addAlways(projectId:string,preview:PermissionRulePreview) {
    const current=this.get(projectId);
    if(current.revision!==preview.revision)throw Errors.conflict('权限规则已变化，请重新预览');
    const items:PermissionRuleDraft[]=current.items.map(({id,action,tool,match,path})=>({id,action,tool,match,path}));
    const position=preview.insertBefore?items.findIndex(r=>r.id===preview.insertBefore):items.length;
    if(position<0)throw Errors.conflict('权限规则已变化，请重新预览');items.splice(position,0,preview.rule);
    return this.put(projectId,{revision:preview.revision,items},'always_allow');
  }
}
