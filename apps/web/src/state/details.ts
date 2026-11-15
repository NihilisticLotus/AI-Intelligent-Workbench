import { setPref, prefsStore } from './prefs';
import { createStore } from './store';
import type { DetailSection } from '../lib/details';

export const detailFocus = createStore<{ section: DetailSection; sequence: number } | null>(null);
let sequence = 0;
export function openDetail(section: DetailSection) {
  setPref('sideTab', 'plan'); setPref('sideOpen', true);
  const opened = prefsStore.get().detailOpen;
  if (!opened.includes(section)) setPref('detailOpen', [...opened, section]);
  detailFocus.set(() => ({ section, sequence: ++sequence }));
}

export const changeFocus = createStore<string | null>(null);
export function openChanges(path: string) {
  setPref('sideTab', 'diff'); setPref('sideOpen', true); changeFocus.set(() => path);
}
