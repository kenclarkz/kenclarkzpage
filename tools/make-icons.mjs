// Generates the PWA icons by rasterising an inline SVG with headless Chromium.
// Dev-only: the PNGs are committed, and this never runs at serve time.
//
// Run: node tools/make-icons.mjs

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadChromium } from './pw.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BG = '#0b0e14';
const GOLD = '#e0a83a';

/**
 * A stepped temple arch with a runner in the doorway.
 * @param {number} inset fraction of the canvas kept free around the artwork
 */
function svg(inset) {
  const scale = 1 - inset * 2;
  const shift = inset * 100;
  return `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <rect x="0" y="0" width="100" height="100" fill="${BG}"/>
  <g transform="translate(${shift} ${shift}) scale(${scale})">
    <!-- ziggurat -->
    <path d="M10 88 L19 60 L29 60 L29 47 L39 47 L39 34 L50 21 L61 34 L61 47 L71 47 L71 60 L81 60 L90 88 Z"
          fill="${GOLD}"/>
    <!-- doorway -->
    <path d="M37 88 L37 60 Q50 47 63 60 L63 88 Z" fill="${BG}"/>
    <!-- runner -->
    <g fill="none" stroke="${GOLD}" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M50 70 L47 78"/>
      <path d="M50 71 L58 68"/>
      <path d="M50 73 L43 77"/>
      <path d="M47 78 L55 84"/>
      <path d="M47 78 L41 86"/>
    </g>
    <circle cx="51" cy="64" r="4.4" fill="${GOLD}"/>
  </g>
</svg>`;
}

const TARGETS = [
  // Plain icons can use nearly the whole canvas.
  { file: 'icons/icon-192.png', size: 192, inset: 0.04 },
  { file: 'icons/icon-512.png', size: 512, inset: 0.04 },
  // Android crops maskable icons to arbitrary shapes, so everything that must
  // survive belongs inside the central 80%.
  { file: 'icons/icon-maskable-512.png', size: 512, inset: 0.1 },
  // iOS applies its own mask; a pre-rounded or inset icon gets double-treated.
  { file: 'icons/apple-touch-icon-180.png', size: 180, inset: 0.06 },
];

const chromium = await loadChromium();
const browser = await chromium.launch();
mkdirSync(resolve(ROOT, 'icons'), { recursive: true });

for (const t of TARGETS) {
  const page = await browser.newPage({
    viewport: { width: t.size, height: t.size },
    deviceScaleFactor: 1,
  });
  await page.setContent(
    `<html><body style="margin:0;background:${BG}">
       <div style="width:${t.size}px;height:${t.size}px">
         ${svg(t.inset).replace('width="100" height="100"', `width="${t.size}" height="${t.size}"`)}
       </div>
     </body></html>`
  );
  await page.screenshot({ path: resolve(ROOT, t.file), omitBackground: false });
  await page.close();
  console.log(`wrote ${t.file} (${t.size}x${t.size})`);
}

await browser.close();
