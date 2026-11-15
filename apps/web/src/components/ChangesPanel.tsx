import { useEffect, useState } from 'react';
import type { Task, WorkspaceChanges, WorkspaceFileDiff } from '@aic/protocol';
import { api } from '../state/app';
import { useStore } from '../state/store';
import { changeFocus } from '../state/details';
import { asApiError, confirmDialog } from './ui';
import { changeLabels, parseWorkspaceDiff } from '../lib/workspace-diff';

export function ChangesPanel({ task, changes, error, refresh }: { task: Task; changes: WorkspaceChanges | null; error: string | null; refresh: () => void }) {
  const [selected, setSelected] = useState<string | null>(null), [diff, setDiff] = useState<WorkspaceFileDiff | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null), [restoring, setRestoring] = useState(false);
  const focus = useStore(changeFocus, s => s);
  const isolated = ['worktree', 'copy'].includes(task.workspace?.kind ?? '');
  const ready = task.workspace?.state === 'ready';
  const busy = ['running', 'waiting', 'queued', 'merged', 'discarded'].includes(task.status) || restoring;
  useEffect(() => { setSelected(null); setDiff(null); setDiffError(null); }, [task.id]);
  useEffect(() => {
    if (!changes) return;
    if (focus !== null) {
      const target = focus.replaceAll('\\', '/');
      const file = changes.files.find(f => f.path === target || target.endsWith('/' + f.path));
      setSelected(file?.path ?? changes.files[0]?.path ?? null);
      if (!file) setDiffError('该工具报告的文件尚未出现在实际改动中。');
      changeFocus.set(() => null);
    } else if (!selected || !changes.files.some(f => f.path === selected)) setSelected(changes.files[0]?.path ?? null);
  }, [changes, focus, selected]);
  useEffect(() => {
    let live = true; setDiff(null);
    if (!selected || !ready || !isolated) return;
    void api.taskFileDiff(task.id, selected).then(value => { if (live) { setDiff(value); setDiffError(null); } }).catch(e => { if (live) setDiffError(asApiError(e).message); });
    return () => { live = false; };
  }, [task.id, selected, changes, ready, isolated]);
  if (!isolated) return <div className="empty"><h3>旧任务没有独立副本</h3><p>请在“详细 → 输出”查看工具记录。</p></div>;
  if (!ready) return <div className="empty"><h3>工作副本尚未准备好</h3><p>请在“详细 → 环境”查看原因或完成复制确认。</p></div>;
  async function restore() {
    if (!selected || !await confirmDialog({ title: '还原文件', ok: '还原文件', danger: true, body: <><p>将 {selected} 还原到任务开始时的内容；新增文件会从副本中删除。</p><p>该文件在副本中的改动将丢失。原项目文件不受影响。</p></> })) return;
    setRestoring(true);
    try { await api.restoreWorkspaceFile(task.id, selected); setDiffError(null); refresh(); }
    catch (e) { setDiffError(asApiError(e).message); }
    finally { setRestoring(false); }
  }
  const current = changes?.files.find(f => f.path === selected);
  return <div className="changes-panel">
    <div className="changes-heading"><strong>相对 {task.workspace?.kind === 'copy' ? '任务开始前' : task.workspace?.baseBranch ?? '任务基准'} 的全部改动</strong><span><b className="stat-add">+{changes?.added ?? '—'}</b> <b className="stat-del">−{changes?.removed ?? '—'}</b></span><button type="button" className="btn ghost sm" onClick={refresh}>刷新</button></div>
    {task.workspace?.kind === 'copy' ? <p className="d-note changes-note">截至最新快照；每轮结束或还原文件后更新。</p> : null}
    {error ? <p className="changes-note" role="alert">改动读取失败：{error}</p> : null}
    {!changes ? <p className="changes-note" role="status">正在读取实际改动…</p> : !changes.files.length ? <p className="changes-note">工作副本没有改动。</p> : <>
      <ul className="changes-files" aria-label="改动文件">{changes.files.map(f => <li key={f.path}><button type="button" className={selected === f.path ? 'selected' : ''} aria-pressed={selected === f.path} onClick={() => { setSelected(f.path); setDiffError(null); }}>
        <span className={'change-mark change-' + f.status} title={changeLabels[f.status]}>{f.status}</span><span className="change-path">{f.path}<small>{f.oldPath ? `原路径：${f.oldPath}` : changeLabels[f.status]}</small></span>
        <span className="change-stats">{f.tooLarge ? '文件过大' : f.binary ? '二进制' : <><span className="stat-add">+{f.added}</span> <span className="stat-del">−{f.removed}</span></>}</span>
      </button></li>)}</ul>
      {current ? <section className="change-detail" aria-label="文件差异"><div className="change-file-head"><strong>{selected}</strong><button type="button" className="btn sm ghost" disabled={busy || !!error || task.workspace?.largeFiles?.includes(current.oldPath ?? current.path)} onClick={() => void restore()}>{restoring ? '正在还原…' : '还原文件'}</button></div>
        {busy ? <p className="d-note changes-note">{restoring ? '正在还原副本文件…' : '任务运行中或已结束时不能还原文件。'}</p> : null}
        {diffError ? <p className="changes-note" role="alert">{diffError}</p> : !diff ? <p className="changes-note" role="status">正在读取文件差异…</p> : diff.patch === null ? <p className="changes-note">{diff.file.tooLarge ? '文件过大，不显示文本差异' : '二进制文件'} · {diff.file.beforeSize.toLocaleString()} → {diff.file.afterSize.toLocaleString()} 字节</p> : <div className="diff-scroll" tabIndex={0} aria-label="差异内容"><table className="diff-table"><thead><tr><th>原行</th><th>新行</th><th>内容</th></tr></thead><tbody>{parseWorkspaceDiff(diff.patch).map((line, index) => <tr key={index} className={'diff-' + line.kind}><td>{line.oldLine}</td><td>{line.newLine}</td><td><code><span aria-hidden="true">{line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}</span>{line.text}</code></td></tr>)}</tbody></table></div>}
      </section> : null}
    </>}
    <div className="changes-actions"><span className="d-note">合并、应用结果与回滚将在后续阶段接入。</span></div>
  </div>;
}
