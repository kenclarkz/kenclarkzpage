// Entry point: renderer, lights, the fixed-timestep loop, and the glue between
// the park, the ride model, the camera and the HUD.

import * as THREE from '../game/three.js';
import * as C from './config.js';
import { Park, PARKS, ROUGH } from './park.js';
import { Board } from './board.js';
import { Skater } from './skater.js';
import { Ride, GROUND, GRIND } from './physics.js';
import { Ragdoll } from './ragdoll.js';
import { ChaseCamera } from './camera.js';
import { Input } from './input.js';
import { Hud } from './hud.js';
import { Audio } from './audio.js';
import { save } from './save.js';
import { makeAiSkaters } from './ai.js';
import { makeBirds } from './bird.js';
import { makeLogos, checkPickup } from './collectible.js';
import { registerServiceWorker, setupInstall } from '../game/pwa.js';

const START = 'start';
const PLAYING = 'playing';
const PAUSED = 'paused';
const GUIDE = 'guide';
const PARKMENU = 'parks';
const BAILED = 'bail';

const AI_COUNT = 3;
const BIRD_COUNT = 3;

const params = new URLSearchParams(location.search);
const DEBUG = params.get('debug') === '1';

// --- renderer -------------------------------------------------------------
const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: false,
  alpha: false,
  stencil: false,
  powerPreference: 'high-performance',
});
renderer.setClearColor(C.SKY_HORIZON, 1);
// The concrete is a big flat mid-grey under a bright sky, which is exactly the
// case that clips to white without a filmic curve on the highlights.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.92;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(C.SKY_HORIZON, C.FOG_NEAR, C.FOG_FAR);

const camera = new THREE.PerspectiveCamera(C.CAM_FOV, 1, C.CAMERA_NEAR, C.CAMERA_FAR);

