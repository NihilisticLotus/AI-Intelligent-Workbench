import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

/** 起始页胶囊：再次点击关闭，选中项打勾；菜单支持方向键、Home / End 和 Esc。 */
export function NewTaskMenu({ label, icon, disabled, options }: {
  label: string; icon: string; disabled?: boolean;
  options: Array<{ id: string; label: string; selected?: boolean; disabled?: boolean; onSelect: () => void }>;
}) {
  const id = useId(), anchor = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false), [position, setPosition] = useState({ left: 8, top: 8 });
  const close = () => { setOpen(false); anchor.current?.focus(); };
  useLayoutEffect(() => {
    if (!open || !menu.current || !anchor.current) return;
    const place = () => {
      const a = anchor.current!.getBoundingClientRect(), m = menu.current!;
      setPosition({ left: Math.max(8, Math.min(a.left, innerWidth - m.offsetWidth - 8)), top: Math.max(8, Math.min(a.bottom + 4, innerHeight - m.offsetHeight - 8)) });
    };
    place(); (menu.current.querySelector<HTMLButtonElement>('button[aria-checked="true"]:not(:disabled)') ?? menu.current.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus();
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => { if (!menu.current?.contains(e.target as Node) && !anchor.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [open]);
  return <div className="nt-menu">
    <button ref={anchor} type="button" className="nt-chip" disabled={disabled} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)}><Icon name={icon} /><span>{label}</span><Icon name="down" /></button>
    {open ? <div id={id} ref={menu} className="menu nt-menu-options" role="menu" aria-label={label} style={position} onKeyDown={(e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === 'Tab') setOpen(false);
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        e.preventDefault(); const buttons = [...menu.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')], i = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const index = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length;
        buttons[index]?.focus();
      }
    }}>{options.length ? options.map((option) => <button key={option.id} type="button" role="menuitemradio" aria-checked={!!option.selected} disabled={option.disabled} onClick={() => { close(); option.onSelect(); }}><span>{option.label}</span>{option.selected ? <Icon name="check" /> : null}</button>) : <p className="picker-hint">还没有保存常用环境，可在任务右侧的“详细 → 环境”中保存。</p>}</div> : null}
  </div>;
}
