// 上下文用量与 token 统计（2026-11-07，ui-design.md 6.6，docs/research/openbitfun.md）。
// - 输入框上方信息行：项目 · 分支 · 运行位置，右侧是上下文用量圆环（70% 变琥珀，90% 变红）
// - 点圆环：上下文明细（参照 Claude 的 Context 面板）+ 本任务 token 用量 + 账号额度
// - 每轮回复下面一行用量小字；Agent 没报告的写“未报告”，不用 0 冒充
// - 右侧面板“计划”里的上下文小条
// 数据都是原型示例；正式版来自 ACP 的 usage_update（总量、窗口）和每轮 usage，分类明细只有 Claude Code 能给。
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const ic = (n) => `<svg class="i" aria-hidden="true"><use href="#i-${n}"/></svg>`;
  const esc = window.aicEsc || ((s) => String(s));
  const composerInner = $('.composer .composer-inner');
  const box = $('.composer .compose-box');
  if (!composerInner || !box) return;

  const WINDOW = 200_000;
  // 分类：颜色按实体固定（图表色板前 4 位 + 灰），不随占比排名变
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
  const mcpServers = [['blender', 4_100], ['unity-mcp', 3_600], ['houdini', 2_200], ['filesystem', 1_500], ['git', 1_100], ['其他 7 个', 1_700]];
  const memFiles = [['AGENTS.md', 420], ['项目记忆（3 条固定）', 140], ['.agent/records.md', 40]];
  // 本任务用量：按段（交接前后各一段）
  const segs = [
    { ag: 'codebuddy', name: 'CodeBuddy', model: 'glm-5.1', input: null, output: null, cache: null, think: null, reported: false },
    { ag: 'claude', name: 'Claude Code', model: 'Opus 5.5', input: 61_200, output: 9_800, cache: 48_900, think: 3_400, reported: true },
  ];

  const k = (n) => (n == null ? '—' : n >= 1_000_000 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1000 ? (n / 1000).toFixed(n >= 100_000 ? 0 : 1).replace(/\.0$/, '') + 'k' : String(n));
  const pct = (n) => { const p = (n / WINDOW) * 100; return p >= 10 ? p.toFixed(1) + '%' : p.toFixed(1) + '%'; };
  const used = () => cats.reduce((s, c) => s + c.v, 0);
  const level = (p) => (p >= 90 ? 'crit' : p >= 70 ? 'warn' : 'ok');

  // ---------- 信息行 + 圆环 ----------
  const branch = 'aic/t8f2-fix-save-corrupt';
  box.insertAdjacentHTML('beforebegin', `<div class="ctx-row" aria-label="任务信息">
      <span class="it" title="项目文件夹 D:\\Games\\FogHarbor">${ic('folder')}雾港物语</span><span class="sep"></span>
      <span class="it mono" title="工作副本的分支">${ic('branch')}${esc(branch)}</span><span class="sep"></span>
      <span class="it" title="Agent 运行在哪台电脑">${ic('devices')}本机</span>
      <span class="grow"></span>
      <button type="button" class="ctx-ring" data-wired="1" aria-haspopup="dialog" aria-expanded="false" aria-controls="ctx-pop"></button>
    </div>`);
  const ring = $('.ctx-row .ctx-ring');
  const paintRing = () => {
    const u = used(), p = (u / WINDOW) * 100, r = 6, c = 2 * Math.PI * r;
    ring.dataset.level = level(p);
    ring.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><circle class="track" cx="8" cy="8" r="${r}" fill="none" stroke-width="2.5"/><circle class="fill" cx="8" cy="8" r="${r}" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="${(c * Math.min(p, 100)) / 100} ${c}"/></svg><span class="pct">${Math.round(p)}%</span>`;
    ring.setAttribute('aria-label', `上下文已用 ${Math.round(p)}%（约 ${k(u)} / ${k(WINDOW)}），点击查看明细`);
    ring.title = `上下文已用 ${Math.round(p)}%（约 ${k(u)} / ${k(WINDOW)}）${p >= 70 ? '，快满时 Agent 会自动压缩较早的对话' : ''}`;
  };

  // ---------- 明细弹出层 ----------
  composerInner.insertAdjacentHTML('beforeend', '<div class="ctx-pop" id="ctx-pop" role="dialog" aria-label="上下文与用量" tabindex="-1" hidden></div>');
  const pop = $('#ctx-pop');
  const barHtml = (withFree = true) => {
    const u = used(), free = WINDOW - u - BUFFER;
    const parts = [...cats.map((c) => ({ ...c })), { k: 'buf', name: '自动压缩预留', v: BUFFER, c: 'var(--line-strong)' }];
    return `<div class="ctx-bar" role="img" aria-label="上下文分布：${parts.map((p) => `${p.name} ${k(p.v)}`).join('，')}，剩余 ${k(free)}">
      ${parts.filter((p) => p.v > 0).map((p) => `<span tabindex="0" data-tip="${esc(p.name)}：${k(p.v)}（${pct(p.v)}）" style="flex:${p.v} 0 0;background:${p.c}"></span>`).join('')}
      ${withFree ? `<span class="free" style="flex:${free} 0 0" data-tip="剩余空间：${k(free)}（${pct(free)}）" tabindex="0"></span>` : ''}
    </div>`;
  };
  const renderPop = () => {
    const u = used(), free = WINDOW - u - BUFFER, p = (u / WINDOW) * 100;
    const rep = segs.filter((s) => s.reported);
    const sum = (f) => rep.reduce((s, x) => s + (x[f] ?? 0), 0);
    pop.innerHTML = `
      <h3>上下文<span class="grow"></span><span class="muted" style="font-weight:400;font-size:var(--fs-12);color:var(--fg-3)">Claude Code · Opus 5.5</span></h3>
      <div class="tot"><b>已用 ${p.toFixed(0)}%</b><span>${k(u)} / ${k(WINDOW)}</span></div>
      ${barHtml()}
      <ul class="ctx-legend" aria-label="上下文分类">
        ${cats.map((c) => `<li data-k="${c.k}"><span class="sw" style="background:${c.c}"></span><span class="n"${c.tip ? ` title="${esc(c.tip)}"` : ''}>${c.name}</span><span class="v">${k(c.v)}</span><span class="p">${pct(c.v)}</span></li>`).join('')}
        <li data-k="buf"><span class="sw" style="background:var(--line-strong)"></span><span class="n" title="快满时 Agent 会把较早的对话压缩成摘要，这部分空间留给它">自动压缩预留</span><span class="v">${k(BUFFER)}</span><span class="p">${pct(BUFFER)}</span></li>
        <li class="free"><span class="sw"></span><span class="n">剩余空间</span><span class="v">${k(free)}</span><span class="p">${pct(free)}</span></li>
      </ul>
      <div class="ctx-more">
        <details><summary>${ic('right')}MCP 工具<span class="c">12 个服务 · 161 个工具</span></summary><ul>${mcpServers.map(([n, v]) => `<li><span>${esc(n)}</span><span>${k(v)}</span></li>`).join('')}</ul></details>
        <details><summary>${ic('right')}记忆文件<span class="c">${memFiles.length}</span></summary><ul>${memFiles.map(([n, v]) => `<li><span class="mono">${esc(n)}</span><span>${k(v)}</span></li>`).join('')}</ul></details>
      </div>
      <div class="ctx-sec">
        <h4>本任务 token 用量<span class="grow"></span><span style="font-weight:400;color:var(--fg-3)">2 段</span></h4>
        <dl>
          <dt>输入</dt><dd>${k(sum('input'))}</dd>
          <dt>输出</dt><dd>${k(sum('output'))}</dd>
          <dt>其中思考</dt><dd>${k(sum('think'))}</dd>
          <dt>缓存命中</dt><dd>${k(sum('cache'))}（${Math.round((sum('cache') / sum('input')) * 100)}%）</dd>
          ${segs.map((s) => `<dt>${s.name} · ${s.model}</dt><dd${s.reported ? '' : ' class="na"'}>${s.reported ? k((s.input ?? 0) + (s.output ?? 0)) : '未报告'}</dd>`).join('')}
          <dt>费用</dt><dd class="na">订阅账号，不单独计费</dd>
        </dl>
      </div>
      <div class="ctx-sec">
        <h4>账号额度<span class="grow"></span><span style="font-weight:400;color:var(--fg-3)">个人订阅</span></h4>
        <div class="quota"><span>本周已用 46%</span><span style="color:var(--fg-3)">周一 08:00 重置</span><div class="bar" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="46" aria-label="本周额度已用 46%"><span style="width:46%"></span></div></div>
      </div>
      <p class="ctx-note">分类明细来自 Claude Code；Codex、CodeBuddy 只报告总量时这里只显示总量。没报告的数字写“未报告”。</p>`;
  };
  const openPop = (v) => {
    pop.hidden = !v;
    ring.setAttribute('aria-expanded', String(v));
    if (v) { renderPop(); pop.focus(); }
  };
  ring.addEventListener('click', () => openPop(pop.hidden));
  document.addEventListener('mousedown', (e) => { if (!pop.hidden && !pop.contains(e.target) && !ring.contains(e.target)) openPop(false); });
  pop.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); openPop(false); ring.focus(); } });

  // 分段的悬停 / 聚焦提示，图例对应行高亮
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

  // ---------- 右侧面板“计划”里的上下文小条 ----------
  const planCtx = () => {
    const plan = $('#p-plan');
    if (!plan) return;
    const old = $$('h3', plan).find((h) => h.textContent.trim() === '上下文');
    const dl = old?.nextElementSibling;
    const u = used();
    const html = `<section class="side-ctx" aria-label="上下文">
      <h3>上下文<span class="grow"></span><button type="button" class="btn sm ghost" data-wired="1" data-ctx-open>查看明细</button></h3>
      <div class="tot"><span>已用 ${Math.round((u / WINDOW) * 100)}%</span><span>${k(u)} / ${k(WINDOW)}</span></div>
      ${barHtml()}
      <dl><dt>工作区</dt><dd>git worktree，基于 main</dd><dt>会话</dt><dd>2 段（CodeBuddy → Claude Code）</dd><dt>本任务用量</dt><dd>输入 ${k(segs[1].input)} · 输出 ${k(segs[1].output)}（CodeBuddy 未报告）</dd></dl>
    </section>`;
    const cur = $('.side-ctx', plan);
    if (cur) cur.outerHTML = html;
    else if (old && dl) { old.remove(); dl.outerHTML = html; }
    $('[data-ctx-open]', plan)?.addEventListener('click', () => openPop(true));
  };

  // ---------- 每轮回复下面的用量小字 ----------
  const turnUsage = (t) => `<div class="turn-usage" aria-label="这一轮的用量">${t.reported
    ? `<button type="button" data-wired="1" title="输入 ${t.input.toLocaleString()}，其中缓存命中 ${t.cache.toLocaleString()}；输出 ${t.output.toLocaleString()}，其中思考 ${t.think.toLocaleString()}">${ic('chart')}${k(t.input + t.output)} token</button><span>输入 ${k(t.input)} · 输出 ${k(t.output)}</span><span>缓存 ${Math.round((t.cache / t.input) * 100)}%</span>`
    : `<span class="na" title="这个 Agent 没有报告每轮用量">${ic('chart')}用量：${esc(t.name)} 未报告</span>`}${t.dur ? `<span>用时 ${t.dur}</span>` : ''}</div>`;
  const firstTurn = $$('.msg.turn')[0];
  firstTurn && $('.answer', firstTurn)?.insertAdjacentHTML('afterend', turnUsage({ reported: false, name: 'CodeBuddy', dur: '1 分 12 秒' }));

  // 新的回复结束时：上下文增长，补上这一轮的用量（原型模拟）
  const inner = $('.stream-inner');
  if (inner) new MutationObserver((ms) => {
    for (const m of ms) for (const n of m.addedNodes) {
      if (!(n instanceof HTMLElement)) continue;
      if (n.matches('.msg.user')) { cats[0].v += 600; }
      if (n.matches('.msg.turn')) {
        const tryAdd = () => {
          if ($('.turn-usage', n)) return;
          if ($('.pl.thinking', n) || !$('.answer, .text', n)) return setTimeout(tryAdd, 500);
          const t = { reported: true, input: 9_800 + Math.round(Math.random() * 3000), output: 600 + Math.round(Math.random() * 900), think: 300, dur: null };
          t.cache = Math.round(t.input * 0.82);
          cats[0].v += t.output + 900;
          segs[1].input += t.input; segs[1].output += t.output; segs[1].cache += t.cache; segs[1].think += t.think;
          ($$('.answer', n).pop() || $$('.text', n).pop()).insertAdjacentHTML('afterend', turnUsage(t));
          paintRing(); planCtx(); if (!pop.hidden) renderPop();
        };
        setTimeout(tryAdd, 800);
      }
    }
    paintRing();
  }).observe(inner, { childList: true });

  paintRing();
  planCtx();
  window.aicUsage = { open: () => openPop(true), add(n) { cats[0].v += n; paintRing(); planCtx(); if (!pop.hidden) renderPop(); } };
})();
