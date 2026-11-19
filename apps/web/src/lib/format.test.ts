import { describe, expect, it } from 'vitest';
import { guessDeviceName } from './format';

describe('配对设备名称', () => {
  it('回环与局域网设备使用各自的名称', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0) Chrome/157.0 Safari/537.36';
    expect(guessDeviceName(ua)).toBe('Chrome 浏览器（本机）');
    expect(guessDeviceName(ua, 'lan')).toBe('Chrome 浏览器');
    expect(guessDeviceName('', 'lan')).toBe('浏览器');
  });

  it('区分 iOS 上的 Chrome 与 Safari', () => {
    expect(guessDeviceName('Mozilla/5.0 (iPhone) CriOS/157.0 Mobile Safari/604.1', 'lan')).toBe('iPhone · Chrome 浏览器');
    expect(guessDeviceName('Mozilla/5.0 (iPad) Version/18.0 Mobile Safari/604.1', 'lan')).toBe('iPad · Safari 浏览器');
  });

  it('从 Android Edge 的浏览器标识中提取 Edge', () => {
    expect(guessDeviceName('Mozilla/5.0 (Linux; Android 15) Chrome/157.0 Safari/537.36 EdgA/157.0', 'lan')).toBe('Android · Edge 浏览器');
  });
});
