// 上下文用量、会话 token 统计、右侧“详细”面板（2026-11-07 第二版，ui-design.md 6.12、6.13）。
// - 输入框工具条最右（发送按钮左边）一个小圆环；悬停只显示“上下文 76.2k / 200k（38%）”，参照 Claude Desktop
// - 右侧面板原来的“计划”改名“详细”，从上到下：环境、计划、上下文（直接显示明细）、整个会话的 token 用量、连接（MCP）、输出（文件）
//   除计划外参照 Claude Desktop 的右侧栏
// - 每轮回复下面一行用量小字
// 数据都是原型示例；正式版来自 ACP 的 usage_update 和每轮 usage（design.md 15.5）。没报告的写“未报告”，不用 0 冒充。
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const ic = (n) => `<svg class="i" aria-hidden="true"><use href="#i-${n}"/></svg>`;
  const esc = window.aicEsc || ((s) => String(s));
  const toast = window.aicToast || (() => {});
  const box = $('.composer .compose-box');
  if (!box) return;

  const WINDOW = 200_000;
  // 分类颜色按实体固定（图表色板前 4 位 + 灰），不随占比排名变
  const cats = [
    { k: 'msg', name: '对话消息', v: 44_600, c: 'var(--series-1)' },
    { k: 'mcp', name: 'MCP 工具', v: 14_200, c: 'var(--series-2)', tip: '12 个 MCP 服务提供的工具说明' },
    { k: 'tools', name: '内置工具', v: 11_800, c: 'var(--series-3)' },
    { k: 'sys', name: '系统提示', v: 3_100, c: 'var(--series-4)' },
    { k: 'skills', name: '技能', v: 1_400, c: 'var(--fg-3)', tip: '已加载的技能说明（unity-test、blender-export 等）' },
    { k: 'mem', name: '记忆文件', v: 600, c: 'var(--fg-3)', tip: 'AGENTS.md、项目记忆' },
    { k: 'mcpi', name: 'MCP 服务说明', v: 500, c: 'var(--fg-3)', tip: 'MCP 服务自带的使用说明' },
  ];
  const BUFFER = 33_000; // 自动压缩预留
  const mcpTools = [['blender', 4_100], ['unity-mcp', 3_600], ['houdini', 2_200], ['filesystem', 1_500], ['git', 1_100], ['其他 7 个', 1_700]];
  const memFiles = [['AGENTS.md', 420], ['项目记忆（3 条固定）', 140], ['.agent/records.md', 40]];
  // 整个会话的累计用量（从任务开始到现在，所有轮次相加），按会话段列出
  const segs = [
    { name: 'CodeBuddy', model: 'glm-5.1', turns: 1, reported: false },
    { name: 'Claude Code', model: 'Opus 5.5', turns: 4, input: 186_400, output: 21_700, think: 6_900, cacheRead: 142_300, cacheWrite: 31_800, reported: true },
  ];
  // 连接：本任务可用的 MCP 服务（和输入框“MCP 12”同一份数据）
  const connectors = [
    { n: 'Houdini', l: 'H', st: 'reconnect', why: '连接断开了：Houdini 没有在运行' },
    { n: 'Blender', l: 'B', st: 'ok' }, { n: 'Unity MCP', l: 'U', st: 'ok' }, { n: 'Bilibili', l: 'B', st: 'ok' },
    { n: 'RenderDoc', l: 'R', st: 'ok' }, { n: 'filesystem', l: 'F', st: 'ok' }, { n: 'git', l: 'G', st: 'ok' },
    { n: 'video-analyzer', l: 'V', st: 'ok' }, { n: 'fxhoudini', l: 'F', st: 'off', why: '本任务已临时停用' },
    { n: 'ai-console', l: 'A', st: 'ok' }, { n: 'web-search', l: 'W', st: 'ok' }, { n: 'unreal-mcp', l: 'U', st: 'ok' },
  ];
  // 输出：这个会话新建或修改过的文件（最近的在前）
  const outputs = [
    { p: 'Assets/Scripts/Save/SaveManager.cs', k: 'M', add: 23, del: 4 },
    { p: 'Assets/Tests/EditMode/SaveManagerTests.cs', k: 'A', add: 46, del: 0 },
    { p: 'Assets/Scripts/Platform/SteamCloudSync.cs', k: 'M', add: 3, del: 2 },
    { p: 'Temp/save-tests.xml', k: 'A', add: 0, del: 0, note: '测试报告（未纳入改动）' },
    { p: '.aic/TASK.md', k: 'M', add: 12, del: 3, note: '任务账本' },
    { p: '.aic/handoff/H3.md', k: 'A', add: 58, del: 0, note: '交接内容' },
  ];

  const k = (n) => (n == null ? '—' : n >= 1_000_000 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1000 ? (n / 1000).toFixed(n >= 100_000 ? 0 : 1).replace(/\.0$/, '') + 'k' : String(n));
  const pct = (n) => ((n / WINDOW) * 100).toFixed(1) + '%';
  const used = () => cats.reduce((s, c) => s + c.v, 0);
  const level = (p) => (p >= 90 ? 'crit' : p >= 70 ? 'warn' : 'ok');

  // ---------- 圆环：输入框工具条最右，发送按钮左边；悬停显示数字 ----------
  const bar = $('.compose-bar', box);
  const send = $('.btn.primary', bar);
  send.insertAdjacentHTML('beforebegin', '<button type="button" class="ctx-ring" data-wired="1" aria-describedby="ctx-hover"></button>');
  const ring = $('.ctx-ring', bar);
  document.body.insertAdjacentHTML('beforeend', '<div class="ctx-hover" id="ctx-hover" role="tooltip" hidden></div>');
  const hover = $('#ctx-hover');
  const ringText = () => { const u = used(); return `上下文 ${k(u)} / ${k(WINDOW)}（${Math.round((u / WINDOW) * 100)}%）`; };
  const paintRing = () => {
    const u = used(), p = (u / WINDOW) * 100, r = 6.5, c = 2 * Math.PI * r;
    ring.dataset.level = level(p);
    ring.innerHTML = `<svg viewBox="0 0 18 18" aria-hidden="true"><circle class="track" cx="9" cy="9" r="${r}" fill="none" stroke-width="2.5"/><circle class="fill" cx="9" cy="9" r="${r}" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="${(c * Math.min(p, 100)) / 100} ${c}"/></svg>`;
    ring.setAttribute('aria-label', `${ringText()}。点击在右侧“详细”里查看明细`);
    hover.textContent = ringText() + (p >= 70 ? '，快满时 Agent 会自动压缩较早的对话' : '');
  };
  const showHover = () => {
    hover.hidden = false;
    const r = ring.getBoundingClientRect();
    hover.style.left = Math.max(8, Math.min(innerWidth - hover.offsetWidth - 8, r.left + r.width / 2 - hover.offsetWidth / 2)) + 'px';
    hover.style.top = (r.top - hover.offsetHeight - 8) + 'px';
  };
  const hideHover = () => { hover.hidden = true; };
  ring.addEventListener('mouseenter', showHover); ring.addEventListener('mouseleave', hideHover);
  ring.addEventListener('focus', showHover); ring.addEventListener('blur', hideHover);
  ring.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideHover(); });
  // 点圆环：打开右侧“详细”并滚到“上下文”
  ring.addEventListener('click', () => {
    hideHover();
    window.aicOpenSide?.('t-plan');
    setTimeout(() => { toggleSec('d-ctx', true); const s = $('#d-ctx'); s?.scrollIntoView({ block: 'start', behavior: 'smooth' }); s?.focus({ preventScroll: true }); }, 60);
  });

  // ---------- 右侧“详细” ----------
  const tab = $('#t-plan');
  if (tab) tab.textContent = '详细';
  const panel = $('#p-plan');
  const planList = panel && $('ol.plan', panel);
  const planHtml = planList ? planList.outerHTML : '';

  const segBar = () => {
    const u = used(), free = WINDOW - u - BUFFER;
    const parts = [...cats, { k: 'buf', name: '自动压缩预留', v: BUFFER, c: 'var(--line-strong)' }];
    return `<div class="ctx-bar" role="img" aria-label="上下文分布：${parts.map((p) => `${p.name} ${k(p.v)}`).join('，')}，剩余 ${k(free)}">
      ${parts.map((p) => `<span tabindex="0" data-tip="${esc(p.name)}：${k(p.v)}（${pct(p.v)}）" style="flex:${p.v} 0 0;background:${p.c}"></span>`).join('')}
      <span class="free" style="flex:${free} 0 0" data-tip="剩余空间：${k(free)}（${pct(free)}）" tabindex="0"></span></div>`;
  };
  // 每节可以折叠展开；默认只展开“计划”和“上下文”，状态按设备记住（2026-11-07 用户要求）
  const OPEN_KEY = 'aic-detail-open';
  const openSet = (() => { try { const v = JSON.parse(localStorage.getItem(OPEN_KEY)); if (Array.isArray(v)) return new Set(v); } catch (e) { /* 忽略 */ } return new Set(['d-plan', 'd-ctx']); })();
  const saveOpen = () => { try { localStorage.setItem(OPEN_KEY, JSON.stringify([...openSet])); } catch (e) { /* 忽略 */ } };
  // 收起时标题行右侧仍显示一句摘要（例如“3 / 6”“38%”“10 个可用”），不用展开也能看到要点
  const sec = (id, title, body, extra = '') => {
    const open = openSet.has(id);
    return `<section class="d-sec${open ? ' open' : ''}" id="${id}" tabindex="-1">
      <h3><button type="button" class="d-tog" data-wired="1" data-tog="${id}" aria-expanded="${open}" aria-controls="${id}-b">${ic('right')}<span>${title}</span>${extra}</button></h3>
      <div class="d-body" id="${id}-b"${open ? '' : ' hidden'}>${body}</div></section>`;
  };
  const toggleSec = (id, force) => {
    const s = $('#' + id); if (!s) return;
    const open = force ?? !openSet.has(id);
    if (open) openSet.add(id); else openSet.delete(id);
    saveOpen();
    s.classList.toggle('open', open);
    $('.d-tog', s).setAttribute('aria-expanded', String(open));
    $('.d-body', s).hidden = !open;
  };
  const showAll = { conn: false, out: false };

  const render = () => {
    if (!panel) return;
    const u = used(), free = WINDOW - u - BUFFER, p = (u / WINDOW) * 100;
    const rep = segs.filter((s) => s.reported);
    const sum = (f) => rep.reduce((s, x) => s + (x[f] ?? 0), 0);
    const turns = segs.reduce((s, x) => s + x.turns, 0);
    const conn = showAll.conn ? connectors : connectors.slice(0, 4);
    const outs = showAll.out ? outputs : outputs.slice(0, 5);
    panel.innerHTML = [
      // 环境：运行在哪、项目文件夹、分支（参照 Claude Desktop 的 Environment）
      sec('d-env', '环境', `<ul class="d-list">
        <li>${ic('devices')}<span class="t">本机</span><span class="r"><button type="button" class="linkish" data-wired="1" data-d="env-save" title="把“本机 · 雾港物语 · 工作副本”存为常用环境，下次新建任务一键选用">存为常用</button></span></li>
        <li>${ic('folder')}<span class="t">雾港物语<span class="sub"> · D:\\Games\\FogHarbor</span></span></li>
        <li>${ic('branch')}<span class="t mono">aic/t8f2-fix-save-corrupt</span><span class="r sub">工作副本，基于 main</span></li>
      </ul>`, '<span class="grow"></span><span class="sub">本机 · aic/t8f2…</span>'),
      sec('d-plan', '计划', planHtml, '<span class="grow"></span><span class="sub">3 / 6</span>'),
      // 上下文：直接显示明细（不再要点“查看明细”）
      sec('d-ctx', '上下文', `
        <div class="tot"><b>已用 ${p.toFixed(0)}%</b><span>${k(u)} / ${k(WINDOW)}</span></div>
        ${segBar()}
        <ul class="ctx-legend" aria-label="上下文分类">
          ${cats.map((c) => `<li><span class="sw" style="background:${c.c}"></span><span class="n"${c.tip ? ` title="${esc(c.tip)}"` : ''}>${c.name}</span><span class="v">${k(c.v)}</span><span class="p">${pct(c.v)}</span></li>`).join('')}
          <li><span class="sw" style="background:var(--line-strong)"></span><span class="n" title="快满时 Agent 会把较早的对话压缩成摘要，这部分空间留给它">自动压缩预留</span><span class="v">${k(BUFFER)}</span><span class="p">${pct(BUFFER)}</span></li>
          <li class="free"><span class="sw"></span><span class="n">剩余空间</span><span class="v">${k(free)}</span><span class="p">${pct(free)}</span></li>
        </ul>
        <div class="ctx-more">
          <details><summary>${ic('right')}MCP 工具<span class="c">12 个服务 · 161 个工具</span></summary><ul>${mcpTools.map(([n, v]) => `<li><span>${esc(n)}</span><span>${k(v)}</span></li>`).join('')}</ul></details>
          <details><summary>${ic('right')}记忆文件<span class="c">${memFiles.length}</span></summary><ul>${memFiles.map(([n, v]) => `<li><span class="mono">${esc(n)}</span><span>${k(v)}</span></li>`).join('')}</ul></details>
        </div>`, `<span class="grow"></span><span class="sub">${p.toFixed(0)}% · Claude Code · Opus 5.5</span>`),
      // 整个会话的累计 token 用量（不是某一轮）
      sec('d-tok', '会话 token 用量', `
        <div class="tok-hero"><b>${k(sum('input') + sum('output'))}</b><span>${turns} 轮 · 2 段会话 · 从 今天 14:02 开始</span></div>
        <dl class="d-dl">
          <dt>输入</dt><dd>${k(sum('input'))}</dd>
          <dt class="ind">其中读缓存</dt><dd>${k(sum('cacheRead'))}（${Math.round((sum('cacheRead') / sum('input')) * 100)}%）</dd>
          <dt class="ind">其中写缓存</dt><dd>${k(sum('cacheWrite'))}</dd>
          <dt>输出</dt><dd>${k(sum('output'))}</dd>
          <dt class="ind">其中思考</dt><dd>${k(sum('think'))}</dd>
        </dl>
        <ul class="d-segs" aria-label="按会话段">${segs.map((s) => `<li><span>${s.name} · ${s.model}<span class="sub"> · ${s.turns} 轮</span></span><span${s.reported ? '' : ' class="sub"'}>${s.reported ? k(s.input + s.output) : '未报告'}</span></li>`).join('')}</ul>
        <dl class="d-dl" style="margin-top:8px"><dt>费用</dt><dd class="sub">订阅账号，不单独计费</dd><dt>账号额度</dt><dd>个人订阅 · 本周已用 46%</dd></dl>
        <div class="quota-bar" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="46" aria-label="本周额度已用 46%，周一 08:00 重置"><span style="width:46%"></span></div>
        <p class="d-note">CodeBuddy 没有报告用量，合计里不含它那 1 轮。</p>`, `<span class="grow"></span><span class="sub">${k(sum('input') + sum('output'))} · ${turns} 轮</span>`),
      // 连接：本任务的 MCP 服务（参照 Claude Desktop 的 Connectors）
      sec('d-conn', '连接', `<ul class="d-list conn">
        ${conn.map((c) => `<li${c.st === 'off' ? ' class="off"' : ''}><span class="lt" aria-hidden="true">${c.l}</span><span class="t">${esc(c.n)}${c.st === 'off' ? '<span class="sub"> · 已停用</span>' : ''}</span>${c.st === 'reconnect' ? `<span class="r"><button type="button" class="linkish attn" data-wired="1" data-d="reconnect" data-n="${esc(c.n)}" title="${esc(c.why)}">重新连接</button></span>` : ''}</li>`).join('')}
      </ul><button type="button" class="linkish more" data-wired="1" data-d="more-conn">${showAll.conn ? '收起' : `再显示 ${connectors.length - 4} 个`}</button>`,
        `<span class="grow"></span><span class="sub">${connectors.filter((c) => c.st === 'ok').length} 个可用</span>`),
      // 输出：这个会话新建或修改的文件（参照 Claude Desktop 的 Outputs）
      sec('d-out', '输出', `<ul class="d-list out">
        ${outs.map((o) => `<li><button type="button" class="ob" data-wired="1" data-d="open" data-p="${esc(o.p)}" title="${esc(o.p)}${o.note ? '（' + esc(o.note) + '）' : ''}">${ic('file')}<span class="t"><span class="fn">${esc(o.p.split('/').pop())}</span><span class="sub"> ${esc(o.p.split('/').slice(0, -1).join('/'))}</span></span>${o.add || o.del ? `<span class="r"><span class="add">+${o.add}</span>${o.del ? ` <span class="del">−${o.del}</span>` : ''}</span>` : `<span class="r sub">${o.k === 'A' ? '新建' : ''}</span>`}</button></li>`).join('')}
      </ul><button type="button" class="linkish more" data-wired="1" data-d="more-out">${showAll.out ? '收起' : `再显示 ${outputs.length - 5} 个`}</button>`,
        `<span class="grow"></span><span class="sub">${outputs.length} 个文件</span>`),
    ].join('');
  };
  panel?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-d], [data-tog]'); if (!b) return;
    const d = b.dataset.d;
    if (b.dataset.tog) { toggleSec(b.dataset.tog); return; }
    if (d === 'more-conn') { showAll.conn = !showAll.conn; render(); }
    else if (d === 'more-out') { showAll.out = !showAll.out; render(); }
    else if (d === 'reconnect') { const c = connectors.find((x) => x.n === b.dataset.n); b.textContent = '连接中…'; setTimeout(() => { c.st = 'ok'; render(); toast(`${esc(c.n)} 已重新连接`); }, 900); }
    else if (d === 'env-save') toast('已存为常用环境“本机 · 雾港物语”，新建任务时可以一键选用');
    else if (d === 'open') { window.aicOpenSide?.('t-diff'); toast(`在“改动”里打开 ${esc(b.dataset.p)}`); }
  });

  // 分段横条的悬停 / 聚焦提示
  let tip = null;
  const showTip = (el) => {
    tip?.remove();
    document.body.insertAdjacentHTML('beforeend', `<div class="ctx-tip" role="tooltip">${el.dataset.tip}</div>`);
    tip = document.body.lastElementChild;
    const r = el.getBoundingClientRect();
    tip.style.left = Math.max(8, Math.min(innerWidth - tip.offsetWidth - 8, r.left + r.width / 2 - tip.offsetWidth / 2)) + 'px';
    tip.style.top = (r.top - tip.offsetHeight - 8) + 'px';
  };
  const hideTip = () => { tip?.remove(); tip = null; };
  document.addEventListener('mouseover', (e) => { const s = e.target.closest?.('.ctx-bar > span[data-tip]'); if (s) showTip(s); });
  document.addEventListener('mouseout', (e) => { if (e.target.closest?.('.ctx-bar > span[data-tip]')) hideTip(); });
  document.addEventListener('focusin', (e) => { const s = e.target.closest?.('.ctx-bar > span[data-tip]'); if (s) showTip(s); });
  document.addEventListener('focusout', (e) => { if (e.target.closest?.('.ctx-bar > span[data-tip]')) hideTip(); });

  // ---------- 每轮回复下面的用量小字 ----------
  const turnUsage = (t) => `<div class="turn-usage" aria-label="这一轮的用量">${t.reported
    ? `<span title="输入 ${t.input.toLocaleString()}，其中读缓存 ${t.cache.toLocaleString()}；输出 ${t.output.toLocaleString()}">${ic('chart')}${k(t.input + t.output)} token</span><span>输入 ${k(t.input)} · 输出 ${k(t.output)}</span>`
    : `<span class="na" title="这个 Agent 没有报告每轮用量">${ic('chart')}用量：${esc(t.name)} 未报告</span>`}${t.dur ? `<span>用时 ${t.dur}</span>` : ''}</div>`;
  const firstTurn = $$('.msg.turn')[0];
  firstTurn && $('.answer', firstTurn)?.insertAdjacentHTML('afterend', turnUsage({ reported: false, name: 'CodeBuddy', dur: '1 分 12 秒' }));

  // 新的回复结束时：上下文和会话累计增长，补上这一轮的用量（原型模拟）
  const inner = $('.stream-inner');
  if (inner) new MutationObserver((ms) => {
    for (const m of ms) for (const n of m.addedNodes) {
      if (!(n instanceof HTMLElement)) continue;
      if (n.matches('.msg.user')) cats[0].v += 600;
      if (n.matches('.msg.turn')) {
        const tryAdd = () => {
          if ($('.turn-usage', n)) return;
          if ($('.pl.thinking', n) || !$('.answer, .text', n)) return setTimeout(tryAdd, 500);
          const t = { reported: true, input: 9_800 + Math.round(Math.random() * 3000), output: 600 + Math.round(Math.random() * 900) };
          t.cache = Math.round(t.input * 0.82);
          cats[0].v += t.output + 900;
          const s = segs[1]; s.turns++; s.input += t.input; s.output += t.output; s.cacheRead += t.cache; s.think += 300;
          ($$('.answer', n).pop() || $$('.text', n).pop()).insertAdjacentHTML('afterend', turnUsage(t));
          paintRing(); render();
        };
        setTimeout(tryAdd, 800);
      }
    }
    paintRing();
  }).observe(inner, { childList: true });

  paintRing();
  render();
  window.aicUsage = { render, paintRing };
})();
