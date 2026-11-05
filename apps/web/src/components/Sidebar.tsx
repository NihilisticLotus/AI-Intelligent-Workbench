// 侧栏：品牌、新建任务、等你处理、搜索、导航、项目 / 分组列表、连接状态与主题切换。
import { useMemo, useState, type DragEvent } from 'react';
import { FeatureKey, type Group, type Project, type Task } from '@aic/protocol';
import { Icon } from './Icon';
import { AgentBadge, StatusMark, confirmDialog, nameDialog, openMenu, toastErrorOf, useAgentName } from './ui';
import { createGroup, deleteGroup, patchTask, removeProject, renameGroup, renameProject, useApp } from '../state/app';
import { setPref, usePref } from '../state/prefs';
import { navigate, routeStore, toast, type Route } from '../state/ui';
import { useStore } from '../state/store';
import { ago, taskStatusText } from '../lib/format';
import { openAddProject, openNewTask } from './dialogs';
import { requestFocusApproval } from './focus';

/** 以后的页面：按 /hello 的功能开关显示，现在都关 */
const featurePages: Array<[key: string, label: string, icon: string]> = [
  [FeatureKey.PageAssets, '资产', 'cube'],
  [FeatureKey.PageGenerate, '生成', 'wand'],
  [FeatureKey.PageAutomations, '自动化', 'auto'],
  [FeatureKey.PageMonitor, '监控', 'chart'],
  [FeatureKey.PageCapabilities, '能力', 'plug'],
];

const PER_SECTION = 8;

