// 新建任务对话框：项目、分组、要做什么、Agent、账号、模型、思考强度、权限。
// 真实 Agent（第 1.2 步）：直接在项目目录里运行，只开放“只读”“需审批”；未就绪的 Agent 显示原因，可以跳到 Agent 页处理。
import { useMemo, useRef, useState } from 'react';
import { FeatureKey, type AgentInfo, type AgentKind, type ApiError, type PermissionLevel } from '@aic/protocol';
import { createTask, sendPrompt, api, useApp } from '../state/app';
import { navigate, toast } from '../state/ui';
import { permInfo, permOrder } from '../lib/format';
import {
  DIRECT_EDIT_WARNING, PERM_LOCKED_REASON, agentReadiness, agentStatusText, agentStatusView, emptyModelsText, isRealAgent,
  permAvailable, profileKindText, taskDefaults, workspaceConfigNote, isEnabled } from '../lib/agents';
import { Dialog, ErrorNotice, asApiError, confirmDialog } from './ui';
import { Attachments, useAttachments, useAttachmentInput } from './Attachments';
import { AgentPicker } from './AgentPicker';
import { visionWarning } from '../lib/attachments';
import { Icon } from './Icon';
/** 默认选中的模型和思考强度（见 lib/agents.ts 的 taskDefaults：真实 Agent 优先用 Agent 设置里的默认值） */
const defaultModel = (a: AgentInfo | undefined) => taskDefaults(a).model;
const defaultEffort = (a: AgentInfo | undefined) => taskDefaults(a).effort;

