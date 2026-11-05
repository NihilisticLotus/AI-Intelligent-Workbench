// AI Console 原型公共脚本：图标、外壳（侧栏、底部导航、右侧面板与拖动条）、主题切换、标签页、弹出层。
// 仅用于原型演示，不代表正式实现。
(function () {
  const P = {
    chat: '<path d="M4 5h16v11H9l-5 4z"/>',
    kanban: '<rect x="3" y="4" width="5" height="16" rx="1"/><rect x="10" y="4" width="5" height="10" rx="1"/><rect x="17" y="4" width="4" height="13" rx="1"/>',
    cube: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>',
    bot: '<rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01"/>',
    project: '<path d="M3 7h6l2 2h10v10H3z"/><circle cx="15" cy="14" r="2"/>',
    devices: '<rect x="3" y="5" width="13" height="10" rx="1"/><path d="M7 19h5"/><rect x="17" y="9" width="4" height="10" rx="1"/>',
    pulse: '<path d="M3 12h4l2-6 4 12 2-6h6"/>',
    gear: '<path d="M10.3 3h3.4l.5 2.4 1.7.9 2.2-1 2.4 2.4-1 2.2.9 1.7 2.4.5v3.4l-2.4.5-.9 1.7 1 2.2-2.4 2.4-2.2-1-1.7.9-.5 2.4h-3.4l-.5-2.4-1.7-.9-2.2 1-2.4-2.4 1-2.2-.9-1.7L3 13.7v-3.4l2.4-.5.9-1.7-1-2.2 2.4-2.4 2.2 1 1.7-.9z"/><circle cx="12" cy="12" r="3"/>',
    moon: '<path d="M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
    down: '<path d="M6 9l6 6 6-6"/>',
    right: '<path d="M9 6l6 6-6 6"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
    terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M12 15h5"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
    eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7v10M18 10c0 5-8 3-11 7"/>',
    merge: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="14" r="2"/><path d="M6 7v10M6 8c0 4 5 6 10 6"/>',
    undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>',
    warn: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h.01"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/>',
    shield: '<path d="M12 3l8 3v6c0 5-4 8-8 9-4-1-8-4-8-9V6z"/>',
    refresh: '<path d="M20 11a8 8 0 00-14.5-4.5L4 8M4 4v4h4M4 13a8 8 0 0014.5 4.5L20 16M20 20v-4h-4"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>',
    clip: '<path d="M20 11l-8.5 8.5a5 5 0 01-7-7L13 4a3.5 3.5 0 015 5l-8.5 8.5a2 2 0 01-3-3L14 7"/>',
    send: '<path d="M4 12l16-8-6 16-2-6z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5"/>',
    pause: '<path d="M9 5v14M15 5v14"/>',
    play: '<path d="M7 5l12 7-12 7z"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
    grid: '<path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
    layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>',
    max: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    swap: '<path d="M4 8h14l-4-4M20 16H6l4 4"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/>',
    download: '<path d="M12 4v11M7 10l5 5 5-5M4 20h16"/>',
    split: '<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M12 4v16"/>',
    drag: '<path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01"/>',
    folder: '<path d="M3 6h6l2 2h10v11H3z"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3"/>',
    sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
    panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
    bulb: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 00-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0012 3z"/>',
    bolt: '<path d="M13 3L5 13h6l-1 8 8-10h-6z"/>',
    shieldcheck: '<path d="M12 3l8 3v6c0 5-4 8-8 9-4-1-8-4-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
    unlock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 017.5-2"/>',
    link: '<path d="M10 14a4 4 0 006 0l3-3a4 4 0 00-6-6l-1 1M14 10a4 4 0 00-6 0l-3 3a4 4 0 006 6l1-1"/>',
    auto: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M9 2h6M19 5l1.5-1.5"/>',
    chart: '<path d="M4 20h16M7 16v-5M12 16V6M17 16v-8"/>',
    gauge: '<path d="M4 17a8 8 0 1116 0"/><path d="M12 17l4-5"/><circle cx="12" cy="17" r="1"/>',
    bell: '<path d="M6 16v-5a6 6 0 0112 0v5l2 2H4z"/><path d="M10 21h4"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
    plug: '<path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 01-12 0zM12 17v4"/>',
    puzzle: '<path d="M4 8h4a2 2 0 114 0h4v4a2 2 0 110 4v4h-4a2 2 0 10-4 0H4v-4a2 2 0 100-4z"/>',
    scan: '<path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4M4 12h16"/>',
    sidechat: '<path d="M3 5h12v8H8l-5 4z"/><path d="M18 9h3v8l-3-2.5h-6V16"/>',
    quote: '<path d="M5 7h5v5c0 3-2 5-5 5M14 7h5v5c0 3-2 5-5 5"/>',
    pin: '<path d="M9 3h6l-1 6 4 4H6l4-4zM12 13v8"/>',
    reply: '<path d="M10 8L5 13l5 5"/><path d="M5 13h9a5 5 0 005-5V5"/>',
    wand: '<path d="M4 20L15 9M13 7l4 4"/><path d="M18 3v3M16.5 4.5h3M7 4v2M6 5h2M20 13v2M19 14h2"/>',
    audio: '<path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2"/>',
    video: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3"/>',
    star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8-4.2-4.1 5.9-.9z"/>',
    dice: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8.5 8.5h.01M15.5 8.5h.01M12 12h.01M8.5 15.5h.01M15.5 15.5h.01"/>',
    coin: '<circle cx="12" cy="12" r="8.5"/><path d="M14.5 9.2c-.6-.8-1.5-1.2-2.5-1.2-1.4 0-2.5.8-2.5 2s1.1 1.6 2.5 2 2.5.8 2.5 2-1.1 2-2.5 2c-1 0-1.9-.4-2.5-1.2M12 6.5V8M12 16v1.5"/>'
  };
  const sprite = '<svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">' +
    Object.entries(P).map(([k, v]) => `<symbol id="i-${k}" viewBox="0 0 24 24">${v}</symbol>`).join('') + '</svg>';
  document.body.insertAdjacentHTML('afterbegin', sprite);

  // 主题：默认深色，记住用户选择
  const root = document.documentElement;
  const saved = (() => { try { return localStorage.getItem('aic-theme'); } catch (e) { return null; } })();
  if (saved) root.dataset.theme = saved;

  window.icon = (name, cls = '') => `<svg class="i ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

  // ---------- 外壳：侧栏、底部导航、右侧面板 ----------
  const page = document.body.dataset.page;          // workbench | kanban | assets | automations | monitor | capabilities | agents
  const curTask = document.body.dataset.task || '';
  const app = document.querySelector('.app');
  // ---------- 侧栏数据：项目、任务、自定义分组 ----------
  // 一个项目对应本机一个文件夹；分组是用户自建的标签，和项目无关，一个任务最多属于一个分组。
  // ago：距最近一次活动（发消息、Agent 输出）的分钟数，用来按“最近活动”排序。
  const agentName = { claude: 'Claude Code', codex: 'Codex', codebuddy: 'CodeBuddy', zcode: 'ZCode' };
  const mono = { claude: 'C', codex: 'X', codebuddy: 'B', zcode: 'Z' };
  const load = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 忽略 */ } };
  const projects = [
    { name: '雾港物语', path: 'D:\\Games\\FogHarbor', kind: 'Unity 项目 · git' },
    { name: '美术管线工具', path: 'D:\\Tools\\ArtPipeline', kind: 'Python 脚本 · git' },
  ];
  const tasks = [
    { id: 't8f2', proj: '雾港物语', ag: 'claude', title: '修复 Steam 云同步时存档偶发损坏', st: 'wait', stText: '等待审批', href: 'workbench.html', ago: 3 },
    { id: 't9a1', proj: '雾港物语', ag: 'codex', title: '背包界面支持手柄导航', st: 'run', stText: '运行中', ago: 0.5 },
    { id: 't7c3', proj: '雾港物语', ag: 'codebuddy', title: '宝箱模型：箱盖改圆、补铁箍', st: 'run', stText: '运行中', href: 'asset-mode.html', ago: 1 },
    { id: 't6e0', proj: '雾港物语', ag: 'codebuddy', title: '补全日文本地化文本表', st: 'ok', stText: '待验收', ago: 65 },
    { id: 't5b2', proj: '雾港物语', ag: 'codex', title: '升级 Addressables 到 2.3', st: 'idle', stText: '排队中', ago: 130 },
    { id: 't2a8', proj: '雾港物语', ag: 'claude', title: '战斗音效接入 Wwise 事件表', st: 'idle', stText: '排队中', ago: 190 },
    { id: 't1c4', proj: '雾港物语', ag: 'claude', title: '主菜单背景视差动画', st: 'ok', stText: '待验收', ago: 1500 },
    { id: 't4d9', proj: '美术管线工具', ag: 'claude', title: '批量把 FBX 转成 glTF 并压缩贴图', st: 'run', stText: '运行中', ago: 2 },
    { id: 't3f7', proj: '美术管线工具', ag: 'codex', title: '修复贴图命名检查脚本', st: 'err', stText: '失败', ago: 125 },
  ];
  const groups = load('aic-groups', [{ id: 'g1', name: '本周上线' }, { id: 'g2', name: '美术资源' }]);
  const assign = load('aic-task-group', { t8f2: 'g1', t9a1: 'g1', t5b2: 'g1', t7c3: 'g2', t4d9: 'g2' });
  const touched = load('aic-touched', {});            // 任务编号 → 最近一次活动的时间戳（原型里发消息时更新）
  let view = load('aic-sb-view', 'project');           // project | group，侧栏和看板共用
  let collapsed = load('aic-sec-collapsed', []);
  const agoOf = (t) => (touched[t.id] ? Math.min(t.ago, (Date.now() - touched[t.id]) / 60000) : t.ago);
  const whenText = (m) => (m < 1 ? '刚刚' : m < 60 ? `${Math.round(m)} 分钟` : m < 1440 ? `${Math.round(m / 60)} 小时` : m < 2880 ? '昨天' : `${Math.round(m / 1440)} 天`);
  const byRecent = (list) => [...list].sort((a, b) => agoOf(a) - agoOf(b));
  const hrefOf = (t) => t.href || 'workbench.html?' + new URLSearchParams({ title: t.title, st: t.st, stt: t.stText });
  const groupName = (id) => groups.find((g) => g.id === id)?.name;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  window.aicAgentName = agentName;
  const navItems = [
    ['task', '任务', 'chat', 'workbench.html', page === 'workbench' || page === 'kanban'],
    ['assets', '资产', 'cube', 'asset-mode.html', page === 'assets'],
    ['generate', '生成', 'wand', 'generate.html', page === 'generate'],
    ['automations', '自动化', 'auto', 'automations.html', page === 'automations'],
    ['monitor', '监控', 'chart', 'monitor.html', page === 'monitor'],
    ['capabilities', '能力', 'plug', 'capabilities.html', page === 'capabilities'],
    ['agents', 'Agent', 'bot', 'agents.html', page === 'agents'],
  ];
  const sidebar = document.querySelector('.sidebar');
  if (sidebar) {
    sidebar.setAttribute('aria-label', '侧栏');
    sidebar.innerHTML = `
      <div class="sb-top">
        <span class="brand"><span class="brand-mark">AI</span><span class="brand-name">AI Console</span></span>
        <span class="grow"></span>
        <button class="btn ghost icon sm" data-action="sidebar" aria-label="折叠侧栏" title="折叠侧栏 Ctrl+B">${icon('sidebar')}</button>
      </div>
      <button class="btn primary sb-new" aria-label="新建任务">${icon('plus')}<span class="sb-label">新建任务</span><kbd>Ctrl N</kbd></button>
      <a class="sb-item attn" href="workbench.html#approval" aria-label="等你处理：1 项">${icon('shield')}<span class="sb-label">等你处理</span><span class="badge">1</span></a>
      <button class="sb-item" aria-label="搜索">${icon('search')}<span class="sb-label">搜索</span><kbd style="margin-left:auto">Ctrl K</kbd></button>
      ${navItems.map(([, label, ic, href, cur]) => `<a class="sb-item" href="${href}" ${cur ? 'aria-current="page"' : ''} aria-label="${label}">${icon(ic)}<span class="sb-label">${label}</span></a>`).join('')}
      <div class="sb-section">
        <div class="seg-mini" role="radiogroup" aria-label="任务的归类方式">
          <button role="radio" data-sbview="project" aria-checked="false">项目</button><button role="radio" data-sbview="group" aria-checked="false">分组</button>
        </div>
        <span class="grow"></span>
        <button class="btn ghost icon xs" data-sec-collapse-all aria-label="全部折叠" title="全部折叠">${icon('layers')}</button>
        <button class="btn ghost icon xs" data-sec-add aria-label="添加项目" title="添加项目">${icon('plus')}</button>
      </div>
      <div class="projects"></div>
      <div class="sb-foot">
        <span class="status ok" title="服务运行中"><span class="dot"></span><span class="status-text">服务运行中，仅本机访问</span></span>
        <button class="btn ghost icon sm" data-action="theme" aria-label="切换日间/夜间模式">${icon('moon')}</button>
        <a class="btn ghost icon sm" href="#" aria-label="设置" title="设置">${icon('gear')}</a>
      </div>`;
  }
  // ---------- 侧栏渲染：按项目 / 按分组，组内按最近活动排序 ----------
  const box = sidebar?.querySelector('.projects');
  const taskRow = (t) => `
    <li><a class="task-row" href="${hrefOf(t)}" data-id="${t.id}" ${t.id === curTask ? 'aria-current="true"' : ''} ${view === 'group' ? 'draggable="true"' : ''} title="${esc(t.title)}（${agentName[t.ag]}，${esc(t.proj)}）">
      <span class="ag ${t.ag}" title="${agentName[t.ag]}" aria-label="${agentName[t.ag]}">${mono[t.ag]}</span><span class="t">${esc(t.title)}</span>
      <span class="sub"><span class="status ${t.st}"><span class="dot"></span>${t.stText}</span><span class="who">${esc(view === 'group' ? t.proj : agentName[t.ag])}</span><span class="when">${whenText(agoOf(t))}</span></span>
    </a><button class="btn ghost icon xs row-more" data-task-menu="${t.id}" aria-label="“${esc(t.title)}”的更多操作" title="移到分组等操作">${icon('more')}</button></li>`;
  const section = ({ key, kind, name, path, kind2, list, empty }) => {
    const closed = collapsed.includes(key);
    const ico = kind === 'proj' ? 'folder' : kind === 'group' ? 'layers' : 'grid';
    const acts = kind === 'none' ? '' : `<span class="proj-acts">
        <button class="btn ghost icon xs" data-sec-new aria-label="在“${esc(name)}”中新建任务" title="在这里新建任务">${icon('plus')}</button>
        <button class="btn ghost icon xs" data-sec-menu aria-label="“${esc(name)}”的更多操作" title="更多操作">${icon('more')}</button></span>`;
    return `<section class="proj" data-kind="${kind}" data-key="${esc(key)}" data-name="${esc(name)}" ${path ? `data-path="${esc(path)}"` : ''}>
      <div class="proj-head">
        <button class="proj-toggle" aria-expanded="${!closed}" ${path ? `title="${esc(path)}（${esc(kind2)}）"` : ''}>
          ${icon('right', 'chev')}${icon(ico, 'fold')}<span class="pn">${esc(name)}</span><span class="count">${list.length}</span>
        </button>${acts}
      </div>
      <ul class="tasks" aria-label="${esc(name)} 的任务" ${closed ? 'hidden' : ''}>${list.length ? byRecent(list).map(taskRow).join('') : `<li class="proj-empty">${empty}</li>`}</ul>
    </section>`;
  };
  const render = () => {
    if (!box) return;
    const top = sidebar.scrollTop;
    const secs = view === 'project'
      ? projects.map((p) => ({ key: 'p:' + p.name, kind: 'proj', name: p.name, path: p.path, kind2: p.kind, list: tasks.filter((t) => t.proj === p.name), empty: '还没有任务' }))
      : [...groups.map((g) => ({ key: 'g:' + g.id, kind: 'group', name: g.name, list: tasks.filter((t) => assign[t.id] === g.id), empty: '把任务拖到这里，或用任务的“…”菜单移入' })),
        { key: 'g:none', kind: 'none', name: '未分类', list: tasks.filter((t) => !groupName(assign[t.id])), empty: '所有任务都已分组' }];
    box.innerHTML = secs.map(section).join('');
    sidebar.querySelectorAll('[data-sbview]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.sbview === view)));
    const add = sidebar.querySelector('[data-sec-add]');
    if (add) { const l = view === 'project' ? '添加项目' : '新建分组'; add.setAttribute('aria-label', l); add.title = l; }
    sidebar.scrollTop = top;
    document.dispatchEvent(new CustomEvent('aic-sb-change'));
  };
  const persist = () => { save('aic-groups', groups); save('aic-task-group', assign); };
  // 供其他脚本调用的接口（新建任务、分组管理、看板筛选都走这里）
  window.aicSB = {
    get view() { return view; }, projects, tasks, groups, assign, agoOf, byRecent, groupName,
    setView(v) { view = v; save('aic-sb-view', v); render(); },
    render,
    touch(id) { touched[id] = Date.now(); save('aic-touched', touched); render(); },
    addTask(t) { const nt = { id: 'n' + Date.now(), st: 'idle', stText: '排队中', ago: 0, ...t }; tasks.push(nt); if (t.group) { assign[nt.id] = t.group; persist(); } collapsed = collapsed.filter((k) => k !== 'p:' + nt.proj && k !== 'g:' + (t.group || 'none')); render(); return nt; },
    addGroup(name) { const g = { id: 'g' + Date.now(), name }; groups.push(g); persist(); render(); return g.id; },
    renameGroup(id, name) { const g = groups.find((x) => x.id === id); if (g) g.name = name; persist(); render(); },
    deleteGroup(id) { const i = groups.findIndex((x) => x.id === id); if (i >= 0) groups.splice(i, 1); Object.keys(assign).forEach((k) => { if (assign[k] === id) delete assign[k]; }); persist(); render(); },
    moveTask(id, gid) { if (gid) assign[id] = gid; else delete assign[id]; persist(); render(); },
    addProject(p) { projects.unshift(p); render(); },
    renameProject(old, name) { const p = projects.find((x) => x.name === old); if (!p) return; p.name = name; tasks.forEach((t) => { if (t.proj === old) t.proj = name; }); render(); },
    removeProject(name) { const i = projects.findIndex((x) => x.name === name); if (i >= 0) projects.splice(i, 1); for (let j = tasks.length - 1; j >= 0; j--) if (tasks[j].proj === name) tasks.splice(j, 1); render(); },
    solo(key) { collapsed = [...box.querySelectorAll('.proj')].map((s) => s.dataset.key).filter((k) => k !== key); save('aic-sec-collapsed', collapsed); render(); },
  };
  render();

  const setOpen = (sec, open) => {
    sec.querySelector('.tasks').hidden = !open;
    sec.querySelector('.proj-toggle').setAttribute('aria-expanded', String(open));
    collapsed = collapsed.filter((k) => k !== sec.dataset.key);
    if (!open) collapsed.push(sec.dataset.key);
    save('aic-sec-collapsed', collapsed);
  };
  sidebar?.addEventListener('click', (e) => {
    const v = e.target.closest('[data-sbview]');
    if (v) { window.aicSB.setView(v.dataset.sbview); return; }
    const t = e.target.closest('.proj-toggle');
    if (t) { const sec = t.closest('.proj'); setOpen(sec, sec.querySelector('.tasks').hidden); return; }
    const all = e.target.closest('[data-sec-collapse-all]');
    if (all) {
      const secs = [...box.querySelectorAll('.proj')];
      const anyOpen = secs.some((s) => !s.querySelector('.tasks').hidden);
      secs.forEach((s) => setOpen(s, !anyOpen));
      all.setAttribute('aria-label', anyOpen ? '全部展开' : '全部折叠'); all.title = all.getAttribute('aria-label');
    }
  });
  sidebar?.addEventListener('keydown', (e) => {
    const v = e.target.closest('[data-sbview]');
    if (v && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); window.aicSB.setView(view === 'project' ? 'group' : 'project'); sidebar.querySelector(`[data-sbview="${view}"]`).focus(); }
  });
  // 分组视图：把任务拖到另一个分组上即可移动
  box?.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.task-row'); if (!row) return;
    e.dataTransfer.setData('text/plain', row.dataset.id); e.dataTransfer.effectAllowed = 'move';
  });
  box?.addEventListener('dragover', (e) => {
    const sec = e.target.closest('.proj'); if (!sec || view !== 'group') return;
    e.preventDefault(); box.querySelectorAll('.drop-target').forEach((s) => s.classList.remove('drop-target')); sec.classList.add('drop-target');
  });
  box?.addEventListener('dragleave', (e) => { if (!box.contains(e.relatedTarget)) box.querySelectorAll('.drop-target').forEach((s) => s.classList.remove('drop-target')); });
  box?.addEventListener('drop', (e) => {
    const sec = e.target.closest('.proj'); if (!sec) return;
    e.preventDefault();
    const id = e.dataTransfer.getData('text/plain');
    const gid = sec.dataset.kind === 'group' ? sec.dataset.key.slice(2) : null;
    window.aicSB.moveTask(id, gid);
    window.aicToast?.(gid ? `已移到分组“${esc(groupName(gid))}”` : '已移到“未分类”');
  });
  // 窄屏底部导航
  if (app && page) {
    app.insertAdjacentHTML('beforeend', `<nav class="bottomnav" aria-label="主导航">
      <a href="workbench.html" ${page === 'workbench' || page === 'kanban' ? 'aria-current="page"' : ''} aria-label="任务，1 项等你处理">${icon('chat')}<span class="badge">1</span></a>
      <a href="asset-mode.html" ${page === 'assets' ? 'aria-current="page"' : ''} aria-label="资产">${icon('cube')}</a>
      <a href="generate.html" ${page === 'generate' ? 'aria-current="page"' : ''} aria-label="生成">${icon('wand')}</a>
      <a href="automations.html" ${page === 'automations' ? 'aria-current="page"' : ''} aria-label="自动化">${icon('auto')}</a>
      <a href="monitor.html" ${page === 'monitor' ? 'aria-current="page"' : ''} aria-label="监控">${icon('chart')}</a>
      <a href="capabilities.html" ${page === 'capabilities' ? 'aria-current="page"' : ''} aria-label="能力">${icon('plug')}</a>
      <a href="agents.html" ${page === 'agents' ? 'aria-current="page"' : ''} aria-label="Agent">${icon('bot')}</a>
      <a href="#" aria-label="设置">${icon('gear')}</a></nav>`);
  }

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 忽略 */ } },
  };
  const mid = matchMedia('(max-width: 1279px)');
  // 侧栏折叠：记住选择；中屏默认折叠
  if (app) {
    const sbPref = store.get('aic-sb');
    if (sbPref === 'collapsed' || (sbPref === null && mid.matches)) app.classList.add('sb-collapsed');
  }
  const toggleSidebar = () => {
    app.classList.toggle('sb-collapsed');
    store.set('aic-sb', app.classList.contains('sb-collapsed') ? 'collapsed' : 'open');
  };
  // 右侧面板：页面给出默认开合；中屏是覆盖抽屉，默认收起
  const side = document.querySelector('.side');
  const setSide = (open) => {
    if (!app || !side) return;
    app.dataset.side = open ? 'open' : 'closed';
    document.querySelectorAll('[data-action="side"]').forEach((b) => b.setAttribute('aria-expanded', String(open)));
  };
  if (side) {
    setSide(mid.matches ? false : app.dataset.side !== 'closed');
    const w = store.get('aic-side-w');
    if (w) app.style.setProperty('--side-w', w + 'px');
  }
  window.aicOpenSide = (tabId) => {
    setSide(true);
    if (tabId) document.getElementById(tabId)?.click();
  };

  // 拖动条：指针拖动或方向键调整右侧面板宽度
  const rz = document.querySelector('.resizer');
  if (rz && side) {
    rz.setAttribute('role', 'separator');
    rz.setAttribute('aria-orientation', 'vertical');
    rz.setAttribute('aria-label', '调整右侧面板宽度');
    rz.tabIndex = 0;
    const clamp = (v) => Math.max(320, Math.min(v, window.innerWidth * 0.62));
    const apply = (v) => { v = Math.round(clamp(v)); app.style.setProperty('--side-w', v + 'px'); rz.setAttribute('aria-valuenow', v); store.set('aic-side-w', v); };
    rz.addEventListener('pointerdown', (e) => {
      rz.setPointerCapture(e.pointerId); rz.classList.add('dragging');
      const move = (ev) => apply(window.innerWidth - ev.clientX);
      const up = () => { rz.classList.remove('dragging'); rz.removeEventListener('pointermove', move); rz.removeEventListener('pointerup', up); };
      rz.addEventListener('pointermove', move); rz.addEventListener('pointerup', up);
    });
    rz.addEventListener('keydown', (e) => {
      const cur = side.getBoundingClientRect().width;
      if (e.key === 'ArrowLeft') { apply(cur + 24); e.preventDefault(); }
      if (e.key === 'ArrowRight') { apply(cur - 24); e.preventDefault(); }
    });
  }

  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="sidebar"]')) toggleSidebar();
    const s = e.target.closest('[data-action="side"]');
    if (s) { if (s.dataset.tab) window.aicOpenSide(s.dataset.tab); else setSide(app.dataset.side === 'closed'); }
    if (e.target.closest('[data-action="side-close"]')) setSide(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'b' && app) { e.preventDefault(); toggleSidebar(); }
    if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'j' && side) { e.preventDefault(); setSide(app.dataset.side === 'closed'); }
  });

  // 主题切换按钮：夜间模式显示月亮，日间模式显示太阳，提示文字说明点击后切到哪个模式
  const syncThemeBtns = () => {
    const night = root.dataset.theme !== 'light';
    document.querySelectorAll('[data-action="theme"]').forEach((b) => {
      const use = b.querySelector('use');
      if (use) use.setAttribute('href', night ? '#i-moon' : '#i-sun');
      const tip = night ? '夜间模式（点击切换到日间模式）' : '日间模式（点击切换到夜间模式）';
      b.setAttribute('aria-label', tip);
      b.title = tip;
    });
  };
  syncThemeBtns();
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-action="theme"]');
    if (!t) return;
    const next = root.dataset.theme === 'light' ? 'dark' : 'light';
    root.dataset.theme = next;
    try { localStorage.setItem('aic-theme', next); } catch (err) { /* 忽略 */ }
    syncThemeBtns();
    document.dispatchEvent(new CustomEvent('themechange', { detail: next }));
  });

  // 标签页：同一面板组内切换，支持左右方向键
  document.querySelectorAll('[role="tablist"]').forEach((list) => {
    const tabs = [...list.querySelectorAll('[role="tab"]')];
    const select = (tab) => {
      tabs.forEach((t) => {
        const on = t === tab;
        t.setAttribute('aria-selected', on);
        t.tabIndex = on ? 0 : -1;
        const panel = document.getElementById(t.getAttribute('aria-controls'));
        if (panel) panel.hidden = !on;
      });
    };
    tabs.forEach((t, i) => {
      t.addEventListener('click', () => select(t));
      t.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        const n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
        n.focus(); select(n);
      });
    });
  });

  // 弹出层：按钮 aria-controls 指向 .popover，Esc 或点外部关闭
  document.addEventListener('click', (e) => {
    const trigger = e.target.closest('[data-popover]');
    document.querySelectorAll('.popover').forEach((p) => {
      if (trigger && p.id === trigger.dataset.popover) {
        p.hidden = !p.hidden;
        trigger.setAttribute('aria-expanded', !p.hidden);
      } else if (!p.contains(e.target)) {
        p.hidden = true;
      }
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const openPop = [...document.querySelectorAll('.popover')].some((p) => !p.hidden);
    document.querySelectorAll('.popover').forEach((p) => (p.hidden = true));
    const viewerOpen = document.querySelector('.viewer:not([hidden])');
    if (!openPop && !viewerOpen && mid.matches && app && app.dataset.side === 'open') setSide(false);
  });
})();
