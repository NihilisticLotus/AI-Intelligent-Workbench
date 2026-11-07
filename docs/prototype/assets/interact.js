// 原型交互层：让原型里每个可点的元素都有反馈。只做演示，不代表正式实现。
// 依赖 app.js 先运行（图标、侧栏、主题都由 app.js 生成）。
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const page = document.body.dataset.page;
  const ic = (n) => window.icon(n);
  const hhmm = () => new Date().toTimeString().slice(0, 5);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const wire = (el) => { if (el) el.dataset.wired = '1'; return el; };

  // ---------- 提示条 ----------
  const toastBox = document.createElement('div');
  toastBox.className = 'toasts';
  toastBox.setAttribute('role', 'status');
  toastBox.setAttribute('aria-live', 'polite');
  document.body.appendChild(toastBox);
  const toast = (msg, kind = 'ok', ms = 3200) => {
    const t = document.createElement('div');
    t.className = 'toast ' + kind;
    t.innerHTML = msg;
    toastBox.appendChild(t);
    setTimeout(() => t.remove(), ms);
  };
  window.aicToast = toast;

  // ---------- 对话框 ----------
  // actions: [{ label, kind, onClick(dlg) }]，onClick 返回 false 时不关闭
  const modal = ({ title, body, actions = [], wide = false, onOpen }) => {
    const d = document.createElement('dialog');
    d.className = 'dlg' + (wide ? ' wide' : '');
    d.setAttribute('aria-label', title);
    d.innerHTML = `<div class="dlg-head"><h2>${title}</h2><span class="grow"></span>
      <button class="btn ghost icon sm" data-close aria-label="关闭">${ic('x')}</button></div>
      <div class="dlg-body">${body}</div>
      <div class="dlg-foot"></div>`;
    const foot = $('.dlg-foot', d);
    const all = actions.length ? actions : [{ label: '知道了', kind: 'primary' }];
    all.forEach((a) => {
      const b = document.createElement('button');
      b.className = 'btn ' + (a.kind || '');
      b.textContent = a.label;
      b.addEventListener('click', () => { if (!a.onClick || a.onClick(d) !== false) d.close(); });
      foot.appendChild(b);
    });
    $('[data-close]', d).addEventListener('click', () => d.close());
    d.addEventListener('close', () => d.remove());
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
    document.body.appendChild(d);
    d.showModal();
    if (onOpen) onOpen(d);
    return d;
  };
  window.aicModal = modal;

  // ---------- 快速判断：只返回“结论 + 概率 + 一句依据”的结构化判断 ----------
  // 设置存在本机：判断引擎、每类判断的开关、低风险审批自动允许、Jev 按项目开关
  const judgeKinds = { risk: '审批风险', agent: 'Agent 推荐', done: '完成度', stuck: '卡住检测', grade: '自动化结果分级' };
  const engines = { account: '已有账号或 API 的便宜模型', local: '本机小模型', jev: 'Jev API' };
  const judgeDefault = { engine: 'account', account: 'claude|工作室 API Key|Haiku 5.5', jevKey: '', jevOff: [], localReady: false, on: { risk: true, agent: true, done: true, stuck: true, grade: true }, autoAllowDefault: true };
  const judgeCfg = () => { try { return { ...judgeDefault, ...JSON.parse(localStorage.getItem('aic-judge') || '{}') }; } catch (e) { return { ...judgeDefault }; } };
  const judgeSave = (c) => { try { localStorage.setItem('aic-judge', JSON.stringify(c)); } catch (e) { /* 忽略 */ } };
  const judgeOn = (kind) => judgeCfg().on[kind] !== false;
  // level：ok | wait | err | idle，决定结论前的形状标记；结论本身总是写成文字
  const judge = ({ kind, text, prob, why, level = 'ok' }) => {
    if (!judgeOn(kind)) return '';
    const eng = engines[judgeCfg().engine];
    return `<div class="judge" data-kind="${kind}" role="group" aria-label="快速判断：${esc(judgeKinds[kind])}">
      <span class="jtag" title="判断引擎：${eng}">${ic('gauge')}快速判断</span>
      <span class="jres"><span class="status ${level}"><span class="dot"></span></span><b>${text}</b><span class="jprob">${prob}%</span></span>
      <span class="jwhy">依据：${why}</span>
      <button class="btn ghost sm jno" data-wired="1" data-judge-no="${kind}" aria-pressed="false" aria-label="不同意这条${esc(judgeKinds[kind])}判断">不同意</button></div>`;
  };
  // 被纠正的次数：本机累计，监控页“判断准确度”会加上这里的数字
  const corrections = () => { try { return JSON.parse(localStorage.getItem('aic-judge-fix') || '{}'); } catch (e) { return {}; } };
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-judge-no]');
    if (!b) return;
    e.stopPropagation();
    const fix = corrections(); const k = b.dataset.judgeNo;
    const on = b.getAttribute('aria-pressed') !== 'true';
    fix[k] = Math.max(0, (fix[k] || 0) + (on ? 1 : -1));
    try { localStorage.setItem('aic-judge-fix', JSON.stringify(fix)); } catch (err) { /* 忽略 */ }
    b.setAttribute('aria-pressed', String(on));
    b.textContent = on ? '已记为纠正' : '不同意';
    b.closest('.judge')?.classList.toggle('corrected', on);
    toast(on ? '已记录，会用于调整阈值' : '已撤销这次纠正');
    document.dispatchEvent(new CustomEvent('aic-judge-fix'));
  }, true);
  Object.assign(window, { aicJudge: judge, aicJudgeOn: judgeOn, aicJudgeCfg: judgeCfg, aicJudgeKinds: judgeKinds, aicJudgeFixes: corrections });

  // ---------- 小菜单 ----------
  const menu = (anchor, items) => {
    $$('.menu').forEach((m) => m.remove());
    const m = document.createElement('div');
    m.className = 'menu';
    m.setAttribute('role', 'menu');
    items.forEach(([label, fn, cls]) => {
      const b = document.createElement('button');
      b.setAttribute('role', 'menuitem');
      b.textContent = label;
      if (cls) b.className = cls;
      b.addEventListener('click', () => { m.remove(); fn(); });
      m.appendChild(b);
    });
    document.body.appendChild(m);
    const r = anchor.getBoundingClientRect();
    m.style.top = Math.min(r.bottom + 4, innerHeight - m.offsetHeight - 8) + 'px';
    m.style.left = Math.min(r.left, innerWidth - m.offsetWidth - 8) + 'px';
    m.querySelector('button').focus();
    setTimeout(() => document.addEventListener('click', function off(e) {
      if (!m.contains(e.target)) { m.remove(); document.removeEventListener('click', off); }
    }), 0);
    m.addEventListener('keydown', (e) => { if (e.key === 'Escape') { m.remove(); anchor.focus(); } });
  };

  // ---------- 侧栏：新建任务、搜索、设置 ----------
  const sidebarRows = () => $$('.sidebar .task-row');
  const SB = window.aicSB;

  const agentModels = {
    claude: ['Claude Code', ['Opus 5.5', 'Sonnet 5']],
    codex: ['Codex', ['gpt-5.5-codex']],
    codebuddy: ['CodeBuddy', ['glm-5.1', 'kimi-k2.5', 'minimax-m2.7', 'deepseek-v3-2']],
    zcode: ['ZCode', ['glm-5.1']],
  };
  window.aicAgents = agentModels;

  // preset：{ proj, group }，从项目或分组的“+”进入时预先选好
  const newTask = (preset = {}) => modal({
    title: '新建任务',
    body: `<div class="form-row"><label for="nt-p">项目</label><select class="select" id="nt-p">${SB.projects.map((p) => `<option ${p.name === preset.proj ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
      <div class="form-row"><label for="nt-g">分组</label><select class="select" id="nt-g"><option value="">不分组（未分类）</option>${SB.groups.map((g) => `<option value="${g.id}" ${g.id === preset.group ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></div>
      <div class="form-row" style="align-items:start"><label for="nt-d">要做什么</label><textarea class="textarea" id="nt-d" rows="4" placeholder="例如：把背包格子的悬停提示改成跟随手柄焦点"></textarea></div>
      <div class="nt-rec" aria-live="polite"></div>
      <div class="form-row"><label for="nt-a">Agent</label><select class="select" id="nt-a">${Object.entries(agentModels).map(([k, [n]]) => `<option value="${k}">${n}</option>`).join('')}</select></div>
      <div class="form-row"><label for="nt-m">模型</label><select class="select" id="nt-m"></select></div>
      <div class="form-row"><label for="nt-l">权限</label><select class="select" id="nt-l"><option>只读</option><option selected>需审批（推荐）</option><option>工作区内自动</option><option>全自动</option></select></div>
      <p style="margin:0;color:var(--fg-3)">派发后会自动为这个任务建立独立工作副本，不影响你正在用的代码。</p>`,
    onOpen(d) {
      const fill = () => { $('#nt-m', d).innerHTML = agentModels[$('#nt-a', d).value][1].map((m) => `<option>${m}</option>`).join(''); };
      $('#nt-a', d).addEventListener('change', fill); fill();
      // 选好项目、写了描述后给出 Agent 推荐（原型用关键词模拟判断结果）
      const rec = $('.nt-rec', d);
      let timer;
      const recommend = () => {
        const text = $('#nt-d', d).value.trim();
        if (text.length < 4 || !judgeOn('agent')) { rec.innerHTML = ''; return; }
        const rules = [
          [/模型|贴图|美术|材质|fbx|glb|gltf|面数|动画|特效|图集/i, 'codebuddy', 81, '涉及美术资产处理，CodeBuddy 在这个项目的资产任务验收通过率最高'],
          [/本地化|翻译|文本表|日文|英文|多语言/, 'codebuddy', 76, '批量文本表处理，glm-5.1 中文和日文条目更稳'],
          [/修复|bug|崩溃|报错|损坏|卡死|闪退/i, 'claude', 84, '需要跨多个文件定位问题，Claude Code 在修复类任务上返工最少'],
          [/界面|ui|手柄|按钮|菜单|布局/i, 'claude', 72, '界面脚本改动；Codex 更合适但登录已过期，先推荐 Claude Code'],
        ];
        const [, ag, p, why] = rules.find(([re]) => re.test(text)) || [null, 'claude', 66, '通用代码任务，按最近 30 天这个项目的成功率选择'];
        rec.innerHTML = `<div class="rec-box">${judge({ kind: 'agent', text: `推荐 Agent：${agentModels[ag][0]}`, prob: p, why })}
          <button class="btn sm" type="button" data-wired="1" data-adopt="${ag}" ${$('#nt-a', d).value === ag ? 'disabled' : ''}>${$('#nt-a', d).value === ag ? '已采用推荐' : '采用推荐'}</button></div>`;
      };
      $('#nt-d', d).addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(recommend, 300); });
      $('#nt-p', d).addEventListener('change', recommend);
      $('#nt-a', d).addEventListener('change', recommend);
      rec.addEventListener('click', (e) => {
        const b = e.target.closest('[data-adopt]'); if (!b) return;
        $('#nt-a', d).value = b.dataset.adopt; fill(); recommend();
        toast(`已采用推荐：${agentModels[b.dataset.adopt][0]}`);
      });
      $('#nt-d', d).focus();
    },
    actions: [{ label: '取消' }, {
      label: '派发', kind: 'primary', onClick(d) {
        const text = $('#nt-d', d).value.trim();
        if (!text) { $('#nt-d', d).focus(); toast('先写一句要做什么', 'attn'); return false; }
        const proj = $('#nt-p', d).value, ag = $('#nt-a', d).value, group = $('#nt-g', d).value || undefined;
        SB.addTask({ proj, ag, title: text, group });
        toast(`已派发到「${esc(proj)}」${group ? `，分组“${esc(SB.groupName(group))}”` : ''}：${esc(text)}<br>${agentModels[ag][0]} 有空位后自动开始。`);
      },
    }],
  });

  const palette = () => {
    const items = [
      ['工作台（对话）', 'workbench.html', '页面'], ['任务看板', 'kanban.html', '页面'],
      ['资产预览', 'asset-mode.html', '页面'], ['生成', 'generate.html', '页面'], ['自动化', 'automations.html', '页面'], ['监控', 'monitor.html', '页面'], ['Agent 管理', 'agents.html', '页面'],
      ...sidebarRows().map((a) => [$('.t', a).textContent, a.getAttribute('href'), $('.status', a).textContent.trim()]),
      ['新建任务…', '#new', '操作'], ['切换日间/夜间模式', '#theme', '操作'],
    ];
    let sel = 0;
    modal({
      title: '搜索',
      body: `<label for="pal-q" class="sr-only">搜索任务、页面或操作</label>
        <input class="input" id="pal-q" style="width:100%;box-sizing:border-box" placeholder="搜索任务、页面或操作，↑↓ 选择，Enter 打开" autocomplete="off">
        <ul class="palette-list" role="listbox" aria-label="搜索结果"></ul>`,
      actions: [{ label: '关闭' }],
      onOpen(d) {
        const q = $('#pal-q', d), ul = $('.palette-list', d);
        const go = (it) => {
          d.close();
          if (it[1] === '#new') newTask();
          else if (it[1] === '#theme') $('[data-action="theme"]')?.click();
          else location.href = it[1];
        };
        const render = () => {
          const list = items.filter((it) => it[0].toLowerCase().includes(q.value.trim().toLowerCase()));
          sel = Math.min(sel, Math.max(list.length - 1, 0));
          ul.innerHTML = list.length ? list.map((it, i) => `<li role="option" aria-selected="${i === sel}" data-i="${i}">${esc(it[0])}<span class="meta">${it[2]}</span></li>`).join('')
            : '<li aria-disabled="true" style="cursor:default;color:var(--fg-3)">没有找到</li>';
          $$('li[data-i]', ul).forEach((li) => li.addEventListener('click', () => go(list[+li.dataset.i])));
          return list;
        };
        let list = render();
        q.addEventListener('input', () => { sel = 0; list = render(); });
        q.addEventListener('keydown', (e) => {
          if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, list.length - 1); list = render(); e.preventDefault(); }
          if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); list = render(); e.preventDefault(); }
          if (e.key === 'Enter' && list[sel]) { e.preventDefault(); go(list[sel]); }
        });
        q.focus();
      },
    });
  };

  const settings = () => modal({
    title: '设置',
    body: `<label class="check-row"><input type="checkbox" checked> <span>任务完成或需要审批时发系统通知<small>托盘图标同时显示数量</small></span></label>
      <label class="check-row"><input type="checkbox" checked> <span>有任务运行时阻止电脑休眠</span></label>
      <label class="check-row"><input type="checkbox" id="lan"> <span>允许局域网内其他设备访问<small>只在“专用网络”下可开启；开启时 Windows 会请求一次管理员确认</small></span></label>
      <div id="lan-info" hidden class="alert info" style="margin:0 0 var(--sp-3)">${ic('devices')}<div class="body"><strong>局域网地址：http://192.168.1.23:17890</strong><p>新设备打开这个地址后，输入电脑上显示的配对码 <b class="mono">482 913</b>（2 分钟内有效）。</p></div></div>
      <label class="check-row"><input type="checkbox" id="ho-confirm"> <span>交接前让我确认<small>默认关闭：切换到其他 Agent 时自动生成、校验并发送交接内容，事后可在对话里查看和撤销</small></span></label>
      <div class="form-row"><label for="th-mode">思考过程</label><select class="select" id="th-mode"><option value="collapsed">显示，默认折叠（推荐）</option><option value="open">显示，默认展开</option><option value="hidden">不显示</option></select></div>
      <div class="form-row"><label for="cc-all">并发上限</label><select class="select" id="cc-all"><option>每个 Agent 1 个</option><option selected>每个 Agent 2 个</option><option>每个 Agent 3 个</option></select></div>
      <div class="form-row"><label for="clean">清理</label><select class="select" id="clean"><option>合并或丢弃 3 天后清理工作副本</option><option selected>7 天后清理</option><option>30 天后清理</option></select></div>
      <h3 class="dlg-sec">${ic('gauge')}快速判断</h3>
      <p>用一个便宜的模型只返回“结论 + 概率 + 一句依据”，不写长段文字。结果出现在审批卡片、新建任务、任务完成和监控页，每处都可以点 [不同意]，你的纠正会用来调整阈值。</p>
      <fieldset class="fs"><legend>判断引擎</legend>
        <label class="check-row"><input type="radio" name="jeng" value="account"> <span>已有账号或 API 的便宜模型（默认）<small>用结构化输出返回判断。不用下载，但会消耗所选账号的额度，每次判断约几百 token</small></span></label>
        <div class="form-row sub-row" id="j-acc-row"><label for="j-acc">账号与模型</label><select class="select" id="j-acc">
          <option value="claude|工作室 API Key|Haiku 5.5">Claude Code · 工作室 API Key · Haiku 5.5（便宜）</option>
          <option value="codebuddy|CodeBuddy 账号|deepseek-v3-2">CodeBuddy · CodeBuddy 账号 · deepseek-v3-2（便宜）</option>
          <option value="claude|个人订阅|Sonnet 5">Claude Code · 个人订阅 · Sonnet 5</option>
          <option value="codebuddy|CodeBuddy 账号|glm-5.1">CodeBuddy · CodeBuddy 账号 · glm-5.1</option></select></div>
        <label class="check-row"><input type="radio" name="jeng" value="local"> <span>本机小模型<small>在这台电脑上运行，判断内容不出网。需要先下载模型文件（约 1.1 GB），运行时约占 1.2 GB 内存</small></span></label>
        <div class="form-row sub-row" id="j-local-row"><span class="lbl">模型文件</span><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span id="j-local-st" class="status idle"><span class="dot"></span>还没下载</span><button type="button" class="btn sm" data-wired="1" id="j-dl">${ic('download')}下载模型文件</button></div></div>
        <label class="check-row"><input type="radio" name="jeng" value="jev"> <span>Jev API（TypeSafe AI）<small>专门做带概率的结构化判断，响应最快；需要 API Key</small></span></label>
        <div id="j-jev" class="sub-row">
          <div class="alert attn" style="margin:0 0 var(--sp-3)">${ic('warn')}<div class="body"><strong>判断的内容会发到 TypeSafe AI 的服务器</strong><p>包括审批里的命令和路径、任务描述、对话摘要。不想发送的项目可以在下面关掉，这些项目会改用已有账号的模型判断。</p></div></div>
          <div class="form-row"><label for="j-key">API Key</label><input class="input" id="j-key" type="password" autocomplete="off" placeholder="粘贴 Jev API Key，保存在 Windows 凭据管理器"></div>
          <div class="form-row" style="align-items:start"><span class="lbl">按项目</span><div id="j-projs">${SB.projects.map((p) => `<label class="check-row" style="margin-bottom:4px"><input type="checkbox" value="${esc(p.name)}"> <span>${esc(p.name)} 使用 Jev</span></label>`).join('')}</div></div>
        </div>
      </fieldset>
      <fieldset class="fs"><legend>要做哪些判断</legend>
        ${Object.entries(judgeKinds).map(([k, n]) => `<label class="check-row"><input type="checkbox" data-jk="${k}"> <span>${n}<small>${{ risk: '审批卡片上显示风险高低和依据', agent: '新建任务时推荐 Agent', done: '任务完成时对照验收标准判断完成度', stuck: '监控页标出可能卡住或原地打转的任务', grade: '给自动化的运行结果分严重程度，用来决定要不要通知你' }[k]}</small></span></label>`).join('')}
      </fieldset>
      <fieldset class="fs"><legend>新任务的默认值</legend>
        <label class="check-row"><input type="checkbox" id="j-auto"> <span>开启“低风险自动允许”<small>每个任务都可以在输入框下方单独关掉。只放行判断为低风险、把握度 ≥ 90%、且只作用于工作副本内的操作；永远不会越过“始终禁止”清单</small></span></label>
      </fieldset>`,
    onOpen(d) {
      $('#lan', d).addEventListener('change', (e) => { $('#lan-info', d).hidden = !e.target.checked; });
      try { $('#th-mode', d).value = localStorage.getItem('aic-thought') || 'collapsed'; $('#ho-confirm', d).checked = localStorage.getItem('aic-handoff-confirm') === '1'; } catch (e) { /* 忽略 */ }
      const c = judgeCfg();
      $(`input[name="jeng"][value="${c.engine}"]`, d).checked = true;
      $('#j-acc', d).value = c.account;
      if (c.jevKey) $('#j-key', d).placeholder = `已保存，结尾 …${c.jevKey}。留空则不修改`;
      $$('#j-projs input', d).forEach((i) => { i.checked = !c.jevOff.includes(i.value); });
      $$('[data-jk]', d).forEach((i) => { i.checked = c.on[i.dataset.jk] !== false; });
      $('#j-auto', d).checked = c.autoAllowDefault;
      let localReady = c.localReady;
      const showLocal = () => {
        $('#j-local-st', d).className = 'status ' + (localReady ? 'ok' : 'idle');
        $('#j-local-st', d).innerHTML = `<span class="dot"></span>${localReady ? '已下载（1.1 GB）' : '还没下载'}`;
        $('#j-dl', d).hidden = localReady;
      };
      showLocal();
      $('#j-dl', d).addEventListener('click', (e) => {
        const b = e.currentTarget; let p = 0; b.setAttribute('aria-busy', 'true');
        const t = setInterval(() => { p += 25; b.textContent = `下载中 ${p}%`; if (p >= 100) { clearInterval(t); b.removeAttribute('aria-busy'); localReady = true; showLocal(); toast('本机小模型已下载，判断内容不会出网'); } }, 350);
      });
      d.aicLocalReady = () => localReady;
      const sync = () => {
        const eng = $('input[name="jeng"]:checked', d).value;
        $('#j-jev', d).hidden = eng !== 'jev';
        $('#j-acc-row', d).hidden = eng !== 'account';
        $('#j-local-row', d).hidden = eng !== 'local';
        const risk = $('[data-jk="risk"]', d).checked;
        $('#j-auto', d).disabled = !risk;
        if (!risk) $('#j-auto', d).checked = false;
      };
      $$('input[name="jeng"], [data-jk="risk"]', d).forEach((i) => i.addEventListener('change', sync)); sync();
    },
    actions: [{ label: '取消' }, { label: '保存', kind: 'primary', onClick(d) {
      const eng = $('input[name="jeng"]:checked', d).value;
      const keyIn = $('#j-key', d).value.trim();
      if (eng === 'jev' && !keyIn && !judgeCfg().jevKey) { toast('选 Jev API 时需要先填 API Key', 'attn'); $('#j-key', d).focus(); return false; }
      const localReady = d.aicLocalReady();
      if (eng === 'local' && !localReady) { toast('先下载本机小模型的模型文件，或者换一个判断引擎', 'attn'); $('#j-dl', d).focus(); return false; }
      try { localStorage.setItem('aic-thought', $('#th-mode', d).value); localStorage.setItem('aic-handoff-confirm', $('#ho-confirm', d).checked ? '1' : '0'); } catch (e) { /* 忽略 */ }
      judgeSave({
        engine: eng, account: $('#j-acc', d).value, jevKey: keyIn ? keyIn.slice(-4) : judgeCfg().jevKey, // 原型只记末四位；正式版把密钥存进 Windows 凭据管理器
        jevOff: $$('#j-projs input', d).filter((i) => !i.checked).map((i) => i.value),
        on: Object.fromEntries($$('[data-jk]', d).map((i) => [i.dataset.jk, i.checked])),
        autoAllowDefault: $('#j-auto', d).checked, localReady,
      });
      window.aicApplyThoughtMode?.();
      document.dispatchEvent(new CustomEvent('aic-judge-change'));
      toast(`设置已保存。快速判断引擎：${engines[eng]}`);
    } }],
  });

  wire($('.sb-new'))?.addEventListener('click', () => newTask());

  // ---------- 项目与分组：新建任务、更多菜单、添加项目、新建分组、移动任务 ----------
  const nameDialog = ({ title, label, value = '', hint = '', ok, onSave }) => modal({
    title,
    body: `<div class="form-row"><label for="nd-n">${label}</label><input class="input" id="nd-n" value="${esc(value)}" placeholder="例如：本周上线、美术资源、Bug 修复"></div>${hint ? `<p style="margin:0;color:var(--fg-3)">${hint}</p>` : ''}`,
    onOpen(d) { const i = $('#nd-n', d); i.select(); i.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('.dlg-foot .btn.primary', d).click(); }); },
    actions: [{ label: '取消' }, { label: ok, kind: 'primary', onClick(d) { const v = $('#nd-n', d).value.trim(); if (!v) { $('#nd-n', d).focus(); return false; } onSave(v); } }],
  });
  const newGroup = (thenMoveId) => nameDialog({
    title: '新建分组', label: '分组名称', ok: '创建',
    hint: '分组和项目无关：不同项目的任务可以放进同一个分组。一个任务只能在一个分组里。',
    onSave(v) { const id = SB.addGroup(v); if (thenMoveId) SB.moveTask(thenMoveId, id); toast(`已创建分组“${esc(v)}”${thenMoveId ? '，并移入了任务' : ''}`); },
  });
  const projMenu = (btn, sec) => {
    const name = sec.dataset.name, path = sec.dataset.path;
    window.aicMenu(btn, [
      ['在这个项目里新建任务', () => newTask({ proj: name })],
      ['在资源管理器中打开', () => toast(`会在资源管理器中打开 ${esc(path)}`, 'demo')],
      ['在 IDE 中打开', () => toast(`会用 VS Code 打开 ${esc(path)}`, 'demo')],
      ['项目设置（默认 Agent、权限规则、项目记忆）', () => toast('项目设置页原型未包含', 'demo')],
      ['只看这个项目，折叠其他', () => SB.solo(sec.dataset.key)],
      ['重命名', () => nameDialog({ title: '重命名项目', label: '名称', value: name, ok: '保存', hint: '只改工作台里的显示名称，不改文件夹名。',
        onSave(v) { SB.renameProject(name, v); toast(`已重命名为“${esc(v)}”`); } })],
      ['从列表中移除…', () => modal({ title: `移除“${esc(name)}”？`, body: `<p>只是从工作台的项目列表里移除，<b>不会删除</b> ${esc(path)} 里的任何文件。</p><p style="margin:0">这个项目还有运行中的任务时，需要先停止它们。</p>`,
        actions: [{ label: '取消' }, { label: '移除', kind: 'danger', onClick() { SB.removeProject(name); toast(`已移除“${esc(name)}”，文件夹没有改动`); } }] }), 'danger'],
    ]);
  };
  const groupMenu = (btn, sec) => {
    const id = sec.dataset.key.slice(2), name = sec.dataset.name;
    window.aicMenu(btn, [
      ['在这个分组里新建任务', () => newTask({ group: id })],
      ['只看这个分组，折叠其他', () => SB.solo(sec.dataset.key)],
      ['重命名分组', () => nameDialog({ title: '重命名分组', label: '分组名称', value: name, ok: '保存', onSave(v) { SB.renameGroup(id, v); toast(`已重命名为“${esc(v)}”`); } })],
      ['删除分组…', () => modal({ title: `删除分组“${esc(name)}”？`, body: '<p>只删除这个分组，里面的任务不会删除，会回到“未分类”。</p>',
        actions: [{ label: '取消' }, { label: '删除分组', kind: 'danger', onClick() { SB.deleteGroup(id); toast(`已删除分组“${esc(name)}”，任务移到了“未分类”`); } }] }), 'danger'],
    ]);
  };
  const taskMenu = (anchor, id) => {
    const cur = SB.assign[id];
    const items = SB.groups.filter((g) => g.id !== cur).map((g) => [`移到分组“${g.name}”`, () => { SB.moveTask(id, g.id); toast(`已移到分组“${esc(g.name)}”`); }]);
    items.push(['新建分组并移入…', () => newGroup(id)]);
    if (SB.groupName(cur)) items.push(['移出分组（回到未分类）', () => { SB.moveTask(id, null); toast('已移到“未分类”'); }]);
    window.aicMenu(anchor, items);
  };
  const addProject = () => modal({
    title: '添加项目',
    body: `<p>选择本机的一个项目文件夹，之后就能在这个项目里派发任务。</p>
      <div class="form-row"><label>文件夹</label><div style="display:flex;gap:8px;min-width:0"><input class="input" id="ap-path" placeholder="还没有选择" readonly style="flex:1;min-width:0"><button class="btn" id="ap-pick" type="button">${icon('folder')}选择文件夹…</button></div></div>
      <div class="form-row"><label for="ap-name">显示名称</label><input class="input" id="ap-name" placeholder="默认用文件夹名"></div>
      <div id="ap-detect" hidden class="alert info" style="margin:0">${icon('info')}<div class="body"><strong>检测结果</strong><p>是 git 仓库，当前分支 main；检测到 Unity 项目（6000.0.32f1）。任务会在独立工作副本里运行。</p></div></div>`,
    onOpen(d) {
      $('#ap-pick', d).addEventListener('click', () => {
        // 原型：模拟系统文件夹对话框的结果
        $('#ap-path', d).value = 'D:\\Games\\StarForge';
        $('#ap-name', d).placeholder = 'StarForge';
        $('#ap-detect', d).hidden = false;
      });
    },
    actions: [{ label: '取消' }, { label: '添加', kind: 'primary', onClick(d) {
      const path = $('#ap-path', d).value;
      if (!path) { toast('先选择一个文件夹', 'attn'); $('#ap-pick', d).focus(); return false; }
      const name = $('#ap-name', d).value.trim() || 'StarForge';
      SB.addProject({ name, path, kind: 'Unity 项目 · git' });
      toast(`已添加项目“${esc(name)}”`);
    } }],
  });
  const sb = $('.sidebar');
  sb?.addEventListener('click', (e) => {
    const sec = e.target.closest('.proj');
    const tm = e.target.closest('[data-task-menu]');
    if (tm) { e.preventDefault(); taskMenu(tm, tm.dataset.taskMenu); return; }
    if (e.target.closest('[data-sec-new]')) newTask(sec.dataset.kind === 'proj' ? { proj: sec.dataset.name } : { group: sec.dataset.key.slice(2) });
    else if (e.target.closest('[data-sec-menu]')) (sec.dataset.kind === 'proj' ? projMenu : groupMenu)(e.target.closest('[data-sec-menu]'), sec);
    else if (e.target.closest('[data-sec-add]')) (SB.view === 'project' ? addProject() : newGroup());
  });
  // 右键任务也能打开同一个菜单
  sb?.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.task-row'); if (!row) return;
    e.preventDefault(); taskMenu(row, row.dataset.id);
  });
  const sbSearch = $$('.sidebar .sb-item').find((b) => b.getAttribute('aria-label') === '搜索');
  wire(sbSearch)?.addEventListener('click', palette);
  $$('a[aria-label^="设置"], .bottomnav a[aria-label="设置"]').forEach((a) => {
    wire(a); a.addEventListener('click', (e) => { e.preventDefault(); settings(); });
  });
  document.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || e.shiftKey || document.querySelector('dialog[open]')) return;
    const k = e.key.toLowerCase();
    if (k === 'k') { e.preventDefault(); palette(); }
    if (k === 'n') { e.preventDefault(); newTask(); }
  });

  // 共享给页面脚本
  Object.assign(window, { aicMenu: menu, aicWire: wire, aicHhmm: hhmm, aicEsc: esc, aicSettings: settings, aicNewTask: newTask });
})();

