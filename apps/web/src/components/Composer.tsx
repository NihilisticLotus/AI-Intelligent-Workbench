// 输入区：待审批条 + 中断提示 + 输入框 + 工具条（附件、[Agent · 账号 · 模型 · 思考强度] 切换器、权限级别、发送 / 停止）。
import { useEffect, useMemo, useRef, useState } from 'react';
import { FeatureKey, type ApiError, type Approval, type PermissionLevel, type Task } from '@aic/protocol';
import { appStore, cancelTask, patchTask, sendPrompt, switchConfig, useApp } from '../state/app';
import { toast } from '../state/ui';
import { createStore, useStore } from '../state/store';
import type { SessionCfg } from '../state/core';
import { permInfo, permOrder } from '../lib/format';
import {
  PERM_LOCKED_REASON, agentReadiness, isEnabled, emptyModelsText, modelSwitchKind, permAvailable, pickEfforts, pickModels,
  profileKindText, profileSwitchKind, profileSwitchText, switchKindText, switchNeedsTurnEnd, withDefaultActions,
} from '../lib/agents';
import { AgentBadge, ErrorNotice, asApiError, choiceDialog, confirmDialog, openMenu, toastErrorOf, useAgentName } from './ui';
import { Icon } from './Icon';
import { AgentPicker } from './AgentPicker';
import { Attachments, useAttachments, useAttachmentInput } from './Attachments';
import { visionWarning } from '../lib/attachments';
import { platform } from '../platform';
import { useNow, useDismiss } from './hooks';
import { requestFocusApproval, switcherRequestStore, type SwitcherSection } from './focus';
import { TaskError } from './Chat';
import { AnnotationChip, clearAnnotations, draftAnnotations, onAnnotationsChanged, restoreAnnotations, useAnnotations } from './Annotations';
import { clearDraft, loadDraft, localDraft, saveDraft } from '../state/drafts';
import { composeWithAnnotations } from '../lib/annotations';
import { openIndependentConfig } from './independent-task-panel';
import { ContextRing } from './ContextRing';

const busyStatuses = new Set<Task['status']>(['running', 'waiting', 'queued']);

