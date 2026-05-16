#!/usr/bin/env node
// Translate Russian .mdx files to English companions (*.en.mdx).
// Idempotent: skips files whose .en companion is newer than the source.
// Uses claude-headless wrapper (CLI) — keeps MCP intact and matches user's "claude sequential" rule.

import { readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOTS = [
  '/root/vault/portfolio/company/cases',
  '/root/vault/portfolio/cases',
  '/root/vault/portfolio/right-panel/tasks',
  '/root/vault/portfolio/right-panel/agents',
  '/root/vault/portfolio/right-panel/releases',
];

const MODEL = process.env.TRANSLATE_MODEL || 'sonnet';

const PROMPT = `You are translating a Russian MDX file into English for a designer portfolio site.

STRICT RULES — output ONLY the translated MDX, no commentary, no fences:
- Preserve the YAML frontmatter block exactly: keep all keys, only translate human-readable values (title, desc, name, role, tags, showcase* strings, label/title/panelTitle inside arrays, etc.). NEVER translate: id, accent, hex, rgb, order, src/href/url/thumb paths, dates, numbers, units.
- Preserve every JSX/MDX tag and prop value untouched UNLESS the prop is human-readable text (label/title/caption/alt/desc). Translate alt/caption/label/title/panelTitle/desc INSIDE component props.
- Preserve all <em>, <strong>, markdown emphasis, code fences, links, anchors (\`<a id=...>\`), heading levels.
- Preserve all import statements verbatim.
- Keep proper nouns (Americor, Health Samurai, Figma, Claude, ComfyUI, etc.) unchanged.
- Tone: native, concise, designer-portfolio English. Don't pad. Match the original's brevity and confidence.
- Numbers/metrics keep as-is. Date ranges (2023 — 2025) keep as-is.
- Russian word "редизайн" → "redesign"; "дизайн-система" → "design system"; "иллюстрации" → "illustrations"; "пайплайн" → "pipeline"; etc.

Output ONLY the translated MDX content. No \`\`\` fences, no "Here is the translation", nothing else.

--- BEGIN MDX ---
`;

function isEnFile(name) {
  return /\.en\.(mdx|md)$/.test(name);
}

async function gather() {
  const files = [];
  for (const root of ROOTS) {
    if (!existsSync(root)) continue;
    const entries = await readdir(root, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      if (!/\.(mdx|md)$/.test(ent.name)) continue;
      if (isEnFile(ent.name)) continue;
      const p = join(root, ent.name);
      const body = await readFile(p, 'utf8');
      if (!/[Ѐ-ӿ]/.test(body)) continue; // no Cyrillic → skip
      files.push(p);
    }
  }
  return files;
}

function enPath(src) {
  return src.replace(/\.(mdx|md)$/, '.en.$1');
}

async function shouldTranslate(src) {
  const dst = enPath(src);
  if (!existsSync(dst)) return true;
  const [a, b] = await Promise.all([stat(src), stat(dst)]);
  return a.mtimeMs > b.mtimeMs;
}

function callClaude(prompt) {
  const r = spawnSync('/root/bin/claude-headless', ['--model', MODEL, '--print'], {
    input: prompt,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(`claude-headless failed (status ${r.status}): ${r.stderr}`);
  }
  return r.stdout.trim();
}

function stripFences(s) {
  // Defensive: strip any leading/trailing ``` blocks if Claude adds them.
  return s
    .replace(/^```(?:mdx|md|markdown)?\s*\n/, '')
    .replace(/\n```\s*$/, '')
    .trim();
}

async function translateFile(src) {
  const body = await readFile(src, 'utf8');
  const out = stripFences(callClaude(PROMPT + body));
  await writeFile(enPath(src), out, 'utf8');
}

async function main() {
  const files = await gather();
  console.log(`Found ${files.length} source files`);
  let done = 0, skipped = 0;
  for (const f of files) {
    if (!(await shouldTranslate(f))) { skipped++; continue; }
    console.log(`  translating ${f}`);
    try {
      await translateFile(f);
      done++;
    } catch (e) {
      console.error(`  FAILED: ${f}: ${e.message}`);
    }
  }
  console.log(`Translated ${done}, skipped ${skipped}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
