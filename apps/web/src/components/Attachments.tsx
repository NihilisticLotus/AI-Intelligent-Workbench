// 附件上传、暂存、预览共用；图片 URL 由带设备凭据的 GET 换成本页 Blob URL。
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import type { AgentInfo, AttachmentInfo } from '@aic/protocol';
import { api } from '../state/app';
import { toast } from '../state/ui';
import { attachmentLimit, clipboardFiles, screenshotName, visionWarning } from '../lib/attachments';
import { Dialog, openDialog } from './ui';
import { Icon } from './Icon';
type Item = { key: string; file?: File; info?: AttachmentInfo; progress: number; error?: string };
export function useAttachments(taskId: string | null) {
  const [items,setItems]=useState<Item[]>([]);const current=useRef(items);current.current=items;
  const jobs=useRef(new Map<string,AbortController>()); const alive=useRef(true);
  const update=(key:string,patch:Partial<Item>)=>{if(alive.current){current.current=current.current.map((a)=>a.key===key?{...a,...patch}:a);setItems(current.current);}};
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;for(const c of jobs.current.values())c.abort();};},[]);
  const upload=async(item:Item,id:string)=>{
    if(item.info)return item.info.id;
    if(!item.file)throw new Error('请重新添加这个附件');
    const controller=new AbortController();jobs.current.get(item.key)?.abort();jobs.current.set(item.key,controller);update(item.key,{progress:0,error:undefined});
    try{const info=await api.uploadAttachment(id,item.file,(progress)=>update(item.key,{progress}),controller.signal);update(item.key,{info,progress:100});return info.id;}
    catch(e){update(item.key,{error:e instanceof Error?e.message:'上传失败'});throw e;}
    finally{if(jobs.current.get(item.key)===controller)jobs.current.delete(item.key);}
  };
  const add=(files:File[])=>{
    const added:Item[]=[];
    for(let file of files){const error=attachmentLimit(file.size,current.current.length+added.length);if(error){toast(error,'attn');continue;}
      if(!file.name||file.name==='image.png'||file.name==='clipboard.png')file=new File([file],screenshotName(new Date()),{type:file.type});
      added.push({key:crypto.randomUUID(),file,progress:taskId?0:100});
    }
    current.current=[...current.current,...added];setItems(current.current);
    if(taskId)for(const item of added)void upload(item,taskId).catch(()=>{});
  };
  return {items,add,
    remove:(key:string)=>{jobs.current.get(key)?.abort();current.current=current.current.filter((x)=>x.key!==key);setItems(current.current);},
    clear:()=>{for(const c of jobs.current.values())c.abort();current.current=[];setItems([]);},
    retry:(key:string)=>{const item=current.current.find((x)=>x.key===key);if(item&&taskId)void upload(item,taskId).catch(()=>{});},
    restore:async(ids:string[])=>{const found:Item[]=[];for(const id of ids){try{const info=await api.attachmentInfo(taskId!,id);found.push({key:id,info,progress:100});}catch{toast('草稿中的附件已过期，请重新添加','attn');}}if(alive.current)setItems((a)=>[...a,...found.filter((f)=>!a.some((x)=>x.info?.id===f.info!.id))]);},
    uploadFor:async(id:string)=>{const ids:string[]=[];for(const item of current.current)ids.push(await upload(item,id));return ids;},
    ids:items.flatMap((a)=>a.info?[a.info.id]:[]),
    uploading:!!taskId&&items.some((a)=>a.progress<100&&!a.info&&!a.error),
    failed:items.some((a)=>!!a.error),
  };
}
export function useAttachmentInput(add:(files:File[])=>void) {
  const input=useRef<HTMLInputElement>(null);const [dragging,setDragging]=useState(false);const depth=useRef(0);
  return {input,dragging, handlers:{
    onPaste:(e:ClipboardEvent)=>{const files=clipboardFiles(e.clipboardData.items);if(files.length){add(files);if(!e.clipboardData.getData('text/plain'))e.preventDefault();}},
    onDragEnter:(e:DragEvent)=>{if(e.dataTransfer.types.includes('Files')){e.preventDefault();depth.current++;setDragging(true);}},
    onDragOver:(e:DragEvent)=>{if(e.dataTransfer.types.includes('Files'))e.preventDefault();},
    onDragLeave:()=>{if(--depth.current<=0){depth.current=0;setDragging(false);}},
    onDrop:(e:DragEvent)=>{e.preventDefault();depth.current=0;setDragging(false);add(Array.from(e.dataTransfer.files));},
  }};
}
function AttachmentImage({taskId,info,file,onClick}:{taskId:string|null;info?:AttachmentInfo;file?:File;onClick:(url:string)=>void}) {
  const [url,setUrl]=useState(''),[error,setError]=useState(false);
  useEffect(()=>{let active=true,local='';setError(false);const load=async()=>{try{const blob=file??await api.attachmentBlob(taskId!,info!.id);local=URL.createObjectURL(blob);if(active)setUrl(local);else URL.revokeObjectURL(local);}catch{if(active)setError(true);}};void load();return()=>{active=false;if(local)URL.revokeObjectURL(local);};},[file,info?.id,taskId]);
  return error?<span role="status">预览失败</span>:<button type="button" className="attachment-image" disabled={!url} onClick={()=>onClick(url)} aria-label={`查看大图 ${info?.name??file?.name}`}><img src={url||undefined} alt={info?.name??file?.name??'图片'} width={120} height={90}/></button>;
}
function showImage(url:string,name:string){openDialog((close)=><Dialog title={name} onClose={close}><img className="attachment-large" src={url} alt={name}/></Dialog>);}
export function Attachments({state,taskId,info,model,onModel,onBlocked}:{state:ReturnType<typeof useAttachments>;taskId:string|null;info:AgentInfo|undefined;model:string|null;onModel:(id:string)=>void;onBlocked?:()=>void}) {
  const images=state.items.filter((a)=>(a.info?.kind??(/^(image\/(png|jpeg|gif|webp))$/.test(a.file?.type??'')?'image':'file'))==='image');
  const warning=visionWarning(info,model,images.length);
  return <>{warning.text?<div className="attachment-warning" role="status"><Icon name="warn"/>{warning.text}
    {warning.recommendation?<button type="button" className="btn sm" onClick={()=>onModel(warning.recommendation!.id)}>换成 {warning.recommendation.name}</button>:null}
    <button type="button" className="btn sm" onClick={()=>images.forEach((a)=>state.remove(a.key))}>去掉图片</button>
    {warning.vision===null?<button type="button" className="btn sm" onClick={onBlocked}>仍然发送</button>:null}</div>:null}
    <div className={'attachment-list'+(warning.vision===false?' cannot-see':'')}>{state.items.map((a)=>{const name=a.info?.name??a.file?.name??'附件',size=a.info?.size??a.file?.size??0;return <div className="attachment-item" key={a.key}>
      {(a.info?.kind==='image'||(!a.info&&/^(image\/(png|jpeg|gif|webp))$/.test(a.file?.type??'')))?<AttachmentImage taskId={taskId} info={a.info} file={a.file} onClick={(url)=>showImage(url,name)}/>:<Icon name="clip"/>}
      <span className="attachment-name" title={name}>{name}<small>{(size/1024).toFixed(1)} KB{a.progress<100&&!a.error?` · 上传中 ${a.progress}%`:''}</small></span>
      {a.error?<span role="alert">{a.error}<button type="button" className="linkish" onClick={()=>state.retry(a.key)}>重试</button></span>:null}
      <button type="button" className="btn ghost icon sm" aria-label={`移除 ${name}`} onClick={()=>state.remove(a.key)}>×</button>
    </div>;})}</div></>;
}
export function MessageAttachments({taskId,items}:{taskId:string;items:AttachmentInfo[]}) {
  return <div className="attachment-list">{items.map((a)=><div className="attachment-item" key={a.id}>{a.kind==='image'?<AttachmentImage taskId={taskId} info={a} onClick={(url)=>showImage(url,a.name)}/>:<button type="button" className="linkish" onClick={()=>void api.attachmentBlob(taskId,a.id).then((blob)=>{const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=a.name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}).catch(()=>toast('附件下载失败','attn'))}><Icon name="clip"/>{a.name}</button>}</div>)}</div>;
}
