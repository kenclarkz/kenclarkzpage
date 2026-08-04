// Fast visual iteration for the skate game: load it once, pose the skater at a
// few moments that matter, and save a screenshot of each.
//
//   npx http-server /home/user -p 8080 -c-1 &
//   node tools/skate-shot.mjs
//
// The poses here are chosen to be the ones that break: a ride stance (is the
// stance right?), mid-ollie (does the board pitch under the feet?), mid-kickflip
// (has the rider's body stayed put while the board goes round?), a grind (is the
// deck on the rail?), a push (is the foot on the ground?) and a slam.

import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadChromium, GL_ARGS } from './pw.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.SMOKE_BASE || 'http://localhost:8080/kenclarkzpage';
const OUT = join(ROOT, '.smoke');
const only = process.argv[2];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(OUT, { recursive: true });
const chromium = await loadChromium();
const browser = await chromium.launch({ args: GL_ARGS });
const context = await browser.newContext({
  viewport: { width: 900, height: 560 },
  deviceScaleFactor: 1,
});
const page = await context.newPage();
page.on('pageerror', (e) => console.log(`  pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && console.log(`  console: ${m.text()}`));

await page.goto(`${BASE}/skate.html?debug=1`, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__skate, null, { timeout: 20000 });
await page.evaluate(() => window.__skate.start());

/** Each shot: a name, and a function run in the page to set the moment up. */
const shots = {
  'ride': () => {
    const g = window.__skate;
    g.place(0, -14, 0, 5.5);
    g.hold(1.2);
  },
  'carve': () => {
    const g = window.__skate;
    g.place(0, -16, 0, 7);
    g.hold(1.4, { steer: 1 });
  },
  'push': () => {
    const g = window.__skate;
    g.place(0, -16, 0, 2.4);
    g.drive(1 / 120, { push: true });
    g.hold(0.26);
  },
  'charge': () => {
    const g = window.__skate;
    g.place(0, -14, 0, 5);
    g.hold(0.42, { charge: true });
  },
  'ollie': () => {
    const g = window.__skate;
    g.place(0, -14, 0, 5);
    g.hold(0.4, { charge: true });
    g.drive(1 / 120, { trick: 'ollie' });
    g.hold(0.14);
  },
  'kickflip': () => {
    const g = window.__skate;
    g.place(0, -14, 0, 5);
    g.hold(0.4, { charge: true });
    g.drive(1 / 120, { trick: 'kickflip' });
    g.hold(0.2);
  },
  'manual': () => {
    const g = window.__skate;
    g.place(0, -14, 0, 4);
    g.hold(0.9, { charge: true });
  },
  'grind': () => {
    const g = window.__skate;
    // Roll at the flat bar, ollie, and let the board find it.
    g.place(-10, -8, 0, 6.5);
    g.hold(0.3, { charge: true });
    g.drive(1 / 120, { trick: 'ollie' });
    g.hold(1.1);
  },
  'transition': () => {
    const g = window.__skate;
    g.place(0, 14, 0, 8.5);
    g.hold(1.0);
  },
  'air': () => {
    const g = window.__skate;
    // Straight at the big quarterpipe, fast enough to fly out of the lip.
    g.place(0, 10, 0, 11);
    g.hold(1.5);
  },
  'bail': () => {
    const g = window.__skate;
    g.place(0, -14, 0, 8);
    g.slam('slide-out');
  },
  // A slam out of the air, caught while the rider is still coming down.
  'bail-air': () => {
    const g = window.__skate;
    g.place(0, -14, 0, 8);
    g.drive(1 / 120, { trick: 'treflip', trickCharge: 1 });
    g.hold(0.25);
    g.slam('primo');
  },
  'menu': () => {
    window.__skate.hud.show('start');
  },
  'guide': () => {
    window.__skate.hud.show('guide');
  },
};

/** Shots that want the sim left running after they are set up. */
const LIVE = new Set(['bail', 'bail-air']);
/** ...and shots that must not be frozen, because freezing hides the overlay. */
const NO_FREEZE = new Set([...LIVE, 'menu', 'guide']);

/**
 * Close-up framings, for reading the rig rather than the park. The offsets are
 * relative to the board, and the pose was already frozen by the time they apply.
 */
const CLOSE = {
  ride: [2.0, 1.0, 1.3, 0.85],
  carve: [2.2, 1.0, 1.2, 0.85],
  // From the toe side, because that is the side the pushing foot goes down on,
  // and framed low so the planted foot is not behind the debug panel.
  push: [-2.4, 1.5, 0.9, 0.45],
  charge: [2.0, 0.9, 1.2, 0.8],
  ollie: [2.2, 1.1, 1.2, 0.85],
  kickflip: [1.8, 1.0, 1.6, 0.85],
  manual: [2.2, 1.0, 1.2, 0.8],
  grind: [2.4, 1.1, 1.4, 0.85],
  feet: [-1.5, 1.2, 0.5, 0.3],
};

for (const [name, fn] of Object.entries(shots)) {
  if (only && name !== only) continue;
  await page.evaluate(() => window.__skate.unfreeze());
  await page.evaluate(fn);
  // Freeze first, or the game's own loop carries on for the whole of the sleep
  // below and every shot ends up being of a skater rolling along the flat.
  if (!NO_FREEZE.has(name)) await page.evaluate(() => window.__skate.freeze());
  // Let the render loop and the camera spring catch up with the new pose.
  await sleep(LIVE.has(name) ? (name === 'bail-air' ? 380 : 900) : 300);
  await page.screenshot({ path: join(OUT, `skate-${name}.png`) });
  if (CLOSE[name]) {
    await page.evaluate((o) => window.__skate.inspect(o[0], o[1], o[2], o[3]), CLOSE[name]);
    await sleep(140);
    await page.screenshot({ path: join(OUT, `skate-${name}-close.png`) });
  }
  const info = await page.evaluate(() => {
    const r = window.__skate.ride;
    return `${['ground', 'air', 'grind', 'bail'][r.mode]} v=${r.speed.toFixed(2)} y=${r.pos.y.toFixed(2)}`;
  });
  console.log(`  ${name.padEnd(12)} ${info}`);
}

await browser.close();
