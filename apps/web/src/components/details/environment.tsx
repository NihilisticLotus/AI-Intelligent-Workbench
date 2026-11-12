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
    <dt>运行位置</dt><dd>本机</dd><dt>项目</dt><dd>{project?.name ?? '未报告'}</dd>
    <dt>文件夹</dt><dd className="mono">{project?.path ?? '未报告'}</dd>
    {project?.branch ? <><dt>分支</dt><dd>{project.branch}</dd></> : null}
    {profileName ? <><dt>账号</dt><dd>{profileName}</dd></> : null}
    <dt>权限</dt><dd>{permInfo[task.permission].label}</dd><dt>工作区</dt><dd>项目目录；工作副本在之后的版本提供</dd>
  </dl><button type="button" className="detail-link" disabled={!project || busy || saved.length >= 50} onClick={() => void save()}>存为常用</button>
    {saved.filter((x) => x.projectId === task.projectId).length ? <ul className="d-list">{saved.filter((x) => x.projectId === task.projectId).map((x) => <li key={x.id}><span className="t" title={x.name}>{x.name}</span><button type="button" className="detail-link" disabled={busy} aria-label={`移除常用环境 ${x.name}`} onClick={() => void remove(x.id)}>移除</button></li>)}</ul> : null}
    <p className="d-note">常用环境只记录项目与分支，不会切换分支。</p></>;
}
