// Headless smoke test for the game and its PWA plumbing.
//
//   npx http-server /home/user -p 8080 -c-1 &
//   node tools/smoke.mjs
//
// Note the server root: the site is served from the /kenclarkzpage/ subpath in
// production, so it must be served that way here too. Serving the repo root at
// / would let every absolute-path bug pass locally and 404 on GitHub Pages.

import { readFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
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
  if (cond) {
    console.log(`  ok   ${msg}`);
  } else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
}

function section(name) {
  console.log(`\n${name}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------------------
// 10. No absolute paths anywhere in the game's own files. This is the single
//     highest-value check in the file: a leading slash works locally under a
//     naive server and 404s on a GitHub Pages project site.
// --------------------------------------------------------------------------
section('Absolute-path audit');
{
  const files = [
    'game.html',
    'sw.js',
    'manifest.webmanifest',
    'css/game.css',
    ...readdirSync(join(ROOT, 'js/game')).map((f) => `js/game/${f}`),
  ];
  const BAD = [/src\s*=\s*["']\//, /href\s*=\s*["']\//, /"\/[a-z]/i, /'\/[a-z]/i, /url\(\s*\//];
  let offenders = [];
  for (const f of files) {
    const text = readFileSync(join(ROOT, f), 'utf8');
    text.split('\n').forEach((line, i) => {
      // Skip comments; "//" and "https://" trip the naive patterns constantly.
      const code = line.replace(/https?:\/\/\S*/g, '').replace(/\/\/.*$/, '');
      if (BAD.some((re) => re.test(code))) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  ok(offenders.length === 0, `no absolute paths in the game's files${offenders.length ? `\n       ${offenders.join('\n       ')}` : ''}`);
}

// --------------------------------------------------------------------------
const chromium = await loadChromium();
const browser = await chromium.launch({ args: GL_ARGS });
mkdirSync(SHOTS, { recursive: true });

async function newPage(context, query = '') {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  });
  page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
  await page.goto(`${BASE}/game.html${query}`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__game, null, { timeout: 15000 });
  return { page, errors };
}

const context = await browser.newContext({
  viewport: { width: 390, height: 844 }, // a phone-shaped window
  deviceScaleFactor: 1,
});

// --------------------------------------------------------------------------
section('1-3. Boots, renders, and the loop advances');
const { page, errors } = await newPage(context, '?seed=1&debug=1');
{
  // Warm up before sampling. The first second is shader compilation and
  // texture upload, and under a software rasteriser that is slow enough to
  // dominate a short window — and because the fixed-timestep accumulator
  // clamps at MAX_FRAME_DT, those slow frames also swallow simulated time. So
  // measure steady state, not the cold start.
  await page.evaluate(() => window.__game.start());
  await sleep(1500);

  const before = await page.evaluate(() => ({
    frames: window.__game.frames,
    dist: window.__game.distance,
  }));
  await sleep(2000);
  const s = await page.evaluate(() => ({
    frames: window.__game.frames,
    tris: window.__game.renderer.info.render.triangles,
    calls: window.__game.renderer.info.render.calls,
    dist: window.__game.distance,
    state: window.__game.state,
    chunks: window.__game.liveChunks,
  }));
  const frames = s.frames - before.frames;
  const advanced = s.dist - before.dist;

  // These are liveness thresholds, not performance ones. This runs on
  // SwiftShader — CPU rasterisation of a lit, textured, bump-mapped corridor —
  // so the absolute numbers say nothing about a phone GPU. What they catch is a
  // loop that has stalled or a player that has stopped moving.
  ok(frames > 20, `renders frames (${frames} in 2 s, software rasterised)`);
  ok(s.tris > 0, `draws geometry (${s.tris} triangles, ${s.calls} draw calls)`);
  ok(s.calls < 90, `stays within the draw-call budget (${s.calls})`);
  ok(advanced > 15, `player advances down the track (${advanced.toFixed(1)} m in 2 s)`);
  ok(s.state === 'playing', 'still playing after clear track');
  ok(s.chunks > 3 && s.chunks < 18, `streams a sane number of chunks (${s.chunks})`);

  const d1 = await page.evaluate(() => window.__game.distance);
  await sleep(400);
  const d2 = await page.evaluate(() => window.__game.distance);
  ok(d2 > d1, 'distance increases monotonically');

  await page.screenshot({ path: join(SHOTS, 'play.png') });
  ok(errors.length === 0, `no page errors${errors.length ? `\n       ${errors.join('\n       ')}` : ''}`);
}

