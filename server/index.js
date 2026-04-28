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
            sendTelegramMessage(msg.chat.id,
              "✓ Connected. You're now picked up by Roman's bot — every reply he sends will arrive here. You can answer either in this chat or in your browser tab; both stay in sync.").catch(() => {});
            // Also tell Roman someone picked up
            const username = state.threadUsername[payload] ? ` @${state.threadUsername[payload]}` : '';
            sendTelegramMessage(ROMAN_CHAT_ID,
              `🔗 Visitor${username} took thread #${payload.slice(0,8)} to Telegram (chat ${msg.chat.id}). Future replies in this bot to that thread will also DM them.`).catch(() => {});
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
    if (!thread || !text) return send(res, 400, { error: 'thread and text required' });

    // Save visitor message + mark this thread as the active one
    const visitorMsg = appendMsg(thread, 'visitor', text);
    state.lastActiveThread = thread;

    // Send to Telegram, tagged with thread for human readability
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
    const username = String(body.username || '').slice(0, 32);
    if (!thread) return send(res, 400, { error: 'thread required' });
    state.threadUsername[thread] = username;
    saveLater();
    return send(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/chat/health') {
    return send(res, 200, { ok: true, threads: Object.keys(state.threads).length });
  }

  send(res, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`portfolio-chat listening on http://127.0.0.1:${PORT}`);
});
