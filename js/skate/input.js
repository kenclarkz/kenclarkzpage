// Flick-It: the control scheme the game this copies is built around.
//
// The idea is that you do not press a button labelled "kickflip". You pull the
// stick back to load your legs, then flick it the way your front foot would go —
// straight up for an ollie, up and across the toe side for a kickflip, sideways
// for a shove-it. The gesture is the trick, and how far you pulled back is how
// much pop you get.
//
// All three input devices land on the same recogniser. A touch drag, a mouse drag
// and a real right thumbstick all produce a pull depth and an exit direction, and
// the classifier below only ever sees those two things — which also means the
// headless test harness can drive the exact code path that ships by dragging the
// mouse.

import * as C from './config.js';

// --- gesture thresholds, in pixels for pointers and in stick units elsewhere ---
const PULL_MIN = 18;      // downward travel that counts as loading the legs
const PULL_FULL = 96;     // ...and where the charge is at maximum
const FLICK_MIN = 24;     // travel out of the pull that counts as a flick
const CURL_MIN = 52;      // sideways excursion that turns a flick into a 360
const TAP_PX = 12;
const TAP_MS = 260;

/**
 * Which trick a flick is, from where it went.
 *
 * `angle` is measured with up as +90° and right as 0°, and `curl` says the path
 * swung out sideways before it left — which is the scoop a 360 flip needs, and is
 * why that trick is a quarter circle on the stick rather than a straight flick.
 */
export function classify(angle, curl) {
  // Normalised into (-180, 180] so the sectors below can be written once and
  // cannot be reached by two different spellings of the same direction.
  let deg = ((((angle * 180) / Math.PI + 180) % 360) + 360) % 360 - 180;
  if (deg <= -180) deg += 360;

  if (deg > 55 && deg <= 125) {
    // Straight up is an ollie; a quarter circle into it is the 360 family,
    // because the scoop that makes those tricks work is a real movement.
    if (curl < 0) return 'treflip';
    if (curl > 0) return 'varialheel';
    return 'ollie';
  }
  if (deg > 125 && deg <= 168) return 'kickflip';   // up and over the toe side
  if (deg > 168 || deg <= -168) return 'shuvit';    // straight across, heel side
  if (deg > 10 && deg <= 55) return 'heelflip';     // up and over the heel side
  if (deg > -40 && deg <= 10) return 'fsshuvit';    // straight across, toe side
  return null;                                      // anything downward
}

/** Keys that fire a trick outright, for anyone who would rather not flick. */
const TRICK_KEYS = {
  KeyJ: 'kickflip',
  KeyK: 'heelflip',
  KeyU: 'shuvit',
  KeyI: 'fsshuvit',
  KeyO: 'shuv360',
  KeyN: 'varial',
  KeyM: 'treflip',
  Comma: 'hardflip',
  Period: 'impossible',
};

export class Input {
  constructor(element) {
    this.el = element;
    this.keys = new Set();
    this.pointers = new Map();
    this.steerTouch = 0;
    this.flickCharge = 0;      // 0..1 while a pull is being held
    this.flickActive = false;
    this.queue = [];           // pending tricks, drained by read()
    this.pushQueued = false;
    this.enabled = true;
    // Set from outside so a paused game stops steering itself.
    this.onPause = null;

    this.padCharge = 0;
    this.padPulled = false;
    this.padCurl = 0;
    this.chargedFor = 0;

    this.bind();
  }

  bind() {
    const opts = { passive: false };
    this.el.addEventListener('pointerdown', (e) => this.down(e), opts);
    this.el.addEventListener('pointermove', (e) => this.move(e), opts);
    this.el.addEventListener('pointerup', (e) => this.up(e), opts);
    this.el.addEventListener('pointercancel', (e) => this.cancel(e), opts);
    window.addEventListener('keydown', (e) => this.key(e, true));
    window.addEventListener('keyup', (e) => this.key(e, false));
    // iOS turns a swipe into a scroll or a pull-to-refresh without these, even
    // with touch-action set in CSS.
    const block = (e) => e.preventDefault();
    document.addEventListener('touchmove', block, { passive: false });
    document.addEventListener('gesturestart', block, { passive: false });
  }

