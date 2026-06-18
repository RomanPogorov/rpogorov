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
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.PORT || '3055', 10);
const TG_TOKEN = process.env.TG_BOT_TOKEN;
const ROMAN_CHAT_ID = process.env.ROMAN_CHAT_ID || '126145988';
// Portfolio password gate. GATE_PASSWORD is the SHARED ("общий") password.
// Each access request also mints a PRIVATE ("частный") per-user password,
// stored in state.gatePasswords with usage stats. Both unlock the site.
const GATE_PASSWORD = process.env.GATE_PASSWORD || 'change-me-in-env';
// Readable, unique-ish per-user password: themed word + 4 hex chars.
const PW_WORDS = ['ronin', 'katana', 'origami', 'samurai', 'aidbox', 'runner', 'torii', 'sakura', 'sensei', 'kaizen', 'dojo', 'shogun', 'bonsai', 'tanto', 'zen'];
function genPassword() {
  let p, guard = 0;
  do {
    const w = PW_WORDS[crypto.randomBytes(1)[0] % PW_WORDS.length];
    p = w + '-' + crypto.randomBytes(2).toString('hex');
  } while (state.gatePasswords && state.gatePasswords[p] && guard++ < 50);
  return p;
}

// --- Signed gate cookie. The real, server-enforced gate: Caddy forward_auth
// calls /api/gate/check, which only passes if the request carries a valid
// HMAC-signed cookie. The cookie is minted here (never in the client bundle),
// so it can't be forged without GATE_COOKIE_SECRET. ---
const GATE_COOKIE_SECRET = process.env.GATE_COOKIE_SECRET || '';
const GATE_COOKIE_NAME = 'rp_gate';
const GATE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
function signGate(exp) {
  return crypto.createHmac('sha256', GATE_COOKIE_SECRET).update(String(exp)).digest('base64url');
}
function makeGateToken() {
  const exp = Date.now() + GATE_TTL_MS;
  return `${exp}.${signGate(exp)}`;
}
function gateTokenValid(token) {
  if (!token || !GATE_COOKIE_SECRET) return false;
  const dot = token.indexOf('.');
  if (dot < 0) return false;
  const exp = token.slice(0, dot), sig = token.slice(dot + 1);
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  const expected = signGate(exp);
  if (sig.length !== expected.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); } catch { return false; }
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  return out;
}
function gateCookieHeader() {
  return `${GATE_COOKIE_NAME}=${makeGateToken()}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${Math.floor(GATE_TTL_MS / 1000)}`;
}
// Forum supergroup ("Portfolio viewers") — each visitor gets a Topic in here.
// Bot must be admin with "Manage Topics". Empty → fall back to Roman's DM.
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID || '-1004299399598';
// While Roman has spoken within this window, the agent stays out of the way and
// doesn't auto-reply to visitor messages (Roman is handling it). After it, the
// agent resumes auto-replies (assume Roman left).
const ROMAN_ACTIVE_WINDOW_MS = 20 * 60 * 1000;
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
  // forum topic message_thread_id → our thread id (route Roman's topic replies)
  topicMap: {},
  lastActiveThread: null,
  // thread → visitor's TG chat_id (set when visitor presses /start <thread> in the bot)
  threadFwd: {},
  // visitor's TG chat_id → thread (reverse lookup so we can route their TG msgs back)
  chatToThread: {},
  // optional username metadata supplied via /api/chat/pickup
  threadUsername: {},
  // per-user portfolio passwords: password -> { name, contact, reason, createdAt, uses, lastUsed }
  gatePasswords: {},
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
  wakeWaiters(threadId);

  // Forward Roman's replies to the visitor's TG chat if they took the
  // conversation to Telegram (visitor pressed /start <thread> in the bot).
  if (role === 'roman' && state.threadFwd[threadId]) {
    sendTelegramMessage(state.threadFwd[threadId], text).catch(() => {});
  }

  return msg;
}

