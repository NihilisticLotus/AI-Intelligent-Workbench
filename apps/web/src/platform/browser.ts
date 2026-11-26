// 浏览器版 Platform 实现。
import type { PickedFolder, Platform } from './types';

/** 选文件夹对话框由 React 层注册（见 components/FolderPicker.tsx），这里只做桥接 */
type FolderPickerHost = () => Promise<PickedFolder | null>;
let folderHost: FolderPickerHost | null = null;
export function registerFolderPicker(host: FolderPickerHost | null) { folderHost = host; }
let workspaceHost:((taskId:string)=>Promise<void>)|null=null;
export function registerWorkspaceOpener(host:(taskId:string)=>Promise<void>){workspaceHost=host;}

const PREFIX = 'aic.';
const ls = {
  get(k: string): string | null { try { return localStorage.getItem(PREFIX + k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(PREFIX + k, v); } catch { /* 隐私模式等情况下忽略 */ } },
  remove(k: string) { try { localStorage.removeItem(PREFIX + k); } catch { /* 忽略 */ } },
};

type Notice = Parameters<Platform['notify']>[0];
let noticeHost: ((notice: Notice) => void) | undefined;
let audio: AudioContext | undefined;
let titleBefore: string | undefined;
let titleTimer: ReturnType<typeof setInterval> | undefined;

export function canUseSystemNotifications(secure: boolean, available: boolean): boolean {
  return secure && available;
}

export function installBrowserNotices(host: (notice: Notice) => void) {
  noticeHost = host;
  const unlock = () => {
    if (ls.get('notificationSound') === 'false') return;
    const Audio = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Audio || audio?.state === 'running') return;
    try { audio ??= new Audio(); void audio.resume().catch(() => {}); } catch { /* 浏览器可能禁用音频 */ }
  };
  document.addEventListener('pointerdown', unlock);
  document.addEventListener('keydown', unlock);
  window.addEventListener('focus', resetNoticeTitle);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') resetNoticeTitle(); });
}

function resetNoticeTitle() {
  if (titleTimer !== undefined) clearInterval(titleTimer);
  titleTimer = undefined;
  if (titleBefore !== undefined) document.title = titleBefore;
  titleBefore = undefined;
}

function fallbackNotice(notice: Notice, foreground: boolean) {
  noticeHost?.(notice);
  if (!foreground && titleBefore === undefined) {
    titleBefore = document.title;
    const alertTitle = `有待处理事项 · ${titleBefore}`;
    document.title = alertTitle;
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      titleTimer = setInterval(() => { document.title = document.title === alertTitle ? titleBefore ?? '' : alertTitle; }, 1300);
    }
  }
  if (!audio || audio.state !== 'running' || ls.get('notificationSound') === 'false') return;
  const tone = audio.createOscillator();
  const gain = audio.createGain();
  const time = audio.currentTime;
  tone.frequency.value = 660;
  gain.gain.setValueAtTime(0.045, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.14);
  tone.connect(gain);
  gain.connect(audio.destination);
  tone.onended = () => { tone.disconnect(); gain.disconnect(); };
  tone.start(time);
  tone.stop(time + 0.14);
}

export function createBrowserPlatform(baseUrl = ''): Platform {
  return {
    kind: 'browser',
    baseUrl,
    tokenDelivery: 'cookie',
    async notify(notice) {
      if (typeof window === 'undefined' || typeof document === 'undefined') return;
      const foreground = document.visibilityState === 'visible' && document.hasFocus();
      if (canUseSystemNotifications(window.isSecureContext, typeof Notification !== 'undefined')) {
        if (foreground) return;
        try {
          if (Notification.permission === 'default') await Notification.requestPermission();
          if (Notification.permission === 'granted') {
            const notification = new Notification(notice.title, { body: notice.body, tag: notice.tag });
            notification.onclick = () => { window.focus(); notice.onClick?.(); notification.close(); };
            return;
          }
        } catch { /* 权限或浏览器限制时走页面提醒 */ }
      }
      fallbackNotice(notice, foreground);
    },
    pickFolder() {
      if (!folderHost) return Promise.resolve(null);
      return folderHost();
    },
    canOpenInIde: false,
    async openWorkspace(taskId) {if(!workspaceHost)throw new Error('工作副本入口尚未就绪');await workspaceHost(taskId);},
    async openInIde() {
      throw new Error('浏览器里不能直接打开 IDE，桌面版提供');
    },
    async openExternal(url) {
      // 仅允许 http / https 绝对地址，禁止 javascript: / file: / 相对路径跳转
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
        window.open(parsed.toString(), '_blank', 'noopener,noreferrer');
        return true;
      } catch { return false; }
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
