// Entry point: renderer, the fixed-timestep loop, and the glue between the
// track, the player, the entities and input.

import * as THREE from './three.js';
import * as C from './config.js';
import { Track } from './track.js';
import { LEFT, RIGHT } from './path.js';
import { Entities } from './entities.js';
import { Player } from './player.js';
import * as Input from './input.js';
import { Hud, loadHighScore, saveHighScore } from './hud.js';
import { registerServiceWorker, setupInstall, isInstalled } from './pwa.js';

const MENU = 'menu';
const PLAYING = 'playing';
const PAUSED = 'paused';
const OVER = 'over';

const params = new URLSearchParams(location.search);
const DEBUG = params.get('debug') === '1';
const SEED = params.has('seed') ? parseInt(params.get('seed'), 10) >>> 0 : (Date.now() >>> 0);

// --- scene ----------------------------------------------------------------
const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: false,
  alpha: false,
  stencil: false,
  depth: true,
  powerPreference: 'high-performance',
});
renderer.shadowMap.enabled = false;
renderer.setClearColor(C.FOG_COLOR, 1);

const scene = new THREE.Scene();
// Fog is the draw-distance mechanism, not decoration: it matches the clear
// colour exactly, so nothing ever needs to exist past camera.far.
scene.fog = new THREE.Fog(C.FOG_COLOR, C.FOG_NEAR, C.FOG_FAR);

const camera = new THREE.PerspectiveCamera(C.FOV_BASE, 1, C.CAMERA_NEAR, C.CAMERA_FAR);
camera.position.set(0, 3.1, 5.4);
camera.lookAt(0, 1.15, -4);

scene.add(new THREE.HemisphereLight(0xb8cbe4, 0x6b5334, 1.15));
const sun = new THREE.DirectionalLight(0xffe9c4, 0.95);
sun.position.set(4, 9, 3);
scene.add(sun);

// --- game objects ---------------------------------------------------------
const rngState = { fn: C.makeRng(SEED) };
const rng = () => rngState.fn();

const entities = new Entities(rng);
const track = new Track(
  rng,
  (node) => entities.spawnForNode(node),
  (node) => entities.retireBefore(node.s0 + node.len)
);
track.root.add(entities.group);
scene.add(track.root);

const player = new Player();
scene.add(player.group);

const hud = new Hud();
if (DEBUG) hud.enableDebug();

// --- state ----------------------------------------------------------------
let state = MENU;
let score = 0;
let coins = 0;
let best = loadHighScore();
let lastArc = null;
let cornersTaken = 0;
let frames = 0;

hud.setBest(best);

function resetRun() {
  rngState.fn = C.makeRng(SEED);
  entities.reset(rng);
  track.reset(rng);
  player.reset();
  score = 0;
  coins = 0;
  lastArc = null;
  cornersTaken = 0;
  hud.setScore(0);
  hud.setCoins(0);
  // Build the world in front of the player before the first frame is shown.
  track.update(player.distance);
  entities.refresh(track.path);
  updateWorldTransform();
}

function startGame() {
  resetRun();
  state = PLAYING;
  hud.hidePanel();
}

function finishRun() {
  state = OVER;
  if (score > best) {
    best = Math.floor(score);
    saveHighScore(best);
    hud.setBest(best);
  }
}

function showGameOverPanel() {
  hud.showPanel(
    'Wiped out',
    `<p>You hit something.</p><p class="big">${Math.floor(score).toLocaleString()}</p>
     <p class="sub">${coins} coins &middot; best ${best.toLocaleString()}</p>`,
    'Run again'
  );
}

function showMenu() {
  state = MENU;
  hud.showPanel(
    'Temple Runner',
    `<p>Swipe <b>left</b> / <b>right</b> to change lanes.</p>
     <p>Swipe <b>up</b> to jump, <b>down</b> to slide.</p>
     <p class="sub">Corners turn on their own &mdash; just watch for obstacles.</p>`,
    'Run'
  );
}

// --- turns ----------------------------------------------------------------
// Corners are followed automatically — the path itself bends, and the world
// transform rotates around the player with no gesture required. A lateral
// swipe always just changes lanes.
function onLateral(dir) {
  // path LEFT is +1; lanes run left(-1) to right(+1), hence the negation.
  player.moveLane(-dir);
}

