// 默认测试只使用内存对象和假时钟，不连接真实 Agent。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentInfo, ProfileSummary, EventEnvelope } from '@aic/protocol';
import { createFlusher } from '../state/flush';
import { buildTimeline } from '../state/core';
import { authenticatedStartup } from '../api/credentials';
import { attachmentLimit, clipboardFiles, screenshotName, visionWarning } from './attachments';
import { effortLabel, pickerAction, pickerItems, pickerRows, profileDefaults, profileInfo } from './picker';

const agent = (over: Partial<AgentInfo> = {}): AgentInfo => ({
  kind:'fake', displayName:'演示 Agent', status:'ready', version:null, verified:true, message:null,
  models:[{id:'yes',name:'能看图',contextWindow:null,vision:true},{id:'no',name:'纯文字',contextWindow:null,vision:false}], efforts:['low','enabled'], ...over,
});
afterEach(()=>vi.useRealTimers());
describe('事件调度',()=>{
  function setup(visible=true){vi.useFakeTimers();const frames:(()=>void)[]=[],flush=vi.fn();const schedule=createFlusher({raf:(f)=>frames.push(f),setTimeout,visibility:()=>visible,flush});return {frames,flush,schedule};}
  it('rAF 不调用时 100ms 刷新',()=>{const s=setup();s.schedule();vi.advanceTimersByTime(99);expect(s.flush).not.toHaveBeenCalled();vi.advanceTimersByTime(1);expect(s.flush).toHaveBeenCalledTimes(1);});
  it('rAF 先到后定时器不重复；下一批仍能刷新',()=>{const s=setup();s.schedule();s.frames[0]!();vi.advanceTimersByTime(100);expect(s.flush).toHaveBeenCalledTimes(1);s.schedule();vi.advanceTimersByTime(100);expect(s.flush).toHaveBeenCalledTimes(2);});
  it('不可见时 16ms 刷新且不申请动画帧',()=>{const s=setup(false);s.schedule();vi.advanceTimersByTime(16);expect(s.flush).toHaveBeenCalledTimes(1);expect(s.frames).toHaveLength(0);});
  it('连续入队 1000 次只刷一次',()=>{const s=setup();for(let i=0;i<1000;i++)s.schedule();vi.advanceTimersByTime(100);s.frames[0]!();expect(s.flush).toHaveBeenCalledTimes(1);expect(s.frames).toHaveLength(1);});
  it('注入的原生风格计时器不接收配置对象作为 this',()=>{
    const schedule=createFlusher({raf:()=>{},setTimeout:function(this:unknown,run){expect(this).toBeUndefined();run();},visibility:()=>false,flush:vi.fn()});schedule();
  });
});
describe('选择器与附件',()=>{
  it('第三方原生目录不使用旧账号模型缓存，也不提供切换认证', () => {
    const a = agent({ kind: 'claude', usesNativeConfig: true, profiles: [
      { id: 'local', name: '本机', kind: 'subscription', isDefault: true, loggedIn: true },
      { id: 'legacy', name: '旧 API', kind: 'customEndpoint', isDefault: false, loggedIn: true, models: [{ id: 'legacy', name: '旧模型', contextWindow: null }] },
    ] });
    expect(profileInfo(a, 'legacy')?.models).toEqual(a.models);
    const items = pickerItems(a, 'claude', { model: 'yes', effort: 'enabled' }, 'legacy', 'new');
    expect(items.profiles).toEqual([]);
    expect(items.models.map((m) => m.id)).toEqual(['yes', 'no']);
  });
  it('新任务换自定义账号后只列该账号模型，清除旧模型和思考强度；旧服务端仍兼容',()=>{
    const profiles=[{id:'local',isDefault:true,models:[{id:'native',name:'订阅模型',contextWindow:null}],efforts:['high']},
      {id:'api',models:[{id:'glm',name:'GLM',contextWindow:null,vision:false}],efforts:null}] as ProfileSummary[];
    const a=agent({profiles});const cfg={model:'native',effort:'high',models:profiles[0]!.models};
    expect(pickerItems(a,'fake',cfg,'api','new').models.map((m)=>m.id)).toEqual(['glm']);
    expect(pickerItems(a,'fake',cfg,'api','new').efforts).toBe(null);
    expect(profileDefaults(a,'api','native','high')).toEqual({model:'glm',effort:''});
    expect(profileInfo(a,'api')?.models[0]?.vision).toBe(false);
    expect(pickerItems(agent(),'fake',{model:null,effort:null},null,'new').models).toHaveLength(2);
    expect(pickerItems(a,'fake',cfg,'local','task').models.map((m)=>m.id)).toEqual(['native']);
  });
  it('只列启用的和当前 Agent，显示会话模型与状态',()=>{
    const a=agent({enabled:false});const b=agent({kind:'codex',enabled:true,status:'needs_login'});const c=agent({kind:'claude',enabled:false});
    const rows=pickerRows([a,b,c],'fake',{model:'yes',effort:'enabled'});expect(rows.map((r)=>r.info.kind)).toEqual(['fake','codex']);expect(rows[0]!.meta).toBe('能看图 · 思考 自动 ✓');expect(rows[1]!.meta).toContain('登录');
    expect(pickerRows([agent({efforts:null})],'fake',{model:'yes',effort:null})[0]!.meta).not.toContain('思考');
  });
  it('自动在前，失败按账号区分，跨目录账号在会话里禁用',()=>{
    const profiles=[{id:'one',isDefault:true,sessionStore:'shared'},{id:'two',sessionStore:'separate'}] as ProfileSummary[];
    const a=agent({profiles,modelFailures:[{profileId:'one',model:'no',reason:'不支持',at:1}]});
    const items=pickerItems(a,'fake',{model:'yes',effort:'enabled'},'one','task');expect(items.efforts?.[0]).toBe('enabled');expect(items.models[1]).toMatchObject({cannotSee:true,failure:'不支持'});expect(items.profiles[1]?.blocked).toBe(true);
    expect(pickerItems(a,'fake',{model:'yes',effort:null},'two','new').models[1]?.failure).toBe(null);
    expect(pickerItems(a,'codex',{model:null,effort:null},null,'task').profiles).toEqual([]);
    expect(pickerAction('fake','codex','task')).toBe('explain');expect(pickerAction('fake','codex','new')).toBe('select');expect(effortLabel('enabled')).toBe('自动');
  });
  it('剪贴板只取文件，截图命名与数量大小上限',()=>{
    const f={} as File;expect(clipboardFiles([{kind:'string',getAsFile:()=>f},{kind:'file',getAsFile:()=>f},{kind:'file',getAsFile:()=>null}])).toEqual([f]);
    expect(screenshotName(new Date(2026,10,8,1,2,3))).toBe('截图-010203.png');expect(attachmentLimit(20*1024*1024,9)).toBe(null);expect(attachmentLimit(1,10)).toContain('10');expect(attachmentLimit(20*1024*1024+1,0)).toContain('20 MB');
  });
  it('图片能力按模型优先，未知不编造，推荐同 Agent',()=>{
    const a=agent();expect(visionWarning(a,'no',2)).toMatchObject({vision:false,recommendation:{id:'yes'}});expect(visionWarning(a,'no',2).text).toContain('2 张');expect(visionWarning(a,'yes',1).text).toBe('');expect(visionWarning(undefined,null,1).text).toContain('没有报告');expect(visionWarning(a,'no',0).text).toBe('');
  });
});
describe('事件兼容和首次启动',()=>{
  it('工具更新、图片元数据、固定 notice id 更新同一行',()=>{
    let seq=0;const ev=(type:string,data:unknown)=>({seq:++seq,ts:seq,taskId:'t',sessionId:'s',type,data}) as EventEnvelope;
    const image={id:'att',name:'图.png',mime:'image/png',size:2,kind:'image',width:12,height:34,createdAt:1};
    const rows=buildTimeline([ev('message.user',{messageId:'m',text:'',attachments:[image]}),ev('tool.start',{toolId:'tc',title:'Preparing file…',target:null,kind:'edit'}),ev('tool.update',{toolId:'tc',title:'写入文档',target:'a.txt'}),ev('session.notice',{id:'idle',text:'1 分钟',level:'warn'}),ev('session.notice',{id:'idle',text:'3 分钟',level:'warn'})]);
    expect(rows[0]).toMatchObject({kind:'user',attachments:[image]});expect(rows.find((r)=>r.kind==='tools')).toMatchObject({tools:[{title:'写入文档',target:'a.txt'}]});expect(rows.filter((r)=>r.kind==='note')).toHaveLength(1);expect(rows.at(-1)).toMatchObject({text:'3 分钟'});
  });
  it('没有凭据只进入配对，有凭据才发受保护请求',async()=>{const request=vi.fn(async()=>{}),pair=vi.fn();await authenticatedStartup(false,request,pair);expect(request).not.toHaveBeenCalled();expect(pair).toHaveBeenCalledOnce();await authenticatedStartup(true,request,pair);expect(request).toHaveBeenCalledOnce();});
});