// ---------- 对话流：思考过程、工具详情、切换器、发消息、交接 ----------
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const { aicToast: toast, aicModal: modal, aicWire: wire, aicHhmm: hhmm, aicEsc: esc, aicAgents: agents } = window;
  const ic = (n) => window.icon(n);
  const page = document.body.dataset.page;
  const letter = { claude: 'C', codex: 'X', codebuddy: 'B', zcode: 'Z' };
  const stream = $('.stream');
  const inner = $('.stream-inner');
  const scrollEnd = () => { if (stream) stream.scrollTop = stream.scrollHeight; };
  const add = (html) => { inner.insertAdjacentHTML('beforeend', html); scrollEnd(); return inner.lastElementChild; };

  // ---------- 思考过程 ----------
  // 显示方式由设置决定：collapsed（默认折叠）/ open（默认展开）/ hidden（不显示）
  const thoughtMode = () => { try { return localStorage.getItem('aic-thought') || 'collapsed'; } catch (e) { return 'collapsed'; } };
  const applyThoughtMode = () => {
    const m = thoughtMode();
    document.documentElement.dataset.thought = m;
    $$('details.thought').forEach((d) => { d.open = m === 'open'; });
  };
  window.aicApplyThoughtMode = applyThoughtMode;
  const thoughtHtml = (text, secs) => `<details class="thought"><summary>${ic('bulb')}<span class="tl">思考了 ${secs} 秒</span>${ic('right')}</summary><div class="thought-body">${text}</div></details>`;
  // 一轮回复（design.md 15.2）：过程（思考等）收进可折叠的“用时 N 秒”，最终回答显示在下面
  const processHtml = (inner, secs) => `<details class="process"><summary><span class="pl">用时 ${secs} 秒</span>${ic('right')}</summary><div class="process-body">${inner}</div></details>`;
  const agentMsg = (key, model, html, thought, secs = 3) => `<article class="msg turn" aria-label="${agents[key][0]} 的回复"><div class="who"><span class="ag ${key}" title="${agents[key][0]}">${letter[key]}</span></div><div>
    <div class="head"><b>${agents[key][0]}</b><span>${model}${window.aicCur && window.aicCur.agent === key && window.aicCur.effort ? ' · 思考 ' + window.aicCur.effort : ''}</span><span>${hhmm()}</span></div>${thought ? processHtml(thoughtHtml(thought, secs), secs) : ''}<div class="text answer md">${html}</div></div></article>`;
  const userMsg = (text) => `<article class="msg user"><div class="who"><span class="me">黄</span></div><div>
    <div class="head"><b>你</b><span>今天 ${hhmm()}</span></div><div class="text"><p>${esc(text)}</p></div></div></article>`;
  const sysnote = (text, kind = '') => `<div class="sysnote" role="note" data-kind="${kind}"><span>${ic('swap')}${text}</span></div>`;
  // 连续切换时只保留最后一条记录：对话末尾已经是同类切换记录（中间没有新消息）就替换它
  const addNote = (text, kind) => {
    const last = inner.lastElementChild;
    if (last && last.classList.contains('sysnote') && last.dataset.kind === kind) { last.outerHTML = sysnote(text, kind); return inner.lastElementChild; }
    return add(sysnote(text, kind));
  };

  // 页面上已有的 Agent 消息补上思考过程（原型示例内容）
  const staticThoughts = {
    workbench: [
      ['日志里两条时间戳只差 40 毫秒：Save 开始写入，云同步开始上传。WriteAllText 会先把文件截断成 0 字节再写，上传读到的正好是这个空文件。再搜一下项目里还有哪些地方直接覆盖写。', 6],
      ['交接包里的约束是不改存档格式。Windows 上原子替换用 File.Replace 最稳，还会顺带留 .bak；Steam Deck 跑的是 Proton，Wine 也支持这个调用。读取端要能识别空文件或解析失败，然后回退。', 9],
      ['编译通过不代表逻辑对。最关键的两条：老格式能读，写到一半中断时能回退。EditMode 测试能覆盖，但要调用 Unity.exe，这一步需要审批。', 4],
    ],
    assets: [
      ['面数上限 1000。箱盖 20 段大约 160 个三角面，每道铁箍 48，拉环 64，总数能控制在 500 以内。材质名不能变，脚本里只改网格，不动材质槽。', 7],
      ['LOD1 取一半面数，用 Decimate 的 collapse 模式，勾选保留 UV 接缝，避免贴图错位。', 3],
    ],
  }[page] || [];
  $$('.msg:not(.user)', inner || document).forEach((m, i) => {
    const t = staticThoughts[i];
    if (t && !$('.thought', m)) $('.text', m).insertAdjacentHTML('beforebegin', thoughtHtml(t[0], t[1]));
  });
  applyThoughtMode();

  // 逐字显示思考，结束后折叠成“思考了 N 秒”，再显示回答
  // opts（可选）：into 写入的容器（默认主对话）；scroller 要跟着滚动的元素（默认 into 自己）；label 覆盖头部的模型文字
  const streamReply = (key, model, thought, answerHtml, done, opts = {}) => {
    let el, scrollEnd = () => { if (stream) stream.scrollTop = stream.scrollHeight; };
    if (opts.into) {
      const sc = opts.scroller || opts.into;
      scrollEnd = () => { sc.scrollTop = sc.scrollHeight; };
      opts.into.insertAdjacentHTML('beforeend', agentMsg(key, model, '', thought ? ' ' : '', 0));
      el = opts.into.lastElementChild; scrollEnd();
    } else el = add(agentMsg(key, model, '', thought ? ' ' : '', 0));
    if (opts.label) $('.head span', el).textContent = opts.label;
    const d = $('.thought', el), body = $('.thought-body', el), label = $('.tl', el);
    const proc = $('.process', el), pl = proc && $('.pl', proc);
    const start = Date.now();
    if (proc) { proc.open = true; pl.textContent = '正在处理'; pl.classList.add('thinking'); }
    const finish = () => {
      $('.text.answer', el).innerHTML = answerHtml;
      if (proc) { pl.classList.remove('thinking'); pl.textContent = `用时 ${Math.max(1, Math.round((Date.now() - start) / 1000))} 秒`; if (!proc.dataset.user) proc.open = false; }
      scrollEnd(); if (done) done(el);
    };
    if (!d) { setTimeout(finish, 600); return el; }
    d.open = thoughtMode() !== 'hidden';
    label.textContent = '正在思考';
    label.classList.add('thinking');
    body.textContent = '';
    let i = 0;
    const timer = setInterval(() => {
      i += 2; body.textContent = thought.slice(0, i); scrollEnd();
      if (i >= thought.length) {
        clearInterval(timer);
        label.classList.remove('thinking');
        label.textContent = `思考了 ${Math.max(1, Math.round((Date.now() - start) / 1000))} 秒`;
        d.open = thoughtMode() === 'open';
        finish();
      }
    }, 30);
    return el;
  };
  // 回复里的链接只显示文字；正式版点击后经 Platform.openExternal 在系统浏览器里打开，原型只给出提示
  document.addEventListener('click', (e) => {
    const a = e.target.closest('.md a[href^="http"]'); if (!a) return;
    e.preventDefault();
    toast(`正式版会在系统浏览器里打开：${esc(a.href)}`);
  });
  // 用户手动开合过程后，以用户为准，不再自动收起
  document.addEventListener('click', (e) => {
    const sm = e.target.closest('details.process > summary'); if (!sm) return;
    if (sm.parentElement.dataset.pending) { e.preventDefault(); toast('有待处理的审批，处理完之前过程保持展开'); return; }
    sm.parentElement.dataset.user = '1';
  });
  Object.assign(window, { aicAdd: add, aicAgentMsg: agentMsg, aicSysnote: sysnote, aicStreamReply: streamReply });

  // 折叠的工具调用补上详情内容，展开后不再是空的
  $$('details.tool').forEach((d) => {
    if ($('.detail', d) || d.classList.contains('search-group')) return;
    const verb = $('.verb', d)?.textContent || '';
    const target = $('.target', d)?.textContent || '';
    let body;
    if (verb.includes('搜索')) body = `<pre>Assets/Scripts/Save/SaveManager.cs:44        File.WriteAllText(SavePath, json);
Assets/Scripts/Save/SettingsStore.cs:31      File.WriteAllText(path, text);
Assets/Editor/BuildReport.cs:88              File.WriteAllText(reportPath, html);
Assets/Scripts/Debug/LogDump.cs:19           File.WriteAllText(dumpPath, log);</pre>`;
    else if (verb.includes('读取')) body = `<pre>已读取完整文件（内容只给 Agent，不在对话里展开）。
关键位置：第 41–45 行 Save()，第 58–60 行 Load()。</pre>`;
    else if (verb.includes('新建') || verb.includes('修改')) body = `<pre>${esc(target)}
改动已写入工作副本，完整内容见右侧“改动”面板。</pre>`;
    else body = `<pre>&gt; ${esc(target)}
完成，用时 ${$('.end', d)?.textContent.trim() || '数秒'}。输出共 32 行，已折叠。</pre>`;
    d.insertAdjacentHTML('beforeend', `<div class="detail">${body}<div class="foot">原型示例输出<span class="grow"></span>
      ${$('#p-diff') ? '<button class="btn sm ghost" data-action="side" data-tab="t-diff">在改动面板中查看</button>' : ''}</div></div>`);
  });
  // 复制输出
  $$('.tool .foot .btn').forEach((b) => {
    if (!b.textContent.includes('复制')) return;
    wire(b).addEventListener('click', () => {
      const t = b.closest('.detail').querySelector('pre')?.textContent || '';
      navigator.clipboard?.writeText(t).then(() => toast('已复制输出'), () => toast('浏览器不允许写剪贴板，请手动选择复制', 'attn'));
    });
  });

  // ---------- 交接包（内容随页面上的示例任务变化） ----------
  const ctx = page === 'assets' ? {
    goal: '- chest.glb：箱盖改成更圆的弧度，加三道铁箍，锁扣下加拉环\n- 约束：三角面 1000 以内；材质名 M_Chest_Wood、M_Chest_Iron 不能改（Unity 已绑定）',
    state: '- 箱盖 20 段，铁箍和拉环已加，当前 404 个三角面\n- LOD1 还没生成',
    decisions: '- 用 Blender 脚本批处理，不手工改：可重复执行，方便以后调参数',
    files: '- Assets/Art/Props/Chest/chest.glb  412 KB → 486 KB\n- scripts/chest_rework.py  新增',
    cmds: '- blender --background --python scripts/chest_rework.py → 成功（14 秒）',
    memory: '- 道具模型导出 glb 时 +Y 朝上，单位米',
    talk: (f) => `- 你：箱盖太方了……面数控制在 1000 以内，材质名不要改\n- ${f}：接下来生成 LOD1，目标是当前面数的 50%`,
    next: '1. 生成 LOD1（约 200 个三角面）\n2. 在 Unity 里确认材质绑定没变',
    resume: '我从“下一步”继续：先生成 LOD1。',
  } : {
    goal: '- 修复 Steam Deck 上退出游戏后存档偶发变成空文件\n- 约束：不改存档格式，老存档必须能读',
    state: '- 写入已改为"临时文件 → 落盘 → 原子替换"，读取失败时回退 .bak\n- 编译通过；EditMode 测试待执行',
    decisions: '- 用 File.Replace 原子替换：同一磁盘上是原子操作，并自动保留 .bak\n- 不加文件锁：Steam 云同步进程不认我们的锁',
    files: '- Assets/Scripts/Save/SaveManager.cs  +23 −4  原子写入、回退读取\n- Assets/Tests/EditMode/SaveManagerTests.cs  +46  新增测试\n- Assets/Scripts/Platform/SteamCloudSync.cs  +3 −2  上传前等写入完成',
    cmds: '- dotnet build FogHarbor.sln → 失败（缺 using System.Text），已修复\n- dotnet build FogHarbor.sln → 成功',
    memory: '- Steam Deck 上存档在 compatdata 目录，测试时用 SaveManager.OverridePath',
    talk: (f) => `- 你：先查原因，修复时不要改存档格式，老存档必须能读\n- ${f}：编译通过，接下来跑存档相关的 EditMode 测试`,
    next: '1. 运行 SaveManagerTests（需要审批）\n2. 云同步上传前等待写入完成',
    resume: '我从“下一步”继续：先运行 SaveManagerTests。',
  };
  const buildPkg = (from, to) => `# 交接：从 ${from} 到 ${to}

## 任务目标与约束
${ctx.goal}

## 当前状态
${ctx.state}

## 关键决策与原因
${ctx.decisions}

## 已改动文件
${ctx.files}

## 执行过的命令与结果
${ctx.cmds}

## 相关项目记忆
${ctx.memory}

## 最近对话（工具输出已折叠成一行）
${ctx.talk(from)}

## 下一步
${ctx.next}

> 上面的工具调用都已执行完毕，代码以工作区当前文件为准，请勿重复执行。
> 更多细节见 .aic/TASK.md，必要时可以读取。`;
  const tokens = (s) => { let a = 0, n = 0; for (const ch of s) (ch.charCodeAt(0) < 128 ? a++ : n++); return Math.round((a / 4 + n) * 1.15); };

  // ---------- 自动交接（design.md 7.5）：默认不弹窗，后台生成、校验、发送；事后可查看、切回、重新交接 ----------
  const confirmFirst = () => { try { return localStorage.getItem('aic-handoff-confirm') === '1'; } catch (e) { return false; } };
  const extra = page === 'assets' ? {
    level: 'H2', levelName: '全量转写', why: '会话较短，完整转写只占新模型窗口的 9%',
    userMessages: ['chest.glb 的箱盖太方了，改成更圆的弧度；箱子上加三道铁箍，锁扣下面加个拉环。面数控制在 1000 以内，材质名不要改，Unity 里已经绑了。'],
    corrections: ['材质名 M_Chest_Wood、M_Chest_Iron 不能改（你在第一条消息里要求）'],
    attempts: [],
    vcs: '分支 aic/t7c3-chest-rework，基于 main；未提交：chest.glb、scripts/chest_rework.py',
    tests: '无测试命令；面数检查：404 个三角面（上限 1000）',
    env: 'Blender 4.2（后台模式）',
    probes: [['改了哪些文件', 'chest.glb、scripts/chest_rework.py', true], ['当前三角面数', '404', true], ['不能改什么', '材质名', true], ['下一步', '生成 LOD1', true]],
    fixed: ['补上未提交文件 scripts/chest_rework.py'],
    readFirst: 'scripts/chest_rework.py',
    goal: '把 chest.glb 改圆、加铁箍和拉环，面数 1000 以内', next: '生成 LOD1（约 200 个三角面）',
  } : {
    level: 'H3', levelName: '结构化交接', why: '完整转写约占新模型窗口的 41%，超过 35% 的门槛',
    userMessages: ['有玩家反馈：在 Steam Deck 上退出游戏后再打开，存档有时变成空文件，只能从头开始。日志附上了。先查原因，修复时不要改存档格式，老存档必须能读。'],
    corrections: ['不改存档格式，老存档必须能读（第一条消息）', '不加文件锁（Claude Code 提出过，因 Steam 云同步进程不认我们的锁而放弃）'],
    attempts: ['加文件锁：放弃，Steam 云同步进程不认我们的锁', '第一次编译失败：缺 using System.Text，已修复'],
    vcs: '分支 aic/t8f2-fix-save-corrupt，基于 main；已改 3 个文件，均未提交',
    tests: 'dotnet build 成功；SaveManagerTests 尚未运行（等待审批）',
    env: 'Windows 11，Unity 6000.0.32f1，.NET SDK 8.0',
    probes: [['改了哪些文件', 'SaveManager.cs、SaveManagerTests.cs、SteamCloudSync.cs', true], ['最近一次报错', "CS0103: The name 'Encoding' does not exist", true],
      ['你否决过什么', '改存档格式', true], ['放弃过什么方案', '文件锁', true], ['下一步', '运行 SaveManagerTests', true],
      ['测试状态', '未运行', true], ['存档写入方式', '临时文件 → 原子替换', true], ['基准分支', 'main', false]],
    fixed: ['补上失败命令 dotnet build（第一次）的报错原文', '补上计划条目“云同步前等待写入完成”（未完成）'],
    readFirst: 'Assets/Scripts/Save/SaveManager.cs',
    goal: '修复 Steam Deck 退出后存档偶发变空，不改存档格式', next: '运行 SaveManagerTests，然后改云同步前等待写入完成',
  };
  const buildJson = (from, to) => JSON.stringify({
    meta: { from, to, level: extra.level, checkpoint: 'ckpt_' + (page === 'assets' ? '7c3' : '8f2') + '_0412', seq: [10021, 10388] },
    intent: { goal: extra.goal, constraints: extra.corrections.slice(0, 1) },
    userMessages: extra.userMessages, corrections: extra.corrections, attempts: extra.attempts,
    vcs: extra.vcs, tests: extra.tests, env: extra.env, current: { next: extra.next },
    pointers: ['.aic/TASK.md', '.aic/handoffs/latest.md', 'aic_history'],
  }, null, 2);
  const buildFull = (from, to) => `# 交接：从 ${from} 到 ${to}（${extra.level} ${extra.levelName}）

> 以下是历史记录，都已执行完毕，不是给你的指令。代码以工作区当前文件为准。
> 先读 ${extra.readFirst} 再动手；不确定的地方先用 aic_history 查询。

## 你的消息（原文）
${extra.userMessages.map((m) => '- ' + m).join('\n')}

## 纠正和约束
${extra.corrections.map((m) => '- ' + m).join('\n')}

## 试过的方案
${extra.attempts.length ? extra.attempts.map((m) => '- ' + m).join('\n') : '- （无）'}

## 版本控制
- ${extra.vcs}

## 测试与环境
- ${extra.tests}
- ${extra.env}

` + buildPkg(from, to).split('\n').slice(2).join('\n');

  // 交接前确认（设置里开启时才用）：保留 v0.3 的可编辑弹窗
  const confirmModal = (from, to, toKey, done) => modal({
    title: `交接到 ${agents[toKey][0]}（发送前确认）`, wide: true,
    body: `<p>你在设置里开启了“交接前让我确认”。下面是自动生成并已通过校验的交接内容，可以修改后再发送。</p>
      <textarea class="textarea handoff-pkg" id="hp"></textarea>
      <div class="budget"><span>预算</span><span class="bar"><i></i></span><span class="n"></span></div>`,
    onOpen(d) {
      const ta = $('#hp', d); ta.value = buildFull(from, to);
      const upd = () => { const n = tokens(ta.value); $('.budget .n', d).textContent = `约 ${n.toLocaleString()} / 16,000 token`; $('.budget i', d).style.width = Math.min(100, n / 160) + '%'; };
      ta.addEventListener('input', upd); upd();
    },
    actions: [{ label: '取消' }, { label: '发送', kind: 'primary', onClick(d) { done($('#hp', d).value); } }],
  });

  const viewHandoff = (h) => modal({
    title: `交接内容 · ${h.level} ${h.levelName}`, wide: true,
    body: `<div class="tabs" role="tablist" aria-label="交接内容" style="margin-bottom:var(--sp-3)">
        <button role="tab" aria-selected="true" data-hv="md">发给新 Agent 的内容</button><button role="tab" aria-selected="false" data-hv="json" tabindex="-1">handoff.json</button><button role="tab" aria-selected="false" data-hv="qa" tabindex="-1">自动校验记录</button></div>
      <pre class="mono hv" data-hv="md" style="white-space:pre-wrap;max-height:52vh;overflow:auto;margin:0">${esc(h.md)}</pre>
      <pre class="mono hv" data-hv="json" hidden style="white-space:pre-wrap;max-height:52vh;overflow:auto;margin:0">${esc(h.json)}</pre>
      <div class="hv" data-hv="qa" hidden>
        <dl class="kv"><dt>选用级别</dt><dd>${h.level} ${h.levelName}：${h.why}</dd>
          <dt>覆盖校验</dt><dd>改动文件、失败命令、约束、未完成计划全部覆盖；自动补齐 ${h.fixed.length} 项：${h.fixed.map(esc).join('；')}</dd>
          <dt>一致性校验</dt><dd>提到的路径和命令都能在记录或工作区里找到</dd>
          <dt>探针问答</dt><dd>${h.probes.filter((p) => p[2]).length}/${h.probes.length} 通过（及格线 6/8）</dd></dl>
        <table class="mini-table"><thead><tr><th>问题</th><th>标准答案（来自记录）</th><th>结果</th></tr></thead><tbody>
          ${h.probes.map(([q, a, ok]) => `<tr><td>${esc(q)}</td><td>${esc(a)}</td><td>${ok ? '✓ 答对' : '✗ 答错，已补充进交接内容'}</td></tr>`).join('')}</tbody></table>
      </div>
      <p style="margin:var(--sp-3) 0 0;color:var(--fg-3)">文件：.aic/handoffs/${h.seq}.md、.aic/handoffs/${h.seq}.json</p>`,
    onOpen(d) {
      $$('[data-hv][role="tab"]', d).forEach((t) => t.addEventListener('click', () => {
        $$('[role="tab"]', d).forEach((x) => { x.setAttribute('aria-selected', String(x === t)); x.tabIndex = x === t ? 0 : -1; });
        $$('.hv', d).forEach((p) => { p.hidden = p.dataset.hv !== t.dataset.hv; });
      }));
    },
    actions: [{ label: '关闭' }],
  });

  // 主入口：返回一个 Promise 风格的回调。opts.stream=false 时（如看板）不在对话里显示进度
  window.aicHandoff = (fromKey, fromModel, toKey, toModel, onDone, opts = {}) => {
    const from = `${agents[fromKey][0]}（${fromModel}）`, to = `${agents[toKey][0]}（${toModel}）`;
    const h = { ...extra, fromKey, fromModel, toKey, toModel, seq: 10388 + Math.floor(Math.random() * 90), json: buildJson(from, to), md: buildFull(from, to) };
    const finish = (md) => { if (md) h.md = md; onDone(h); };
    if (confirmFirst()) return confirmModal(from, to, toKey, finish);
    if (opts.instant) { finish(); return; }
    if (opts.stream === false || !inner) { setTimeout(() => finish(), 900); return; }
    // 对话里显示一条进度分隔条，逐步打勾，完成后换成最终分隔条
    const steps = ['生成交接内容', `覆盖校验：自动补齐 ${h.fixed.length} 项`, '一致性校验', h.level === 'H3' ? `探针问答 ${h.probes.filter((p) => p[2]).length}/${h.probes.length}` : '探针问答（H2 无需）', `发送给 ${agents[toKey][0]}`];
    const el = add(`<div class="handoff running" role="group" aria-label="交接进行中"><div class="ho-run">${ic('swap')}<span>正在自动交接到 ${esc(to)}</span><span class="ho-steps" aria-live="polite"></span></div></div>`);
    let i = 0;
    const t = setInterval(() => {
      $('.ho-steps', el).textContent = steps.slice(0, i + 1).map((s) => '✓ ' + s).join('　');
      if (++i >= steps.length) { clearInterval(t); setTimeout(() => { el.remove(); finish(); }, 350); }
    }, 320);
  };

  window.aicHandoffDivider = (h) => `<div class="handoff auto" role="group" aria-label="交接" data-seq="${h.seq}">
    <details><summary>${ic('swap')}已自动交接：${agents[h.fromKey][0]}（${h.fromModel}）→ ${agents[h.toKey][0]}（${h.toModel}）<span class="ho-badge">${h.level} ${h.levelName}</span><span class="ho-badge ok">校验 ${h.level === 'H3' ? h.probes.filter((p) => p[2]).length + '/' + h.probes.length : '通过'}</span>${ic('right', 'chev')}</summary>
      <div class="summary-box">
        <dl class="kv" style="margin:0 0 var(--sp-3)"><dt>为什么选这一级</dt><dd>${esc(h.why)}</dd>
          <dt>自动补齐</dt><dd>${h.fixed.map(esc).join('；')}</dd>
          <dt>原样带过去</dt><dd>你的 ${h.userMessages.length} 条消息原文、${h.corrections.length} 条纠正和约束、改动文件、失败命令</dd>
          <dt>新 Agent 复述</dt><dd class="ho-restate">等待新 Agent 开始…</dd></dl>
        <div class="acts" style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn sm" data-wired="1" data-ho="view">查看交接内容</button>
          <button class="btn sm" data-wired="1" data-ho="back">切回 ${agents[h.fromKey][0]}</button>
          <button class="btn sm ghost" data-wired="1" data-ho="redo">重新交接…</button>
        </div>
      </div></details></div>`;
  const handoffs = {};
  window.aicRegisterHandoff = (h) => { handoffs[h.seq] = h; };
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ho]'); if (!b) return;
    const box = b.closest('.handoff'); const h = handoffs[box.dataset.seq]; if (!h) return;
    if (b.dataset.ho === 'view') viewHandoff(h);
    else if (b.dataset.ho === 'back') window.aicSwitchBack?.(h);
    else if (b.dataset.ho === 'redo') window.aicMenu(b, [
      ['强制完整转写（H2）后重新交接', () => toast('会用完整转写重新开一个新会话；当前新会话保留，可随时切回', 'demo')],
      ['修改交接内容后重新交接…', () => confirmModal(`${agents[h.fromKey][0]}（${h.fromModel}）`, `${agents[h.toKey][0]}（${h.toModel}）`, h.toKey, () => toast('已用修改后的内容重新交接；你的修改已记为纠正，下次交接会自动带上'))],
    ]);
  });

  // ---------- Agent / 账号 / 模型 / 思考强度 切换器（每个输入框都有） ----------
  const accounts = { claude: ['个人订阅', '工作室 API Key'], codex: ['ChatGPT 账号'], codebuddy: ['CodeBuddy 账号'], zcode: ['Z.AI 账号'] };
  const status = { claude: '空闲', codex: '登录已过期', codebuddy: '空闲', zcode: '未连接' };
  // 思考强度：Agent 通过 ACP 配置项提供时才可调；null 表示由模型自己决定
  const efforts = { claude: ['低', '中', '高', '最高'], codex: ['低', '中', '高'], codebuddy: null, zcode: null };
  // 按会话（每个任务）的开关：低风险自动允许（默认取设置）、测试通过后自动合并（默认关）
  const sessKey = document.body.dataset.task || page;
  const sess = {
    all() { try { return JSON.parse(localStorage.getItem('aic-sess') || '{}'); } catch (e) { return {}; } },
    get() { return { autoAllow: window.aicJudgeCfg().autoAllowDefault, autoMerge: false, ...(sess.all()[sessKey] || {}) }; },
    set(v) { const a = sess.all(); a[sessKey] = { ...sess.get(), ...v }; try { localStorage.setItem('aic-sess', JSON.stringify(a)); } catch (e) { /* 忽略 */ } },
  };
  Object.assign(window, { aicAccounts: accounts, aicEfforts: efforts, aicAgentStatus: status, aicSess: sess });
  const lastAgent = $$('.msg:not(.user)', inner || document).pop();
  const startKey = (lastAgent && Object.keys(letter).find((k) => $('.ag', lastAgent).classList.contains(k))) || 'claude';
  const cur = window.aicCur = page === 'workbench'
    ? { agent: 'claude', account: '个人订阅', model: 'Opus 5.5', effort: '高' }
    : { agent: startKey, account: accounts[startKey][0], model: $('.head span', lastAgent)?.textContent || agents[startKey][1][0], effort: efforts[startKey] ? '中' : null };

  $$('.compose-box').forEach((box) => {
    const bar = $('.compose-bar', box);
    let sw = $('.switcher', bar);
    if (!sw) {
      $('[aria-label="添加附件"]', bar).insertAdjacentHTML('afterend', `<div class="switcher" role="group" aria-label="当前 Agent、账号与模型">
        <button data-popover="pop-switch" aria-expanded="false"></button><button data-popover="pop-switch" aria-expanded="false" class="hide-narrow"></button><button data-popover="pop-switch" aria-expanded="false"></button></div>`);
      sw = $('.switcher', bar);
    }
    let pop = $('#pop-switch');
    if (!pop) {
      box.closest('.composer-inner').insertAdjacentHTML('beforeend', '<div class="popover" id="pop-switch" hidden role="dialog" aria-label="切换 Agent、账号、模型与思考强度" style="bottom: 110px; left: 32px;"></div>');
      pop = $('#pop-switch');
    }
    const btns = $$('button', sw);
    const render = () => {
      btns[0].innerHTML = `<span class="ag ${cur.agent}" aria-hidden="true" style="width:16px;height:16px;font-size:9px">${letter[cur.agent]}</span>${agents[cur.agent][0]}${ic('down')}`;
      btns[0].setAttribute('aria-label', '切换 Agent，当前 ' + agents[cur.agent][0]);
      btns[1].innerHTML = `<span class="muted">${cur.account}</span>${ic('down')}`;
      btns[1].setAttribute('aria-label', '切换账号，当前 ' + cur.account);
      btns[2].innerHTML = `${cur.model}${cur.effort ? `<span class="muted">· 思考 ${cur.effort}</span>` : ''}${ic('down')}`;
      btns[2].setAttribute('aria-label', `切换模型，当前 ${cur.model}${cur.effort ? '，思考强度' + cur.effort : ''}`);
      const opt = (kind, val, label, meta, sel) => `<div class="opt" role="option" tabindex="0" data-kind="${kind}" data-val="${val}" aria-selected="${sel}">${label}<span class="meta"${meta === '登录已过期' ? ' style="color:var(--attn)"' : ''}>${meta}</span></div>`;
      const ef = efforts[cur.agent];
      pop.innerHTML = `<div class="group-label">Agent（换 Agent 会生成交接包）</div>
        ${Object.keys(agents).map((k) => opt('agent', k, `<span class="ag ${k}">${letter[k]}</span>${agents[k][0]}`, k === cur.agent ? '当前' : status[k], k === cur.agent)).join('')}
        <div class="group-label">账号</div>
        ${accounts[cur.agent].map((a) => opt('account', a, a, a === cur.account ? '当前' : '恢复原会话（无损）', a === cur.account)).join('')}
        <div class="group-label">模型</div>
        ${agents[cur.agent][1].map((m) => opt('model', m, m, m === cur.model ? '当前' : '会话内切换（无损）', m === cur.model)).join('')}
        <div class="group-label">思考强度</div>
        ${ef ? `<div class="seg" role="radiogroup" aria-label="思考强度">${ef.map((e) => `<button role="radio" aria-checked="${e === cur.effort}" data-kind="effort" data-val="${e}">${e}</button>`).join('')}</div>`
          : `<div class="hint" style="margin-top:2px">${agents[cur.agent][0]} 的思考强度由模型自己决定，这里不能调。</div>`}
        <div class="hint">换模型、换账号、调思考强度都保留完整上下文。换到其他 Agent 会生成交接包并开启新会话，发送前可以检查和编辑。</div>`;
    };
    render();
    // 切回原会话：走原生恢复，可选恢复工作区到交接时的检查点
    window.aicSwitchBack = (h) => modal({
      title: `切回 ${agents[h.back.agent][0]}？`,
      body: `<p>会用原生恢复打开交接前的原会话，上下文完整保留。当前的 ${agents[h.toKey][0]} 会话也会保留。</p>
        <label class="check-row"><input type="checkbox" id="sb-ckpt"> <span>同时把工作区恢复到交接时的检查点<small>会撤销交接之后 ${agents[h.toKey][0]} 做的改动（可以再恢复回来）</small></span></label>`,
      actions: [{ label: '取消' }, { label: '切回', kind: 'primary', onClick(d) {
        const ck = $('#sb-ckpt', d).checked;
        Object.assign(cur, h.back); render();
        addNote(`已切回 ${agents[h.back.agent][0]}（${h.back.model}），恢复原会话，上下文完整保留${ck ? '；工作区已恢复到交接时的检查点' : ''}`, 'agent');
        toast(`已切回 ${agents[h.back.agent][0]}`);
      } }],
    });
    // 页面上已有的交接分隔条（示例数据）换成自动交接的样式
    const staticHo = inner && $('.stream-inner > .handoff');
    if (staticHo && page === 'workbench') {
      window.aicHandoff('codebuddy', 'glm-5.1', 'claude', 'Opus 5.5', (h) => {
        h.back = { agent: 'codebuddy', model: 'glm-5.1', account: accounts.codebuddy[0], effort: null };
        h.level = 'H2'; h.levelName = '全量转写'; h.why = '交接时会话只有 2 轮，完整转写只占新模型窗口的 6%';
        window.aicRegisterHandoff(h);
        staticHo.outerHTML = window.aicHandoffDivider(h);
        const r = $('.stream-inner > .handoff .ho-restate'); if (r) r.textContent = '目标：修复存档截断，不改存档格式。下一步：改为原子写入并补测试。我会先读 SaveManager.cs。　✓ 与交接内容一致';
      }, { stream: false, instant: true });
    }
    const closePop = () => { pop.hidden = true; btns.forEach((b) => b.setAttribute('aria-expanded', 'false')); };
    const choose = (o) => {
      const { kind, val } = o.dataset;
      if (kind === 'effort') {
        if (val !== cur.effort) {
          // 只改按钮上的显示，不往对话里插记录：思考强度会体现在下一条回复的头部（模型 · 思考 X）
          cur.effort = val;
          document.querySelectorAll('.toast[data-key="effort"]').forEach((t) => t.remove());
          toast(`思考强度：${val}，从下一条消息开始生效。越高越仔细，也更慢、更耗额度`);
          [...document.querySelectorAll('.toasts .toast')].pop()?.setAttribute('data-key', 'effort');
          // 等这次点击事件处理完再重绘，否则被点的按钮先脱离页面，弹出层会被当成“点了外面”而关闭
          setTimeout(() => { render(); $(`.seg button[data-val="${val}"]`, pop)?.focus(); });
        }
        return;
      }
      closePop();
      if (kind === 'model' && val !== cur.model) {
        addNote(`已切换到 ${val}，会话内切换，上下文完整保留`, 'model');
        cur.model = val; render(); toast(`已切换到 ${val}`);
      } else if (kind === 'account' && val !== cur.account) {
        addNote(`已切换账号：${val}，用新账号恢复了原会话，上下文完整保留`, 'account');
        cur.account = val; render(); toast(`已切换到账号“${val}”`);
      } else if (kind === 'agent' && val !== cur.agent) {
        if (val === 'codex') return modal({ title: 'Codex 登录已过期', body: '<p>重新登录后才能交接给 Codex。登录会在浏览器里打开授权页面，完成后回到这里即可。</p>',
          actions: [{ label: '取消' }, { label: '去重新登录', kind: 'primary', onClick() { location.href = 'agents.html'; } }] });
        if (val === 'zcode') return modal({ title: 'ZCode 还没连接', body: '<p>ZCode 需要先在 Agent 管理里启用实验桥接。</p>',
          actions: [{ label: '取消' }, { label: '去 Agent 管理', kind: 'primary', onClick() { location.href = 'agents.html'; } }] });
        const toModel = agents[val][1][0];
        const back = { agent: cur.agent, model: cur.model, account: cur.account, effort: cur.effort };
        window.aicHandoff(cur.agent, cur.model, val, toModel, (h) => {
          window.aicRegisterHandoff(h);
          h.back = back;
          const div = add(window.aicHandoffDivider(h));
          Object.assign(cur, { agent: val, model: toModel, account: accounts[val][0], effort: efforts[val] ? '中' : null });
          render();
          const restate = `目标：${h.goal}。下一步：${h.next}。我会先读 ${h.readFirst}。`;
          streamReply(val, toModel, `这是从 ${agents[back.agent][0]} 交接过来的任务。先核对交接内容里的约束和未提交改动，确认工作区和描述一致；已经跑过的命令不重复执行。`,
            `<details class="restate"><summary>${ic('check')}交接确认（我的理解）</summary><p>${esc(restate)}</p></details><p>已读取交接内容和 <code>.aic/TASK.md</code>，代码以工作区当前文件为准。${ctx.resume}</p>`,
            () => { const r = $('.ho-restate', div); if (r) r.textContent = restate + '　✓ 与交接内容一致'; });
          toast(`已自动交接到 ${agents[val][0]}（${h.level}），原会话已保留`);
        });
      }
    };
    pop.addEventListener('click', (e) => { const o = e.target.closest('.opt, .seg button'); if (o) choose(o); });
    pop.addEventListener('keydown', (e) => { const o = e.target.closest('.opt'); if (o && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); choose(o); } });
    btns.forEach((b) => b.addEventListener('click', () => setTimeout(() => { if (!pop.hidden) $('.opt[aria-selected="true"]', pop)?.focus(); })));
  });

  // ---------- 输入框：发消息、附件、权限 ----------
  $$('.compose-box').forEach((box) => {
    const ta = $('textarea', box);
    const sendBtn = $('.compose-bar .btn.primary', box);
    const send = () => {
      // 对话注释（sidechat.js 的 aicAnnos）：附在消息后面一起发出，发出后清空
      const annos = window.aicAnnos?.take() ?? '';
      const text = [ta.value.trim(), annos].filter(Boolean).join('\n\n');
      if (!text) { ta.focus(); return; }
      add(userMsg(text));
      ta.value = '';
      // 发消息算一次活动：侧栏里这个任务排到所在项目/分组的最前面
      const h1 = $('.main-head h1')?.textContent;
      const tid = window.aicSB?.tasks.find((t) => t.title === h1)?.id || document.body.dataset.task;
      if (tid) window.aicSB.touch(tid);
      streamReply(cur.agent, cur.model, `你补充了：“${text}”。先确认当前步骤能不能安全停下，再把这条要求加进计划，${cur.effort === '最高' || cur.effort === '高' ? '顺便检查它会不会和已有约束冲突。' : '然后继续。'}`,
        `<p>收到：“${esc(text)}”。我会在当前步骤完成后接着处理。（原型模拟回复）</p>`);
    };
    wire(sendBtn)?.addEventListener('click', send);
    ta?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
    const attach = $('[aria-label="添加附件"]', box);
    wire(attach)?.addEventListener('click', () => toast('正式版会打开文件选择框，也可以直接把文件拖进输入框。', 'demo'));
    const perm = $('.perm-chip', box);
    wire(perm)?.addEventListener('click', () => {
      // 每个权限级别一个图标：只读=眼睛，需审批=盾牌，工作区内自动=带勾的盾牌，全自动=打开的锁（琥珀色提醒）
      const permIcon = { '只读': ['eye', 'ro'], '需审批': ['shield', 'ask'], '工作区内自动': ['shieldcheck', 'ws'], '全自动': ['unlock', 'full'] };
      const set = (lv) => { const [icn, cls] = permIcon[lv]; perm.innerHTML = `${ic(icn)}${lv}`; perm.dataset.level = cls; perm.title = '权限级别：' + lv + '（点击修改）'; perm.setAttribute('aria-label', '权限级别：' + lv + '，点击修改'); toast(`本任务权限改为“${lv}”，从下一步开始生效`); };
      window.aicMenu(perm, [
        ['只读：只能读文件和搜索', () => set('只读')],
        ['需审批：改文件、执行命令前问你', () => set('需审批')],
        ['工作区内自动：只有越界操作才问你', () => set('工作区内自动')],
        ['全自动…', () => modal({ title: '开启全自动？', body: '<p>除了“始终禁止”清单里的操作（例如删除工作区外的文件），Agent 的所有操作都不再询问你。</p><p>建议只在可以随时丢弃的任务上使用。</p>',
          actions: [{ label: '取消' }, { label: '开启全自动', kind: 'danger', onClick() { set('全自动'); } }] }), 'danger'],
      ]);
    });

    // 本任务的“低风险自动允许”：按会话的开关，默认取设置里“新任务的默认值”（默认开）
    const bar = $('.compose-bar', box);
    const anchor = perm || $('.switcher', bar);
    anchor?.insertAdjacentHTML('afterend', '<button class="perm-chip aa-chip hide-narrow" data-wired="1" aria-haspopup="dialog"></button>');
    const aa = $('.aa-chip', bar);
    const paint = () => {
      const riskOn = window.aicJudgeOn('risk'), on = riskOn && sess.get().autoAllow;
      aa.innerHTML = `${ic('bolt')}<span class="lbl">低风险自动允许：${on ? '开' : riskOn ? '关' : '不可用'}</span>`;
      aa.title = `低风险自动允许：${on ? '已开启' : riskOn ? '已关闭' : '不可用'}（点击查看规则或切换）`;
      aa.classList.toggle('on', on);
      aa.setAttribute('aria-label', `本任务的低风险自动允许：${on ? '已开启' : riskOn ? '已关闭' : '不可用，审批风险判断已关闭'}。点击查看规则或切换`);
      document.dispatchEvent(new CustomEvent('aic-sess-change'));
    };
    const rules = `<ul class="steps" style="padding-left:1.2em"><li>只放行快速判断为<b>低风险</b>、把握度 <b>≥ 90%</b> 的审批</li><li>只作用于<b>工作副本内</b>的操作；碰到工作副本外的文件、联网上传、推送到远程，照常问你</li><li><b>永远不会越过“始终禁止”清单</b>：清单里的操作直接拒绝，不经过判断</li><li>每次自动允许都会在对话里留一行记录，可以“撤销此类自动允许”</li></ul>`;
    aa?.addEventListener('click', () => {
      if (!window.aicJudgeOn('risk')) return modal({ title: '低风险自动允许不可用', body: '<p>它依赖“审批风险”判断，这项在设置里已关闭。</p>', actions: [{ label: '关闭' }, { label: '打开设置', kind: 'primary', onClick() { setTimeout(() => window.aicSettings()); } }] });
      const on = sess.get().autoAllow;
      modal({ title: `本任务的低风险自动允许：${on ? '已开启' : '已关闭'}`,
        body: `<p>只影响这个任务。新任务的默认值在设置的“快速判断”里改。</p>${rules}`,
        actions: on
          ? [{ label: '关闭自动允许', kind: 'danger', onClick() { sess.set({ autoAllow: false }); paint(); add(sysnote('本任务已关闭低风险自动允许，之后的审批都会问你')); toast('本任务已关闭低风险自动允许'); } }, { label: '保持开启', kind: 'primary' }]
          : [{ label: '保持关闭' }, { label: '开启自动允许', kind: 'primary', onClick() { sess.set({ autoAllow: true }); paint(); add(sysnote('本任务已开启低风险自动允许')); toast('本任务已开启低风险自动允许'); } }] });
    });
    if (aa) { paint(); document.addEventListener('aic-judge-change', paint); }
  });
})();

