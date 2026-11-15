import { confirmWorkspaceCopy } from '../workspace-confirmation';
import { useEffect, useState } from 'react';
import type { Project, SavedEnvironment, Task } from '@aic/protocol';
import { api } from '../../state/app';
import { permInfo } from '../../lib/format';
import { toastErrorOf } from '../ui';
import { toast } from '../../state/ui';

export function EnvironmentDetails({ project, task, profileName }: { project?: Project; task: Task; profileName: string | null }) {
  const [saved, setSaved] = useState<SavedEnvironment[]>([]), [busy, setBusy] = useState(false);
  useEffect(() => { let live = true; void api.environments().then((v) => { if (live) setSaved(v); }).catch(toastErrorOf); return () => { live = false; }; }, []);
  const save = async () => {
    if (!project || busy) return; setBusy(true);
    try { const item = await api.saveEnvironment({ name: `${project.name}${project.branch ? ' · ' + project.branch : ''}`.slice(0, 200), projectId: project.id, branch: project.branch ?? null }); setSaved((v) => [...v, item]); toast('已存为常用环境'); }
    catch (e) { toastErrorOf(e); } finally { setBusy(false); }
  };
  const remove = async (id: string) => { if (busy) return; setBusy(true); try { await api.deleteEnvironment(id); setSaved((v) => v.filter((x) => x.id !== id)); } catch (e) { toastErrorOf(e); } finally { setBusy(false); } };
  return <><dl className="d-dl environment-list">
    <dt>运行位置</dt><dd>{task.workspace?.kind === 'worktree' ? '独立工作副本' : task.workspace?.kind === 'copy' ? '独立副本（快照）' : '项目目录（旧任务）'}</dd><dt>项目</dt><dd>{project?.name ?? '未报告'}</dd>
    <dt>文件夹</dt><dd className="mono">{task.workspace?.path ?? (task.workspace?.kind === 'copy' || task.workspace?.kind === 'worktree' ? '尚未准备好' : project?.path ?? '未报告')}</dd>
    {task.workspace?.branch ? <><dt>分支</dt><dd className="mono">{task.workspace.branch}</dd></> : null}
    {task.workspace?.baseBranch ? <><dt>基于分支</dt><dd>{task.workspace.baseBranch}</dd></> : null}
    {profileName ? <><dt>账号</dt><dd>{profileName}</dd></> : null}
    <dt>权限</dt><dd>{permInfo[task.permission].label}</dd><dt>工作区</dt><dd>{task.workspace?.state === 'failed' ? task.workspace.error ?? '准备失败' : task.workspace?.kind === 'worktree' || task.workspace?.kind === 'copy' ? '原项目文件保持不变，确认合并或应用后才更新' : '直接在项目目录运行，建议保持需审批'}</dd>
  </dl>{task.workspace?.state === 'confirmation_required' ? <button type="button" className="btn primary" disabled={busy} onClick={() => { setBusy(true); void confirmWorkspaceCopy(task).catch(toastErrorOf).finally(() => setBusy(false)); }}>确认复制并继续</button> : null}
  {task.workspace?.largeFiles?.length ? <p className="d-note">以下大于 50 MB 的文件不进入快照，不能依靠快照回滚：{task.workspace.largeFiles.join('、')}</p> : null}
  <button type="button" className="detail-link" disabled={!project || busy || saved.length >= 50} onClick={() => void save()}>存为常用</button>
    {saved.filter((x) => x.projectId === task.projectId).length ? <ul className="d-list">{saved.filter((x) => x.projectId === task.projectId).map((x) => <li key={x.id}><span className="t" title={x.name}>{x.name}</span><button type="button" className="detail-link" disabled={busy} aria-label={`移除常用环境 ${x.name}`} onClick={() => void remove(x.id)}>移除</button></li>)}</ul> : null}
    <p className="d-note">常用环境只记录项目与分支，不会切换分支。</p></>;
}
