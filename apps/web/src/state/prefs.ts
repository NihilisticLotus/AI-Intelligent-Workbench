// 本机偏好：只存在这台设备上，不需要服务端接口（ui-design.md 10.13）。
import { platform } from '../platform';
import { createStore, useStore } from './store';
import { defaultDetailSections, validDetailSections, type DetailSection } from '../lib/details';

export type Theme = 'dark' | 'light';
export type ThoughtMode = 'collapsed' | 'expanded' | 'hidden';
export type SideTab = 'plan' | 'diff';

export interface Prefs {
  theme: Theme;
  thought: ThoughtMode;
  sidebarCollapsed: boolean;
  /** 侧栏任务归类：按项目 / 按分组 */
  sbView: 'project' | 'group';
  /** 折叠了的项目或分组，键形如 'p:项目id' 'g:分组id' 'g:none' */
  collapsed: string[];
  sideOpen: boolean;
  sideWidth: number;
  sideTab: SideTab;
  detailOpen: DetailSection[];
}

const defaults: Prefs = {
  theme: 'dark', thought: 'collapsed', sidebarCollapsed: false, sbView: 'project', collapsed: [],
  sideOpen: true, sideWidth: 440, sideTab: 'plan',
  detailOpen: [...defaultDetailSections],
};

function load(): Prefs {
  const out: Record<string, unknown> = { ...defaults };
  for (const k of Object.keys(defaults)) {
    const raw = platform.prefs.get(k);
    if (raw === null) continue;
    try {
      const v = JSON.parse(raw);
      if (typeof v === typeof (defaults as unknown as Record<string, unknown>)[k]) out[k] = v;
    } catch { /* 坏数据用默认值 */ }
  }
  // 中屏第一次打开时侧栏默认折叠、右侧面板默认收起
  if (typeof matchMedia !== 'undefined' && matchMedia('(max-width: 1279px)').matches) {
    if (platform.prefs.get('sidebarCollapsed') === null) out.sidebarCollapsed = true;
    out.sideOpen = false;
  }
  out.detailOpen = validDetailSections(out.detailOpen);
  return out as unknown as Prefs;
}

export const prefsStore = createStore<Prefs>(load());

export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]) {
  prefsStore.set((p) => (p[key] === value ? p : { ...p, [key]: value }));
  platform.prefs.set(key, JSON.stringify(value));
  if (key === 'theme') document.documentElement.dataset.theme = value as string;
}

export const usePref = <K extends keyof Prefs>(key: K): Prefs[K] => useStore(prefsStore, (p) => p[key]);

export function applyThemeNow() {
  document.documentElement.dataset.theme = prefsStore.get().theme;
}
