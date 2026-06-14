// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Post-build: defer offscreen images. Every case body is rendered into the
// initial HTML inside fixed overlays pushed off-screen with translateY(100%),
// so without this ALL ~113 case images (~37 MB) fetch on first paint and choke
// the main thread. We add loading="lazy" + decoding="async" to every <img>
// that doesn't already have a loading attr, EXCEPT the visible showcase-grid
// thumbnails (src under showcase/cases/) which stay eager so the Витрина grid
// doesn't pop in. Runs on every build, including the cron autobuild.
function lazyOffscreenImages() {
  return {
    name: 'lazy-offscreen-images',
    hooks: {
      'astro:build:done': ({ dir, logger }) => {
        const root = fileURLToPath(dir);
        let files = 0;
        let patched = 0;
        const walk = (d) => {
          for (const name of readdirSync(d)) {
            const p = join(d, name);
            const st = statSync(p);
            if (st.isDirectory()) walk(p);
            else if (name.endsWith('.html')) {
              files++;
              let out = readFileSync(p, 'utf8');
              out = out.replace(/<img\b(?![^>]*\bloading=)[^>]*>/g, (tag) => {
                if (/showcase\/cases\//.test(tag)) return tag; // visible grid thumbnails stay eager
                patched++;
                return tag.replace(/^<img\b/, '<img loading="lazy" decoding="async"');
              });
              // Case-overlay videos are ambient loops inside off-screen overlays.
              // `autoplay` makes the browser fetch them on first paint (~6 MB)
              // even with preload="none", because they sit just below the fold.
              // Strip autoplay + force preload="none" + tag them; a tiny
              // IntersectionObserver (injected below) plays them only once they
              // actually scroll into view (i.e. after their overlay opens) and
              // pauses them when they leave. The hero background (id="bg") is
              // left exactly as-is.
              let hasLazyVideo = false;
              out = out.replace(/<video\b[^>]*>/g, (tag) => {
                if (/id="bg"/.test(tag)) return tag;
                patched++;
                hasLazyVideo = true;
                let t = tag.replace(/\s+autoplay\b/g, '');
                t = /\bpreload=/.test(t) ? t.replace(/\bpreload="[^"]*"/, 'preload="none"') : t.replace(/^<video\b/, '<video preload="none"');
                if (!/data-lazyvideo/.test(t)) t = t.replace(/^<video\b/, '<video data-lazyvideo');
                return t;
              });
              if (hasLazyVideo && !out.includes('__lazyvideo')) {
                const script = `<script>/*__lazyvideo*/(function(){var io=new IntersectionObserver(function(es){es.forEach(function(e){var v=e.target;if(e.isIntersecting){if(v.preload!=='auto')v.preload='auto';v.play&&v.play().catch(function(){});}else{v.pause&&v.pause();}});},{rootMargin:'200px'});function wire(){document.querySelectorAll('video[data-lazyvideo]:not([data-lv])').forEach(function(v){v.setAttribute('data-lv','1');io.observe(v);});}wire();new MutationObserver(wire).observe(document.documentElement,{childList:true,subtree:true});})();<\/script>`;
                // IMPORTANT: inject before the LAST </body>. The first </body>
                // in this file lives inside a JS template-literal string, and
                // injecting there both fails to run and prematurely closes the
                // surrounding inline <script>.
                const idx = out.lastIndexOf('</body>');
                out = idx !== -1 ? out.slice(0, idx) + script + out.slice(idx) : out + script;
              }
              const html = readFileSync(p, 'utf8');
              if (out !== html) writeFileSync(p, out);
            }
          }
        };
        walk(root);
        logger?.info?.(`lazy-offscreen-images: lazied ${patched} <img> across ${files} html files`);
      },
    },
  };
}

export default defineConfig({
  site: 'https://clauderunner.com',
  base: '/rpogorov-dev/app/',
  outDir: '../app',
  build: {
    assets: 'assets',
  },
  integrations: [mdx(), lazyOffscreenImages()],
});