// --- sky ------------------------------------------------------------------
/** A two-stop vertical gradient, drawn once into a 2×256 canvas. */
function skyTexture() {
  const c = document.createElement('canvas');
  c.width = 2;
  c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  const hex = (v) => `#${v.toString(16).padStart(6, '0')}`;
  grad.addColorStop(0, hex(C.SKY_TOP));
  grad.addColorStop(0.55, '#8fb4d6');
  grad.addColorStop(1, hex(C.SKY_HORIZON));
  g.fillStyle = grad;
  g.fillRect(0, 0, 2, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const sky = new THREE.Mesh(
  new THREE.SphereGeometry(400, 16, 12),
  new THREE.MeshBasicMaterial({
    map: skyTexture(),
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  })
);
sky.renderOrder = -1;
sky.frustumCulled = false;
scene.add(sky);

// --- lights ---------------------------------------------------------------
// Two lights, both cheap. A skatepark at midday is sky fill plus one hard sun,
// and anything more per-fragment is frame time spent on a scene this simple.
scene.add(new THREE.HemisphereLight(0xbcd6f0, 0x6b6455, 2.1));
const sun = new THREE.DirectionalLight(0xfff2d8, 2.3);
sun.position.set(-6, 9, 4);
scene.add(sun);

// --- world ----------------------------------------------------------------
let park = new Park(PARKS.find((p) => p.id === save.park) || PARKS[0]);
scene.add(park.group);

const board = new Board();
const skater = new Skater();
const ride = new Ride(park, board, skater);
scene.add(ride.frame);

const ragdoll = new Ragdoll(park);
const chase = new ChaseCamera(camera, park);

const bots = makeAiSkaters(park, AI_COUNT);
for (const b of bots) scene.add(b.ride.frame);

const birds = makeBirds(BIRD_COUNT);
for (const b of birds) scene.add(b.group);

let logos = makeLogos(park);
let logosCollected = 0;

/** Release every geometry a group owns. Only ever called on a group that is
 * about to be dropped for good — the park being replaced by another one. */
function disposeGroup(group) {
  group.traverse((o) => {
    if (!o.isMesh) return;
    o.geometry?.dispose();
    if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
    else o.material?.dispose();
  });
}

/**
 * Swap the whole map out from under the player. The ride, the camera and the
 * ragdoll do not need rebuilding — they only ever read `.park` when they need
 * it, so handing them the new one is the entire hand-off. The AI tours a new
 * patrol loop, the logos are fresh, and the old park's geometry is freed
 * rather than left for the GC to eventually notice.
 */
function loadPark(def) {
  disposeGroup(park.group);
  scene.remove(park.group);
  park = new Park(def);
  scene.add(park.group);
  ride.park = park;
  chase.park = park;
  ragdoll.park = park;
  logos = makeLogos(park);
  logosCollected = 0;
  bots.forEach((b, i) => b.setPark(park, i));
  save.setPark(def.id);
  hud.setCurrentPark(def.name);
}

/**
 * A soft blob, laid on the surface under the board.
 *
 * A real shadow map would cost a whole extra pass over the park for one small
 * object, and this carries the only information anybody needs from a shadow
 * here: where the board is, and how far above the ground it is. The gradient
 * matters — a hard-edged disc reads as a sticker rather than as a shadow.
 */
function shadowTexture() {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(20,24,30,0.85)');
  grad.addColorStop(0.55, 'rgba(20,24,30,0.45)');
  grad.addColorStop(1, 'rgba(20,24,30,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

const shadowGeo = new THREE.PlaneGeometry(1.15, 1.15);
shadowGeo.rotateX(-Math.PI / 2);
const shadow = new THREE.Mesh(
  shadowGeo,
  new THREE.MeshBasicMaterial({
    map: shadowTexture(),
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
  })
);
shadow.renderOrder = 1;
scene.add(shadow);
const shadowSurf = { y: 0, nx: 0, ny: 1, nz: 0, kind: 0 };
const _sn = new THREE.Vector3();
const _sq = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

function updateShadow() {
  const s = park.sample(ride.pos.x, ride.pos.z, shadowSurf);
  const h = Math.max(0, ride.pos.y - s.y);
  shadow.position.set(ride.pos.x, s.y + 0.012, ride.pos.z);
  _sn.set(s.nx, s.ny, s.nz);
  _sq.setFromUnitVectors(UP, _sn);
  shadow.quaternion.copy(_sq);
  // Bigger and fainter with height, which is what sells an ollie's air.
  const spread = 1 + h * 0.5;
  shadow.scale.set(spread, 1, spread);
  shadow.material.opacity = Math.max(0, 0.85 * (1 - h / 3.4));
}

// --- systems --------------------------------------------------------------
const hud = new Hud();
if (DEBUG) hud.enableDebug();
const audio = new Audio(save.sound);
const input = new Input(document.getElementById('app'));

let state = START;
let score = 0;           // banked this session
let frames = 0;
let worldTime = 0;       // unconditional clock, for birds and the logos' spin
let liveCombo = { names: [], points: 0 };

hud.setBest(save.best);
hud.setSound(save.sound);
hud.setStats(save);
hud.setCurrentPark(park.name);

// --- state changes --------------------------------------------------------
function respawn() {
  if (ragdoll.active) {
    ragdoll.stop();
    // The rider and the board are put back under the frame they were taken from.
    ride.frame.add(skater.group);
    ride.frame.add(board.group);
    board.group.position.set(0, 0, 0);
    board.group.quaternion.identity();
  }
  ride.reset();
  chase.snap(ride);
  liveCombo = { names: [], points: 0 };
  hud.setCombo([], 0, 1);
  input.clear();
}

function startGame() {
  respawn();
  score = 0;
  hud.setScore(0);
  state = PLAYING;
  input.enabled = true;
  hud.hide();
}

function showStart() {
  state = START;
  input.enabled = false;
  audio.hush();
  hud.setStats(save);
  hud.show('start');
}

function showGuide() {
  state = GUIDE;
  input.enabled = false;
  save.markGuideSeen();
  hud.show('guide');
}

function showParks() {
  state = PARKMENU;
  input.enabled = false;
  hud.renderParks(PARKS, park.id);
  hud.show('parks');
}

function togglePause() {
  if (state === PLAYING) {
    state = PAUSED;
    input.enabled = false;
    audio.hush();
    hud.show('paused');
  } else if (state === PAUSED) {
    state = PLAYING;
    input.enabled = true;
    hud.hide();
  }
}

hud.on.play = () => startGame();
hud.on.retry = () => startGame();
hud.on.resume = () => togglePause();
hud.on.guide = () => showGuide();
hud.on.back = () => showStart();
hud.on.parks = () => showParks();
hud.on.selectPark = (id) => {
  const def = PARKS.find((p) => p.id === id);
  if (def && def.id !== park.id) {
    loadPark(def);
    respawn();
  }
  showStart();
};
hud.on.sound = () => {
  save.setSound(!save.sound);
  audio.setEnabled(save.sound);
  hud.setSound(save.sound);
};
hud.on.reset = () => {
  save.reset();
  hud.setBest(save.best);
  hud.setStats(save);
  hud.setSound(save.sound);
  audio.setEnabled(save.sound);
};
input.onPause = () => {
  if (state === PLAYING || state === PAUSED) togglePause();
};

// --- events from the ride model -------------------------------------------
/**
 * Everything the player hears and reads comes from here. The ride model raises
 * events and knows nothing about the HUD or the audio graph, which is what lets
 * the physics be tested on its own.
 */
function handleEvents(events) {
  for (const e of events) {
    switch (e.name) {
      case 'pop':
        audio.pop(e.height);
        break;
      case 'push':
        audio.push();
        break;
      case 'land':
        audio.land(e.impact);
        if (e.height > 0.4 && save.recordAir(e.height)) hud.say(`${e.height.toFixed(2)} m air`, 'small');
        break;
      case 'grindStart':
        audio.lock();
        break;
      case 'trick':
        hud.say(e.sketchy ? `${e.label} (sketchy)` : e.label, e.sketchy ? 'sketchy' : '');
        save.recordTrick(e.points);
        liveCombo = { names: ride.combo.names.slice(), points: ride.combo.points };
        break;
      case 'combo': {
        score += e.total;
        hud.setScore(score);
        const best = save.recordCombo(e.total);
        hud.setBest(save.best);
        if (e.multiplier > 1 || e.total > 400) {
          hud.say(`${e.total.toLocaleString()}${best ? '  new best' : ''}`, 'banked');
        }
        audio.chime(e.multiplier > 2);
        liveCombo = { names: [], points: 0 };
        break;
      }
      case 'comboLost':
        liveCombo = { names: [], points: 0 };
        break;
      case 'bail':
        audio.bail();
        save.recordBail();
        startBail();
        break;
    }
  }
}

/** Hand the rider and the board over to the ragdoll. */
function startBail() {
  // Both come out of the ride frame and into the world, because from here they
  // are two independent objects that happen to have been travelling together.
  ragdoll.start(skater, ride.frame, ride.vel, ride.airYaw ? C.SPIN_RATE * Math.sign(ride.airYaw) : 0);
  scene.add(skater.group);
  scene.add(board.group);
  state = BAILED;
  input.enabled = false;
  hud.setBalance(false, 0, 1);
  hud.setCharge(0);
}

// --- the step -------------------------------------------------------------
let bailWait = 0;

function step(dt, frameInput) {
  // The park's own crowd keeps moving whatever the player is doing — paused at
  // the menu is exactly when a skatepark should still look alive.
  for (const b of bots) b.step(dt);

  if (state === PLAYING) {
    handleEvents(ride.update(dt, frameInput));
    if (ride.combo.live) liveCombo = { names: ride.combo.names, points: ride.combo.points };
    const got = checkPickup(logos, ride.pos);
    if (got) {
      audio.collect();
      save.recordLogo();
      logosCollected++;
      hud.say('Logo found', 'small');
    }
  } else if (state === BAILED) {
    ragdoll.step(dt);
    skater.poseRagdoll(ragdoll.named);
    const b = ragdoll.board.points;
    if (b.length === 3) board.poseFree(b[0], b[1], b[2]);
    bailWait += dt;
    // Wait for the body to stop moving, or for long enough that it clearly is not
    // going to, then offer a reset rather than forcing one.
    if (bailWait > C.BAIL_SETTLE && (ragdoll.settled > 0.25 || bailWait > 4)) {
      state = PAUSED;
      hud.showBail(ride.bailReason);
    }
  } else if (state === PAUSED || state === START || state === GUIDE || state === PARKMENU) {
    // Nothing moves, but the camera still eases into place behind a fresh spawn.
  }

  if (state !== BAILED) bailWait = 0;
}

// --- render ---------------------------------------------------------------
// Set by the test hook's inspect(), so a screenshot can be framed by hand.
let cameraLocked = false;

function render(dt) {
  worldTime += dt;
  for (const b of birds) b.update(worldTime);
  for (const l of logos) l.update(dt, worldTime);
  if (!cameraLocked) chase.update(ride, ragdoll, dt);
  if (state !== BAILED) updateShadow();
  else shadow.material.opacity = Math.max(0, shadow.material.opacity - dt);
  renderer.render(scene, camera);
}

function updateHud(dt) {
  hud.tick(dt);
  if (state === PLAYING) {
    hud.setSpeed(ride.groundSpeed);
    hud.setAir(ride.airHeight);
    hud.setCombo(liveCombo.names, liveCombo.points, Math.max(1, liveCombo.names.length));
    const balancing = !!ride.grind || ride.manual;
    hud.setBalance(balancing, ride.balance, C.BALANCE_LIMIT);
    hud.setCharge(input.flickActive || input.charging() ? ride.charge : 0);
    hud.setLogos(logosCollected, logos.length);
  }
  audio.follow(
    ride.groundSpeed,
    ride.mode === GROUND,
    ride.mode === GRIND,
    ride.surf.kind === ROUGH
  );
}

// --- adaptive resolution --------------------------------------------------
// devicePixelRatio is 3 on a phone, and 3× is nine times the fragment work of 1×.
// Start capped and step down, never up, so it cannot oscillate.
const DPR_STEPS = [1.75, 1.5, 1.25, 1];
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
    if (++slowSeconds >= 2) {
      dprIdx++;
      applyDpr();
      slowSeconds = 0;
    }
  } else slowSeconds = 0;
}

// --- resize ---------------------------------------------------------------
let resizeTimer = 0;
function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(resize, 100);
});
window.visualViewport?.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(resize, 100);
});

