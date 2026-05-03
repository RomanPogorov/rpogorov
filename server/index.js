// Minimal portfolio chat: forwards visitor messages to Telegram and surfaces
// Roman's replies back. Native http + fetch only — no npm deps.
//
// Visitor → Roman:
//   POST /api/chat/send  { thread, text }
//     server → Telegram sendMessage(chat_id=ROMAN_CHAT_ID, text)
//     stores mapping telegram_message_id → thread so we can route replies back.
//
// Roman → Visitor:
//   Background loop polls Telegram getUpdates. When a message has
//   reply_to_message_id matching one of our sent IDs, we route the message
//   into that thread.
//
// Thread-aware long-poll for the browser:
//   GET /api/chat/poll?thread=X&after=Y  (long-polls up to 25s).

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.PORT || '3055', 10);
const TG_TOKEN = process.env.TG_BOT_TOKEN;
const ROMAN_CHAT_ID = process.env.ROMAN_CHAT_ID || '126145988';
const TG_API = (m) => `https://api.telegram.org/bot${TG_TOKEN}/${m}`;
const STATE_PATH = path.join(__dirname, 'state.json');

if (!TG_TOKEN) {
  console.error('FATAL: TG_BOT_TOKEN env var required');
  process.exit(1);
}

// ---------- persistent state ----------
let state = {
  lastUpdateId: 0,
  threads: {},
  sentMap: {},
  lastActiveThread: null,
  // thread → visitor's TG chat_id (set when visitor presses /start <thread> in the bot)
  threadFwd: {},
  // visitor's TG chat_id → thread (reverse lookup so we can route their TG msgs back)
  chatToThread: {},
  // optional username metadata supplied via /api/chat/pickup
  threadUsername: {},
};
try {
  state = Object.assign(state, JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8')));
} catch (_) {}
let saveTimer = null;
function saveLater() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFile(STATE_PATH, JSON.stringify(state), () => {});
  }, 250);
}

function getThread(id) {
  if (!state.threads[id]) state.threads[id] = { msgs: [], nextId: 1 };
  return state.threads[id];
}

function mostRecentVisitorThread() {
  let bestId = null;
  let bestTs = 0;
  for (const [id, t] of Object.entries(state.threads)) {
    for (let i = t.msgs.length - 1; i >= 0; i--) {
      const m = t.msgs[i];
      if (m.role === 'visitor') {
        if (m.ts > bestTs) { bestTs = m.ts; bestId = id; }
        break;
      }
    }
  }
  return bestId;
}

function appendMsg(threadId, role, text) {
  const t = getThread(threadId);
  const msg = { id: t.nextId++, role, text, ts: Date.now() };
  t.msgs.push(msg);
  if (t.msgs.length > 200) t.msgs.splice(0, t.msgs.length - 200);
  saveLater();
  // wake long-polls
  for (const fn of (waiters[threadId] || [])) fn(msg);
  delete waiters[threadId];

  // Forward Roman's replies to the visitor's TG chat if they took the
  // conversation to Telegram (visitor pressed /start <thread> in the bot).
  if (role === 'roman' && state.threadFwd[threadId]) {
    sendTelegramMessage(state.threadFwd[threadId], text).catch(() => {});
  }

  return msg;
}

