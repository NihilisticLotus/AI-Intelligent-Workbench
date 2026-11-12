// 应用外壳：启动状态（载入 / 配对 / 就绪）、侧栏 + 主区 + 右侧面板、全局快捷键。
import { useEffect, useMemo, useRef, useState } from 'react';
import { FeatureKey } from '@aic/protocol';
import { boot, useApp } from './state/app';
import { prefsStore, setPref, usePref } from './state/prefs';
import { navigate, newTaskReturnStore, routeHash, routeStore } from './state/ui';
import { useStore } from './state/store';
import { Sidebar } from './components/Sidebar';
import { TaskView } from './components/TaskView';
import { Announcer, DialogHost, ErrorAlerts, ErrorNotice, MenuHost, Toasts } from './components/ui';
import { openPalette } from './components/Palette';
import { openNewTask } from './components/dialogs';
import { requestFocusApproval } from './components/focus';
import { AgentsPage } from './pages/AgentsPage';
import { SettingsPage } from './pages/SettingsPage';
import { PairingPage } from './pages/PairingPage';
import { NewTaskPage } from './pages/new-task-page';
import { Icon } from './components/Icon';

export function App() {
  const bootState = useApp((s) => s.boot);
  const bootError = useApp((s) => s.bootError);
  useEffect(() => { void boot(); }, []);

  return (
    <>
      {bootState === 'loading' ? <div className="boot" role="status">正在连接 AI Console…</div> : null}
      {bootState === 'unpaired' ? <PairingPage /> : null}
      {bootState === 'error' && bootError ? (
        <div className="pair-page"><div className="pair-card">
          <h1>打不开工作台</h1>
          <ErrorNotice error={bootError} onRetry={() => void boot()} />
          <div className="row"><button type="button" className="btn primary" onClick={() => void boot()}>重试</button></div>
        </div></div>
      ) : null}
      {bootState === 'ready' ? <Shell /> : null}
      <DialogHost />
      <MenuHost />
      <ErrorAlerts />
      <Toasts />
      <Announcer />
    </>
  );
}

function Shell() {
  const route = useStore(routeStore, (r) => r);
  const returnRoute = useStore(newTaskReturnStore, (r) => r);
  const pageRoute = route.page === 'new' ? returnRoute : route;
  const previousPage = useRef(route.page);
  const sbCollapsed = usePref('sidebarCollapsed');
  const sideOpen = usePref('sideOpen');
  const sideWidth = usePref('sideWidth');
  const approvals = useApp((s) => s.approvals);
  const tasks = useApp((s) => s.tasks);
  const pending = useMemo(() => Object.values(approvals).filter((a) => a.status === 'pending').sort((a, b) => a.createdAt - b.createdAt), [approvals]);
  // 窄屏（<768px）：侧栏改成抽屉，由底部导航的“任务列表”打开；换页面（点了某个任务）后自动收起
  const [drawer, setDrawer] = useState(false);
  useEffect(() => { setDrawer(false); }, [route]);
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('dialog[open], .popover, .menu')) setDrawer(false); };
    const mq = matchMedia('(min-width: 768px)');
    const onWide = () => { if (mq.matches) setDrawer(false); };
    document.addEventListener('keydown', onKey);
    mq.addEventListener('change', onWide);
    return () => { document.removeEventListener('keydown', onKey); mq.removeEventListener('change', onWide); };
  }, [drawer]);

  // 首页：有任务时打开最近活动的那个
  useEffect(() => {
    const from = previousPage.current; previousPage.current = route.page;
    if (route.page !== 'home') return;
    // 派发返回空首页时不自动跳进刚创建的任务。
    if (from === 'new') return;
    const recent = Object.values(tasks).sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
    if (recent) navigate({ page: 'task', taskId: recent.id });
  }, [route.page]); // eslint-disable-line react-hooks/exhaustive-deps

  // 全局快捷键（ui-design.md 8.2）。Ctrl+N 会被浏览器拦截，网页端用 Alt+N
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) return;
      const k = e.key.toLowerCase();
      if (e.ctrlKey && !e.shiftKey && !e.altKey && k === 'k') { e.preventDefault(); openPalette(); }
      else if (e.altKey && !e.ctrlKey && k === 'n') { e.preventDefault(); openNewTask(); }
      else if (e.ctrlKey && !e.shiftKey && k === 'b') { e.preventDefault(); setPref('sidebarCollapsed', !prefsStore.get().sidebarCollapsed); }
      else if (e.ctrlKey && !e.shiftKey && k === 'j') { e.preventDefault(); setPref('sideOpen', !prefsStore.get().sideOpen); }
      else if (e.ctrlKey && e.shiftKey && k === 'a') {
        e.preventDefault();
        // 跳到下一个待审批：当前聚焦的之后那一个，没有就回到第一个
        const curId = (document.activeElement as HTMLElement | null)?.id?.replace(/^ap-/, '');
        const i = pending.findIndex((a) => a.id === curId);
        const next = pending[(i + 1) % Math.max(1, pending.length)];
        if (next) { navigate({ page: 'task', taskId: next.taskId }); requestFocusApproval(next.id); }
      } else if (e.key === 'Escape' && routeStore.get().page !== 'new' && matchMedia('(max-width: 1279px)').matches && prefsStore.get().sideOpen && !document.querySelector('.popover, .menu')) {
        setPref('sideOpen', false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [pending]);

  const showSide = route.page === 'task' && sideOpen;
  return (
    <div className={'app' + (sbCollapsed && !drawer ? ' sb-collapsed' : '') + (drawer ? ' sb-drawer' : '')} data-side={showSide ? 'open' : 'closed'}
      style={{ ['--side-w' as string]: sideWidth + 'px' }}>
      <Sidebar onSearch={openPalette} />
      <button type="button" className="sb-scrim" aria-label="关闭任务列表" tabIndex={-1} onClick={() => setDrawer(false)} />
      <div className="route-surface" hidden={route.page === 'new'}>
      {pageRoute.page === 'task' ? <TaskView key={pageRoute.taskId} taskId={pageRoute.taskId} active={route.page !== 'new'} /> : null}
      {pageRoute.page === 'agents' ? <AgentsPage /> : null}
      {pageRoute.page === 'settings' ? <SettingsPage /> : null}
      {pageRoute.page === 'home' ? <Home /> : null}
      {pageRoute.page === 'feature' ? (
        <main className="main"><div className="content-scroll"><div className="page">
          <div className="empty"><h3>这个页面还没有开放</h3><p>它会在后续阶段提供。</p></div>
        </div></div></main>
      ) : null}
      </div>
      {route.page === 'new' ? <NewTaskPage key={routeHash(route)} preset={route.preset} /> : null}
      <BottomNav pendingCount={pending.length} drawerOpen={drawer} onToggleDrawer={() => setDrawer((v) => !v)} />
    </div>
  );
}