async function sendTelegramMessage(chatId, text, messageThreadId) {
  const body = { chat_id: chatId, text, disable_web_page_preview: true };
  if (messageThreadId) body.message_thread_id = messageThreadId;
  const r = await fetch(TG_API('sendMessage'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

// ----- Forum topics: one Telegram Topic per visitor thread -----
async function ensureTopic(threadId, name) {
  if (!GROUP_CHAT_ID) return null;
  const t = getThread(threadId);
  if (t.topicId) return t.topicId;
  try {
    const r = await fetch(TG_API('createForumTopic'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: GROUP_CHAT_ID,
        name: String(name || ('Гость #' + threadId.slice(0, 6))).slice(0, 128),
      }),
    });
    const data = await r.json();
    if (data.ok) {
      t.topicId = data.result.message_thread_id;
      state.topicMap[t.topicId] = threadId;
      saveLater();
      return t.topicId;
    }
    console.error('createForumTopic failed:', JSON.stringify(data).slice(0, 200));
  } catch (e) {
    console.error('createForumTopic error:', e.message);
  }
  return null;
}
// Send a message into the visitor's topic (creating it if needed). Falls back
// to Roman's DM if the group/topics aren't available.
async function sendToTopic(threadId, text, nameForCreation) {
  const topicId = await ensureTopic(threadId, nameForCreation);
  if (topicId) {
    return sendTelegramMessage(GROUP_CHAT_ID, text, topicId).catch((e) => {
      console.error('sendToTopic error:', e.message);
    });
  }
  return sendTelegramMessage(ROMAN_CHAT_ID, `[#${threadId.slice(0, 8)}]\n${text}`).catch(() => {});
}

const waiters = {};
function wakeWaiters(threadId) {
  for (const fn of (waiters[threadId] || [])) fn();
  delete waiters[threadId];
}
// Threads where the agent is actively preparing a reply — surfaced in the
// poll so the visitor sees a "typing" indicator (incl. replies triggered by
// Roman, e.g. "поприветствуй гостя"). Cleared on reply OR on [silent].
const typingThreads = new Set();
function setTyping(threadId, on) {
  const had = typingThreads.has(threadId);
  if (on) typingThreads.add(threadId); else typingThreads.delete(threadId);
  if (had !== !!on) wakeWaiters(threadId);
}

// Wake the agent on Roman's turn (it decides whether to step back or reply,
// per the system prompt). Used for Roman's DM replies AND his topic replies.
function wakeClaudeForRoman(threadId) {
  setTyping(threadId, true);   // set synchronously so the next poll shows it immediately
  claudeQueue.run(() => {
    const history = (state.threads[threadId]?.msgs || []).slice(-12);
    const messages = history.map((m) => {
      if (m.role === 'roman') return { role: 'user', content: `[ROMAN — owner of this portfolio, in the chat]: ${m.text}` };
      if (m.role === 'visitor') return { role: 'user', content: m.text };
      return { role: 'assistant', content: m.text };
    });
    return callClaude(messages);
  }).then((reply) => {
    setTyping(threadId, false);
    if (!reply) return;
    let r = reply.trim();
    if (!r || /^\[silent\]$/i.test(r)) return;
    const handoffMatch = r.match(/HANDOFF:\s*(.+?)(?:\n|$)/);
    if (handoffMatch) {
      const task = handoffMatch[1].trim();
      r = r.replace(/HANDOFF:.*$/m, '').trim();
      enqueueBuild(threadId, task);
    }
    if (!r) return;
    appendMsg(threadId, 'claude', r);
    sendToTopic(threadId, `🤖 claude:\n${r}`);
  }).catch((err) => { setTyping(threadId, false); console.error('claude (roman-trigger) error:', err); });
}

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

      // ---------- Group topics: Roman replying inside a visitor's Topic ----------
      if (GROUP_CHAT_ID && fromChatId === String(GROUP_CHAT_ID)) {
        if (msg.from && msg.from.is_bot) continue;        // ignore the bot's own posts
        const topicId = msg.message_thread_id;
        const tThread = topicId && state.topicMap[topicId];
        if (!tThread) continue;                           // not a mapped visitor topic (e.g. General)
        if (text.startsWith('/')) {
          const bm = text.match(/^\/build\s+(.+)/i);
          if (bm) {
            appendMsg(tThread, 'roman', `/build ${bm[1]}`);
            runOwnerBuild(tThread, bm[1]).catch((e) => {
              appendMsg(tThread, 'claude', `// build failed: ${String(e.message || e).slice(0, 200)}`);
            });
          }
          continue;
        }
        state.lastActiveThread = tThread;
        console.log(`roman (topic ${topicId}) → thread ${tThread.slice(0, 8)}: ${text.slice(0, 80)}`);
        getThread(tThread).romanActiveTs = Date.now();
        appendMsg(tThread, 'roman', text);
        wakeClaudeForRoman(tThread);
        saveLater();
        continue;
      }

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
      getThread(threadId).romanActiveTs = Date.now();
      appendMsg(threadId, 'roman', text);
      // Roman's messages also wake the agent so it can react (or step back)
      // per the system prompt. Same path as topic replies.
      wakeClaudeForRoman(threadId);
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

  // ---------- Password gate ----------
  // Single password, no login. Verified server-side so the password never ships
  // in the client bundle. On success the frontend stores a local flag.
  if (req.method === 'POST' && url.pathname === '/api/gate/verify') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'bad json' }); }
    const pw = String(body.password || '');
    let ok = false;
    if (pw.length > 0) {
      if (pw === GATE_PASSWORD) {
        ok = true;                                  // shared / общий password
      } else if (state.gatePasswords[pw]) {
        ok = true;                                  // private / частный per-user password
        const rec = state.gatePasswords[pw];
        rec.uses = (rec.uses || 0) + 1;
        rec.lastUsed = Date.now();
        saveLater();
      }
    }
    if (ok) {
      // Mint the signed gate cookie so Caddy forward_auth will serve content.
      res.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'Set-Cookie': gateCookieHeader(),
      });
      return res.end(JSON.stringify({ ok: true }));
    }
    return send(res, 200, { ok: false });
  }
  // Gate check for Caddy forward_auth: 200 if a valid gate cookie is present,
  // 401 otherwise (Caddy then serves the gate page instead of the content).
  if (req.method === 'GET' && url.pathname === '/api/gate/check') {
    const cookies = parseCookies(req);
    if (gateTokenValid(cookies[GATE_COOKIE_NAME])) return send(res, 200, { ok: true });
    return send(res, 401, { ok: false });
  }
  // "Request password" — visitor says who they are and why; it lands in Roman's TG.
  if (req.method === 'POST' && url.pathname === '/api/gate/request') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'bad json' }); }
    const name = String(body.name || '').trim().slice(0, 200);
    const reason = String(body.reason || '').trim().slice(0, 1000);
    const contact = String(body.contact || '').trim().slice(0, 200);
    if (!name || !contact || !reason) return send(res, 400, { error: 'name, contact and reason required' });
    // Mint a private per-user password and remember who it belongs to.
    const password = genPassword();
    state.gatePasswords[password] = { name, contact, reason, createdAt: Date.now(), uses: 0, lastUsed: null };
    saveLater();
    const msg = `🔑 ЗАПРОС ПАРОЛЯ\n\nКто: ${name}\nКонтакт: ${contact}\n\nЗачем:\n${reason}\n\n🔓 Личный пароль для него:\n${password}\n\nОтправь его на контакт выше. Общий пароль тоже работает.`;
    // Each request lands in its OWN forum topic in the group; fall back to DM.
    (async () => {
      let topicId = null;
      if (GROUP_CHAT_ID) {
        try {
          const r = await fetch(TG_API('createForumTopic'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ chat_id: GROUP_CHAT_ID, name: ('🔑 Пароль · ' + name).slice(0, 128), icon_color: 0xFF93B3 }),
          });
          const data = await r.json();
          if (data.ok) topicId = data.result.message_thread_id;
          else console.error('gate createForumTopic failed:', JSON.stringify(data).slice(0, 200));
        } catch (e) { console.error('gate topic error:', e.message); }
      }
      // Remember this password's topic so the visitor's later chat lands here too.
      if (topicId && state.gatePasswords[password]) { state.gatePasswords[password].topicId = topicId; saveLater(); }
      if (topicId) await sendTelegramMessage(GROUP_CHAT_ID, msg, topicId).catch(() => {});
      else await sendTelegramMessage(ROMAN_CHAT_ID, msg).catch(() => {});
    })();
    return send(res, 200, { ok: true });
  }

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

    // If the visitor unlocked with a private password, bind their chat thread to
    // that password's topic — so the request, the password and the chat all live
    // in ONE Telegram topic instead of spawning a separate "first message" topic.
    const gatePw = String(body.pw || '');
    if (gatePw) {
      const rec = state.gatePasswords[gatePw];
      const t = getThread(thread);
      if (rec && rec.topicId && !t.topicId) {
        t.topicId = rec.topicId;
        state.topicMap[rec.topicId] = thread;
        rec.thread = thread;
        saveLater();
      }
    }

    // If Roman is actively handling this thread (spoke within the window, or
    // told the agent to stay quiet), the agent steps aside: no auto-reply AND no
    // "typing" preloader. The visitor's message still goes to Roman in the topic;
    // the agent only speaks again when summoned with the "ask the agent" button.
    const romanActive = (Date.now() - (state.threads[thread]?.romanActiveTs || 0)) < ROMAN_ACTIVE_WINDOW_MS;
    const runAgent = useClaude && !romanActive;

    // Flag "typing" BEFORE appending the visitor msg, so the poll that delivers
    // the visitor message already carries typing:true (no flicker on the dots).
    if (runAgent) setTyping(thread, true);
    const visitorMsg = appendMsg(thread, 'visitor', text);
    state.lastActiveThread = thread;

    // Forward the visitor's message into their Telegram Topic (created on the
    // first message and named after it). Roman replies inside the topic →
    // routed back to this visitor. Falls back to Roman's DM if topics are off.
    sendToTopic(thread, `💬 ${text}`, text);

    // Kick off Claude in the background so the HTTP response returns fast
    // and the visitor sees Claude's reply via long-poll a few seconds later.
    if (runAgent) {
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
        setTyping(thread, false);
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
        sendToTopic(thread, `🤖 claude:\n${r}`);
      }).catch((err) => {
        setTyping(thread, false);
        console.error('claude bg error:', err);
        appendMsg(thread, 'claude', '// internal: claude error — try again in a moment');
      });
    }

    return send(res, 200, { ok: true, msg: visitorMsg });
  }

  if (req.method === 'GET' && url.pathname === '/api/chat/poll') {
    const thread = String(url.searchParams.get('thread') || '').slice(0, 64);
    const after = parseInt(url.searchParams.get('after') || '0', 10) || 0;
    if (!thread) return send(res, 400, { error: 'thread required' });
    const t = getThread(thread);
    const fresh = t.msgs.filter((m) => m.id > after);
    if (fresh.length) return send(res, 200, { msgs: fresh, typing: typingThreads.has(thread) });
    // long-poll up to 25s
    const timer = setTimeout(() => {
      delete waiters[thread];
      send(res, 200, { msgs: [], typing: typingThreads.has(thread) });
    }, 25000);
    waiters[thread] = waiters[thread] || [];
    waiters[thread].push(() => {
      clearTimeout(timer);
      const t2 = getThread(thread);
      send(res, 200, { msgs: t2.msgs.filter((m) => m.id > after), typing: typingThreads.has(thread) });
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

  // ---------- /api/webhook/vault — GitHub push → vault pull + Astro build ----------
  // GitHub posts on every push to the obsidianVault repo. We HMAC-verify the
  // payload, ack 202 immediately so GitHub doesn't retry, then run
  // git pull + npm run build out of band. Build is ~7s, total cycle ~10s.
  if (req.method === 'POST' && url.pathname === '/api/webhook/vault') {
    const secret = process.env.VAULT_WEBHOOK_SECRET;
    if (!secret) return send(res, 500, { error: 'webhook secret not configured' });
    const sigHeader = req.headers['x-hub-signature-256'] || '';
    const eventType = req.headers['x-github-event'] || '';
    const raw = await readBody(req);
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
    let valid = false;
    try {
      valid = sigHeader.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(sigHeader), Buffer.from(expected));
    } catch (_) { valid = false; }
    if (!valid) {
      console.log(`[webhook/vault] rejected — bad signature (event=${eventType})`);
      return send(res, 401, { error: 'invalid signature' });
    }
    if (eventType === 'ping') {
      console.log('[webhook/vault] ping ok');
      return send(res, 200, { ok: true, pong: true });
    }
    if (eventType !== 'push') {
      return send(res, 200, { ok: true, ignored: eventType });
    }
    // Ack first, build async.
    send(res, 202, { ok: true, queued: true });
    rebuildVault();
    return;
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
    const thread = String(body.thread || '').slice(0, 64);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const cleanMsgs = messages
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-12)
      .map((m) => ({ role: m.role, content: String(m.content).slice(0, 4000) }));
    if (!cleanMsgs.length) {
      return send(res, 400, { error: 'no messages' });
    }
    // "Ask the agent" button: the visitor explicitly summoned the agent. If the
    // last turn is already an agent reply (e.g. it auto-answered), append a nudge
    // so there's a user turn to respond to — the button never dead-ends.
    if (cleanMsgs[cleanMsgs.length - 1].role !== 'user') {
      cleanMsgs.push({ role: 'user', content: '(The visitor tapped "ask the agent" to summon you. Answer their actual last message directly and concretely — do NOT invent a different question. If the last message is too short to be sure what they mean, give your best concrete answer AND offer one short clarifying option. Keep it tight.)' });
    }
    // With a thread: route the summoned reply into the thread + the visitor's
    // Telegram topic (so Roman sees it too), delivered to the visitor via poll —
    // just like an auto-reply. Respond fast; the reply arrives over the long-poll.
    if (thread) {
      setTyping(thread, true);
      claudeQueue.run(() => callClaude(cleanMsgs)).then((reply) => {
        setTyping(thread, false);
        let r = (reply || '').trim();
        if (/^\[silent\]$/i.test(r)) return;
        const hm = r.match(/HANDOFF:\s*(.+?)(?:\n|$)/);
        if (hm) { const task = hm[1].trim(); r = r.replace(/HANDOFF:.*$/m, '').trim(); enqueueBuild(thread, task); }
        if (!r) return;
        appendMsg(thread, 'claude', r);
        sendToTopic(thread, `🤖 claude (по кнопке):\n${r}`);
      }).catch((err) => { setTyping(thread, false); console.error('claude (summon) error:', err); });
      return send(res, 200, { ok: true, viaPoll: true });
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
    // Three sources, by purpose:
    //   /portfolio/rag       → raw experience dumps Roman keeps adding
    //                          (notes, stories, context). NOT published.
    //                          PRIMARY source for grounding answers.
    //   /portfolio/articles  → published markdown articles on the site.
    //   /portfolio/cases     → published .mdx case pages with frontmatter.
    // cap: truncate each file's body to keep the prompt small enough to stay
    // fast (rag stays full — it's the grounding source; published pages are
    // capped since their full text lives on the site and the agent only links).
    { dir: '/root/vault/portfolio/rag', label: 'RAW EXPERIENCE — Roman\'s knowledge dump (primary grounding source)', cap: 0 },
    { dir: '/root/vault/portfolio/articles', label: 'PUBLISHED ARTICLES (summaries — full text on the page)', cap: 1200 },
    { dir: '/root/vault/portfolio/cases', label: 'PUBLISHED CASE PAGES (summaries — full text on the page)', cap: 1400 },
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
        let trimmed = body.trim();
        if (r.cap && trimmed.length > r.cap) {
          trimmed = trimmed.slice(0, r.cap).trimEnd() + '\n…[truncated — full text lives on the page]';
        }
        blocks.push(`\n--- ${rel} ---\n${trimmed}`);
      } catch (_) {}
    }
  }
  vaultCacheText = blocks.join('\n');
  vaultCacheTs = now;
  return vaultCacheText;
}

