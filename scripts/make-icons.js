'use strict';

// Renders the favicons, app icons and social sharing images into public/
// from the logo (an up arrow on a teal tile), using Playwright's Chromium:
//   node scripts/make-icons.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');

const out = path.join(__dirname, '..', 'public');
const font = (file) => `url(data:font/woff2;base64,${fs.readFileSync(path.join(out, 'font', file)).toString('base64')})`;

const TEAL = '#0d9488';
const arrow = (stroke) =>
  `<path d="M16 23V9M10 15l6-6 6 6" fill="none" stroke="#fff" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/>`;

// Rounded tile (browser tabs, Android) and a full-bleed square (iOS and
// maskable icons, which the platform rounds itself).
const rounded = (stroke = 3) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="9" fill="${TEAL}"/>${arrow(stroke)}</svg>`;
const square = (scale = 1) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="${TEAL}"/><g transform="translate(16 16) scale(${scale}) translate(-16 -16)">${arrow(3)}</g></svg>`;

async function renderSvg(page, svg, size) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  return page.screenshot({ omitBackground: true, type: 'png' });
}

// An .ico file holding PNG images (supported by every current browser).
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(entry);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

const SOCIAL = {
  cs: { title: 'Web online jedním přetažením.', text: 'Přetáhněte složku s webem a za pár sekund běží na vlastní adrese. Zdarma, s HTTPS.', name: 'muj-web' },
  en: { title: 'Your site online in one drop.', text: 'Drop a folder with your site and seconds later it runs at its own address. Free, with HTTPS.', name: 'my-site' },
};

function socialHtml({ title, text, name }) {
  return `<!doctype html><meta charset="utf-8"><style>
    @font-face { font-family: B; src: ${font('bricolage-grotesque-latin-wght-normal.woff2')}; font-weight: 200 800; unicode-range: U+0000-00FF; }
    @font-face { font-family: B; src: ${font('bricolage-grotesque-latin-ext-wght-normal.woff2')}; font-weight: 200 800; unicode-range: U+0100-02BA, U+1E00-1EFF; }
    html, body { margin: 0; width: 1200px; height: 630px; }
    body {
      position: relative; overflow: hidden; box-sizing: border-box; padding: 84px 96px;
      display: flex; flex-direction: column; justify-content: space-between;
      font-family: B, sans-serif; color: #0b1324; background: #f3f5f9;
    }
    body::before { content: ''; position: absolute; inset: 0; z-index: -1;
      background:
        radial-gradient(600px 420px at 8% 0%, rgba(45,212,191,.55), transparent 70%),
        radial-gradient(640px 460px at 100% 10%, rgba(167,139,250,.5), transparent 70%),
        radial-gradient(520px 380px at 70% 110%, rgba(251,146,120,.32), transparent 70%); }
    .brand { display: flex; align-items: center; gap: 22px; font-size: 44px; font-weight: 700; letter-spacing: -0.02em; }
    .brand svg { width: 76px; height: 76px; }
    .brand span { color: #586174; font-weight: 600; }
    h1 { margin: 0; font-size: 92px; line-height: 1.02; letter-spacing: -0.035em; font-weight: 750; max-width: 980px; }
    h1 em { font-style: normal; color: #0f766e; }
    p { margin: 22px 0 0; font-size: 34px; line-height: 1.35; color: #3b4456; max-width: 940px; font-family: system-ui, sans-serif; }
    .bar { display: inline-block; padding: 16px 26px; border-radius: 18px;
      background: rgba(255,255,255,.75); border: 1px solid rgba(255,255,255,.9); box-shadow: 0 12px 40px -12px rgba(30,41,59,.25);
      font: 600 30px ui-monospace, Menlo, monospace; color: #586174; align-self: flex-start; }
    .bar b { color: #6d28d9; font-weight: 700; }
  </style>
  <div class="brand">${rounded()}<div>freepages<span>.dev</span></div></div>
  <div><h1>${title.replace(/^(\S+ \S+) /, '$1 <em>').replace(/\.$/, '.</em>')}</h1><p>${text}</p></div>
  <div class="bar">https://<b>${name}</b>.freepages.dev/</div>`;
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });

  const sizes = [16, 32, 48];
  // Small sizes get a thicker arrow so it stays readable.
  const icoImages = [];
  for (const size of sizes) icoImages.push({ size, png: await renderSvg(page, rounded(size <= 16 ? 3.6 : 3.2), size) });
  fs.writeFileSync(path.join(out, 'favicon.ico'), ico(icoImages));

  fs.writeFileSync(path.join(out, 'apple-touch-icon.png'), await renderSvg(page, square(0.82), 180));
  fs.writeFileSync(path.join(out, 'icon-192.png'), await renderSvg(page, rounded(), 192));
  fs.writeFileSync(path.join(out, 'icon-512.png'), await renderSvg(page, rounded(), 512));
  // Maskable icons must keep their content inside the central 80 % circle.
  fs.writeFileSync(path.join(out, 'icon-maskable-512.png'), await renderSvg(page, square(0.7), 512));

  await page.setViewportSize({ width: 1200, height: 630 });
  for (const [lang, copy] of Object.entries(SOCIAL)) {
    await page.setContent(socialHtml(copy));
    await page.evaluate(() => document.fonts.ready);
    fs.writeFileSync(path.join(out, `og-${lang}.png`), await page.screenshot({ type: 'png' }));
  }

  await browser.close();
  console.log('icons written to public/');
})();
