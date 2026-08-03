// Fast visual iteration: load the game once, pose it at a few framings, and
// save a screenshot of each.
//
//   npx http-server /home/user -p 8080 -c-1 &
//   node tools/shot.mjs            # the standard set
//   node tools/shot.mjs 1.4        # ...with a tone-mapping exposure override
//
// The smoke suite also saves screenshots, but it runs 40-odd assertions first.
// Lighting is tuned by looking, and looking wants a two-second turnaround.

import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadChromium, GL_ARGS } from './pw.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.SMOKE_BASE || 'http://localhost:8080/kenclarkzpage';
const OUT = join(ROOT, '.smoke');
const exposure = process.argv[2] ? parseFloat(process.argv[2]) : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(OUT, { recursive: true });
const chromium = await loadChromium();
const browser = await chromium.launch({ args: GL_ARGS });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
const page = await context.newPage();
page.on('pageerror', (e) => console.log(`  pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && console.log(`  console: ${m.text()}`));

await page.goto(`${BASE}/game.html?seed=7&debug=1`, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, null, { timeout: 20000 });

if (exposure !== null) {
  await page.evaluate((e) => {
    window.__game.renderer.toneMappingExposure = e;
  }, exposure);
  console.log(`exposure override: ${exposure}`);
}

// Freezing the runner keeps each framing reproducible between runs.
const poses = [
  ['shot-open', 40],
  ['shot-corridor', 150],
  ['shot-corner', null],
];

for (const [name, dist] of poses) {
  await page.evaluate((d) => {
    const g = window.__game;
    g.start();
    if (d === null) {
      const arc = g.nextArc();
      g.teleportTo(arc.s0 - 24);
    } else {
      g.teleportTo(d);
    }
    g.player.speed = 0;
  }, dist);
  await sleep(700);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`  wrote ${name}.png`);
}

// The slide, sampled part-way through so the pose has eased in but not expired.
await page.evaluate(() => {
  const g = window.__game;
  g.start();
  g.teleportTo(40);
  g.player.slide();
});
await sleep(260);
await page.evaluate(() => {
  window.__game.player.speed = 0;
  window.__game.player.slideTimer = 999; // hold the pose for the capture
});
await sleep(200);
await page.screenshot({ path: join(OUT, 'shot-slide.png') });
console.log('  wrote shot-slide.png');

// The guardian, right on the runner's heels.
await page.evaluate(() => {
  const g = window.__game;
  g.start();
  g.teleportTo(40);
  g.startChase();
});
await sleep(1400);
await page.evaluate(() => {
  window.__game.player.speed = 0;
});
await sleep(200);
await page.screenshot({ path: join(OUT, 'shot-chase.png') });
console.log('  wrote shot-chase.png');

await browser.close();
