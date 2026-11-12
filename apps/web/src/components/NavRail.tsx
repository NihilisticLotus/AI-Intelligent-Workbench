import { useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react';
import type { ViewItem } from '../state/core';
import { useApp } from '../state/app';
import { clock } from '../lib/format';
import { currentNavigationIndex, navigationItems, navigationKey, navigationMotion } from '../lib/navigation';

export function NavRail({ view, stream, agent, onJump }: { view: ViewItem[]; stream: RefObject<HTMLDivElement | null>; agent: string; onJump: () => void }) {
  const items = useMemo(() => navigationItems(view), [view]);
  const agents = useApp((s) => s.agents);
  const rail = useRef<HTMLElement>(null), flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [current, setCurrent] = useState(-1), [tabKey, setTabKey] = useState<string | null>(null);
  const [peek, setPeek] = useState<{ key: string; top: number } | null>(null);
  const tooltipId = useId();
  const anchors = () => new Map(Array.from(stream.current?.querySelectorAll<HTMLElement>('[data-key]') ?? []).map((el) => [el.dataset.key!, el]));
  useEffect(() => {
    const scroller = stream.current; if (!scroller) return;
    let frame = 0;
    const measure = () => {
      const nodes = anchors(), top = scroller.getBoundingClientRect().top;
      const positions = items.map((item) => (nodes.get(item.key)?.getBoundingClientRect().top ?? top) - top + scroller.scrollTop);
      setCurrent(currentNavigationIndex(positions, scroller.scrollTop, scroller.clientHeight, scroller.scrollHeight));
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    scroller.addEventListener('scroll', schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(scroller); if (scroller.firstElementChild) observer.observe(scroller.firstElementChild);
    schedule();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); scroller.removeEventListener('scroll', schedule); };
  }, [items, stream]);
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);
  if (items.length < 3) return null;
  const who = (item: typeof items[number]) => item.kind === 'user' ? '你' : agents.find((a) => a.kind === (item.agent ?? agent))?.displayName ?? item.agent ?? agent;
  const show = (key: string, button: HTMLButtonElement) => {
    const shell = stream.current?.parentElement; if (!shell) return;
    setPeek({ key, top: Math.max(8, Math.min(shell.clientHeight - 110, button.getBoundingClientRect().top - shell.getBoundingClientRect().top - 30)) });
  };
  const jump = (key: string) => {
    const scroller = stream.current, node = anchors().get(key); if (!scroller || !node) return;
    onJump();
    const motion = navigationMotion(matchMedia('(prefers-reduced-motion: reduce)').matches);
    scroller.scrollTo({ top: scroller.scrollTop + node.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 12, behavior: motion.behavior });
    scroller.querySelectorAll('.nav-flash').forEach((el) => el.classList.remove('nav-flash'));
    if (flashTimer.current) clearTimeout(flashTimer.current);
    if (motion.flash) { node.classList.add('nav-flash'); flashTimer.current = setTimeout(() => node.classList.remove('nav-flash'), 900); }
  };
  const preview = items.find((item) => item.key === peek?.key);
  return <><nav className="nav-rail" aria-label="对话导航：跳到某条消息" ref={rail} onMouseLeave={() => setPeek(null)}
    onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) { setPeek(null); setTabKey(null); } }}>
    {items.map((item, i) => <button key={item.key} type="button" className={`nav-tick ${item.kind}${i === current ? ' current' : ''}`}
      data-nav-key={item.key} aria-label={`${who(item)} · ${clock(item.ts)}：${item.text}${item.kind === 'attn' ? '（待审批）' : ''}`}
      aria-current={i === current ? 'location' : undefined} aria-describedby={peek?.key === item.key ? tooltipId : undefined}
      tabIndex={tabKey ? item.key === tabKey ? 0 : -1 : i === Math.max(0, current) ? 0 : -1}
      onMouseEnter={(e) => show(item.key, e.currentTarget)} onFocus={(e) => { setTabKey(item.key); show(item.key, e.currentTarget); }}
      onClick={() => jump(item.key)} onKeyDown={(e) => {
        if (e.key === 'Escape') { setPeek(null); return; }
        const next = navigationKey(e.key, i, items.length); if (next === null) return;
        e.preventDefault(); rail.current?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
      }}><span /></button>)}
  </nav>{preview && peek ? <div className="nav-peek" role="tooltip" id={tooltipId} style={{ top: peek.top }}><b>{who(preview)}</b><span>{clock(preview.ts)}</span><p>{preview.text}</p></div> : null}</>;
}