export function Composer({ task, pending, config, blocking }: { task: Task; pending: Approval[]; config: SessionCfg; blocking?: ApiError | null }) {
  const attachments = useAttachments(task.id);
  const attachmentInput = useAttachmentInput(attachments.add);
  const info = useApp((s)=>s.agents.find((a)=>a.kind===task.agent));
  const visionInfo = info ? {...info,models:pickModels(info,config)} : undefined;
  const imageCount = attachments.items.filter((a)=>a.info?.kind==='image').length;
  const warning = visionWarning(visionInfo,config.model,imageCount);
  const [blocked,setBlocked]=useState(false);
  const attachmentIds=useRef<string[]>([]);attachmentIds.current=attachments.ids;
  const now=useNow(1000);
  const logs=useApp((s)=>s.logs[task.id]);
  const lastUser=logs?.findLast((e)=>e.type==='message.user');
  const idleNotice=logs?.some((e)=>e.type==='session.notice'&&e.data.id&&e.ts>=(lastUser?.ts??Infinity));
  const conn = useApp((s) => s.conn);
  const online = conn === 'online' || conn === 'replaying';
  // 草稿（文字 + 注释）按任务保存在 Gateway：先用本页内存里的，再用服务端读回来的补上（state/drafts.ts）
  const [text, setText] = useState(() => localDraft(task.id)?.text ?? '');
  const [sending, setSending] = useState(false);
  const [sendErr, setSendErr] = useState<ApiError | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const ready = useRef(false);
  const [draftReady,setDraftReady]=useState(false);

  // 对话里选中文字添加的注释：发送时附在消息后面（Annotations.tsx）
  const annos = useAnnotations(task.id);

  useEffect(() => {
    let alive = true;
    ready.current = false;
    void loadDraft(task.id).then(async (d) => {
      if (!alive) return;
      if(d?.expiredAttachments)toast('草稿中的附件已过期，请重新添加','attn');
      if (d && !localDraft(task.id)) {
        if (d.text) setText((t) => t || d.text);
        if (d.annotations.length) restoreAnnotations(task.id, d.annotations);
      }
      const saved = localDraft(task.id) ?? d;
      if(saved?.attachments?.length)await attachments.restore(saved.attachments);
      if(!alive)return;
      ready.current = true;setDraftReady(true);
    });
    // 注释改了（添加、评论、删除）也保存
    const off = onAnnotationsChanged((id) => { if (id === task.id && ready.current) saveDraft(id, { text: ta.current?.value ?? '', annotations: draftAnnotations(id), attachments: attachmentIds.current }); });
    return () => { alive = false; off(); };
  }, [task.id]);
  useEffect(() => {
    if (draftReady) saveDraft(task.id, { text, annotations: draftAnnotations(task.id), attachments: attachments.ids });
  }, [task.id, text, attachments.ids.join(','),draftReady]);

  const working = busyStatuses.has(task.status);
  const canSend = online && draftReady && !working && !sending && (text.trim().length > 0 || annos.length > 0 || attachments.ids.length>0) && !attachments.uploading && !attachments.failed;

  const send = async (force = false) => {
    if (!canSend) return;
    if(imageCount && (warning.vision===false || (warning.vision===null&&!force))){setBlocked(true);toast(warning.text,'attn');setTimeout(()=>document.querySelector<HTMLElement>('.attachment-warning button')?.focus(),0);setTimeout(()=>setBlocked(false),700);return;}
    const body = composeWithAnnotations(text, annos);
    setSending(true);
    setSendErr(null);
    try {
      await sendPrompt(task.id, body, attachments.ids);
      attachments.clear();
      setText('');
      clearAnnotations(task.id);
      clearDraft(task.id);
    } catch (e) {
      setSendErr(withDefaultActions(asApiError(e), { taskId: task.id, kind: task.agent })); // 发送失败时保留输入内容，错误连同按钮显示在输入框上方
    } finally {
      setSending(false);
      ta.current?.focus();
    }
  };
  const stop = async () => {
    try { await cancelTask(task.id); toast('已请求停止，Agent 会在当前步骤结束后停下'); } catch (e) { toastErrorOf(e, { taskId: task.id, kind: task.agent }); }
  };
  const chooseImageModel = async (model:string) => {
    if (task.agent === 'independent') { openIndependentConfig(task.id, model); return; }
    try {
      if(switchNeedsTurnEnd(task.status,'model',modelSwitchKind(info?.caps))){
        const choice=await choiceDialog({title:'Agent 正在执行',body:<p>可以等当前步骤完成后切换，也可以立即中断这一轮。</p>,choices:[{value:'wait',label:'等当前步骤完成',primary:true},{value:'interrupt',label:'立即中断',danger:true}]});
        if(!choice)return;queueSwitchAfterTurn(task.id,{kind:'model',patch:{model},label:'换模型'});
        if(choice==='interrupt')await cancelTask(task.id);
      }else await switchConfig(task.id,{model});
    }catch(e){cancelPendingSwitch(task.id);setSendErr(asApiError(e));}
  };

  const serviceStopped = conn === 'down';
  const placeholder = serviceStopped ? '工作台服务已停止，重新启动后可以继续发送'
    : !online ? '正在重新连接，恢复后可以继续发送'
    : task.status === 'waiting' ? '有审批等你处理，处理后 Agent 会继续'
    : working ? 'Agent 正在工作，完成后可以继续对话；需要时可以点“停止”'
    : blocking ? '处理上面的提示后，发一条消息就能继续（会自动恢复会话）'
    : task.status === 'interrupted' ? '任务中断了：发一条消息就能继续（会自动恢复会话）'
    : '继续对话，或补充要求。Enter 发送，Shift+Enter 换行';

  return (
    <div className="composer">
      <div className="composer-inner">
        {!online ? (
          <div className={'offline-note' + (serviceStopped ? ' is-down' : '')} role={serviceStopped ? 'alert' : 'status'}>
            <Icon name={serviceStopped ? 'alert' : 'refresh'} />
            <div className="offline-copy">
              {serviceStopped ? <><strong>工作台服务已停止</strong><span>对话不会丢。双击桌面上的“启动 AI Console”可以重新打开；打开后这里会自动恢复。</span></> : '和服务的连接断开了，正在重新连接…恢复后会自动补齐对话。'}
            </div>
            {serviceStopped && platform.restartGateway ? <button type="button" className="btn" onClick={() => void platform.restartGateway!()}>重新启动</button> : null}
          </div>
        ) : null}
        {blocking && !working ? <div className="composer-error"><TaskError error={blocking} task={task} compact /></div> : null}
        {sendErr ? <div className="composer-error"><ErrorNotice error={sendErr} ctx={{ taskId: task.id, kind: task.agent, busy: working }} onDismiss={() => setSendErr(null)} onAction={() => setSendErr(null)} /></div> : null}
        {pending.length ? (
          <div className="pending-strip" role="status">
            <Icon name="shield" />
            <span>有 {pending.length} 项审批等你处理：{pending[0]!.title}</span>
            <span className="grow" />
            <button type="button" className="btn sm ghost" onClick={() => requestFocusApproval(pending[0]!.id)}>跳到审批</button>
          </div>
        ) : null}
        <div className={'compose-box'+(attachmentInput.dragging?' dragging':'')+(blocked?' attachment-blocked':'')} {...attachmentInput.handlers}>
          {working&&idleNotice?<div className="attachment-warning" role="status">正在处理 · {Math.max(0,Math.floor((now-(lastUser?.ts??now))/1000))} 秒，Agent 暂时没有回应。<button type="button" className="btn sm" onClick={stop}>停止</button></div>:null}
          <Attachments state={attachments} taskId={task.id} info={visionInfo} model={config.model} onModel={(model)=>void chooseImageModel(model)} onBlocked={()=>void send(true)}/>
          <input type="file" multiple hidden ref={attachmentInput.input} onChange={(e)=>{attachments.add(Array.from(e.target.files??[]));e.target.value='';}}/>
          <AnnotationChip taskId={task.id} />
          <label htmlFor="prompt" className="sr-only">给 Agent 发消息</label>
          <textarea id="prompt" ref={ta} value={text} placeholder={placeholder} maxLength={100_000}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // 输入法组字时的回车不算发送
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
            }} />
          <div className="compose-bar">
            <button type="button" className="btn ghost icon sm" aria-label="添加附件" title="选择文件或粘贴、拖入图片" onClick={()=>attachmentInput.input.current?.click()}><Icon name="clip" /></button>
            <Switcher task={task} config={config} online={online} />
            <span className="grow" />
            <PermChip task={task} online={online} />
            {working ? (
              <button type="button" className="btn" style={{ order: 7 }} onClick={stop} disabled={!online} aria-label="停止 Agent"><Icon name="stop" />停止</button>
            ) : null}
            <ContextRing usage={config.usage} />
            <button type="button" className="btn primary" aria-label="发送" disabled={!canSend} aria-busy={sending} onClick={()=>void send()}><Icon name="send" />发送</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// [Agent · 账号 · 模型 · 思考强度] 切换器（ui-design.md 6.5，phase-1.md 6.7）