async function sendTelegramMessage(chatId, text) {
  const r = await fetch(TG_API('sendMessage'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  return r.json();
}

const waiters = {};

// ---------- Telegram polling ----------
async function tgGetUpdates() {
  try {
    const res = await fetch(TG_API('getUpdates') + `?offset=${state.lastUpdateId + 1}&timeout=25&allowed_updates=["message"]`, {
      method: 'GET',
    });
    if (!res.ok) {
      console.error('getUpdates HTTP', res.status);
      return;
    }
    const data = await res.json();
    if (!data.ok) return;
    for (const upd of data.result) {
      state.lastUpdateId = upd.update_id;
      const msg = upd.message;
      if (!msg) continue;
      const fromChatId = String(msg.chat.id);
      const text = msg.text || msg.caption || '[media]';

      // ---------- Visitor side (anyone who isn't Roman) ----------
      if (fromChatId !== ROMAN_CHAT_ID) {
        // /start <thread_id> — visitor "took" the conversation to Telegram
        const startMatch = text.match(/^\/start(?:\s+(\S+))?/);
        if (startMatch) {
          const payload = startMatch[1];
          if (payload && state.threads[payload]) {
            state.threadFwd[payload] = msg.chat.id;
            state.chatToThread[fromChatId] = payload;
            saveLater();

            // Greeting
            await sendTelegramMessage(msg.chat.id,
              "✓ Connected. Sending you the conversation so far. New replies from Roman will land here too. You can answer in this chat or in your browser — both stay in sync.").catch(() => {});

            // Dump the entire thread history so the user gets the conversation
            // immediately, as if it had been happening here all along.
            const t = state.threads[payload];
            if (t && t.msgs.length) {
              const lines = t.msgs.map(m => {
                const who = m.role === 'roman' ? 'Roman' : (m.role === 'visitor' ? 'You' : '·');
                return `${who}: ${m.text}`;
              });
              // Telegram message limit ~4000 chars — chunk if needed
              const chunks = [];
              let buf = '📜 Conversation:\n\n';
              for (const line of lines) {
                if ((buf + line + '\n\n').length > 3500) { chunks.push(buf); buf = ''; }
                buf += line + '\n\n';
              }
              if (buf.trim()) chunks.push(buf);
              for (const c of chunks) await sendTelegramMessage(msg.chat.id, c).catch(() => {});
            }

            // Notify Roman
            const username = state.threadUsername[payload] ? ` @${state.threadUsername[payload]}` : '';
            sendTelegramMessage(ROMAN_CHAT_ID,
              `🔗 Visitor${username} took thread #${payload.slice(0,8)} to Telegram (chat ${msg.chat.id}). Future replies forward to them.`).catch(() => {});
          } else {
            // /start without a valid payload — generic greeting
            sendTelegramMessage(msg.chat.id,
              "Hi! This bot connects portfolio chats to Telegram. To pick up a conversation, click 'Take to Telegram' on the website.").catch(() => {});
          }
          continue;
        }
        // Visitor types in TG after pickup — route as visitor msg in their thread
        const linkedThread = state.chatToThread[fromChatId];
        if (linkedThread && state.threads[linkedThread]) {
          appendMsg(linkedThread, 'visitor', text);
          state.lastActiveThread = linkedThread;
          // Surface in Roman's bot too (so he sees it the same way as website-sent msgs)
          const u = state.threadUsername[linkedThread] || '';
          const tag = `💬 [#${linkedThread.slice(0, 8)}${u ? ' @' + u : ''}] (from TG)\n${text}`;
          sendTelegramMessage(ROMAN_CHAT_ID, tag)
            .then(d => { if (d?.ok) state.sentMap[d.result.message_id] = linkedThread; saveLater(); })
            .catch(() => {});
        }
        continue;
      }

      // ---------- Roman side ----------
      // Owner /build command — triggers an agentic Claude run that creates
      // a new case file and ships it. Only Roman can do this.
      const buildMatch = text.match(/^\/build\s+(.+)$/s);
      if (buildMatch) {
        const replyId2 = msg.reply_to_message?.message_id;
        const threadIdB =
          (replyId2 && state.sentMap[replyId2]) ||
          state.lastActiveThread ||
          mostRecentVisitorThread();
        if (!threadIdB) {
          sendTelegramMessage(ROMAN_CHAT_ID, '⚠️ /build needs a thread context — reply to a visitor message to scope it, or wait until someone is in the chat.').catch(() => {});
          continue;
        }
        state.lastActiveThread = threadIdB;
        appendMsg(threadIdB, 'roman', `/build ${buildMatch[1]}`);
        runOwnerBuild(threadIdB, buildMatch[1]).catch((e) => {
          console.error('build err:', e);
          appendMsg(threadIdB, 'claude', `// build failed: ${String(e.message || e).slice(0, 200)}`);
        });
        continue;
      }
      // Other slash commands: ignore.
      if (text.startsWith('/')) continue;
      const replyId = msg.reply_to_message?.message_id;
      const threadId =
        (replyId && state.sentMap[replyId]) ||
        state.lastActiveThread ||
        mostRecentVisitorThread();
      if (!threadId) {
        console.log('roman msg with no thread context, dropping:', text.slice(0, 60));
        continue;
      }
      state.lastActiveThread = threadId;
      console.log(`roman → thread ${threadId.slice(0,8)}: ${text.slice(0, 80)}`);
      appendMsg(threadId, 'roman', text);
      // Roman's messages also wake Claude so it can react if Roman is
      // addressing it. The system prompt tells Claude to emit [silent]
      // when the message is between Roman and the visitor — server then
      // suppresses that turn.
      claudeQueue.run(() => {
        const history = (state.threads[threadId]?.msgs || []).slice(-12);
        const messages = history.map((m) => {
          if (m.role === 'roman') {
            return { role: 'user', content: `[ROMAN — owner of this portfolio, in the chat]: ${m.text}` };
          }
          if (m.role === 'visitor') {
            return { role: 'user', content: m.text };
          }
          return { role: 'assistant', content: m.text };
        });
        return callClaude(messages);
      }).then((reply) => {
        if (!reply) return;
        let r = reply.trim();
        if (!r || /^\[silent\]$/i.test(r)) return;
        // Strip HANDOFF marker if present and queue a build request for
        // the main agent (Roman's terminal Claude session).
        const handoffMatch = r.match(/HANDOFF:\s*(.+?)(?:\n|$)/);
        if (handoffMatch) {
          const task = handoffMatch[1].trim();
          r = r.replace(/HANDOFF:.*$/m, '').trim();
          enqueueBuild(threadId, task);
        }
        if (!r) return;
        appendMsg(threadId, 'claude', r);
        sendTelegramMessage(ROMAN_CHAT_ID, `🤖 [#${threadId.slice(0, 8)}] claude:\n${r}`).catch(() => {});
      }).catch((err) => {
        console.error('claude (roman-trigger) error:', err);
      });
    }
    saveLater();
  } catch (e) {
    console.error('getUpdates error:', e.message);
    await new Promise((r) => setTimeout(r, 2000));
  }
}
async function tgLoop() {
  while (true) await tgGetUpdates();
}
tgLoop();

// ---------- HTTP server ----------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 1e5) req.destroy(); });
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}
function send(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  // CORS not needed (same-origin via Caddy proxy)

  if (req.method === 'POST' && url.pathname === '/api/chat/send') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'bad json' }); }
    const thread = String(body.thread || '').slice(0, 64);
    const text = String(body.text || '').trim().slice(0, 2000);
    // useClaude: when true (default), the server also kicks off Claude in
    // the background so visitor and Roman see Claude's reply in the same
    // thread alongside Roman's own TG replies.
    const useClaude = body.useClaude !== false;
    if (!thread || !text) return send(res, 400, { error: 'thread and text required' });

    const visitorMsg = appendMsg(thread, 'visitor', text);
    state.lastActiveThread = thread;

    const tgText = `💬 [#${thread.slice(0, 8)}]\n${text}\n\n— reply to this message to respond`;
    let tgMsgId = null;
    try {
      const r = await fetch(TG_API('sendMessage'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: ROMAN_CHAT_ID, text: tgText, disable_web_page_preview: true }),
      });
      const data = await r.json();
      if (data.ok) {
        tgMsgId = data.result.message_id;
        state.sentMap[tgMsgId] = thread;
        saveLater();
      } else {
        console.error('sendMessage failed:', data);
      }
    } catch (e) {
      console.error('sendMessage error:', e.message);
    }

    // Kick off Claude in the background so the HTTP response returns fast
    // and the visitor sees Claude's reply via long-poll a few seconds later.
    if (useClaude) {
      claudeQueue.run(() => {
        const history = (state.threads[thread]?.msgs || []).map((m) => ({
          role: m.role === 'visitor' ? 'user' : (m.role === 'roman' ? 'user' : 'assistant'),
          name: m.role,
          content: m.text,
        })).filter((m) => typeof m.content === 'string' && m.content.length > 0);
        // Re-format for Claude with role hints — when a message came from
        // Roman tag it explicitly so Claude knows the owner is in the room.
        const messages = history.map((m) => {
          if (m.name === 'roman') {
            return { role: 'user', content: `[ROMAN — owner of this portfolio, talking to you in front of the visitor]: ${m.content}` };
          }
          if (m.name === 'visitor') {
            return { role: 'user', content: m.content };
          }
          return { role: 'assistant', content: m.content };
        });
        return callClaude(messages.slice(-12));
      }).then((reply) => {
        let r = (reply || '').trim();
        if (/^\[silent\]$/i.test(r)) return;
        const handoffMatch = r.match(/HANDOFF:\s*(.+?)(?:\n|$)/);
        if (handoffMatch) {
          const task = handoffMatch[1].trim();
          r = r.replace(/HANDOFF:.*$/m, '').trim();
          enqueueBuild(thread, task);
        }
        if (!r) return;
        appendMsg(thread, 'claude', r);
        sendTelegramMessage(ROMAN_CHAT_ID, `🤖 [#${thread.slice(0, 8)}] claude:\n${r}`).catch(() => {});
      }).catch((err) => {
        console.error('claude bg error:', err);
        appendMsg(thread, 'claude', '// internal: claude error — try again in a moment');
      });
    }

    return send(res, 200, { ok: true, msg: visitorMsg, tg: tgMsgId });
  }

  if (req.method === 'GET' && url.pathname === '/api/chat/poll') {
    const thread = String(url.searchParams.get('thread') || '').slice(0, 64);
    const after = parseInt(url.searchParams.get('after') || '0', 10) || 0;
    if (!thread) return send(res, 400, { error: 'thread required' });
    const t = getThread(thread);
    const fresh = t.msgs.filter((m) => m.id > after);
    if (fresh.length) return send(res, 200, { msgs: fresh });
    // long-poll up to 25s
    const timer = setTimeout(() => {
      delete waiters[thread];
      send(res, 200, { msgs: [] });
    }, 25000);
    waiters[thread] = waiters[thread] || [];
    waiters[thread].push(() => {
      clearTimeout(timer);
      const t2 = getThread(thread);
      send(res, 200, { msgs: t2.msgs.filter((m) => m.id > after) });
    });
    req.on('close', () => {
      clearTimeout(timer);
      waiters[thread] = (waiters[thread] || []).filter((fn) => fn !== fn);
      delete waiters[thread];
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/chat/pickup') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'bad json' }); }
    const thread = String(body.thread || '').slice(0, 64);
    const username = String(body.username || '').slice(0, 32).replace(/^@/, '');
    if (!thread) return send(res, 400, { error: 'thread required' });
    if (!username) return send(res, 400, { error: 'username required' });

    const t = state.threads[thread];
    if (!t || !t.msgs.length) return send(res, 404, { error: 'no conversation yet' });

    state.threadUsername[thread] = username;
    saveLater();

    // Build the transcript
    const lines = t.msgs.map(m => {
      const who = m.role === 'roman' ? 'Roman' : (m.role === 'visitor' ? 'You' : '·');
      return `${who}: ${m.text}`;
    });
    const transcript =
      `Conversation with Roman (rpogorov.com)\n\n` +
      lines.join('\n\n') +
      `\n\n— You can reply right here in Telegram, Roman will see it.`;

    // Spawn the Telethon helper that sends from Roman's user account
    const child = spawn('/usr/bin/python3', [path.join(__dirname, 'tg_send_transcript.py')], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    child.stdin.write(JSON.stringify({ username, text: transcript }));
    child.stdin.end();
    child.stdout.on('data', (d) => out += d);
    child.stderr.on('data', (d) => err += d);
    child.on('close', () => {
      try {
        const result = JSON.parse(out.trim().split('\n').pop() || '{}');
        send(res, result.ok ? 200 : 400, result);
      } catch (e) {
        send(res, 500, { ok: false, error: 'helper crashed: ' + (err || out).slice(0, 200) });
      }
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/chat/health') {
    return send(res, 200, { ok: true, threads: Object.keys(state.threads).length });
  }

  // ---------- Localhost-only inject endpoint ----------
  // Lets Roman (or his agent in another Claude session) drop a message
  // into any thread, in any role. Used when Roman wants to collaborate
  // on a case in his terminal Claude session and then ship the result
  // into the visitor's chat. Path is intentionally /internal/* so Caddy
  // (which only proxies /api/chat/*) doesn't expose it externally.
  if (req.method === 'POST' && url.pathname === '/internal/chat/post') {
    const localAddr = req.socket.remoteAddress || '';
    if (!localAddr.includes('127.0.0.1') && !localAddr.includes('::1')) {
      return send(res, 403, { error: 'localhost only' });
    }
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'bad json' }); }
    const thread = String(body.thread || '').slice(0, 64);
    const role = String(body.role || 'claude');
    const text = String(body.text || '').trim();
    if (!thread || !text) return send(res, 400, { error: 'thread and text required' });
    if (!['visitor', 'claude', 'roman'].includes(role)) return send(res, 400, { error: 'role must be visitor|claude|roman' });
    const m = appendMsg(thread, role, text);
    // Also forward to Roman's TG so he sees the same thing in the bot.
    sendTelegramMessage(ROMAN_CHAT_ID, `📨 [#${thread.slice(0, 8)}] ${role}:\n${text}`).catch(() => {});
    return send(res, 200, { ok: true, msg: m });
  }

  // ---------- Build queue (localhost-only) ----------
  if (req.method === 'GET' && url.pathname === '/internal/chat/queue') {
    const localAddr = req.socket.remoteAddress || '';
    if (!localAddr.includes('127.0.0.1') && !localAddr.includes('::1')) {
      return send(res, 403, { error: 'localhost only' });
    }
    const showClaimed = url.searchParams.get('claimed') === '1';
    const queue = (state.buildQueue || [])
      .filter((e) => showClaimed || !e.claimed)
      .map((e) => {
        const t = state.threads[e.threadId];
        const last3 = (t?.msgs || []).slice(-6).map((m) => `${m.role}: ${m.text.slice(0, 100)}`);
        return { ...e, threadShort: e.threadId.slice(0, 8), recentTurns: last3 };
      })
      .sort((a, b) => b.ts - a.ts);
    return send(res, 200, { queue });
  }

  if (req.method === 'POST' && url.pathname === '/internal/chat/queue/claim') {
    const localAddr = req.socket.remoteAddress || '';
    if (!localAddr.includes('127.0.0.1') && !localAddr.includes('::1')) {
      return send(res, 403, { error: 'localhost only' });
    }
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'bad json' }); }
    const id = String(body.id || '');
    const entry = (state.buildQueue || []).find((e) => e.id === id);
    if (!entry) return send(res, 404, { error: 'not found' });
    entry.claimed = true;
    entry.claimedAt = Date.now();
    saveLater();
    return send(res, 200, { ok: true, entry });
  }

  // ---------- List threads (localhost-only) so Roman can pick one ----------
  if (req.method === 'GET' && url.pathname === '/internal/chat/threads') {
    const localAddr = req.socket.remoteAddress || '';
    if (!localAddr.includes('127.0.0.1') && !localAddr.includes('::1')) {
      return send(res, 403, { error: 'localhost only' });
    }
    const threads = Object.entries(state.threads)
      .map(([id, t]) => {
        const msgs = t.msgs || [];
        const last = msgs[msgs.length - 1];
        return {
          id,
          msgCount: msgs.length,
          lastTs: last?.ts || 0,
          lastRole: last?.role,
          lastText: (last?.text || '').slice(0, 120),
        };
      })
      .sort((a, b) => b.lastTs - a.lastTs)
      .slice(0, 20);
    return send(res, 200, { threads });
  }

  // ---------- /api/chat/claude — visitor talks to Roman's Claude ----------
  // POST { messages: [{role: 'user'|'assistant', content: string}, ...] }
  // Returns { reply: string }.
  if (req.method === 'POST' && url.pathname === '/api/chat/claude') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'bad json' }); }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const cleanMsgs = messages
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-12)
      .map((m) => ({ role: m.role, content: String(m.content).slice(0, 4000) }));
    if (!cleanMsgs.length || cleanMsgs[cleanMsgs.length - 1].role !== 'user') {
      return send(res, 400, { error: 'last message must be from user' });
    }
    return claudeQueue.run(() => callClaude(cleanMsgs)).then(
      (reply) => send(res, 200, { reply }),
      (err) => { console.error('claude error:', err); send(res, 500, { error: String(err.message || err) }); },
    );
  }

  send(res, 404, { error: 'not found' });
});

