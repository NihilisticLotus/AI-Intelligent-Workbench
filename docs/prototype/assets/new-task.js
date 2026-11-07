// 新建任务：起始页（2026-11-07，ui-design.md 6.15，参照 ZCode 的起始页），替代原来的“新建任务”对话框。
// 主区域中间：问候语 → 一个大输入框（顶部项目 ▾、分支 ▾、分组 ▾；底部 + 附件、权限 ▾、Agent · 模型 ▾、派发）→ 快捷入口。
// 写了描述后给出 Agent 推荐（原型用关键词模拟）。Esc 或“返回”回到原来的页面。
// 依赖 app.js（aicSB、图标）和 interact.js（aicMenu、aicToast、aicEsc、aicAgents、aicJudge）。
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const ic = (n) => `<svg class="i" aria-hidden="true"><use href="#i-${n}"/></svg>`;
  const esc = window.aicEsc, toast = window.aicToast, menu = window.aicMenu;
  const SB = window.aicSB;
  const main = $('.main'), app = $('.app');
  if (!main || !SB) return;

  // 新建任务里可选的 Agent（ZCode 还没接通，不列）
  const agents = Object.entries(window.aicAgents || {}).filter(([k]) => k !== 'zcode');
  const defEffort = (k) => { const e = window.aicEfforts?.[k]; return e ? (e.includes('高') && k === 'claude' ? '高' : e.includes('中') ? '中' : e[0]) : null; };
  const BADGE = { claude: 'C', codex: 'X', codebuddy: 'B', workbuddy: 'W', zcode: 'Z' };
  const branches = ['main', 'develop', 'release/1.2'];
  const perms = [['只读', '只看不改'], ['需审批', '改文件、运行命令前问你（推荐）'], ['工作区内自动', '工作副本里自动执行，越界才问'], ['完全访问', '全部自动执行，不再询问']];
  const quick = [
    { k: 'fix', ic: 'warn', n: '报错修复', t: '玩家反馈：', tail: '先查原因，修复时不改存档格式，补上测试。', ag: 'claude' },
    { k: 'week', ic: 'calendar', n: '周报总结', t: '汇总本周这个项目的改动、完成的任务和遗留问题，写成一页周报，按功能分组。', ag: 'claude' },
    { k: 'asset', ic: 'cube', n: '资产处理', t: '检查 Assets/Art 下本周新增的模型：面数、材质命名、贴图尺寸，列出不合规的。', ag: 'codebuddy' },
    { k: 'ppt', ic: 'layers', n: 'PPT 制作', t: '根据最近的里程碑进度，做一份 8 页左右的项目汇报 PPT，配上截图位置。', ag: 'claude' },
    { k: 'idle', ic: 'clock', n: '闲时任务', t: '', ag: null, idle: true },
  ];
  const hour = new Date().getHours();
  const hello = hour < 6 ? '夜深了' : hour < 11 ? '早上好' : hour < 13 ? '中午好' : hour < 18 ? '下午好' : '晚上好';

  let page = null, prevFocus = null;
  const close = () => {
    if (!page) return;
    page.dispatchEvent(new Event('close'));
    page.remove(); page = null;
    delete main.dataset.view; if (app) delete app.dataset.nt;
    document.removeEventListener('keydown', onKey, true);
    prevFocus?.focus?.();
  };
  const onKey = (e) => {
    if (e.key !== 'Escape' || !page || document.querySelector('.menu')) return; // 菜单开着时 Esc 只关菜单
    e.preventDefault(); close();
  };

  // preset：{ proj, group }，从项目或分组的“+”进入时预先选好
  const open = (preset = {}) => {
    if (page) close();
    prevFocus = document.activeElement;
    const st = {
      proj: SB.projects.find((p) => p.name === preset.proj)?.name || SB.projects[0]?.name || '',
      branch: 'main', group: preset.group || '', perm: '需审批', ag: 'claude', model: null, idle: false, adopted: false,
    };
    st.model = (window.aicAgents[st.ag] || [, ['']])[1][0];
    st.effort = defEffort(st.ag);

    main.insertAdjacentHTML('beforeend', `<section class="nt-page" aria-labelledby="nt-h">
      <div class="nt-top"><button type="button" class="btn ghost sm" data-wired="1" data-nt="back">${ic('right')}<span>返回</span></button><span class="grow"></span><span class="sub">Esc 返回 · Ctrl+Enter 派发</span></div>
      <div class="nt-center">
        <h1 id="nt-h" class="nt-hello">${hello}，今天让 Agent 做什么？</h1>
        <div class="nt-box">
          <div class="nt-chips">
            <button type="button" class="nt-chip" data-wired="1" data-nt="proj" aria-haspopup="menu"></button>
            <button type="button" class="nt-chip" data-wired="1" data-nt="branch" aria-haspopup="menu"></button>
            <button type="button" class="nt-chip" data-wired="1" data-nt="group" aria-haspopup="menu"></button>
            <span class="nt-idle" hidden>${ic('clock')}闲时运行<button type="button" class="x" data-wired="1" data-nt="idle-off" aria-label="取消闲时运行">${ic('x')}</button></span>
          </div>
          <label for="nt-d" class="sr-only">要做什么</label>
          <textarea id="nt-d" rows="3" placeholder="描述要做的事，比如：把背包格子的悬停提示改成跟随手柄焦点。@ 引用文件"></textarea>
          <div class="nt-attach"></div>
          <div class="nt-bar">
            <button type="button" class="btn ghost icon sm" data-wired="1" data-nt="attach" aria-label="添加附件">${ic('plus')}</button>
            <button type="button" class="nt-chip" data-wired="1" data-nt="perm" aria-haspopup="menu"></button>
            <span class="grow"></span>
            <button type="button" class="nt-chip" data-wired="1" data-nt="agent" aria-haspopup="menu"></button>
            <button type="button" class="btn primary nt-send" data-wired="1" data-nt="send" aria-label="派发">${ic('send')}</button>
          </div>
        </div>
        <div class="nt-rec" aria-live="polite"></div>
        <div class="nt-quick" role="group" aria-label="快捷入口">${quick.map((q) => `<button type="button" class="nt-q" data-wired="1" data-q="${q.k}">${ic(q.ic)}${q.n}</button>`).join('')}</div>
        <p class="nt-foot">派发后会为这个任务建立独立的工作副本，不影响你正在用的代码。</p>
      </div></section>`);
    page = main.lastElementChild;
    main.dataset.view = 'new'; if (app) app.dataset.nt = '1';
    const ta = $('#nt-d', page), rec = $('.nt-rec', page);
    // 附件：Ctrl+V 粘贴图片、拖入、点“+”；模型看不了图片时立即警告（attach.js）
    const att = window.aicAttach?.($('.nt-box', page), {
      textarea: ta, pickBtn: $('[data-nt="attach"]', page),
      target: () => ({ agent: st.ag, model: st.model }),
      switchTo: (agent, model) => { if (agent !== st.ag) setAgent(agent); st.model = model; paint(); recommend(); },
      onChange: () => paint(),
    });

    const paint = () => {
      const [agName] = window.aicAgents[st.ag];
      $('[data-nt="proj"]', page).innerHTML = `${ic('folder')}<span>${esc(st.proj)}</span>${ic('down')}`;
      $('[data-nt="proj"]', page).setAttribute('aria-label', `项目：${st.proj}`);
      $('[data-nt="branch"]', page).innerHTML = `${ic('branch')}<span class="mono">${esc(st.branch)}</span>${ic('down')}`;
      $('[data-nt="branch"]', page).setAttribute('aria-label', `基于分支：${st.branch}`);
      $('[data-nt="group"]', page).innerHTML = `${ic('layers')}<span>${st.group ? esc(SB.groupName(st.group)) : '不分组'}</span>${ic('down')}`;
      $('[data-nt="group"]', page).classList.toggle('quiet', !st.group);
      $('[data-nt="group"]', page).setAttribute('aria-label', `分组：${st.group ? SB.groupName(st.group) : '不分组'}`);
      $('[data-nt="perm"]', page).innerHTML = `${ic(st.perm === '完全访问' ? 'unlock' : 'shield')}<span>${st.perm}</span>${ic('down')}`;
      $('[data-nt="perm"]', page).classList.toggle('attn', st.perm === '完全访问');
      $('[data-nt="perm"]', page).setAttribute('aria-label', `权限：${st.perm}`);
      $('[data-nt="agent"]', page).innerHTML = `<span class="ag ${st.ag}" aria-hidden="true">${BADGE[st.ag] || agName[0]}</span><span>${esc(agName)}</span><span class="sub">${esc(st.model)}${st.effort ? ' · 思考 ' + esc(st.effort) : ''}</span>${ic('down')}`;
      $('[data-nt="agent"]', page).setAttribute('aria-label', `Agent、模型和思考强度：${agName} · ${st.model}${st.effort ? ' · 思考 ' + st.effort : ''}`);
      $('.nt-idle', page).hidden = !st.idle;
      $('.nt-send', page).disabled = !ta.value.trim() && !att?.count();
      att?.refresh();
    };

    // 推荐 Agent（规则同原对话框）
    let timer;
    const recommend = () => {
      const text = ta.value.trim();
      if (text.length < 4 || !window.aicJudgeOn?.('agent')) { rec.innerHTML = ''; return; }
      const rules = [
        [/模型|贴图|美术|材质|fbx|glb|gltf|面数|动画|特效|图集/i, 'codebuddy', 81, '涉及美术资产处理，CodeBuddy 在这个项目的资产任务验收通过率最高'],
        [/本地化|翻译|文本表|日文|英文|多语言/, 'codebuddy', 76, '批量文本表处理，glm-5.1 中文和日文条目更稳'],
        [/修复|bug|崩溃|报错|损坏|卡死|闪退/i, 'claude', 84, '需要跨多个文件定位问题，Claude Code 在修复类任务上返工最少'],
        [/界面|ui|手柄|按钮|菜单|布局/i, 'claude', 72, '界面脚本改动；Codex 更合适但登录已过期，先推荐 Claude Code'],
      ];
      const [, ag, p, why] = rules.find(([re]) => re.test(text)) || [null, 'claude', 66, '通用代码任务，按最近 30 天这个项目的成功率选择'];
      const same = st.ag === ag;
      rec.innerHTML = `<div class="rec-box">${window.aicJudge({ kind: 'agent', text: `推荐 Agent：${window.aicAgents[ag][0]}`, prob: p, why })}
        <button class="btn sm" type="button" data-wired="1" data-adopt="${ag}" ${same ? 'disabled' : ''}>${same ? '已采用推荐' : '采用推荐'}</button></div>`;
    };
    ta.addEventListener('input', () => { paint(); clearTimeout(timer); timer = setTimeout(recommend, 300); });
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } });

    const send = () => {
      const text = ta.value.trim();
      if (!text) { ta.focus(); toast('先写一句要做什么', 'attn'); return; }
      const files = att ? att.take() : [];
      if (files === null) return; // 模型看不了图片，已在输入框里提示
      const t = { proj: st.proj, ag: st.ag, title: text, group: st.group || undefined };
      SB.addTask(t);
      toast(`已派发到「${esc(st.proj)}」${st.group ? `，分组“${esc(SB.groupName(st.group))}”` : ''}：${esc(text)}${files.length ? `（附件 ${files.length} 个）` : ''}<br>${st.idle ? '会在电脑空闲时开始。' : `${window.aicAgents[st.ag][0]} 有空位后自动开始。`}`);
      close();
    };

    // Agent · 模型 · 思考强度：和对话输入框共用 interact.js 的 aicAgentPicker
    const agentMenu = (b) => window.aicAgentPicker(b, {
      agent: st.ag, model: st.model, effort: st.effort, list: agents.map(([k]) => k),
      onPick: (p) => { st.ag = p.agent; st.model = p.model; st.effort = p.effort; paint(); recommend(); },
      onEffort: (e) => { st.effort = e; paint(); },
    });
    // 换 Agent（推荐、快捷入口）时思考强度回到这个 Agent 的默认值
    const setAgent = (k) => { st.ag = k; st.model = window.aicAgents[k][1][0]; st.effort = defEffort(k); };
    page.addEventListener('click', (e) => {
      const ad = e.target.closest('[data-adopt]');
      if (ad) { setAgent(ad.dataset.adopt); paint(); recommend(); toast(`已采用推荐：${window.aicAgents[st.ag][0]}`); return; }
      const q = e.target.closest('[data-q]');
      if (q) {
        const it = quick.find((x) => x.k === q.dataset.q);
        if (it.idle) { st.idle = true; paint(); toast('这个任务会在电脑空闲时运行（没人用、没有其他任务在跑）'); ta.focus(); return; }
        ta.value = it.t + (it.tail ? '\n' + it.tail : '');
        if (it.ag) setAgent(it.ag);
        ta.dispatchEvent(new Event('input'));
        ta.focus(); ta.setSelectionRange(it.t.length, it.t.length); // 光标停在要补充的地方
        return;
      }
      const b = e.target.closest('[data-nt]'); if (!b) return;
      const d = b.dataset.nt;
      if (d === 'back') close();
      else if (d === 'send') send();
      else if (d === 'idle-off') { st.idle = false; paint(); }
      else if (d === 'proj') menu(b, SB.projects.map((p) => [p.name, () => { st.proj = p.name; paint(); recommend(); }, p.name === st.proj ? 'on' : '']));
      else if (d === 'branch') menu(b, branches.map((n) => [n, () => { st.branch = n; paint(); }, n === st.branch ? 'on' : '']));
      else if (d === 'group') menu(b, [['不分组（未分类）', () => { st.group = ''; paint(); }, st.group ? '' : 'on'], ...SB.groups.map((g) => [g.name, () => { st.group = g.id; paint(); }, g.id === st.group ? 'on' : ''])]);
      else if (d === 'perm') menu(b, perms.map(([n, w]) => [`${n} · ${w}`, () => { st.perm = n; paint(); if (n === '完全访问') toast('完全访问：Agent 改文件、运行命令都不再问你', 'attn'); }, n === st.perm ? 'on' : '']));
      else if (d === 'agent') agentMenu(b);
    });

    document.addEventListener('keydown', onKey, true);
    paint();
    ta.focus();
    return page;
  };

  window.aicNewTaskPage = open;
  window.aicNewTaskClose = close;
})();
