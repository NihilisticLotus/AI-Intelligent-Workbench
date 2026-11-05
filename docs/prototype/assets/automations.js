// 自动化页：定时任务与事件触发。只做原型演示，数据都是示例，保存在内存里。
// 依赖 app.js（侧栏、项目数据 aicSB、图标）和 interact.js（aicModal、aicToast、aicMenu、aicJudge）。
(function () {
  if (document.body.dataset.page !== 'automations') return;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const { aicToast: toast, aicModal: modal, aicMenu: menu, aicEsc: esc, aicAgents: agents, aicAccounts: accounts, aicEfforts: efforts, aicJudge: judge, aicJudgeOn: judgeOn, aicSB: SB } = window;
  const ic = (n, c) => window.icon(n, c);
  const letter = { claude: 'C', codex: 'X', codebuddy: 'B', zcode: 'Z' };

  // ---------- 时间工具 ----------
  const WK = '日一二三四五六';
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  const shift = (d, days) => { const x = new Date(d); x.setDate(x.getDate() + days); return x; };
  const fmt = (d) => {
    const now = new Date(), hm = d.toTimeString().slice(0, 5);
    if (sameDay(d, now)) return '今天 ' + hm;
    if (sameDay(d, shift(now, 1))) return '明天 ' + hm;
    if (sameDay(d, shift(now, -1))) return '昨天 ' + hm;
    return `${d.getMonth() + 1}月${d.getDate()}日 周${WK[d.getDay()]} ${hm}`;
  };
  const dayAt = (daysAgo, hm) => { const d = shift(new Date(), -daysAgo); const [h, m] = hm.split(':').map(Number); d.setHours(h, m, 0, 0); return d; };
  const minsAgo = (m) => new Date(Date.now() - m * 60000);
  const lastMonday = () => { const d = new Date(); return (d.getDay() + 6) % 7 || 7; }; // 距上周一（或本周一）的天数

  // ---------- 触发方式：描述与接下来几次的时间 ----------
  const freqName = { daily: '每天', weekdays: '工作日', weekly: '每周', monthly: '每月', hourly: '每隔 N 小时' };
  const describe = (tr, list = autos) => {
    if (tr.type === 'once') return `仅一次：${fmt(new Date(tr.at))}`;
    if (tr.type === 'file') return `${tr.folder} 有新 ${tr.exts.map((e) => e.slice(1).toUpperCase()).join(' / ')} 时`;
    if (tr.type === 'after') { const ref = list.find((a) => a.id === tr.ref); return `“${ref ? ref.name : '已删除的自动化'}”${tr.when === 'success' ? '成功' : '完成'}后`; }
    const t = tr.time;
    if (tr.freq === 'daily') return `每天 ${t}`;
    if (tr.freq === 'weekdays') return `工作日 ${t}`;
    if (tr.freq === 'weekly') return `每周${tr.days.map((d) => WK[d % 7]).join('、')} ${t}`;
    if (tr.freq === 'monthly') return `每月${tr.mday === 'last' ? '最后一天' : ` ${tr.mday} 号`} ${t}`;
    return `每隔 ${tr.every} 小时（从 ${t} 起）`;
  };
  const nextRuns = (tr, n = 3, from = new Date(), list = autos) => {
    if (tr.type === 'once') { const d = new Date(tr.at); return d > from ? [d] : []; }
    if (tr.type === 'file') return [];
    if (tr.type === 'after') {
      const ref = list.find((a) => a.id === tr.ref);
      return ref && ref.trigger.type !== 'after' ? nextRuns(ref.trigger, n, from, list).map((d) => new Date(+d + 30 * 60000)) : [];
    }
    const [hh, mm] = tr.time.split(':').map(Number);
    const out = [];
    if (tr.freq === 'hourly') {
      let t = new Date(from); t.setHours(hh, mm, 0, 0);
      const step = tr.every * 3600000;
      while (t <= from) t = new Date(+t + step);
      while (out.length < n) { out.push(t); t = new Date(+t + step); }
      return out;
    }
    for (let i = 0; out.length < n && i < 400; i++) {
      const d = shift(from, i); d.setHours(hh, mm, 0, 0);
      if (d <= from) continue;
      const wd = d.getDay() || 7;
      const last = shift(d, 1).getDate() === 1;
      const hit = tr.freq === 'daily' || (tr.freq === 'weekdays' && wd <= 5) || (tr.freq === 'weekly' && tr.days.includes(wd))
        || (tr.freq === 'monthly' && (tr.mday === 'last' ? last : d.getDate() === +tr.mday));
      if (hit) out.push(d);
    }
    return out;
  };
  const trigIcon = (tr) => ({ once: 'calendar', repeat: 'clock', file: 'folder', after: 'link' }[tr.type]);

  // ---------- 示例数据：贴合游戏开发 ----------
  const P1 = SB.projects[0]?.name || '雾港物语';
  const autos = [
    { id: 'a1', name: '每晚全量构建并汇总报错', proj: P1, enabled: true,
      prompt: '全量构建 FogHarbor（Windows 和 Steam Deck 两个目标），把编译错误和警告按文件汇总成一张表，和{上次运行结果}对比，标出新增的问题。不要修改代码。',
      trigger: { type: 'repeat', freq: 'daily', time: '02:00' },
      agent: 'claude', account: '工作室 API Key', model: 'Sonnet 5', effort: '中', perm: '工作区内自动',
      rules: { overlap: 'skip', missed: 'catchup', max: '1 小时', budget: '$3' }, notify: 'severity', automerge: false,
      runs: [
        { at: dayAt(0, '02:00'), st: 'ok', dur: '23 分钟', sum: '构建通过；3 条警告，比上次少 2 条' },
        { at: dayAt(1, '02:00'), st: 'err', dur: '9 分钟', sum: 'Steam Deck 目标编译失败：InventoryGrid.cs 有 2 个错误', grade: { text: '严重程度：高', prob: 86, level: 'err', why: '主分支编译失败，会挡住所有人今天的构建' } },
        { at: dayAt(2, '07:42'), st: 'ok', dur: '21 分钟', sum: '补跑：02:00 时电脑在休眠，醒来后补跑了一次。构建通过' },
        { at: dayAt(3, '02:00'), st: 'ok', dur: '22 分钟', sum: '构建通过；5 条警告' },
      ] },
    { id: 'a2', name: '每周一生成上周更新日志', proj: P1, enabled: true,
      prompt: '读取上周合并到 main 的提交和已完成的任务，按“新功能 / 修复 / 美术资源 / 本地化”分类，写一份玩家能看懂的更新日志，存到 Docs/Changelog/{日期}.md。',
      trigger: { type: 'repeat', freq: 'weekly', days: [1], time: '10:00' },
      agent: 'codebuddy', account: '沿用 WorkBuddy 登录', model: 'glm-5.1', effort: null, perm: '工作区内自动',
      rules: { overlap: 'queue', missed: 'skip', max: '30 分钟', budget: '5%' }, notify: 'always', automerge: false,
      runs: [
        { at: dayAt(lastMonday(), '10:00'), st: 'ok', dur: '6 分钟', sum: '生成 v0.9.3 更新日志，共 14 条，已放进待验收' },
        { at: dayAt(lastMonday() + 7, '10:00'), st: 'skip', sum: '电脑在休眠，已错过（规则：错过就跳过）' },
        { at: dayAt(lastMonday() + 14, '10:00'), st: 'ok', dur: '5 分钟', sum: '生成 v0.9.1 更新日志，共 9 条' },
      ] },
    { id: 'a3', name: '新 FBX 自动转 glb 并检查面数和命名', proj: P1, enabled: true,
      prompt: '把{变化的文件}转成 glb（+Y 朝上，单位米），检查三角面不超过 2,000、文件名符合 SM_ / SK_ 前缀规则。不合格的列出原因，不要改原始 FBX。',
      trigger: { type: 'file', folder: 'Assets/Art', exts: ['.fbx'], settle: '30 秒' },
      agent: 'codebuddy', account: '沿用 WorkBuddy 登录', model: 'glm-5.1', effort: null, perm: '工作区内自动',
      rules: { overlap: 'skip', missed: 'catchup', max: '15 分钟', budget: '2%' }, notify: 'fail', automerge: false,
      runs: [
        { at: minsAgo(18), st: 'ok', dur: '2 分钟', sum: 'SM_Chest_v2.fbx → SM_Chest_v2.glb，412 个三角面，命名正确' },
        { at: minsAgo(52), st: 'err', dur: '1 分钟', sum: 'SM_Lantern.fbx 有 3,812 个三角面，超过上限 2,000', grade: { text: '严重程度：中', prob: 71, level: 'wait', why: '单个道具超面数，不影响构建，可以等美术改' } },
        { at: minsAgo(53), st: 'skip', sum: '上次还没跑完，已跳过（规则：跳过这次）' },
      ] },
    { id: 'a4', name: '检查本地化文本表的缺失条目', proj: P1, enabled: true,
      prompt: '对比 Localization 下中文、英文、日文三张文本表，列出缺失或空白的条目，以及超过 UI 宽度的超长条目，生成补全清单。只读，不要直接改文本表。',
      trigger: { type: 'repeat', freq: 'weekdays', time: '09:30' },
      agent: 'codex', account: 'ChatGPT 账号', model: 'gpt-5.5-codex', effort: '中', perm: '只读',
      rules: { overlap: 'skip', missed: 'catchup', max: '30 分钟', budget: '5%' }, notify: 'severity', automerge: false,
      warn: 'Codex 登录已过期，下次运行会失败',
      runs: [
        { at: dayAt(1, '09:30'), st: 'err', dur: '—', sum: 'Codex 登录已过期，没有开始运行' },
        { at: dayAt(2, '09:30'), st: 'ok', dur: '4 分钟', sum: '缺 7 条日文、2 条英文；3 条日文超长', grade: { text: '严重程度：低', prob: 90, level: 'ok', why: '只是缺翻译，不影响构建，本周内补齐即可' } },
      ] },
    { id: 'a5', name: '每隔 4 小时核对 Wwise 事件表和代码引用', proj: P1, enabled: false,
      prompt: '对比 Wwise 导出的事件表和代码里的 AkSoundEngine.PostEvent 调用，列出代码引用了但事件表里没有的事件。',
      trigger: { type: 'repeat', freq: 'hourly', every: 4, time: '08:00' },
      agent: 'claude', account: '个人订阅', model: 'Sonnet 5', effort: '低', perm: '只读',
      rules: { overlap: 'skip', missed: 'skip', max: '15 分钟', budget: '2%' }, notify: 'fail', automerge: false,
      paused: '你在 3 天前暂停：音频组在重做事件命名',
      runs: [{ at: dayAt(3, '12:00'), st: 'ok', dur: '3 分钟', sum: '一致，没有缺失的事件' }] },
    { id: 'a6', name: '构建成功后跑冒烟测试并截图主菜单', proj: P1, enabled: true,
      prompt: '用{上次运行结果}里的构建包启动游戏，进入主菜单、新建存档、进入第一关，各截一张图。任何一步卡住超过 2 分钟就判为失败。',
      trigger: { type: 'after', ref: 'a1', when: 'success' },
      agent: 'claude', account: '工作室 API Key', model: 'Sonnet 5', effort: '低', perm: '工作区内自动',
      rules: { overlap: 'queue', missed: 'catchup', max: '30 分钟', budget: '$1' }, notify: 'fail', automerge: false,
      runs: [
        { at: dayAt(0, '02:31'), st: 'ok', dur: '7 分钟', sum: '3 张截图；主菜单加载 4.2 秒' },
        { at: dayAt(1, '02:09'), st: 'skip', sum: '“每晚全量构建”失败，按规则不运行' },
      ] },
  ];
  const stText = { ok: '成功', err: '失败', skip: '跳过', run: '运行中' };
  const stCls = { ok: 'ok', err: 'err', skip: 'idle', run: 'run' };
  const notifyText = { always: '每次都发通知', fail: '只在失败时通知', severity: '按快速判断的严重程度：中及以上才通知' };
  const varHtml = (s) => esc(s).replace(/\{(日期|变化的文件|上次运行结果|项目名)\}/g, '<span class="var">$1</span>');
  const isApiKey = (acc) => /API Key/.test(acc);
  const budgetText = (a) => (a.rules.budget === 'none' ? '不设上限' : a.rules.budget.startsWith('$') ? `单次最多 ${a.rules.budget}` : `单次最多用 ${a.rules.budget} 周额度`);
  const nextText = (a) => {
    if (!a.enabled) return '已暂停';
    if (a.trigger.type === 'file') return '有新文件时';
    const n = nextRuns(a.trigger, 1)[0];
    if (!n) return a.trigger.type === 'once' ? '已运行，不再重复' : '—';
    return (a.trigger.type === 'after' ? '约 ' : '') + fmt(n);
  };

  // ---------- 列表 ----------
  let filter = 'all';
  let selId = 'a1';
  const tbody = $('#auto-rows');
  const resultCell = (a) => {
    const r = a.runs[0];
    if (!r) return '<span class="status idle"><span class="dot"></span>还没运行过</span>';
    return `<span class="status ${stCls[r.st]}"><span class="dot"></span>${stText[r.st]}</span><span class="sub">${fmt(r.at)}</span>`;
  };
  const renderChips = () => {
    $('.achips').innerHTML = [['all', '全部项目'], ...SB.projects.map((p) => [p.name, p.name])]
      .map(([v, l]) => `<button class="chipsel" data-wired="1" data-af="${esc(v)}" aria-pressed="${v === filter}">${esc(l)}</button>`).join('');
  };
  const render = () => {
    const list = autos.filter((a) => filter === 'all' || a.proj === filter);
    $('.main-head .meta').textContent = `${autos.length} 条，${autos.filter((a) => a.enabled).length} 条启用`;
    tbody.innerHTML = list.map((a) => `<tr data-id="${a.id}" tabindex="0" ${a.id === selId ? 'aria-selected="true"' : 'aria-selected="false"'} class="${a.enabled ? '' : 'off'}">
      <td class="c-sw"><button class="switch" role="switch" data-wired="1" data-sw aria-checked="${a.enabled}" aria-label="启用“${esc(a.name)}”"></button><span class="sw-t">${a.enabled ? '启用' : '暂停'}</span></td>
      <td class="c-name"><b>${esc(a.name)}</b><span class="sub">${esc(a.proj)}</span></td>
      <td class="c-trig">${ic(trigIcon(a.trigger))}<span>${esc(describe(a.trigger))}</span></td>
      <td class="c-ag"><span class="ag ${a.agent}" title="${agents[a.agent][0]}" aria-hidden="true">${letter[a.agent]}</span><span>${agents[a.agent][0]}<span class="sub">${esc(a.model)}</span></span></td>
      <td class="c-next">${a.warn && a.enabled ? `<span class="status wait" title="${esc(a.warn)}"><span class="dot"></span>${esc(nextText(a))}</span><span class="sub attn-t">${esc(a.warn)}</span>` : esc(nextText(a))}</td>
      <td class="c-res">${resultCell(a)}</td>
      <td class="c-more"><button class="btn ghost icon sm" data-wired="1" data-more aria-label="“${esc(a.name)}”的更多操作" title="立即运行、暂停、复制、删除">${ic('more')}</button></td></tr>`).join('');
    $('#auto-empty').hidden = list.length > 0;
    $('.auto-table').hidden = list.length === 0;
    renderSide();
  };

  // ---------- 右侧：详情 + 运行历史 ----------
  const side = $('#a-detail');
  const renderSide = () => {
    const a = autos.find((x) => x.id === selId);
    if (!a) { side.innerHTML = '<div class="empty"><p>选择左边的一条自动化查看详情和运行历史。</p></div>'; return; }
    const next = a.trigger.type === 'file' ? [] : nextRuns(a.trigger, 3);
    const runRow = (r) => {
      const title = `${a.name} · ${fmt(r.at)}`;
      const link = r.st === 'skip' ? '<span class="sub">没有生成任务</span>'
        : `<a class="btn sm ghost" data-wired="1" href="workbench.html?${new URLSearchParams({ title, st: stCls[r.st], stt: r.st === 'ok' ? '已完成' : r.st === 'run' ? '运行中' : '失败' })}">打开对话</a>`;
      const g = r.grade && judgeOn('grade') ? judge({ kind: 'grade', text: r.grade.text, prob: r.grade.prob, why: r.grade.why, level: r.grade.level }) : '';
      return `<li><div class="rh"><span class="status ${stCls[r.st]}"><span class="dot"></span>${stText[r.st]}</span><span class="t">${fmt(r.at)}</span>${r.dur ? `<span class="sub">${r.dur}</span>` : ''}<span class="grow"></span>${link}</div>
        <p>${esc(r.sum)}</p>${g}</li>`;
    };
    side.innerHTML = `<h2>${esc(a.name)}</h2>
      <p class="lead"><span class="status ${a.enabled ? 'ok' : 'idle'}"><span class="dot"></span>${a.enabled ? '已启用' : '已暂停'}</span>${a.paused && !a.enabled ? `<span class="sub">${esc(a.paused)}</span>` : ''}</p>
      ${a.warn && a.enabled ? `<div class="alert attn" style="margin-bottom:var(--sp-3)">${ic('warn')}<div class="body"><strong>${esc(a.warn)}</strong><p>重新登录后会按时运行。也可以编辑这条自动化，换成其他 Agent。</p><div class="actions" style="margin-top:6px"><a class="btn sm attn" data-wired="1" href="agents.html">去重新登录</a></div></div></div>` : ''}
      <div class="d-acts">
        <button class="btn sm primary" data-wired="1" data-op="run">${ic('play')}立即运行一次</button>
        <button class="btn sm" data-wired="1" data-op="edit">${ic('edit')}编辑</button>
        <button class="btn sm" data-wired="1" data-op="toggle">${ic(a.enabled ? 'pause' : 'play')}${a.enabled ? '暂停' : '启用'}</button>
        <button class="btn sm ghost icon" data-wired="1" data-op="more" aria-label="更多操作">${ic('more')}</button>
      </div>
      <dl class="d-kv">
        <dt>项目</dt><dd>${esc(a.proj)}</dd>
        <dt>要做什么</dt><dd class="prompt">${varHtml(a.prompt)}</dd>
        <dt>触发</dt><dd>${esc(describe(a.trigger))}${a.trigger.type === 'file' ? `<span class="sub">同一批改动 ${esc(a.trigger.settle)}内合并成一次运行</span>` : ''}</dd>
        <dt>接下来</dt><dd>${!a.enabled ? '已暂停，不会运行' : a.trigger.type === 'file' ? '没有固定时间，检测到新文件时运行' : next.length ? next.map((d) => (a.trigger.type === 'after' ? '约 ' : '') + fmt(d)).join('<br>') : '没有下次'}</dd>
        <dt>Agent</dt><dd><span class="ag ${a.agent}" aria-hidden="true">${letter[a.agent]}</span> ${agents[a.agent][0]} · ${esc(a.account)} · ${esc(a.model)}${a.effort ? ` · 思考 ${a.effort}` : ''}</dd>
        <dt>权限</dt><dd>${esc(a.perm)}</dd>
        <dt>运行规则</dt><dd>${a.rules.overlap === 'skip' ? '上次没结束就跳过这次' : '上次没结束就排队等'}<br>${a.rules.missed === 'catchup' ? '电脑休眠错过了，醒来后补跑一次' : '电脑休眠错过了就跳过'}<br>单次最长 ${esc(a.rules.max)}，${budgetText(a)}</dd>
        <dt>完成后</dt><dd>${notifyText[a.notify]}<br>${a.automerge ? '<b>生成的任务测试通过后自动合并</b>' : '生成的任务不自动合并，等你验收'}</dd>
      </dl>
      <h3>运行历史</h3>
      <p class="sub" style="margin:0 0 var(--sp-2)">每次运行都是一个普通任务，可以点进对话查看过程和改动。</p>
      <ol class="runs">${a.runs.map(runRow).join('') || '<li class="sub">还没运行过</li>'}</ol>`;
  };
  const select = (id, open = true) => {
    selId = id;
    $$('tr[data-id]', tbody).forEach((r) => r.setAttribute('aria-selected', String(r.dataset.id === id)));
    renderSide();
    if (open) window.aicOpenSide();
  };

  // ---------- 行操作 ----------
  const byId = (id) => autos.find((a) => a.id === id);
  const toggle = (a) => {
    a.enabled = !a.enabled;
    if (!a.enabled) a.paused = '你刚刚暂停';
    render();
    toast(a.enabled ? `已启用“${esc(a.name)}”，${a.trigger.type === 'file' ? '检测到新文件时运行' : '下次 ' + esc(nextText(a))}` : `已暂停“${esc(a.name)}”，不会再自动运行`);
  };
  const runNow = (a) => {
    if (a.agent === 'codex') return modal({ title: 'Codex 登录已过期', body: '<p>这条自动化用的是 Codex，重新登录后才能运行。也可以编辑它换成其他 Agent。</p>',
      actions: [{ label: '取消' }, { label: '编辑自动化', onClick() { setTimeout(() => editor(a)); } }, { label: '去重新登录', kind: 'primary', onClick() { location.href = 'agents.html'; } }] });
    if (a.runs[0]?.st === 'run' && a.rules.overlap === 'skip') {
      a.runs.unshift({ at: new Date(), st: 'skip', sum: '上次还没跑完，已跳过（规则：跳过这次）' });
      render(); return toast('上一次还在运行，按规则跳过了这次', 'attn');
    }
    if (a.runs[0]?.st === 'run') {
      if (a.queued) return toast('已经有一次在排队了', 'attn');
      a.queued = true;
      return toast('上一次还在运行，这次已排队，等它结束后开始（规则：排队等它结束）');
    }
    const run = { at: new Date(), st: 'run', dur: '', sum: '正在运行（手动触发）' };
    a.runs.unshift(run);
    const task = SB.addTask({ proj: a.proj, ag: a.agent, title: `${a.name}（手动运行）`, st: 'run', stText: '运行中' });
    run.task = task.id;
    select(a.id, false); render();
    toast(`已开始运行“${esc(a.name)}”，侧栏任务列表里可以看到这次运行`);
    setTimeout(() => {
      Object.assign(run, { st: 'ok', dur: '1 分钟', sum: '完成（原型模拟结果）' });
      Object.assign(task, { st: 'ok', stText: '已完成' }); SB.render();
      render();
      toast(`“${esc(a.name)}”运行完成${a.notify === 'fail' ? '（只在失败时通知，这里仅原型提示）' : ''}`);
      if (a.queued) { a.queued = false; setTimeout(() => runNow(a), 400); }
    }, 2600);
  };
  const copy = (a) => {
    const c = JSON.parse(JSON.stringify({ ...a, runs: [] }));
    Object.assign(c, { id: 'a' + Date.now(), name: a.name + '（副本）', enabled: false, paused: '复制出来的副本默认暂停，确认无误后再启用', runs: [] });
    autos.splice(autos.indexOf(a) + 1, 0, c);
    selId = c.id; render(); window.aicOpenSide();
    toast(`已复制为“${esc(c.name)}”，副本默认暂停`);
  };
  const remove = (a) => modal({ title: `删除“${esc(a.name)}”？`,
    body: `<p>删除后不会再自动运行。已经产生的 ${a.runs.length} 次运行记录作为普通任务保留，不受影响。</p>${autos.some((x) => x.trigger.type === 'after' && x.trigger.ref === a.id) ? '<p style="margin:0;color:var(--attn)">有其他自动化设为“在它完成后运行”，删除后它们不会再被触发。</p>' : ''}`,
    actions: [{ label: '取消' }, { label: '删除', kind: 'danger', onClick() {
      autos.splice(autos.indexOf(a), 1);
      if (selId === a.id) selId = autos[0]?.id;
      render(); toast(`已删除“${esc(a.name)}”`);
    } }] });
  const rowMenu = (btn, a) => menu(btn, [
    ['立即运行一次', () => runNow(a)],
    ['编辑…', () => editor(a)],
    [a.enabled ? '暂停' : '启用', () => toggle(a)],
    ['复制', () => copy(a)],
    ['删除…', () => remove(a), 'danger'],
  ]);

  tbody.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]'); if (!tr) return;
    const a = byId(tr.dataset.id);
    if (e.target.closest('[data-sw]')) { toggle(a); return; }
    if (e.target.closest('[data-more]')) { rowMenu(e.target.closest('[data-more]'), a); return; }
    select(a.id);
  });
  tbody.addEventListener('keydown', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr || e.target !== tr) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(tr.dataset.id); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); (e.key === 'ArrowDown' ? tr.nextElementSibling : tr.previousElementSibling)?.focus(); }
  });
  side.addEventListener('click', (e) => {
    const b = e.target.closest('[data-op]'); if (!b) return;
    const a = byId(selId);
    ({ run: () => runNow(a), edit: () => editor(a), toggle: () => toggle(a), more: () => rowMenu(b, a) })[b.dataset.op]();
  });
  $('.afilters').addEventListener('click', (e) => { const f = e.target.closest('[data-af]'); if (f) { filter = f.dataset.af; renderChips(); render(); } });
  $$('[data-new-auto]').forEach((b) => b.addEventListener('click', () => editor()));
  document.addEventListener('aic-sb-change', () => { if (!$('.achips').children.length) return; renderChips(); });
  document.addEventListener('aic-judge-change', renderSide);

  // ---------- 新建 / 编辑对话框 ----------
  const opts = (list, cur) => list.map((v) => { const [val, label] = Array.isArray(v) ? v : [v, v]; return `<option value="${esc(val)}" ${String(val) === String(cur) ? 'selected' : ''}>${esc(label)}</option>`; }).join('');
  const radios = (name, list, cur) => `<div class="radios" role="radiogroup" aria-labelledby="${name}-l">${list.map(([v, l]) => `<label><input type="radio" name="${name}" value="${v}" ${v === cur ? 'checked' : ''}>${l}</label>`).join('')}</div>`;
  const tomorrow9 = () => { const d = shift(new Date(), 1); d.setHours(9, 0, 0, 0); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
  const budgetOpts = (acc) => (isApiKey(acc) ? [['$1', '单次最多 $1'], ['$3', '单次最多 $3'], ['$5', '单次最多 $5'], ['none', '不设上限']] : [['2%', '单次最多用 2% 周额度'], ['5%', '单次最多用 5% 周额度'], ['10%', '单次最多用 10% 周额度'], ['none', '不设上限']]);
  const folders = ['Assets/Art', 'Assets/Audio', 'Localization', 'Assets/Scripts'];
  const exts = ['.fbx', '.obj', '.png', '.psd', '.wav', '.csv'];

  const editor = (src) => {
    const isNew = !src;
    // 运行历史里有 Date，不跟着复制；保存时只覆盖配置字段
    const a = src ? JSON.parse(JSON.stringify({ ...src, runs: undefined })) : {
      name: '', proj: P1, prompt: '', trigger: { type: 'repeat', freq: 'daily', time: '09:00' },
      agent: 'claude', account: accounts.claude[0], model: agents.claude[1][0], effort: '中', perm: '工作区内自动',
      rules: { overlap: 'skip', missed: 'catchup', max: '30 分钟', budget: '5%' }, notify: 'always', automerge: false,
    };
    const tr = a.trigger;
    const others = autos.filter((x) => x.id !== a.id && x.trigger.type !== 'after');
    const gradeOn = judgeOn('grade');
    modal({
      title: isNew ? '新建自动化' : `编辑“${esc(a.name)}”`, wide: true,
      body: `<h3 class="dlg-sec">做什么</h3>
        <div class="form-row"><label for="ae-n">名称</label><input class="input" id="ae-n" value="${esc(a.name)}" placeholder="例如：每晚全量构建并汇总报错"></div>
        <div class="form-row"><label for="ae-p">项目</label><select class="select" id="ae-p">${opts(SB.projects.map((p) => p.name), a.proj)}</select></div>
        <div class="form-row" style="align-items:start"><label for="ae-d">要做什么</label><div>
          <textarea class="textarea" id="ae-d" rows="4" placeholder="像派任务一样写：要做什么、不要碰什么、做完交付什么">${esc(a.prompt)}</textarea>
          <div class="vars" role="group" aria-label="插入变量"><span class="sub">插入变量：</span>${['日期', '变化的文件', '上次运行结果', '项目名'].map((v) => `<button type="button" class="btn sm ghost" data-wired="1" data-var="${v}">+ ${v}</button>`).join('')}</div>
          <p class="sub" style="margin:4px 0 0">运行时变量会换成实际内容，例如“日期”换成 2026-11-07。</p></div></div>

        <h3 class="dlg-sec">什么时候运行</h3>
        <div class="form-row"><span class="lbl" id="ae-tt-l">触发方式</span>${radios('ae-tt', [['once', '一次性'], ['repeat', '重复'], ['file', '文件变化'], ['after', '任务完成后']], tr.type)}</div>
        <div data-tt="once"><div class="form-row"><label for="ae-at">日期时间</label><input class="input" type="datetime-local" id="ae-at" value="${tr.at || tomorrow9()}"></div></div>
        <div data-tt="repeat">
          <div class="form-row"><label for="ae-f">频率</label><select class="select" id="ae-f">${opts(Object.entries(freqName), tr.freq || 'daily')}</select></div>
          <div class="form-row" data-fq="weekly"><span class="lbl">星期</span><div class="daypick" role="group" aria-label="每周哪几天">${[1, 2, 3, 4, 5, 6, 7].map((d) => `<label><input type="checkbox" value="${d}" ${(tr.days || [1]).includes(d) ? 'checked' : ''}><span>周${WK[d % 7]}</span></label>`).join('')}</div></div>
          <div class="form-row" data-fq="monthly"><label for="ae-md">日期</label><select class="select" id="ae-md">${opts([...Array.from({ length: 28 }, (_, i) => [String(i + 1), `每月 ${i + 1} 号`]), ['last', '每月最后一天']], tr.mday || '1')}</select></div>
          <div class="form-row" data-fq="hourly"><label for="ae-ev">间隔</label><select class="select" id="ae-ev">${opts([1, 2, 3, 4, 6, 8, 12].map((h) => [String(h), `每隔 ${h} 小时`]), String(tr.every || 4))}</select></div>
          <div class="form-row"><label for="ae-t" id="ae-t-l">时间</label><input class="input" type="time" id="ae-t" value="${tr.time || '09:00'}" style="max-width:160px"></div>
        </div>
        <div data-tt="file">
          <div class="form-row"><span class="lbl">文件夹</span><div style="display:flex;gap:8px;min-width:0"><input class="input" id="ae-fd" value="${esc(tr.folder || 'Assets/Art')}" readonly aria-label="监视的文件夹" style="flex:1;min-width:0"><button type="button" class="btn" data-wired="1" id="ae-pick">${ic('folder')}选择文件夹…</button></div></div>
          <div class="form-row"><span class="lbl">文件类型</span><div class="daypick" role="group" aria-label="文件类型">${exts.map((x) => `<label><input type="checkbox" value="${x}" ${(tr.exts || ['.fbx']).includes(x) ? 'checked' : ''}><span>${x.slice(1).toUpperCase()}</span></label>`).join('')}</div></div>
          <div class="form-row"><label for="ae-st">合并改动</label><select class="select" id="ae-st">${opts(['10 秒', '30 秒', '2 分钟'].map((v) => [v, `同一批改动 ${v}内合并成一次运行`]), tr.settle || '30 秒')}</select></div>
        </div>
        <div data-tt="after">
          <div class="form-row"><label for="ae-ref">在它之后</label><select class="select" id="ae-ref">${others.length ? opts(others.map((x) => [x.id, x.name]), tr.ref) : '<option value="">还没有其他自动化</option>'}</select></div>
          <div class="form-row"><span class="lbl" id="ae-when-l">条件</span>${radios('ae-when', [['success', '它成功后才运行'], ['any', '无论成功失败都运行']], tr.when || 'success')}</div>
        </div>
        <div class="next-box" aria-live="polite"></div>

        <h3 class="dlg-sec">谁来做</h3>
        <div class="form-row"><label for="ae-a">Agent</label><select class="select" id="ae-a">${opts(Object.entries(agents).map(([k, [n]]) => [k, n + (k === 'codex' ? '（登录已过期）' : k === 'zcode' ? '（未连接）' : '')]), a.agent)}</select></div>
        <div class="form-row"><label for="ae-acc">账号</label><select class="select" id="ae-acc"></select></div>
        <div class="form-row"><label for="ae-m">模型</label><select class="select" id="ae-m"></select></div>
        <div class="form-row"><label for="ae-e">思考强度</label><select class="select" id="ae-e"></select></div>
        <div class="form-row"><label for="ae-pm">权限</label><select class="select" id="ae-pm">${opts([['只读', '只读：只能读文件和搜索'], ['需审批', '需审批：每次改文件、执行命令都等你（无人值守时会一直等）'], ['工作区内自动', '工作区内自动（推荐）：只在工作副本里操作，越界才问你'], ['全自动', '全自动…']], a.perm)}</select></div>

        <h3 class="dlg-sec">运行规则</h3>
        <div class="form-row"><span class="lbl" id="ae-ov-l">上次没结束</span>${radios('ae-ov', [['skip', '跳过这次'], ['queue', '排队等它结束']], a.rules.overlap)}</div>
        <div class="form-row"><span class="lbl" id="ae-ms-l">电脑休眠错过</span>${radios('ae-ms', [['catchup', '醒来后补跑一次'], ['skip', '跳过']], a.rules.missed)}</div>
        <div class="form-row"><label for="ae-mx">最长时间</label><select class="select" id="ae-mx">${opts(['15 分钟', '30 分钟', '1 小时', '2 小时'], a.rules.max)}</select></div>
        <p class="field-note">超过时间自动中断，结果记为失败。</p>
        <div class="form-row"><label for="ae-bg">额度上限</label><select class="select" id="ae-bg"></select></div>

        <h3 class="dlg-sec">完成后</h3>
        <div class="form-row" style="align-items:start"><span class="lbl">通知</span><div>
          <label class="check-row"><input type="radio" name="ae-nt" value="always" ${a.notify === 'always' ? 'checked' : ''}> <span>每次都发通知</span></label>
          <label class="check-row"><input type="radio" name="ae-nt" value="fail" ${a.notify === 'fail' ? 'checked' : ''}> <span>只在失败时通知</span></label>
          <label class="check-row"><input type="radio" name="ae-nt" value="severity" ${a.notify === 'severity' ? 'checked' : ''} ${gradeOn ? '' : 'disabled'}> <span>按快速判断的严重程度决定<small>${gradeOn ? '判断为“中”或“高”才通知，“低”只记在运行历史里' : '“自动化结果分级”在设置里已关闭，这一项不可用'}</small></span></label>
        </div></div>
        <label class="check-row"><input type="checkbox" id="ae-am" ${a.automerge ? 'checked' : ''}> <span>生成的任务默认“测试通过后自动合并”<small>这是每次运行生成的任务的初始值，默认关闭；之后可以在单个任务的合并区里改。开启后不经你验收直接合并到 main，合并前仍会检查冲突</small></span></label>`,
      onOpen(d) {
        const q = (s) => $(s, d);
        const ta = q('#ae-d');
        $$('[data-var]', d).forEach((b) => b.addEventListener('click', () => {
          const t = `{${b.dataset.var}}`, s = ta.selectionStart ?? ta.value.length;
          ta.value = ta.value.slice(0, s) + t + ta.value.slice(ta.selectionEnd ?? s);
          ta.focus(); ta.selectionStart = ta.selectionEnd = s + t.length;
        }));
        q('#ae-pick').addEventListener('click', () => {
          const i = (folders.indexOf(q('#ae-fd').value) + 1) % folders.length;
          q('#ae-fd').value = folders[i];
          toast(`原型模拟文件夹对话框：选了 ${folders[i]}`, 'demo'); upd();
        });
        // Agent → 账号、模型、思考强度联动
        const fillAgent = (keep) => {
          const k = q('#ae-a').value;
          q('#ae-acc').innerHTML = opts(accounts[k], keep ? a.account : accounts[k][0]);
          q('#ae-m').innerHTML = opts(agents[k][1], keep ? a.model : agents[k][1][0]);
          const ef = efforts[k];
          q('#ae-e').innerHTML = ef ? opts(ef, keep && a.effort ? a.effort : '中') : '<option value="">由模型自己决定</option>';
          q('#ae-e').disabled = !ef;
          fillBudget(keep);
        };
        const fillBudget = (keep) => { q('#ae-bg').innerHTML = opts(budgetOpts(q('#ae-acc').value), keep ? a.rules.budget : isApiKey(q('#ae-acc').value) ? '$3' : '5%'); };
        q('#ae-a').addEventListener('change', () => {
          fillAgent(false);
          const k = q('#ae-a').value;
          if (k === 'codex' || k === 'zcode') toast(`${agents[k][0]} 现在${k === 'codex' ? '登录已过期' : '还没连接'}，保存后运行会失败，可以先去 Agent 管理处理`, 'attn');
        });
        q('#ae-acc').addEventListener('change', () => fillBudget(false));
        fillAgent(true);
        // 全自动：二次确认
        let lastPerm = q('#ae-pm').value;
        q('#ae-pm').addEventListener('change', (e) => {
          if (e.target.value !== '全自动') { lastPerm = e.target.value; return; }
          e.target.value = lastPerm;
          modal({ title: '这条自动化用全自动？', body: '<p>无人值守时，除了“始终禁止”清单里的操作，Agent 的所有操作都不再询问你，包括工作副本外的读写。</p><p style="margin:0">建议只给可以随时丢弃结果的自动化使用。</p>',
            actions: [{ label: '取消' }, { label: '使用全自动', kind: 'danger', onClick() { q('#ae-pm').value = '全自动'; lastPerm = '全自动'; } }] });
        });
        // 自动合并：二次确认
        q('#ae-am').addEventListener('change', (e) => {
          if (!e.target.checked) return;
          e.target.checked = false;
          modal({ title: '开启自动合并？', body: '<p>测试全部通过后，这条自动化的改动会直接合并到 main，不等你验收。如果测试没覆盖到的地方改错了，要靠回滚恢复。</p><p style="margin:0">合并前仍会检查冲突；有冲突时不合并，改为通知你。</p>',
            actions: [{ label: '取消' }, { label: '开启自动合并', kind: 'danger', onClick() { q('#ae-am').checked = true; } }] });
        });
        // 触发方式切换 + 接下来 3 次预览
        const upd = () => {
          const t = readTrigger(d);
          $$('[data-tt]', d).forEach((p) => { p.hidden = p.dataset.tt !== t.type; });
          if (t.type === 'repeat') {
            $$('[data-fq]', d).forEach((p) => { p.hidden = p.dataset.fq !== t.freq; });
            q('#ae-t-l').textContent = t.freq === 'hourly' ? '从几点起' : '时间';
          }
          const box = q('.next-box');
          if (t.type === 'file') { box.innerHTML = `${ic('info')}<div><b>没有固定时间</b><span>${esc(describe(t))}运行；同一批改动 ${esc(t.settle)}内合并成一次。</span></div>`; return; }
          const runs = nextRuns(t, 3);
          if (t.type === 'repeat' && t.freq === 'weekly' && !t.days.length) { box.innerHTML = `${ic('warn')}<div><b>至少选一天</b></div>`; return; }
          box.innerHTML = `${ic('calendar')}<div><b>接下来 3 次运行</b>${runs.length ? `<ol>${runs.map((r) => `<li>${t.type === 'after' ? '约 ' : ''}${fmt(r)}</li>`).join('')}</ol>${t.type === 'after' ? '<span>按前一个自动化的下次时间加上它通常的耗时估算</span>' : ''}`
            : `<span>${t.type === 'once' ? '这个时间已经过去了，请选一个以后的时间' : '没有可预览的时间'}</span>`}</div>`;
        };
        d.addEventListener('change', upd); d.addEventListener('input', (e) => { if (e.target.type === 'time' || e.target.type === 'datetime-local') upd(); });
        upd();
        (isNew ? q('#ae-n') : ta).focus();
      },
      actions: [{ label: '取消' }, { label: isNew ? '创建' : '保存', kind: 'primary', onClick(d) {
        const q = (s) => $(s, d);
        const name = q('#ae-n').value.trim(), prompt = q('#ae-d').value.trim();
        if (!name) { toast('先起个名字', 'attn'); q('#ae-n').focus(); return false; }
        if (!prompt) { toast('写一句要做什么', 'attn'); q('#ae-d').focus(); return false; }
        const t = readTrigger(d);
        if (t.type === 'repeat' && t.freq === 'weekly' && !t.days.length) { toast('每周至少选一天', 'attn'); return false; }
        if (t.type === 'file' && !t.exts.length) { toast('至少选一种文件类型', 'attn'); return false; }
        if (t.type === 'once' && !nextRuns(t, 1).length) { toast('一次性运行的时间已经过去了', 'attn'); q('#ae-at').focus(); return false; }
        if (t.type === 'after' && !t.ref) { toast('先建一条其他自动化，才能设为“在它完成后运行”', 'attn'); return false; }
        const ef = q('#ae-e');
        Object.assign(a, {
          name, prompt, proj: q('#ae-p').value, trigger: t,
          agent: q('#ae-a').value, account: q('#ae-acc').value, model: q('#ae-m').value, effort: ef.disabled ? null : ef.value, perm: q('#ae-pm').value,
          rules: { overlap: q('input[name="ae-ov"]:checked').value, missed: q('input[name="ae-ms"]:checked').value, max: q('#ae-mx').value, budget: q('#ae-bg').value },
          notify: q('input[name="ae-nt"]:checked')?.value || 'always', automerge: q('#ae-am').checked,
          warn: q('#ae-a').value === 'codex' ? 'Codex 登录已过期，下次运行会失败' : q('#ae-a').value === 'zcode' ? 'ZCode 还没连接，下次运行会失败' : undefined,
        });
        if (isNew) { Object.assign(a, { id: 'a' + Date.now(), enabled: true, runs: [] }); autos.unshift(a); }
        else Object.assign(src, a);
        selId = a.id; filter = 'all'; renderChips(); render(); window.aicOpenSide();
        const n = t.type === 'file' ? '检测到新文件时运行' : `下次 ${nextText(a)}`;
        toast(`${isNew ? '已创建' : '已保存'}“${esc(name)}”，${esc(n)}`);
      } }],
    });
  };
  const readTrigger = (d) => {
    const q = (s) => $(s, d);
    const type = q('input[name="ae-tt"]:checked').value;
    if (type === 'once') return { type, at: q('#ae-at').value };
    if (type === 'file') return { type, folder: q('#ae-fd').value, exts: $$('[data-tt="file"] .daypick input:checked', d).map((i) => i.value), settle: q('#ae-st').value };
    if (type === 'after') return { type, ref: q('#ae-ref').value, when: q('input[name="ae-when"]:checked').value };
    return { type, freq: q('#ae-f').value, time: q('#ae-t').value || '09:00', days: $$('[data-fq="weekly"] input:checked', d).map((i) => +i.value), mday: q('#ae-md').value, every: +q('#ae-ev').value };
  };

  renderChips(); render();
  // 窄屏下右侧面板默认收起；宽屏打开时显示第一条
  window.aicAutomations = { autos, nextRuns, describe };
})();