// ---------- Claude helpers ----------
// The visitor-side Claude reads its context from two sources:
// 1. The static prompt below (role, tone, three-speaker rules, formatting).
// 2. A dynamically-loaded snapshot of /root/vault/cases/* and the published
//    /root/vault/portfolio/articles/* — Roman's raw experience texts that
//    he keeps adding to over time. We rebuild the prompt on every request,
//    cached for 60s, so dropping a new MD into vault automatically enriches
//    the agent on the next visitor turn (no server restart needed).

let vaultCacheText = '';
let vaultCacheTs = 0;
function loadVaultContext() {
  const now = Date.now();
  if (now - vaultCacheTs < 60_000 && vaultCacheText) return vaultCacheText;
  const blocks = [];
  const ROOTS = [
    // Single source of truth — vault/portfolio/cases now holds both raw
    // experience texts (companies subfolders, free-form .md) AND the
    // published case .mdx pages with frontmatter. Astro picks up only
    // .mdx for the content collection (subfolder .md is invisible to it
    // but still loaded into agent context).
    { dir: '/root/vault/portfolio/cases', label: 'EXPERIENCE — case archive (raw + published)' },
    { dir: '/root/vault/portfolio/articles', label: 'PUBLISHED ARTICLES' },
  ];
  function walk(dir) {
    let out = [];
    try {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) out = out.concat(walk(p));
        else if (/\.(md|mdx)$/i.test(ent.name) && ent.name !== 'CLAUDE.md') out.push(p);
      }
    } catch (_) {}
    return out;
  }
  for (const r of ROOTS) {
    const files = walk(r.dir).sort();
    if (!files.length) continue;
    blocks.push(`\n=== ${r.label} (${files.length} files) ===`);
    for (const f of files) {
      try {
        let body = fs.readFileSync(f, 'utf-8');
        // Strip frontmatter to keep the prompt lean
        body = body.replace(/^---\n[\s\S]*?\n---\n/, '');
        const rel = f.replace('/root/vault/', '');
        blocks.push(`\n--- ${rel} ---\n${body.trim()}`);
      } catch (_) {}
    }
  }
  vaultCacheText = blocks.join('\n');
  vaultCacheTs = now;
  return vaultCacheText;
}