export function Sidebar({ onSearch }: { onSearch: () => void }) {
  const route = useStore(routeStore, (r) => r);
  const tasks = useApp((s) => s.tasks);
  const projects = useApp((s) => s.projects);
  const groups = useApp((s) => s.groups);
  const approvals = useApp((s) => s.approvals);
  const hello = useApp((s) => s.hello);
  const conn = useApp((s) => s.conn);
  const view = usePref('sbView');
  const collapsed = usePref('collapsed');
  const theme = usePref('theme');
  const sbCollapsed = usePref('sidebarCollapsed');

  const pending = useMemo(() => Object.values(approvals).filter((a) => a.status === 'pending').sort((a, b) => a.createdAt - b.createdAt), [approvals]);
  const taskList = useMemo(() => Object.values(tasks).sort((a, b) => b.lastActivityAt - a.lastActivityAt), [tasks]);

  const sections = useMemo(() => {
    if (view === 'project') {
      return projects.map((p) => ({ key: 'p:' + p.id, kind: 'proj' as const, name: p.name, project: p, group: null as Group | null, list: taskList.filter((t) => t.projectId === p.id), empty: '还没有任务' }));
    }
    const ids = new Set(groups.map((g) => g.id));
    const sorted = [...groups].sort((a, b) => a.ord - b.ord);
    return [
      ...sorted.map((g) => ({ key: 'g:' + g.id, kind: 'group' as const, name: g.name, project: null as Project | null, group: g, list: taskList.filter((t) => t.groupId === g.id), empty: '把任务拖到这里，或用任务的“…”菜单移入' })),
      { key: 'g:none', kind: 'none' as const, name: '未分类', project: null, group: null, list: taskList.filter((t) => !t.groupId || !ids.has(t.groupId)), empty: '所有任务都已分组' },
    ];
  }, [view, projects, groups, taskList]);

  const toggle = (key: string) => setPref('collapsed', collapsed.includes(key) ? collapsed.filter((k) => k !== key) : [...collapsed, key]);
  const anyOpen = sections.some((s) => !collapsed.includes(s.key));
  const toggleAll = () => {
    const keys = sections.map((s) => s.key);
    setPref('collapsed', anyOpen ? [...new Set([...collapsed, ...keys])] : collapsed.filter((k) => !keys.includes(k)));
  };
  const goPending = () => {
    const a = pending[0];
    if (!a) return;
    navigate({ page: 'task', taskId: a.taskId });
    requestFocusApproval(a.id);
  };
  const addSection = () => {
    if (view === 'project') openAddProject();
    else nameDialog({ title: '新建分组', label: '分组名称', ok: '创建', placeholder: '例如：本周上线、美术资源、Bug 修复',
      hint: '分组和项目无关：不同项目的任务可以放进同一个分组。一个任务只能在一个分组里。',
      onSave: async (v) => { await createGroup(v); toast(`已创建分组“${v}”`); } });
  };

  const isCur = (r: Route['page']) => route.page === r;
  const onlineText = conn === 'online' ? '服务运行中，仅本机访问' : conn === 'replaying' ? '正在同步…' : conn === 'connecting' || conn === 'idle' ? '正在连接…' : '正在重新连接…';
  const night = theme !== 'light';
  const themeTip = night ? '夜间模式（点击切换到日间模式）' : '日间模式（点击切换到夜间模式）';

  return (
    <aside className="sidebar" aria-label="侧栏">
      <div className="sb-top">
        <span className="brand"><span className="brand-mark" aria-hidden="true">AI</span><span className="brand-name">AI Console</span></span>
        <span className="grow" />
        <button type="button" className="btn ghost icon sm" aria-label="折叠或展开侧栏" title="折叠侧栏 Ctrl+B" onClick={() => setPref('sidebarCollapsed', !sbCollapsed)}><Icon name="sidebar" /></button>
      </div>
      <button type="button" className="btn primary sb-new" aria-label="新建任务" title="新建任务 Alt+N" onClick={() => openNewTask()}>
        <Icon name="plus" /><span className="sb-label">新建任务</span><kbd>Alt N</kbd>
      </button>
      <button type="button" className={'sb-item' + (pending.length ? ' attn' : '')} onClick={goPending}
        aria-label={pending.length ? `等你处理：${pending.length} 项` : '等你处理：没有'} aria-disabled={!pending.length}
        title={pending.length ? '跳到下一个待审批 Ctrl+Shift+A' : '现在没有要你处理的事'}>
        <Icon name="shield" /><span className="sb-label">等你处理</span>
        {pending.length ? <span className="badge">{pending.length}</span> : null}
      </button>
      <button type="button" className="sb-item" aria-label="搜索任务" title="搜索 Ctrl+K" onClick={onSearch}>
        <Icon name="search" /><span className="sb-label">搜索</span><kbd style={{ marginLeft: 'auto' }}>Ctrl K</kbd>
      </button>
      <nav aria-label="页面">
        <a className="sb-item" href="#/" aria-current={isCur('home') || isCur('task') ? 'page' : undefined} aria-label="任务"><Icon name="chat" /><span className="sb-label">任务</span></a>
        {featurePages.filter(([k]) => hello?.features[k]).map(([k, label, ic]) => (
          <a key={k} className="sb-item" href={'#/p/' + encodeURIComponent(k)} aria-label={label}
            aria-current={route.page === 'feature' && route.key === k ? 'page' : undefined}><Icon name={ic} /><span className="sb-label">{label}</span></a>
        ))}
        <a className="sb-item" href="#/agents" aria-current={isCur('agents') ? 'page' : undefined} aria-label="Agent"><Icon name="bot" /><span className="sb-label">Agent</span></a>
        <a className="sb-item" href="#/settings" aria-current={isCur('settings') ? 'page' : undefined} aria-label="设置"><Icon name="gear" /><span className="sb-label">设置</span></a>
      </nav>

      <div className="sb-section">
        <div className="seg-mini" role="radiogroup" aria-label="任务的归类方式"
          onKeyDown={(e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); const v = view === 'project' ? 'group' : 'project'; setPref('sbView', v); (e.currentTarget.querySelector(`[data-v="${v}"]`) as HTMLElement | null)?.focus(); } }}>
          <button type="button" role="radio" data-v="project" aria-checked={view === 'project'} tabIndex={view === 'project' ? 0 : -1} onClick={() => setPref('sbView', 'project')}>项目</button>
          <button type="button" role="radio" data-v="group" aria-checked={view === 'group'} tabIndex={view === 'group' ? 0 : -1} onClick={() => setPref('sbView', 'group')}>分组</button>
        </div>
        <span className="grow" />
        <button type="button" className="btn ghost icon xs" aria-label={anyOpen ? '全部折叠' : '全部展开'} title={anyOpen ? '全部折叠' : '全部展开'} onClick={toggleAll}><Icon name="layers" /></button>
        <button type="button" className="btn ghost icon xs" aria-label={view === 'project' ? '添加项目' : '新建分组'} title={view === 'project' ? '添加项目' : '新建分组'} onClick={addSection}><Icon name="plus" /></button>
      </div>

      <div className="projects">
        {view === 'project' && !projects.length ? (
          <div className="proj-empty">还没有项目。点上面的 + 添加一个项目文件夹。</div>
        ) : null}
        {sections.map((sec) => (
          <Section key={sec.key} sec={sec} open={!collapsed.includes(sec.key)} onToggle={() => toggle(sec.key)}
            view={view} projects={projects} groups={groups} currentTaskId={route.page === 'task' ? route.taskId : null} />
        ))}
      </div>

      <div className="sb-foot">
        <span className={'status ' + (conn === 'online' ? 'ok' : 'wait')} title={onlineText} role="status">
          <span className="dot" aria-hidden="true" /><span className="status-text">{onlineText}</span>
        </span>
        <button type="button" className="btn ghost icon sm" aria-label={themeTip} title={themeTip} onClick={() => setPref('theme', night ? 'light' : 'dark')}>
          <Icon name={night ? 'moon' : 'sun'} />
        </button>
      </div>
    </aside>
  );
}

