// Perf harness for clauderunner.com/rpogorov-dev.
// Measures initial-load weight (image requests + bytes), paint timings, long
// tasks, and jank during the "Витрина"/Showcase interaction.
//
// Usage:  node perf/measure.mjs [ru|en] [path]
//   requires the local static server:  python3 -m http.server 8137 --directory /root
//
// Prints a JSON summary so before/after runs are diffable.
import pw from '/tmp/pw/node_modules/playwright/index.js';
const { chromium } = pw;

const lang = process.argv[2] || 'ru';
const base = `http://127.0.0.1:8137/rpogorov-dev/app/${lang === 'en' ? '' : 'ru/'}index.html`;

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();

// Tally network by type. resourceType image + transferred sizes (from response headers / body).
const reqs = [];
page.on('requestfinished', async (req) => {
  try {
    const resp = await req.response();
    const sizes = await req.sizes().catch(() => ({}));
    reqs.push({
      url: req.url(),
      type: req.resourceType(),
      bytes: sizes.responseBodySize || 0,
    });
  } catch {}
});

const t0 = Date.now();
await page.goto(base, { waitUntil: 'load', timeout: 60000 });
const loadMs = Date.now() - t0;
// settle: let lazy/idle work happen
await page.waitForTimeout(2500);

const paint = await page.evaluate(() => {
  const out = {};
  for (const e of performance.getEntriesByType('paint')) out[e.name] = Math.round(e.startTime);
  const nav = performance.getEntriesByType('navigation')[0];
  if (nav) { out.domContentLoaded = Math.round(nav.domContentLoadedEventEnd); out.loadEvent = Math.round(nav.loadEventEnd); }
  return out;
});

const byType = {};
let imgBytes = 0, imgCount = 0, totalBytes = 0;
for (const r of reqs) {
  byType[r.type] = byType[r.type] || { count: 0, bytes: 0 };
  byType[r.type].count++; byType[r.type].bytes += r.bytes;
  totalBytes += r.bytes;
  if (r.type === 'image') { imgBytes += r.bytes; imgCount++; }
}

// --- Showcase interaction jank: install longtask + rAF FPS probes, then click ---
await page.evaluate(() => {
  window.__lt = [];
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)); }).observe({ entryTypes: ['longtask'] }); } catch {}
  window.__frames = []; let last = performance.now();
  function tick(now){ window.__frames.push(now - last); last = now; if (window.__rafGo) requestAnimationFrame(tick); }
  window.__rafGo = true; requestAnimationFrame(tick);
});

// Find a "Витрина"/Showcase trigger. Try common selectors / text.
const clicked = await page.evaluate(() => {
  const cands = [...document.querySelectorAll('a,button,[role="button"],[data-nav],[data-scroll]')];
  const el = cands.find((e) => /витрин|showcase/i.test(e.textContent || '') || /витрин|showcase/i.test(e.getAttribute('href') || '') || /showcase|витрин/i.test(e.getAttribute('data-scroll') || ''));
  if (el) { el.scrollIntoView(); el.click(); return el.outerHTML.slice(0, 120); }
  return null;
});
await page.waitForTimeout(1800);

const jank = await page.evaluate(() => {
  window.__rafGo = false;
  const f = window.__frames.filter((x) => x > 0);
  const long = f.filter((x) => x > 32).length; // dropped frames (>~2x 16.7ms)
  const lt = window.__lt;
  return {
    showcaseClicked: !!window.__clickedShowcase,
    frames: f.length,
    droppedFrames: long,
    maxFrameMs: f.length ? Math.round(Math.max(...f)) : 0,
    longTasks: lt.length,
    longTaskTotalMs: lt.reduce((a, b) => a + b, 0),
    maxLongTaskMs: lt.length ? Math.max(...lt) : 0,
  };
});

const summary = {
  url: base,
  loadMs,
  paint,
  totalRequests: reqs.length,
  totalMB: +(totalBytes / 1048576).toFixed(2),
  images: { count: imgCount, MB: +(imgBytes / 1048576).toFixed(2) },
  byType: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, { count: v.count, MB: +(v.bytes / 1048576).toFixed(2) }])),
  showcaseTrigger: clicked,
  jank,
};
console.log(JSON.stringify(summary, null, 2));

await browser.close();