const CLAUDE_STATIC_PROMPT = `You are Claude, answering questions about ROMAN POGOROV on his portfolio site (clauderunner.com/rpogorov-dev/). You are NOT Roman — you speak ABOUT him.

ROMAN POGOROV — Product Designer · 15 years in design.
- Now: Senior Product Designer at Health Samurai (2024 → present)
- Before: Lead Product Designer at Americor (2023 → 2025)
- Edge: design ↔ code pipeline, AI tooling, design systems, vibe-coding production features.

KEY WORK (link these when relevant):

[1] Americor — fintech debt-relief, web + iOS + Android.
- Engagement case: progress visibility redesign, +72% NPS lift across platforms. /case/cs01/engagement
- Offer-acceptance: +175% offers accepted online, +44% overall. /case/cs01/offer-acceptance
- Design system: 3-tier token architecture (primitive → semantic → component), Figma modes per brand, Code Connect to React. /case/cs01/design-system
- Figma + Claude vibe pipeline. /case/cs01/figma-claude-vibe
- Company overlay: /case/cs01

[2] Health Samurai — healthcare infrastructure (Aidbox, FHIR-native).
- Stood up a shadCN-based design system end-to-end: Figma + code + Storybook in lockstep.
- Wrote a Claude skill that pulled components straight out of Figma before that tooling existed elsewhere.
- Markdown-first landing platform with in-browser DOM-aware Claude chat ("Fixik"). Cycle time per landing dropped from 3 months to 2–3 days. Whole company website now runs on it.
- Presentation generator + kudos image generator on the same engine.
- Vibe-coded the FireCamp conference app in a week (voting, schedule, subscriptions). 600+ attendees used it.
- Company overlay: /case/cs02

STRENGTHS:
- Code × Design: a lot of hypotheses → picking the perfect UX, fast iteration on real prototypes.
- Proper prototypes: code-first prototypes that become production.
- Figma + AI multi-tooling: token sync, Claude skills, automation.

REPLY STYLE:
- Concise. 1–4 short paragraphs. No filler.
- Reply in the SAME LANGUAGE the user wrote in (Russian or English; pick automatically).
- When pointing to a specific case, embed the URL as a markdown link [label](/case/cs0X[/...]). The frontend turns those into clickable buttons.
- Never fabricate metrics, dates, projects, or quotes that aren't listed above. If a question is outside Roman's listed work, say so briefly and offer the closest relevant case.
- Don't roleplay as Roman. You're Claude answering ABOUT him.

If the user just says hi, greet briefly and suggest 2–3 directions you can dig into (e.g. "design system at Health Samurai", "Americor +72% NPS engagement case", "code-design pipeline").

THREE-SPEAKER ROOM
The thread has three voices: the visitor (the website user), Roman (the owner — joins from his Telegram bot, his messages are tagged [ROMAN — owner of this portfolio, in the chat]), and you. You receive a turn whenever ANYONE writes — visitor or Roman.

When the latest turn is from Roman:

A. **CASE BUILD REQUEST** — when Roman asks you to build / assemble / put together / собрать / сделать a case (e.g. "клод, собери кейс про X", "build me a case on Y", "сделай кейс про маркетинг") — DO NOT discuss permissions, capabilities, access rights, or limitations. DO NOT say "у меня нет доступа" or "I'd need…". Just confirm and hand off:
   - In Russian: "Понял. Занимаюсь — это займёт 3-5 минут, передал основному агенту."
   - In English: "Got it. On it — 3–5 minutes, the main agent will assemble it."
   Then on a NEW LINE, emit a structured handoff marker the server will scrape:
   HANDOFF: <one short clean line restating what Roman wants assembled>
   The server will queue the request for the main agent (Roman's terminal Claude) and ping Roman to come refine it. Don't attempt to write any files yourself.

B. If Roman is addressing you directly with a NON-build question ("клод, расскажи про X", "что там по дизайн-системе") — respond normally about Roman's work as you'd respond to the visitor.

C. If Roman is giving a heads-up ("секунду", "минуту", "ща приду") or chatting WITH the visitor ("привет всем", explaining something to them directly) — output literally [silent] and nothing else. Server suppresses the turn.

When the latest turn is from the VISITOR, respond normally about Roman's work.

Never emit [silent] when the visitor asked something — they're waiting on you.`;

