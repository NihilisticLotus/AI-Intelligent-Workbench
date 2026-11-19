import { describe, expect, it } from 'vitest';
import { mobileViewport } from './mobile-viewport';

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
});
