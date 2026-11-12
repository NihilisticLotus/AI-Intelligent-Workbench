// 新任务起始页：沿用任务 API、附件和选择器，所有真实调用都由明确的派发触发。
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentKind, ApiError, IndependentTaskOptions, SavedEnvironment } from '@aic/protocol';
import { api, createTask, sendPrompt, useApp } from '../state/app';
import { navigate, returnFromNewTask, toast, type NewTaskPreset } from '../state/ui';
import { agentReadiness, isEnabled, isRealAgent, permAvailable, taskDefaults, workspaceConfigNote } from '../lib/agents';
import { permInfo, permOrder } from '../lib/format';
import { profileDefaults, profileInfo } from '../lib/picker';
import { visionWarning } from '../lib/attachments';
import { greeting, newTaskBody, quickTemplates, recommendAgent, templateDraft } from '../lib/new-task';
import { Attachments, useAttachments, useAttachmentInput } from '../components/Attachments';
import { AgentPicker } from '../components/AgentPicker';
import { IndependentTaskConfig } from '../components/independent-task-config';
import { NewTaskMenu } from '../components/new-task-menu';
import { Icon } from '../components/Icon';
import { ErrorNotice, asApiError } from '../components/ui';
import { openAddProject } from '../components/dialogs';

export function NewTaskPage({ preset = {} }: { preset?: NewTaskPreset }) {
  const projects = useApp((s) => s.projects), groups = useApp((s) => s.groups), tasks = useApp((s) => s.tasks), allAgents = useApp((s) => s.agents);
  const agents = useMemo(() => allAgents.filter(isEnabled), [allAgents]);
  const [projectId, setProjectId] = useState(preset.projectId ?? projects[0]?.id ?? '');
  const project = projects.find((p) => p.id === projectId);
  const [groupId, setGroupId] = useState(preset.groupId ?? ''), [prompt, setPrompt] = useState(preset.prompt ?? '');
  const firstAgent = agents.find((a) => a.status === 'ready' && a.kind === project?.defaultAgent) ?? agents.find((a) => a.status === 'ready') ?? agents[0];
  const [agent, setAgent] = useState<AgentKind | ''>(preset.agent ?? firstAgent?.kind ?? '');
  const [profileId, setProfileId] = useState('');
  const baseInfo = agents.find((a) => a.kind === agent), info = profileInfo(baseInfo, profileId || null);
  const [model, setModel] = useState(preset.model ?? taskDefaults(info).model), [effort, setEffort] = useState(taskDefaults(info).effort);
  const [permission, setPermission] = useState<'readonly' | 'ask'>('ask');
  const [independent, setIndependent] = useState<IndependentTaskOptions | null>(null);
  const [created, setCreated] = useState<string | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<ApiError | null>(null);
  const [environments, setEnvironments] = useState<SavedEnvironment[]>([]), [environmentId, setEnvironmentId] = useState('');
  const [environmentError, setEnvironmentError] = useState<ApiError | null>(null), [environmentLoading, setEnvironmentLoading] = useState(true);
  const attachments = useAttachments(created), input = useAttachmentInput(attachments.add);
  const textarea = useRef<HTMLTextAreaElement>(null), submitting = useRef(false), alive = useRef(true);
  const readiness = agentReadiness(info), note = workspaceConfigNote(info);
  const hasImages = attachments.items.some((a) => a.info?.kind === 'image' || a.file?.type.startsWith('image/'));
  const recommendation = recommendAgent(prompt, hasImages, projectId, agents, Object.values(tasks));
  const [adopted, setAdopted] = useState('');
  const recommendationKey = recommendation ? `${projectId}:${recommendation.agent}:${recommendation.model}:${recommendation.reason}` : '';
  const adoptedCurrent = !!recommendation && adopted === recommendationKey && agent === recommendation.agent && model === recommendation.model;

  useEffect(() => {
    alive.current = true; textarea.current?.focus();
    void api.environments().then((rows) => { if (alive.current) setEnvironments(rows); }).catch((e) => { if (alive.current) setEnvironmentError(asApiError(e)); }).finally(() => { if (alive.current) setEnvironmentLoading(false); });
    return () => { alive.current = false; };
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const overlayOpen = [...document.querySelectorAll('dialog[open], .menu, .popover')].some((element) => element.getClientRects().length > 0);
      if (e.key === 'Escape' && !e.defaultPrevented && !submitting.current && !overlayOpen) { e.preventDefault(); returnFromNewTask(); }
    };
    document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key);
  }, []);
  const changeAgent = (kind: AgentKind) => {
    const defaults = taskDefaults(agents.find((a) => a.kind === kind));
    if (kind !== agent) setIndependent(null);
    setAgent(kind); setProfileId(''); setModel(defaults.model); setEffort(defaults.effort); setError(null); setAdopted('');
  };
  const submit = async (force = false) => {
    if (!prompt.trim()) { textarea.current?.focus(); return; }
    if (!project || !agent || submitting.current || attachments.uploading || !readiness.ready || !permAvailable(agent, permission, info)) return;
    if (agent === 'independent' && !independent) { toast('请先填写有效的独立 Agent 配置', 'attn'); return; }
    const images = attachments.items.filter((a) => a.info?.kind === 'image' || a.file?.type.startsWith('image/')).length;
    const warning = visionWarning(info, model || null, images);
    if (warning.text && (warning.vision === false || !force)) { toast(warning.text, 'attn'); textarea.current?.closest('.nt-page')?.querySelector<HTMLElement>('.attachment-warning button')?.focus(); return; }
    submitting.current = true; setBusy(true); setError(null);
    try {
      const task = created ? { id: created } : await createTask(newTaskBody({ projectId, groupId, prompt, agent, model, effort, permission, profileId, independent, hasAttachments: !!attachments.items.length }));
      if (attachments.items.length || created) { setCreated(task.id); const ids = await attachments.uploadFor(task.id); await sendPrompt(task.id, prompt.trim(), ids); }
      toast('已派发新任务，可在左侧任务列表查看');
      if (alive.current) returnFromNewTask();
    } catch (e) { if (alive.current) { setError(asApiError(e)); setBusy(false); } }
    finally { submitting.current = false; }
  };
  const locked = busy || !!created;
  const sendDisabled = busy || !prompt.trim() || !project || !agent || !readiness.ready || attachments.uploading || !permAvailable(agent, permission, info) || agent === 'independent' && !independent;
  return <main className="main nt-page">
    <header className="nt-top"><button type="button" className="btn ghost" disabled={busy} onClick={returnFromNewTask}><Icon name="undo" />返回</button><span className="muted">新建任务</span></header>
    <div className="nt-center">
      <h1 className="nt-hello">{greeting(new Date().getHours())}<span>今天让 Agent 做什么？</span></h1>
      {!projects.length ? <div className="empty"><h2>先添加一个项目</h2><p>任务要在某个项目文件夹里进行。</p><button type="button" className="btn primary" onClick={() => openAddProject(setProjectId)}>添加项目</button></div> : <>
        {error ? <ErrorNotice error={error} /> : null}
        <fieldset className={'nt-box' + (input.dragging ? ' dragging' : '')} disabled={busy} {...(!busy ? input.handlers : {})}>
          <legend className="sr-only">新任务描述与派发设置</legend>
          <div className="nt-chips">
            <NewTaskMenu label={project?.name ?? '选择项目'} icon="folder" disabled={locked} options={projects.map((p) => ({ id: p.id, label: p.name, selected: p.id === projectId, onSelect: () => { setProjectId(p.id); setEnvironmentId(''); } }))} />
            <span className="nt-chip quiet" title="只显示当前分支，不会切换分支"><Icon name="branch" /><span>{project?.isGit ? project.branch ?? '分支未报告' : '非 Git 项目'}</span></span>
            <NewTaskMenu label={groups.find((g) => g.id === groupId)?.name ?? '不分组'} icon="layers" disabled={locked} options={[{ id: '', label: '不分组（未分类）', selected: !groupId, onSelect: () => setGroupId('') }, ...groups.map((g) => ({ id: g.id, label: g.name, selected: g.id === groupId, onSelect: () => setGroupId(g.id) }))]} />
            <NewTaskMenu label={environmentLoading ? '常用环境读取中…' : environments.find((e) => e.id === environmentId)?.name ?? '常用环境'} icon="drive" disabled={locked || environmentLoading || !!environmentError} options={environments.map((environment) => ({ id: environment.id, label: `${environment.name}${environment.branch ? ' · 记录分支 ' + environment.branch : ''}`, selected: environment.id === environmentId, disabled: !projects.some((p) => p.id === environment.projectId), onSelect: () => { setProjectId(environment.projectId); setEnvironmentId(environment.id); toast('已选择常用环境的项目，分支保持当前状态'); } }))} />
          </div>
          <p className="nt-worktree">工作副本在之后的版本提供；常用环境不会切换分支。</p>
          {environmentError ? <ErrorNotice error={environmentError} /> : null}
          <Attachments state={attachments} taskId={created} info={info} model={model || null} onModel={setModel} onBlocked={() => void submit(true)} />
          <label className="sr-only" htmlFor="nt-description">要做什么</label>
          <textarea ref={textarea} id="nt-description" rows={4} value={prompt} maxLength={100_000} placeholder="描述要做的事…" onChange={(e) => setPrompt(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); } }} />
          <input ref={input.input} type="file" multiple hidden onChange={(e) => { attachments.add(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
          <div className="nt-bar">
            <button type="button" className="btn ghost icon" aria-label="添加附件" title="添加附件，也可以粘贴或拖入" onClick={() => input.input.current?.click()}><Icon name="plus" /></button>
            <NewTaskMenu label={permInfo[permission].label} icon={permInfo[permission].icon} disabled={locked} options={permOrder.map((p) => ({ id: p, label: `${permInfo[p].label}${p === 'workspace' || p === 'full' ? ' · 之后的版本提供' : ''}`, selected: p === permission, disabled: p !== 'readonly' && p !== 'ask' || !agent || !permAvailable(agent, p, info), onSelect: () => { if (p === 'readonly' || p === 'ask') setPermission(p); } }))} />
            <span className="grow" />
            <AgentPicker agents={agents} agent={agent || 'fake'} config={{ model: model || null, effort: effort || null }} profileId={profileId || info?.profiles?.find((p) => p.isDefault)?.id || null} mode="new" disabled={locked} onPick={(pick) => {
              if (pick.agent !== agent) changeAgent(pick.agent);
              if (pick.model !== undefined) setModel(pick.model);
              if (pick.effort !== undefined) setEffort(pick.effort);
              if (pick.profileId) { setProfileId(pick.profileId); const defaults = profileDefaults(baseInfo, pick.profileId, model, effort); setModel(defaults.model); setEffort(defaults.effort); }
              setAdopted('');
            }} />
            <button type="button" className="btn primary nt-send" disabled={sendDisabled} aria-label="派发新任务" title="派发 Ctrl+Enter" aria-busy={busy} onClick={() => void submit()}><Icon name="up" /></button>
          </div>
        </fieldset>
        {recommendation ? <div className="nt-rec"><div><strong>推荐：{recommendation.label}</strong><p>{recommendation.reason}</p></div><button type="button" className="btn sm" disabled={locked || adoptedCurrent} onClick={() => { changeAgent(recommendation.agent); setModel(recommendation.model); setAdopted(recommendationKey); }}>{adoptedCurrent ? '已采用推荐' : '采用推荐'}</button></div> : null}
        {agent === 'independent' ? <IndependentTaskConfig initialModelId={model} onChange={(value) => { setIndependent(value); if (value) setModel(value.selection.modelId); }} disabled={locked} /> : null}
        {!readiness.ready ? <div className="alert attn"><div className="body"><strong>{readiness.reason}</strong><p>请在 Agent 页完成安装、登录或连接检测。</p><button type="button" className="btn sm" onClick={() => navigate(agent ? { page: 'agents', agent } : { page: 'agents' })}>去 Agent 页处理</button></div></div> : null}
        <div className="nt-quick">{quickTemplates.map((template) => <button key={template.id} type="button" className="nt-q" disabled={busy} onClick={() => { const draft = templateDraft(template); setPrompt(draft.text); requestAnimationFrame(() => { textarea.current?.focus(); textarea.current?.setSelectionRange(draft.start, draft.end); }); }}>{template.label}</button>)}</div>
        <p className="nt-foot">Ctrl+Enter 派发。{agent && isRealAgent(agent) ? permission === 'readonly' ? '当前为只读，Agent 不会修改项目文件。' : '任务直接在项目目录里运行，会直接修改项目文件，建议保持需审批。' : '演示 Agent 不调用真实模型。'}</p>
        {note?.warn ? <p className="nt-foot">{note.text}。</p> : null}
      </>}
    </div>
  </main>;
}
