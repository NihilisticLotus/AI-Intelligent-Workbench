// 浏览器版 Platform 实现。
import type { PickedFolder, Platform } from './types';

/** 选文件夹对话框由 React 层注册（见 components/FolderPicker.tsx），这里只做桥接 */
type FolderPickerHost = () => Promise<PickedFolder | null>;
let folderHost: FolderPickerHost | null = null;
export function registerFolderPicker(host: FolderPickerHost | null) { folderHost = host; }

const PREFIX = 'aic.';
const ls = {
  get(k: string): string | null { try { return localStorage.getItem(PREFIX + k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(PREFIX + k, v); } catch { /* 隐私模式等情况下忽略 */ } },
  remove(k: string) { try { localStorage.removeItem(PREFIX + k); } catch { /* 忽略 */ } },
};

export function createBrowserPlatform(baseUrl = ''): Platform {
  return {
    kind: 'browser',
    baseUrl,
    tokenDelivery: 'cookie',
    async notify({ title, body, tag, onClick }) {
      if (typeof Notification === 'undefined') return;
      // 页面在前台时不弹系统通知，界面里已经能看到
      if (document.visibilityState === 'visible' && document.hasFocus()) return;
      try {
        if (Notification.permission === 'default') await Notification.requestPermission();
        if (Notification.permission !== 'granted') return;
        const n = new Notification(title, { body, tag });
        n.onclick = () => { window.focus(); onClick?.(); n.close(); };
      } catch { /* 忽略 */ }
    },
    pickFolder() {
      if (!folderHost) return Promise.resolve(null);
      return folderHost();
    },
    canOpenInIde: false,
    async openInIde() {
      throw new Error('浏览器里不能直接打开 IDE，桌面版提供');
    },
    async openExternal(url) {
      // 带 noopener 时 window.open 总是返回 null，拿不到“是否被拦截”，只能认为已打开
      try { window.open(url, '_blank', 'noopener,noreferrer'); return true; } catch { return false; }
    },
    async copyText(text) {
      try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
    },
    prefs: { get: ls.get, set: ls.set },
    secureStorage: {
      secure: false,
      async get(k) { return ls.get('s.' + k); },
      async set(k, v) { ls.set('s.' + k, v); },
      async remove(k) { ls.remove('s.' + k); },
    },
  };
}
