# Performance overhaul — results (2026-06-14, overnight)

Measured with `perf/measure.mjs` (Playwright, 1440×900) against the local build
served from `/root` on :8137. Re-run any time:

```bash
python3 -m http.server 8137 --bind 127.0.0.1 --directory /root &   # serve
node perf/measure.mjs ru        # initial-load weight + paint + jank
node perf/optimize-images.mjs --dry   # preview image savings (safe, idempotent)
```

## Before → After (initial load of /ru/)

| Metric | Before | After | Δ |
| --- | --- | --- | --- |
| Total transferred | 46.7 MB | 10.8 MB | −77% |
| Requests | 248 | 173 | −30% |
| Images loaded eagerly | 113 / 36.8 MB | 40 / 5.9 MB | −84% bytes |
| Video loaded eagerly | 6.1 MB (4 files) | 1.0 MB (hero bg only) | −83% |
| DOMContentLoaded | 3381 ms | 1976 ms | −42% |
| load event | 5602 ms | 3998 ms | −29% |
| Deep-link case open (`/#case/...`) | 4248 ms | 2138 ms | −50% |
| Showcase-open long-tasks (jank) | 168 ms / 3 tasks | 0 ms | gone |

## What changed

1. **Lazy-load offscreen images** — every case body is server-rendered into the
   initial DOM inside fixed overlays pushed off-screen. A post-build integration
   (`site/astro.config.mjs`) adds `loading="lazy" decoding="async"` to all `<img>`
   except the visible showcase-grid thumbnails. Case images now load when their
   overlay opens, not on first paint.

2. **Defer case videos** — those overlays' ambient `<video autoplay>` loops
   fetched ~6 MB up front even with `preload="metadata"` (autoplay forces it).
   The post-build strips `autoplay`, sets `preload="none"`, and plays them via a
   small IntersectionObserver when they scroll into view. Only the 1 MB hero bg
   loads eagerly now.

3. **Compress images in place** — `perf/optimize-images.mjs` downscaled 63 source
   images to sane targets (cards ≤1000px, detail ≤2000px, the 16860px `high-level`
   panorama → 3600px / 2.9 MB→42 KB) and re-encoded (mozjpeg / palette PNG). Only
   overwrites when ≥8% smaller, so it's idempotent. Source 55 MB → 29 MB.

4. **Open deep-links on DOMContentLoaded, not `load`** — `/#case/...` URLs used to
   wait for every resource (the `load` event) before opening. Now they open at
   DOMContentLoaded. Also shrinks the window where the late initial-apply could
   fight quick user navigation (the "kicked back a step" report).

5. **content-visibility on offscreen overlays** — closed `.case-page`s get
   `content-visibility:auto` so the browser skips their layout/paint; the open one
   is forced `visible`. This is what killed the showcase-open jank (168→0 ms) and
   trimmed DCL.

## Verified (Playwright)

- No new JS console errors. Cases open from the grid and from `/#case/...`.
- Opened cases render fully (screenshot checked); images lazy-load on open;
  videos auto-play when scrolled into view.

## Pre-existing issues found (NOT fixed — out of scope, flag for Roman)

- `cases/cs02/health-samurai-illustrations/samurai-*.jpg` (3 files) 404 — the
  directory doesn't exist; `health-samurai-illustrations.mdx` thumb points at
  missing files.
- The chat widget logs "Unexpected end of input" — it `JSON.parse`s the poll
  response which can be empty/non-JSON. Cosmetic; worth a guard in the chat code.

## Not touched (would need sign-off — higher risk)

- The R3F hero (three.js + in-browser Babel JSX compile from CDN) is the main
  remaining FCP cost (~3.4 s). Reworking it (precompiled bundle, deferred init)
  is a real change to the hero and was left alone deliberately.
- The ~40 still-eager images (5.9 MB) are mostly the showcase grid + first image
  of each overlay within the lazy margin; pushing lower has diminishing returns.
