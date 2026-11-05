// 监控页：概览、用量图表（纯 SVG）、Agent 健康、任务表现、卡住检测、判断准确度、告警规则、最近事件。
// 只做原型演示，数据都是示例。依赖 app.js 与 interact.js。
(function () {
  if (document.body.dataset.page !== 'monitor') return;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const { aicToast: toast, aicModal: modal, aicMenu: menu, aicEsc: esc, aicAgents: agents, aicJudge: judge, aicJudgeOn: judgeOn, aicJudgeKinds: kinds, aicJudgeFixes: fixes, aicSB: SB } = window;
  const ic = (n) => window.icon(n);
  const letter = { claude: 'C', codex: 'X', codebuddy: 'B', zcode: 'Z' };
  const WK = '日一二三四五六';
  const shift = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  const fmt = (d) => { const now = new Date(), hm = d.toTimeString().slice(0, 5); return sameDay(d, now) ? '今天 ' + hm : sameDay(d, shift(now, -1)) ? '昨天 ' + hm : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`; };
  const minsAgo = (m) => new Date(Date.now() - m * 60000);
  const stamp = () => { $('.main-head .meta').textContent = `数据更新于 ${new Date().toTimeString().slice(0, 5)}`; };

  // ---------- 概览 ----------
  const quotas = [
    ['个人订阅', 'Claude Code', 46, '本周已用，周一 08:00 重置'],
    ['WorkBuddy 登录', 'CodeBuddy', 82, '本周已用，超过告警线 80%'],
    ['ChatGPT 账号', 'Codex', 12, '登录已过期，暂停计数'],
  ];
  const renderTiles = () => {
    const run = SB.tasks.filter((t) => t.st === 'run');
    const wait = SB.tasks.filter((t) => t.st === 'wait');
    const byAg = Object.entries(run.reduce((m, t) => ((m[t.ag] = (m[t.ag] || 0) + 1), m), {})).map(([k, n]) => `${agents[k][0]} ${n}`).join('、');
    $('#tiles').innerHTML = `
      <section class="tile"><h3>运行中任务</h3><p class="val">${run.length}</p><p class="sub">${byAg || '没有'}</p></section>
      <section class="tile ${wait.length ? 'needs' : ''}"><h3>等你处理</h3><p class="val">${wait.length}</p><p class="sub">${wait.length ? `<span class="status wait"><span class="dot"></span>${wait.length} 项审批</span>` : '没有'}</p>${wait.length ? '<a class="btn sm attn" data-wired="1" href="workbench.html#approval">去处理</a>' : ''}</section>
      <section class="tile"><h3>今日失败</h3><p class="val">2</p><p class="sub"><span class="status err"><span class="dot"></span>1 个任务、1 次自动化</span></p><button class="btn sm" data-wired="1" data-go-events="fail">看失败记录</button></section>
      <section class="tile wide"><h3>今日用量</h3><ul class="meters" aria-label="各账号额度已用比例">${quotas.map(([a, ag, p, note]) => `
        <li><span class="mt"><b>${a}</b><span class="sub">${ag}</span><span class="pct">${p}%${p >= 80 ? '<span class="status wait" style="margin-left:6px"><span class="dot"></span>超过 80%</span>' : ''}</span></span>
          <span class="meter ${p >= 80 ? 'hot' : ''}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p}" aria-label="${a} 已用 ${p}%，${note}"><i style="width:${p}%"></i></span><span class="sub">${note}</span></li>`).join('')}</ul></section>
      <section class="tile"><h3>今日预估费用</h3><p class="val">$3.42</p><p class="sub">工作室 API Key（Claude Code）<br>本月累计 $41.80</p></section>`;
  };

  // ---------- 用量图表：近 7 天，按 Agent / 账号 / 项目 ----------
  // 颜色用 dataviz 校验过的分类色板（见 monitor.html 的 --series-*），跟着实体走，切换维度时不按排名重新上色。
  const raw = {
    claude: [2.1, 2.8, 1.6, 3.4, 2.9, 3.6, 2.2],
    codex: [0.9, 1.2, 0.4, 1.1, 0.8, 0, 0],
    codebuddy: [1.4, 1.1, 0.9, 1.8, 2.4, 2.1, 1.6],
    zcode: [0.2, 0, 0, 0.3, 0, 0, 0],
  };
  const projShare = [0.25, 0.3, 0.4, 0.2, 0.35, 0.3, 0.45]; // 第二个项目每天的占比
  const r1 = (v) => Math.round(v * 10) / 10;
  const series = (dim) => {
    if (dim === 'agent') return Object.keys(raw).map((k, i) => ({ name: agents[k][0], slot: i + 1, vals: raw[k] }));
    if (dim === 'account') return [
      { name: '个人订阅', slot: 1, vals: raw.claude.map((v) => r1(v * 0.6)) },
      { name: '工作室 API Key', slot: 2, vals: raw.claude.map((v) => r1(v * 0.4)) },
      { name: 'ChatGPT 账号', slot: 3, vals: raw.codex },
      { name: 'WorkBuddy 登录', slot: 4, vals: raw.codebuddy },
      { name: 'Z.AI 账号', slot: 5, vals: raw.zcode },
    ];
    // 按项目：复用侧栏的项目列表；前两个项目分摊示例用量，之后新加的项目还没有用量
    const total = raw.claude.map((_, i) => Object.values(raw).reduce((s, a) => s + a[i], 0));
    return SB.projects.slice(0, 5).map((p, pi) => ({ name: p.name, slot: pi + 1,
      vals: total.map((t, i) => (pi === 0 ? r1(t * (1 - projShare[i])) : pi === 1 ? r1(t * projShare[i]) : 0)) }));
  };
  const days = Array.from({ length: 7 }, (_, i) => shift(new Date(), i - 6));
  const dayLabel = (d, i) => (i === 6 ? '今天' : `${d.getMonth() + 1}/${d.getDate()}`);
  let dim = 'agent', mode = 'chart';
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs = {}, parent) => { const e = document.createElementNS(NS, tag); Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v)); parent?.appendChild(e); return e; };
  const topRounded = (x, y, w, h, r) => { r = Math.min(r, h, w / 2); return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`; };

  const renderChart = () => {
    const S = series(dim).filter((s) => s.vals.some((v) => v > 0));
    const totals = days.map((_, i) => r1(S.reduce((s, x) => s + x.vals[i], 0)));
    // 图例：名字用文字令牌，颜色只在色块上
    const lg = $('#legend'); lg.textContent = '';
    S.forEach((s) => { const li = document.createElement('li'); const sw = document.createElement('span'); sw.className = 'sw'; sw.style.background = `var(--series-${s.slot})`; li.append(sw, document.createTextNode(s.name)); lg.appendChild(li); });
    // 表格视图
    const tbl = $('#usage-table');
    tbl.textContent = '';
    const thead = tbl.createTHead().insertRow();
    ['日期', ...S.map((s) => s.name), '合计'].forEach((h) => { const th = document.createElement('th'); th.scope = 'col'; th.textContent = h; thead.appendChild(th); });
    const tb = tbl.createTBody();
    days.forEach((d, i) => { const r = tb.insertRow(); const th = document.createElement('th'); th.scope = 'row'; th.textContent = `${d.getMonth() + 1}月${d.getDate()}日 周${WK[d.getDay()]}${i === 6 ? '（截至现在）' : ''}`; r.appendChild(th); [...S.map((s) => s.vals[i]), totals[i]].forEach((v) => { r.insertCell().textContent = v.toFixed(1); }); });

    const svg = $('#usage-svg'); svg.textContent = '';
    const W = 640, H = 236, L = 34, R = 8, T = 18, B = 26;
    const maxT = Math.max(...totals), top = Math.max(2, Math.ceil(maxT / 2) * 2);
    const y = (v) => T + (H - T - B) * (1 - v / top);
    const band = (W - L - R) / 7, bw = Math.min(24, band * 0.45);
    // 网格与坐标轴：实线细线，退在后面
    for (let v = 0; v <= top; v += 2) {
      el('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: v === 0 ? 'axis' : 'grid' }, svg);
      const t = el('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'tick' }, svg); t.textContent = v;
    }
    const plot = el('g', {}, svg);
    days.forEach((d, i) => {
      const cx = L + band * i + band / 2;
      const g = el('g', { class: 'col' }, plot);
      let acc = 0;
      const live = S.map((s, si) => ({ s, v: s.vals[i], si })).filter((x) => x.v > 0);
      live.forEach((x, k) => {
        const y0 = y(acc), y1 = y(acc + x.v); acc += x.v;
        const h = Math.max(0, y0 - y1 - (k > 0 ? 2 : 0)); // 和下面一段之间留 2px 底色空隙
        if (k === live.length - 1) el('path', { d: topRounded(cx - bw / 2, y1, bw, h, 4), fill: `var(--series-${x.s.slot})` }, g);
        else el('rect', { x: cx - bw / 2, y: y1, width: bw, height: h, fill: `var(--series-${x.s.slot})` }, g);
      });
      const xl = el('text', { x: cx, y: H - 8, 'text-anchor': 'middle', class: 'tick' }, svg); xl.textContent = dayLabel(d, i);
      // 只直接标出今天的合计和 7 天里的最大值，其他数值看坐标、提示框或表格
      if (i === 6 || totals[i] === maxT) { const tl = el('text', { x: cx, y: y(totals[i]) - 6, 'text-anchor': 'middle', class: 'vlabel' }, svg); tl.textContent = totals[i].toFixed(1); }
      // 命中区域比柱子大：整列都能悬停，键盘可聚焦
      const hit = el('rect', { x: L + band * i, y: T, width: band, height: H - T - B, class: 'hit', tabindex: 0, role: 'img',
        'aria-label': `${d.getMonth() + 1}月${d.getDate()}日：合计 ${totals[i].toFixed(1)} 百万 token；${S.map((s) => `${s.name} ${s.vals[i].toFixed(1)}`).join('，')}` }, svg);
      const show = () => showTip(i, cx, S, totals, d);
      hit.addEventListener('pointerenter', show); hit.addEventListener('focus', show);
      hit.addEventListener('pointerleave', hideTip); hit.addEventListener('blur', hideTip);
    });
    $('#chart-wrap').hidden = mode !== 'chart';
    $('#table-wrap').hidden = mode !== 'table';
    $('#usage-sum').textContent = `近 7 天合计 ${r1(totals.reduce((a, b) => a + b, 0)).toFixed(1)} 百万 token，单位：百万 token`;
  };
  const tip = $('#tip');
  const showTip = (i, cx, S, totals, d) => {
    $$('#usage-svg .col').forEach((c, k) => c.classList.toggle('dim', k !== i));
    tip.textContent = '';
    const h = document.createElement('div'); h.className = 'th'; h.textContent = `${d.getMonth() + 1}月${d.getDate()}日 周${WK[d.getDay()]}`; tip.appendChild(h);
    const row = (name, v, slot) => {
      const r = document.createElement('div'); r.className = 'tr';
      const k = document.createElement('span'); k.className = 'key'; if (slot) k.style.background = `var(--series-${slot})`;
      const b = document.createElement('b'); b.textContent = v.toFixed(1);
      const n = document.createElement('span'); n.textContent = name;
      r.append(k, b, n); tip.appendChild(r);
    };
    [...S].reverse().forEach((s) => row(s.name, s.vals[i], s.slot));
    row('合计', totals[i]);
    const svg = $('#usage-svg'), box = svg.getBoundingClientRect(), wrap = $('#chart-wrap').getBoundingClientRect();
    const px = box.left - wrap.left + (cx / 640) * box.width;
    tip.hidden = false;
    tip.style.left = Math.min(Math.max(px - tip.offsetWidth / 2, 0), wrap.width - tip.offsetWidth) + 'px';
  };
  const hideTip = () => { tip.hidden = true; $$('#usage-svg .col').forEach((c) => c.classList.remove('dim')); };
  $('#dim').addEventListener('click', (e) => { const b = e.target.closest('[data-dim]'); if (!b) return; dim = b.dataset.dim; $$('#dim [data-dim]').forEach((x) => x.setAttribute('aria-checked', String(x === b))); renderChart(); });
  $('#vmode').addEventListener('click', (e) => { const b = e.target.closest('[data-mode]'); if (!b) return; mode = b.dataset.mode; $$('#vmode [data-mode]').forEach((x) => x.setAttribute('aria-checked', String(x === b))); renderChart(); });
  [$('#dim'), $('#vmode')].forEach((g) => g.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const bs = $$('button', g), i = bs.indexOf(document.activeElement); if (i < 0) return;
    e.preventDefault(); const n = bs[(i + (e.key === 'ArrowRight' ? 1 : bs.length - 1)) % bs.length]; n.focus(); n.click();
  }));
  document.addEventListener('themechange', renderChart);

  // ---------- Agent 健康 ----------
  const health = [
    { k: 'claude', st: ['run', '运行中'], mem: '640 MB', ses: '2 / 2', quota: '个人订阅剩 54%', err: '无' },
    { k: 'codex', st: ['wait', '需要登录'], mem: '未启动', ses: '0 / 2', quota: '—', err: '昨天 14:20 登录已过期（401）', act: '<a class="btn sm attn" data-wired="1" href="agents.html">重新登录</a>' },
    { k: 'codebuddy', st: ['run', '运行中'], mem: '1.1 GB', ses: '1 / 2', quota: 'WorkBuddy 剩 18%', quotaWarn: true, err: '13:05 进程崩溃，3 秒后自动重启（今天第 1 次）', act: '<button class="btn sm" data-wired="1" data-hact="log">查看日志</button><button class="btn sm" data-wired="1" data-hact="restart">重启进程</button>' },
    { k: 'zcode', st: ['idle', '未连接'], mem: '—', ses: '—', quota: '—', err: '需要先启用实验桥接', act: '<a class="btn sm" data-wired="1" href="agents.html">去 Agent 管理</a>' },
  ];
  const renderHealth = () => {
    $('#health tbody').innerHTML = health.map((h) => `<tr data-k="${h.k}">
      <th scope="row"><span class="ag ${h.k}" aria-hidden="true">${letter[h.k]}</span>${agents[h.k][0]}</th>
      <td><span class="status ${h.st[0]}"><span class="dot"></span>${h.st[1]}</span></td>
      <td class="num">${h.mem}</td><td class="num">${h.ses}</td>
      <td>${h.quotaWarn ? `<span class="status wait"><span class="dot"></span>${h.quota}</span>` : h.quota}</td>
      <td class="err-t">${h.err}</td><td class="acts">${h.act || ''}</td></tr>`).join('');
  };
  $('#health').addEventListener('click', (e) => {
    const b = e.target.closest('[data-hact]'); if (!b) return;
    if (b.dataset.hact === 'log') modal({ title: 'CodeBuddy 进程日志（最后 6 行）', wide: true,
      body: `<pre class="mono" style="margin:0;padding:10px 12px;background:var(--bg-0);border-radius:var(--r-ctl);white-space:pre-wrap">13:05:41  codebuddy.js 退出，退出码 134（内存不足）
13:05:41  正在运行的会话：宝箱模型：箱盖改圆、补铁箍
13:05:44  自动重启进程（第 1 次，上限 3 次）
13:05:46  ACP 握手成功，恢复会话 s-7c3
13:05:47  从第 2/4 步继续，没有丢失进度
13:05:47  已发出事件：Agent 进程崩溃 → 已恢复</pre><p style="margin:var(--sp-3) 0 0">原因是一次加载了太多贴图。连续崩溃 3 次会停止重启并通知你。</p>`,
      actions: [{ label: '复制日志', onClick() { navigator.clipboard?.writeText('CodeBuddy 13:05 崩溃日志').catch(() => {}); toast('已复制日志'); return false; } }, { label: '关闭', kind: 'primary' }] });
    else modal({ title: '重启 CodeBuddy 进程？', body: '<p>正在运行的 1 个会话会先保存进度，重启后从当前步骤继续，大约 5 秒。</p>',
      actions: [{ label: '取消' }, { label: '重启', kind: 'primary', onClick() {
        b.setAttribute('aria-busy', 'true'); b.textContent = '重启中…';
        setTimeout(() => { const h = health[2]; h.mem = '480 MB'; h.err = `${new Date().toTimeString().slice(0, 5)} 手动重启，正常`; renderHealth(); addEvent({ at: new Date(), type: 'crash', lv: 'ok', title: 'CodeBuddy 进程已手动重启', detail: '1 个会话从当前步骤继续' }); toast('CodeBuddy 已重启，会话已恢复'); }, 1400);
      } }] });
  });

  // ---------- 任务表现（近 7 天） ----------
  const perf = [
    ['claude', '92%', '23 / 25', '18 分钟', 1, 2],
    ['codex', '78%', '7 / 9', '24 分钟', 2, 1],
    ['codebuddy', '88%', '15 / 17', '11 分钟', 0, 3],
    ['zcode', '—', '0 / 0', '—', 0, 0],
  ];
  $('#perf tbody').innerHTML = perf.map(([k, rate, n, avg, stuck, rej]) => `<tr><th scope="row"><span class="ag ${k}" aria-hidden="true">${letter[k]}</span>${agents[k][0]}</th>
    <td class="num">${rate}<span class="sub">${n}</span></td><td class="num">${avg}</td><td class="num">${stuck}</td><td class="num">${rej}</td></tr>`).join('');

  // ---------- 快速判断：可能卡住或原地打转 ----------
  const stuckItems = [
    { id: 't9a1', text: '可能在原地打转', prob: 77, level: 'wait', why: '12 分钟里 4 次修改 InventoryGrid.cs 的同一段，测试结果一直相同' },
    { id: 't4d9', text: '可能卡住了', prob: 64, level: 'wait', why: '9 分钟没有新输出，进程 CPU 接近 0，上一步在等 Blender 返回' },
    { id: 't7c3', text: '正常运行', prob: 93, level: 'ok', why: '持续有新输出，计划进行到第 2/4 步' },
  ];
  const waited = new Set();
  const renderStuck = () => {
    const box = $('#stuck');
    if (!judgeOn('stuck')) { box.innerHTML = `<div class="empty" style="padding:var(--sp-4)"><p>卡住检测在设置里已关闭。监控页仍会按告警规则提醒“10 分钟没有输出”的任务。</p><button class="btn sm" data-wired="1" data-open-settings>打开设置</button></div>`; return; }
    const live = stuckItems.filter((s) => SB.tasks.find((x) => x.id === s.id)?.st === 'run');
    if (!live.length) { box.innerHTML = '<li class="sub">没有运行中的任务</li>'; return; }
    box.innerHTML = live.map((s) => {
      const t = SB.tasks.find((x) => x.id === s.id);
      const waiting = waited.has(s.id);
      const href = t.href || 'workbench.html?' + new URLSearchParams({ title: t.title, st: t.st, stt: t.stText });
      return `<li data-id="${s.id}"><div class="sh"><span class="ag ${t.ag}" aria-hidden="true">${letter[t.ag]}</span><b>${esc(t.title)}</b><span class="sub">${agents[t.ag][0]} · ${esc(t.proj)}</span><span class="grow"></span>
        <a class="btn sm ghost" data-wired="1" href="${href}">打开对话</a>${s.level !== 'ok' && waiting ? '<span class="sub">再观察 10 分钟</span>' : ''}${s.level !== 'ok' && !waiting ? `<button class="btn sm ghost" data-wired="1" data-sact="wait">继续等待</button><button class="btn sm danger" data-wired="1" data-sact="stop">中断…</button>` : ''}</div>
        ${judge({ kind: 'stuck', text: s.text, prob: s.prob, why: s.why, level: s.level })}</li>`;
    }).join('');
  };
  $('#stuck').addEventListener('click', (e) => {
    if (e.target.closest('[data-open-settings]')) { window.aicSettings(); return; }
    const b = e.target.closest('[data-sact]'); if (!b) return;
    const li = b.closest('li'), t = SB.tasks.find((x) => x.id === li.dataset.id);
    if (b.dataset.sact === 'wait') { waited.add(t.id); renderStuck(); toast(`会再观察 10 分钟，“${esc(t.title)}”仍没有进展再提醒你`); return; }
    modal({ title: `中断“${esc(t.title)}”？`, body: '<p>Agent 会停在当前步骤，工作副本和对话都保留。之后可以在对话里补充说明再继续，或者交接给其他 Agent。</p>',
      actions: [{ label: '取消' }, { label: '中断', kind: 'danger', onClick() { Object.assign(t, { st: 'err', stText: '已中断' }); SB.render(); toast(`已中断“${esc(t.title)}”`); } }] });
  });

  // ---------- 判断准确度（近 7 天被你纠正的比例） ----------
  const acc = { risk: [64, 3], agent: [21, 4], done: [18, 2], stuck: [9, 2], grade: [30, 1] };
  const renderAcc = () => {
    const f = fixes();
    $('#acc').innerHTML = Object.entries(kinds).map(([k, name]) => {
      const [n, c0] = acc[k]; const c = c0 + (f[k] || 0); const p = Math.round((c / n) * 1000) / 10;
      const off = !judgeOn(k);
      return `<li><span class="mt"><b>${name}</b>${off ? '<span class="sub">已在设置中关闭</span>' : ''}<span class="pct">${c} / ${n} 被纠正（${p}%）</span></span>
        <span class="meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p}" aria-label="${name}：${n} 次判断里被纠正 ${c} 次，占 ${p}%"><i style="width:${Math.min(100, p)}%"></i></span></li>`;
    }).join('');
  };
  document.addEventListener('aic-judge-fix', renderAcc);
  document.addEventListener('aic-judge-change', () => { renderAcc(); renderStuck(); });

  // ---------- 告警规则 ----------
  const ruleTypes = {
    quota: { name: '账号额度超过', unit: '%', def: 80, opts: [50, 70, 80, 90, 95], scope: ['任何账号', '个人订阅', '工作室 API Key', 'ChatGPT 账号', 'WorkBuddy 登录', 'Z.AI 账号'] },
    stuck: { name: '任务卡住超过', unit: '分钟', def: 10, opts: [5, 10, 20, 30], scope: ['任何任务', '只看自动化产生的任务'], hint: '卡住指一直没有新输出' },
    autofail: { name: '自动化连续失败', unit: '次', def: 2, opts: [1, 2, 3, 5], scope: ['任何自动化', '每晚全量构建并汇总报错', '新 FBX 自动转 glb 并检查面数和命名'] },
    disk: { name: '工作副本占用磁盘超过', unit: 'GB', def: 20, opts: [5, 10, 20, 50, 100], scope: ['所有项目', ...SB.projects.map((p) => p.name)] },
    crash: { name: 'Agent 进程崩溃', unit: '', def: null, opts: [], scope: ['任何 Agent', ...Object.values(agents).map((a) => a[0])], hint: '自动重启成功也会记一条事件；重启失败一定通知' },
    cost: { name: '今日预估费用超过', unit: '$', def: 10, opts: [5, 10, 20, 50], scope: ['所有 API Key 账号', '工作室 API Key'] },
  };
  const notifyNames = { os: '系统通知', sidebar: '侧栏“等你处理”', phone: '已配对的手机', sound: '提示音' };
  const rules = [
    { id: 'r1', type: 'quota', val: 80, scope: '任何账号', notify: ['os', 'sidebar'], on: true, fired: '正在触发：WorkBuddy 登录已用 82%' },
    { id: 'r2', type: 'stuck', val: 10, scope: '任何任务', notify: ['os'], on: true },
    { id: 'r3', type: 'autofail', val: 2, scope: '任何自动化', notify: ['os', 'phone'], on: true },
    { id: 'r4', type: 'disk', val: 20, scope: '所有项目', notify: ['sidebar'], on: true, cur: '现在 14.2 GB' },
    { id: 'r5', type: 'crash', val: null, scope: '任何 Agent', notify: ['os'], on: true },
    { id: 'r6', type: 'cost', val: 10, scope: '所有 API Key 账号', notify: ['os'], on: false },
  ];
  const ruleText = (r) => { const t = ruleTypes[r.type]; return t.unit === '$' ? `${t.name} $${r.val}` : r.val == null ? t.name : `${t.name} ${r.val}${t.unit === '%' ? '%' : ' ' + t.unit}`; };
  const renderRules = () => {
    $('#rules').innerHTML = rules.map((r) => `<li data-id="${r.id}" class="${r.on ? '' : 'off'}">
      <button class="switch" role="switch" data-wired="1" data-rsw aria-checked="${r.on}" aria-label="启用规则：${esc(ruleText(r))}"></button>
      <div class="rb"><b>${esc(ruleText(r))}</b><span class="sub">${esc(r.scope)} · ${r.notify.map((n) => notifyNames[n]).join('、')}${r.on ? '' : ' · 已停用'}</span>
        ${r.fired && r.on ? `<span class="status wait"><span class="dot"></span>${esc(r.fired)}</span>` : r.cur ? `<span class="sub">${esc(r.cur)}</span>` : ''}</div>
      <button class="btn ghost icon sm" data-wired="1" data-rmore aria-label="规则“${esc(ruleText(r))}”的更多操作">${ic('more')}</button></li>`).join('');
  };
  const ruleDialog = (src) => {
    const r = src ? { ...src, notify: [...src.notify] } : { type: 'quota', val: 80, scope: '任何账号', notify: ['os'], on: true };
    modal({
      title: src ? '编辑告警规则' : '新建告警规则',
      body: `<div class="form-row"><label for="rl-t">什么时候</label><select class="select" id="rl-t">${Object.entries(ruleTypes).map(([k, t]) => `<option value="${k}" ${k === r.type ? 'selected' : ''}>${t.name}${t.unit ? ' …' : ''}</option>`).join('')}</select></div>
        <div class="form-row" id="rl-vrow"><label for="rl-v">阈值</label><select class="select" id="rl-v"></select></div>
        <div class="form-row"><label for="rl-s">范围</label><select class="select" id="rl-s"></select></div>
        <p class="field-note" id="rl-h" style="margin-left:96px"></p>
        <fieldset class="fs"><legend>通知方式</legend><div class="radios">${Object.entries(notifyNames).map(([k, n]) => `<label><input type="checkbox" value="${k}" ${r.notify.includes(k) ? 'checked' : ''}>${n}</label>`).join('')}</div></fieldset>
        <label class="check-row"><input type="checkbox" id="rl-on" ${r.on ? 'checked' : ''}> <span>启用这条规则</span></label>
        <div class="rl-prev alert info" style="margin:0" aria-live="polite"></div>`,
      onOpen(d) {
        const q = (s) => $(s, d);
        const fill = (keep) => {
          const t = ruleTypes[q('#rl-t').value];
          q('#rl-vrow').hidden = !t.opts.length;
          q('#rl-v').innerHTML = t.opts.map((v) => `<option value="${v}" ${(keep ? r.val : t.def) === v ? 'selected' : ''}>${t.unit === '$' ? '$' + v : v + (t.unit === '%' ? '%' : ' ' + t.unit)}</option>`).join('');
          q('#rl-s').innerHTML = t.scope.map((s) => `<option ${keep && s === r.scope ? 'selected' : ''}>${esc(s)}</option>`).join('');
          q('#rl-h').textContent = t.hint || ''; q('#rl-h').hidden = !t.hint;
          prev();
        };
        const prev = () => {
          const t = q('#rl-t').value, v = t === 'crash' ? null : +q('#rl-v').value;
          const ns = $$('.radios input:checked', d).map((i) => notifyNames[i.value]);
          q('.rl-prev').innerHTML = `${ic('bell')}<div class="body"><strong>${esc(ruleText({ type: t, val: v }))}（${esc(q('#rl-s').value)}）时</strong><p>${ns.length ? '通过' + ns.join('、') + '告诉你' : '还没选通知方式'}，同时记在“最近事件”里。</p></div>`;
        };
        q('#rl-t').addEventListener('change', () => fill(false));
        d.addEventListener('change', (e) => { if (e.target.id !== 'rl-t') prev(); });
        fill(true);
      },
      actions: [{ label: '取消' }, { label: src ? '保存' : '创建', kind: 'primary', onClick(d) {
        const q = (s) => $(s, d);
        const notify = $$('.radios input:checked', d).map((i) => i.value);
        if (!notify.length) { toast('至少选一种通知方式', 'attn'); return false; }
        const type = q('#rl-t').value;
        const nr = { type, val: type === 'crash' ? null : +q('#rl-v').value, scope: q('#rl-s').value, notify, on: q('#rl-on').checked };
        if (src) { Object.assign(src, nr); delete src.fired; delete src.cur; } else rules.push({ id: 'r' + Date.now(), ...nr });
        renderRules(); toast(`${src ? '已保存' : '已创建'}规则“${esc(ruleText(nr))}”`);
      } }],
    });
  };
  $('#rules').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-id]'); if (!li) return;
    const r = rules.find((x) => x.id === li.dataset.id);
    if (e.target.closest('[data-rsw]')) { r.on = !r.on; renderRules(); toast(`${r.on ? '已启用' : '已停用'}规则“${esc(ruleText(r))}”`); $(`li[data-id="${r.id}"] [data-rsw]`)?.focus(); return; }
    const m = e.target.closest('[data-rmore]');
    if (m) menu(m, [
      ['编辑…', () => ruleDialog(r)],
      ['发一条测试通知', () => toast(`测试通知：${esc(ruleText(r))}（通过${r.notify.map((n) => notifyNames[n]).join('、')}）`, 'attn')],
      ['删除…', () => modal({ title: '删除这条规则？', body: `<p>“${esc(ruleText(r))}”删除后不再提醒。已经记下的事件保留。</p>`,
        actions: [{ label: '取消' }, { label: '删除', kind: 'danger', onClick() { rules.splice(rules.indexOf(r), 1); renderRules(); toast('已删除规则'); } }] }), 'danger'],
    ]);
  });
  $('[data-new-rule]').addEventListener('click', () => ruleDialog());

  // ---------- 最近事件 ----------
  const typeNames = { alert: '告警', crash: '崩溃恢复', auto: '自动化' };
  const events = [
    { at: minsAgo(18), type: 'auto', lv: 'ok', title: '自动化“新 FBX 自动转 glb”成功', detail: 'SM_Chest_v2.glb，412 个三角面，命名正确' },
    { at: minsAgo(52), type: 'auto', lv: 'err', title: '自动化“新 FBX 自动转 glb”失败', detail: 'SM_Lantern.fbx 超面数。快速判断：严重程度中（71%），按规则通知了你', act: '<a class="btn sm ghost" data-wired="1" href="automations.html">查看运行历史</a>' },
    { at: minsAgo(70), type: 'alert', lv: 'wait', title: '额度超过 80%：WorkBuddy 登录已用 82%', detail: '规则“账号额度超过 80%”，已发系统通知', act: '<button class="btn sm ghost" data-wired="1" data-ev="usage">查看用量</button>' },
    { at: minsAgo(140), type: 'crash', lv: 'ok', title: 'CodeBuddy 进程崩溃，3 秒后自动恢复', detail: '正在运行的“宝箱模型”从断点继续，没有丢失进度', act: '<button class="btn sm ghost" data-wired="1" data-ev="log">查看日志</button>' },
    { at: minsAgo(60 * 9), type: 'auto', lv: 'ok', title: '自动化“构建成功后跑冒烟测试”成功', detail: '3 张截图，主菜单加载 4.2 秒' },
    { at: minsAgo(60 * 9.5), type: 'auto', lv: 'ok', title: '自动化“每晚全量构建”成功', detail: '3 条警告，比上次少 2 条' },
    { at: minsAgo(60 * 22), type: 'alert', lv: 'err', title: 'Codex 登录已过期', detail: '1 个任务和 1 条自动化因此失败', act: '<a class="btn sm ghost" data-wired="1" href="agents.html">去重新登录</a>' },
  ];
  let evFilter = 'all';
  const lvText = { ok: '已恢复或成功', err: '失败', wait: '需要你看一下' };
  const renderEvents = () => {
    $('#ev-chips').innerHTML = [['all', '全部'], ['fail', '只看失败'], ...Object.entries(typeNames)].map(([k, n]) => `<button class="chipsel" data-wired="1" data-evf="${k}" aria-pressed="${k === evFilter}">${n}</button>`).join('');
    const list = events.filter((e) => evFilter === 'all' || (evFilter === 'fail' ? e.lv === 'err' : e.type === evFilter));
    $('#events').innerHTML = list.length ? list.map((e) => `<li><span class="status ${e.lv}" title="${lvText[e.lv]}"><span class="dot"></span></span>
      <div class="eb"><div class="eh"><b>${esc(e.title)}</b></div><span class="sub">${fmt(e.at)} · ${typeNames[e.type]} · ${esc(e.detail)}</span></div>${e.act || ''}</li>`).join('')
      : '<li class="sub">这一类最近没有事件</li>';
  };
  const addEvent = (e) => { events.unshift(e); renderEvents(); };
  $('#ev-card').addEventListener('click', (e) => {
    const f = e.target.closest('[data-evf]'); if (f) { evFilter = f.dataset.evf; renderEvents(); return; }
    const a = e.target.closest('[data-ev]'); if (!a) return;
    if (a.dataset.ev === 'usage') { $('#usage').scrollIntoView({ behavior: 'smooth', block: 'start' }); $('[data-dim="account"]').click(); toast('已切到“按账号”查看用量'); }
    else $('[data-hact="log"]')?.click();
  });
  document.addEventListener('click', (e) => {
    const g = e.target.closest('[data-go-events]'); if (!g) return;
    evFilter = g.dataset.goEvents; renderEvents(); $('#ev-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // ---------- 刷新 ----------
  $('[data-refresh]').addEventListener('click', (e) => {
    const b = e.currentTarget; b.setAttribute('aria-busy', 'true');
    $('.page').classList.add('refetch');
    setTimeout(() => { b.removeAttribute('aria-busy'); $('.page').classList.remove('refetch'); renderTiles(); renderChart(); renderStuck(); stamp(); toast('监控数据已刷新'); }, 700);
  });
  document.addEventListener('aic-sb-change', () => { if ($('#tiles').children.length) { renderTiles(); renderStuck(); } });

  stamp(); renderTiles(); renderChart(); renderHealth(); renderStuck(); renderAcc(); renderRules(); renderEvents();
})();

// ---------- 调用统计（design.md 23.4）：任务、轮次、工具调用、MCP / Skill 四层，外加模型对比、切换与交接、快速判断开销 ----------
// 示例数据用确定性的伪随机生成：同一天、同一组筛选条件，每次打开都一样。项目、分组、任务来自侧栏数据（window.aicSB）。
(function () {
  if (document.body.dataset.page !== 'monitor') return;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const { aicToast: toast, aicSB: SB } = window;
  const esc = window.aicEsc;
  const AG = window.aicAgents || {};
  const KINDS = window.aicJudgeKinds || { risk: '审批风险', agent: 'Agent 推荐', done: '完成度', stuck: '卡住检测', grade: '自动化结果分级' };
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs = {}, parent) => { const e = document.createElementNS(NS, tag); Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v)); parent?.appendChild(e); return e; };
  const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  // ---------- 确定性伪随机 ----------
  const hash = (s) => { let x = 2166136261; for (const c of s) { x ^= c.codePointAt(0); x = Math.imul(x, 16777619); } return x >>> 0; };
  const rng = (seed) => { let a = hash(seed); return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
  const pickW = (r, items, ws) => { let x = r() * ws.reduce((a, b) => a + b, 0); for (let i = 0; i < items.length; i++) { x -= ws[i]; if (x < 0) return items[i]; } return items[items.length - 1]; };

  // ---------- 维度与示例参数 ----------
  const AGK = ['claude', 'codex', 'codebuddy', 'zcode'];
  const agName = (k) => (AG[k] ? AG[k][0] : window.aicAgentName?.[k] || k);
  const modelsOf = (k) => (AG[k] ? AG[k][1] : ['默认模型']);
  const modelW = { claude: [0.55, 0.45], codebuddy: [0.4, 0.25, 0.2, 0.15] };
  const ACCT = { claude: ['个人订阅', '工作室 API Key'], codex: ['ChatGPT 账号'], codebuddy: ['WorkBuddy 登录'], zcode: ['Z.AI 账号'] };
  // 示例价格表：美元 / 百万 token（输入、输出）。缓存命中按输入价的 10%，思考按输出价。正式版用用户可编辑的价格表。
  const PRICE = { 'Opus 5.5': [5, 25], 'Sonnet 5': [3, 15], 'gpt-5.5-codex': [1.25, 10], 'glm-5.1': [0.6, 2.2], 'kimi-k2.5': [0.6, 2.5], 'minimax-m2.7': [0.3, 1.2], 'deepseek-v3-2': [0.28, 0.42] };
  const SUCC = { 'Opus 5.5': 0.9, 'Sonnet 5': 0.86, 'gpt-5.5-codex': 0.8, 'glm-5.1': 0.82, 'kimi-k2.5': 0.78, 'minimax-m2.7': 0.72, 'deepseek-v3-2': 0.75 };
  const NOREPORT = { codebuddy: 'thought', zcode: 'cached' }; // 示例：CodeBuddy 不报告思考 token，ZCode 不报告缓存命中
  const FT = { claude: 1400, codex: 2100, codebuddy: 900, zcode: 1700 };
  const DURF = { claude: 1, codex: 1.25, codebuddy: 0.7, zcode: 1.1 };
  const TOOLT = [['read', '读取'], ['search', '搜索'], ['edit', '修改'], ['create', '新建'], ['exec', '执行']];
  const TOOLW = [0.36, 0.2, 0.24, 0.08, 0.12], TOOLFAIL = [0.01, 0.02, 0.04, 0.03, 0.09], TOOLMS = [120, 380, 260, 200, 4200];
  const TOOLAPPR = [0, 0, 0.35, 0.4, 0.7], TOOLAUTO = [0, 0, 0.6, 0.5, 0.3];
  const OUT = [['ok', '成功'], ['fail', '失败'], ['drop', '丢弃'], ['stop', '中断']];
  const OUTST = { ok: ['ok', '已完成'], fail: ['err', '失败'], drop: ['idle', '已丢弃'], stop: ['err', '已中断'] };
  const HL = [['H0', 'H0 会话内换模型'], ['H1', 'H1 原生恢复'], ['H2', 'H2 全量转写'], ['H3', 'H3 结构化交接'], ['H4', 'H4 最小交接']];
  // MCP 工具名带服务器前缀；Skill 一次读取记为一次调用。按任务内容决定会用到哪些（每个任务的平均次数）。
  const CAP = {
    t7c3: [['blender__get_scene_info', 3], ['blender__execute_blender_code', 4], ['blender__look', 3], ['skill:3dviz-pro-max', 1]],
    t4d9: [['blender__execute_blender_code', 3], ['houdini__cook_node', 3], ['houdini__create_node', 2]],
    t3f7: [['blender__get_scene_info', 2], ['zai-mcp-server__analyze_image', 2]],
    t1c4: [['renderdoc__get_draw_packet', 3], ['renderdoc__get_shader_code', 2], ['skill:ui-ux-pro-max', 1], ['bilibili__extract_bilibili_comments', 0.3], ['video-analyzer__extract_frames', 0.3]],
    t9a1: [['skill:ui-ux-pro-max', 1.2]],
    t8f2: [['skill:fix-precedents-skill', 1], ['web-search-prime__webSearchPrime', 1.5]],
    t5b2: [['web-search-prime__webSearchPrime', 2], ['web-reader__webReader', 2], ['zread__get_repo_structure', 0.5]],
    t2a8: [['web-reader__webReader', 1.5], ['web-search-prime__webSearchPrime', 1]],
    t6e0: [['skill:level-blockout', 0.2]],
  };
  const MCPMETA = { // 失败率、平均耗时（毫秒）
    'blender__get_scene_info': [0.01, 300], 'blender__execute_blender_code': [0.06, 1800], 'blender__look': [0.02, 600],
    'houdini__cook_node': [0.08, 4100], 'houdini__create_node': [0.02, 500], 'renderdoc__get_draw_packet': [0.03, 1200], 'renderdoc__get_shader_code': [0.02, 800],
    'bilibili__extract_bilibili_comments': [0.05, 3400], 'video-analyzer__extract_frames': [0.04, 6200], 'zai-mcp-server__analyze_image': [0.03, 2700],
    'web-search-prime__webSearchPrime': [0.02, 1000], 'web-reader__webReader': [0.05, 2000], 'zread__get_repo_structure': [0.02, 1500],
  };
  const isSkill = (k) => k.startsWith('skill:');
  const capName = (k) => (isSkill(k) ? k.slice(6) : k);
  const capServer = (k) => (isSkill(k) ? 'Skill（统一库）' : k.split('__')[0]);
  // 生成器：每次平均秒数、每次费用（美元，示例值）、是否占用本机显卡；GENUSE 是各任务用到生成的概率
  const GENK = ['ComfyUI（本机，示例）', '图片服务 A（示例）', '视频服务 B（示例）', '音效服务 C（示例）'];
  const GENMETA = { 'ComfyUI（本机，示例）': [38, 0, true], '图片服务 A（示例）': [12, 0.04, false], '视频服务 B（示例）': [90, 0.3, false], '音效服务 C（示例）': [6, 0.02, false] };
  const GENUSE = { t7c3: 0.7, t4d9: 0.5, t1c4: 0.45, t2a8: 0.6, t3f7: 0.2 };
  // 装了 30 天没用过（固定看最近 30 天，不随时间范围变化）
  const UNUSED = [
    ['node_repl', 'MCP', 'Codex', '从未调用'], ['qml_preview', 'MCP', 'Codex', '从未调用，启动也失败（找不到 qmlscene.exe）'],
    ['eni-coldbrew', 'Skill', 'Codex', '从未读取'], ['audio-ducking', 'Skill', 'CodeBuddy、ZCode', '最后一次 41 天前'],
    ['pacing', 'Skill', 'CodeBuddy、ZCode', '最后一次 37 天前'], ['colour-grade', 'Skill', 'CodeBuddy、ZCode', '最后一次 52 天前'],
  ];

  // ---------- 生成近 90 天的任务记录（每天一个种子） ----------
  const DAYS = 90;
  const dayStart = (n) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - n); return d; };
  // 示例：Codex 有一天登录过期，当天的任务都改派给了 Claude Code（取 2–6 天前最近的一个工作日，7 天范围里能看到）
  const DROP = [2, 3, 4, 5, 6].find((n) => { const w = dayStart(n).getDay(); return w !== 0 && w !== 6; });
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const md = (d) => `${d.getMonth() + 1}月${d.getDate()}日`;
  let RECS = null;
  const build = () => {
    const out = [], now = Date.now(), tpl = SB.tasks.slice();
    if (!tpl.length) return out;
    for (let n = DAYS - 1; n >= 0; n--) {
      const d0 = dayStart(n), r = rng('aic-stats|' + ymd(d0));
      const wk = d0.getDay() === 0 || d0.getDay() === 6;
      // 工作日多、周末少；最近 6 天逐步略有上升
      const trend = n < 6 ? 1 + 0.06 * (6 - n) : 1;
      const cnt = Math.round((wk ? 2 + r() * 3 : 8 + r() * 5) * trend), later = [];
      let kept = 0;
      for (let i = 0; i < cnt; i++) {
        const t = tpl[Math.floor(r() * tpl.length)];
        let ag = r() < 0.6 ? t.ag : pickW(r, AGK, [0.35, 0.25, 0.3, 0.1]);
        if (n === DROP && ag === 'codex') ag = 'claude';
        const ms = modelsOf(ag), mw = modelW[ag];
        const model = mw && ms.length === mw.length ? pickW(r, ms, mw) : ms[Math.floor(r() * ms.length)];
        const accts = ACCT[ag] || ['默认账号'], acct = accts.length > 1 ? pickW(r, accts, [0.6, 0.4]) : accts[0];
        const src = r() < (t.proj === '美术管线工具' ? 0.45 : 0.15) ? 'auto' : 'manual';
        const hour = src === 'auto' ? 1 + Math.floor(r() * 5) : 9 + Math.floor(r() * 14);
        const mm = Math.floor(r() * 60);
        const ts = d0.getTime() + hour * 3600e3 + mm * 60e3;
        const p = (SUCC[model] ?? 0.8) - (ag === 'zcode' ? 0.12 : 0), x = r();
        const res = x < p ? 'ok' : x < p + (1 - p) * 0.5 ? 'fail' : x < p + (1 - p) * 0.75 ? 'drop' : 'stop';
        const merged = res === 'ok' && r() < 0.8;
        const dur = (8 + r() * 28) * (DURF[ag] || 1) * (res === 'ok' ? 1 : 0.6);
        const [pi, po] = PRICE[model] || [1, 4];
        const nr = NOREPORT[ag];
        const rec = { ts, tid: t.id, title: t.title, proj: t.proj, ag, model, acct, src, res, merged, dur,
          rn: 2 + Math.floor(r() * 9), ft: 0, rd: 0, tin: 0, tout: 0, tc: nr === 'cached' ? null : 0, tt: nr === 'thought' ? null : 0, cost: 0,
          tl: { read: [0, 0, 0], search: [0, 0, 0], edit: [0, 0, 0], create: [0, 0, 0], exec: [0, 0, 0] }, appr: 0, rej: 0, auto: 0,
          mcp: {}, hl: [], swM: 0, swA: 0, swG: 0, probe: [], guard: 0, jk: {} };
        for (let k = 0; k < rec.rn; k++) {
          rec.ft += FT[ag] * (0.7 + r() * 0.6);
          rec.rd += 20 + r() * 100;
          const tin = 18000 + r() * 42000, tout = 1500 + r() * 4500, tc = tin * (0.4 + r() * 0.3), tt = 500 + r() * 3500;
          const hasC = rec.tc !== null, hasT = rec.tt !== null;
          rec.tin += tin; rec.tout += tout;
          if (hasC) rec.tc += tc;
          if (hasT) rec.tt += tt;
          rec.cost += ((tin - (hasC ? tc : 0)) * pi + (hasC ? tc * pi * 0.1 : 0) + (tout + (hasT ? tt : 0)) * po) / 1e6;
          const nt = 1 + Math.floor(r() * 5);
          for (let j = 0; j < nt; j++) {
            const ti = Math.max(0, TOOLT.indexOf(pickW(r, TOOLT, TOOLW))), a = rec.tl[TOOLT[ti][0]];
            a[0]++; if (r() < TOOLFAIL[ti]) a[1]++; a[2] += TOOLMS[ti] * (0.5 + r());
            if (r() < TOOLAPPR[ti]) { rec.appr++; if (r() < TOOLAUTO[ti]) rec.auto++; else if (r() < 0.12) rec.rej++; }
          }
        }
        (CAP[t.id] || []).forEach(([key, mean]) => {
          const n2 = Math.floor(r() * mean * 2 + 0.3); if (!n2) return;
          const [fp, mms] = MCPMETA[key] || [0.01, 150];
          const a = rec.mcp[key] = [0, 0, 0];
          for (let j = 0; j < n2; j++) { a[0]++; if (r() < fp) a[1]++; a[2] += mms * (0.6 + r() * 0.8); }
        });
        const nho = (r() < 0.25 ? 1 : 0) + (r() < 0.06 ? 1 : 0);
        for (let j = 0; j < nho; j++) {
          const lv = pickW(r, ['H0', 'H1', 'H2', 'H3', 'H4'], [0.3, 0.22, 0.18, 0.24, 0.06]);
          rec.hl.push(lv);
          if (lv === 'H0') rec.swM++; else if (lv === 'H1') rec.swA++;
          else { rec.swG++; rec.probe.push(Math.round(70 + r() * 28 - (lv === 'H4' ? 15 : 0))); if (r() < (lv === 'H4' ? 0.4 : 0.15)) rec.guard++; }
        }
        const jn = { risk: rec.appr, agent: src === 'manual' ? 1 : 0, done: res === 'ok' ? 1 : 0, stuck: Math.floor(dur / 10), grade: src === 'auto' ? 1 : 0 };
        Object.entries(jn).forEach(([k, c]) => { const tk = c * (700 + r() * 900); rec.jk[k] = [c, tk, tk * 1.6 / 1e6]; });
        // 媒体生成（design.md 27.4）：资产类任务偶尔调用生成器。单独的种子，不影响上面的示例数据
        { const rg = rng(`aic-gen|${ts}|${i}`), gw = GENUSE[t.id] || 0;
          if (rg() < gw) { const g = pickW(rg, GENK, [0.5, 0.25, 0.15, 0.1]), m = GENMETA[g], n3 = 1 + Math.floor(rg() * 6);
            rec.gen = { key: g, n: n3, sec: n3 * m[0] * (0.6 + rg() * 0.8), cost: n3 * m[1], gpu: m[2] ? n3 * m[0] * (0.6 + rg() * 0.8) : 0 }; } }
        if (ts <= now) { out.push(rec); kept++; } else if (n === 0) later.push(rec);
      }
      // 今天还没到的时段不出数据；凌晨打开时至少留几条示例，均匀摊在已过去的时间里
      if (n === 0 && kept < 4) later.slice(0, 4 - kept).forEach((rec, j, a) => { rec.ts = d0.getTime() + ((j + 0.5) / a.length) * (now - d0); out.push(rec); });
    }
    return out.sort((a, b) => a.ts - b.ts);
  };
  const recs = () => (RECS ||= build());

  // ---------- 汇总 ----------
  const blank = () => ({ n: 0, out: { ok: 0, fail: 0, drop: 0, stop: 0 }, merged: 0, dur: 0, ho: 0, rn: 0, ft: 0, rd: 0, tin: 0, tout: 0,
    tc: 0, tcR: 0, tt: 0, ttR: 0, cost: 0, tl: { read: [0, 0, 0], search: [0, 0, 0], edit: [0, 0, 0], create: [0, 0, 0], exec: [0, 0, 0] }, tn: 0, tf: 0, tms: 0,
    appr: 0, rej: 0, auto: 0, mcp: {}, mn: 0, hl: { H0: 0, H1: 0, H2: 0, H3: 0, H4: 0 }, swM: 0, swA: 0, swG: 0, pS: 0, pN: 0, guard: 0,
    jk: Object.fromEntries(Object.keys(KINDS).map((k) => [k, [0, 0, 0]])), list: [] });
  const add = (a, r) => {
    a.n++; a.out[r.res]++; if (r.merged) a.merged++; a.dur += r.dur; a.ho += r.hl.length; a.list.push(r);
    a.rn += r.rn; a.ft += r.ft; a.rd += r.rd; a.tin += r.tin; a.tout += r.tout; a.cost += r.cost;
    if (r.tc !== null) { a.tc += r.tc; a.tcR += r.rn; }
    if (r.tt !== null) { a.tt += r.tt; a.ttR += r.rn; }
    Object.entries(r.tl).forEach(([k, v]) => { const t = a.tl[k]; t[0] += v[0]; t[1] += v[1]; t[2] += v[2]; a.tn += v[0]; a.tf += v[1]; a.tms += v[2]; });
    a.appr += r.appr; a.rej += r.rej; a.auto += r.auto;
    Object.entries(r.mcp).forEach(([k, v]) => { const m = a.mcp[k] ||= [0, 0, 0, new Set()]; m[0] += v[0]; m[1] += v[1]; m[2] += v[2]; m[3].add(r.ag); a.mn += v[0]; });
    r.hl.forEach((l) => a.hl[l]++); a.swM += r.swM; a.swA += r.swA; a.swG += r.swG; r.probe.forEach((s) => { a.pS += s; a.pN++; }); a.guard += r.guard;
    Object.entries(r.jk).forEach(([k, v]) => { const j = a.jk[k]; if (j) { j[0] += v[0]; j[1] += v[1]; j[2] += v[2]; } });
    return a;
  };
  const agg = (list) => list.reduce(add, blank());

  // 分组维度：颜色跟着实体在固定顺序里的位置走，不按排名重新上色；超过 8 个的并成灰色
  const ALLMODELS = () => [...new Set(AGK.flatMap(modelsOf))];
  const DIMS = {
    agent: { name: 'Agent', key: (r) => r.ag, label: agName, order: () => AGK },
    model: { name: '模型', key: (r) => r.model, label: (k) => k, order: ALLMODELS },
    account: { name: '账号', key: (r) => r.acct, label: (k) => k, order: () => Object.values(ACCT).flat() },
    project: { name: '项目', key: (r) => r.proj, label: (k) => k, order: () => SB.projects.map((p) => p.name) },
    group: { name: '分组', key: (r) => SB.groupName(SB.assign[r.tid]) || '未分组', label: (k) => k, order: () => [...SB.groups.map((g) => g.name), '未分组'] },
    gen: { name: '生成器', key: (r) => (r.gen ? r.gen.key : '未用生成器'), label: (k) => k, order: () => [...GENK, '未用生成器'] },
    source: { name: '来源', key: (r) => r.src, label: (k) => (k === 'auto' ? '自动化' : '手动'), order: () => ['manual', 'auto'] },
  };
  const colorAt = (i) => (i < 8 ? `var(--series-${i + 1})` : 'var(--line-strong)');
  const groupBy = (list, dimKey) => {
    const D = DIMS[dimKey], order = D.order().slice(), m = new Map();
    list.forEach((r) => { const k = D.key(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); if (!order.includes(k)) order.push(k); });
    return order.map((k, i) => ({ key: k, idx: i, label: D.label(k), color: colorAt(i), a: m.has(k) ? agg(m.get(k)) : null })).filter((g) => g.a);
  };

  // ---------- 格式 ----------
  const num = (v) => Math.round(v).toLocaleString('zh-CN');
  const pc = (a, b) => (b ? `${(Math.round((a / b) * 1000) / 10).toFixed(1)}%` : '—');
  const tok = (v) => (v < 1e4 ? num(v) : v < 1e8 ? `${(v / 1e4).toFixed(1)} 万` : `${(v / 1e8).toFixed(2)} 亿`);
  const usd = (v) => (v < 1 ? `$${v.toFixed(3)}` : v < 1000 ? `$${v.toFixed(2)}` : `$${num(v)}`);
  const mins = (m) => (m < 60 ? `${m.toFixed(1)} 分钟` : `${(m / 60).toFixed(1)} 小时`);
  const secs = (ms) => (ms < 1000 ? `${Math.round(ms)} 毫秒` : `${(ms / 1000).toFixed(1)} 秒`);
  const avg = (s, n, f) => (n ? f(s / n) : '—');
  // 缓存命中、思考 token：全部未报告写“未报告”，部分未报告加注
  const repTok = (v, rep, total) => (rep === 0 ? { nr: true } : rep < total ? { t: tok(v), sub: '部分未报告' } : { t: tok(v) });
  const totalTok = (a) => a.tin + a.tout + a.tc + a.tt;

  // ---------- 筛选状态与时间范围 ----------
  const WK = '日一二三四五六';
  const S = { range: '7', from: null, to: null, dim: 'agent', mode: {}, mcpBy: 'tool', cls: 'all' };
  const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const nextDay = (d) => { const x = new Date(d); x.setDate(x.getDate() + 1); return x; };
  const span = () => {
    let f, t;
    if (S.range === 'today') { f = dayStart(0); return { f, t: nextDay(f), days: 1, label: `今天（${md(f)} 00:00 至现在）` }; }
    if (S.range === 'custom' && S.from && S.to) { f = parseYmd(S.from); t = nextDay(parseYmd(S.to)); }
    else { const n = S.range === 'custom' ? 7 : +S.range; f = dayStart(n - 1); t = nextDay(dayStart(0)); }
    const days = Math.round((t - f) / 864e5);
    return { f, t, days, label: days === 1 ? md(f) : `${md(f)} – ${md(new Date(t - 1))}（${days} 天）` };
  };
  const cur = () => { const sp = span(); return { sp, list: recs().filter((r) => r.ts >= sp.f.getTime() && r.ts < sp.t.getTime()) }; };
  const buckets = (sp) => {
    if (sp.days === 1) return Array.from({ length: 12 }, (_, i) => ({ s: sp.f.getTime() + i * 72e5, e: sp.f.getTime() + (i + 1) * 72e5,
      label: `${String(i * 2).padStart(2, '0')}时`, long: `${md(sp.f)} ${i * 2}:00–${i * 2 + 2}:00` }));
    const step = sp.days > 45 ? 7 : 1, out = [];
    for (let d = new Date(sp.f); d < sp.t; ) {
      const e = new Date(d); e.setDate(e.getDate() + step); const end = e < sp.t ? e : sp.t;
      out.push({ s: d.getTime(), e: end.getTime(), label: `${d.getMonth() + 1}/${d.getDate()}`,
        long: step === 1 ? `${md(d)} 周${WK[d.getDay()]}` : `${md(d)} – ${md(new Date(end - 1))}` });
      d = e;
    }
    return out;
  };
  const scopeText = () => `${span().label} · 分组维度：${DIMS[S.dim].name}`;

  // ---------- 图表基础：dataviz 规范（细柱 ≤24px、数据端 4px 圆角、段间 2px 底色空隙、实线细网格、图例常驻、少量直接标注） ----------
  const nice = (max) => { const raw = Math.max(max, 1) / 4, p = 10 ** Math.floor(Math.log10(raw)); const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s * 4 >= max) || 10 * p; return { step, top: Math.max(step, Math.ceil(max / step - 1e-9) * step) }; };
  const tickFmt = (v) => (v >= 1e4 ? `${+(v / 1e4).toFixed(1)}万` : num(v));
  const tw = (s, fs) => [...s].reduce((w, c) => w + (c.charCodeAt(0) > 255 ? fs : fs * 0.58), 0);
  const fit = (s, max, fs) => { if (tw(s, fs) <= max) return s; let o = ''; for (const c of s) { if (tw(o + c + '…', fs) > max) break; o += c; } return o + '…'; };
  const topRounded = (x, y, w, hh, r) => { r = Math.min(r, hh, w / 2); return `M${x},${y + hh}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hh}Z`; };
  const rightRounded = (x, y, w, hh, r) => { r = Math.min(r, w, hh / 2); return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hh - r}Q${x + w},${y + hh} ${x + w - r},${y + hh}H${x}Z`; };
  const widthOf = (svg) => Math.max(360, Math.round((svg.closest('.card')?.clientWidth || 672) - 32));
  const tipShow = (svg, vx, vy, head, rows) => {
    const wrap = svg.parentNode, tip = $('.tip', wrap);
    tip.textContent = ''; tip.appendChild(h('div', 'th', head));
    rows.forEach(([name, val, color]) => { const r = h('div', 'tr'), k = h('span', 'key'); if (color) k.style.background = color; r.append(k, h('b', null, val), h('span', null, name)); tip.appendChild(r); });
    tip.hidden = false;
    const wb = wrap.getBoundingClientRect();
    tip.style.left = Math.max(0, Math.min(vx - tip.offsetWidth / 2, wb.width - tip.offsetWidth)) + 'px';
    tip.style.top = (vy || 0) + 'px';
  };
  const tipHide = (svg) => { const t = $('.tip', svg.parentNode); if (t) t.hidden = true; $$('.mk', svg).forEach((m) => m.classList.remove('dim')); };
  const bindHit = (hit, svg, i, show, pick) => {
    const on = () => { $$('.mk', svg).forEach((m, k) => m.classList.toggle('dim', k !== i)); show(); };
    hit.addEventListener('pointerenter', on); hit.addEventListener('focus', on);
    hit.addEventListener('pointerleave', () => tipHide(svg)); hit.addEventListener('blur', () => tipHide(svg));
    hit.addEventListener('click', () => pick(hit));
    hit.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(hit); } });
  };

  // 横向条形：每行一个实体，按 defs 分段；pct 时每行归一到 100%
  // rows: [{ label, segs: [数值，与 defs 对齐], end: 行尾文字, aria, pick }]；defs: [{ name, color }]
  const hbars = (svg, rows, defs, o = {}) => {
    svg.textContent = '';
    const W = widthOf(svg), L = o.lw || 132, R = 84, T = 4, RH = 30, BH = 16, B = 22, H = T + rows.length * RH + B;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('width', W); svg.setAttribute('height', H);
    const tot = rows.map((r) => r.segs.reduce((a, b) => a + b, 0));
    const { top, step } = o.pct ? { top: 100, step: 25 } : nice(Math.max(...tot, 1));
    const x = (v) => L + ((W - L - R) * v) / top;
    for (let v = 0; v <= top + 1e-9; v += step) {
      el('line', { x1: x(v), x2: x(v), y1: T, y2: H - B, class: v === 0 ? 'axis' : 'grid' }, svg);
      el('text', { x: x(v), y: H - 6, 'text-anchor': 'middle', class: 'tick' }, svg).textContent = o.pct ? `${v}%` : tickFmt(v);
    }
    rows.forEach((row, i) => {
      const y0 = T + i * RH + (RH - BH) / 2, g = el('g', { class: 'mk' }, svg), t = tot[i], sc = o.pct && t ? 100 / t : 1;
      let acc = 0;
      const live = row.segs.map((v, k) => ({ v: v * sc, k })).filter((s) => s.v > 0);
      live.forEach((s, j) => {
        const xa = x(acc) + (j ? 2 : 0), xb = x(acc + s.v); acc += s.v;
        const w = xb - xa; if (w < 0.5) return;
        if (j === live.length - 1) el('path', { d: rightRounded(xa, y0, w, BH, 4), fill: defs[s.k].color }, g);
        else el('rect', { x: xa, y: y0, width: w, height: BH, fill: defs[s.k].color }, g);
      });
      const lb = el('text', { x: L - 10, y: y0 + BH / 2 + 4, 'text-anchor': 'end', class: 'lbl' }, svg); lb.textContent = fit(row.label, L - 14, 12);
      el('text', { x: x(o.pct ? (t ? 100 : 0) : t) + 6, y: y0 + BH / 2 + 4, class: 'vlabel' }, svg).textContent = row.end;
      const hit = el('rect', { x: 0, y: T + i * RH, width: W, height: RH, class: 'hit', tabindex: 0, role: 'button', 'aria-label': `${row.aria}。按回车查看对应任务` }, svg);
      bindHit(hit, svg, i, () => tipShow(svg, Math.min(x(o.pct ? 100 : t), W - 80), T + (i + 1) * RH + 2, row.label,
        [...row.segs.map((v, k) => [defs[k].name, o.val ? o.val(v, t) : num(v), defs[k].color]).filter((_, k) => row.segs[k] > 0), ...(o.pct ? [] : [['合计', num(t)]])]), row.pick);
    });
  };

  // 堆叠柱：横轴是时间桶；series: [{ label, color, vals }]
  const cols = (svg, bks, series, o = {}) => {
    svg.textContent = '';
    const W = widthOf(svg), H = 230, L = 48, R = 12, T = 20, B = 26, n = bks.length;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('width', W); svg.setAttribute('height', H);
    const totals = bks.map((_, i) => series.reduce((s, x) => s + x.vals[i], 0)), maxT = Math.max(...totals, 0);
    const { top, step } = nice(Math.max(maxT, 1)), y = (v) => T + (H - T - B) * (1 - v / top);
    const band = (W - L - R) / n, bw = Math.min(24, band * 0.6), every = Math.ceil(n / Math.max(1, Math.floor((W - L - R) / 52)));
    for (let v = 0; v <= top + 1e-9; v += step) {
      el('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: v === 0 ? 'axis' : 'grid' }, svg);
      el('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'tick' }, svg).textContent = tickFmt(v);
    }
    let labeledMax = false;
    bks.forEach((b, i) => {
      const cx = L + band * i + band / 2, g = el('g', { class: 'mk' }, svg);
      const live = series.map((s) => s.vals[i]).map((v, k) => ({ v, k })).filter((x) => x.v > 0);
      let acc = 0;
      live.forEach((x, j) => {
        const y0 = y(acc), y1 = y(acc + x.v); acc += x.v;
        const hh = Math.max(0, y0 - y1 - (j ? 2 : 0));
        if (j === live.length - 1) el('path', { d: topRounded(cx - bw / 2, y1, bw, hh, 4), fill: series[x.k].color }, g);
        else el('rect', { x: cx - bw / 2, y: y1, width: bw, height: hh, fill: series[x.k].color }, g);
      });
      if (i % every === 0 || i === n - 1) el('text', { x: cx, y: H - 8, 'text-anchor': 'middle', class: 'tick' }, svg).textContent = b.s === dayStart(0).getTime() && n > 1 ? '今天' : b.label;
      // 只直接标出最后一个时间桶和最大值，其他看坐标、提示框或表格
      const isMax = totals[i] === maxT && maxT > 0 && !labeledMax;
      if (isMax) labeledMax = true;
      if ((i === n - 1 || isMax) && totals[i] > 0) el('text', { x: cx, y: y(totals[i]) - 6, 'text-anchor': 'middle', class: 'vlabel' }, svg).textContent = tickFmt(totals[i]);
      const hit = el('rect', { x: L + band * i, y: T, width: band, height: H - T - B, class: 'hit', tabindex: 0, role: 'button',
        'aria-label': `${b.long}：合计 ${num(totals[i])}${o.unit || ''}；${series.map((s) => `${s.label} ${num(s.vals[i])}`).join('，')}。按回车查看这段时间的任务` }, svg);
      bindHit(hit, svg, i, () => tipShow(svg, cx, 0, b.long, [...[...series].reverse().filter((s) => s.vals[i] > 0).map((s) => [s.label, num(s.vals[i]), s.color]), ['合计', num(totals[i])]]), o.pick ? (hEl) => o.pick(b, hEl) : () => {});
    });
  };

  const legend = (ul, defs) => { ul.textContent = ''; defs.forEach((d) => { const li = h('li'), sw = h('span', 'sw'); sw.style.background = d.color; li.append(sw, document.createTextNode(d.name)); ul.appendChild(li); }); };

  // 表格：cols: [{ h, v(row) → 文字 | { t, sub, nr, low } }]；rows: [{ label, color, pick }]。任意一行可点，行首按钮给键盘用。
  const fill = (cell, v) => {
    if (v == null) { cell.textContent = '—'; return; }
    if (typeof v !== 'object') { cell.textContent = v; return; }
    if (v.nr) { const s = h('span', 'nr', '未报告'); s.title = '这个 Agent 不通过 usage_update 报告这一项，不按 0 计算'; cell.appendChild(s); return; }
    cell.appendChild(document.createTextNode(v.t));
    if (v.sub) cell.appendChild(h('span', 'sub', v.sub));
    if (v.low) cell.appendChild(h('span', 'lowtag', '样本少，仅供参考'));
  };
  const table = (tbl, colsDef, rows) => {
    tbl.textContent = '';
    const hr = tbl.createTHead().insertRow();
    colsDef.forEach((c) => { const th = h('th', null, c.h); th.scope = 'col'; if (c.title) th.title = c.title; hr.appendChild(th); });
    const tb = tbl.createTBody();
    if (!rows.length) { const c = tb.insertRow().insertCell(); c.colSpan = colsDef.length; c.className = 'sub'; c.textContent = '这个范围里没有数据'; return; }
    rows.forEach((row) => {
      const tr = tb.insertRow(); tr.className = 'pick';
      colsDef.forEach((c, i) => {
        if (i === 0) {
          const th = h('th'); th.scope = 'row';
          const b = h('button', 'rowlink'); b.type = 'button'; b.dataset.wired = '1';
          if (row.color) { const sw = h('span'); sw.setAttribute('aria-hidden', 'true'); sw.style.cssText = `display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;background:${row.color}`; b.appendChild(sw); }
          const v = c.v(row); b.appendChild(document.createTextNode(typeof v === 'object' ? v.t : v));
          b.setAttribute('aria-label', `${typeof v === 'object' ? v.t : v}：查看对应任务`);
          th.appendChild(b); tr.appendChild(th);
          if (typeof v === 'object' && v.low) th.appendChild(h('span', 'lowtag', '样本少，仅供参考'));
        } else fill(tr.insertCell(), c.v(row));
      });
      tr.addEventListener('click', (e) => { const b = $('.rowlink', tr); if (e.target.closest('.rowlink') || !e.target.closest('a')) row.pick(b); });
    });
  };

  // ---------- 区块骨架 ----------
  const BLOCKS = [
    ['task', '任务', '一个任务从派发到结束', true],
    ['round', '轮次', '你发一条消息到 Agent 回答结束（一次 session/prompt）', true],
    ['tool', '工具调用', 'Agent 的一次读文件、改文件、执行命令等', true],
    ['mcp', 'MCP / Skill', '经能力中心的一次 MCP 工具调用或一次 Skill 读取', true],
    ['cmp', '模型对比', '同类任务（同项目、同分组）在不同 Agent、模型上的表现', false],
    ['ho', '切换与交接', 'H0 到 H4：交接时保留的上下文从完整到最少', true],
    ['judge', '快速判断的开销', '额度保护依据这里的数', false],
    ['gen', '媒体生成', '图片、音效、视频生成器的调用；费用为示例值', false],
  ];
  const box = $('#st-blocks');
  box.innerHTML = BLOCKS.map(([id, title, note, tog]) => `<section class="sec" id="blk-${id}" aria-labelledby="h-st-${id}">
    <div class="sec-head"><h2 id="h-st-${id}">${title}</h2><span class="note">${note}</span><span class="grow"></span><span class="extra"></span>
      ${tog ? `<div class="seg-mini" role="radiogroup" aria-label="${title}：显示方式" data-vmg="${id}"><button role="radio" data-wired="1" data-vm="chart" aria-checked="true">图表</button><button role="radio" data-wired="1" data-vm="table" aria-checked="false" tabindex="-1">表格</button></div>` : ''}</div>
    <div class="card"><ul class="mini-tiles" hidden></ul>
      <div class="chart-part" ${tog ? '' : 'hidden'}><ul class="legend" aria-label="图例" style="margin-bottom:var(--sp-3)"></ul><div class="cwrap"><svg class="vz" role="group"></svg><div class="tip st" hidden aria-hidden="true"></div></div></div>
      <div class="table-part tscroll" ${tog ? 'hidden' : ''}></div></div>
    <div class="after"></div></section>`).join('');
  const B = (id) => { const s = $('#blk-' + id); return { s, mini: $('.mini-tiles', s), chart: $('.chart-part', s), legend: $('.legend', s), svg: $('svg', s), tablePart: $('.table-part', s), extra: $('.extra', s), after: $('.after', s) }; };
  const tables = (b, n) => { if (b.tablePart.children.length !== n) { b.tablePart.textContent = ''; for (let i = 0; i < n; i++) { const t = h('table', 'dtable'); if (i) t.style.marginTop = 'var(--sp-4)'; b.tablePart.appendChild(t); } } return [...b.tablePart.children]; };
  const showMode = (id, b) => { const m = S.mode[id] || 'chart'; b.chart.hidden = m !== 'chart'; b.tablePart.hidden = m !== 'table'; return m; };
  const miniTiles = (b, items) => { b.mini.hidden = false; b.mini.textContent = ''; items.forEach(([k, v, sub]) => { const li = h('li'); li.append(h('b', null, v), document.createTextNode(k)); if (sub) li.appendChild(h('span', 'sub', sub)); b.mini.appendChild(li); }); };
  const dimName = () => DIMS[S.dim].name;
  const pickOf = (title, list) => (opener) => drill(title, list, opener);

  // ---------- 概览数字 ----------
  const renderTilesSt = (ctx) => {
    const a = ctx.all, nrT = a.list.some((r) => r.tt === null), nrC = a.list.some((r) => r.tc === null);
    const miss = [nrC && '缓存命中', nrT && '思考'].filter(Boolean).join('、');
    const T = [
      ['任务数', num(a.n), `日均 ${(a.n / ctx.sp.days).toFixed(1)} 个`],
      ['成功率', pc(a.out.ok, a.n), `成功 ${a.out.ok} / ${a.n}`],
      ['轮次数', num(a.rn), a.n ? `平均每个任务 ${(a.rn / a.n).toFixed(1)} 轮` : '—'],
      ['工具调用数', num(a.tn), `失败率 ${pc(a.tf, a.tn)}`],
      ['MCP 调用数', num(a.mn), '含 Skill 读取'],
      ['总 token', tok(totalTok(a)), miss ? `部分 Agent 未报告${miss}，未计入` : '输入 + 输出 + 缓存命中 + 思考'],
      ['预估费用', usd(a.cost), '按价格表估算'],
    ];
    const el2 = $('#st-tiles'); el2.textContent = '';
    T.forEach(([k, v, sub]) => { const s = h('section', 'tile'); s.append(h('h3', null, k), h('p', 'val', v), h('p', 'sub', sub)); el2.appendChild(s); });
  };

  // ---------- 任务 ----------
  const renderTask = (ctx) => {
    const b = B('task'), G = ctx.G, defs = OUT.map(([, n], i) => ({ name: n, color: colorAt(i) }));
    if (showMode('task', b) === 'chart') {
      legend(b.legend, defs);
      b.svg.setAttribute('aria-label', `各${dimName()}的任务数和结果构成，横向堆叠条形图。用 Tab 逐行查看，回车查看任务`);
      hbars(b.svg, G.map((g) => ({ label: g.label, segs: OUT.map(([k]) => g.a.out[k]), end: `${g.a.n} 个`,
        aria: `${g.label}：${g.a.n} 个任务，${OUT.map(([k, n]) => `${n} ${g.a.out[k]}`).join('，')}`, pick: pickOf(`${dimName()}：${g.label} · 任务`, g.a.list) })), defs,
        { val: (v, t) => `${v}（${pc(v, t)}）` });
    } else {
      const [t1] = tables(b, 1); t1.setAttribute('aria-label', `各${dimName()}的任务统计`);
      table(t1, [
        { h: dimName(), v: (g) => g.label },
        { h: '任务数', v: (g) => num(g.a.n) },
        ...OUT.map(([k, n]) => ({ h: n, v: (g) => ({ t: num(g.a.out[k]), sub: pc(g.a.out[k], g.a.n) }) })),
        { h: '合并率', title: '合并了改动的任务占成功任务的比例', v: (g) => pc(g.a.merged, g.a.out.ok) },
        { h: '平均耗时', v: (g) => avg(g.a.dur, g.a.n, mins) },
        { h: '平均交接次数', v: (g) => avg(g.a.ho, g.a.n, (x) => x.toFixed(2)) },
      ], G.map((g) => ({ ...g, pick: pickOf(`${dimName()}：${g.label} · 任务`, g.a.list) })));
    }
  };

  // ---------- 轮次 ----------
  const renderRound = (ctx) => {
    const b = B('round'), G = ctx.G;
    if (showMode('round', b) === 'chart') {
      const bks = buckets(ctx.sp);
      legend(b.legend, G.map((g) => ({ name: g.label, color: g.color })));
      b.svg.setAttribute('aria-label', `轮次数趋势，按${dimName()}堆叠的柱状图，每根柱子是${ctx.sp.days === 1 ? '两小时' : ctx.sp.days > 45 ? '一周' : '一天'}。用 Tab 逐个查看，回车查看任务`);
      cols(b.svg, bks, G.map((g) => ({ label: g.label, color: g.color, vals: bks.map((k) => g.a.list.reduce((s, r) => s + (r.ts >= k.s && r.ts < k.e ? r.rn : 0), 0)) })),
        { unit: ' 轮', pick: (k, opener) => drill(`${k.long} · 轮次`, ctx.list.filter((r) => r.ts >= k.s && r.ts < k.e), opener) });
    } else {
      const [t1] = tables(b, 1); t1.setAttribute('aria-label', `各${dimName()}的轮次、token 和费用`);
      table(t1, [
        { h: dimName(), v: (g) => g.label },
        { h: '轮次数', v: (g) => num(g.a.rn) },
        { h: '平均首字延迟', v: (g) => avg(g.a.ft, g.a.rn, secs) },
        { h: '平均单轮耗时', v: (g) => avg(g.a.rd * 1000, g.a.rn, secs) },
        { h: '输入 token', v: (g) => tok(g.a.tin) },
        { h: '输出 token', v: (g) => tok(g.a.tout) },
        { h: '缓存命中 token', v: (g) => repTok(g.a.tc, g.a.tcR, g.a.rn) },
        { h: '思考 token', v: (g) => repTok(g.a.tt, g.a.ttR, g.a.rn) },
        { h: '预估费用', v: (g) => usd(g.a.cost) },
        { h: '平均每轮费用', v: (g) => avg(g.a.cost, g.a.rn, usd) },
      ], G.map((g) => ({ ...g, pick: pickOf(`${dimName()}：${g.label} · 轮次`, g.a.list) })));
    }
  };

  // ---------- 工具调用 ----------
  const renderTool = (ctx) => {
    const b = B('tool'), G = ctx.G, defs = TOOLT.map(([, n], i) => ({ name: n, color: colorAt(i) }));
    if (showMode('tool', b) === 'chart') {
      legend(b.legend, defs);
      b.svg.setAttribute('aria-label', `各${dimName()}的工具调用次数，按类型堆叠的横向条形图。用 Tab 逐行查看，回车查看任务`);
      hbars(b.svg, G.map((g) => ({ label: g.label, segs: TOOLT.map(([k]) => g.a.tl[k][0]), end: `${tickFmt(g.a.tn)} 次`,
        aria: `${g.label}：工具调用 ${g.a.tn} 次，${TOOLT.map(([k, n]) => `${n} ${g.a.tl[k][0]}`).join('，')}，失败率 ${pc(g.a.tf, g.a.tn)}`,
        pick: pickOf(`${dimName()}：${g.label} · 工具调用`, g.a.list) })), defs, { val: (v, t) => `${num(v)}（${pc(v, t)}）` });
    } else {
      const [t1, t2] = tables(b, 2);
      t1.setAttribute('aria-label', `各${dimName()}的工具调用`); t2.setAttribute('aria-label', '按工具类型');
      table(t1, [
        { h: dimName(), v: (g) => g.label },
        { h: '调用次数', v: (g) => num(g.a.tn) },
        ...TOOLT.map(([k, n]) => ({ h: n, v: (g) => num(g.a.tl[k][0]) })),
        { h: '失败率', v: (g) => pc(g.a.tf, g.a.tn) },
        { h: '平均耗时', v: (g) => avg(g.a.tms, g.a.tn, secs) },
        { h: '需要审批', title: '触发审批的调用占全部调用的比例', v: (g) => ({ t: pc(g.a.appr, g.a.tn), sub: `${num(g.a.appr)} 次` }) },
        { h: '其中被你拒绝', title: '占需要审批的比例', v: (g) => ({ t: pc(g.a.rej, g.a.appr), sub: `${num(g.a.rej)} 次` }) },
        { h: '其中被自动允许', title: '低风险自动允许，占需要审批的比例', v: (g) => ({ t: pc(g.a.auto, g.a.appr), sub: `${num(g.a.auto)} 次` }) },
      ], G.map((g) => ({ ...g, pick: pickOf(`${dimName()}：${g.label} · 工具调用`, g.a.list) })));
      const a = ctx.all;
      table(t2, [
        { h: '工具类型', v: (r) => r.label },
        { h: '次数', v: (r) => num(a.tl[r.k][0]) },
        { h: '占比', v: (r) => pc(a.tl[r.k][0], a.tn) },
        { h: '失败率', v: (r) => pc(a.tl[r.k][1], a.tl[r.k][0]) },
        { h: '平均耗时', v: (r) => avg(a.tl[r.k][2], a.tl[r.k][0], secs) },
      ], TOOLT.map(([k, n], i) => ({ k, label: n, color: colorAt(i), pick: pickOf(`工具类型：${n}`, ctx.list.filter((r) => r.tl[k][0] > 0)) })));
    }
  };

  // ---------- MCP / Skill ----------
  const renderMcp = (ctx) => {
    const b = B('mcp'), G = ctx.G, a = ctx.all, bySrv = S.mcpBy === 'server';
    if (!b.extra.firstChild) {
      b.extra.innerHTML = '<div class="seg-mini" role="radiogroup" aria-label="MCP 排行方式" id="mcp-by"><button role="radio" data-wired="1" data-by="tool" aria-checked="true">按工具</button><button role="radio" data-wired="1" data-by="server" aria-checked="false" tabindex="-1">按服务器</button></div>';
      radio($('#mcp-by'), (x) => { S.mcpBy = x.dataset.by; renderMcp(cur2()); });
    }
    const keyOf = (k) => (bySrv ? capServer(k) : k);
    const items = new Map();
    Object.entries(a.mcp).forEach(([k, v]) => { const id = keyOf(k); const it = items.get(id) || { id, keys: [], n: 0, f: 0, ms: 0, ags: new Set() }; it.keys.push(k); it.n += v[0]; it.f += v[1]; it.ms += v[2]; v[3].forEach((x) => it.ags.add(x)); items.set(id, it); });
    const rank = [...items.values()].sort((x, y) => y.n - x.n);
    const nameOf = (it) => (bySrv ? it.id : (isSkill(it.id) ? `Skill · ${capName(it.id)}` : it.id));
    const per = (it, g) => it.keys.reduce((s, k) => s + (g.a.mcp[k]?.[0] || 0), 0);
    const listOf = (it) => ctx.list.filter((r) => it.keys.some((k) => r.mcp[k]));
    if (showMode('mcp', b) === 'chart') {
      const top = rank.slice(0, 10), defs = G.map((g) => ({ name: g.label, color: g.color }));
      legend(b.legend, defs);
      b.svg.setAttribute('aria-label', `${bySrv ? 'MCP 服务器' : 'MCP 工具和 Skill'}调用次数排行前 ${top.length} 名，按${dimName()}堆叠。用 Tab 逐行查看，回车查看任务`);
      hbars(b.svg, top.map((it) => ({ label: nameOf(it), segs: G.map((g) => per(it, g)), end: `${num(it.n)} 次`,
        aria: `${nameOf(it)}：${it.n} 次，失败率 ${pc(it.f, it.n)}，${G.filter((g) => per(it, g)).map((g) => `${g.label} ${per(it, g)}`).join('，')}`,
        pick: pickOf(`${nameOf(it)} · 调用它的任务`, listOf(it)) })), defs, { lw: bySrv ? 140 : 256, val: (v, t) => `${num(v)}（${pc(v, t)}）` });
    } else {
      const [t1] = tables(b, 1); t1.setAttribute('aria-label', bySrv ? 'MCP 服务器排行' : 'MCP 工具和 Skill 排行');
      table(t1, [
        { h: bySrv ? '服务器' : '工具', v: (it) => nameOf(it) },
        { h: '类型', v: (it) => (it.keys.every(isSkill) ? 'Skill' : 'MCP') },
        ...(bySrv ? [] : [{ h: '服务器', v: (it) => capServer(it.id) }]),
        { h: '调用次数', v: (it) => num(it.n) },
        { h: '失败率', v: (it) => pc(it.f, it.n) },
        { h: '平均耗时', v: (it) => avg(it.ms, it.n, secs) },
        { h: '在用的 Agent', v: (it) => AGK.filter((k) => it.ags.has(k)).map(agName).join('、') },
        { h: `主要来自（${dimName()}）`, v: (it) => { const best = G.map((g) => [g.label, per(it, g)]).sort((x, y) => y[1] - x[1])[0]; return best && best[1] ? { t: best[0], sub: pc(best[1], it.n) } : '—'; } },
      ], rank.map((it) => ({ ...it, pick: pickOf(`${nameOf(it)} · 调用它的任务`, listOf(it)) })));
    }
    if (!b.after.firstChild) {
      b.after.innerHTML = `<div class="card" style="margin-top:var(--sp-3)"><div class="sec-head" style="margin-bottom:var(--sp-2)"><h3 style="margin:0;font-size:var(--fs-14)" id="h-unused">装了 30 天没用过</h3><span class="note">固定看最近 30 天，不随上面的时间范围变化，方便清理</span></div>
        <ul class="unused" aria-labelledby="h-unused">${UNUSED.map(([n, ty, where, last]) => `<li><span class="status idle"><span class="dot"></span>${ty}</span><code>${esc(n)}</code><span class="sub" style="display:inline">${esc(where)} · ${esc(last)}</span><span class="grow"></span><a class="btn sm ghost" data-wired="1" href="capabilities.html" aria-label="去能力页处理 ${esc(n)}">去能力页</a></li>`).join('')}</ul></div>`;
    }
  };

  // ---------- 模型对比：只展示数据，不做推荐 ----------
  const clsOf = (r) => `${r.proj} · ${SB.groupName(SB.assign[r.tid]) || '未分组'}`;
  const renderCmp = (ctx) => {
    const b = B('cmp');
    const classes = [...new Set(ctx.list.map(clsOf))].sort((x, y) => x.localeCompare(y, 'zh-CN'));
    if (S.cls !== 'all' && !classes.includes(S.cls)) S.cls = 'all';
    b.extra.textContent = '';
    const lab = h('label', null, '同类任务'); lab.htmlFor = 'cmp-cls'; lab.style.cssText = 'font-size:var(--fs-12);color:var(--fg-2);margin-right:6px';
    const sel = h('select', 'select'); sel.id = 'cmp-cls'; sel.style.cssText = 'width:auto;height:28px;padding:2px 8px;font-size:var(--fs-12)';
    [['all', '全部'], ...classes.map((c) => [c, c])].forEach(([v, t]) => { const o = h('option', null, t); o.value = v; o.selected = v === S.cls; sel.appendChild(o); });
    sel.addEventListener('change', () => { S.cls = sel.value; renderCmp(cur2()); $('#cmp-cls').focus(); });
    b.extra.append(lab, sel);
    if (!b.tablePart.querySelector('.st-note')) b.tablePart.textContent = '';
    if (!b.tablePart.firstChild) { b.tablePart.appendChild(h('p', 'st-note', '只展示数据，不做推荐。同类任务指同一项目、同一分组里的任务；样本少于 10 个的行标注“样本少，仅供参考”。')); b.tablePart.appendChild(h('table', 'dtable')); }
    const t1 = $('table', b.tablePart); t1.setAttribute('aria-label', '同类任务在不同 Agent、模型上的成功率、耗时和花费');
    const rows = [];
    classes.filter((c) => S.cls === 'all' || c === S.cls).forEach((c) => {
      const inC = ctx.list.filter((r) => clsOf(r) === c);
      AGK.forEach((ag) => modelsOf(ag).forEach((m) => {
        const l = inC.filter((r) => r.ag === ag && r.model === m); if (!l.length) return;
        const a = agg(l); rows.push({ cls: c, label: c, who: `${agName(ag)} · ${m}`, a, pick: pickOf(`${c} · ${agName(ag)} · ${m}`, l) });
      }));
    });
    table(t1, [
      { h: '同类任务', v: (r) => r.cls },
      { h: 'Agent · 模型', v: (r) => r.who },
      { h: '样本数', v: (r) => ({ t: num(r.a.n), low: r.a.n < 10 }) },
      { h: '成功率', v: (r) => pc(r.a.out.ok, r.a.n) },
      { h: '平均耗时', v: (r) => avg(r.a.dur, r.a.n, mins) },
      { h: '平均每个任务的费用', v: (r) => avg(r.a.cost, r.a.n, usd) },
      { h: '平均每个成功任务的花费', title: '全部花费 ÷ 成功任务数，失败和丢弃的花费也算在内', v: (r) => (r.a.out.ok ? usd(r.a.cost / r.a.out.ok) : '没有成功的任务') },
    ], rows);
  };

  // ---------- 切换与交接 ----------
  const renderHo = (ctx) => {
    const b = B('ho'), a = ctx.all, G = ctx.G, defs = HL.map(([, n], i) => ({ name: n, color: colorAt(i) }));
    miniTiles(b, [
      ['换模型', `${num(a.swM)} 次`], ['换账号', `${num(a.swA)} 次`], ['换 Agent', `${num(a.swG)} 次`],
      ['探针问答平均得分', a.pN ? `${(a.pS / a.pN).toFixed(1)} 分` : '—', a.pN ? `满分 100，${a.pN} 次跨 Agent 交接` : '没有跨 Agent 交接'],
      ['交接后行为守卫告警', `${num(a.guard)} 次`],
    ]);
    if (showMode('ho', b) === 'chart') {
      legend(b.legend, defs);
      b.svg.setAttribute('aria-label', `交接级别占比，每行归一到 100% 的横向条形图，第一行是全部，下面按${dimName()}。用 Tab 逐行查看，回车查看任务`);
      const rows = [{ label: '全部', a, list: ctx.list.filter((r) => r.hl.length) }, ...G.map((g) => ({ label: g.label, a: g.a, list: g.a.list.filter((r) => r.hl.length) }))];
      hbars(b.svg, rows.map((r) => ({ label: r.label, segs: HL.map(([k]) => r.a.hl[k]), end: `${num(r.a.ho)} 次交接`,
        aria: `${r.label}：${r.a.ho} 次交接，${HL.map(([k]) => `${k} ${pc(r.a.hl[k], r.a.ho)}`).join('，')}`, pick: pickOf(`${r.label} · 发生过交接的任务`, r.list) })), defs,
        { pct: true, val: (v, t) => `${v} 次（${pc(v, t)}）` });
    } else {
      const [t1] = tables(b, 1); t1.setAttribute('aria-label', `各${dimName()}的切换与交接`);
      table(t1, [
        { h: dimName(), v: (g) => g.label },
        { h: '交接次数', v: (g) => num(g.a.ho) },
        ...HL.map(([k, n]) => ({ h: k, title: n, v: (g) => pc(g.a.hl[k], g.a.ho) })),
        { h: '换模型', v: (g) => num(g.a.swM) }, { h: '换账号', v: (g) => num(g.a.swA) }, { h: '换 Agent', v: (g) => num(g.a.swG) },
        { h: '探针平均分', v: (g) => (g.a.pN ? (g.a.pS / g.a.pN).toFixed(1) : '—') },
        { h: '守卫告警', v: (g) => num(g.a.guard) },
      ], G.map((g) => ({ ...g, pick: pickOf(`${dimName()}：${g.label} · 发生过交接的任务`, g.a.list.filter((r) => r.hl.length)) })));
    }
  };

  // ---------- 快速判断的开销 ----------
  const renderJudge = (ctx) => {
    const b = B('judge'), a = ctx.all, ks = Object.keys(KINDS);
    const n = ks.reduce((s, k) => s + a.jk[k][0], 0), t = ks.reduce((s, k) => s + a.jk[k][1], 0), c = ks.reduce((s, k) => s + a.jk[k][2], 0);
    miniTiles(b, [['判断调用次数', num(n)], ['消耗 token', tok(t), `占全部 token 的 ${pc(t, totalTok(a) + t)}`], ['预估费用', usd(c)]]);
    if (!b.tablePart.firstChild) b.tablePart.appendChild(h('table', 'dtable'));
    const t1 = $('table', b.tablePart); t1.setAttribute('aria-label', '各类快速判断的调用次数和开销');
    table(t1, [
      { h: '判断类型', v: (r) => r.label },
      { h: '调用次数', v: (r) => num(a.jk[r.k][0]) },
      { h: 'token', v: (r) => tok(a.jk[r.k][1]) },
      { h: '预估费用', v: (r) => usd(a.jk[r.k][2]) },
      { h: '平均每次 token', v: (r) => avg(a.jk[r.k][1], a.jk[r.k][0], num) },
    ], ks.map((k) => ({ k, label: KINDS[k], pick: pickOf(`快速判断：${KINDS[k]}`, ctx.list.filter((r) => r.jk[k]?.[0] > 0)) })));
  };

  // ---------- 媒体生成：次数、时长、费用、显卡占用时长 ----------
  const renderGen = (ctx) => {
    const b = B('gen'), L = ctx.list.filter((r) => r.gen), sum = (f, l = L) => l.reduce((s, r) => s + f(r.gen), 0);
    miniTiles(b, [['生成次数', num(sum((g) => g.n))], ['生成时长', mins(sum((g) => g.sec) / 60)], ['费用（示例）', usd(sum((g) => g.cost)), '本机生成不计费'], ['显卡占用', mins(sum((g) => g.gpu) / 60), '本机 ComfyUI，独占排队']]);
    if (!b.tablePart.firstChild) b.tablePart.appendChild(h('table', 'dtable'));
    const t1 = $('table', b.tablePart); t1.setAttribute('aria-label', '各生成器的次数、时长、费用和显卡占用');
    table(t1, [
      { h: '生成器', v: (r) => r.label },
      { h: '次数', v: (r) => num(sum((g) => g.n, r.l)) },
      { h: '时长', v: (r) => mins(sum((g) => g.sec, r.l) / 60) },
      { h: '费用（示例）', v: (r) => usd(sum((g) => g.cost, r.l)) },
      { h: '显卡占用', v: (r) => (GENMETA[r.label][2] ? mins(sum((g) => g.gpu, r.l) / 60) : '不占用') },
    ], GENK.map((k) => ({ label: k, l: L.filter((r) => r.gen.key === k) })).filter((r) => r.l.length).map((r) => ({ ...r, pick: pickOf(`生成器：${r.label}`, r.l) })));
    b.after.innerHTML = '<p class="note" style="margin:var(--sp-2) 0 0">具体用哪些生成服务等调研结论，名称都是示例。当前队列：ComfyUI（本机）1 个运行中、1 个排队（显卡独占）。<a href="generate.html" data-wired="1">打开生成页</a></p>';
  };

  // ---------- 每日调用量：平滑曲线（单调三次插值），按分组维度每个实体一条，另加“合计” ----------
  // 颜色用同一套 8 色图表色板、跟着实体走；每个色位另配固定的标记形状，“其他”是灰色空心方块，“合计”是粗虚线 + 空心圆，不只靠颜色区分。
  const METRICS = [['task', '任务数', '个'], ['round', '轮次数', '轮'], ['tool', '工具调用数', '次'], ['mcp', 'MCP 调用数', '次'], ['token', 'token', '']];
  const mval = {
    task: () => 1, round: (r) => r.rn,
    tool: (r) => Object.values(r.tl).reduce((s, v) => s + v[0], 0),
    mcp: (r) => Object.values(r.mcp).reduce((s, v) => s + v[0], 0),
    token: (r) => r.tin + r.tout + (r.tc || 0) + (r.tt || 0),
  };
  const SHAPES = ['circle', 'square', 'tri', 'diamond', 'triD', 'hex', 'triR', 'triL'];
  const POLY = {
    tri: [[0, -5], [5, 4], [-5, 4]], triD: [[0, 5], [5, -4], [-5, -4]], diamond: [[0, -5.5], [5.5, 0], [0, 5.5], [-5.5, 0]],
    hex: Array.from({ length: 6 }, (_, k) => [5 * Math.cos(Math.PI / 6 + (k * Math.PI) / 3), 5 * Math.sin(Math.PI / 6 + (k * Math.PI) / 3)]),
    triR: [[5, 0], [-4, 5], [-4, -5]], triL: [[-5, 0], [4, 5], [4, -5]],
  };
  // 标记：实心形状带 2px 底色描边；hollow（其他、合计）是底色填充 + 系列色描边
  const marker = (g, shape, cx, cy, color, hollow) => {
    let e;
    if (shape === 'circle') e = el('circle', { cx, cy, r: 4.5 }, g);
    else if (shape === 'square') e = el('rect', { x: cx - 4, y: cy - 4, width: 8, height: 8, rx: 1 }, g);
    else e = el('path', { d: 'M' + POLY[shape].map(([a, b]) => `${(cx + a).toFixed(1)},${(cy + b).toFixed(1)}`).join('L') + 'Z' }, g);
    e.setAttribute('class', hollow ? 'mkr hollow' : 'mkr');
    if (hollow) e.style.stroke = color; else e.setAttribute('fill', color);
    return e;
  };
  // Fritsch–Carlson 单调三次插值：曲线不越过相邻数据点，数据非负时曲线也不会低于 0
  const smoothPath = (P) => {
    const n = P.length;
    if (!n) return '';
    if (n === 1) return `M${P[0][0]},${P[0][1]}`;
    const d = [], m = new Array(n);
    for (let i = 0; i < n - 1; i++) d[i] = (P[i + 1][1] - P[i][1]) / (P[i + 1][0] - P[i][0]);
    m[0] = d[0]; m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
      const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
      if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
    }
    let p = `M${P[0][0].toFixed(1)},${P[0][1].toFixed(1)}`;
    for (let i = 0; i < n - 1; i++) {
      const [x0, y0] = P[i], [x1, y1] = P[i + 1], hx = (x1 - x0) / 3;
      p += `C${(x0 + hx).toFixed(1)},${(y0 + m[i] * hx).toFixed(1)} ${(x1 - hx).toFixed(1)},${(y1 - m[i + 1] * hx).toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
    }
    return p;
  };
  // 时间桶：一天时按小时（还没到的小时不出点），否则按天
  const dailyBuckets = (sp) => {
    const now = Date.now(), today0 = dayStart(0).getTime();
    if (sp.days === 1) return Array.from({ length: 24 }, (_, i) => { const s = sp.f.getTime() + i * 3600e3;
      return { s, e: s + 3600e3, label: `${i}时`, long: `${md(sp.f)} ${i}:00–${i + 1}:00${s <= now && now < s + 3600e3 ? '（截至现在）' : ''}`, live: s <= now }; });
    const out = [];
    for (let d = new Date(sp.f); d < sp.t; d = nextDay(d)) {
      const s = d.getTime(), isT = s === today0;
      out.push({ s, e: nextDay(d).getTime(), label: isT ? '今天' : `${d.getMonth() + 1}/${d.getDate()}`, long: `${md(d)} 周${WK[d.getDay()]}${isT ? '（截至现在）' : ''}`, live: true, drop: s === dayStart(DROP).getTime() });
    }
    return out;
  };
  const isCodex = (k) => (S.dim === 'agent' ? k === 'codex' : S.dim === 'model' ? modelsOf('codex').includes(k) : S.dim === 'account' ? (ACCT.codex || []).includes(k) : false);
  Object.assign(S, { metric: 'task', dvm: 'chart', off: new Set(), di: null });
  const offKey = (id) => `${S.dim}|${id}`;

  const renderDaily = (ctx) => {
    const sec = $('#blk-daily'), svg = $('#daily-svg'), tbl = $('#daily-table'), ul = $('#daily-legend');
    const [mk, mName, mUnit] = METRICS.find((m) => m[0] === S.metric), f = mval[mk], fv = mk === 'token' ? tok : num;
    const bks = dailyBuckets(ctx.sp), n = bks.length, hourly = ctx.sp.days === 1;
    if (S.dn !== `${n}|${ctx.sp.f.getTime()}`) { S.dn = `${n}|${ctx.sp.f.getTime()}`; S.di = null; }
    const valsOf = (list) => { const v = bks.map((b) => (b.live ? 0 : null)); let k = 0;
      list.forEach((r) => { while (k < n && r.ts >= bks[k].e) k++; if (k < n && r.ts >= bks[k].s && v[k] !== null) v[k] += f(r); }); return v; };
    // 线超过 6 条时：按当前指标取前 5 名，其余并成“其他”；显示顺序仍按实体的固定顺序
    let G = ctx.G.map((g) => ({ g, vals: valsOf(g.a.list) }));
    G.forEach((x) => { x.sum = x.vals.reduce((s, v) => s + (v || 0), 0); });
    let rest = [];
    if (G.length > 6) { const keep = new Set([...G].sort((a, b) => b.sum - a.sum).slice(0, 5)); rest = G.filter((x) => !keep.has(x)); G = G.filter((x) => keep.has(x)); }
    const lines = G.map(({ g, vals }) => ({ id: 'e:' + g.key, label: g.label, color: g.color, shape: g.idx < 8 ? SHAPES[g.idx] : 'square', hollow: g.idx >= 8, vals, codex: !hourly && isCodex(g.key) }));
    if (rest.length) lines.push({ id: 'other', label: `其他（${rest.length} 个）`, color: 'var(--fg-3)', shape: 'square', hollow: true,
      vals: bks.map((b, i) => (b.live ? rest.reduce((s, x) => s + x.vals[i], 0) : null)), names: rest.map((x) => x.g.label) });
    const total = { id: 'total', label: '合计', color: 'var(--fg-1)', shape: 'circle', hollow: true, total: true, vals: valsOf(ctx.list) };
    const all = [total, ...lines];
    const isOn = (s) => !S.off.has(offKey(s.id));
    const dropAt = bks.findIndex((b) => b.drop);
    const annOf = (s, i) => (s.codex && i === dropAt && s.vals[i] === 0 ? '登录过期' : '');
    $('#daily-note').textContent = `${mName}，${hourly ? '按小时' : '按天'}${mUnit ? `，单位：${mUnit}` : ''}`;
    const mode = S.dvm;
    $('.chart-part', sec).hidden = mode !== 'chart'; $('.table-part', sec).hidden = mode !== 'table';
    const bkPick = (b, opener) => drill(`${b.long} · ${mName}`, ctx.list.filter((r) => r.ts >= b.s && r.ts < b.e), opener);

    if (mode === 'table') {
      tbl.setAttribute('aria-label', `每日调用量（${mName}），行是${hourly ? '小时' : '日期'}，列是各条线`);
      table(tbl, [
        { h: hourly ? '时段' : '日期', v: (r) => r.b.long },
        ...all.map((s, k) => ({ h: s.label, title: s.names ? s.names.join('、') : undefined, v: (r) => (s.vals[r.i] == null ? '—' : annOf(s, r.i) ? { t: fv(s.vals[r.i]), sub: annOf(s, r.i) } : fv(s.vals[r.i])) })),
      ], bks.map((b, i) => ({ b, i, pick: (opener) => bkPick(b, opener) })));
      return;
    }

    // 图例：按钮，点击或回车 / 空格隐藏、显示对应的线
    ul.textContent = '';
    [...lines, total].forEach((s) => {
      const li = h('li'), b = h('button', 'lgb'); b.type = 'button'; b.dataset.wired = '1';
      b.setAttribute('aria-pressed', String(isOn(s))); b.title = (isOn(s) ? '点击隐藏这条线' : '点击显示这条线') + (s.names ? `：${s.names.join('、')}` : '');
      const k = el('svg', { width: 24, height: 12, viewBox: '0 0 24 12', 'aria-hidden': 'true', class: 'lgk' });
      el('line', { x1: 1, x2: 23, y1: 6, y2: 6, class: s.total ? 'ln total' : 'ln', stroke: s.color }, k);
      marker(k, s.shape, 12, 6, s.color, s.hollow);
      b.append(k, document.createTextNode(s.label));
      b.addEventListener('click', () => { const ok = offKey(s.id); S.off.has(ok) ? S.off.delete(ok) : S.off.add(ok); renderDaily(ctx); $$('#daily-legend .lgb').find((x) => x.textContent === s.label)?.focus(); });
      li.appendChild(b); ul.appendChild(li);
    });

    svg.textContent = '';
    const W = widthOf(svg), H = 268, L = 52, R = 24, T = 28, B = 28, pw = W - L - R;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('width', W); svg.setAttribute('height', H);
    const vis = all.filter(isOn), live = bks.map((b, i) => (b.live ? i : -1)).filter((i) => i >= 0), lastLive = live[live.length - 1] ?? 0;
    const maxV = Math.max(1, ...vis.flatMap((s) => s.vals.filter((v) => v != null)));
    const { top, step } = nice(maxV), y = (v) => T + (H - T - B) * (1 - v / top), x = (i) => L + (n === 1 ? pw / 2 : (pw * i) / (n - 1));
    svg.setAttribute('aria-label', `每日调用量：${mName}，${hourly ? '按小时' : '按天'}的平滑曲线图，${lines.length} 条线加合计${vis.length < all.length ? `（已隐藏 ${all.length - vis.length} 条）` : ''}。聚焦读数后按左右键逐${hourly ? '小时' : '日'}查看，回车查看对应任务；完整数据在表格视图里`);
    for (let v = 0; v <= top + 1e-9; v += step) {
      el('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: v === 0 ? 'axis' : 'grid' }, svg);
      el('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'tick' }, svg).textContent = tickFmt(v);
    }
    // 横轴刻度：按可用宽度稀疏；按天时从最后一天往前数，保证“今天”总有刻度
    const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(pw / (hourly ? 44 : 60)))));
    bks.forEach((b, i) => { if (hourly ? i % every === 0 : (n - 1 - i) % every === 0) el('text', { x: x(i), y: H - 8, 'text-anchor': 'middle', class: 'tick' }, svg).textContent = b.label; });
    const plot = el('g', {}, svg);
    if (!vis.length) el('text', { x: L + pw / 2, y: T + (H - T - B) / 2, 'text-anchor': 'middle', class: 'lbl' }, svg).textContent = '所有线都已隐藏，点图例重新显示';
    // 先画各实体，最后画合计，合计在最上层
    [...vis.filter((s) => !s.total), ...vis.filter((s) => s.total)].forEach((s) => {
      const P = live.map((i) => [x(i), y(s.vals[i])]);
      el('path', { d: smoothPath(P), class: s.total ? 'ln total' : 'ln', stroke: s.color }, plot);
      if (P.length) marker(plot, s.shape, P[P.length - 1][0], P[P.length - 1][1], s.color, s.hollow);
      // 少量直接标注：合计的最大值（上方留白最多，不和收拢的线尾挤在一起）；Codex 掉为 0 的那一天
      if (s.total && P.length) { const mi = live.reduce((a, i) => (s.vals[i] > s.vals[a] ? i : a), live[0]);
        el('text', { x: Math.max(L + 40, Math.min(x(mi), W - R - 40)), y: y(s.vals[mi]) - 10, 'text-anchor': 'middle', class: 'vlabel' }, svg).textContent = `合计最高 ${fv(s.vals[mi])}`; }
      if (s.codex && dropAt >= 0 && s.vals[dropAt] === 0) {
        const ax = x(dropAt), ay = y(0);
        el('line', { x1: ax, x2: ax, y1: ay - 8, y2: ay - 46, class: 'leader' }, svg);
        marker(plot, s.shape, ax, ay, s.color, s.hollow);
        el('text', { x: Math.max(L + 30, Math.min(ax, W - R - 30)), y: ay - 52, 'text-anchor': 'middle', class: 'ann' }, svg).textContent = `${s.label} 登录过期`;
      }
    });
    // 悬停层：竖向参考线 + 当天每条线的标记
    const xh = el('g', { class: 'xh', visibility: 'hidden' }, svg);
    const hit = el('rect', { x: L - 10, y: T, width: pw + 20, height: H - T - B, class: 'hit', tabindex: 0, role: 'slider',
      'aria-label': `每日调用量读数（${mName}）。左右键逐${hourly ? '小时' : '日'}移动，Home / End 到首尾，回车查看对应任务`, 'aria-valuemin': 1, 'aria-valuemax': live.length }, svg);
    const tip = $('#daily-tip'), wrap = svg.parentNode;
    const showAt = (i) => {
      i = Math.max(live[0] ?? 0, Math.min(lastLive, i)); S.di = i;
      const b = bks[i], cx = x(i);
      xh.textContent = ''; xh.setAttribute('visibility', 'visible');
      el('line', { x1: cx, x2: cx, y1: T, y2: H - B, class: 'xhl' }, xh);
      vis.forEach((s) => marker(xh, s.shape, cx, y(s.vals[i]), s.color, s.hollow));
      const rows = vis.map((s) => [s, fv(s.vals[i]), annOf(s, i)]);
      tip.textContent = ''; tip.appendChild(h('div', 'th', b.long));
      rows.forEach(([s, v, ann]) => { const r = h('div', 'tr'), k = h('span', s.total ? 'key dash' : 'key'); k.style.setProperty('--c', s.color); if (!s.total) k.style.background = s.color;
        r.append(k, h('b', null, v), h('span', null, s.label + (ann ? ` · ${ann}` : ''))); tip.appendChild(r); });
      if (!rows.length) tip.appendChild(h('div', 'tr', '所有线都已隐藏'));
      tip.hidden = false;
      const sx = svg.getBoundingClientRect().width / W, px = cx * sx, ww = wrap.getBoundingClientRect().width, tw2 = tip.offsetWidth;
      tip.style.left = (px + 14 + tw2 <= ww ? px + 14 : Math.max(0, px - 14 - tw2)) + 'px';
      tip.style.top = T * sx + 'px';
      hit.setAttribute('aria-valuenow', live.indexOf(i) + 1);
      hit.setAttribute('aria-valuetext', `${b.long}：${rows.map(([s, v, ann]) => `${s.label} ${v}${ann ? `（${ann}）` : ''}`).join('，') || '所有线都已隐藏'}`);
    };
    const hide = () => { xh.setAttribute('visibility', 'hidden'); tip.hidden = true; };
    const idxAt = (e) => { const bx = svg.getBoundingClientRect(); const vx = ((e.clientX - bx.left) * W) / bx.width; return n === 1 ? 0 : Math.round(((vx - L) / pw) * (n - 1)); };
    hit.addEventListener('pointermove', (e) => showAt(idxAt(e)));
    hit.addEventListener('pointerleave', () => { if (document.activeElement !== hit) hide(); else showAt(S.di); });
    hit.addEventListener('focus', () => showAt(S.di ?? lastLive));
    hit.addEventListener('blur', hide);
    hit.addEventListener('click', (e) => bkPick(bks[Math.max(0, Math.min(lastLive, idxAt(e)))], hit));
    hit.addEventListener('keydown', (e) => {
      const k = live.indexOf(S.di ?? lastLive), mv = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 };
      if (e.key in mv) showAt(live[Math.max(0, Math.min(live.length - 1, k + mv[e.key]))]);
      else if (e.key === 'Home') showAt(live[0]); else if (e.key === 'End') showAt(lastLive);
      else if (e.key === 'Enter' || e.key === ' ') bkPick(bks[S.di ?? lastLive], hit);
      else return;
      e.preventDefault();
    });
    if (S.di != null && S.di > lastLive) S.di = null;
  };

  // ---------- 下钻：右侧面板列出对应的示例任务 ----------
  const drillEl = $('#st-drill');
  let opener = null;
  const drill = (title, list, from) => {
    opener = from || document.activeElement;
    $('#drill-h').textContent = title;
    const by = new Map();
    list.forEach((r) => { const g = by.get(r.tid) || { n: 0, ok: 0, last: r, ags: new Set(), cost: 0 }; g.n++; if (r.res === 'ok') g.ok++; g.cost += r.cost; if (r.ts > g.last.ts) g.last = r; g.ags.add(agName(r.ag)); by.set(r.tid, g); });
    const items = [...by.values()].sort((x, y) => y.n - x.n);
    $('#drill-sub').textContent = `${span().label} · ${list.length} 次任务运行，涉及 ${items.length} 个任务`;
    const ul = $('#drill-list'); ul.textContent = '';
    if (!items.length) ul.appendChild(h('li', 'sub', '这个范围里没有对应的任务'));
    items.forEach((g) => {
      const r = g.last, [st, stt] = OUTST[r.res], li = h('li'), row = h('div', 'row');
      const a = h('a', null, r.title); a.dataset.wired = '1';
      a.href = 'workbench.html?' + new URLSearchParams({ title: r.title, st, stt });
      const s = h('span', `status ${st}`); s.append(h('span', 'dot'), document.createTextNode(`最近一次${stt}`));
      row.append(a, s);
      const d = new Date(r.ts);
      li.append(row, h('span', 'sub', `${r.proj} · ${SB.groupName(SB.assign[r.tid]) || '未分组'} · ${[...g.ags].join('、')}`),
        h('span', 'sub', `${g.n} 次，成功 ${g.ok} 次 · 预估 ${usd(g.cost)} · 最近 ${md(d)} ${d.toTimeString().slice(0, 5)}（${agName(r.ag)} · ${r.model}）`));
      ul.appendChild(li);
    });
    drillEl.hidden = false; $('#drill-h').focus();
  };
  const closeDrill = () => { if (drillEl.hidden) return; drillEl.hidden = true; if (opener && document.contains(opener)) opener.focus(); };
  $('#drill-x').addEventListener('click', closeDrill);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !drillEl.hidden && !document.querySelector('dialog[open]')) closeDrill(); });

  // ---------- 导出 CSV：当前时间范围下的明细 ----------
  const csvCell = (v) => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s)) s = "'" + s; return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  $('#st-export').addEventListener('click', () => {
    const { sp, list } = cur();
    const head = ['开始时间', '任务', '项目', '分组', 'Agent', '模型', '账号', '来源', '结果', '已合并', '耗时（分钟）', '轮次', '输入 token', '输出 token', '缓存命中 token', '思考 token', '工具调用', '工具失败', 'MCP / Skill 调用', '交接级别', '预估费用（美元）'];
    const lines = [head.map(csvCell).join(',')];
    list.forEach((r) => {
      const d = new Date(r.ts), tn = Object.values(r.tl).reduce((s, v) => s + v[0], 0), tf = Object.values(r.tl).reduce((s, v) => s + v[1], 0);
      lines.push([`${ymd(d)} ${d.toTimeString().slice(0, 5)}`, r.title, r.proj, SB.groupName(SB.assign[r.tid]) || '未分组', agName(r.ag), r.model, r.acct, r.src === 'auto' ? '自动化' : '手动',
        OUT.find(([k]) => k === r.res)[1], r.merged ? '是' : '否', r.dur.toFixed(1), r.rn, Math.round(r.tin), Math.round(r.tout),
        r.tc === null ? '未报告' : Math.round(r.tc), r.tt === null ? '未报告' : Math.round(r.tt), tn, tf,
        Object.values(r.mcp).reduce((s, v) => s + v[0], 0), r.hl.join(' ') || '无', r.cost.toFixed(4)].map(csvCell).join(','));
    });
    const blob = new Blob([String.fromCharCode(0xfeff) + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.dataset.wired = '1';
    a.download = `AI-Console-调用统计-${ymd(sp.f)}_${ymd(new Date(sp.t - 1))}.csv`;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
    toast(`已导出 ${list.length} 条明细（${esc(sp.label)}）`);
  });

  // ---------- 渲染与筛选 ----------
  const cur2 = () => { const c = cur(); c.all = agg(c.list); c.G = groupBy(c.list, S.dim); return c; };
  const pane = $('#pane-st');
  let dirty = true;
  const render = () => {
    if (pane.hidden) { dirty = true; return; }
    dirty = false;
    const ctx = cur2();
    $('#st-scope').textContent = `统计范围：${scopeText()} · 共 ${num(ctx.all.n)} 个任务、${num(ctx.all.rn)} 轮`;
    renderTilesSt(ctx); renderDaily(ctx); renderTask(ctx); renderRound(ctx); renderTool(ctx); renderMcp(ctx); renderCmp(ctx); renderHo(ctx); renderJudge(ctx); renderGen(ctx);
  };
  function radio(group, onPick) {
    const bs = $$('[role="radio"]', group);
    group.addEventListener('click', (e) => {
      const b = e.target.closest('[role="radio"]'); if (!b) return;
      bs.forEach((x) => { x.setAttribute('aria-checked', String(x === b)); x.tabIndex = x === b ? 0 : -1; });
      onPick(b);
    });
    group.addEventListener('keydown', (e) => {
      const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
      const i = bs.indexOf(document.activeElement); if (i < 0) return;
      let n;
      if (e.key in keys) n = (i + keys[e.key] + bs.length) % bs.length; else if (e.key === 'Home') n = 0; else if (e.key === 'End') n = bs.length - 1; else return;
      e.preventDefault(); bs[n].focus(); bs[n].click();
    });
  }
  const fromEl = $('#st-from'), toEl = $('#st-to');
  fromEl.min = toEl.min = ymd(dayStart(DAYS - 1)); fromEl.max = toEl.max = ymd(dayStart(0));
  radio($('#st-range'), (b) => {
    const v = b.dataset.range;
    if (v === 'custom') { const sp = span(); S.from = S.from || ymd(sp.f); S.to = S.to || ymd(new Date(sp.t - 1)); fromEl.value = S.from; toEl.value = S.to; }
    S.range = v; $('#st-custom').hidden = v !== 'custom'; render();
  });
  const onDate = () => {
    const f = fromEl.value, t = toEl.value;
    if (!f || !t) return;
    if (f > t) { toast('开始日期不能晚于结束日期', 'attn'); fromEl.value = S.from; toEl.value = S.to; return; }
    if (f < fromEl.min) { toast('只保留最近 90 天的汇总数据', 'attn'); fromEl.value = S.from; return; }
    S.from = f; S.to = t; render();
  };
  fromEl.addEventListener('change', onDate); toEl.addEventListener('change', onDate);
  $('#st-dim').addEventListener('change', (e) => { S.dim = e.target.value; render(); });
  radio($('#daily-metric'), (b) => { S.metric = b.dataset.metric; renderDaily(cur2()); });
  radio($('#daily-vm'), (b) => { S.dvm = b.dataset.vm; renderDaily(cur2()); });
  BLOCKS.filter((x) => x[3]).forEach(([id]) => radio($(`[data-vmg="${id}"]`), (b) => { S.mode[id] = b.dataset.vm; render(); }));

  // 标签：app.js 负责切换和方向键，这里只做按需渲染和地址栏记忆
  $('#tab-st').addEventListener('click', () => { history.replaceState(null, '', '#stats'); if (dirty) setTimeout(render); });
  $('#tab-ov').addEventListener('click', () => { history.replaceState(null, '', location.pathname + location.search); closeDrill(); });
  $('#mon-tabs').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') setTimeout(() => { if (!pane.hidden && dirty) render(); history.replaceState(null, '', pane.hidden ? location.pathname + location.search : '#stats'); });
  });
  let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (!pane.hidden) render(); else dirty = true; }, 150); });
  document.addEventListener('aic-sb-change', () => { RECS = null; render(); });
  $('[data-refresh]')?.addEventListener('click', () => setTimeout(render, 720));
  const fromHash = () => { if (location.hash === '#stats' && pane.hidden) $('#tab-st').click(); };
  window.addEventListener('hashchange', fromHash);
  fromHash();
})();
