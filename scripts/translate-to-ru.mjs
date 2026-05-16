#!/usr/bin/env node
// Translate an MDX/MD file from English to Russian — used for one-time
// conversion of EN-source files (cs02.mdx body, right-panel md files)
// to RU source. After running, the regular RU→EN translator regenerates
// the .en.mdx twin.
//
// Usage: node scripts/translate-to-ru.mjs <file1.mdx> [file2.mdx ...]

import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const PROMPT = `You are translating an MDX/MD content file from English to Russian for a designer portfolio site (Roman Pogorov, senior product designer).

STRICT RULES — output ONLY the translated MDX/MD content, no commentary, no fences:

1. Preserve the YAML frontmatter block intact at the top — translate values for human-readable fields (title, desc, name, role, tags, showcase* strings, label/title/panelTitle inside arrays, etc.) ONLY IF they are English. If a field is already Russian or a proper noun, leave as-is. NEVER translate: id, accent, hex, rgb, order, src/href/url/thumb paths, dates, numbers, units.

2. Preserve every JSX/MDX tag and prop value untouched UNLESS the prop is human-readable text (label/title/caption/alt/desc). Translate alt/caption/label/title/panelTitle/desc INSIDE component props.

3. Preserve all <em>, <strong>, markdown emphasis, code fences, links, anchors (\`<a id=...>\`), heading levels.

4. Preserve all import statements verbatim.

5. Keep proper nouns unchanged: Americor, Health Samurai, Aidbox, Figma, Claude, ComfyUI, OpenAI, Storybook, MPI Box, FireCamp, GitHub, NotebookLM, Roman Pogorov, shadCN, FHIR, Kudos, MedTech, FinTech, etc.

6. Keep technical jargon: API, JSON, MDX, R3F, FPS, HUD, design system, dashboard, kudos, prompt, agent, LLM, code-first, code-review, UX, UI, A/B, NPS, CSAT, Storybook, etc. Use Russian where natural.

7. Tone: native, concise, designer-portfolio Russian. Match cyberpunk-terminal vibe ("// архив", "// готов").

8. Markdown / code: heading levels (###), bullet markers (-), table syntax, code fences (\`\`\`) — all preserved exactly.

9. Output ONLY the translated content. No \`\`\` fences, no "Here is the translation", nothing else.

--- BEGIN MDX/MD ---
`;

const files = process.argv.slice(2);
if (!files.length) {
  console.error('Usage: node translate-to-ru.mjs <file1> [file2 ...]');
  process.exit(1);
}

for (const file of files) {
  const body = await readFile(file, 'utf8');
  if (!/[a-zA-Z]/.test(body)) {
    console.log(`  skipping ${file} (no English content)`);
    continue;
  }
  console.log(`  translating ${file} (${body.length} chars)`);
  const r = spawnSync('/root/bin/claude-headless', ['--model', 'sonnet', '--print'], {
    input: PROMPT + body,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
  if (r.status !== 0) {
    console.error(`    FAILED: status ${r.status}: ${r.stderr}`);
    continue;
  }
  let out = r.stdout.trim();
  out = out.replace(/^```(?:mdx|md|markdown)?\s*\n/, '').replace(/\n```\s*$/, '').trim();
  await writeFile(file, out, 'utf8');
  console.log(`    written (${out.length} chars)`);
}
console.log('Done.');