// 选项以当前会话的 session.config（models / efforts）为准，没有会话时用 /agents 的缓存。
// 切换后等服务端 ack；失败时界面仍显示原值（值来自事件），并提示 Agent 给的说明。
// ---------------------------------------------------------------------
type Busy = 'model' | 'effort' | 'profile' | null;
type SwitchPatch = { model?: string; effort?: string; profileId?: string };

// 本轮结束后再执行的切换（用户选了“等当前步骤完成”或“立即中断”）：按任务记一条，任务不再忙时执行。
// 放在模块里而不是组件里：用户切到别的任务再回来也不会丢。
interface PendingSwitch { kind: Exclude<Busy, null>; patch: SwitchPatch; label: string }
const pendingSwitchStore = createStore<Record<string, PendingSwitch>>({});
let pendingWatch: (() => void) | null = null;
function queueSwitchAfterTurn(taskId: string, p: PendingSwitch) {
  pendingSwitchStore.set((m) => ({ ...m, [taskId]: p }));
  if (pendingWatch) return;
  const check = () => {
    const all = pendingSwitchStore.get();
    for (const [id, sw] of Object.entries(all)) {
      const t = appStore.get().tasks[id];
      if (!t) { pendingSwitchStore.set((m) => { const n = { ...m }; delete n[id]; return n; }); continue; }
      if (busyStatuses.has(t.status)) continue;
      pendingSwitchStore.set((m) => { const n = { ...m }; delete n[id]; return n; });
      switchConfig(id, sw.patch).then(
        () => toast(`这一轮已结束，${sw.label}`),
        (e) => toastErrorOf(e, { taskId: id, kind: t.agent }),
      );
    }
    if (!Object.keys(pendingSwitchStore.get()).length && pendingWatch) { pendingWatch(); pendingWatch = null; }
  };
  pendingWatch = appStore.subscribe(check);
  check();
}
function cancelPendingSwitch(taskId: string) {
  pendingSwitchStore.set((m) => { if (!m[taskId]) return m; const n = { ...m }; delete n[taskId]; return n; });
}