interface Sec {
  key: string; kind: 'proj' | 'group' | 'none'; name: string; project: Project | null; group: Group | null; list: Task[]; empty: string;
}

function Section({ sec, open, onToggle, view, projects, groups, currentTaskId }: {
  sec: Sec; open: boolean; onToggle: () => void; view: 'project' | 'group'; projects: Project[]; groups: Group[]; currentTaskId: string | null;
}) {
  const [showAll, setShowAll] = useState(false);
  const [drop, setDrop] = useState(false);
  const list = showAll ? sec.list : sec.list.slice(0, PER_SECTION);
  const rest = sec.list.length - list.length;
  const icon = sec.kind === 'proj' ? 'folder' : sec.kind === 'group' ? 'layers' : 'grid';

  const menu = (btn: HTMLElement) => {
    if (sec.project) {
      const p = sec.project;
      openMenu(btn, [
        { label: '在这个项目里新建任务', onSelect: () => openNewTask({ projectId: p.id }) },
        { label: '只看这个项目，折叠其他', onSelect: () => setPref('collapsed', projects.map((x) => 'p:' + x.id).filter((k) => k !== sec.key)) },
        { label: '重命名', onSelect: () => nameDialog({ title: '重命名项目', label: '名称', value: p.name, ok: '保存', hint: '只改工作台里的显示名称，不改文件夹名。', onSave: async (v) => { await renameProject(p.id, v); toast(`已重命名为“${v}”`); } }) },
        { label: '从列表中移除…', danger: true, onSelect: async () => {
          const ok = await confirmDialog({ title: `移除“${p.name}”？`, ok: '移除', danger: true,
            body: <><p>只是从工作台的项目列表里移除，<b>不会删除</b>文件夹里的任何文件。</p><p className="mono" style={{ margin: 0, wordBreak: 'break-all' }}>{p.path}</p></> });
          if (!ok) return;
          try { await removeProject(p.id); toast(`已移除“${p.name}”，文件夹没有改动`); } catch (e) { toastErrorOf(e); }
        } },
      ]);
    } else if (sec.group) {
      const g = sec.group;
      openMenu(btn, [
        { label: '在这个分组里新建任务', onSelect: () => openNewTask({ groupId: g.id }) },
        { label: '只看这个分组，折叠其他', onSelect: () => setPref('collapsed', [...groups.map((x) => 'g:' + x.id), 'g:none'].filter((k) => k !== sec.key)) },
        { label: '重命名分组', onSelect: () => nameDialog({ title: '重命名分组', label: '分组名称', value: g.name, ok: '保存', onSave: async (v) => { await renameGroup(g.id, v); toast(`已重命名为“${v}”`); } }) },
        { label: '删除分组…', danger: true, onSelect: async () => {
          const ok = await confirmDialog({ title: `删除分组“${g.name}”？`, ok: '删除分组', danger: true, body: <p style={{ margin: 0 }}>只删除这个分组，里面的任务不会删除，会回到“未分类”。</p> });
          if (!ok) return;
          try { await deleteGroup(g.id); toast(`已删除分组“${g.name}”，任务移到了“未分类”`); } catch (e) { toastErrorOf(e); }
        } },
      ]);
    }
  };

  // 分组视图：把任务拖到另一个分组上即可移动
  const canDrop = view === 'group';
  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    setDrop(false);
    const id = e.dataTransfer.getData('application/x-aic-task');
    if (!id) return;
    const gid = sec.group?.id ?? null;
    try { await patchTask(id, { groupId: gid }); toast(gid ? `已移到分组“${sec.name}”` : '已移到“未分类”'); } catch (err) { toastErrorOf(err); }
  };

  return (
    <section className={'proj' + (drop ? ' drop-target' : '')} aria-label={sec.name}
      onDragOver={canDrop ? (e) => { if (e.dataTransfer.types.includes('application/x-aic-task')) { e.preventDefault(); setDrop(true); } } : undefined}
      onDragLeave={canDrop ? (e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrop(false); } : undefined}
      onDrop={canDrop ? onDrop : undefined}>
      <div className="proj-head">
        <button type="button" className="proj-toggle" aria-expanded={open} onClick={onToggle}
          title={sec.project ? `${sec.project.path}${sec.project.isGit ? '（git 仓库）' : ''}` : undefined}>
          <Icon name="right" className="chev" /><Icon name={icon} className="fold" />
          <span className="pn">{sec.name}</span><span className="count">{sec.list.length}</span>
        </button>
        {sec.kind !== 'none' ? (
          <span className="proj-acts">
            <button type="button" className="btn ghost icon xs" aria-label={`在“${sec.name}”中新建任务`} title="在这里新建任务"
              onClick={() => openNewTask(sec.project ? { projectId: sec.project.id } : { groupId: sec.group?.id ?? null })}><Icon name="plus" /></button>
            <button type="button" className="btn ghost icon xs" aria-label={`“${sec.name}”的更多操作`} title="更多操作" aria-haspopup="menu"
              onClick={(e) => menu(e.currentTarget)}><Icon name="more" /></button>
          </span>
        ) : null}
      </div>
      <ul className="tasks" aria-label={`${sec.name} 的任务`} hidden={!open}>
        {list.length ? list.map((t) => (
          <TaskRow key={t.id} t={t} view={view} current={t.id === currentTaskId} projects={projects} groups={groups} />
        )) : <li className="proj-empty">{sec.empty}</li>}
        {rest > 0 ? <li><button type="button" className="show-more" onClick={() => setShowAll(true)}>显示其余 {rest} 个</button></li> : null}
        {showAll && sec.list.length > PER_SECTION ? <li><button type="button" className="show-more" onClick={() => setShowAll(false)}>只显示最近 {PER_SECTION} 个</button></li> : null}
      </ul>
    </section>
  );
}