export function NewTaskDialog({ close, preset, onAddProject }: {
  close: () => void;
  preset: { projectId?: string; groupId?: string | null; agent?: AgentKind; model?: string; prompt?: string };
  /** 还没有项目时：关掉本对话框，先添加项目 */
  onAddProject: () => void;
}) {
  const projects = useApp((s) => s.projects);
  const groups = useApp((s) => s.groups);
  // 关闭的 Agent 不出现在新建任务里（design.md 6.7）
  const allAgents = useApp((s) => s.agents);
  const agents = useMemo(() => allAgents.filter(isEnabled), [allAgents]);
  const profilesOn = useApp((s) => !!s.hello?.features[FeatureKey.Profiles]);
  const usable = useMemo(() => agents.filter((a) => a.status === 'ready'), [agents]);
  const [projectId, setProjectId] = useState(preset.projectId ?? projects[0]?.id ?? '');
  const [groupId, setGroupId] = useState<string>(preset.groupId ?? '');
  const [prompt, setPrompt] = useState(preset.prompt??'');
  const [created,setCreated]=useState<string|null>(null);
  const attachments=useAttachments(created), attachmentInput=useAttachmentInput(attachments.add);
  const firstAgent = usable.find((a) => a.kind === projects.find((p) => p.id === projectId)?.defaultAgent) ?? usable[0] ?? agents[0];
  const [agent, setAgent] = useState<AgentKind | ''>(preset.agent ?? firstAgent?.kind ?? '');
  const info = agents.find((a) => a.kind === agent);
  const [model, setModel] = useState<string>(preset.model??defaultModel(info));
  const [effort, setEffort] = useState<string>(defaultEffort(info));
  const [profileId, setProfileId] = useState<string>('');
  const [perm, setPerm] = useState<PermissionLevel>('ask');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);

  const readiness = agentReadiness(info);
  const wsNote = workspaceConfigNote(info);
  const real = !!agent && isRealAgent(agent);
  const profiles = profilesOn && real ? info?.profiles ?? [] : [];
  const efforts = info?.efforts?.length ? info.efforts : null;

  const changeAgent = (k: AgentKind) => {
    setAgent(k);
    const a = agents.find((x) => x.kind === k);
    setModel(defaultModel(a));
    setEffort(defaultEffort(a));
    setProfileId('');
    // 换成真实 Agent 时，没开放的权限级别退回“需审批”
    if (!permAvailable(k, perm, a)) setPerm('ask');
    setErr(null);
  };
  const choosePerm = async (p: PermissionLevel) => {
    if (!agent || !permAvailable(agent, p, info)) return;
    if (p === 'full') {
      const ok = await confirmDialog({
        title: '开启全自动？', ok: '开启全自动', danger: true,
        body: <><p>除了“始终禁止”清单里的操作，Agent 的所有操作都不再询问你。</p><p style={{ margin: 0 }}>建议只在可以随时丢弃的任务上使用。</p></>,
      });
      if (!ok) return;
    }
    setPerm(p);
  };
  const goFix = () => {
    close();
    navigate(agent ? { page: 'agents', agent } : { page: 'agents' });
  };
  const submit = async (force = false) => {
    const text = prompt.trim();
    if (!text && !attachments.items.length) { document.getElementById('nt-d')?.focus(); toast('先写一句要做什么', 'attn'); return; }
    if (!projectId || !agent || busy || attachments.uploading || !readiness.ready) return;
    const warning=visionWarning(info,model||null,attachments.items.filter((a)=>a.info?.kind==='image'||a.file?.type.startsWith('image/')).length);
    if(warning.text && (warning.vision===false||!force)){toast(warning.text,'attn');document.querySelector<HTMLElement>('.attachment-warning button')?.focus();return;}
    setBusy(true);setErr(null);
    try {
      const t = created ? {id:created} : await createTask({
        projectId, groupId: groupId || null, prompt: text, agent,
        model: model || null, effort: effort || null, permission: perm,
        ...(profileId ? { profileId } : {}),
        ...(attachments.items.length?{deferPrompt:true}:{}),
      });
      if(attachments.items.length||created){setCreated(t.id);const ids=await attachments.uploadFor(t.id);await sendPrompt(t.id,text,ids);}
      close();
      navigate({ page: 'task', taskId: t.id });
    } catch (e) { setErr(asApiError(e)); setBusy(false); }
  };

  if (!projects.length) {
    return (
      <Dialog title="新建任务" onClose={close}
        footer={<><button type="button" className="btn" onClick={close}>取消</button>
          <button type="button" className="btn primary" onClick={onAddProject}>添加项目</button></>}>
        <div className="empty" style={{ padding: 'var(--sp-4) 0' }}>
          <h3>先添加一个项目</h3><p>任务要在某个项目文件夹里进行。添加项目后就能派发任务。</p>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title="新建任务" onClose={close} initialFocus="#nt-d"
      footer={<>
        {real && readiness.ready ? (
          <p className="dlg-warn" role="note"><Icon name="warn" /><span>{DIRECT_EDIT_WARNING}{wsNote?.warn ? ` ${wsNote.text}。` : ''}</span></p>
        ) : null}
        <button type="button" className="btn" onClick={close}>取消</button>
        <button type="button" className="btn primary" aria-busy={busy} disabled={busy || !agent || !readiness.ready} onClick={()=>void submit()}>派发</button>
      </>}>
      {err ? <ErrorNotice error={err} /> : null}
      <div className="form-row"><label htmlFor="nt-p">项目</label>
        <select id="nt-p" className="select" disabled={!!created} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      <div className="form-row"><label htmlFor="nt-g">分组</label>
        <select id="nt-g" className="select" disabled={!!created} value={groupId} onChange={(e) => setGroupId(e.target.value)}>
          <option value="">不分组（未分类）</option>
          {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
      </div>
      <div className="form-row top"><label htmlFor="nt-d">要做什么</label>
        <textarea id="nt-d" className="textarea" {...attachmentInput.handlers} rows={4} value={prompt} maxLength={100_000}
          placeholder="例如：背包界面的悬停提示改成跟随手柄焦点"
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit(); } }} />
      </div>
      <div className={'new-task-attachments'+(attachmentInput.dragging?' dragging':'')} {...attachmentInput.handlers}>
        <Attachments state={attachments} taskId={created} info={info} model={model||null} onModel={setModel} onBlocked={()=>void submit(true)}/>
        <input type="file" multiple hidden ref={attachmentInput.input} onChange={(e)=>{attachments.add(Array.from(e.target.files??[]));e.target.value='';}}/>
        <button type="button" className="btn sm" disabled={busy} onClick={()=>attachmentInput.input.current?.click()}><Icon name="clip"/>附件</button>
      </div>
      <div className="form-row"><span className="lbl">Agent · 模型 · 思考强度</span>
        <AgentPicker agents={agents} agent={agent||'fake'} config={{model:model||null,effort:effort||null}} profileId={profileId||info?.profiles?.find((p)=>p.isDefault)?.id||null} mode="new" disabled={busy||!!created}
          onPick={(p)=>{if(p.agent!==agent)changeAgent(p.agent);if(p.model!==undefined)setModel(p.model);if(p.effort!==undefined)setEffort(p.effort);if(p.profileId)setProfileId(p.profileId);}}/>
      </div>
      {agent && !readiness.ready ? (
        <div className="alert attn" id="nt-a-why" style={{ margin: '0 0 var(--sp-3)' }}>
          <Icon name="warn" />
          <div className="body"><strong>{readiness.reason}</strong>
            <p>{info?.status === 'needs_login' ? '在 Agent 页点“登录”，按提示在浏览器里完成授权，然后回来派发。'
              : info?.status === 'not_installed' ? '在 Agent 页查看检测结果，装好后点“重新检测”。'
              : '在 Agent 页点“测试连接”，看看卡在哪一步。'}</p>
            <div className="err-actions"><button type="button" className="btn sm" onClick={goFix}>去 Agent 页处理</button></div>
          </div>
        </div>
      ) : null}
      <div className="form-row top"><span className="lbl" id="nt-l">权限</span>
        <div className="perm-radios" role="radiogroup" aria-labelledby="nt-l">
          {permOrder.map((p) => {
            const ok = !agent || permAvailable(agent, p, info);
            return (
              <label key={p} className={[p === 'full' ? 'full' : '', ok ? '' : 'locked'].filter(Boolean).join(' ') || undefined}>
                <input type="radio" name="nt-perm" checked={perm === p} disabled={!ok||!!created} onChange={() => void choosePerm(p)} />
                <Icon name={permInfo[p].icon} />
                <span>{permInfo[p].label}{p === 'ask' ? '（推荐）' : ''}
                  <small>{ok ? permInfo[p].desc : `${PERM_LOCKED_REASON}。现在任务直接在项目目录里运行，这一档下 Agent 不再请求审批`}</small></span>
              </label>
            );
          })}
        </div>
      </div>
      <p style={{ margin: 0, color: 'var(--fg-3)' }}>Ctrl+Enter 派发。派发后也能在输入框下方换模型和思考强度。</p>
    </Dialog>
  );
}