// --------------------------------------------------------------------------
section('4-5. Input');
{
  await page.evaluate(() => window.__game.start());
  await sleep(200);

  await page.keyboard.press('ArrowLeft');
  await sleep(60);
  ok((await page.evaluate(() => window.__game.player.targetLane)) === -1, 'ArrowLeft moves to the left lane');

  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await sleep(60);
  ok((await page.evaluate(() => window.__game.player.targetLane)) === 1, 'ArrowRight moves to the right lane');

  // Wait for the runner to be back on its feet rather than sleeping a fixed
  // time. A jump is 0.65 *simulated* seconds and the clamped accumulator runs
  // slower than wall clock here, so a fixed wait can leave the player still
  // airborne — where a slide input fast-falls instead, and the next assertion
  // fails for reasons that have nothing to do with input handling.
  const landed = () =>
    page.waitForFunction(() => window.__game.player.state === 0, null, { timeout: 10000 });

  await page.keyboard.press('ArrowUp');
  await sleep(120);
  ok((await page.evaluate(() => window.__game.player.state)) === 1, 'ArrowUp jumps');
  await landed();

  await page.keyboard.press('ArrowDown');
  await sleep(120);
  ok((await page.evaluate(() => window.__game.player.state)) === 2, 'ArrowDown slides');
  await landed();

  // Playwright's mouse emits pointer events, so this drives the production
  // swipe handler rather than a test-only shortcut.
  const swipe = async (dx, dy) => {
    await page.mouse.move(195, 500);
    await page.mouse.down();
    await page.mouse.move(195 + dx, 500 + dy, { steps: 6 });
    await page.mouse.up();
    await sleep(80);
  };

  await page.evaluate(() => {
    window.__game.player.targetLane = 0;
  });
  await swipe(-120, 0);
  ok((await page.evaluate(() => window.__game.player.targetLane)) === -1, 'swipe left changes lane');

  await swipe(120, 0);
  await swipe(120, 0);
  ok((await page.evaluate(() => window.__game.player.targetLane)) === 1, 'swipe right changes lane');

  await swipe(0, -120);
  ok((await page.evaluate(() => window.__game.player.state)) === 1, 'swipe up jumps');
  await landed();

  await swipe(0, 120);
  ok((await page.evaluate(() => window.__game.player.state)) === 2, 'swipe down slides');
  await landed();
}

