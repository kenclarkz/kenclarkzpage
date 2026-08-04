// Headless smoke test for the skate game.
//
//   npx http-server /home/user -p 8080 -c-1 &
//   node tools/skate-smoke.mjs
//
// Note the server root: the site is served from the /kenclarkzpage/ subpath in
// production, so it has to be served that way here too. Serving the repo root at
// / lets every absolute-path bug pass locally and 404 on GitHub Pages.
//
// Most of what follows checks physics rather than pixels, and it checks it against
// arithmetic done here in the test rather than against numbers recorded from the
// game. A ballistic apex really is v²/2g and a carve radius really is v²/g·tanθ,
// so if the model has drifted away from those the test says so — which is the
// only way a claim like "the movement is realistic" can be kept honest as the code
// changes.

import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadChromium, GL_ARGS } from './pw.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.SMOKE_BASE || 'http://localhost:8080/kenclarkzpage';
const SHOTS = process.env.SMOKE_SHOTS || join(ROOT, '.smoke');

let failures = 0;
let checks = 0;

function ok(cond, msg) {
  checks++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!cond) failures++;
}

/** Within `tol` as a fraction of the expected value. */
function near(actual, expected, tol, msg) {
  const off = Math.abs(actual - expected) / Math.max(1e-6, Math.abs(expected));
  ok(off <= tol, `${msg} (got ${actual.toFixed(3)}, expected ${expected.toFixed(3)}, ${(off * 100).toFixed(1)}% off)`);
}