// ---------- 工作台：审批、改动面板 ----------
(function () {
  if (document.body.dataset.page !== 'workbench') return;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const { aicToast: toast, aicModal: modal, aicWire: wire, aicHhmm: hhmm, aicEsc: esc, aicAgents: agents, aicAdd: add, aicAgentMsg: agentMsg, aicSysnote: sysnote } = window;
  const ic = (n) => window.icon(n);
  const letter = { claude: 'C', codex: 'X', codebuddy: 'B', zcode: 'Z' };

  // 从侧栏点进其他任务：沿用示例对话，只换标题和状态
  const qs = new URLSearchParams(location.search);
  if (qs.get('title')) {
    $('.main-head h1').textContent = qs.get('title');
    const st = $('.main-head .status');
    st.className = 'status ' + (qs.get('st') || 'run');
    st.innerHTML = `<span class="dot"></span>${esc(qs.get('stt') || '')}`;
    document.title = qs.get('title') + ' - AI Console 原型';
    $$('.sidebar .task-row').forEach((a) => a.toggleAttribute('aria-current', $('.t', a).textContent === qs.get('title')));
    $('.stream-inner').insertAdjacentHTML('afterbegin', `<div class="alert info proto-note">${ic('info')}<div class="body"><strong>原型说明</strong><p>原型只画了一个任务的完整对话，这里沿用示例内容。正式版会显示这个任务自己的记录。</p></div></div>`);
  }

  // ---------- 审批 ----------
  const card = $('#approval');
  const clearBadges = () => {
    $$('.sidebar .sb-item.attn .badge, .bottomnav .badge').forEach((b) => b.remove());
    $('.pending-strip')?.remove();
  };
  const setHead = (cls, text) => { const s = $('.main-head .status'); s.className = 'status ' + cls; s.innerHTML = `<span class="dot"></span>${text}`; };
  const resolve = (ok, text) => {
    card.classList.add('resolved');
    if (!ok) card.classList.add('denied');
    $('#ap-title').textContent = text;
    $('.ah .meta', card).textContent = `你 · ${hhmm()}`;
    $('.ah svg use', card).setAttribute('href', ok ? '#i-check' : '#i-x');
    card.removeAttribute('tabindex');
    clearBadges();
  };
  const runTests = () => {
    setHead('run', '运行中');
    const turn = $('#turn-cur'), proc = $('.process', turn), body = $('.process-body', turn);
    $('.pl', proc).textContent = '正在处理';
    body.insertAdjacentHTML('beforeend', `<div class="tools-group"><details class="tool" open><summary>${window.icon('right', 'chev')}<span class="verb">执行</span><span class="target">Unity.exe -runTests -testFilter SaveManagerTests</span><span class="end thinking">运行中</span></summary>
      <div class="detail"><pre>正在启动 Unity（batchmode）</pre></div></details></div>`);
    const g = body.lastElementChild;
    delete proc.dataset.pending;
    $('.stream').scrollTop = $('.stream').scrollHeight;
    setTimeout(() => {
      $('.end', g).className = 'end';
      $('.end', g).innerHTML = '<span class="status ok"><span class="dot"></span>12/12 通过</span>41 秒';
      $('pre', g).textContent = 'SaveManagerTests.LoadLegacySave_v3 ✓\nSaveManagerTests.InterruptedWrite_FallsBackToBak ✓\nSaveManagerTests.RoundTrip_KeepsFormat ✓\n…共 12 项，全部通过';
      const pl = $('.pl', proc); pl.classList.remove('thinking'); pl.textContent = '用时 5 分 2 秒';
      $('summary', proc).setAttribute('aria-label', '用时 5 分 2 秒，点击查看过程');
      if (!proc.dataset.user) proc.open = false;
      $('.process', turn).insertAdjacentHTML('afterend', '<div class="text answer md"><h3>测试结果</h3><p><strong>12 项全部通过</strong>：</p><ul><li>老格式 v3 存档能读</li><li>写入中断时会回退到 <code>.bak</code></li></ul><p>剩下“云同步前等待写入完成”这一步，改完后就可以合并。</p></div>');
      $('.stream').scrollTop = $('.stream').scrollHeight;
      (() => { const j = window.aicJudge({ kind: 'done', text: '完成度判断：已满足验收标准 3/3', prob: 88, why: 'SaveManagerTests 12/12 通过，覆盖了老格式读取和中断回退；存档格式没有改动' }); if (j) add(`<div class="judge-inline">${j}</div>`);
          if (window.aicSess.get().autoMerge) {
            setTimeout(() => { add(sysnote('测试全部通过，已按本任务设置自动合并到 main（压缩成一个提交）')); setHead('ok', '已合并'); toast('已自动合并到 main，可以在改动面板回滚'); }, 600);
          } })();
      setHead('ok', '待验收');
      const now = $('.plan li.now');
      if (now) { now.className = 'done'; now.querySelector('.mk').innerHTML = ic('check'); now.nextElementSibling?.classList.add('now'); }
    }, 1800);
  };
  // 快速判断：审批风险（设置里关掉“审批风险”时不显示）
  // 这条审批判断为低风险，但把握度 87% 低于自动允许的 90%，所以仍然等你处理；卡片上写明原因
  const riskRow = () => {
    $('.judge', card)?.remove();
    $$('.aa-note', card).forEach((x) => x.remove());
    $('.facts', card).insertAdjacentHTML('afterend', window.aicJudge({ kind: 'risk', text: '风险评估：低', prob: 87, why: '只在工作副本里运行测试，不联网、不删除文件；但会启动 Unity 编辑器进程，这个任务里第一次出现' }));
    const s = window.aicSess.get();
    const why = !window.aicJudgeOn('risk') ? '“审批风险”判断已在设置里关闭' : !s.autoAllow ? '本任务已关闭低风险自动允许' : '判断为低风险，但把握度 87% 低于 90%，所以仍然问你';
    $('.facts', card).insertAdjacentHTML('beforeend', `<dt class="aa-note">自动允许</dt><dd class="aa-note">没有自动放行：${why}</dd>`);
  };
  riskRow();
  ['aic-judge-change', 'aic-sess-change'].forEach((ev) => document.addEventListener(ev, () => { if (!card.classList.contains('resolved')) riskRow(); }));

  // 对话里的自动允许记录：低风险、把握度 ≥ 90%、只在工作副本内，所以之前那次构建没有问你
  const failed = $('.stream .tool.failed');
  failed?.insertAdjacentHTML('beforebegin', `<div class="autoallow" role="note">${ic('shield')}<span class="aa-t">已自动允许（低风险 · 96%）：执行 <span class="mono">dotnet build FogHarbor.sln</span></span>
    <button class="btn ghost sm" data-wired="1" data-aa-undo>撤销此类自动允许</button></div>`);
  $('[data-aa-undo]')?.addEventListener('click', (e) => {
    const b = e.currentTarget, row = b.closest('.autoallow');
    modal({ title: '撤销此类自动允许？', body: '<p>本任务里以后再执行 <span class="mono">dotnet build</span> 这类命令时会先问你。已经执行过的这次不会撤回。</p><p style="margin:0">这也会记为一次对“审批风险”判断的纠正。</p>',
      actions: [{ label: '取消' }, { label: '撤销', kind: 'primary', onClick() {
        $('.aa-t', row).innerHTML = '已撤销：本任务里 <span class="mono">dotnet build</span> 这类命令以后会先问你';
        b.remove(); row.classList.add('undone');
        const fix = window.aicJudgeFixes(); fix.risk = (fix.risk || 0) + 1;
        try { localStorage.setItem('aic-judge-fix', JSON.stringify(fix)); } catch (err) { /* 忽略 */ }
        toast('已撤销此类自动允许，已记录，会用于调整阈值');
      } }] });
  });

  // 改动面板合并区：本任务“测试通过后自动合并”，默认关，开启要二次确认
  const foot = $('.review-foot');
  foot?.insertAdjacentHTML('afterbegin', `<div class="am-row"><button class="switch" role="switch" data-wired="1" id="am-sw" aria-checked="false" aria-labelledby="am-l" aria-describedby="am-s"></button>
    <span id="am-l">测试通过后自动合并</span><span class="sub" id="am-s"></span></div>`);
  const amSw = $('#am-sw');
  const paintAm = () => { const on = window.aicSess.get().autoMerge; amSw.setAttribute('aria-checked', String(on)); $('#am-s').textContent = on ? '已开启：测试全部通过后压缩成一个提交合并到 main' : '关（本任务）'; };
  paintAm();
  amSw?.addEventListener('click', () => {
    if (window.aicSess.get().autoMerge) { window.aicSess.set({ autoMerge: false }); paintAm(); toast('已关闭本任务的自动合并'); return; }
    modal({ title: '本任务测试通过后自动合并？', body: '<p>测试全部通过后，这个任务的改动会直接合并到 <span class="mono">main</span>（压缩成一个提交），不等你验收。测试没覆盖到的问题要靠回滚恢复。</p><p style="margin:0">合并前仍会检查冲突和主目录的未提交改动，有问题就不合并，改为通知你。</p>',
      actions: [{ label: '取消' }, { label: '开启自动合并', kind: 'danger', onClick() { window.aicSess.set({ autoMerge: true }); paintAm(); toast('本任务测试通过后会自动合并'); } }] });
  });
  const [allowBtn, alwaysBtn] = $$('.acts .btn', card);
  const rejectBtn = $('.acts .btn.danger', card);
  wire(allowBtn).addEventListener('click', () => { resolve(true, '已允许：执行 Unity 测试命令'); runTests(); });
  wire(alwaysBtn).addEventListener('click', () => modal({
    title: '总是允许此类命令？',
    body: `<p>会给项目“雾港物语”添加一条规则，以后同类命令不再询问：</p>
      <pre class="mono" style="margin:0 0 var(--sp-3);padding:10px 12px;background:var(--bg-0);border-radius:var(--r-ctl);white-space:pre-wrap">{ "action": "allow", "tool": "shell",
  "match": "\\"…\\\\Unity.exe\\" -batchmode * -runTests *" }</pre>
      <p style="margin:0">随时可以在项目设置的“权限规则”里删除。</p>`,
    actions: [{ label: '取消' }, { label: '添加规则并允许', kind: 'primary', onClick() { resolve(true, '已允许（并添加了项目规则）：执行 Unity 测试命令'); toast('已添加项目规则'); runTests(); } }],
  }));
  wire(rejectBtn);
  const rr = $('#rr');
  rr.insertAdjacentHTML('beforeend', '<div style="display:flex;gap:8px;margin-top:8px;justify-content:flex-end"><button class="btn sm" data-rr="cancel">取消</button><button class="btn sm danger" data-rr="ok">确认拒绝</button></div>');
  $$('[data-rr]', rr).forEach((b) => wire(b).addEventListener('click', () => {
    if (b.dataset.rr === 'cancel') { rr.hidden = true; return; }
    const why = $('#rr-input').value.trim();
    resolve(false, '已拒绝' + (why ? `，理由：${why}` : ''));
    setHead('run', '运行中');
    const proc = $('#turn-cur .process'); delete proc.dataset.pending;
    const pl = $('.pl', proc); pl.classList.remove('thinking'); pl.textContent = '用时 4 分 30 秒';
    if (!proc.dataset.user) proc.open = false;
    proc.insertAdjacentHTML('afterend', `<div class="text answer md"><p>好的，不运行这条命令。${why ? `按你的意见：“${esc(why)}”，我换个做法。` : '我先改为只做静态检查，有需要再请你确认。'}</p></div>`);
  }));
  $('#rr-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('[data-rr="ok"]', rr).click(); });
  card.addEventListener('keydown', (e) => {
    if (e.target !== card) return;
    if (e.key === 'Enter') { e.preventDefault(); allowBtn.click(); }
    if (e.key === 'Escape') { e.preventDefault(); rejectBtn.click(); }
  });
  // ---------- 改动面板 ----------
  const diff = $('#diff-save');
  const original = diff.innerHTML;
  const other = {
    'SaveManagerTests.cs': ['@@ -0,0 +1,46 @@', ['a', '[Test] public void LoadLegacySave_v3()'], ['a', '{'], ['a', '    var data = SaveManager.LoadFrom(Fixture("legacy_v3.json"));'], ['a', '    Assert.AreEqual(3, data.Version);'], ['a', '}'], ['a', '[Test] public void InterruptedWrite_FallsBackToBak() { … }']],
    'SteamCloudSync.cs': ['@@ -27,6 +27,7 @@ public class SteamCloudSync', ['n', 'void OnApplicationQuit()'], ['n', '{'], ['d', '    UploadSaves();'], ['a', '    SaveManager.WaitForPendingWrites(timeoutMs: 2000);'], ['a', '    UploadSaves();'], ['n', '}']],
  };
  $$('.filelist li').forEach((li) => {
    li.tabIndex = 0;
    const pick = () => {
      $$('.filelist li').forEach((x) => x.removeAttribute('aria-current'));
      li.setAttribute('aria-current', 'true');
      const name = li.querySelector('.path').lastChild.textContent;
      if (name === 'SaveManager.cs') { diff.innerHTML = original; return; }
      const [hunk, ...lines] = other[name];
      let n = 1;
      diff.innerHTML = `<div class="fh"><span class="mono" style="font-size:12px">${name}</span><span class="grow"></span><button class="btn sm ghost">${ic('undo')}还原文件</button><button class="btn sm ghost">评论</button></div>
        <div class="hunk">${hunk}</div>` + lines.map(([k, t]) => `<div class="ln ${k === 'n' ? '' : k}"><span>${k === 'a' ? '' : n}</span><span>${k === 'd' ? '' : n++}</span><span>${k === 'a' ? '+' : k === 'd' ? '−' : ''}</span><span>${esc(t)}</span></div>`).join('');
    };
    li.addEventListener('click', pick);
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
  });
  const side = $('.side');
  side.addEventListener('click', (e) => {
    const b = e.target.closest('.btn');
    if (!b || b.dataset.action) return;
    const t = b.textContent.trim();
    const file = $('.diff .fh .mono')?.textContent;
    wire(b);
    if (t.includes('还原文件')) modal({ title: `还原 ${file}？`, body: `<p>撤销 Agent 对这个文件的全部改动，恢复成任务开始前的样子。其他文件不受影响。</p>`,
      actions: [{ label: '取消' }, { label: '还原', kind: 'danger', onClick() { toast(`已还原 ${file}`); } }] });
    else if (t === '评论') toast('正式版可以在某一行上留评论，下次发消息时一并告诉 Agent。', 'demo');
    else if (t === '左右对比') toast('正式版支持左右对比视图，原型只画了上下合并视图。', 'demo');
    else if (t.includes('IDE')) toast('会用 VS Code 打开这个任务的工作副本。', 'demo');
    else if (t.includes('查看任务说明')) modal({ title: '任务说明（.aic/TASK.md）', wide: true,
      body: `<pre class="mono" style="margin:0;white-space:pre-wrap">## 目标
修复 Steam Deck 上退出游戏后存档偶发变成空文件

## 约束
- 不改存档格式，老存档必须能读${(window.aicTaskConstraints || []).map((c) => `\n- ${esc(c)}（来自侧聊）`).join('')}
- 来自审批：无

## 验收标准
- 老格式（v3）存档能正常读取
- 写入中断时能回退到 .bak
- SaveManagerTests 全部通过</pre><p style="margin-top:var(--sp-3)">每个会话的第一条消息都会引用这个文件；交接时它原样保留，所以这部分上下文不会丢。</p>` });
    else if (t.includes('丢弃任务')) modal({ title: '丢弃这个任务？', body: '<p>会删除任务的工作副本和分支 <span class="mono">aic/t8f2-fix-save-corrupt</span>。你主目录里的代码不受影响。对话记录会保留。</p>',
      actions: [{ label: '取消' }, { label: '丢弃', kind: 'danger', onClick() { setHead('idle', '已丢弃'); toast('任务已丢弃，工作副本已删除'); } }] });
    else if (t.includes('合并到')) modal({ title: '合并到 main', body: `<p>把这个任务的改动合并进主目录的 <span class="mono">main</span> 分支。</p>
        <label class="check-row"><input type="radio" name="mm" checked> <span>压缩成一个提交（推荐）</span></label>
        <label class="check-row"><input type="radio" name="mm"> <span>保留全部提交记录</span></label>
        <label for="cm" style="display:block;margin-bottom:6px;color:var(--fg-1)">提交说明（Agent 已起草，可修改）</label>
        <textarea class="textarea" id="cm" rows="3">修复退出时存档偶发被截断：写入改为临时文件 + 原子替换，读取失败回退 .bak</textarea>
        <p style="margin:var(--sp-3) 0 0;color:var(--fg-3)">已检查：主目录没有未提交的改动，没有冲突。</p>`,
      actions: [{ label: '取消' }, { label: '合并', kind: 'primary', onClick() { setHead('ok', '已合并'); toast('已合并到 main，工作副本 7 天后自动清理'); } }] });
  });
})();

// ---------- 看板 ----------
(function () {
  if (document.body.dataset.page !== 'kanban') return;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const { aicToast: toast, aicWire: wire, aicEsc: esc } = window;
  // 卡片和侧栏用同一份任务数据：按标题对上任务编号
  const SB = window.aicSB;
  const cards = $$('.task-card');
  cards.forEach((c) => { const t = SB.tasks.find((x) => x.title === $('.t', c).textContent); if (t) c.dataset.id = t.id; });
  const taskOf = (c) => SB.tasks.find((x) => x.id === c.dataset.id);
  let filter = 'all';
  const recount = () => $$('.col').forEach((col) => { const n = $$('.task-card', col).filter((c) => !c.hidden).length; const el = $('.col-head .n', col); if (el && !el.textContent.includes('近')) el.textContent = n; });
  // 每列按最近活动排序；“排队中”保持执行顺序（可拖动调整），不按时间排
  const sortCols = () => $$('.col').forEach((col) => {
    if (col.getAttribute('aria-labelledby') === 'c-queue') return;
    const body = $('.col-body', col);
    $$('.task-card', body).filter(taskOf).sort((a, b) => SB.agoOf(taskOf(a)) - SB.agoOf(taskOf(b))).forEach((c) => body.appendChild(c));
  });
  const apply = () => {
    cards.forEach((c) => {
      const t = taskOf(c); if (!t) return;
      const g = SB.groupName(SB.assign[t.id]) ? SB.assign[t.id] : 'none';
      c.hidden = filter !== 'all' && (SB.view === 'project' ? t.proj !== filter : g !== filter);
    });
    recount();
  };
  // 筛选方式和侧栏共用：在任一处切到“分组”，另一处也跟着变
  const renderChips = () => {
    $$('[data-kview]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.kview === SB.view)));
    const opts = SB.view === 'project' ? SB.projects.map((p) => [p.name, p.name]) : [...SB.groups.map((g) => [g.id, g.name]), ['none', '未分类']];
    if (filter !== 'all' && !opts.some((o) => o[0] === filter)) filter = 'all';
    $('.kchips').innerHTML = [['all', SB.view === 'project' ? '全部项目' : '全部分组'], ...opts]
      .map(([v, l]) => `<button class="chipsel" data-wired="1" data-kf="${esc(v)}" aria-pressed="${v === filter}">${esc(l)}</button>`).join('');
    apply();
  };
  $('.filters').addEventListener('click', (e) => {
    const k = e.target.closest('[data-kview]');
    if (k) { SB.setView(k.dataset.kview); return; }
    const f = e.target.closest('[data-kf]');
    if (f) { filter = f.dataset.kf; renderChips(); }
  });
  document.addEventListener('aic-sb-change', renderChips);
  sortCols(); renderChips();

  // 点卡片：右侧显示摘要
  const showSum = (c) => {
    const title = $('.t', c).textContent;
    const col = c.closest('.col');
    const st = $('.col-head .status', col).classList[1];
    const stText = $('.col-head [id]', col).textContent;
    const agent = $('.row', c).textContent.replace(/\s+/g, ' ').trim();
    $('#k-sum').innerHTML = `<h2>${esc(title)}</h2><dl>
      <dt>状态</dt><dd><span class="status ${st}"><span class="dot"></span>${stText}</span></dd>
      <dt>Agent</dt><dd>${esc(agent)}</dd>
      <dt>进展</dt><dd>${esc($('.now', c)?.textContent || '—')}</dd>
      <dt>项目</dt><dd>${esc(taskOf(c)?.proj || '—')}</dd>
      <dt>分组</dt><dd>${esc(SB.groupName(SB.assign[c.dataset.id]) || '未分类')}</dd></dl>
      <a class="btn primary" href="workbench.html?${new URLSearchParams({ title, st, stt: stText })}">打开对话</a>`;
    cards.forEach((x) => x.removeAttribute('aria-current'));
    c.setAttribute('aria-current', 'true');
    window.aicOpenSide('kt-sum');
  };
  cards.forEach((c) => {
    c.removeAttribute('data-action');
    c.addEventListener('click', (e) => { if (!e.target.closest('a, button, .handle')) showSum(c); });
    c.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === c) showSum(c); });
  });

  // 排队列：拖动或 Alt+↑/↓ 调整顺序
  const qBody = $('[aria-labelledby="c-queue"] .col-body');
  const renumber = () => $$('.task-card', qBody).forEach((c, i) => {
    $('.now', c).textContent = `第 ${i + 1} 位，${i === 0 ? '有空位后开始' : '前面还有 ' + i + ' 个任务'}`;
  });
  $$('.task-card', qBody).forEach((c) => {
    c.draggable = true;
    c.addEventListener('dragstart', () => c.classList.add('dragging'));
    c.addEventListener('dragend', () => { c.classList.remove('dragging'); renumber(); toast('已调整排队顺序'); });
    c.addEventListener('keydown', (e) => {
      if (!e.altKey || !['ArrowUp', 'ArrowDown'].includes(e.key)) return;
      e.preventDefault();
      const sib = e.key === 'ArrowUp' ? c.previousElementSibling : c.nextElementSibling;
      if (!sib) return;
      e.key === 'ArrowUp' ? qBody.insertBefore(c, sib) : qBody.insertBefore(sib, c);
      c.focus(); renumber();
    });
  });
  qBody.addEventListener('dragover', (e) => {
    e.preventDefault();
    const drag = $('.dragging', qBody); if (!drag) return;
    const after = $$('.task-card:not(.dragging)', qBody).find((c) => e.clientY < c.getBoundingClientRect().top + c.offsetHeight / 2);
    after ? qBody.insertBefore(drag, after) : qBody.appendChild(drag);
  });

  const moveTo = (c, colId, nowText) => {
    const body = $(`[aria-labelledby="${colId}"] .col-body`);
    $$('.row', c).forEach((r) => { if (r.querySelector('button, a.btn')) r.remove(); });
    $('.alert', c)?.remove();
    c.classList.remove('needs');
    if (nowText) {
      if (!$('.now', c)) c.insertAdjacentHTML('beforeend', '<div class="now"></div>');
      $('.now', c).textContent = nowText;
    }
    body.prepend(c);
    $$('.col').forEach((col) => { const el = $('.col-head .n', col); if (el && !el.textContent.includes('近')) el.textContent = $$('.task-card', col).length; });
  };
  // 允许
  $$('.task-card .btn.attn').forEach((b) => wire(b).addEventListener('click', () => {
    const c = b.closest('.task-card');
    moveTo(c, 'c-run', '正在运行 Unity 测试');
    $$('.sidebar .sb-item.attn .badge, .bottomnav .badge').forEach((x) => x.remove());
    toast('已允许，任务继续运行');
  }));
  // 失败任务交接
  $$('.task-card .btn').filter((b) => b.textContent.includes('交接给')).forEach((b) => wire(b).addEventListener('click', () => {
    const c = b.closest('.task-card');
    window.aicHandoff('codex', 'gpt-5.5-codex', 'claude', 'Opus 5.5', () => {
      $('.row', c).innerHTML = '<span class="ag claude">C</span>Claude Code<span class="grow"></span><span>刚刚</span>';
      moveTo(c, 'c-run', '已接手，正在读取交接包');
      toast('已交接给 Claude Code');
    });
  }));
})();

