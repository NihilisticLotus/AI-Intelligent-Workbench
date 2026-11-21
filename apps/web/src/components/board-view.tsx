import { useEffect, useState } from 'react';
import type { ApiError, Approval, Task, WorkspaceChanges } from '@aic/protocol';
import { api, approve, loadHistory, putTask, useApp } from '../state/app';
import { setPref, usePref } from '../state/prefs';
import { navigate } from '../state/ui';
import { blockingError } from '../state/core';
import { agentFallback, permInfo, taskStatusLabel } from '../lib/format';
import { boardColumn, boardColumns, boardIndependentError, queueKeyPosition, sameQueue, sortBoardTasks } from '../lib/board';
import { lastSeq } from '../lib/details';
import { ApprovalCard, TaskError } from './Chat';
import { ChangesPanel } from './ChangesPanel';
import { Resizer } from './SidePanel';
import { AgentBadge, Dialog, openDialog, asApiError, toastErrorOf } from './ui';
import { WorkViewSwitch } from './work-view-switch';
import { useNow } from './hooks';
import { Icon } from './Icon';

function openChat(task: Task) { setPref('workView', 'chat'); navigate({ page: 'task', taskId: task.id }); }
function inspectApproval(task: Task, approval: Approval) {
  openDialog(close => <Dialog title="查看审批" onClose={close}><ApprovalCard task={task} approval={approval} resolvedInLog={null} /></Dialog>);
}
function useChanges(task: Task, enabled: boolean, poll = false) {
  const revision = useApp(s => lastSeq(s.logs[task.id], 'task.changes_updated')), conn = useApp(s => s.conn);
  const [changes, setChanges] = useState<WorkspaceChanges | null>(null), [error, setError] = useState<string | null>(null), [reload, setReload] = useState(0);
  useEffect(() => {
    setChanges(null); setError(null);
    if (!enabled || !['worktree', 'copy'].includes(task.workspace?.kind ?? '') || task.workspace?.state !== 'ready') return;
    let live = true, reading = false;
    const read = async () => {
      if (reading) return; reading = true;
      try { const value = await api.taskChanges(task.id); if (live) { setChanges(previous => JSON.stringify(previous) === JSON.stringify(value) ? previous : value); setError(null); } }
      catch (e) { if (live) setError(asApiError(e).message); } finally { reading = false; }
    };
    void read(); const timer = poll ? setInterval(() => void read(), 3000) : null;
    return () => { live = false; if (timer) clearInterval(timer); };
  }, [task.id, task.status, task.workspace?.kind, task.workspace?.state, enabled, revision, conn, reload, poll]);
  return { changes, error, refresh: () => setReload(n => n + 1) };
}

