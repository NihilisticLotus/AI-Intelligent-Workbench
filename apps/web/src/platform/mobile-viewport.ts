const mobileWidth = '(max-width: 1279px)';
export const compactPickerQuery = '(max-width: 767px), (max-width: 1279px) and (pointer: coarse)';

export function mobileViewport({ layoutHeight, visibleHeight, offsetTop, scale, restingHeight, editing }: {
  layoutHeight: number; visibleHeight: number; offsetTop: number; scale: number; restingHeight: number; editing: boolean;
}): { height: number; top: number; keyboard: boolean } | null {
  if (Math.abs(scale - 1) > .01) return null;
  const height = Math.min(layoutHeight, visibleHeight);
  const keyboard = editing && Math.max(restingHeight, layoutHeight) - height >= 120;
  return { height: Math.round(height), top: keyboard ? Math.round(offsetTop) : 0, keyboard };
}

export function installMobileViewport() {
  const width = matchMedia(mobileWidth);
  // 只有触屏设备会弹软键盘；桌面小窗口在输入时调整窗口高度不能当成键盘。
  const touch = matchMedia('(pointer: coarse)');
  const viewport = window.visualViewport;
  const root = document.documentElement;
  let previousWidth = 0;
  let restingHeight = 0;
  let frame = 0;
  const update = () => {
    frame = 0;
    if (!width.matches || !viewport) {
      root.style.removeProperty('--visible-height');
      root.style.removeProperty('--visible-top');
      delete root.dataset.keyboard;
      previousWidth = restingHeight = 0;
      return;
    }
    if (previousWidth !== innerWidth) {
      previousWidth = innerWidth;
      restingHeight = innerHeight;
    }
    const editing = touch.matches && !!document.activeElement?.matches('textarea, input:not([readonly]):not([type=radio]):not([type=checkbox]):not([type=button]):not([type=file]), [contenteditable=true]');
    const next = mobileViewport({ layoutHeight: innerHeight, visibleHeight: viewport.height, offsetTop: viewport.offsetTop, scale: viewport.scale, restingHeight, editing });
    if (!next) return;
    if (!editing || next.height > restingHeight) restingHeight = next.height;
    root.style.setProperty('--visible-height', `${next.height}px`);
    root.style.setProperty('--visible-top', `${next.top}px`);
    root.toggleAttribute('data-keyboard', next.keyboard);
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
  width.addEventListener('change', schedule);
  window.addEventListener('resize', schedule);
  document.addEventListener('focusin', schedule);
  document.addEventListener('focusout', schedule);
  viewport?.addEventListener('resize', schedule);
  viewport?.addEventListener('scroll', schedule);
  update();
}
