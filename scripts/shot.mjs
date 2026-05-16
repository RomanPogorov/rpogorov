#!/usr/bin/env node
// Quick visual check: open page in headless chromium, screenshot it.
// Usage: node scripts/shot.mjs <url> <out.png> [viewport WxH]

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/usr/lib/node_modules/playwright');

const [, , urlArg, outArg, vpArg] = process.argv;
const url = urlArg || 'https://clauderunner.com/rpogorov-dev/app/#case/cs02';
const out = outArg || '/tmp/shot.png';
const [vw, vh] = (vpArg || '1440x900').split('x').map(Number);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(2000);
// dismiss audio gate if present
await page.evaluate(() => {
  const silent = document.getElementById('audio-gate-mute');
  const accept = document.getElementById('audio-gate-enable');
  (silent || accept)?.click();
});
await page.waitForTimeout(10000);
const scrollY = parseInt(process.env.SCROLL || '0', 10);
if (scrollY > 0) {
  await page.evaluate((y) => {
    const cp = document.querySelector('.case-page.open') || document.scrollingElement;
    if (cp.scrollTo) cp.scrollTo({ top: y, behavior: 'instant' });
  }, scrollY);
  await page.waitForTimeout(500);
}
await page.screenshot({ path: out, fullPage: false });
console.log(`Saved ${out} (${vw}x${vh})`);
await browser.close();