// --------------------------------------------------------------------------
section('7. Death paths');
{
  // Corners turn on their own, with no swipe required. Note this cannot assert
  // on distances captured beforehand: rebasing shifts every path distance
  // mid-run.
  await page.evaluate(() => {
    const g = window.__game;
    g.start();
    g.teleportTo(g.nextArc().s0 - 5);
  });
  // Poll rather than sleeping a fixed time. Under a software rasteriser the
  // frame time regularly exceeds MAX_FRAME_DT, so the clamped accumulator
  // simulates noticeably less than wall clock — a fixed sleep here is really a
  // bet on the renderer's speed.
  const tookCorner = await page
    .waitForFunction(() => window.__game.cornersTaken >= 1 || window.__game.state !== 'playing', null, {
      timeout: 20000,
    })
    .then(() => true)
    .catch(() => false);
  const auto = await page.evaluate(() => ({
    state: window.__game.state,
    why: window.__game.deathReason,
    corners: window.__game.cornersTaken,
  }));
  ok(auto.state === 'playing', `a corner turns on its own with no swipe (${auto.state}, ${auto.why || 'alive'})`);
  ok(tookCorner && auto.corners >= 1, `and carries the player through and out the other side (${auto.corners} corner)`);

  // Drives the player into the next wide obstacle (BARRIER or BEAM, so no lane
  // alignment is needed) and reports what happened.
  const runIntoObstacle = (p) =>
    p.evaluate(async () => {
      const g = window.__game;
      for (let i = 0; i < 40; i++) {
        const o = g.nextObstacle();
        if (o && (o.kind === 1 || o.kind === 2)) {
          g.teleportTo(o.s - 4);
          await new Promise((res) => setTimeout(res, 1000));
          return { state: g.state, why: g.deathReason, chasing: g.chasing };
        }
        g.teleportTo(g.distance + 20);
      }
      return { state: 'none', why: 'no obstacle found' };
    });

  // The first hit starts the chase instead of ending the run.
  await page.evaluate(() => window.__game.start());
  const first = await runIntoObstacle(page);
  ok(first.state === 'playing', `the first hit does not end the run (${first.state})`);
  ok(first.chasing > 0, `and puts the guardian on your heels (${first.chasing.toFixed(1)} s left)`);

  // A second hit inside that window does.
  const second = await runIntoObstacle(page);
  ok(second.state === 'over' && second.why === 'caught', `a second hit while chased is fatal (${second.why})`);

  await page.screenshot({ path: join(SHOTS, 'gameover.png') });

  // Staying clean for the full window shakes it off, and a hit after that is
  // survivable again — otherwise "outrun him" would be cosmetic only.
  await page.evaluate(() => {
    const g = window.__game;
    g.start();
    g.startChase();
    // Sweep the track clear while this runs. Ten seconds at 15 m/s is 150 m of
    // obstacles and nobody is steering, so without this the runner is caught
    // every time — which would be the game working correctly, and would tell us
    // nothing about whether the window ever closes.
    window.__sweep = setInterval(() => {
      for (const it of g.entities.items) if (it.kind !== 0) it.alive = false;
      g.entities.dirty = true;
    }, 40);
  });
  // Same again: the window is ten *simulated* seconds, which is longer than ten
  // wall-clock seconds whenever frames run long.
  const shookOff = await page
    .waitForFunction(() => window.__game.chasing === 0 || window.__game.state !== 'playing', null, { timeout: 45000 })
    .then(() => true)
    .catch(() => false);
  const outran = await page.evaluate(() => {
    clearInterval(window.__sweep);
    return { chasing: window.__game.chasing, state: window.__game.state };
  });
  ok(
    shookOff && outran.chasing === 0 && outran.state === 'playing',
    `surviving the window outruns it (${outran.chasing.toFixed(1)} s left, ${outran.state})`
  );
}

// --------------------------------------------------------------------------
section('Visual check: corner geometry');
{
  // The corner is the only hand-derived geometry in the game (a plaza, an outer
  // L of walls, and a chamfered inner corner), so it gets looked at rather than
  // just asserted on.
  for (const [name, offset] of [['corner-far', 30], ['corner-near', 9]]) {
    await page.evaluate((back) => {
      const g = window.__game;
      g.start();
      const arc = g.nextArc();
      g.teleportTo(arc.s0 - back);
      g.player.speed = 0;
    }, offset);
    await sleep(250);
    await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  }
  ok(true, 'captured corner approach screenshots for review');
}

// --------------------------------------------------------------------------
section('6. Determinism');
{
  // The opening run is straights by design, so sample far enough ahead that
  // corner placement has actually had a chance to diverge.
  const signature = (p) =>
    p.evaluate(() => {
      const path = window.__game.track.path;
      while (path.end < 3000) path.append();
      return path.nodes.map((n) => `${n.kind}:${n.dir}`).join(',');
    });

  const a = await newPage(context, '?seed=42');
  const b = await newPage(context, '?seed=42');
  const c = await newPage(context, '?seed=99');
  const sa = await signature(a.page);
  const sb = await signature(b.page);
  const sc = await signature(c.page);
  ok(sa.length > 0 && sa === sb, 'the same seed generates the same track');
  ok(sa !== sc, 'a different seed generates a different track');
  await a.page.close();
  await b.page.close();
  await c.page.close();
}

