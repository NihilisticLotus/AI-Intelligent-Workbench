// 对话导航条（2026-11-07，ui-design.md 6.14，参照 Codex 对话区左侧的刻度条）。
// 对话区左边一列细刻度：每条你的消息一根长刻度，每轮 Agent 回复一根短刻度，交接、审批单独标记。
// 悬停或聚焦刻度显示这一条的开头和时间，点一下跳过去；滚动时高亮当前看到的那一条。
// 新消息进来自动加刻度。消息少于 3 条时不显示（没什么可跳的）。
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = window.aicEsc || ((s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])));
  const content = $('.content');
  const stream = $('.stream', content || document);
  const inner = $('.stream-inner', stream || document);
  if (!content || !stream || !inner) return;

  content.insertAdjacentHTML('beforeend', '<nav class="nav-rail" aria-label="对话导航：跳到某条消息"></nav><div class="nav-peek" role="tooltip" id="nav-peek" hidden></div>');
  const rail = $('.nav-rail', content);
  const peek = $('#nav-peek', content);

  const clip = (s, n = 60) => { s = (s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
  // 消息头里的时间（头里还可能有模型名，只取像时间的那一段）
  const timeOf = (el) => [...el.querySelectorAll('.head span')].map((s) => s.textContent.trim()).filter((s) => /\d:\d\d/.test(s)).pop() || '';
  // 这一条在刻度条上叫什么、显示什么
  const describe = (el) => {
    if (el.matches('.msg.user')) return { kind: 'user', who: '你', text: clip($('.text', el)?.innerText), time: timeOf(el) };
    if (el.matches('.msg.turn')) {
      const who = el.getAttribute('aria-label')?.replace(/的回复$/, '').trim() || 'Agent';
      const body = $('.answer', el)?.innerText || $$('.text', el).map((x) => x.innerText).join(' ');
      return { kind: $('.approval:not([hidden])', el) ? 'attn' : 'turn', who, text: clip(body) || '正在回复…', time: timeOf(el) };
    }
    if (el.matches('.handoff')) return { kind: 'mark', who: '交接', text: clip(el.innerText, 48), time: '' };
    return null;
  };
  let items = [];
  const build = () => {
    items = $$(':scope > .msg.user, :scope > .msg.turn, :scope > .handoff', inner).map((el) => ({ el, ...describe(el) })).filter((x) => x.kind);
    rail.hidden = items.length < 3;
    rail.innerHTML = items.map((x, i) => `<button type="button" class="tick ${x.kind}" data-wired="1" data-i="${i}" aria-label="${esc(`${x.who}${x.time ? ' · ' + x.time : ''}：${x.text}`)}" aria-describedby="nav-peek"><span></span></button>`).join('');
    mark();
  };

  // 当前位置：可视区顶部往下 1/3 处落在哪一条
  let cur = -1;
  const mark = () => {
    const top = stream.getBoundingClientRect().top + stream.clientHeight / 3;
    let i = 0;
    items.forEach((x, j) => { if (x.el.getBoundingClientRect().top <= top) i = j; });
    if (stream.scrollTop + stream.clientHeight >= stream.scrollHeight - 4) i = items.length - 1; // 到底了就是最后一条
    if (i === cur && rail.querySelector('.tick.cur')) return;
    cur = i;
    $$('.tick', rail).forEach((b, j) => { b.classList.toggle('cur', j === i); if (j === i) b.setAttribute('aria-current', 'location'); else b.removeAttribute('aria-current'); });
  };

  const show = (b) => {
    const x = items[+b.dataset.i]; if (!x) return;
    peek.innerHTML = `<b>${esc(x.who)}</b>${x.time ? `<span class="tm">${esc(x.time)}</span>` : ''}<p>${esc(x.text)}</p>`;
    peek.hidden = false;
    const r = b.getBoundingClientRect(), c = content.getBoundingClientRect();
    peek.style.left = (r.right - c.left + 10) + 'px';
    peek.style.top = Math.max(8, Math.min(c.height - peek.offsetHeight - 8, r.top - c.top + r.height / 2 - peek.offsetHeight / 2)) + 'px';
  };
  const hide = () => { peek.hidden = true; };
  rail.addEventListener('mouseover', (e) => { const b = e.target.closest('.tick'); if (b) show(b); });
  rail.addEventListener('mouseleave', hide);
  rail.addEventListener('focusin', (e) => { const b = e.target.closest('.tick'); if (b) show(b); });
  rail.addEventListener('focusout', hide);
  rail.addEventListener('click', (e) => {
    const b = e.target.closest('.tick'); if (!b) return;
    const x = items[+b.dataset.i];
    x?.el.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    x?.el.classList.add('nav-flash'); setTimeout(() => x?.el.classList.remove('nav-flash'), 900);
  });
  // 上下方向键在刻度之间移动
  rail.addEventListener('keydown', (e) => {
    const b = e.target.closest('.tick'); if (!b) return;
    const ticks = $$('.tick', rail), i = ticks.indexOf(b);
    const to = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? ticks.length - 1 : null;
    if (to == null) { if (e.key === 'Escape') hide(); return; }
    e.preventDefault(); ticks[Math.max(0, Math.min(ticks.length - 1, to))].focus();
  });

  let raf = 0;
  stream.addEventListener('scroll', () => { hide(); cancelAnimationFrame(raf); raf = requestAnimationFrame(mark); }, { passive: true });
  // 新消息、回复内容变化（流式输出、审批出现/消失）时重建，合并到一帧
  let pend = 0;
  new MutationObserver(() => { clearTimeout(pend); pend = setTimeout(build, 200); }).observe(inner, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  build();
})();