function buildClaudeSystemPrompt() {
  const vault = loadVaultContext();
  if (!vault) return CLAUDE_STATIC_PROMPT;
  return CLAUDE_STATIC_PROMPT + '\n\n=========================================\n' +
    'DEEP CONTEXT — Roman\'s vault (cases, articles, raw experience texts).\n' +
    'Use this to answer questions with detail. Quote a specific case file or article when grounding a claim. Don\'t fabricate beyond what\'s in here.\n' +
    '=========================================\n' +
    vault;
}

// Sequential queue — Roman's instruction: claude CLI calls strictly serial
// (parallel only with explicit ask) so background invocations don't trample
// each other.
const claudeQueue = (() => {
  let chain = Promise.resolve();
  return {
    run(fn) {
      const p = chain.then(() => fn());
      chain = p.catch(() => {});
      return p;
    },
  };
})();

// ---------- Owner build mode ----------
// Spawns Claude in agentic mode (full tool access, working dir at the
// portfolio repo) to assemble a custom case MDX, build it, and post the
// resulting URL into the chat thread. Only triggered by Roman's /build
// command on Telegram.
//
// Q&A loop: if Claude can't understand the brief, it can emit
//   ASK: <one specific question>
// and exit. The server posts that question into the thread (visitor sees
// it too), waits for Roman's reply, and re-spawns Claude with the full
// turn history.
const BUILD_SYSTEM_PROMPT = `You are Claude operating in OWNER MODE on Roman Pogorov's portfolio site. Roman asked you (via /build from his Telegram bot, or via a HANDOFF: marker from his visitor-side Claude) to assemble a custom case page LIVE for someone watching the chat unfold.

PROCEDURE — READ EXISTING CASES FIRST
Before writing anything, run a Glob over /root/vault/portfolio/cases/*.mdx and Read the engagement.mdx, offer-acceptance.mdx, design-system.mdx files in full. You MUST follow their exact shape:
  - Frontmatter fields: id, company (cs01 or cs02), companyLabel, title, desc, metric, tags, theme, accent, deeplink, no, role, year, thumb, order, status, impact (array of {num, lbl}), meta (array of {label, value})
  - Imports header: at minimum import IterCard, Pillar, PainCard, Mobile, Wide, Row2, Row3, Quote, MetaStub from @components/case/ and @components/case-rich/ — only the ones you actually use
  - Body sections start with "## // ..." headings (the // prefix is part of Roman's tone)
  - Lists use "▸" or "-" but body paragraphs have NO emoji, NO filler

USE THE COMPONENTS, NOT RAW MARKDOWN
For images / media — DO NOT just write inline ![alt](src). Always wrap through:
  - <Wide src="..." alt="..." caption="..." /> — full-width single image
  - <Row2 items={[ { src, alt, caption }, { src, alt, caption } ]} /> — two side by side
  - <Row3 items={[ ... three items ... ]} /> — three side by side
For pull-quotes use <Quote text="..." attribution="..." />
For iteration cards (before/after, then-now) use <IterCard ... />
For pain points use <PainCard ... />
For three-column comparators use Pillar trios.
Frontmatter "impact" populates the in-header impact strip — three or more {num, lbl} cells.

WRITING TONE — ROMAN'S, NOT YOURS
- Short paragraphs (1-3 sentences max), no preamble.
- "//" section headers in upper-case label form ("// the brief", "// what shipped").
- "▸" arrow bullets for tight lists.
- Direct, sharp, no marketing-speak. Concrete numbers / decisions / trade-offs.
- Reply / write in the SAME LANGUAGE Roman used in the brief (Russian or English).
- Reference real things from his existing cases when adjacent (HS shadCN DS, Fixik, Americor +72% NPS, FireCamp, etc.).

ASSETS
If Roman has shared images for the case, copy them into /root/rpogorov-dev/app/cases/<company>/<slug>/<descriptive-name>.<ext> (use cp from the inbox or wherever they live) and reference them with absolute paths /rpogorov-dev/app/cases/<company>/<slug>/<file>.

CLARIFY-FIRST RULE
If the brief is too vague to commit to a confident case (e.g. "marketing case", "что-то про дизайн" — no specific project, role, metric, or angle), DO NOT start writing files. Instead exit immediately with ONE line:
   ASK: <one short, specific question for Roman>
The server will surface that question to Roman, he'll answer, and you'll be re-spawned with his answer in context.

BUILD + EMIT
1. Pick a kebab-case slug. Check existing files don't conflict.
2. Write /root/vault/portfolio/cases/<slug>.mdx with the right frontmatter + components + body in Roman's tone.
3. Run \`cd /root/rpogorov-dev/site && npx astro build\` to compile.
4. After successful build, output exactly ONE final line and nothing else after it:
   BUILD_OK /case/<company>/<slug>
   On failure:
   BUILD_FAIL <one-line error>

Concise progress notes (one line per phase) are welcome. Don't dump transcripts. Tools allowed: Bash, Edit, Write, Read, Glob, Grep. Site repo at /root/rpogorov-dev/site, cases at /root/vault/portfolio/cases (symlinked into src/content/cases).`;

