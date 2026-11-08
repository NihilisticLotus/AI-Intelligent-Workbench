// 双层菜单共用于对话和新建任务，键盘与鼠标使用同一套选项。
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { AgentInfo, AgentKind } from '@aic/protocol';
import type { SessionCfg } from '../state/core';
import { effortLabel, pickerAction, pickerItems, pickerRows, profileInfo } from '../lib/picker';
import { AgentBadge, choiceDialog } from './ui';
import { openNewTask } from './dialogs';
import { Icon } from './Icon';
export function AgentPicker({ agents, agent, config, profileId, mode, disabled, onPick, taskPreset, requestKey }: {
  agents: AgentInfo[]; agent: AgentKind; config: SessionCfg; profileId: string | null; mode: 'task' | 'new'; disabled?: boolean;
  onPick: (pick: { agent: AgentKind; model?: string; effort?: string; profileId?: string }) => void;
  taskPreset?: { projectId: string; prompt: string }; requestKey?: number;
}) {
  const [open,setOpen]=useState(false), [sub,setSub]=useState<AgentKind|null>(agent);
  const [position,setPosition]=useState({left:8,top:8,subLeft:8,subTop:8});
  const anchor=useRef<HTMLButtonElement>(null), root=useRef<HTMLDivElement>(null), submenu=useRef<HTMLDivElement>(null);
  const [pendingEffort,setPendingEffort]=useState<Record<string,string>>({});
  const current=profileInfo(agents.find((a)=>a.kind===agent),profileId);
  const rows=pickerRows(agents.map((a)=>a.kind===agent&&current?current:a),agent,config), info=agents.find((a)=>a.kind===sub);
  const items=info?pickerItems(info,agent,config,profileId,mode):null;
  const curProfile=current?.profiles?.find((p)=>p.id===profileId)??current?.profiles?.find((p)=>p.isDefault);
  const close=()=>{setOpen(false);anchor.current?.focus();};
  useEffect(()=>{if(requestKey){setSub(agent);setOpen(true);}},[requestKey,agent]);
  useEffect(()=>{if(!open)return; const outside=(e:PointerEvent)=>{if(!root.current?.contains(e.target as Node)&&!submenu.current?.contains(e.target as Node)&&!anchor.current?.contains(e.target as Node))setOpen(false);};document.addEventListener('pointerdown',outside,true);return()=>document.removeEventListener('pointerdown',outside,true);},[open]);
  useLayoutEffect(()=>{
    if(!open||!anchor.current||!root.current)return;
    const place=()=>{
      const a=anchor.current!.getBoundingClientRect(),r=root.current!,w=r.offsetWidth,h=r.offsetHeight;
      const left=Math.max(8,Math.min(a.left,innerWidth-w-8));const top=a.top>innerHeight/2?Math.max(8,a.top-h-4):Math.min(a.bottom+4,innerHeight-h-8);
      const row=r.querySelector<HTMLElement>(`[data-agent="${sub}"]`)?.getBoundingClientRect();const sw=submenu.current?.offsetWidth??280,sh=submenu.current?.offsetHeight??300;
      const rowTop=top+(row?row.top-r.getBoundingClientRect().top:0);
      setPosition({left,top,subLeft:left+w+4+sw<=innerWidth-8?left+w+4:Math.max(8,left-sw-4),subTop:Math.max(8,Math.min(rowTop,innerHeight-sh-8))});
    };place();window.addEventListener('resize',place);return()=>window.removeEventListener('resize',place);
  },[open,sub,items?.models.length]);
  useEffect(()=>{if(open)root.current?.querySelector<HTMLElement>(`[data-agent="${agent}"]`)?.focus();},[open]);
  const move=(e:KeyboardEvent,container:HTMLDivElement|null)=>{if(e.key!=='ArrowUp'&&e.key!=='ArrowDown')return; e.preventDefault(); const bs=[...container!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')],i=bs.indexOf(document.activeElement as HTMLButtonElement);bs[(i+(e.key==='ArrowDown'?1:bs.length-1))%bs.length]?.focus();};
  const pick=async(model:string)=>{
    if(!info)return;
    if(pickerAction(agent,info.kind,mode)==='explain'){
      close();const result=await choiceDialog({title:'换 Agent 需要交接',body:<p>换 Agent 需要交接，会在之后的版本提供；现在可以用这个 Agent 新建任务。</p>,choices:[{value:'new',label:'用它新建任务',primary:true},{value:'cancel',label:'取消'}]});
      if(result==='new')openNewTask({...taskPreset,agent:info.kind,model});return;
    }
    onPick({agent:info.kind,model,...(pendingEffort[info.kind]?{effort:pendingEffort[info.kind]}:{})});close();
  };
  const modelName=current?.models.find((m)=>m.id===config.model)?.name??config.model??'Agent 默认模型';
  return <div className="agent-picker">
    <button type="button" className="picker-trigger" ref={anchor} disabled={disabled} aria-haspopup="menu" aria-expanded={open} title={agent==='independent'?'工作台自有 API 服务':`账号：${curProfile?.name??'默认账号'}`} onClick={()=>{setSub(agent);setOpen(!open);}}><AgentBadge kind={agent} size="sm"/>{current?.displayName??agent}<span className="muted">{modelName}{config.effort&&current&&pickerItems(current,agent,config,profileId,mode).efforts?' · 思考 '+effortLabel(config.effort):''}</span><Icon name="down"/></button>
    {open?<><div className="menu picker-root" role="menu" aria-label="选择 Agent" ref={root} style={{left:position.left,top:position.top}} onKeyDown={(e)=>{move(e,root.current);if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close();}if(e.key==='ArrowRight'||e.key==='Enter'){e.preventDefault();const k=(document.activeElement as HTMLElement).dataset.agent as AgentKind;setSub(k);setTimeout(()=>submenu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(),0);}}}>
      {rows.map(({info:a,meta})=><button key={a.kind} type="button" role="menuitem" data-agent={a.kind} aria-haspopup="menu" aria-expanded={sub===a.kind} onMouseEnter={()=>setSub(a.kind)} onClick={()=>{setSub(a.kind);setTimeout(()=>submenu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(),0);}}><AgentBadge kind={a.kind}/>{a.displayName}<span className={a.status!=='ready'&&a.kind!==agent?'meta attn':'meta'}>{meta}</span><Icon name="right"/></button>)}
      <p className="picker-hint">换模型和思考强度保留上下文。第三方 Agent 沿用软件自身配置；换 Agent 需要交接，现在还不能直接换。</p>
    </div>{info&&items?<div className="menu picker-sub" role="menu" aria-label={`${info.displayName} 的模型和思考强度`} ref={submenu} style={{left:position.subLeft,top:position.subTop}} onKeyDown={(e)=>{move(e,submenu.current);if(e.key==='Escape'||e.key==='ArrowLeft'){e.preventDefault();e.stopPropagation();root.current?.querySelector<HTMLElement>(`[data-agent="${sub}"]`)?.focus();setSub(null);}}}>
      <div className="group-label">模型</div>
      {(items.models.length?items.models:[{id:'',name:'Agent 默认模型',cannotSee:false,failure:null}]).map((m)=><button key={m.id} type="button" role="menuitemradio" aria-checked={info.kind===agent&&m.id===(config.model??'')} disabled={disabled} title={m.failure??undefined} onClick={()=>void pick(m.id)}>{m.name}{m.cannotSee?<small>不能看图</small>:null}{m.failure?<small>上次失败</small>:null}{info.kind===agent&&m.id===config.model?' ✓':''}</button>)}
      <div className="group-label">思考强度</div>{items.efforts?<div className="seg" role="radiogroup" aria-label="思考强度">{items.efforts.map((x)=><button key={x} type="button" role="radio" aria-checked={x===(pendingEffort[info.kind]??(info.kind===agent?config.effort:null))} disabled={disabled} onClick={()=>{if(info.kind===agent)onPick({agent,effort:x});else setPendingEffort((p)=>({...p,[info.kind]:x}));}}>{effortLabel(x)}</button>)}</div>:<p className="picker-hint">由模型自己决定，这里不能调</p>}
      {items.profiles.length?<><div className="group-label">账号</div>{items.profiles.map((p)=><button key={p.id} type="button" role="menuitemradio" aria-checked={p.id===(profileId??curProfile?.id)} disabled={disabled||p.blocked} title={p.blocked?'这个账号的会话存在别的地方，需要交接；现在可以用它新建任务':undefined} onClick={()=>{onPick({agent,profileId:p.id});close();}}>{p.name}<span className="meta">{p.blocked?'需要交接':p.id===(profileId??curProfile?.id)?'✓':''}</span></button>)}</>:null}
    </div>:null}</>:null}
  </div>;
}