// Audio has to be created inside a gesture, and can be suspended again at any
// point, so every gesture routes here.
for (const type of ['pointerdown', 'keydown']) {
  document.addEventListener(type, () => audio.unlock(), { capture: true, passive: true });
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state === PLAYING) togglePause();
});

// The overlay swallows its own pointer events, so a tap on a button does not also
// count as a flick.
const overlayEl = document.getElementById('overlay');
overlayEl.style.pointerEvents = 'auto';
for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
  overlayEl.addEventListener(type, (e) => e.stopPropagation());
}

// --- loop -----------------------------------------------------------------
let last = performance.now();
let acc = 0;

function loop(now) {
  requestAnimationFrame(loop);
  const raw = (now - last) / 1000;
  last = now;
  // Clamped, so a backgrounded tab cannot teleport the skater across the park the
  // instant it comes back.
  const dt = Math.min(raw, C.MAX_FRAME_DT);
  acc += dt;

  const t0 = performance.now();
  // One input read per frame, not per step: a flick must fire once however many
  // simulation steps this frame turns into.
  const frameInput = state === PLAYING ? input.read() : null;
  let steps = 0;
  while (acc >= C.FIXED_DT && steps < 8) {
    step(C.FIXED_DT, frameInput);
    acc -= C.FIXED_DT;
    steps++;
  }
  if (steps === 8) acc = 0; // give up rather than fall further behind

  updateHud(dt);
  render(dt);
  frames++;
  trackFrameTime(performance.now() - t0);

  if (DEBUG) {
    const info = renderer.info.render;
    const modes = ['ground', 'air', 'grind', 'bail'];
    hud.setDebug(
      `${(1 / Math.max(raw, 1e-4)).toFixed(0)} fps  dpr ${renderer.getPixelRatio().toFixed(2)}  calls ${info.calls}\n` +
        `${modes[ride.mode]}  v ${ride.speed.toFixed(2)} m/s  side ${ride.side.toFixed(2)}\n` +
        `pos ${ride.pos.x.toFixed(1)} ${ride.pos.y.toFixed(2)} ${ride.pos.z.toFixed(1)}  yaw ${ride.yaw.toFixed(2)}\n` +
        `lean ${ride.lean.toFixed(2)}  charge ${ride.charge.toFixed(2)}  bal ${ride.balance.toFixed(2)}\n` +
        `air ${ride.airHeight.toFixed(2)} m  combo ${ride.combo.points}×${ride.combo.names.length}  park ${park.id}`
    );
  }
}