  // --- pointers ----------------------------------------------------------
  /**
   * Which half of the screen a pointer started in decides what it is for: left
   * steers, right flicks. Tracking them in a map rather than as one active
   * pointer is what lets a thumb on each side work at the same time.
   */
  down(e) {
    if (!this.enabled) return;
    const left = e.clientX < window.innerWidth * 0.42;
    this.pointers.set(e.pointerId, {
      left,
      x0: e.clientX,
      y0: e.clientY,
      x: e.clientX,
      y: e.clientY,
      lowY: e.clientY,
      lowX: e.clientX,
      curl: 0,
      pulled: false,
      t0: performance.now(),
    });
    if (this.el.setPointerCapture) {
      try {
        this.el.setPointerCapture(e.pointerId);
      } catch {
        /* capture is a nicety */
      }
    }
  }

  move(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX;
    p.y = e.clientY;
    if (p.left) {
      // A steering stick with a dead zone, so resting a thumb does not carve.
      this.steerTouch = C.clamp((p.x - p.x0) / 74, -1, 1);
      return;
    }
    // The pull: how far below the deepest point we have been, and how far the
    // path wandered sideways on the way — the scoop, for the 360 family.
    if (p.y > p.lowY) {
      p.lowY = p.y;
      p.lowX = p.x;
      p.curl = 0;
    } else {
      const side = p.x - p.lowX;
      if (Math.abs(side) > Math.abs(p.curl)) p.curl = side;
    }
    const pull = p.lowY - p.y0;
    if (pull > PULL_MIN) {
      p.pulled = true;
      this.flickActive = true;
      this.flickCharge = C.clamp((pull - PULL_MIN) / (PULL_FULL - PULL_MIN), 0, 1);
    }
  }

  up(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    this.pointers.delete(e.pointerId);

    if (p.left) {
      this.steerTouch = 0;
      // A tap on the steering side is a push, which is the one thing you do far
      // more often than anything else.
      const moved = Math.hypot(p.x - p.x0, p.y - p.y0);
      if (moved < TAP_PX && performance.now() - p.t0 < TAP_MS) this.pushQueued = true;
      return;
    }

    if (p.pulled) {
      const dx = p.x - p.lowX;
      const dy = p.y - p.lowY;
      if (Math.hypot(dx, dy) > FLICK_MIN) {
        const angle = Math.atan2(-dy, dx);
        const curl = Math.abs(p.curl) > CURL_MIN ? Math.sign(p.curl) : 0;
        const trick = classify(angle, curl);
        // The charge at the bottom of the pull is what the pop is worth: flicking
        // out of it does not un-load your legs.
        if (trick) this.queue.push({ trick, charge: this.flickCharge });
      }
    }
    this.flickActive = false;
    this.flickCharge = 0;
  }

  cancel(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    this.pointers.delete(e.pointerId);
    if (p.left) this.steerTouch = 0;
    else {
      this.flickActive = false;
      this.flickCharge = 0;
    }
  }

  // --- keyboard ----------------------------------------------------------
  key(e, downNow) {
    if (e.repeat) return;
    const code = e.code;
    if (code === 'Escape' || code === 'KeyP') {
      if (downNow) this.onPause?.();
      return;
    }
    if (
      code.startsWith('Arrow') ||
      code === 'Space' ||
      TRICK_KEYS[code] ||
      ['KeyA', 'KeyD', 'KeyW', 'KeyS', 'KeyC', 'ShiftLeft', 'ShiftRight'].includes(code)
    ) {
      e.preventDefault();
    }
    if (downNow) {
      this.keys.add(code);
      if (!this.enabled) return;
      if (TRICK_KEYS[code]) {
        // A trick key with no charge behind it still needs some pop, or a
        // keyboard player could never land anything.
        const charge = this.charging() ? undefined : 0.55;
        this.queue.push({ trick: TRICK_KEYS[code], charge });
      }
      if (code === 'KeyW' || code === 'KeyC' || code === 'ArrowUp') this.pushQueued = true;
    } else {
      this.keys.delete(code);
      // Releasing the charge with nothing else asked for is an ollie, exactly as
      // letting the stick spring back up is.
      if ((code === 'Space' || code === 'ArrowDown' || code === 'KeyS') && !this.charging()) {
        if (this.enabled && this.chargedFor > 0.05) this.queue.push({ trick: 'ollie' });
      }
    }
  }