// ============ BM25 retrieval over vault chunks ============
// Instead of dumping the whole vault (~300KB) into every prompt, we chunk the
// files once and, per query, retrieve only the most relevant excerpts (~14KB).
const VAULT_DIRS = [
  '/root/vault/portfolio/rag',
  '/root/vault/portfolio/articles',
  '/root/vault/portfolio/cases',
];
function walkVault(dir) {
  let out = [];
  try {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) out = out.concat(walkVault(p));
      else if (/\.(md|mdx)$/i.test(ent.name) && ent.name !== 'CLAUDE.md') out.push(p);
    }
  } catch (_) {}
  return out;
}
const STOPWORDS = new Set(
  ('the a an and or of to in on for with is are was were be been by at as it its this that these those ' +
   'и в во не на с со что а то как он она они мы вы ты я его её их это эта этот так вот же бы ли уже или ' +
   'для по от из про у о об над под при за до без есть был была быть да нет ну вообще там тут чтобы')
  .split(/\s+/),
);
function tokenize(s) {
  const out = [];
  const re = /[\p{L}\p{N}][\p{L}\p{N}_-]*/gu;
  let m;
  const lower = String(s).toLowerCase();
  while ((m = re.exec(lower))) {
    const t = m[0];
    if (t.length < 2 || STOPWORDS.has(t)) continue;
    out.push(t);
  }
  return out;
}
function splitSections(body) {
  const lines = body.split('\n');
  const sections = [];
  let cur = { heading: '', text: '' };
  for (const line of lines) {
    const h = line.match(/^#{1,4}\s+(.+)/);
    if (h) {
      if (cur.text.trim()) sections.push(cur);
      cur = { heading: h[1].trim().replace(/[#*`]/g, ''), text: '' };
    } else {
      cur.text += line + '\n';
    }
  }
  if (cur.text.trim()) sections.push(cur);
  return sections.length ? sections : [{ heading: '', text: body }];
}
function packParagraphs(text, maxChars) {
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const out = [];
  let buf = '';
  for (const p of paras) {
    if (buf && (buf.length + p.length + 2) > maxChars) { out.push(buf); buf = ''; }
    buf = buf ? buf + '\n\n' + p : p;
    while (buf.length > maxChars) { out.push(buf.slice(0, maxChars)); buf = buf.slice(maxChars); }
  }
  if (buf.trim()) out.push(buf);
  return out.length ? out : [text];
}
let chunkIndex = null;
let chunkIndexTs = 0;
function buildChunkIndex() {
  const now = Date.now();
  if (chunkIndex && now - chunkIndexTs < 300_000) return chunkIndex;
  const chunks = [];
  for (const dir of VAULT_DIRS) {
    for (const f of walkVault(dir).sort()) {
      let body;
      try { body = fs.readFileSync(f, 'utf-8'); } catch (_) { continue; }
      body = body.replace(/^---\n[\s\S]*?\n---\n/, '');
      const rel = f.replace('/root/vault/', '');
      for (const sec of splitSections(body)) {
        for (const piece of packParagraphs(sec.text.trim(), 1100)) {
          const text = piece.trim();
          if (text.length < 40) continue;
          const header = `[${rel}${sec.heading ? ' › ' + sec.heading : ''}]`;
          chunks.push({ file: rel, heading: sec.heading || '', text, header });
        }
      }
    }
  }
  const df = new Map();
  let totalLen = 0;
  for (const c of chunks) {
    c.tokens = tokenize(`${c.text} ${c.heading} ${c.file.replace(/[\/_.-]/g, ' ')}`);
    c.len = c.tokens.length || 1;
    c.tf = new Map();
    for (const t of c.tokens) c.tf.set(t, (c.tf.get(t) || 0) + 1);
    for (const t of new Set(c.tokens)) df.set(t, (df.get(t) || 0) + 1);
    totalLen += c.len;
  }
  chunkIndex = { chunks, df, N: chunks.length, avgdl: chunks.length ? totalLen / chunks.length : 1 };
  chunkIndexTs = now;
  console.log(`[rag] chunk index built: ${chunks.length} chunks from ${VAULT_DIRS.length} dirs`);
  return chunkIndex;
}
function bm25Search(query, { topK = 14, budget = 18000, k1 = 1.5, b = 0.75 } = {}) {
  const idx = buildChunkIndex();
  if (!idx.N) return [];
  const qTerms = [...new Set(tokenize(query))];
  if (!qTerms.length) return [];
  const scored = [];
  for (const c of idx.chunks) {
    let s = 0;
    for (const t of qTerms) {
      const tf = c.tf.get(t);
      if (!tf) continue;
      const dfp = idx.df.get(t) || 0.5;
      const idf = Math.log(1 + (idx.N - dfp + 0.5) / (dfp + 0.5));
      s += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * c.len / idx.avgdl));
    }
    if (s > 0) scored.push({ c, s });
  }
  scored.sort((x, y) => y.s - x.s);
  const picked = [];
  let used = 0;
  for (const { c } of scored) {
    if (picked.length >= topK) break;
    const block = `${c.header}\n${c.text}`;
    if (picked.length && used + block.length > budget) break;
    picked.push(block);
    used += block.length;
  }
  return picked;
}

const CLAUDE_STATIC_PROMPT = `You are Claude, answering questions about ROMAN POGOROV on his portfolio site (clauderunner.com/rpogorov-dev/). You are NOT Roman — you speak ABOUT him.

WHO YOU ARE — IMPORTANT: You are the assistant built INTO Roman's portfolio — his right hand on this site, helping each visitor on his behalf. You are NOT a generic chatbot that happens to be on a page, and you must never break character into "I'm just an LLM, I don't have a job / dream job / feelings". When a visitor asks about YOU ("кто ты", "у тебя есть работа?", "what do you do", "тебе нравится тут?"), answer AS Roman's portfolio assistant: your job here is to help people get to know Roman and his work, you know his experience and projects deeply, and — key — Roman himself will gladly answer personally (he jumps into the chat from Telegram when he's online). So the vibe is: "Роман с удовольствием вам ответит лично, а я пока могу рассказать всё, что для него важно — я хорошо знаю его опыт и работы". Warm, on-brand, a teammate — then steer gently back to what they'd like to know about Roman. Stay in this role for the WHOLE conversation.

PRIMARY DESCRIPTION (use this as the default answer for "who is Roman?", "расскажи про Романа", intros, and any open-ended question about him; reply in Russian if the user wrote Russian):

Роман — Senior Product Designer с 15 годами в дизайне, но интереснее другое: он давно перешёл черту между «дизайнером» и «человеком, который сам пишет код».

Судя по его работам, это человек, которому скучно останавливаться на макете. Столкнулся с непонятной бизнес-логикой — написал симулятор. Нужны инсайты из Facebook-группы — парсер на 80 000 сообщений с сентимент-анализом. Нет нормального инструмента для синхронизации Figma и кода — написал скилл для Claude сам, до того как это появилось где-то ещё.

При этом он не теряет дизайнерскую голову: NPS с 45 до 78, +175% принятых офферов — это не случайности, а результат исследований, интервью, итераций.

Ещё одна черта — он доказывает подходы делом. Приложение для конференции FireCamp (600+ участников) собрал за неделю вайбкодингом — и именно это убедило руководство Health Samurai, что подход работает. Про это можно почитать в его [статье о голографическом портфолио-агенте](/article/holographic-portfolio-agent), который ты сейчас и видишь.

— END PRIMARY DESCRIPTION —

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
- ANSWER DIRECTLY. Don't ask the visitor to clarify or say the question is ambiguous — pick the most reasonable interpretation and answer it substantively. The quick-suggestion chips ("How do you work with AI?", "Tell me about Health Samurai", "shadCN design system", "Figma ↔ code", "Open for work?") are clear prompts — answer each right away with concrete detail from Roman's work, no preamble.
- Reply in the SAME LANGUAGE the user wrote in (Russian or English; pick automatically).
- When pointing to a specific case or article, embed the URL as a markdown link [label](/path). The frontend turns those into clickable buttons. The [label] MUST be a short human phrase — the case/article NAME (e.g. [Дизайн-система Health Samurai](/case/cs06/hs-design-system)). NEVER use the raw URL/path as the label.
- LINKS — STRICT: only link to paths that appear verbatim in the PUBLISHED ROUTES block below. Never invent, guess, transform, or pluralize a URL (e.g. /article/ vs /articles/, slug variants). If the relevant work has no published route, mention it in plain prose without a link.
- Never fabricate metrics, dates, projects, or quotes that aren't listed above. If a question is outside Roman's listed work, say so briefly and offer the closest relevant case.
- Don't roleplay as Roman. You're Claude answering ABOUT him.
- DON'T BE PUSHY OR SALESY. Surface cases / links / "directions to dig into" ONLY when the visitor actually asks about the work or clearly shows interest — never on a greeting or a compliment. The rest of the time just hold a natural, human conversation around whatever they said. When work does come up, you can lightly note that you'll pull up ANY written case on request — and that some of Roman's projects aren't written up as case pages, but you know them well and can describe them in words. Offer that gently when it fits; don't force it.

SMALL TALK — when the visitor just greets, compliments the site, or makes off-topic chit-chat ("привет", "клёвый сайт", "круто", "thanks"): reply warmly and naturally, like a person, and keep the vibe going around what they said. Do NOT dump a menu of cases or ask "что ближе?" / "what interests you" when nobody asked. At most one light, no-pressure hint that you're around to dig into Roman's work if they're curious — then stop.

THREE-SPEAKER ROOM
The thread has three voices: the visitor (the website user), Roman (the owner — joins from his Telegram bot, his messages are tagged [ROMAN — owner of this portfolio, in the chat]), and you. You receive a turn whenever ANYONE writes — visitor or Roman.

When the latest turn is from Roman, the OWNER has joined the room. Your DEFAULT is to STEP BACK and let him take the conversation — don't keep answering over him.

DEFAULT (Roman just appeared / is talking and none of the exceptions below apply): hand the floor to him with ONE short line, then get out of the way. Examples (match the thread's language):
   - Russian: "Вижу, Роман подключился — передаю слово ему. Если что, зовите меня кнопкой «спросить агента» снизу."
   - English: "Roman's here — I'll let him take it. Ping me with the 'ask the agent' button below if you need me."
   If you ALREADY handed off earlier in this thread and Roman is still talking, output literally [silent] and nothing else — don't interject again.

EXCEPTIONS (these override the step-back default):
A. **CASE BUILD REQUEST** — when Roman asks you to build / assemble / put together / собрать / сделать a case (e.g. "клод, собери кейс про X", "build me a case on Y", "сделай кейс про маркетинг") — DO NOT discuss permissions, capabilities, access rights, or limitations. DO NOT say "у меня нет доступа" or "I'd need…". Just confirm and hand off:
   - In Russian: "Понял. Занимаюсь — это займёт 3-5 минут, передал основному агенту."
   - In English: "Got it. On it — 3–5 minutes, the main agent will assemble it."
   Then on a NEW LINE, emit a structured handoff marker the server will scrape:
   HANDOFF: <one short clean line restating what Roman wants assembled>
   The server will queue the request for the main agent (Roman's terminal Claude) and ping Roman to come refine it. Don't attempt to write any files yourself.

B. If Roman is addressing YOU directly with a NON-build question (names you — "клод, расскажи про X", "агент, что там по дизайн-системе") — answer it normally about Roman's work, then step back.

C. If Roman is giving a heads-up ("секунду", "минуту", "ща приду") or chatting WITH the visitor ("привет всем", explaining something to them directly) — output literally [silent] and nothing else. Server suppresses the turn.

When the latest turn is from the VISITOR, respond normally about Roman's work.

Never emit [silent] when the visitor asked something — they're waiting on you.`;

// Whitelist of URLs that actually exist on the live site. Built from the
// compiled portfolio output so the visitor-side Claude can't link to a
// path that 404s. Cached for 60s alongside the vault context.
let routesCacheText = '';
let routesCacheTs = 0;
function loadPublishedRoutes() {
  const now = Date.now();
  if (now - routesCacheTs < 60_000 && routesCacheText) return routesCacheText;
  const routes = new Set();
  // Hash-based company overlays handled by the client router on /
  routes.add('/case/cs01');
  routes.add('/case/cs02');
  routes.add('/case/cs03');
  routes.add('/case/cs04');
  routes.add('/case/cs05');
  // Filesystem-built article routes — only present if Astro emitted them
  try {
    for (const slug of fs.readdirSync('/root/rpogorov-dev/app/article')) {
      const p = path.join('/root/rpogorov-dev/app/article', slug);
      try {
        if (fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'index.html'))) {
          routes.add(`/article/${slug}`);
        }
      } catch (_) {}
    }
  } catch (_) {}
  // Filesystem-built case detail routes
  try {
    for (const company of fs.readdirSync('/root/rpogorov-dev/app/case')) {
      const cp = path.join('/root/rpogorov-dev/app/case', company);
      try {
        if (!fs.statSync(cp).isDirectory()) continue;
      } catch (_) { continue; }
      try {
        for (const slug of fs.readdirSync(cp)) {
          const sp = path.join(cp, slug);
          try {
            if (fs.statSync(sp).isDirectory() && fs.existsSync(path.join(sp, 'index.html'))) {
              routes.add(`/case/${company}/${slug}`);
            }
          } catch (_) {}
        }
      } catch (_) {}
    }
  } catch (_) {}
  routesCacheText = Array.from(routes).sort().map((r) => `  ${r}`).join('\n');
  routesCacheTs = now;
  return routesCacheText;
}