// --- boot -----------------------------------------------------------------
applyDpr();
resize();
respawn();
chase.snap(ride);
if (save.seenGuide) showStart();
else showGuide();
requestAnimationFrame(loop);

registerServiceWorker();
setupInstall(
  document.getElementById('install'),
  document.getElementById('ios-hint'),
  document.getElementById('ios-dismiss')
);

// Test hook for tools/skate-smoke.mjs. Exposes no more than the debug overlay
// already does, and drives the same code paths the player does.
window.__skate = {
  get state() {
    return state;
  },
  get score() {
    return score;
  },
  get frames() {
    return frames;
  },
  get park() {
    return park;
  },
  get logos() {
    return logos;
  },
  parks: PARKS,
  bots,
  birds,
  ride,
  board,
  skater,
  ragdoll,
  input,
  hud,
  audio,
  save,
  chase,
  scene,
  camera,
  renderer,
  start: startGame,
  respawn,
  /** Load a different map by id, the way the park picker does. */
  switchPark(id) {
    const def = PARKS.find((p) => p.id === id);
    if (def) {
      loadPark(def);
      respawn();
    }
    return park;
  },
  /** Drive one simulation step with a synthetic input, for deterministic tests. */
  drive(dt, over = {}) {
    const base = {
      steer: 0,
      charge: false,
      slide: false,
      push: false,
      trick: null,
      trickCharge: undefined,
    };
    handleEvents(ride.update(dt, { ...base, ...over }));
    return ride;
  },
  /** Run the model for `seconds` with a fixed input, at the real step size. */
  hold(seconds, over = {}) {
    const n = Math.round(seconds / C.FIXED_DT);
    for (let i = 0; i < n; i++) this.drive(C.FIXED_DT, over);
    return ride;
  },
  /** Put the board somewhere, at a speed, pointing a way. */
  place(x, z, yaw = 0, speed = 0) {
    ride.reset({ x, y: 0, z, yaw });
    ride.speed = speed;
    // The velocity has to be set too, not just the rolling speed: it is what a
    // pop launches with and what a ragdoll is thrown by.
    ride.vel.set(Math.sin(yaw) * speed, 0, Math.cos(yaw) * speed);
    chase.snap(ride);
    return ride;
  },
  /**
   * Stop the loop from stepping the simulation, while still rendering.
   *
   * Without this a screenshot taken a few hundred milliseconds after posing the
   * skater would catch them mid-landing, because the game does not stop just
   * because a test stopped driving it.
   */
  freeze() {
    state = PAUSED;
    hud.hide();
    // Put the camera on its mark immediately: the chase spring needs a couple of
    // dozen frames to settle, and a headless renderer does not have them.
    chase.snap(ride);
  },
  unfreeze() {
    state = PLAYING;
    cameraLocked = false;
    // Input is switched off by a slam and switched back on by the retry button,
    // so resuming from a test has to do what that button does.
    input.enabled = true;
    hud.hide();
  },
  /** Park the camera by hand, relative to the board, for close-up captures. */
  inspect(dx, dy, dz, lookAt = 0.85) {
    cameraLocked = true;
    camera.position.set(ride.pos.x + dx, ride.pos.y + dy, ride.pos.z + dz);
    camera.up.set(0, 1, 0);
    camera.lookAt(ride.pos.x, ride.pos.y + lookAt, ride.pos.z);
    camera.fov = 40;
    camera.updateProjectionMatrix();
  },
  /** Slam on demand, through the same path a refused landing takes. */
  slam(reason = 'slide-out') {
    ride.bail(reason);
    audio.bail();
    startBail();
    return ride;
  },
};