/** Tracks how many corners the player has passed, for the HUD/score only. */
function updateCorners() {
  const arc = track.path.nextArc(player.distance);
  if (arc !== lastArc) {
    if (lastArc) cornersTaken++;
    lastArc = arc;
  }
}

// --- world transform ------------------------------------------------------
// The player is pinned at the origin and the world is moved by the inverse of
// the player's pose on the path. Corners then need no special handling at all.
const _m = new THREE.Matrix4();
const _lat = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);

function updateWorldTransform() {
  const pose = track.path.pose(player.distance);
  _e.set(0, pose.yaw, 0);
  _q.setFromEuler(_e);
  _p.set(pose.x, 0, pose.z);
  _m.compose(_p, _q, _one);
  _lat.makeTranslation(player.lateral, 0, 0);
  _m.multiply(_lat);
  _m.invert();
  _m.decompose(track.root.position, track.root.quaternion, track.root.scale);
}

// --- simulation step ------------------------------------------------------
function step(dt) {
  if (state === PLAYING) {
    player.update(dt);
    if (!player.isDead) updateCorners();
  } else if (state === OVER) {
    player.update(dt); // let the tumble play out
  }

  const shift = track.update(player.distance);
  if (shift) {
    player.distance -= shift;
    entities.shift(shift);
  }

  if (state === PLAYING && !player.isDead) {
    const got = entities.collide(player, (reason) => player.die(reason));
    if (got) {
      coins += got;
      hud.setCoins(coins);
    }
    score = player.distance * C.POINTS_PER_METRE + coins * C.COIN_VALUE;
    hud.setScore(score);
  }

  if (entities.dirty) entities.refresh(track.path);
  updateWorldTransform();
  updateCamera(dt);

  // The panel waits for the crash to play out, so the player sees what killed
  // them rather than a menu appearing over a frozen frame.
  if (state === PLAYING && player.isDead) finishRun();
  if (state === OVER && player.settled && !hud.panelVisible) showGameOverPanel();
}

function updateCamera(dt) {
  const k = Math.min(1, dt * 5);
  // Shifting the camera *against* the lane offset makes the runner read as
  // being in that lane while staying near the centre of the screen.
  camera.position.x += (-player.lateral * 0.25 - camera.position.x) * k;
  camera.position.y += (3.1 + player.y * 0.28 - camera.position.y) * Math.min(1, dt * 7);
  camera.lookAt(0, 1.15, -4);

  const t = (player.speed - C.SPEED_0) / (C.SPEED_MAX - C.SPEED_0);
  const targetFov = C.FOV_BASE + t * C.FOV_SPEED_GAIN;
  if (Math.abs(camera.fov - targetFov) > 0.01) {
    camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 2);
    camera.updateProjectionMatrix();
  }
}

// --- adaptive resolution --------------------------------------------------
// devicePixelRatio is 3 on an iPhone; rendering at 3x is 9x the fragment work
// of 1x and is by far the easiest way to tank the frame rate on a scene this
// simple. Start capped, and step down (never up, to avoid oscillation).
const DPR_STEPS = [2, 1.5, 1.25, 1];
let dprIdx = 0;
let frameAccum = 0;
let frameCount = 0;
let slowSeconds = 0;

function applyDpr() {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, DPR_STEPS[dprIdx]));
}

function trackFrameTime(ms) {
  frameAccum += ms;
  frameCount++;
  if (frameCount < 60) return;
  const avg = frameAccum / frameCount;
  frameAccum = 0;
  frameCount = 0;
  if (avg > 20 && dprIdx < DPR_STEPS.length - 1) {
    slowSeconds++;
    if (slowSeconds >= 2) {
      dprIdx++;
      applyDpr();
      slowSeconds = 0;
    }
  } else {
    slowSeconds = 0;
  }
}

// --- resize ---------------------------------------------------------------
let resizeTimer = 0;
function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix(); // forgetting this is the classic stretched-after-rotation bug
}
function scheduleResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(resize, 100);
}
window.addEventListener('resize', scheduleResize);
window.visualViewport?.addEventListener('resize', scheduleResize);

// --- input ----------------------------------------------------------------
function togglePause() {
  if (state === PLAYING) {
    state = PAUSED;
    hud.showPanel('Paused', '<p class="sub">Take your time.</p>', 'Resume');
  } else if (state === PAUSED) {
    state = PLAYING;
    hud.hidePanel();
  }
}