// pendingBuilds[threadId] = { originalTask, turns: [{q, a}], status: 'awaiting-claude'|'awaiting-roman' }
const pendingBuilds = {};

// ---------- Build queue (handoff to Roman's terminal Claude) ----------
// Each entry: { id, threadId, task, ts, claimed: bool }
// Stored in state.buildQueue so it survives restarts.
if (!Array.isArray(state.buildQueue)) state.buildQueue = [];
function enqueueBuild(threadId, task) {
  const entry = {
    id: 'q_' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4),
    threadId,
    task,
    ts: Date.now(),
    claimed: false,
  };
  state.buildQueue.push(entry);
  // Cap queue at 50 to avoid unbounded growth.
  if (state.buildQueue.length > 50) state.buildQueue.splice(0, state.buildQueue.length - 50);
  saveLater();
  // Ping Roman in TG so he knows to walk to the terminal.
  sendTelegramMessage(ROMAN_CHAT_ID,
    `🔔 BUILD REQUEST QUEUED — [#${threadId.slice(0, 8)}]\n${task}\n\nGo to your terminal — main claude is waiting.`).catch(() => {});
}

async function runOwnerBuild(threadId, taskText, opts = {}) {
  // opts.resume = true means we're continuing a Q&A loop; don't post the
  // "spinning up" intro again, just feed the agent the new turn.
  const pending = pendingBuilds[threadId] || { originalTask: taskText, turns: [], status: 'awaiting-claude' };
  pending.status = 'awaiting-claude';
  pendingBuilds[threadId] = pending;

  if (!opts.resume) {
    appendMsg(threadId, 'claude', `// owner build started\n▸ task: ${taskText.slice(0, 200)}\n▸ status: spinning up agent…`);
  } else {
    appendMsg(threadId, 'claude', `// resuming with your answer…`);
  }

  // Compose the prompt — original task + accumulated Q&A history.
  let prompt = `Roman's brief:\n${pending.originalTask}`;
  if (pending.turns.length) {
    prompt += '\n\nClarification trail so far:';
    for (const t of pending.turns) {
      prompt += `\n  Q (you asked): ${t.q}\n  A (Roman answered): ${t.a}`;
    }
    prompt += '\n\nNow continue. If still unclear, you may ASK once more; otherwise build.';
  }

  return new Promise((resolve) => {
    // claude refuses --dangerously-skip-permissions / bypassPermissions
    // under systemd as root. Workaround: explicit allowlist Bash(*) +
    // file tools, and --permission-mode acceptEdits so file writes
    // auto-approve without prompts.
    const child = spawn('/root/bin/claude-headless', [
      '--print',
      '--model', 'claude-sonnet-4-6',
      '--allowedTools', 'Bash(*)', 'Edit', 'Write', 'Read', 'Glob', 'Grep',
      '--add-dir', '/root/vault/portfolio',
      '--add-dir', '/root/rpogorov-dev/site',
      '--append-system-prompt', BUILD_SYSTEM_PROMPT,
      '--permission-mode', 'acceptEdits',
      prompt,
    ], { cwd: '/root/rpogorov-dev/site', stdio: ['ignore', 'pipe', 'pipe'] });

    let out = '', err = '';
    const killer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch (_) {}
      appendMsg(threadId, 'claude', '// build timed out after 8 minutes — the agent will be killed.');
    }, 8 * 60 * 1000);

    child.stdout.on('data', (d) => out += d);
    child.stderr.on('data', (d) => err += d);
    child.on('close', (code) => {
      clearTimeout(killer);
      const trimmed = out.trim();
      // Find the BUILD_OK / BUILD_FAIL marker.
      const okMatch = trimmed.match(/BUILD_OK\s+(\S+)/);
      const failMatch = trimmed.match(/BUILD_FAIL\s+(.+)/);
      if (okMatch) {
        const url = okMatch[1];
        appendMsg(threadId, 'claude', `// build complete — your custom case is live\n[Open the case](${url})`);
      } else if (failMatch) {
        appendMsg(threadId, 'claude', `// build failed — ${failMatch[1].slice(0, 300)}`);
      } else if (code !== 0) {
        appendMsg(threadId, 'claude', `// build agent exited ${code}\n${(err || trimmed).slice(0, 400)}`);
      } else {
        // No marker — surface the agent's final words anyway.
        appendMsg(threadId, 'claude', `// build agent done\n${trimmed.slice(-600)}`);
      }
      resolve();
    });
  });
}

