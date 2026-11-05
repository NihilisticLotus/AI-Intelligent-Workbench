// 添加项目、新建任务两个对话框。
import { useMemo, useState } from 'react';
import type { AgentKind, ApiError, PermissionLevel } from '@aic/protocol';
import { platform, type PickedFolder } from '../platform';
import { createProject, createTask, useApp } from '../state/app';
import { navigate, toast } from '../state/ui';
import { permInfo, permOrder } from '../lib/format';
import { Dialog, ErrorNotice, asApiError, confirmDialog, openDialog } from './ui';
import { Icon } from './Icon';

// ---------------------------------------------------------------------
// 添加项目：用 /fs/browse 浏览选文件夹，不让用户手打路径
// ---------------------------------------------------------------------
export function openAddProject(then?: (projectId: string) => void) {
  openDialog((close) => <AddProject close={close} then={then} />);
}
function AddProject({ close, then }: { close: () => void; then?: (id: string) => void }) {
  const [picked, setPicked] = useState<PickedFolder | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const pick = async () => {
    const f = await platform.pickFolder();
    if (f) { setPicked(f); setErr(null); }
  };
  const submit = async () => {
    if (!picked || busy) return;
    setBusy(true);
    try {
      const p = await createProject(name.trim() || picked.name, picked.path);
      toast(`已添加项目“${p.name}”`);
      close();
      then?.(p.id);
    } catch (e) { setErr(asApiError(e)); setBusy(false); }
  };
  return (
    <Dialog title="添加项目" onClose={close}
      footer={<>
        <button type="button" className="btn" onClick={close}>取消</button>
        <button type="button" className="btn primary" disabled={!picked} aria-busy={busy} onClick={submit}>添加</button>
      </>}>
      <p>选择本机的一个项目文件夹，之后就能在这个项目里派发任务。</p>
      {err ? <ErrorNotice error={err} /> : null}
      <div className="form-row">
        <span className="lbl" id="ap-l">文件夹</span>
        <div style={{ display: 'flex', gap: 8, minWidth: 0 }}>
          <span className="fs-cur" aria-labelledby="ap-l" title={picked?.path ?? ''}>{picked?.path ?? '还没有选择'}</span>
          <button type="button" className="btn" onClick={pick} autoFocus><Icon name="folder" />选择文件夹…</button>
        </div>
      </div>
      <div className="form-row">
        <label htmlFor="ap-name">显示名称</label>
        <input id="ap-name" className="input" value={name} maxLength={200} placeholder={picked?.name ?? '默认用文件夹名'} onChange={(e) => setName(e.target.value)} />
      </div>
      {picked ? (
        <div className="alert info" style={{ margin: 0 }}>
          <Icon name="info" />
          <div className="body"><strong>检测结果</strong>
            <p>{picked.isGit ? '是 git 仓库。' : '不是 git 仓库。'}引擎类型和工作副本方式在第 1.3 步提供。</p>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}

// ---------------------------------------------------------------------
// 新建任务：项目、分组、要做什么、Agent、模型、思考强度、权限
// ---------------------------------------------------------------------
export function openNewTask(preset: { projectId?: string; groupId?: string | null } = {}) {
  openDialog((close) => <NewTask close={close} preset={preset} />);
}
function NewTask({ close, preset }: { close: () => void; preset: { projectId?: string; groupId?: string | null } }) {
  const projects = useApp((s) => s.projects);
  const groups = useApp((s) => s.groups);
  const agents = useApp((s) => s.agents);
  const usable = useMemo(() => agents.filter((a) => a.status === 'ready'), [agents]);
  const [projectId, setProjectId] = useState(preset.projectId ?? projects[0]?.id ?? '');
  const [groupId, setGroupId] = useState<string>(preset.groupId ?? '');
  const [prompt, setPrompt] = useState('');
  const firstAgent = usable.find((a) => a.kind === projects.find((p) => p.id === projectId)?.defaultAgent) ?? usable[0];
  const [agent, setAgent] = useState<AgentKind | ''>(firstAgent?.kind ?? '');
  const info = agents.find((a) => a.kind === agent);
  const [model, setModel] = useState<string>(info?.models[0]?.id ?? '');
  const [effort, setEffort] = useState<string>(info?.efforts?.[Math.floor((info.efforts.length - 1) / 2)] ?? '');
  const [perm, setPerm] = useState<PermissionLevel>('ask');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);

  const changeAgent = (k: AgentKind) => {
    setAgent(k);
    const a = agents.find((x) => x.kind === k);
    setModel(a?.models[0]?.id ?? '');
    setEffort(a?.efforts?.[Math.floor((a.efforts.length - 1) / 2)] ?? '');
  };
  const choosePerm = async (p: PermissionLevel) => {
    if (p === 'full') {
      const ok = await confirmDialog({
        title: '开启全自动？', ok: '开启全自动', danger: true,
        body: <><p>除了“始终禁止”清单里的操作，Agent 的所有操作都不再询问你。</p><p style={{ margin: 0 }}>建议只在可以随时丢弃的任务上使用。</p></>,
      });
      if (!ok) return;
    }
    setPerm(p);
  };
  const submit = async () => {
    const text = prompt.trim();
    if (!text) { document.getElementById('nt-d')?.focus(); toast('先写一句要做什么', 'attn'); return; }
    if (!projectId || !agent || busy) return;
    setBusy(true);
    try {
      const t = await createTask({
        projectId, groupId: groupId || null, prompt: text, agent,
        model: model || null, effort: effort || null, permission: perm,
      });
      close();
      navigate({ page: 'task', taskId: t.id });
    } catch (e) { setErr(asApiError(e)); setBusy(false); }
  };

  if (!projects.length) {
    return (
      <Dialog title="新建任务" onClose={close}
        footer={<><button type="button" className="btn" onClick={close}>取消</button>
          <button type="button" className="btn primary" onClick={() => { close(); openAddProject((id) => openNewTask({ projectId: id })); }}>添加项目</button></>}>
        <div className="empty" style={{ padding: 'var(--sp-4) 0' }}>
          <h3>先添加一个项目</h3><p>任务要在某个项目文件夹里进行。添加项目后就能派发任务。</p>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title="新建任务" onClose={close} initialFocus="#nt-d"
      footer={<>
        <button type="button" className="btn" onClick={close}>取消</button>
        <button type="button" className="btn primary" aria-busy={busy} disabled={!agent} onClick={submit}>派发</button>
      </>}>
      {err ? <ErrorNotice error={err} /> : null}
      <div className="form-row"><label htmlFor="nt-p">项目</label>
        <select id="nt-p" className="select" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      <div className="form-row"><label htmlFor="nt-g">分组</label>
        <select id="nt-g" className="select" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
          <option value="">不分组（未分类）</option>
          {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
      </div>
      <div className="form-row top"><label htmlFor="nt-d">要做什么</label>
        <textarea id="nt-d" className="textarea" rows={4} value={prompt} maxLength={100_000}
          placeholder="例如：背包界面的悬停提示改成跟随手柄焦点"
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit(); } }} />
      </div>
      <div className="form-row"><label htmlFor="nt-a">Agent</label>
        <select id="nt-a" className="select" value={agent} onChange={(e) => changeAgent(e.target.value as AgentKind)}>
          {!agents.length ? <option value="">没有可用的 Agent</option> : null}
          {agents.map((a) => (
            <option key={a.kind} value={a.kind} disabled={a.status !== 'ready'}>
              {a.displayName}{a.status !== 'ready' ? `（${agentStatusText(a.status)}）` : ''}
            </option>
          ))}
        </select>
      </div>
      <div className="form-row"><label htmlFor="nt-m">模型</label>
        <select id="nt-m" className="select" value={model} onChange={(e) => setModel(e.target.value)} disabled={!info?.models.length}>
          {info?.models.length ? info.models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>) : <option value="">由 Agent 决定</option>}
        </select>
      </div>
      <div className="form-row"><label htmlFor="nt-e">思考强度</label>
        <select id="nt-e" className="select" value={effort} onChange={(e) => setEffort(e.target.value)} disabled={!info?.efforts?.length}>
          {info?.efforts?.length ? info.efforts.map((x) => <option key={x} value={x}>{x}</option>) : <option value="">由模型自己决定</option>}
        </select>
      </div>
      <div className="form-row top"><span className="lbl" id="nt-l">权限</span>
        <div className="perm-radios" role="radiogroup" aria-labelledby="nt-l">
          {permOrder.map((p) => (
            <label key={p} className={p === 'full' ? 'full' : undefined}>
              <input type="radio" name="nt-perm" checked={perm === p} onChange={() => void choosePerm(p)} />
              <Icon name={permInfo[p].icon} />
              <span>{permInfo[p].label}{p === 'ask' ? '（推荐）' : ''}<small>{permInfo[p].desc}</small></span>
            </label>
          ))}
        </div>
      </div>
      <p style={{ margin: 0, color: 'var(--fg-3)' }}>Ctrl+Enter 派发。每个任务的独立工作副本在第 1.3 步提供。</p>
    </Dialog>
  );
}

export function agentStatusText(s: string): string {
  return ({ ready: '就绪', needs_login: '需要登录', not_installed: '未安装', error: '出错', disabled: '已停用' } as Record<string, string>)[s] ?? s;
}
