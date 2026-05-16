#!/usr/bin/env node
// Extract user-visible strings from legacy-body.html, translate to RU,
// write legacy-body.ru.html with substitutions.

import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const SRC = '/root/rpogorov-dev/site/src/legacy-body.html';
const DST = '/root/rpogorov-dev/site/src/legacy-body.ru.html';

const html = await readFile(SRC, 'utf8');

// 1. Mask out <script>, <style> AND <!-- comments --> so we don't extract
//    from them. Comments often carry structural markers (e.g. "By Cases view")
//    that regexes in index.astro rely on — translating them breaks the build.
const blocks = [];
let masked = html.replace(/<(script|style)\b[\s\S]*?<\/\1>|<!--[\s\S]*?-->/gi, (m) => {
  const k = `__BLOCK_${blocks.length}__`;
  blocks.push(m);
  return k;
});

// 2. Collect candidate strings:
//    - text between tags (>...<)
//    - aria-label, alt, title (attribute) values
const candidates = new Set();
const ATTR_RE = /\s(?:aria-label|alt|title|placeholder)="([^"]+)"/g;
const TEXT_RE = />([^<>{}]+?)</g;

for (const m of masked.matchAll(ATTR_RE)) {
  const v = m[1].trim();
  if (v && /[a-zA-Z]/.test(v) && v.length > 1 && v.length < 200) candidates.add(v);
}
for (const m of masked.matchAll(TEXT_RE)) {
  const v = m[1].trim();
  if (!v) continue;
  if (!/[a-zA-Z]/.test(v)) continue; // Skip pure punctuation/numbers/symbols
  if (v.length < 2 || v.length > 300) continue;
  if (/^[<>&\s ]+$/.test(v)) continue;
  // Skip if it's mostly markup-like / placeholder
  if (/^&[a-z]+;$/.test(v)) continue;
  candidates.add(v);
}

const strings = Array.from(candidates).sort((a, b) => b.length - a.length);
console.log(`Found ${strings.length} candidate strings`);

// 3. Send to claude in JSON form: ask for {en: ru} map
const PROMPT = `You are translating UI strings for a designer portfolio site from English to Russian. The site belongs to Roman Pogorov, senior product designer.

I'll give you a JSON array of English strings. Return a JSON object mapping each English string to its Russian translation.

STRICT RULES:
- Return ONLY a JSON object: {"en1": "ru1", "en2": "ru2", ...}
- No commentary, no markdown fences, no explanations
- Preserve proper nouns unchanged: Americor, Health Samurai, Aidbox, Figma, Claude, ComfyUI, OpenAI, Storybook, MPI Box, FireCamp, GitHub, NotebookLM, Roman Pogorov, CLAUDE RUNNER (the logo)
- Preserve technical jargon often left in English in Russian tech contexts: API, JSON, MDX, R3F, FPS, HUD, terminal, design system, dashboard, kudos, prompt, agent, LLM
- Year ranges & numbers stay as-is (2014 — 2026, +18%, etc.)
- Special chars / arrows (→, ↑, ↓, ←, ▸, ◆, ·, •, /, |, :) preserved as in source
- Tone: native, concise, designer-portfolio Russian. Cyberpunk-terminal vibe ("// архив", "// агенты", "// готов")
- If a string is already in Russian or mixed Russian/English, return it unchanged
- If a string is mostly a code-like identifier (single word with underscores/CamelCase, or looks like a slug), return unchanged
- If you're unsure how to translate (proper-noun-like or technical), return unchanged

Strings to translate (JSON array):

${JSON.stringify(strings)}
`;

console.log(`Sending ${strings.length} strings (${PROMPT.length} chars)...`);

const r = spawnSync('/root/bin/claude-headless', ['--model', 'sonnet', '--print'], {
  input: PROMPT,
  encoding: 'utf8',
  maxBuffer: 50 * 1024 * 1024,
});

if (r.status !== 0) {
  console.error(`claude-headless failed: status ${r.status}`);
  console.error(r.stderr);
  process.exit(1);
}

let out = r.stdout.trim();
out = out.replace(/^```(?:json)?\s*\n/, '').replace(/\n```\s*$/, '').trim();
// Some Sonnet runs return body without the wrapping braces — auto-wrap.
if (!out.startsWith('{')) out = '{' + out;
if (!out.endsWith('}')) out = out + '}';

let dict;
try {
  dict = JSON.parse(out);
} catch (e) {
  console.error('Failed to parse JSON:', e.message);
  console.error('First 500 chars of output:', out.slice(0, 500));
  process.exit(1);
}

console.log(`Got ${Object.keys(dict).length} translations`);

// 4. Substitute ONLY in masked HTML (script/style blocks already
//    replaced with placeholders), then unmask. This guarantees we never
//    touch JS/CSS code even if an English word appears both in UI text
//    and inside getElementById/className/etc.
let result = masked;
const sorted = Object.entries(dict).sort((a, b) => b[0].length - a[0].length);
let count = 0;
for (const [en, ru] of sorted) {
  if (!ru || ru === en) continue;
  const re = new RegExp(en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  const before = result;
  result = result.replace(re, ru);
  if (before !== result) count++;
}
console.log(`Substituted ${count} unique strings`);

// Restore blocks
result = result.replace(/__BLOCK_(\d+)__/g, (_, i) => blocks[+i]);

await writeFile(DST, result, 'utf8');
console.log(`Wrote ${DST} (${result.length} chars)`);