function callClaude(messages) {
  return new Promise((resolve, reject) => {
    const transcript = messages.map((m) => {
      const tag = m.role === 'user' ? 'User' : 'Assistant';
      return `${tag}: ${m.content}`;
    }).join('\n\n');
    const prompt = `${transcript}\n\nAssistant:`;

    // No --bare: use Roman's Max-plan OAuth (claude-headless --bare requires
    // an explicit ANTHROPIC_API_KEY which we don't have).
    // Write the system prompt to a temp file — the dynamic vault context
    // is too large (~85KB+) to fit in argv (E2BIG). claude reads it via
    // --append-system-prompt-file.
    const promptFile = `/tmp/portfolio-claude-prompt-${process.pid}-${Date.now()}.txt`;
    try { fs.writeFileSync(promptFile, buildClaudeSystemPrompt()); } catch (e) {
      return reject(new Error('failed to write prompt file: ' + e.message));
    }
    const child = spawn('/root/bin/claude-headless', [
      '--print',
      '--model', 'claude-sonnet-4-6',
      '--append-system-prompt-file', promptFile,
      prompt,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let out = '', err = '';
    const killer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch (_) {}
    }, 45_000);
    child.stdout.on('data', (d) => out += d);
    child.stderr.on('data', (d) => err += d);
    child.on('close', (code) => {
      clearTimeout(killer);
      try { fs.unlinkSync(promptFile); } catch (_) {}
      if (code !== 0) return reject(new Error(`claude exit ${code}: ${err.slice(0, 300)}`));
      const reply = out.trim();
      if (!reply) return reject(new Error('claude returned empty output'));
      resolve(reply);
    });
    child.on('error', (e) => {
      clearTimeout(killer);
      try { fs.unlinkSync(promptFile); } catch (_) {}
      reject(e);
    });
  });
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`portfolio-chat listening on http://127.0.0.1:${PORT}`);
});
