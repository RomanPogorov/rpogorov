#!/usr/bin/env node
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/usr/lib/node_modules/playwright');

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto('https://clauderunner.com/rpogorov-dev/app/#case/cs02', { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(2000);
await page.evaluate(() => {
  document.querySelectorAll('button').forEach(b => { if (/accept|silent/i.test(b.textContent||'')) b.click(); });
});
await page.waitForTimeout(4000);
const result = await page.evaluate(() => {
  const out = {};
  for (const sel of ['.cp-hs.case-page.open', '.cp-hs .cp-inner', '.cp-hs .dc-title', '.cp-hs .cnt-body', '.cp-hs .hs-cta', '.cp-hs .hs-meta-row', '.cp-hs .hs-tldr-wrap']) {
    const el = document.querySelector(sel);
    if (!el) { out[sel] = 'not found'; continue; }
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    out[sel] = {
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      ml: cs.marginLeft, pl: cs.paddingLeft, maxW: cs.maxWidth, display: cs.display,
    };
  }
  return out;
});
console.log(JSON.stringify(result, null, 2));
await browser.close();