/** 以后的页面：按 /hello 的功能开关出现在底部导航里（和侧栏一致） */
const featureNav: Array<[key: string, label: string, icon: string]> = [
  [FeatureKey.PageAssets, '资产', 'cube'],
  [FeatureKey.PageGenerate, '生成', 'wand'],
  [FeatureKey.PageAutomations, '自动化', 'auto'],
  [FeatureKey.PageMonitor, '监控', 'chart'],
  [FeatureKey.PageCapabilities, '能力', 'plug'],
];

/** 窄屏底部导航（ui-design.md 8.1）：只在窄于 768px 时显示（CSS 控制），每项 48px，“任务”带待处理徽标 */
function BottomNav({ pendingCount, drawerOpen, onToggleDrawer }: { pendingCount: number; drawerOpen: boolean; onToggleDrawer: () => void }) {
  const route = useStore(routeStore, (r) => r);
  const hello = useApp((s) => s.hello);
  const onTasks = route.page === 'home' || route.page === 'task' || route.page === 'new';
  return (
    <nav className="bottomnav" aria-label="主导航">
      <a href="#/" aria-current={onTasks && !drawerOpen ? 'page' : undefined}
        aria-label={pendingCount ? `任务，${pendingCount} 项等你处理` : '任务'} title="任务">
        <Icon name="chat" />{pendingCount ? <span className="badge" aria-hidden="true">{pendingCount}</span> : null}
      </a>
      <button type="button" aria-label="任务列表" title="任务列表" aria-expanded={drawerOpen} onClick={onToggleDrawer}>
        <Icon name="sidebar" />
      </button>
      {featureNav.filter(([k]) => hello?.features[k]).map(([k, label, ic]) => (
        <a key={k} href={'#/p/' + encodeURIComponent(k)} aria-label={label} title={label}
          aria-current={route.page === 'feature' && route.key === k ? 'page' : undefined}><Icon name={ic} /></a>
      ))}
      <a href="#/agents" aria-label="Agent" title="Agent" aria-current={route.page === 'agents' ? 'page' : undefined}><Icon name="bot" /></a>
      <a href="#/settings" aria-label="设置" title="设置" aria-current={route.page === 'settings' ? 'page' : undefined}><Icon name="gear" /></a>
    </nav>
  );
}

function Home() {
  const projects = useApp((s) => s.projects);
  return (
    <main className="main">
      <header className="main-head"><h1>任务</h1></header>
      <div className="content-scroll">
        <div className="empty" style={{ paddingTop: '18vh' }}>
          <h3>还没有任务</h3>
          <p>{projects.length ? '描述你想完成的事，选一个 Agent 派发出去。' : '先添加一个项目文件夹，再描述你想完成的事，选一个 Agent 派发出去。'}</p>
          <button type="button" className="btn primary" onClick={() => openNewTask()}><Icon name="plus" />新建任务</button>
        </div>
      </div>
    </main>
  );
}
