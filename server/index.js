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
let state = { lastUpdateId: 0, threads: {}, sentMap: {} };
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

function appendMsg(threadId, role, text) {
  const t = getThread(threadId);
  const msg = { id: t.nextId++, role, text, ts: Date.now() };
  t.msgs.push(msg);
  if (t.msgs.length > 200) t.msgs.splice(0, t.msgs.length - 200);
  saveLater();
  // wake long-polls
  for (const fn of (waiters[threadId] || [])) fn(msg);
  delete waiters[threadId];
  return msg;
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
      if (!msg || String(msg.chat.id) !== ROMAN_CHAT_ID) continue;
      const replyId = msg.reply_to_message?.message_id;
      const threadId = replyId ? state.sentMap[replyId] : null;
      if (!threadId) continue;
      const text = msg.text || msg.caption || '[media]';
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

    // Save visitor message
    const visitorMsg = appendMsg(thread, 'visitor', text);

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

  if (req.method === 'GET' && url.pathname === '/api/chat/health') {
    return send(res, 200, { ok: true, threads: Object.keys(state.threads).length });
  }

  send(res, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`portfolio-chat listening on http://127.0.0.1:${PORT}`);
});