// ---------- Agent 管理 ----------
(function () {
  if (document.body.dataset.page !== 'agents') return;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const { aicToast: toast, aicModal: modal, aicWire: wire, aicHhmm: hhmm, aicEsc: esc } = window;
  const ic = (n) => window.icon(n);
  const progress = (b, done, label) => {
    const old = b.textContent; b.setAttribute('aria-busy', 'true'); let p = 0;
    const t = setInterval(() => {
      p += 20; b.textContent = `${label} ${p}%`;
      if (p >= 100) { clearInterval(t); b.removeAttribute('aria-busy'); b.textContent = old; done(b); }
    }, 300);
  };
  const setStatus = (card, cls, text) => { const s = $('.top .status', card); s.className = 'status ' + cls; s.innerHTML = `<span class="dot"></span>${text}`; };

  // 选中卡片：下方详情跟着换
  const info = {
    'Claude Code': ['claude', 'C', ['Opus 5.5', 'Sonnet 5'], '%APPDATA%\\npm\\claude.cmd'],
    'Codex': ['codex', 'X', ['gpt-5.5-codex'], '%APPDATA%\\npm\\codex.cmd'],
    'CodeBuddy': ['codebuddy', 'B', ['glm-5.1', 'kimi-k2.5', 'minimax-m2.7', 'deepseek-v3-2'], '工作台自带：node_modules\\@tencent-ai\\codebuddy-code（2.181.0）'],
    'WorkBuddy': ['workbuddy', 'W', ['（暂不支持，没有可用模型）'], '…\\WorkBuddy\\resources\\app.asar.unpacked\\cli（只有精简引擎）'],
    'ZCode': ['zcode', 'Z', ['glm-5.1'], '…\\ZCode\\resources\\glm\\zcode.cjs'],
  };
  const detail = $('.detail');
  const pickCard = (card) => {
    const name = $('.name', card).textContent;
    const [k, l, models, path] = info[name];
    $$('.agent-card').forEach((c) => c.removeAttribute('aria-current'));
    card.setAttribute('aria-current', 'true');
    detail.setAttribute('aria-label', name + ' 详情');
    $('h2', detail).innerHTML = `<span class="ag ${k}">${l}</span>${name}`;
    $('#dm').innerHTML = models.map((m) => `<option>${m}</option>`).join('');
    $$('.field .mono', detail)[0].textContent = path;
  };
  $$('.agent-card').forEach((card) => {
    card.addEventListener('click', (e) => { if (!e.target.closest('button')) pickCard(card); });
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === card) pickCard(card); });
  });

  // 顶部重新检测
  const redetect = $('.main-head .btn');
  wire(redetect).addEventListener('click', () => progress(redetect, () => {
    $('.page-lead').firstChild.textContent = `上次检测：今天 ${hhmm()}。`;
    toast('检测完成：找到 5 个 Agent，其中 WorkBuddy 暂不支持');
  }, '检测中'));

  $$('.agent-card .btn').forEach((b) => {
    wire(b);
    const card = b.closest('.agent-card');
    const t = b.textContent;
    if (b.dataset.cbLogin) b.addEventListener('click', () => modal({
      title: `用${b.dataset.cbLogin}登录 CodeBuddy`,
      body: `<ol class="steps"><li>已在默认浏览器中打开 CodeBuddy 的登录页面（原型未真正打开）</li><li>在网页上用${esc(b.dataset.cbLogin)}完成登录</li><li>回到这里，状态会自动变成“就绪”</li></ol><p style="margin:0;color:var(--fg-3)">登录信息由 CodeBuddy 引擎自己保存，AI Console 不经手你的密码。WorkBuddy 的登录和这里无关。</p>`,
      actions: [{ label: '取消' }, { label: '我已完成登录', kind: 'primary', onClick() {
        setStatus(card, 'ok', '就绪'); $$('dl dd', card)[1].textContent = `已登录（${b.dataset.cbLogin}）`; $('.acts', card).remove();
        toast('CodeBuddy 已登录');
      } }],
    }));
    else if (b.hasAttribute('data-wb-recheck')) b.addEventListener('click', () => progress(b, () => toast('WorkBuddy 仍然只带精简引擎，保持“暂不支持”。等 WorkBuddy 更新或我们支持精简引擎后会自动可用', 'attn'), '检测中'));
    else if (t.includes('登录')) b.addEventListener('click', () => modal({
      title: '在浏览器中登录 Codex',
      body: '<ol class="steps"><li>已在默认浏览器中打开 ChatGPT 授权页面（原型未真正打开）</li><li>在网页上点“允许”</li><li>回到这里，状态会自动变成“就绪”</li></ol><p style="margin:0;color:var(--fg-3)">登录信息由 Codex 自己保存，AI Console 不经手你的密码。</p>',
      actions: [{ label: '取消' }, { label: '我已完成登录', kind: 'primary', onClick() {
        setStatus(card, 'ok', '就绪'); $('.alert', card)?.remove(); b.remove();
        toast('Codex 已登录，失败的任务可以从看板里继续');
      } }],
    }));
    else if (t.includes('更新')) b.addEventListener('click', () => progress(b, () => {
      $('dl dd', card).textContent = '0.63.2（已验证）'; b.remove(); toast('Codex 已更新到 0.63.2');
    }, '更新中'));
    else if (t.includes('桥接')) b.addEventListener('click', () => progress(b, () => {
      setStatus(card, 'ok', '已连接（实验）'); b.textContent = '关闭桥接'; toast('ZCode 已通过实验桥接连接');
    }, '连接中'));
  });

  // 账号行
  $$('.acct').forEach((row) => {
    const name = $('.info b', row).textContent;
    $$('.btn', row).forEach((b) => {
      wire(b);
      if (b.textContent.includes('测试')) b.addEventListener('click', () => progress(b, () => toast(`${name}：连接正常，1.6 秒收到回复`), '测试中'));
      else b.addEventListener('click', () => window.aicMenu(b, [
        ['设为默认账号', () => { $$('.acct .status').forEach((s) => s.remove()); $('.info', row).insertAdjacentHTML('afterend', '<span class="status ok"><span class="dot"></span>默认</span>'); toast(`默认账号改为“${name}”`); }],
        ['重命名', () => toast('正式版会弹出重命名输入框', 'demo')],
        ['删除账号', () => modal({ title: `删除“${name}”？`, body: '<p>会同时从 Windows 凭据管理器删除对应的密钥。使用这个账号的任务需要改用其他账号。</p>',
          actions: [{ label: '取消' }, { label: '删除', kind: 'danger', onClick() { row.remove(); toast(`已删除“${name}”`); } }] }), 'danger'],
      ]));
    });
  });

  // 添加账号
  const addRow = (title, sub, icon) => {
    $$('.detail .acct').pop().insertAdjacentHTML('afterend', `<div class="acct">${ic(icon)}<div class="info"><b>${esc(title)}</b><span>${esc(sub)}</span></div></div>`);
    toast(`已添加账号“${esc(title)}”`);
  };
  $$('.method button').forEach((b) => {
    wire(b);
    const kind = $('b', b).textContent;
    b.addEventListener('click', () => {
      if (kind === '订阅登录') return modal({ title: '订阅登录', body: '<p>会在浏览器中打开官方授权页面，完成后自动回到这里。</p>',
        actions: [{ label: '取消' }, { label: '打开浏览器授权', kind: 'primary', onClick() { addRow('订阅账号 2', '订阅登录，刚刚授权', 'link'); } }] });
      const custom = kind === '自定义地址';
      modal({ title: custom ? '添加自定义地址' : '添加官方 API Key',
        body: `<div class="form-row"><label for="an">名称</label><input class="input" id="an" value="${custom ? '公司中转' : '我的 API Key'}"></div>
          ${custom ? '<div class="form-row"><label for="au">Base URL</label><input class="input" id="au" placeholder="https://example.com/v1"></div>' : ''}
          <div class="form-row"><label for="ak">API Key</label><input class="input" id="ak" type="password" placeholder="粘贴密钥" autocomplete="off"></div>
          ${custom ? '<div class="form-row"><label for="am">模型</label><input class="input" id="am" placeholder="留空则自动从接口拉取"></div>' : ''}
          <p style="margin:0;color:var(--fg-3)">密钥保存在 Windows 凭据管理器，不写入任何配置文件。只在启动这个 Agent 时传给它，不改动你的全局配置。</p>`,
        actions: [{ label: '取消' }, { label: '测试并保存', kind: 'primary', onClick(d) {
          const key = $('#ak', d).value.trim();
          if (!key) { $('#ak', d).focus(); toast('请先粘贴 API Key', 'attn'); return false; }
          addRow($('#an', d).value || '未命名', `${custom ? '自定义地址' : '官方 API Key'}，结尾 …${key.slice(-4)}`, 'key');
        } }] });
    });
  });

  // 再测一次
  const retest = $$('.detail h3 .btn').find((b) => b.textContent.includes('再测'));
  wire(retest)?.addEventListener('click', () => {
    const log = $('.testlog'); const t = () => new Date().toTimeString().slice(0, 8);
    log.textContent = `${t()}  找到引擎`;
    setTimeout(() => { log.textContent += `\n${t()}  ACP 握手成功，协议版本 1`; }, 400);
    setTimeout(() => { log.textContent += `\n${t()}  发送测试消息，1.7 秒收到回复\n结果：一切正常`; toast('测试通过'); }, 1200);
  });
})();

// ---------- 兜底：任何还没有动作的按钮或链接，至少给出说明 ----------
(function () {
  const handled = '[data-wired],[data-action],[data-popover],[role="tab"],[data-shade],[data-open-viewer],[onclick],[data-close],[data-rr],.popover,.proj-head,.sb-section,#snap,#snap2,#reset,#simulate,#cmp-toggle,#viewer-close,.opt,.menu,dialog,summary,select,input,textarea,label';
  document.addEventListener('click', (e) => {
    const el = e.target.closest('button, a[href="#"]');
    if (!el || el.closest(handled)) return;
    e.preventDefault();
    const label = (el.getAttribute('aria-label') || el.textContent).trim().replace(/\s+/g, ' ');
    window.aicToast(`“${window.aicEsc(label)}”在原型里只演示样式，正式版会执行这个操作。`, 'demo');
  });
})();