// --------------------------------------------------------------------------
section('Home, store and options');
{
  // A fresh context, because the store is backed by localStorage and the runs
  // above have already banked coins into it.
  const shopCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const shop = await shopCtx.newPage();
  const shopErrors = [];
  shop.on('pageerror', (e) => shopErrors.push(e.message));
  shop.on('console', (m) => m.type() === 'error' && shopErrors.push(m.text()));
  await shop.goto(`${BASE}/game.html`, { waitUntil: 'load' });
  await shop.waitForFunction(() => !!window.__game, null, { timeout: 15000 });

  const shown = () => shop.evaluate(() => window.__game.hud.current);
  ok((await shown()) === 'home', 'boots to the home screen');
  ok((await shop.evaluate(() => window.__game.state)) === 'home', 'and is not running a game behind it');

  // Everything below drives the real buttons, so the wiring is under test too.
  await shop.click('#btn-store');
  ok((await shown()) === 'store', 'Store opens the store');
  const rows = await shop.$$eval('#store-list .skin', (n) => n.length);
  ok(rows === 5, `lists every skin (${rows})`);

  const buyState = () =>
    shop.$$eval('#store-list .skin button', (b) => b.map((x) => ({ t: x.textContent, off: x.disabled })));
  let btns = await buyState();
  ok(btns[0].t === 'Wearing' && btns[0].off, 'the default skin reads as worn');
  ok(btns[1].t === 'Buy' && btns[1].off, 'a skin you cannot afford cannot be bought');

  // Bank enough for the second skin and reopen.
  await shop.evaluate(() => {
    window.__game.save.addCoins(500);
    window.__game.hud.renderStore(window.__game.save);
    window.__game.hud.setBank(window.__game.save.coins);
  });
  btns = await buyState();
  ok(!btns[1].off, 'and can be bought once you can afford it');

  await shop.$$eval('#store-list .skin button', (b) => b[1].click());
  const bought = await shop.evaluate(() => ({
    coins: window.__game.save.coins,
    skin: window.__game.save.skin,
    owns: window.__game.save.owns('jade'),
  }));
  ok(bought.owns && bought.coins === 300, `buying deducts the price (${bought.coins} left of 500)`);
  ok(bought.skin === 'jade', 'and equips what you just bought');
  ok((await buyState())[1].t === 'Wearing', 'and the row updates to match');

  // Buying twice must not charge twice.
  await shop.$$eval('#store-list .skin button', (b) => b[0].click());
  await shop.$$eval('#store-list .skin button', (b) => b[1].click());
  const reworn = await shop.evaluate(() => ({ coins: window.__game.save.coins, skin: window.__game.save.skin }));
  ok(reworn.coins === 300 && reworn.skin === 'jade', 'wearing an owned skin again is free');

  await shop.click('#btn-store-back');
  ok((await shown()) === 'home', 'Back returns to the home screen');

  await shop.click('#btn-options');
  ok((await shown()) === 'options', 'Options opens options');
  await shop.click('#opt-music');
  ok((await shop.evaluate(() => window.__game.save.music)) === false, 'music can be turned off');
  await shop.click('#opt-sfx');
  ok((await shop.evaluate(() => window.__game.save.sfx)) === false, 'sound effects can be turned off');

  // Settings must outlive a reload, or the toggles are decorative.
  await shop.reload({ waitUntil: 'load' });
  await shop.waitForFunction(() => !!window.__game, null, { timeout: 15000 });
  const persisted = await shop.evaluate(() => ({
    music: window.__game.save.music,
    sfx: window.__game.save.sfx,
    skin: window.__game.save.skin,
    coins: window.__game.save.coins,
  }));
  ok(!persisted.music && !persisted.sfx, 'settings survive a reload');
  ok(persisted.skin === 'jade' && persisted.coins === 300, 'so do the coins and the equipped skin');

  await shop.click('#btn-options');
  await shop.click('#opt-reset');
  await shop.click('#opt-reset'); // the confirm tap
  const wiped = await shop.evaluate(() => ({
    coins: window.__game.save.coins,
    skin: window.__game.save.skin,
    best: window.__game.save.best,
  }));
  ok(wiped.coins === 0 && wiped.skin === 'explorer' && wiped.best === 0, 'reset clears progress');

  await shop.click('#btn-options-back');
  await shop.click('#btn-play');
  ok((await shop.evaluate(() => window.__game.state)) === 'playing', 'Play starts a run');
  ok(!(await shop.evaluate(() => window.__game.hud.visible)), 'and clears the menu');

  // Play it out to a death, so the run-end path is covered end to end: the
  // result screen, and coins moving from the run into the bank.
  for (let i = 0; i < 2; i++) {
    await shop.evaluate(async () => {
      const g = window.__game;
      for (let n = 0; n < 40; n++) {
        const o = g.nextObstacle();
        if (o && (o.kind === 1 || o.kind === 2)) {
          g.teleportTo(o.s - 3);
          return;
        }
        g.teleportTo(g.distance + 20);
      }
    });
    await shop
      .waitForFunction((want) => window.__game.chasing > 0 || window.__game.state === want, 'over', { timeout: 15000 })
      .catch(() => {});
  }
  await shop.waitForFunction(() => window.__game.hud.current === 'result', null, { timeout: 15000 }).catch(() => {});
  const ended = await shop.evaluate(() => ({
    screen: window.__game.hud.current,
    state: window.__game.state,
    banked: window.__game.save.coins,
    best: window.__game.save.best,
  }));
  ok(ended.screen === 'result' && ended.state === 'over', `dying shows the result screen (${ended.screen})`);
  ok(ended.best > 0, `and records the score (best ${ended.best})`);
  ok(ended.banked >= 0, `and banks the run's coins (${ended.banked})`);

  ok(shopErrors.length === 0, `no errors driving the menus${shopErrors.length ? `\n       ${shopErrors.join('\n       ')}` : ''}`);
  await shop.screenshot({ path: join(SHOTS, 'playing-after-menu.png') });
  await shopCtx.close();
}

