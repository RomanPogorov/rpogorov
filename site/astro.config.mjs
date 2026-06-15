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
              const original = readFileSync(p, 'utf8');
              let out = original;
              // Inject attributes with SINGLE quotes. Many <img>/<video> tags live
              // inside inline-script data: case bodies in backtick template literals
              // (double quotes ok) AND window.__RIGHT_PANEL_DETAIL via JSON.stringify
              // (a double-quote-delimited string — injecting double quotes there
              // breaks the JSON and silently kills every card-detail open). Single
              // quotes are valid in HTML, in backtick strings, and inside JSON
              // strings, so they're safe in all three contexts.
              out = out.replace(/<img\b(?![^>]*\bloading=)[^>]*>/g, (tag) => {
                if (/showcase\/cases\//.test(tag)) return tag; // visible grid thumbnails stay eager
                patched++;
                return tag.replace(/^<img\b/, "<img loading='lazy' decoding='async'");
              });
              let hasLazyVideo = false;
              out = out.replace(/<video\b[^>]*>/g, (tag) => {
                if (/id="bg"/.test(tag)) return tag;
                patched++;
                hasLazyVideo = true;
                let t = tag.replace(/\s+autoplay\b/g, '');
                t = /\bpreload=/.test(t) ? t.replace(/\bpreload=["'][^"']*["']/, "preload='none'") : t.replace(/^<video\b/, "<video preload='none'");
                if (!/data-lazyvideo/.test(t)) t = t.replace(/^<video\b/, '<video data-lazyvideo');
                return t;
              });
              // Case-overlay videos (ambient loops inside off-screen overlays)
              // were stripped of autoplay + tagged data-lazyvideo in the segment
              // pass above. A tiny IntersectionObserver (injected below) plays
              // them only once they scroll into view and pauses them on exit.
              if (hasLazyVideo && !out.includes('__lazyvideo')) {
                const script = `<script>/*__lazyvideo*/(function(){var io=new IntersectionObserver(function(es){es.forEach(function(e){var v=e.target;if(e.isIntersecting){if(v.preload!=='auto')v.preload='auto';v.play&&v.play().catch(function(){});}else{v.pause&&v.pause();}});},{rootMargin:'200px'});function wire(){document.querySelectorAll('video[data-lazyvideo]:not([data-lv])').forEach(function(v){v.setAttribute('data-lv','1');io.observe(v);});}wire();new MutationObserver(wire).observe(document.documentElement,{childList:true,subtree:true});})();<\/script>`;
                // IMPORTANT: inject before the LAST </body>. The first </body>
                // in this file lives inside a JS template-literal string, and
                // injecting there both fails to run and prematurely closes the
                // surrounding inline <script>.
                const idx = out.lastIndexOf('</body>');
                out = idx !== -1 ? out.slice(0, idx) + script + out.slice(idx) : out + script;
              }
              if (out !== original) writeFileSync(p, out);
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
