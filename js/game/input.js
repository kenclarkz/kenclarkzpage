// Swipe and keyboard input.
//
// Pointer Events, not Touch Events: one code path covers phone touches, a
// desktop mouse, and Playwright's page.mouse — so the headless smoke test
// drives the exact same handler that ships.

export const LEFT = 'left';
export const RIGHT = 'right';
export const UP = 'up';
export const DOWN = 'down';
export const TAP = 'tap';
export const PAUSE = 'pause';

const SWIPE_PX = 30; // fire as soon as a drag crosses this
const TAP_PX = 12;
const TAP_MS = 250;

export function attachInput(element, emit) {
  let active = false;
  let consumed = false;
  let startX = 0;
  let startY = 0;
  let startT = 0;
  let pointerId = null;

  function onDown(e) {
    if (active) return;
    active = true;
    consumed = false;
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    startT = performance.now();
    if (element.setPointerCapture) {
      try {
        element.setPointerCapture(e.pointerId);
      } catch {
        /* capture is a nicety; ignore browsers that refuse */
      }
    }
  }

  function onMove(e) {
    if (!active || consumed || e.pointerId !== pointerId) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_PX) return;
    // Firing here rather than waiting for pointerup is the difference between
    // the controls feeling crisp and feeling broken.
    consumed = true;
    if (Math.abs(dx) > Math.abs(dy)) emit(dx > 0 ? RIGHT : LEFT);
    else emit(dy > 0 ? DOWN : UP);
  }

  function onUp(e) {
    if (!active || e.pointerId !== pointerId) return;
    if (!consumed) {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.hypot(dx, dy) < TAP_PX && performance.now() - startT < TAP_MS) emit(TAP);
    }
    active = false;
    consumed = false;
    pointerId = null;
  }

  function onCancel() {
    active = false;
    consumed = false;
    pointerId = null;
  }

  const opts = { passive: false };
  element.addEventListener('pointerdown', onDown, opts);
  element.addEventListener('pointermove', onMove, opts);
  element.addEventListener('pointerup', onUp, opts);
  element.addEventListener('pointercancel', onCancel, opts);

  const KEYS = {
    ArrowLeft: LEFT, KeyA: LEFT,
    ArrowRight: RIGHT, KeyD: RIGHT,
    ArrowUp: UP, KeyW: UP, Space: UP,
    ArrowDown: DOWN, KeyS: DOWN,
    Enter: TAP,
    KeyP: PAUSE, Escape: PAUSE,
  };

  function onKey(e) {
    if (e.repeat) return;
    const action = KEYS[e.code];
    if (!action) return;
    e.preventDefault();
    emit(action);
  }
  window.addEventListener('keydown', onKey);

  // Belt and braces against iOS: touch-action and overscroll-behavior in CSS
  // cover most cases, but older Safari still needs these to stop a swipe
  // turning into a scroll, a pull-to-refresh, or a pinch-zoom.
  const blockTouch = (e) => e.preventDefault();
  document.addEventListener('touchmove', blockTouch, { passive: false });
  document.addEventListener('gesturestart', blockTouch, { passive: false });

  return function detach() {
    element.removeEventListener('pointerdown', onDown, opts);
    element.removeEventListener('pointermove', onMove, opts);
    element.removeEventListener('pointerup', onUp, opts);
    element.removeEventListener('pointercancel', onCancel, opts);
    window.removeEventListener('keydown', onKey);
    document.removeEventListener('touchmove', blockTouch);
    document.removeEventListener('gesturestart', blockTouch);
  };
}
