// 当前运行环境的 Platform。以后桌面 / 手机外壳在启动前替换这里的实现即可。
import { createBrowserPlatform } from './browser';
import type { Platform } from './types';

export type { Platform, PickedFolder, SecureStorage } from './types';

export const platform: Platform = createBrowserPlatform(import.meta.env.VITE_AIC_BASE_URL ?? '');