function Switcher({ task, config, online }: { task: Task; config: SessionCfg; online: boolean }) {
  const agents = useApp((s) => s.agents);
  const info = agents.find((a) => a.kind === task.agent);
  const [busy,setBusy] = useState<Busy>(null), [swErr,setSwErr] = useState<ApiError|null>(null);
  const pendingSw = useStore(pendingSwitchStore,(m)=>m[task.id]??null);
  const req=useStore(switcherRequestStore,(s)=>s),[requestKey,setRequestKey]=useState(0);
  useEffect(()=>{if(req?.taskId===task.id){if(task.agent==='independent')openIndependentConfig(task.id);else setRequestKey(req.n);switcherRequestStore.set(()=>null);}},[req,task.id,task.agent]);
  const doSwitch=async(kind:Exclude<Busy,null>,patch:SwitchPatch)=>{
    if(busy)return;setSwErr(null);const label=kind==='model'?'换模型':kind==='profile'?'换账号':'调整思考强度';
    if(switchNeedsTurnEnd(task.status,kind,modelSwitchKind(info?.caps))){
      const choice=await choiceDialog({title:'Agent 正在执行',body:<p>可以等当前步骤完成后切换，也可以立即中断这一轮。</p>,choices:[{value:'wait',label:'等当前步骤完成',primary:true},{value:'interrupt',label:'立即中断',danger:true}]});
      if(!choice)return;queueSwitchAfterTurn(task.id,{kind,patch,label});
      if(choice==='interrupt')try{await cancelTask(task.id);}catch(e){cancelPendingSwitch(task.id);setSwErr(asApiError(e));}return;
    }
    setBusy(kind);try{await switchConfig(task.id,patch);}catch(e){setSwErr(withDefaultActions(asApiError(e),{taskId:task.id,kind:task.agent}));}finally{setBusy(null);}
  };
  const profileId=config.profileId??task.profileId??info?.profiles?.find((p)=>p.isDefault)?.id??null;
  if (task.agent === 'independent') return <button type="button" className="picker-trigger independent-runtime-trigger" aria-label="AI Console 独立 Agent 独立 Agent · 模型与运行配置" title="独立 Agent · 模型与运行配置" disabled={!online || busyStatuses.has(task.status)} onClick={() => openIndependentConfig(task.id)}><AgentBadge kind="independent" size="sm"/>独立配置<Icon name="down"/></button>;
  return <div>
    <AgentPicker agents={agents} agent={task.agent} config={config} profileId={profileId} mode="task" disabled={!online||!!busy} requestKey={requestKey} taskPreset={{projectId:task.projectId,prompt:task.prompt}}
      onPick={(p)=>void doSwitch(p.profileId?'profile':p.model!==undefined?'model':'effort',{...(p.model?{model:p.model}:{}),...(p.effort?{effort:p.effort}:{}),...(p.profileId?{profileId:p.profileId}:{})})}/>
    {swErr?<ErrorNotice error={swErr} ctx={{taskId:task.id,kind:task.agent}} onDismiss={()=>setSwErr(null)}/>:null}
    {pendingSw?<div className="hint" role="status">这一轮结束后会{pendingSw.label}。<button type="button" className="linkish" onClick={()=>cancelPendingSwitch(task.id)}>不换了</button></div>:null}
  </div>;
}

// ---------------------------------------------------------------------
// 权限级别：只读=眼睛、需审批=盾牌、工作区内自动=带勾的盾牌、全自动=打开的锁（琥珀色，二次确认）
// 能选哪几档以 Gateway 给的 AgentInfo.permissionLevels 为准（审查第 13 条）
// ---------------------------------------------------------------------
function PermChip({ task, online }: { task: Task; online: boolean }) {
  const info = permInfo[task.permission];
  const agentInfo = useApp((s) => s.agents.find((a) => a.kind === task.agent));
  const set = async (p: PermissionLevel) => {
    if (p === task.permission) return;
    if (p === 'full') {
      const ok = await confirmDialog({
        title: '开启全自动？', ok: '开启全自动', danger: true,
        body: <><p>除了“始终禁止”清单里的操作（例如删除工作区外的文件），Agent 的所有操作都不再询问你。</p><p style={{ margin: 0 }}>建议只在可以随时丢弃的任务上使用。</p></>,
      });
      if (!ok) return;
    }
    try {
      await patchTask(task.id, { permission: p });
      toast(`本任务权限改为“${permInfo[p].label}”，从下一步开始生效`);
    } catch (e) { toastErrorOf(e, { taskId: task.id, kind: task.agent }); }
  };
  return (
    <button type="button" className="perm-chip" data-level={info.level} aria-haspopup="menu" disabled={!online}
      aria-label={`权限级别：${info.label}，点击修改`} title={`权限级别：${info.label}（点击修改）`}
      onClick={(e) => openMenu(e.currentTarget, permOrder.map((p) => {
        const ok = permAvailable(task.agent, p, agentInfo);
        return {
          label: `${p === task.permission ? '✓ ' : ''}${permInfo[p].label}${p === 'full' && ok ? '…' : ''}：${ok ? permInfo[p].desc : PERM_LOCKED_REASON}`,
          danger: p === 'full' && ok,
          disabled: !ok,
          onSelect: () => void set(p),
        };
      }))}>
      <Icon name={info.icon} />{info.label}
    </button>
  );
}
