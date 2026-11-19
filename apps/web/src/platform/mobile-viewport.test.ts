import { afterEach, describe, expect, it, vi } from 'vitest';
import { installMobileViewport, mobileViewport } from './mobile-viewport';

describe('移动浏览器可视视口', () => {
  const portrait = { layoutHeight: 812, visibleHeight: 812, offsetTop: 0, scale: 1, restingHeight: 812, editing: true };

  it('iOS 风格的键盘收缩和视口移动保留可见区', () => {
    expect(mobileViewport({ ...portrait, visibleHeight: 338.3, offsetTop: 39.7 })).toEqual({ height: 338, top: 40, keyboard: true });
  });

  it('Chrome 内容视口同步缩短时也能识别打开的键盘', () => {
    expect(mobileViewport({ ...portrait, layoutHeight: 310, visibleHeight: 310 })).toEqual({ height: 310, top: 0, keyboard: true });
  });

  it('浏览器工具条及横屏旋转不误作键盘', () => {
    expect(mobileViewport({ ...portrait, visibleHeight: 741 })?.keyboard).toBe(false);
    expect(mobileViewport({ ...portrait, layoutHeight: 375, visibleHeight: 375, restingHeight: 375 })?.keyboard).toBe(false);
    expect(mobileViewport({ ...portrait, visibleHeight: 310, editing: false })?.keyboard).toBe(false);
  });

  it('保留双指缩放，不将其当成键盘', () => {
    expect(mobileViewport({ ...portrait, scale: 1.5, visibleHeight: 400 })).toBeNull();
  });

  describe('安装到页面', () => {
    afterEach(() => vi.unstubAllGlobals());

    function install(coarse: boolean) {
      const attrs = new Set<string>();
      const props = new Map<string, string>();
      const listeners: Array<() => void> = [];
      const viewport = { height: 812, offsetTop: 0, scale: 1, addEventListener: (_: string, run: () => void) => listeners.push(run) };
      vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('coarse') ? coarse : true, addEventListener: () => {} }));
      vi.stubGlobal('innerWidth', 1000);
      vi.stubGlobal('innerHeight', 812);
      vi.stubGlobal('requestAnimationFrame', (run: () => void) => { run(); return 0; });
      vi.stubGlobal('window', { visualViewport: viewport, addEventListener: () => {} });
      vi.stubGlobal('document', {
        activeElement: { matches: () => true }, addEventListener: () => {},
        documentElement: {
          dataset: {}, style: { setProperty: (k: string, v: string) => props.set(k, v), removeProperty: (k: string) => props.delete(k) },
          toggleAttribute: (name: string, on: boolean) => { if (on) attrs.add(name); else attrs.delete(name); },
        },
      });
      installMobileViewport();
      return {
        attrs, props,
        shrink(height: number) { viewport.height = height; vi.stubGlobal('innerHeight', height); listeners.forEach((run) => run()); },
      };
    }

    it('触屏输入时高度收缩识别为键盘', () => {
      const page = install(true);
      page.shrink(400);
      expect(page.attrs.has('data-keyboard')).toBe(true);
    });

    it('桌面小窗口在输入时缩短高度，不进入键盘模式', () => {
      const page = install(false);
      page.shrink(400);
      expect(page.attrs.has('data-keyboard')).toBe(false);
      expect(page.props.get('--visible-height')).toBe('400px');
    });
  });
});