function emit(action) {
  switch (action) {
    case Input.LEFT:
      if (state === PLAYING) onLateral(LEFT);
      break;
    case Input.RIGHT:
      if (state === PLAYING) onLateral(RIGHT);
      break;
    case Input.UP:
      if (state === PLAYING) player.jump();
      break;
    case Input.DOWN:
      if (state === PLAYING) player.slide();
      break;
    case Input.PAUSE:
      togglePause();
      break;
    case Input.TAP:
      if (state === MENU || state === OVER) startGame();
      else if (state === PAUSED) togglePause();
      break;
  }
}

Input.attachInput(document.getElementById('app'), emit);

// The overlay sits inside #app, so it swallows its own pointer events rather
// than letting them bubble into the swipe handler and start the game twice.
const overlayEl = document.getElementById('overlay');
overlayEl.style.pointerEvents = 'auto';
for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
  overlayEl.addEventListener(type, (e) => e.stopPropagation());
}
overlayEl.addEventListener('click', (e) => {
  if (e.target.id === 'back') return; // let the link navigate
  if (state === PAUSED) togglePause();
  else startGame();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden && state === PLAYING) togglePause();
});

// --- loop -----------------------------------------------------------------
let last = performance.now();
let acc = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const raw = (now - last) / 1000;
  last = now;
  // Clamping stops a backgrounded tab from teleporting the player hundreds of
  // metres down the track the instant it comes back.
  acc += Math.min(raw, C.MAX_FRAME_DT);

  const t0 = performance.now();
  while (acc >= C.FIXED_DT) {
    step(C.FIXED_DT);
    acc -= C.FIXED_DT;
  }
  renderer.render(scene, camera);
  frames++;
  trackFrameTime(performance.now() - t0);

  if (DEBUG) {
    const info = renderer.info.render;
    hud.setDebug(
      `${(1 / Math.max(raw, 1e-4)).toFixed(0)} fps  dpr ${renderer.getPixelRatio().toFixed(2)}\n` +
        `calls ${info.calls}  tris ${info.triangles}\n` +
        `chunks ${track.live.length}  items ${entities.items.length}\n` +
        `dist ${player.distance.toFixed(1)}  speed ${player.speed.toFixed(1)}`
    );
  }
}

// --- boot -----------------------------------------------------------------
applyDpr();
resize();
resetRun();
showMenu();
requestAnimationFrame(frame);

registerServiceWorker();
setupInstall(
  document.getElementById('install'),
  document.getElementById('ios-hint'),
  document.getElementById('ios-dismiss')
);

// Test hook for tools/smoke.mjs. Harmless in production — it exposes no more
// than the debug overlay already does.
window.__game = {
  get state() {
    return state;
  },
  get score() {
    return score;
  },
  get coins() {
    return coins;
  },
  get frames() {
    return frames;
  },
  get distance() {
    return player.distance;
  },
  get deathReason() {
    return player.deathReason;
  },
  get yaw() {
    return track.path.pose(player.distance).yaw;
  },
  get liveChunks() {
    return track.live.length;
  },
  get cornersTaken() {
    return cornersTaken;
  },
  player,
  track,
  entities,
  renderer,
  emit,
  start: startGame,
  installed: isInstalled(),
  /** Jump the player to a path distance, streaming the world to match. */
  teleportTo(s) {
    player.distance = s;
    let guard = 0;
    let total = 0;
    for (;;) {
      const shift = track.update(player.distance);
      if (!shift) break;
      player.distance -= shift;
      entities.shift(shift);
      total += shift;
      if (++guard > 5000) break;
    }
    lastArc = null;
    entities.refresh(track.path);
    updateWorldTransform();
    return total;
  },
  /**
   * The next corner ahead, for tests that need to steer into or past one.
   * Extends the path if no corner has been generated yet — harmless, since
   * chunks are only ever spawned for nodes the player is close to.
   */
  nextArc() {
    let guard = 0;
    while (!track.path.nextArc(player.distance) && guard++ < 200) track.path.append();
    const a = track.path.nextArc(player.distance);
    return a ? { s0: a.s0, len: a.len, dir: a.dir } : null;
  },
  /** The next obstacle ahead, so a test can park in front of it. */
  nextObstacle() {
    for (const it of entities.items) {
      if (it.kind !== 0 && it.alive && it.s > player.distance) {
        return { s: it.s, lane: it.lane, kind: it.kind };
      }
    }
    return null;
  },
};
