// 图标：沿用原型 app.js 的线条图标（24×24，描边 1.6）。只收录 1.1 用到的。
const P: Record<string, string> = {
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
  cube: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>',
  bot: '<rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01"/>',
  gear: '<path d="M10.3 3h3.4l.5 2.4 1.7.9 2.2-1 2.4 2.4-1 2.2.9 1.7 2.4.5v3.4l-2.4.5-.9 1.7 1 2.2-2.4 2.4-2.2-1-1.7.9-.5 2.4h-3.4l-.5-2.4-1.7-.9-2.2 1-2.4-2.4 1-2.2-.9-1.7L3 13.7v-3.4l2.4-.5.9-1.7-1-2.2 2.4-2.4 2.2 1 1.7-.9z"/><circle cx="12" cy="12" r="3"/>',
  moon: '<path d="M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  right: '<path d="M9 6l6 6-6 6"/>',
  up: '<path d="M6 15l6-6 6 6"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  warn: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/>',
  shield: '<path d="M12 3l8 3v6c0 5-4 8-8 9-4-1-8-4-8-9V6z"/>',
  shieldcheck: '<path d="M12 3l8 3v6c0 5-4 8-8 9-4-1-8-4-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
  unlock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 017.5-2"/>',
  refresh: '<path d="M20 11a8 8 0 00-14.5-4.5L4 8M4 4v4h4M4 13a8 8 0 0014.5 4.5L20 16M20 20v-4h-4"/>',
  clip: '<path d="M20 11l-8.5 8.5a5 5 0 01-7-7L13 4a3.5 3.5 0 015 5l-8.5 8.5a2 2 0 01-3-3L14 7"/>',
  send: '<path d="M4 12l16-8-6 16-2-6z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  grid: '<path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  folder: '<path d="M3 6h6l2 2h10v11H3z"/>',
  drive: '<rect x="3" y="7" width="18" height="10" rx="2"/><path d="M7 12h.01M11 12h6"/>',
  home: '<path d="M4 11l8-7 8 7v9H4z"/><path d="M10 20v-5h4v5"/>',
  branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7v10M18 10c0 5-8 3-11 7"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  devices: '<rect x="3" y="5" width="13" height="10" rx="1"/><path d="M7 19h5"/><rect x="17" y="9" width="4" height="10" rx="1"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3"/>',
  bulb: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 00-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0012 3z"/>',
  wand: '<path d="M4 20L15 9M13 7l4 4"/><path d="M18 3v3M16.5 4.5h3M7 4v2M6 5h2M20 13v2M19 14h2"/>',
  auto: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M9 2h6M19 5l1.5-1.5"/>',
  chart: '<path d="M4 20h16M7 16v-5M12 16V6M17 16v-8"/>',
  plug: '<path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 01-12 0zM12 17v4"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>',
};

export type IconName = keyof typeof P | string;

export function Icon({ name, className, size }: { name: IconName; className?: string; size?: number }) {
  const body = P[name] ?? P.info!;
  return (
    <svg
      className={'i' + (className ? ' ' + className : '')}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      style={size ? { width: size, height: size } : undefined}
      // 图标内容是上面写死的常量，不含外部数据
      dangerouslySetInnerHTML={{ __html: body }}
    />
  );
}