function section(name) {
  console.log(`\n${name}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------------------
section('Absolute-path audit');
{
  // A leading slash works locally under a naive server and 404s on a project
  // site. This is the cheapest high-value check in the file.
  const files = [
    'skate.html',
    'sw.js',
    'css/skate.css',
    ...readdirSync(join(ROOT, 'js/skate')).map((f) => `js/skate/${f}`),
  ];
  const BAD = [/src\s*=\s*["']\//, /href\s*=\s*["']\//, /"\/[a-z]/i, /'\/[a-z]/i, /url\(\s*\//];
  const offenders = [];
  for (const f of files) {
    readFileSync(join(ROOT, f), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        const code = line.replace(/https?:\/\/\S*/g, '').replace(/\/\/.*$/, '');
        if (BAD.some((re) => re.test(code))) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
      });
  }
  ok(offenders.length === 0, `no absolute paths${offenders.length ? `\n       ${offenders.join('\n       ')}` : ''}`);
}

// --------------------------------------------------------------------------
const chromium = await loadChromium();
const browser = await chromium.launch({ args: GL_ARGS });
mkdirSync(SHOTS, { recursive: true });
const context = await browser.newContext({ viewport: { width: 900, height: 560 }, deviceScaleFactor: 1 });
const errors = [];
const page = await context.newPage();
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && errors.push(`console.error: ${m.text()}`));
page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
await page.goto(`${BASE}/skate.html?debug=1`, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__skate, null, { timeout: 20000 });

/** Run a function inside the page with the simulation under our control. */
const run = (fn, arg) => page.evaluate(fn, arg);

await run(() => {
  window.__skate.start();
  window.__skate.freeze(); // the test drives every step itself
});

// --------------------------------------------------------------------------
section('Boot');
{
  const info = await run(() => ({
    tris: window.__skate.renderer.info.render.triangles,
    calls: window.__skate.renderer.info.render.calls,
    grinds: window.__skate.park.grinds.length,
    features: window.__skate.park.features.length,
  }));
  ok(info.tris > 2000, `the park is drawing (${info.tris} triangles)`);
  // The park itself is still two merged draw calls; the rest of the count is
  // the AI skaters, the birds and the six logos, none of which are merged
  // because each one needs its own transform every frame.
  ok(info.calls <= 110, `and in a bounded number of draw calls (${info.calls})`);
  ok(info.features >= 14, `the park has its obstacles (${info.features} surfaces)`);
  ok(info.grinds >= 8, `and its grindable lines (${info.grinds})`);
}

// --------------------------------------------------------------------------
section('The surface');
{
  // A transition has to be tangent to the flat where it starts, or the bottom of
  // the ramp is a kink that stops you dead. Walk a line into the big
  // quarterpipe and check both the height and the slope stay continuous.
  const walk = await run(() => {
    const g = window.__skate;
    const out = [];
    // 1 cm samples from the flat, up the whole transition, and onto the deck.
    for (let z = 19; z <= 26; z += 0.01) out.push(+g.park.heightAt(0, z).toFixed(6));
    return out;
  });
  let maxStep = 0;
  for (let i = 1; i < walk.length; i++) maxStep = Math.max(maxStep, Math.abs(walk[i] - walk[i - 1]));
  // The lip is about 70°, which is 0.028 m per centimetre. Anything much over
  // that is a wall, not a ramp — including the join onto the deck behind it.
  ok(maxStep < 0.05, `no step anywhere up the transition or onto its deck (biggest ${maxStep.toFixed(4)} m per cm)`);

  // Tangency at the base: the first centimetre of a circular transition is
  // essentially flat, and a ramp that starts at an angle is a ramp you hit.
  const base = await run(() => {
    const g = window.__skate;
    return [g.park.heightAt(0, 19.99), g.park.heightAt(0, 20.01), g.park.heightAt(0, 20.1)];
  });
  ok(base[0] === 0, 'the flat in front of the ramp is flat');
  ok(base[1] < 0.0005, `and the ramp leaves it tangentially (${base[1].toFixed(5)} m after 1 cm)`);
  ok(base[2] > 0 && base[2] < 0.01, `and only then starts to climb (${base[2].toFixed(4)} m after 10 cm)`);
}

// --------------------------------------------------------------------------
section('Rolling');
{
  // Coasting: a skateboard on smooth concrete keeps going a long way. The check
  // is that it decays smoothly and never gains energy on the flat.
  const roll = await run(() => {
    const g = window.__skate;
    // x = -6 is a clear forty-metre lane: west of the funbox, east of the flat
    // bar, and clear of both transitions until z = 20.
    g.place(-6, -18, 0, 8);
    const samples = [];
    for (let i = 0; i < 4; i++) {
      g.hold(1);
      samples.push(g.ride.speed);
    }
    return samples;
  });
  ok(roll.every((v, i) => i === 0 || v < roll[i - 1]), `coasting only ever slows (${roll.map((v) => v.toFixed(2)).join(' → ')})`);
  ok(roll[0] < 8 && roll[0] > 7, 'and loses less than a metre per second in the first one');
  ok(roll[3] > 4, 'and still rolls after four seconds');

  // Pushing has a ceiling: legs only move so fast.
  const pushed = await run(() => {
    const g = window.__skate;
    g.place(-6, -18, 0, 0);
    // Eleven pushes, each started the moment the last cycle ends.
    for (let i = 0; i < 11; i++) {
      g.drive(1 / 120, { push: true });
      g.hold(0.56);
    }
    return g.ride.speed;
  });
  ok(pushed > 4, `pushing gets you moving (${pushed.toFixed(2)} m/s)`);
  ok(pushed < 9.2, 'and cannot push past what a leg can do');

  const rough = await run(() => {
    const g = window.__skate;
    g.place(-6, -18, 0, 6);
    const before = g.ride.speed;
    g.hold(1.5);
    const paved = g.ride.speed;
    // Well outside the park, on the dirt.
    g.place(0, 40, 0, 6);
    g.hold(1.5);
    return { paved: before - paved, dirt: before - g.ride.speed };
  });
  ok(rough.dirt > rough.paved * 2, `dirt is much slower than concrete (${rough.dirt.toFixed(2)} vs ${rough.paved.toFixed(2)} m/s lost)`);
}

// --------------------------------------------------------------------------
section('Carving');
{
  // The claim being tested: a lean of θ commits the rider to a lateral
  // acceleration of g·tanθ, so the turn radius is v²/(g·tanθ). That relation is
  // the whole steering model, and this is the check that it is still true.
  const carve = await run(() => {
    const g = window.__skate;
    const out = [];
    for (const speed of [4, 7, 10]) {
      g.place(-6, -18, 0, speed);
      g.hold(1.2, { steer: 1 }); // let the lean settle first
      const yaw0 = g.ride.yaw;
      const v = g.ride.speed;
      const lean = g.ride.lean;
      g.hold(0.5, { steer: 1 });
      const rate = Math.abs(g.ride.yaw - yaw0) / 0.5;
      out.push({ v, lean, radius: v / rate });
    }
    return out;
  });
  for (const c of carve) {
    const ideal = (c.v * c.v) / (9.81 * Math.abs(Math.tan(c.lean)));
    near(c.radius, ideal, 0.22, `at ${c.v.toFixed(1)} m/s the radius follows v²/g·tanθ`);
  }
  ok(
    carve[0].radius < carve[1].radius && carve[1].radius < carve[2].radius,
    `and a faster carve is a wider one (${carve.map((c) => c.radius.toFixed(1)).join(' < ')} m)`
  );

  // A hard carve scrubs speed. Without this, turning would be free.
  const scrub = await run(() => {
    const g = window.__skate;
    g.place(-6, -20, 0, 8);
    g.hold(1.5);
    const straight = g.ride.speed;
    g.place(-6, -20, 0, 8);
    g.hold(1.5, { steer: 1 });
    return { straight, carved: g.ride.speed };
  });
  ok(scrub.carved < scrub.straight - 0.2, `carving costs speed (${scrub.carved.toFixed(2)} vs ${scrub.straight.toFixed(2)} m/s)`);

  // A powerslide: the board is kicked across the direction of travel, so it has
  // to end up with real sideways velocity and to have scrubbed off much more
  // speed than the same turn taken on grip.
  const slide = await run(() => {
    const g = window.__skate;
    g.place(-6, -20, 0, 9);
    g.hold(0.7, { steer: 1 });
    const gripped = Math.abs(g.ride.speed);
    g.place(-6, -20, 0, 9);
    // Sampled while it is still sliding: a powerslide ends by gripping again, and
    // by then the sideways velocity it was made of has gone into the concrete.
    let side = 0;
    let slip = 0;
    for (let i = 0; i < 84; i++) {
      g.drive(1 / 120, { steer: 1, slide: true });
      side = Math.max(side, Math.abs(g.ride.side));
      const velYaw = Math.atan2(g.ride.vel.x, g.ride.vel.z);
      slip = Math.max(slip, Math.abs(velYaw - g.ride.yaw));
    }
    g.hold(0.7, { steer: 1, slide: true });
    return { gripped, slid: Math.abs(g.ride.speed), side, slip };
  });
  ok(slide.side > 0.4, `a powerslide breaks the wheels loose sideways (${slide.side.toFixed(2)} m/s)`);
  ok(slide.slid < slide.gripped - 1, `and scrubs far more speed than a carve (${slide.slid.toFixed(2)} vs ${slide.gripped.toFixed(2)} m/s)`);
  ok(slide.slip > 0.15, `with the board no longer pointing where it is going (${slide.slip.toFixed(2)} rad)`);

  // Steering right has to turn right. Screen-right is -X when travelling +Z, so
  // a right-hand steer must reduce the yaw.
  const dir = await run(() => {
    const g = window.__skate;
    g.place(-6, -20, 0, 6);
    g.hold(1.0, { steer: 1 });
    return g.ride.yaw;
  });
  ok(dir < -0.1, `steering right turns right (yaw ${dir.toFixed(2)})`);
}

// --------------------------------------------------------------------------
section('Ollies');
{
  // Pop height is set by the charge, and the launch speed by the height:
  // v = sqrt(2gh). So the apex has to come back out as h, and the air time as
  // 2v/g. If any of those three drift apart, the ollie has stopped being physics.
  const pops = await run(() => {
    const g = window.__skate;
    const out = [];
    for (const charge of [0, 0.5, 1]) {
      g.place(-6, -20, 0, 5);
      g.drive(1 / 120, { trick: 'ollie', trickCharge: charge });
      const vy = g.ride.vel.y;
      let air = 0;
      let apex = 0;
      for (let i = 0; i < 400 && g.ride.mode === 1; i++) {
        g.drive(1 / 120, {});
        air += 1 / 120;
        apex = Math.max(apex, g.ride.pos.y);
      }
      out.push({ charge, vy, apex, air, mode: g.ride.mode });
    }
    return out;
  });
  for (const p of pops) {
    near(p.apex, (p.vy * p.vy) / (2 * 9.81), 0.1, `a ${p.charge} charge reaches its ballistic apex`);
    near(p.air, (2 * p.vy) / 9.81, 0.12, `and stays up for 2v/g`);
    ok(p.mode === 0, 'and lands back on the ground');
  }
  ok(pops[2].apex > pops[0].apex * 2, `a full charge pops far higher than none (${pops[2].apex.toFixed(2)} vs ${pops[0].apex.toFixed(2)} m)`);
  ok(pops[2].apex > 0.5 && pops[2].apex < 0.8, `and a full one is a believable ollie (${pops[2].apex.toFixed(2)} m)`);

  // Holding the charge past what the legs can take costs you the pop, and tips
  // the board into a manual.
  const held = await run(() => {
    const g = window.__skate;
    g.place(-6, -20, 0, 5);
    g.hold(0.42, { charge: true });
    const atFull = g.ride.charge;
    g.hold(1.2, { charge: true });
    return { atFull, tired: g.ride.charge, manual: g.ride.manual };
  });
  ok(held.atFull > 0.9, 'the charge fills in CHARGE_TIME');
  ok(held.tired < held.atFull, `holding it too long loses it (${held.tired.toFixed(2)} vs ${held.atFull.toFixed(2)})`);
  ok(held.manual, 'and the nose comes up into a manual');
}

// --------------------------------------------------------------------------
section('Flip tricks');
{
  const flips = await run(() => {
    const g = window.__skate;
    const out = [];
    for (const id of ['kickflip', 'heelflip', 'treflip', 'shuvit', 'impossible']) {
      g.place(-6, -20, 0, 6);
      const events = [];
      g.ride.update(1 / 120, { steer: 0, charge: false, slide: false, push: false, trick: id, trickCharge: 1 });
      let landed = null;
      for (let i = 0; i < 400 && g.ride.mode === 1; i++) {
        for (const e of g.ride.update(1 / 120, { steer: 0, charge: false, slide: false, push: false })) {
          events.push(e);
        }
      }
      landed = events.find((e) => e.name === 'trick');
      const flip = events.find((e) => e.name === 'land');
      out.push({ id, name: landed?.label, points: landed?.points || 0, mode: g.ride.mode, sketchy: flip?.sketchy });
    }
    return out;
  });
  for (const f of flips) {
    ok(f.mode === 0, `a ${f.id} off a full charge lands (${f.name || 'nothing scored'})`);
    ok(f.points > 0, `and scores (${f.points})`);
    ok(!f.sketchy, 'and lands clean, not sketchy');
  }
  ok(flips.find((f) => f.id === 'treflip').points > flips.find((f) => f.id === 'kickflip').points, 'a tre flip is worth more than a kickflip');

  // Not enough air to finish the rotation has to be a slam. This is the stake
  // that makes the trick a trick.
  const short = await run(() => {
    const g = window.__skate;
    g.place(-6, -20, 0, 6);
    g.drive(1 / 120, { trick: 'treflip', trickCharge: 0 });
    for (let i = 0; i < 400 && g.ride.mode === 1; i++) g.drive(1 / 120, {});
    return { mode: g.ride.mode, reason: g.ride.bailReason };
  });
  ok(short.mode === 3, `a tre flip with no pop cannot come round in time (${short.reason})`);
  ok(short.reason === 'primo', 'and lands on the side of the board');
}

// --------------------------------------------------------------------------
section('Spins and stance');
{
  const spun = await run(() => {
    const g = window.__skate;
    g.place(-6, -20, 0, 7);
    g.drive(1 / 120, { trick: 'ollie', trickCharge: 1 });
    // Hold the stick over for the whole flight: about 180° at SPIN_RATE.
    const events = [];
    for (let i = 0; i < 400 && g.ride.mode === 1; i++) {
      for (const e of g.ride.update(1 / 120, { steer: -1, charge: false, slide: false, push: false })) events.push(e);
    }
    const t = events.find((e) => e.name === 'trick');
    return { mode: g.ride.mode, name: t?.label, fakie: g.ride.fakie, speed: g.ride.speed };
  });
  ok(spun.mode === 0, `a spin lands (${spun.name || 'nothing'})`);
  ok(/180|360/.test(spun.name || ''), 'and is named for how far it went round');
  ok(spun.fakie === spun.speed < 0, 'and a half turn leaves the rider rolling fakie');
}

// --------------------------------------------------------------------------
section('Transitions');
{
  // Riding a quarterpipe: up costs speed, down gives it back, and the round trip
  // must never give back more than it took. A ramp that creates energy is the
  // classic height-field bug.
  const pump = await run(() => {
    const g = window.__skate;
    g.place(0, 12, 0, 6);
    let apex = 0;
    for (let i = 0; i < 1200; i++) {
      g.drive(1 / 120, {});
      apex = Math.max(apex, g.ride.pos.y);
      if (g.ride.pos.z < 12 && g.ride.pos.y < 0.02 && i > 200) break;
    }
    return { apex, back: Math.abs(g.ride.speed), mode: g.ride.mode, z: g.ride.pos.z };
  });
  ok(pump.apex > 0.55, `the ramp is rideable (up to ${pump.apex.toFixed(2)} m)`);
  ok(pump.back < 6, `and gives back less than it took (${pump.back.toFixed(2)} of 6 m/s)`);
  ok(pump.back > 3.4, 'but most of it, so a transition is worth riding');

  // Fast enough into it and you fly out of the lip, which should be a real
  // launch rather than a hop: the board should get well above the coping.
  const launch = await run(() => {
    const g = window.__skate;
    g.place(0, 8, 0, 11);
    let apex = 0;
    let air = 0;
    let wasAir = false;
    let onLanding = null;
    for (let i = 0; i < 900; i++) {
      g.drive(1 / 120, {});
      if (g.ride.mode === 1) {
        air += 1 / 120;
        wasAir = true;
      } else if (wasAir && onLanding === null && g.ride.mode === 0) {
        onLanding = { speed: Math.abs(g.ride.speed), y: g.ride.pos.y, z: g.ride.pos.z };
      }
      apex = Math.max(apex, g.ride.pos.y);
    }
    return { apex, air, mode: g.ride.mode, onLanding };
  });
  ok(launch.apex > 2.0, `speed into the lip becomes air (${launch.apex.toFixed(2)} m up)`);
  ok(launch.air > 0.4, `with real time in it (${launch.air.toFixed(2)} s)`);
  // A lip that steep throws you out over the deck rather than back into the
  // ramp, so the deck has to be deep enough to come down on.
  ok(
    launch.onLanding && launch.onLanding.y > 1.4,
    `and comes down on the deck, not in the dirt behind it (y ${(launch.onLanding?.y || 0).toFixed(2)} at z ${(launch.onLanding?.z || 0).toFixed(1)})`
  );
  // Two and a half metres to flat concrete is a sketchy landing and is supposed
  // to cost speed — but it is a landing, not a slam.
  ok(launch.mode !== 3, 'and the landing is not refused');
  ok(launch.onLanding && launch.onLanding.speed > 1.2, `though it costs most of the speed (${(launch.onLanding?.speed || 0).toFixed(2)} m/s left)`);

  // Dropping in off the deck: a fall onto a steep surface, which is the case a
  // vertical-impact test would wrongly call a slam.
  const dropIn = await run(() => {
    const g = window.__skate;
    g.place(0, 24, Math.PI, 1.5); // on the deck, rolling at the lip
    let bailed = false;
    let fastest = 0;
    for (let i = 0; i < 700; i++) {
      g.drive(1 / 120, {});
      if (g.ride.mode === 3) bailed = true;
      if (g.ride.mode === 0) fastest = Math.max(fastest, Math.abs(g.ride.speed));
    }
    return { bailed, fastest, reason: g.ride.bailReason };
  });
  ok(!dropIn.bailed, `dropping in off the deck is not a slam (${dropIn.reason || 'rode away'})`);
  ok(dropIn.fastest > 4, `and the drop becomes speed (${dropIn.fastest.toFixed(2)} m/s at the bottom)`);
}

// --------------------------------------------------------------------------
section('Grinds and manuals');
{
  const grind = await run(() => {
    const g = window.__skate;
    // Straight down the flat bar, ollie onto it.
    g.place(-10, -7, 0, 6.5);
    g.drive(1 / 120, { trick: 'ollie', trickCharge: 0.55 });
    let locked = null;
    for (let i = 0; i < 240 && !locked; i++) {
      for (const e of g.ride.update(1 / 120, { steer: 0, charge: false, slide: false, push: false })) {
        if (e.name === 'grindStart') locked = e.name;
      }
    }
    const before = g.ride.speed;
    // Hold the balance with a correction against the drift.
    let bailed = false;
    for (let i = 0; i < 120; i++) {
      const steer = -Math.sign(g.ride.balance + g.ride.balanceVel * 0.3) * 0.8;
      g.drive(1 / 120, { steer });
      if (g.ride.mode === 3) bailed = true;
    }
    return {
      locked: !!locked,
      mode: g.ride.mode,
      name: g.ride.grind?.label,
      points: g.ride.grind?.points || 0,
      slowed: before - Math.abs(g.ride.speed),
      bailed,
      y: g.ride.pos.y,
    };
  });
  ok(grind.locked, 'an ollie into a rail locks on');
  ok(grind.mode === 2, `and stays on it (${grind.name})`);
  ok(grind.y > 0.3, `at the height of the rail (${grind.y.toFixed(2)} m)`);
  ok(grind.slowed > 0.5, `and grinding scrubs speed (${grind.slowed.toFixed(2)} m/s)`);
  ok(grind.points > 20, `and pays by the metre (${Math.round(grind.points)})`);

  // Left alone, balance always goes. That is what makes it a balance meter and
  // not an ornament.
  const dropped = await run(() => {
    const g = window.__skate;
    g.place(-10, -7, 0, 6.5);
    g.drive(1 / 120, { trick: 'ollie', trickCharge: 0.55 });
    for (let i = 0; i < 240 && g.ride.mode !== 2; i++) g.drive(1 / 120, {});
    const on = g.ride.mode === 2;
    let steps = 0;
    while (g.ride.mode === 2 && steps < 1200) {
      g.drive(1 / 120, {});
      steps++;
    }
    return { on, mode: g.ride.mode, reason: g.ride.bailReason, seconds: steps / 120 };
  });
  ok(dropped.on, 'a grind with no correction at all');
  ok(dropped.mode !== 2, `does not last (${dropped.seconds.toFixed(2)} s, ${dropped.reason || 'ran off the end'})`);

  const manual = await run(() => {
    const g = window.__skate;
    g.place(-6, -20, 0, 5);
    g.hold(0.7, { charge: true });
    const started = g.ride.manual;
    let dist = 0;
    let pitch = 0;
    let lift = 0;
    for (let i = 0; i < 300 && g.ride.manual; i++) {
      const steer = -Math.sign(g.ride.balance + g.ride.balanceVel * 0.3) * 0.7;
      g.drive(1 / 120, { steer, charge: true });
      dist = g.ride.manualDist;
      // Read while the tail is actually down: letting go puts the nose back.
      pitch = g.ride.state.deckPitch;
      lift = g.ride.state.deckLift;
    }
    const events = g.ride.update(1 / 120, { steer: 0, charge: false, slide: false, push: false });
    return { started, dist, pitch, lift, banked: events.find((e) => e.name === 'manualEnd') };
  });
  ok(manual.started, 'holding the charge presses the tail into a manual');
  // A nose-up deck pivots on its back axle, so it has to rise by half a wheelbase
  // of that angle or the rear wheels end up inside the concrete.
  near(
    manual.lift,
    Math.sin(manual.pitch) * 0.18,
    0.06,
    'and the deck rises by what pivoting on the back axle costs'
  );
  ok(manual.dist > 1, `and it can be held (${manual.dist.toFixed(1)} m)`);
  ok(!!manual.banked, `and letting go scores it (${manual.banked?.points || 0})`);
}

// --------------------------------------------------------------------------
section('Slams');
{
  const wall = await run(() => {
    const g = window.__skate;
    // Straight into the bottom step of the stair set.
    g.place(18, 1, 0, 7);
    for (let i = 0; i < 600 && g.ride.mode !== 3; i++) g.drive(1 / 120, {});
    return { mode: g.ride.mode, reason: g.ride.bailReason };
  });
  ok(wall.mode === 3, `rolling into a step at speed is a slam (${wall.reason})`);

  const kerb = await run(() => {
    const g = window.__skate;
    g.place(18, 1, 0, 1.0);
    for (let i = 0; i < 600; i++) g.drive(1 / 120, {});
    return { mode: g.ride.mode, speed: g.ride.speed };
  });
  ok(kerb.mode === 0 && Math.abs(kerb.speed) < 0.2, 'but rolling into one slowly just stops you');

  const drop = await run(() => {
    const g = window.__skate;
    // Off the top of the stair-set platform, which is a 1.25 m drop.
    g.place(18, 10, Math.PI, 9);
    let bailed = false;
    for (let i = 0; i < 900; i++) {
      g.drive(1 / 120, {});
      if (g.ride.mode === 3) bailed = true;
    }
    return { bailed, mode: g.ride.mode };
  });
  ok(!drop.bailed, 'a 1.25 m drop taken straight is landable');

  const ragdoll = await run(() => {
    const g = window.__skate;
    g.place(0, -14, 0, 8);
    g.slam('slide-out');
    for (let i = 0; i < 400; i++) g.ragdoll.step(1 / 120);
    const pts = g.ragdoll.points;
    let lowest = Infinity;
    let spread = 0;
    for (const p of pts) {
      lowest = Math.min(lowest, p.p.y);
      spread = Math.max(spread, p.p.distanceTo(g.ragdoll.named.pelvis.p));
    }
    return { lowest, spread, settled: g.ragdoll.settled, n: pts.length };
  });
  ok(ragdoll.n === 15, `the ragdoll has its joints (${ragdoll.n})`);
  ok(ragdoll.lowest > -0.02, `and none of them ends up under the concrete (${ragdoll.lowest.toFixed(3)} m)`);
  ok(ragdoll.spread < 1.3, `and it still holds together (${ragdoll.spread.toFixed(2)} m from the hips)`);
  ok(ragdoll.settled > 0.2, 'and it comes to rest');
}

// --------------------------------------------------------------------------
section('Scoring');
{
  const combo = await run(() => {
    const g = window.__skate;
    g.place(-6, -22, 0, 7);
    const events = [];
    const push = (list) => {
      for (const e of list) events.push(e);
    };
    // Two flips in a row, then roll away and let the combo bank.
    for (const id of ['kickflip', 'heelflip']) {
      push(g.ride.update(1 / 120, { steer: 0, charge: false, slide: false, push: false, trick: id, trickCharge: 1 }));
      for (let i = 0; i < 400 && g.ride.mode === 1; i++) {
        push(g.ride.update(1 / 120, { steer: 0, charge: false, slide: false, push: false }));
      }
      // Land, then straight into the next one.
      for (let i = 0; i < 30; i++) push(g.ride.update(1 / 120, { steer: 0, charge: false, slide: false, push: false }));
    }
    for (let i = 0; i < 300; i++) push(g.ride.update(1 / 120, { steer: 0, charge: false, slide: false, push: false }));
    const tricks = events.filter((e) => e.name === 'trick');
    const banked = events.find((e) => e.name === 'combo');
    return { tricks: tricks.map((t) => t.label), banked };
  });
  ok(combo.tricks.length === 2, `two tricks link into one combo (${combo.tricks.join(' + ')})`);
  ok(!!combo.banked, 'and the combo banks once the skater rolls away');
  ok(combo.banked?.multiplier === 2, `with a multiplier for the chain (×${combo.banked?.multiplier})`);
  ok(
    combo.banked && combo.banked.total === combo.banked.points * combo.banked.multiplier,
    'and the total is the chain times the multiplier'
  );

  const lost = await run(() => {
    const g = window.__skate;
    g.place(-6, -22, 0, 7);
    g.drive(1 / 120, { trick: 'kickflip', trickCharge: 1 });
    for (let i = 0; i < 400 && g.ride.mode === 1; i++) g.drive(1 / 120, {});
    const live = g.ride.combo.points;
    const events = [];
    g.ride.bail('slide-out');
    return { live, points: g.ride.combo.points, lost: g.ride.events.some((e) => e.name === 'comboLost'), events };
  });
  ok(lost.live > 0 && lost.points === 0, 'and a slam takes the whole thing away');
}

// --------------------------------------------------------------------------
section('Flick-It');
{
  // The gesture classifier, exercised directly: these are the angles a thumb
  // actually leaves at, and the mapping has to be stable.
  const map = await run(async () => {
    const { classify } = await import('./js/skate/input.js');
    const at = (deg, curl = 0) => classify((deg * Math.PI) / 180, curl);
    return {
      up: at(90),
      upLeft: at(150),
      upRight: at(30),
      left: at(185),
      leftNeg: at(-178),
      right: at(0),
      down: at(-100),
      curlLeft: at(90, -1),
      curlRight: at(90, 1),
    };
  });
  ok(map.up === 'ollie', 'flick up is an ollie');
  ok(map.upLeft === 'kickflip', 'up and left is a kickflip');
  ok(map.upRight === 'heelflip', 'up and right is a heelflip');
  ok(map.left === 'shuvit' && map.leftNeg === 'shuvit', 'straight left is a shove-it, from either side of 180°');
  ok(map.right === 'fsshuvit', 'straight right is a frontside shove-it');
  ok(map.curlLeft === 'treflip', 'a quarter circle into up is a 360 flip');
  ok(map.curlRight === 'varialheel', 'and the other way is a varial heelflip');
  ok(map.down === null, 'and flicking down does nothing');

  // Then the same thing through a real drag, on the element that ships.
  const dragged = await run(() => {
    // respawn(), not place(): the slam section left the rider parented to the
    // scene behind a live ragdoll, and only respawn puts them back on the board.
    window.__skate.respawn();
    window.__skate.unfreeze();
    window.__skate.place(-6, -18, 0, 6);
    window.__skate.input.clear();
    return true;
  });
  ok(dragged, 'the game is live for a real gesture');
  const w = 900;
  await page.mouse.move(w * 0.7, 300);
  await page.mouse.down();
  await page.mouse.move(w * 0.7, 380, { steps: 6 }); // pull back
  await sleep(120);
  await page.mouse.move(w * 0.62, 300, { steps: 6 }); // flick up and left
  await page.mouse.up();
  await sleep(500);
  const flicked = await run(() => ({
    tricks: window.__skate.save.tricks,
    mode: window.__skate.ride.mode,
    best: window.__skate.save.bestTrick,
  }));
  ok(flicked.mode !== 0 || flicked.tricks > 0, `a mouse drag pops a trick (mode ${flicked.mode}, ${flicked.tricks} landed)`);
}

// --------------------------------------------------------------------------
section('Parks');
{
  const info = await run(() => {
    const g = window.__skate;
    return { count: g.parks.length, ids: g.parks.map((p) => p.id), current: g.park.id };
  });
  ok(info.count === 6, `there are six parks (${info.count})`);
  ok(new Set(info.ids).size === info.count, 'each with a distinct id');
  ok(info.current === 'home', 'and the game boots into Home Park');

  // Every map needs a rideable spawn, a patrol loop the AI can actually
  // follow, and six logos — checked by actually loading each of the six in
  // turn, since `parks` is the raw list of definitions and only the live
  // `park` — the one switchPark just built — has a height field to query.
  const shapes = await run(() =>
    window.__skate.parks.map((def) => {
      const p = window.__skate.switchPark(def.id);
      return {
        id: p.id,
        onSurface: Math.abs(p.heightAt(p.spawn.x, p.spawn.z)) < 5,
        patrol: p.patrol.length,
        logos: p.logos.length,
        grinds: p.grinds.length,
      };
    })
  );
  for (const s of shapes) {
    ok(s.onSurface, `${s.id}: the spawn sits on a real surface`);
    ok(s.patrol >= 4, `${s.id}: a patrol loop with real waypoints (${s.patrol})`);
    ok(s.logos === 6, `${s.id}: six logos (${s.logos})`);
    ok(s.grinds >= 1, `${s.id}: at least one grindable line (${s.grinds})`);
  }

  // Switching parks has to move the live ride onto the new map's spawn, not
  // just swap the object reference out from under it.
  const switched = await run(() => {
    const g = window.__skate;
    g.switchPark('bowl');
    return { id: g.park.id, y: g.ride.pos.y, spawnY: g.park.heightAt(g.park.spawn.x, g.park.spawn.z) };
  });
  ok(switched.id === 'bowl', 'switchPark loads the requested map');
  near(switched.y, switched.spawnY, 0.02, 'and drops the rider on its own spawn');
  await run(() => window.__skate.switchPark('home'));
}

// --------------------------------------------------------------------------
section('AI skaters');
{
  const count = await run(() => window.__skate.bots.length);
  ok(count === 3, `three AI skaters roam the park (${count})`);

  // Give them real simulated time and see that they actually cover ground —
  // not just idle on their spawn point waiting for a player who never drives
  // them, and not stuck against the first thing they roll into either.
  const moved = await run(() => {
    const g = window.__skate;
    const before = g.bots.map((b) => ({ x: b.ride.pos.x, z: b.ride.pos.z }));
    for (let i = 0; i < 600; i++) for (const b of g.bots) b.step(1 / 120);
    return before.map((p, i) => Math.hypot(g.bots[i].ride.pos.x - p.x, g.bots[i].ride.pos.z - p.z));
  });
  ok(moved.every((d) => d > 1), `every bot covers real ground in 5 s (${moved.map((d) => d.toFixed(1)).join(', ')} m)`);
}

// --------------------------------------------------------------------------
section('Birds');
{
  const count = await run(() => window.__skate.birds.length);
  ok(count === 3, `three birds circle the park (${count})`);

  const flight = await run(() => {
    const g = window.__skate;
    const b = g.birds[0];
    b.update(0);
    const y0 = b.group.position.y;
    const p0 = b.group.position.clone();
    b.update(3);
    return { dist: p0.distanceTo(b.group.position), y0, y1: b.group.position.y };
  });
  ok(flight.dist > 1, `a bird moves along its circuit (${flight.dist.toFixed(2)} m in 3 s)`);
  ok(flight.y0 > 3 && flight.y1 > 3, 'and stays well above the park throughout');
}

// --------------------------------------------------------------------------
section('Collectibles');
{
  const before = await run(() => {
    const g = window.__skate;
    g.switchPark('home');
    g.start();
    return { logos: g.logos.length, saved: g.save.logos };
  });
  ok(before.logos === 6, `home park has six logos to find (${before.logos})`);

  await run(() => {
    const g = window.__skate;
    const l = g.logos[0];
    g.place(l.x, l.z, 0, 0);
  });
  await sleep(250); // real time, so the live loop's own pickup check runs it
  const picked = await run(() => ({
    collected: window.__skate.logos[0].collected,
    saved: window.__skate.save.logos,
  }));
  ok(picked.collected, 'rolling onto a logo collects it');
  ok(picked.saved === before.saved + 1, 'and it is recorded for good');

  const cleared = await run(() => {
    const g = window.__skate;
    g.switchPark('bowl');
    g.switchPark('home');
    return g.logos.every((l) => !l.collected);
  });
  ok(cleared, 'and a fresh load of the park puts them all back');
}

// --------------------------------------------------------------------------
section('Push gesture (touch and mouse)');
{
  const before = await run(() => {
    const g = window.__skate;
    g.unfreeze();
    g.place(-6, -18, 0, 0);
    return g.ride.speed;
  });
  const w = 900;
  const h = 560;
  // Left half of the screen, dragged straight down — the gesture that replaced
  // a tap, so pushing off does not need lifting the thumb between kicks.
  await page.mouse.move(w * 0.25, h * 0.4);
  await page.mouse.down();
  await page.mouse.move(w * 0.25, h * 0.4 + 60, { steps: 6 });
  await sleep(150);
  await page.mouse.up();
  await sleep(150);
  const after = await run(() => window.__skate.ride.speed);
  ok(before === 0 && after > 0.3, `sliding down the steering side pushes (0 → ${after.toFixed(2)} m/s)`);
}

// --------------------------------------------------------------------------
section('Tutorial and menus');
{
  const tut = await run(() => {
    const g = window.__skate;
    g.hud.show('guide');
    const first = { step: g.hud.tutStep, prevDisabled: g.hud.tutPrev.disabled, nextLabel: g.hud.tutNext.textContent };
    for (let i = 0; i < 30; i++) g.hud.showTutStep(g.hud.tutStep + 1); // walk well past the end
    const last = { step: g.hud.tutStep, nextLabel: g.hud.tutNext.textContent };
    g.hud.showTutStep(0);
    return { first, last, dots: g.hud.tutDotEls.length };
  });
  ok(tut.first.step === 0, 'the tutorial opens on its first step');
  ok(tut.first.prevDisabled, 'with no way to go back further than that');
  ok(tut.dots >= 8, `and covers every move in its own step (${tut.dots} steps)`);
  ok(tut.last.step === tut.dots - 1, 'stepping past the end just holds on the last one');
  ok(tut.last.nextLabel.toLowerCase().includes('ride'), 'which offers to start the run instead of another step');

  const picker = await run(() => {
    const g = window.__skate;
    g.hud.renderParks(g.parks, g.park.id);
    const cards = [...g.hud.parkGrid.querySelectorAll('[data-park]')];
    return { count: cards.length, ids: cards.map((c) => c.dataset.park) };
  });
  ok(picker.count === 6, `the park picker lists all six maps (${picker.count})`);
  const known = await run(() => window.__skate.parks.map((p) => p.id));
  ok(
    picker.ids.every((id) => known.includes(id)),
    'and every card points at a real map'
  );
}

// --------------------------------------------------------------------------
section('The loop and the page');
{
  await run(() => {
    window.__skate.unfreeze();
    window.__skate.respawn();
  });
  const before = await run(() => window.__skate.frames);
  await sleep(1200);
  const after = await run(() => window.__skate.frames);
  ok(after > before + 3, `the render loop runs (${after - before} frames in 1.2 s)`);

  // Keyboard: hold the charge, release, and expect to be off the ground.
  await run(() => {
    window.__skate.place(-6, -18, 0, 6);
  });
  await page.keyboard.down('Space');
  await sleep(420);
  await page.keyboard.up('Space');
  await sleep(120);
  const airborne = await run(() => window.__skate.ride.mode);
  ok(airborne === 1, 'space bar loads and releases into an ollie');

  const hudText = await page.evaluate(() => document.getElementById('score')?.textContent);
  ok(typeof hudText === 'string', 'the HUD is wired up');

  // index.html pulls jQuery and Google Maps off CDNs this sandbox cannot reach,
  // so its console noise is checked for separately from the game's.
  const gameErrors = errors.slice();
  await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });
  const linked = await page.$$eval('a[href="skate.html"]', (a) => a.length);
  ok(linked > 0, 'index.html links to the skate game');
  errors.length = 0;
  errors.push(...gameErrors);

  const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  const missing = readdirSync(join(ROOT, 'js/skate'))
    .map((f) => `js/skate/${f}`)
    .filter((f) => !sw.includes(f));
  ok(missing.length === 0, `every skate module is precached${missing.length ? `: missing ${missing.join(', ')}` : ''}`);
  ok(sw.includes('skate.html') && sw.includes('css/skate.css'), 'and so are the page and its stylesheet');
}

await page.goto(`${BASE}/skate.html?debug=1`, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__skate, null, { timeout: 20000 });
await run(() => {
  window.__skate.start();
  window.__skate.place(0, -16, 0, 6);
});
await sleep(600);
await page.screenshot({ path: join(SHOTS, 'skate-smoke.png') });

ok(errors.length === 0, `no page errors${errors.length ? `\n       ${errors.join('\n       ')}` : ''}`);

await browser.close();

console.log('');
if (failures) {
  console.error(`${failures} of ${checks} checks FAILED`);
  process.exit(1);
}
console.log(`all ${checks} checks passed  (screenshots in ${relative(ROOT, SHOTS) || SHOTS})`);
