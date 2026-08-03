// Locate Playwright whether it is a local dependency or a global install.
// This repo has no node_modules by design, so the global path is the usual hit.

import { execSync } from 'node:child_process';

// Playwright ships as CommonJS, so a dynamic import lands the exports on
// `default` rather than as named bindings.
const pick = (mod) => (mod.chromium ?? mod.default?.chromium);

export async function loadChromium() {
  for (const id of ['playwright', 'playwright-core']) {
    try {
      const chromium = pick(await import(id));
      if (chromium) return chromium;
    } catch {
      /* not installed locally; try the next candidate */
    }
  }
  const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
  const chromium = pick(await import(`file://${root}/playwright/index.js`));
  if (!chromium) throw new Error('could not load Playwright (tried local and global installs)');
  return chromium;
}

// Headless Chromium has no GPU here, so WebGL needs the software rasteriser.
export const GL_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--disable-dev-shm-usage',
];
