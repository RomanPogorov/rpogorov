// Phase 1 / Pass A image optimization (in place, same names + formats).
// Downscale oversized images and re-encode. SAFETY: only overwrites a file
// when the new version is meaningfully smaller (>=8%), so re-running never
// degrades already-optimized images (idempotent). Images are git-tracked in
// this repo, so a bad run is `git checkout -- showcase cases` away.
//
// Targets (px, longest edge):
//   showcase/cases/*  -> 1000  (grid thumbnails)
//   *high-level*      -> 3600  (wide panorama / product-flow diagram)
//   everything else   -> 2000  (case detail images)
//
// Usage:  node perf/optimize-images.mjs [--dry]
import sharp from '../site/node_modules/sharp/lib/index.js';
import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join, extname, basename } from 'node:path';

const DRY = process.argv.includes('--dry');
const DIRS = ['showcase', 'cases'];
const MIN_GAIN = 0.08; // require >=8% smaller to replace

function targetW(p) {
  if (p.includes('showcase/cases/')) return 1000;
  if (basename(p).includes('high-level')) return 3600;
  return 2000;
}

const files = [];
const walk = (d) => {
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (/\.(png|jpe?g)$/i.test(name)) files.push(p);
  }
};
for (const d of DIRS) walk(d);

let before = 0, after = 0, changed = 0, resized = 0;
for (const p of files) {
  const buf = readFileSync(p);
  before += buf.length;
  const ext = extname(p).toLowerCase();
  const meta = await sharp(buf).metadata();
  const tw = targetW(p);
  const doResize = meta.width && meta.width > tw;

  let pipe = sharp(buf, { failOn: 'none' }).rotate();
  if (doResize) pipe = pipe.resize({ width: tw, withoutEnlargement: true });
  if (ext === '.png') pipe = pipe.png({ compressionLevel: 9, quality: 82, effort: 8, palette: true });
  else pipe = pipe.jpeg({ quality: 80, mozjpeg: true, progressive: true });

  let out;
  try { out = await pipe.toBuffer(); } catch (e) { console.error('skip', p, e.message); after += buf.length; continue; }

  const gain = 1 - out.length / buf.length;
  // Resized files: accept any real shrink (resize is the point). Re-encode-only
  // files: require a big win so we don't requantize already-good images for ~20%.
  const need = doResize ? 0.05 : 0.35;
  if (out.length < buf.length && gain >= need) {
    after += out.length; changed++; if (doResize) resized++;
    if (!DRY) writeFileSync(p, out);
    console.log(`${gain >= 0 ? '-' : '+'}${(gain * 100).toFixed(0)}%  ${(buf.length/1024).toFixed(0)}->${(out.length/1024).toFixed(0)}KB  ${doResize ? `[${meta.width}->${tw}px] ` : ''}${p}`);
  } else {
    after += buf.length; // keep original
  }
}
console.log(`\n${DRY ? '[DRY] ' : ''}files=${files.length} changed=${changed} (resized ${resized})  ${(before/1048576).toFixed(1)}MB -> ${(after/1048576).toFixed(1)}MB  saved ${((before-after)/1048576).toFixed(1)}MB`);