function TaskRow({ t, view, current, projects, groups }: { t: Task; view: 'project' | 'group'; current: boolean; projects: Project[]; groups: Group[] }) {
  const agentName = useAgentName(t.agent);
  const [stText, shape] = taskStatusText[t.status];
  const projName = projects.find((p) => p.id === t.projectId)?.name ?? '';
  const menu = (anchor: HTMLElement, at?: { x: number; y: number }) => {
    const curGroup = groups.find((g) => g.id === t.groupId);
    const move = async (gid: string | null, label: string) => {
      try { await patchTask(t.id, { groupId: gid }); toast(label); } catch (e) { toastErrorOf(e); }
    };
    openMenu(anchor, [
      ...groups.filter((g) => g.id !== t.groupId).map((g) => ({ label: `移到分组“${g.name}”`, onSelect: () => void move(g.id, `已移到分组“${g.name}”`) })),
      { label: '新建分组并移入…', onSelect: () => nameDialog({ title: '新建分组', label: '分组名称', ok: '创建并移入', placeholder: '例如：本周上线',
        onSave: async (v) => { const g = await createGroup(v); await patchTask(t.id, { groupId: g.id }); toast(`已创建分组“${v}”，并移入了任务`); } }) },
      ...(curGroup ? [{ label: '移出分组（回到未分类）', onSelect: () => void move(null, '已移到“未分类”') }] : []),
    ], at);
  };
  return (
    <li>
      <button type="button" className="task-row" aria-current={current ? 'true' : undefined}
        title={`${t.title}（${agentName}，${projName}）`}
        draggable={view === 'group'}
        onDragStart={(e) => { e.dataTransfer.setData('application/x-aic-task', t.id); e.dataTransfer.effectAllowed = 'move'; }}
        onClick={() => navigate({ page: 'task', taskId: t.id })}
        onContextMenu={(e) => { e.preventDefault(); menu(e.currentTarget, { x: e.clientX, y: e.clientY }); }}>
        <AgentBadge kind={t.agent} /><span className="t">{t.title}</span>
        <span className="sub">
          <StatusMark shape={shape} text={stText} />
          <span className="who">{view === 'group' ? projName : agentName}</span>
          <span className="when">{ago(t.lastActivityAt)}</span>
        </span>
      </button>
      <button type="button" className="btn ghost icon xs row-more" aria-label={`“${t.title}”的更多操作`} title="移到分组等操作" aria-haspopup="menu"
        onClick={(e) => menu(e.currentTarget)}><Icon name="more" /></button>
    </li>
  );
}