export function BoardView({ taskId }: { taskId?: string }) {
  const tasks = useApp(s => s.tasks), projects = useApp(s => s.projects), groups = useApp(s => s.groups), agents = useApp(s => s.agents);
  const view = usePref('sbView'), projectFilter = usePref('boardProject'), groupFilter = usePref('boardGroup'), sideOpen = usePref('sideOpen');
  const now = useNow(1000), [dragged, setDragged] = useState<string | null>(null), [moving, setMoving] = useState(false);
  const filter = view === 'project' ? projectFilter : groupFilter;
  const choices = view === 'project' ? projects : groups;
  const validFilter = filter === 'none' && view === 'group' || choices.some(item => item.id === filter) ? filter : '';
  const visible = Object.values(tasks).filter(task => !validFilter || (view === 'project' ? task.projectId === validFilter : validFilter === 'none' ? task.groupId === null : task.groupId === validFilter));
  const selected = taskId ? tasks[taskId] : undefined;
  async function move(task: Task, position: number) {
    if (moving) return; setMoving(true);
    try { putTask(await api.moveTaskQueue(task.id, position)); }
    catch (e) { toastErrorOf(e); } finally { setMoving(false); setDragged(null); }
  }
  return <><main className="main board-main">
    <header className="main-head"><WorkViewSwitch /><h1>任务看板</h1><span className="grow" />
      <div className="board-capacity" aria-label="Agent 并发占用">{agents.filter(a => a.enabled !== false).map(agent => <span key={agent.kind} title={agent.concurrencyLimit ? '运行会话 / 并发上限' : '当前运行任务数'}>{agent.displayName} <b>{agent.runningSessions ?? Object.values(tasks).filter(t => t.agent === agent.kind && ['running', 'waiting'].includes(t.status)).length}{agent.concurrencyLimit ? `/${agent.concurrencyLimit}` : ''}</b></span>)}</div>
      {selected ? <button type="button" className="btn ghost icon" aria-label={sideOpen ? '收起右侧面板' : '显示右侧面板'} onClick={() => setPref('sideOpen', !sideOpen)}><Icon name="panel" /></button> : null}
    </header>
    <div className="board-toolbar"><div className="work-view-switch" role="group" aria-label="看板归类"><button type="button" aria-pressed={view === 'project'} onClick={() => setPref('sbView', 'project')}>按项目</button><button type="button" aria-pressed={view === 'group'} onClick={() => setPref('sbView', 'group')}>按分组</button></div>
      <label>筛选<select className="input" aria-label={view === 'project' ? '筛选项目' : '筛选分组'} value={validFilter} onChange={e => setPref(view === 'project' ? 'boardProject' : 'boardGroup', e.target.value)}><option value="">全部{view === 'project' ? '项目' : '分组'}</option>{view === 'group' ? <option value="none">未分组</option> : null}{choices.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <span className="board-help">排队卡片可拖动或按 Alt＋↑ / ↓；仅在同一等待队列内调序。</span>
    </div>
    {visible.some(task => task.status === 'draft') ? <p className="board-drafts">另有 {visible.filter(task => task.status === 'draft').length} 个未派发草稿，可从左侧任务列表打开。</p> : null}
    <div className="board-scroll" tabIndex={0} aria-label="六列任务看板">
      {boardColumns.map(([column, label]) => { const items = visible.filter(task => boardColumn(task, now) === column).sort(sortBoardTasks); return <section className={'board-column column-' + column} key={column} aria-label={label}>
        <h2>{label}<span>{items.length}</span></h2>
        <div className="board-cards">{items.map(task => <BoardCard key={task.id} task={task} now={now} selected={task.id === taskId} moving={moving} onMove={position => void move(task, position)}
          onSelect={() => { navigate({ page: 'task', taskId: task.id }); setPref('sideOpen', true); }}
          onDrag={() => setDragged(task.id)} onDragEnd={() => setDragged(null)} canDrop={!!dragged && !!tasks[dragged] && sameQueue(tasks[dragged]!, task)}
          onPointerDrop={targetId => { const target = tasks[targetId]; if (target && sameQueue(task, target)) void move(task, target.queue!.position); else setDragged(null); }}
          onDrop={() => { const from = dragged ? tasks[dragged] : undefined; if (from && sameQueue(from, task)) void move(from, task.queue!.position); }} />)}
          {!items.length ? <p className="board-empty">暂无任务</p> : null}</div>
      </section>; })}
    </div>
  </main>{selected && sideOpen ? <><Resizer /><BoardDetails key={selected.id} task={selected} /></> : null}</>;
}

function BoardCard({ task, now, selected, moving, onMove, onSelect, onDrag, onDragEnd, canDrop, onDrop, onPointerDrop }: {
  task: Task; now: number; selected: boolean; moving: boolean; onMove: (position: number) => void;
  onSelect: () => void; onDrag: () => void; onDragEnd: () => void; canDrop: boolean; onDrop: () => void;
  onPointerDrop: (targetId: string) => void;
}) {
  const approvals = useApp(s => s.approvals), projects = useApp(s => s.projects), conn = useApp(s => s.conn);
  const log = useApp(s => s.logs[task.id]), history = useApp(s => s.history[task.id]);
  const [busy, setBusy] = useState(false), failed = ['failed', 'interrupted', 'paused'].includes(task.status);
  const [independentError, setIndependentError] = useState<ApiError | null>(null);
  const independentRevision = useApp(s => lastSeq(s.logs[task.id], 'independent.task_changed'));
  const actual = useChanges(task, task.status === 'review');
  const pending = Object.values(approvals).filter(a => a.taskId === task.id && a.status === 'pending').sort((a, b) => a.createdAt - b.createdAt);
  const approval = pending[0], allow = approval?.options.find(o => o.kind === 'allow_once');
  useEffect(() => { if (failed) void loadHistory(task.id).catch(toastErrorOf); }, [task.id, failed]);
  useEffect(() => {
    setIndependentError(null); if (!failed || task.agent !== 'independent') return;
    let live = true; void api.independentTask(task.id).then(state => { if (live) setIndependentError(boardIndependentError(state)); }).catch(e => { if (live) setIndependentError(asApiError(e)); });
    return () => { live = false; };
  }, [task.id, task.agent, task.status, failed, independentRevision]);
  const error = (failed && log ? blockingError(task, log)?.data.error : null) ?? independentError;
  const queue = task.status === 'queued' ? task.queue : undefined;
  async function allowOnce() {
    if (!approval || !allow || busy) return;
    if (approval.independentToolId) { inspectApproval(task, approval); return; }
    setBusy(true); try { await approve(approval.id, allow.id); } catch (e) { toastErrorOf(e); } finally { setBusy(false); }
  }
  return <article className={'board-card' + (selected ? ' selected' : '') + (canDrop ? ' drop-target' : '')} tabIndex={0} aria-label={task.title} data-board-task={task.id}
    onClick={e => { if (!(e.target as HTMLElement).closest('button, a, input, select, textarea')) onSelect(); }}
    draggable={!!queue && !moving} onDragStart={e => { if (!queue) { e.preventDefault(); return; } e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', task.id); onDrag(); }} onDragEnd={onDragEnd}
    onDragOver={e => { if (canDrop) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } }} onDrop={e => { e.preventDefault(); if (canDrop) onDrop(); }}
    onKeyDown={e => { if (e.target !== e.currentTarget) return; const position = queueKeyPosition(task, e.key, e.altKey); if (position !== null) { e.preventDefault(); onMove(position); } else if (e.key === 'Enter') { e.preventDefault(); onSelect(); } }}>
    {queue ? <span className="board-drag-handle" aria-hidden="true" title="拖动调整同队列顺序" onClick={e => e.stopPropagation()}
      onPointerDown={e => { if (e.button !== 0 || moving) return; e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); onDrag(); }}
      onPointerUp={e => { if (!e.currentTarget.hasPointerCapture(e.pointerId)) return; e.currentTarget.releasePointerCapture(e.pointerId); const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-board-task]')?.getAttribute('data-board-task'); if (target) onPointerDrop(target); else onDragEnd(); }} onPointerCancel={onDragEnd}>⠿</span> : null}<button type="button" className="board-card-title" title={task.title} onClick={onSelect}>{task.title}</button>
    <p className="board-card-meta"><AgentBadge kind={task.agent} /> {projects.find(p => p.id === task.projectId)?.name ?? '项目已移除'} · {agentFallback[task.agent].name}</p>
    {task.status === 'queued' ? <><p>{queue ? `第 ${queue.position} 位，${queue.scope === 'project' ? '等同项目任务结束' : `等 ${agentFallback[task.agent].name} 空位`}` : '正在准备排队信息…'}</p>{queue ? <div className="board-card-actions"><button type="button" className="btn ghost sm" aria-label={`上移 ${task.title}`} disabled={moving || queue.position === 1} onClick={() => onMove(queue.position - 1)}>↑ 上移</button><button type="button" className="btn ghost sm" aria-label={`下移 ${task.title}`} disabled={moving || queue.position === queue.total} onClick={() => onMove(queue.position + 1)}>↓ 下移</button></div> : null}</> : null}
    {task.status === 'running' ? <p><span className="board-elapsed">{task.activity ? `已用 ${Math.max(0, Math.floor((now - task.activity.startedAt) / 1000))} 秒` : '用时未报告'}</span><br />{task.activity?.action ?? '正在运行'}</p> : null}
    {task.status === 'waiting' ? approval ? <><p className="board-approval-title">{approval.title}</p><div className="board-card-actions"><button type="button" className="btn attn sm" disabled={busy || !allow || !['online', 'replaying'].includes(conn)} onClick={() => void allowOnce()}>允许</button><button type="button" className="btn ghost sm" onClick={() => inspectApproval(task, approval)}>查看{pending.length > 1 ? `（${pending.length} 项）` : ''}</button></div></> : <p>正在同步审批…</p> : null}
    {task.status === 'review' ? <p title={actual.error ?? '工作副本的实际改动'}>{actual.error ? '改动读取失败，请打开改动面板重试' : <><b className="stat-add">+{actual.changes?.added ?? '—'}</b> <b className="stat-del">−{actual.changes?.removed ?? '—'}</b><span className="board-card-meta"> · {actual.changes ? `${actual.changes.files.length} 个文件` : '正在读取改动'}</span></>}</p> : null}
    {failed ? <>{error ? <TaskError task={task} error={error} compact beforeAction={() => openChat(task)} /> : <p>{history === 'error' ? '错误详情读取失败' : task.workspace?.error ?? (task.status === 'paused' ? '任务已暂停' : '本轮未完成')}</p>}<button type="button" className="btn sm" onClick={() => openChat(task)}>恢复对话</button></> : null}
    {boardColumn(task, now) === 'done' ? <p className="board-done-label">{task.workspace?.operation?.state === 'rolled_back' ? '已回滚' : taskStatusLabel(task)[0]}</p> : null}
  </article>;
}

function BoardDetails({ task }: { task: Task }) {
  const tab = usePref('boardTab'), projects = useApp(s => s.projects), actual = useChanges(task, true, tab === 'diff');
  return <aside className="side" aria-label="看板任务详情"><div className="side-head"><div className="tabs" role="tablist" aria-label="看板详情" onKeyDown={e => { if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return; e.preventDefault(); const next = tab === 'summary' ? 'diff' : 'summary'; setPref('boardTab', next); document.getElementById('board-tab-' + next)?.focus(); }}>
    {(['summary', 'diff'] as const).map(key => <button type="button" role="tab" id={'board-tab-' + key} aria-controls="board-detail-content" tabIndex={tab === key ? 0 : -1} aria-selected={tab === key} key={key} onClick={() => setPref('boardTab', key)}>{key === 'summary' ? '摘要' : '改动'}</button>)}
  </div><span className="grow" /><button type="button" className="btn ghost icon sm" aria-label="收起右侧面板" onClick={() => setPref('sideOpen', false)}><Icon name="x" /></button></div>
    <div id="board-detail-content" className={'side-body' + (tab === 'summary' ? ' pane-pad board-summary' : '')} role="tabpanel" aria-labelledby={'board-tab-' + tab}>{tab === 'summary' ? <><h2>{task.title}</h2><dl className="facts"><dt>状态</dt><dd>{taskStatusLabel(task)[0]}</dd><dt>项目</dt><dd>{projects.find(p => p.id === task.projectId)?.name ?? '项目已移除'}</dd><dt>Agent</dt><dd>{agentFallback[task.agent].name}</dd><dt>权限</dt><dd>{permInfo[task.permission].label}</dd>{task.workspace?.branch ? <><dt>任务分支</dt><dd className="mono">{task.workspace.branch}</dd></> : null}</dl><p className="board-prompt">{task.prompt}</p><button type="button" className="btn primary" onClick={() => openChat(task)}>打开对话</button></> : <ChangesPanel key={task.id} task={task} {...actual} />}</div>
  </aside>;
}