  charging() {
    return this.keys.has('Space') || this.keys.has('ArrowDown') || this.keys.has('KeyS');
  }

  // --- gamepad -----------------------------------------------------------
  /**
   * A real right stick, recognised the same way as a drag: pulled back past a
   * threshold to charge, and classified when it comes back through the middle.
   */
  readPad(out) {
    const pads = navigator.getGamepads?.();
    if (!pads) return;
    let pad = null;
    for (const p of pads) if (p && p.connected) pad = p;
    if (!pad) return;

    const lx = pad.axes[0] || 0;
    if (Math.abs(lx) > 0.14) out.steer = C.clamp(lx, -1, 1);
    const rx = pad.axes[2] || 0;
    const ry = pad.axes[3] || 0;

    if (ry > 0.55) {
      this.padPulled = true;
      this.padCharge = Math.max(this.padCharge, C.clamp((ry - 0.55) / 0.4, 0, 1));
      if (Math.abs(rx) > Math.abs(this.padCurl)) this.padCurl = rx;
    } else if (this.padPulled && Math.hypot(rx, ry) < 0.75) {
      // Back through the middle: the direction it came out at is the trick.
      const angle = Math.atan2(-ry, rx);
      const curl = Math.abs(this.padCurl) > 0.7 ? Math.sign(this.padCurl) : 0;
      const trick = ry < -0.35 || Math.abs(rx) > 0.35 ? classify(angle, curl) : null;
      if (trick) this.queue.push({ trick, charge: this.padCharge });
      this.padPulled = false;
      this.padCharge = 0;
      this.padCurl = 0;
    }
    if (this.padPulled) out.charge = true;
    if (pad.buttons[6]?.pressed || pad.buttons[4]?.pressed) out.slide = true;
    if (pad.buttons[0]?.pressed || pad.buttons[7]?.pressed) out.push = true;
  }

  // --- the frame's worth of input -----------------------------------------
  /**
   * Collapse every device into the one object physics reads. Called once per
   * frame; draining the queues here is what makes a flick fire exactly once
   * however many simulation steps that frame turns into.
   */
  read() {
    const out = {
      steer: 0,
      charge: false,
      slide: false,
      push: false,
      trick: null,
      trickCharge: undefined,
    };
    if (!this.enabled) return out;

    let steer = this.steerTouch;
    if (this.keys.has('ArrowLeft') || this.keys.has('KeyA')) steer -= 1;
    if (this.keys.has('ArrowRight') || this.keys.has('KeyD')) steer += 1;
    out.steer = C.clamp(steer, -1, 1);

    out.charge = this.flickActive || this.charging();
    out.slide = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    out.push = this.pushQueued;
    this.pushQueued = false;

    this.readPad(out);

    if (this.queue.length) {
      const next = this.queue.shift();
      out.trick = next.trick;
      out.trickCharge = next.charge;
    }

    // How long the keyboard charge has been held, so releasing it can tell the
    // difference between an ollie and a key that was never pressed.
    this.chargedFor = out.charge ? (this.chargedFor || 0) + 1 / 60 : 0;
    return out;
  }

  /** Drop everything held down. Used when the game is paused or reset. */
  clear() {
    this.keys.clear();
    this.pointers.clear();
    this.steerTouch = 0;
    this.flickActive = false;
    this.flickCharge = 0;
    this.queue.length = 0;
    this.pushQueued = false;
    this.padPulled = false;
    this.padCharge = 0;
  }
}
