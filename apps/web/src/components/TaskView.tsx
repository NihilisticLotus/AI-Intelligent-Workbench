// 对话页：头部（标题、状态、项目、面板开关）+ 对话流 + 输入区 + 右侧面板。
import { useEffect, useMemo } from 'react';
import { blockingError, buildTimeline, latestPlan, sessionConfig, type SessionCfg } from '../state/core';
import { isRealAgent } from '../lib/agents';
import { loadHistory, useApp } from '../state/app';
import { setPref, usePref } from '../state/prefs';
import { taskStatusText } from '../lib/format';
import type { EventEnvelope } from '@aic/protocol';
import { Stream } from './Chat';
import { Composer } from './Composer';
import { Resizer, SidePanel } from './SidePanel';
import { ErrorNotice, StatusMark, toastErrorOf } from './ui';
import { Icon } from './Icon';

const EMPTY: EventEnvelope[] = [];

export function TaskView({ taskId }: { taskId: string }) {
  const task = useApp((s) => s.tasks[taskId]);
  const log = useApp((s) => s.logs[taskId] ?? EMPTY);
  const history = useApp((s) => s.history[taskId]);
  const approvals = useApp((s) => s.approvals);
  const project = useApp((s) => (task ? s.projects.find((p) => p.id === task.projectId) : undefined));
  const sideOpen = usePref('sideOpen');

  useEffect(() => { if (task) loadHistory(taskId).catch(toastErrorOf); }, [taskId, !!task]); // eslint-disable-line react-hooks/exhaustive-deps

  const items = useMemo(() => buildTimeline(log), [log]);
  const plan = useMemo(() => latestPlan(log), [log]);
  const config = useMemo<SessionCfg>(() => (task ? sessionConfig(task, log) : { model: null, effort: null }), [task, log]);
  const blocking = useMemo(() => (task ? blockingError(task, log)?.data.error ?? null : null), [task, log]);
  const pending = useMemo(() => Object.values(approvals).filter((a) => a.taskId === taskId && a.status === 'pending').sort((a, b) => a.createdAt - b.createdAt), [approvals, taskId]);

  if (!task) {
    return (
      <main className="main"><div className="content-scroll"><div className="page">
        <ErrorNotice kind="attn" error={{ code: 'resource.not_found', message: '找不到这个任务', hint: '它可能已经被删除，或者属于已移除的项目。从左侧选一个任务继续。', actions: [] }} />
      </div></div></main>
    );
  }
  const [stText, shape] = taskStatusText[task.status];
  return (
    <>
      <main className="main">
        <header className="main-head">
          <h1 title={task.title}>{task.title}</h1>
          <StatusMark shape={shape} text={stText} />
          {project ? <span className="meta hide-narrow" title={project.path}><Icon name="folder" />{project.name}</span> : null}
          <span className="grow" />
          <button type="button" className="btn ghost icon" aria-label={sideOpen ? '收起右侧面板' : '显示右侧面板'} aria-expanded={sideOpen}
            title="右侧面板 Ctrl+J" onClick={() => setPref('sideOpen', !sideOpen)}><Icon name="panel" /></button>
        </header>
        {isRealAgent(task.agent) ? (
          <div className="direct-edit-note" role="note">
            <Icon name={task.permission === 'readonly' ? 'eye' : 'warn'} />
            <span>{task.permission === 'readonly'
              ? '这个任务直接在项目目录里运行。当前是“只读”，Agent 不会修改文件；改成其他权限后会直接修改项目文件，建议用“需审批”。'
              : `会直接修改项目文件：这个任务直接在项目目录里运行；有了独立工作副本后会在副本里修改。建议权限保持“需审批”${task.permission === 'ask' ? '（当前就是）' : ''}。`}</span>
          </div>
        ) : null}
        <div className="main-body">
          <section className="content" aria-label="对话">
            {history === 'error' ? <div style={{ padding: '0 var(--sp-5)' }}><ErrorNotice error={{ code: 'client.history', message: '对话记录没有载入完整', hint: '刷新页面再试一次。', actions: [{ label: '刷新页面', action: 'reload' }] }} /></div> : null}
            <Stream task={task} items={items} loading={history !== 'done'} onOpenPlan={() => { setPref('sideOpen', true); setPref('sideTab', 'plan'); }} />
            <Composer key={task.id} task={task} pending={pending} config={config} blocking={blocking} />
          </section>
        </div>
      </main>
      {sideOpen ? <><Resizer /><SidePanel task={task} plan={plan} config={config} /></> : null}
    </>
  );
}
