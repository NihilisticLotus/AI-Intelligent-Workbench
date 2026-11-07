// 输入框附件：Ctrl+V 粘贴图片、拖入文件、点“+”选择文件（2026-11-07 用户要求，ui-design.md 6.16）。
// 对话输入框和新建任务起始页共用。图片在输入框里显示缩略图（点开看大图，× 删除），发送时随消息一起发出。
// 当前 Agent · 模型看不了图片时立即警告：输入框里一条琥珀提示，给出 [换成能看图的模型] 和 [去掉图片]；
// 不处理就发送会被拦下，不会悄悄把图片丢掉。之后再换模型，提示随之更新。
// 能不能看图：正式版来自 ACP initialize 的 promptCapabilities.image（Agent 级），模型级的差别来自 Agent 报告的模型信息；
// 拿不到时按“未确认”提示。下面是原型示例数据。
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const ic = (n) => `<svg class="i" aria-hidden="true"><use href="#i-${n}"/></svg>`;
  const esc = (s) => (window.aicEsc ? window.aicEsc(s) : String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])));
  const toast = (...a) => window.aicToast?.(...a);

  // true 能看图，false 不能，null 未确认
  const VISION = {
    claude: { 'Opus 5.5': true, 'Sonnet 5': true },
    codex: { 'gpt-5.5-codex': true },
    codebuddy: { 'glm-5.1': false, 'kimi-k2.5': true, 'minimax-m2.7': false, 'deepseek-v3-2': false },
    workbuddy: {},
    zcode: { 'glm-5.1': false },
  };
  const vision = (agent, model) => { const v = VISION[agent]?.[model]; return v === undefined ? null : v; };
  // 推荐一个能看图的替代：先找同一个 Agent 的其他模型（会话内切换，无损），再找别的 Agent（发送时交接）
  const alternative = (agent) => {
    const A = window.aicAgents || {};
    const same = (A[agent]?.[1] || []).find((m) => vision(agent, m));
    if (same) return { agent, model: same, handoff: false };
    for (const k of ['claude', 'codex', 'codebuddy']) {
      if (k === agent || window.aicAgentStatus?.[k] === '登录已过期') continue;
      const m = (A[k]?.[1] || []).find((x) => vision(k, x));
      if (m) return { agent: k, model: m, handoff: true };
    }
    return null;
  };
  window.aicVision = vision;

  const MAX = 10, MAX_MB = 20;
  const fmt = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
  let seq = 0;

  // box：输入框外层；opts：{ textarea, pickBtn, target() → {agent, model}, switchTo(agent, model), onChange() }
  window.aicAttach = (box, opts) => {
    const ta = opts.textarea;
    const items = []; // { id, file, url, img }
    ta.insertAdjacentHTML('beforebegin', '<div class="att-warn" role="alert" hidden></div><div class="att-tray" aria-label="附件"></div>');
    const warn = ta.previousElementSibling.previousElementSibling, tray = ta.previousElementSibling;
    const input = document.createElement('input');
    input.type = 'file'; input.multiple = true; input.hidden = true;
    box.appendChild(input);

    const imgs = () => items.filter((x) => x.img);
    const state = () => {
      const t = opts.target(), v = vision(t.agent, t.model);
      return { t, v, name: `${window.aicAgents?.[t.agent]?.[0] || t.agent} · ${t.model}` };
    };
    // 返回 true 表示可以发送
    const refresh = () => {
      const n = imgs().length, { t, v, name } = state();
      const bad = n > 0 && v !== true;
      box.classList.toggle('att-bad', bad);
      $$('.att-item.img', tray).forEach((el) => el.classList.toggle('bad', bad));
      if (!bad) { warn.hidden = true; warn.innerHTML = ''; return true; }
      const alt = alternative(t.agent);
      warn.innerHTML = `${ic('warn')}<span>${v === false ? `<b>${esc(name)} 看不了图片</b>，这 ${n} 张图片发过去它收不到。` : `<b>${esc(name)} 没有报告能不能看图片</b>，这 ${n} 张图片它可能收不到。`}</span>
        <span class="grow"></span>
        ${alt ? `<button type="button" class="btn sm" data-wired="1" data-att="alt" data-a="${alt.agent}" data-m="${esc(alt.model)}">换成 ${esc(alt.agent === t.agent ? alt.model : `${window.aicAgents[alt.agent][0]} · ${alt.model}`)}${alt.handoff ? '（发送时交接）' : ''}</button>` : ''}
        <button type="button" class="btn sm ghost" data-wired="1" data-att="drop-imgs">去掉图片</button>
        ${v === null ? '<button type="button" class="btn sm ghost" data-wired="1" data-att="force">仍然发送</button>' : ''}`;
      warn.hidden = false;
      return v === null && warn.dataset.force === '1';
    };
    const render = () => {
      tray.innerHTML = items.map((x) => x.img
        ? `<div class="att-item img" data-id="${x.id}"><button type="button" class="att-thumb" data-wired="1" data-att="view" aria-label="查看大图：${esc(x.file.name)}"><img src="${x.url}" alt=""></button>
            <span class="att-meta"><span class="nm" title="${esc(x.file.name)}">${esc(x.file.name)}</span><span class="sz">${fmt(x.file.size)}</span></span>
            <button type="button" class="att-x" data-wired="1" data-att="rm" aria-label="移除 ${esc(x.file.name)}">${ic('x')}</button></div>`
        : `<div class="att-item file" data-id="${x.id}">${ic('file')}<span class="att-meta"><span class="nm" title="${esc(x.file.name)}">${esc(x.file.name)}</span><span class="sz">${fmt(x.file.size)}</span></span>
            <button type="button" class="att-x" data-wired="1" data-att="rm" aria-label="移除 ${esc(x.file.name)}">${ic('x')}</button></div>`).join('');
      tray.hidden = !items.length;
      warn.dataset.force = '';
      refresh();
      opts.onChange?.();
    };
    const addFiles = (files, how) => {
      let added = 0, skipped = [];
      for (const f of files) {
        if (items.length >= MAX) { skipped.push(`最多 ${MAX} 个附件`); break; }
        if (f.size > MAX_MB * 1048576) { skipped.push(`${f.name} 超过 ${MAX_MB} MB`); continue; }
        const img = /^image\//.test(f.type);
        // 粘贴的截图没有文件名，按时间起一个
        const file = img && (!f.name || f.name === 'image.png') ? new File([f], `截图-${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type }) : f;
        items.push({ id: 'a' + (++seq), file, img, url: img ? URL.createObjectURL(file) : null });
        added++;
      }
      if (!added && !skipped.length) return;
      render();
      if (skipped.length) toast(`有附件没加上：${esc(skipped.join('；'))}`, 'attn');
      const { v, name } = state();
      // 及时警告：加图片的那一刻就说
      if (imgs().length && v === false) toast(`${esc(name)} 看不了图片。可以换个能看图的模型，或者去掉图片`, 'attn');
      else if (added && how === 'paste') toast(`已粘贴 ${added} 张图片`);
    };

    // Ctrl+V：剪贴板里有图片就加为附件；同时有文字时文字照常粘贴
    ta.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.items || [])].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean);
      if (!files.length) return;
      if (!e.clipboardData.getData('text/plain')) e.preventDefault();
      addFiles(files, 'paste');
    });
    // 拖入
    let depth = 0;
    box.addEventListener('dragenter', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { depth++; box.classList.add('att-drag'); } });
    box.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; box.classList.remove('att-drag'); } });
    box.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); });
    box.addEventListener('drop', (e) => {
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault(); depth = 0; box.classList.remove('att-drag');
      addFiles([...e.dataTransfer.files], 'drop');
    });
    // “+” 选择文件
    opts.pickBtn?.addEventListener('click', (e) => { e.stopImmediatePropagation(); input.click(); }, true);
    input.addEventListener('change', () => { addFiles([...input.files], 'pick'); input.value = ''; });

    box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-att]'); if (!b || !box.contains(b)) return;
      const a = b.dataset.att, id = b.closest('.att-item')?.dataset.id, it = items.find((x) => x.id === id);
      if (a === 'rm' && it) { URL.revokeObjectURL(it.url); items.splice(items.indexOf(it), 1); render(); ta.focus(); }
      else if (a === 'view' && it) window.aicModal?.({ title: esc(it.file.name), wide: true, body: `<img class="att-big" src="${it.url}" alt="${esc(it.file.name)}"><p class="att-cap">${fmt(it.file.size)} · ${esc(it.file.type || '图片')}</p>`, actions: [{ label: '关闭' }] });
      else if (a === 'alt') { opts.switchTo?.(b.dataset.a, b.dataset.m); setTimeout(refresh); ta.focus(); }
      else if (a === 'drop-imgs') { imgs().forEach((x) => { URL.revokeObjectURL(x.url); items.splice(items.indexOf(x), 1); }); render(); toast('已去掉图片'); ta.focus(); }
      else if (a === 'force') { warn.dataset.force = '1'; warn.hidden = true; toast('好的，图片照常发送；如果 Agent 收不到，会在回复里说明'); ta.focus(); }
    });

    document.addEventListener('aic-model-change', refresh);
    return {
      refresh,
      count: () => items.length,
      // 发送前调用：模型看不了图片时拦下并突出提示，返回 null；否则取走附件并清空
      take() {
        if (imgs().length && !refresh()) {
          warn.classList.remove('att-shake'); void warn.offsetWidth; warn.classList.add('att-shake');
          $('button', warn)?.focus();
          toast('先处理图片：换成能看图的模型，或者去掉图片', 'attn');
          return null;
        }
        const out = items.splice(0).map((x) => ({ name: x.file.name, size: x.file.size, img: x.img, url: x.url }));
        render();
        return out;
      },
    };
  };

  // 用户消息里的附件（图片缩略图，点开看大图）
  window.aicAttachHtml = (list) => (list?.length ? `<div class="msg-atts">${list.map((x) => x.img
    ? `<button type="button" class="msg-att img" data-wired="1" data-url="${x.url}" data-name="${esc(x.name)}" aria-label="查看大图：${esc(x.name)}"><img src="${x.url}" alt=""></button>`
    : `<span class="attach">${ic('file')}${esc(x.name)}<span class="mono" style="font-size:12px">${fmt(x.size)}</span></span>`).join('')}</div>` : '');
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.msg-att.img'); if (!b) return;
    window.aicModal?.({ title: esc(b.dataset.name), wide: true, body: `<img class="att-big" src="${b.dataset.url}" alt="${esc(b.dataset.name)}">`, actions: [{ label: '关闭' }] });
  });
})();