function buildClaudeSystemPrompt(query) {
  const routes = loadPublishedRoutes();
  const routesBlock = '\n\n=========================================\n' +
    'PUBLISHED ROUTES — these are the ONLY URLs that exist on the site.\n' +
    'You MAY embed links ONLY to paths from this list. Never invent, guess,\n' +
    'pluralize, or otherwise transform a path. If the work you want to\n' +
    'reference has no route here, name it in plain prose without a link.\n' +
    '=========================================\n' + routes;
  const base = CLAUDE_STATIC_PROMPT + routesBlock;
  // Retrieve only the most relevant vault excerpts for THIS question (BM25)
  // instead of dumping the whole vault into every prompt.
  const picked = query ? bm25Search(query) : [];
  if (!picked.length) return base;
  return base + '\n\n=========================================\n' +
    'RETRIEVED CONTEXT — the most relevant excerpts from Roman\'s vault for THIS\n' +
    'question (cases, articles, raw experience). Each block is tagged with its\n' +
    'source file. Ground your answer in these and quote the source when it helps.\n' +
    'Don\'t fabricate beyond them; if they don\'t cover the question, say so briefly.\n' +
    '=========================================\n' +
    picked.join('\n\n---\n\n');
}

// ---------- Vault rebuild ----------
// Pulls /root/vault and rebuilds /root/rpogorov-dev/site. Serialized so a
// burst of pushes only triggers one in-flight build at a time, with at
// most one queued follow-up that absorbs all pushes received during the
// previous build.
let rebuildInFlight = false;
let rebuildPending = false;
function rebuildVault() {
  if (rebuildInFlight) {
    rebuildPending = true;
    console.log('[webhook/vault] build in flight — queuing follow-up');
    return;
  }
  rebuildInFlight = true;
  rebuildPending = false;
  const startTs = Date.now();
  console.log('[webhook/vault] starting git pull + astro build');
  const sh = spawn('bash', ['-lc',
    'cd /root/vault && git pull --rebase --autostash 2>&1 && ' +
    'cd /root/rpogorov-dev/site && npm run build 2>&1'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  sh.stdout.on('data', (d) => out += d);
  sh.stderr.on('data', (d) => out += d);
  sh.on('close', (code) => {
    const dur = ((Date.now() - startTs) / 1000).toFixed(1);
    if (code === 0) {
      console.log(`[webhook/vault] build ok in ${dur}s`);
    } else {
      console.error(`[webhook/vault] build failed (exit ${code}, ${dur}s):\n${out.slice(-2000)}`);
      // Notify Roman on failure so he doesn't think the deploy went through.
      try {
        const msg = `🚨 vault rebuild failed (exit ${code}, ${dur}s)\n\`\`\`\n${out.slice(-1500)}\n\`\`\``;
        const tgUrl = `https://api.telegram.org/bot${process.env.TG_BOT_TOKEN}/sendMessage`;
        fetch(tgUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: process.env.ROMAN_CHAT_ID,
            text: msg,
            parse_mode: 'Markdown',
          }),
        }).catch(() => {});
      } catch (_) {}
    }
    rebuildInFlight = false;
    if (rebuildPending) {
      rebuildPending = false;
      console.log('[webhook/vault] running queued follow-up build');
      rebuildVault();
    }
  });
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
    // Build the retrieval query from the last couple of user turns.
    const query = messages.filter((m) => m.role === 'user').slice(-2).map((m) => m.content).join('\n');
    const promptFile = `/tmp/portfolio-claude-prompt-${process.pid}-${Date.now()}.txt`;
    try { fs.writeFileSync(promptFile, buildClaudeSystemPrompt(query)); } catch (e) {
      return reject(new Error('failed to write prompt file: ' + e.message));
    }
    const child = spawn('/root/bin/claude-headless', [
      '--print',
      '--model', 'claude-opus-4-8',
      '--append-system-prompt-file', promptFile,
      prompt,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let out = '', err = '';
    const killer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch (_) {}
    }, 75_000);
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