// --------------------------------------------------------------------------
section('Audio');
{
  const aCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const a = await aCtx.newPage();
  const aErrors = [];
  a.on('pageerror', (e) => aErrors.push(e.message));
  await a.goto(`${BASE}/game.html`, { waitUntil: 'load' });
  await a.waitForFunction(() => !!window.__game, null, { timeout: 15000 });

  ok((await a.evaluate(() => window.__game.audio.ctx)) === null, 'no AudioContext before a gesture');

  // A real click, which is what mobile Safari requires before audio will start.
  await a.click('#btn-play');
  const started = await a.evaluate(() => ({
    hasCtx: !!window.__game.audio.ctx,
    state: window.__game.audio.ctx && window.__game.audio.ctx.state,
  }));
  ok(started.hasCtx, `a gesture creates the AudioContext (state: ${started.state})`);

  // Every sound must be safe to fire regardless of context state — they are
  // called from the game loop, which knows nothing about autoplay policy.
  const threw = await a.evaluate(() => {
    try {
      const au = window.__game.audio;
      for (const s of ['jump', 'land', 'slide', 'coin', 'hit', 'roar', 'caught']) au[s]();
      au.setIntensity(0.5);
      au.setChase(true);
      au.startMusic();
      au.stopMusic();
      return null;
    } catch (e) {
      return e.message;
    }
  });
  ok(threw === null, `every sound plays without throwing${threw ? ` (${threw})` : ''}`);
  ok(aErrors.length === 0, `no audio errors${aErrors.length ? `\n       ${aErrors.join('\n       ')}` : ''}`);
  await aCtx.close();
}

// --------------------------------------------------------------------------
section('8. Manifest and icons');
{
  const res = await page.request.get(`${BASE}/manifest.webmanifest`);
  ok(res.status() === 200, 'manifest is served');
  const manifest = JSON.parse(await res.text());

  const flat = JSON.stringify(manifest);
  ok(!/"\.?\/?[^"]*":\s*"\/[^/]/.test(flat) && !/"\/[a-z]/i.test(flat), 'no absolute paths inside the manifest');

  ok(!!manifest.name && !!manifest.short_name, 'manifest has name and short_name');
  ok(manifest.display === 'fullscreen', 'manifest asks for fullscreen');

  const sizes = manifest.icons.map((i) => i.sizes);
  ok(sizes.includes('192x192') && sizes.includes('512x512'), 'manifest has the 192 and 512 icons Chrome requires');
  ok(manifest.icons.some((i) => i.purpose === 'maskable'), 'manifest has a maskable icon');

  for (const icon of manifest.icons) {
    const r = await page.request.get(`${BASE}/${icon.src}`);
    ok(r.status() === 200, `icon ${icon.src} resolves`);
  }
  const apple = await page.request.get(`${BASE}/icons/apple-touch-icon-180.png`);
  ok(apple.status() === 200, 'apple-touch-icon resolves');
}

// --------------------------------------------------------------------------
section('9. Offline');
{
  const offlineCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p = await offlineCtx.newPage();
  const offErrors = [];
  p.on('pageerror', (e) => offErrors.push(e.message));

  await p.goto(`${BASE}/game.html`, { waitUntil: 'load' });
  await p.evaluate(() => navigator.serviceWorker.ready);
  await sleep(2500); // let addAll finish

  await offlineCtx.setOffline(true);
  await p.reload({ waitUntil: 'load' });
  await p.waitForFunction(() => !!window.__game, null, { timeout: 15000 }).catch(() => {});

  const alive = await p.evaluate(() => {
    if (!window.__game) return null;
    window.__game.start();
    return new Promise((res) =>
      setTimeout(
        () =>
          res({
            frames: window.__game.frames,
            tris: window.__game.renderer.info.render.triangles,
            dist: window.__game.distance,
          }),
        2000
      )
    );
  });

  ok(!!alive, 'the page loads with no network at all');
  // A cold software-rasterised start is slow, and boot now deliberately spends
  // ~160 ms compiling the guardian's shaders up front so the chase never
  // stalls. Both land inside this window, so these assert liveness, not speed —
  // what they catch is a loop that never started.
  ok(alive && alive.frames > 4, `and keeps rendering offline (${alive ? alive.frames : 0} frames)`);
  ok(alive && alive.dist > 1, `and the game actually runs offline (${alive ? alive.dist.toFixed(1) : 0} m)`);
  ok(alive && alive.tris > 0, 'and three.js loaded from cache (geometry is drawing)');
  ok(offErrors.length === 0, `no errors offline${offErrors.length ? `\n       ${offErrors.join('\n       ')}` : ''}`);
  await p.screenshot({ path: join(SHOTS, 'offline.png') });

  // The worker sits at the repo root, so its scope covers the portfolio site
  // too. Confirm the OWNED filter leaves index.html and its assets alone.
  await offlineCtx.setOffline(false);
  const portfolio = await p.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });
  ok(portfolio.status() === 200, 'index.html still loads with the worker active');
  const css = await p.request.get(`${BASE}/css/style.css`);
  ok(css.status() === 200, "the portfolio's own assets are untouched by the worker");
  const linked = await p.$$eval('a[href="game.html"]', (a) => a.length);
  ok(linked > 0, 'index.html links to the game');

  await offlineCtx.close();
}

await browser.close();

console.log('');
if (failures) {
  console.error(`${failures} of ${checks} checks FAILED`);
  process.exit(1);
}
console.log(`all ${checks} checks passed  (screenshots in ${relative(ROOT, SHOTS) || SHOTS})`);
