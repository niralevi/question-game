'use strict';
/*
 * שרת המשחק. השרת הוא מקור האמת: הוא מחלק תפקידים, מנהל טיימרים ומחשב ניקוד.
 * כל שחקן מקבל רק את מה שמותר לו לראות (בלי לחשוף מי האימפוסטר).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Room } = require('./lib/game');
const R = require('./lib/roles');

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  let url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/' || !path.extname(url)) url = '/index.html';
  const file = path.normalize(path.join(PUB, url));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('לא נמצא'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 32 * 1024 });
const rooms = new Map(); // code -> Room
const CATALOG = JSON.stringify({ t: 'catalog', c: R.catalog() });

function newCode() {
  for (let i = 0; i < 200; i++) {
    const c = String(1000 + Math.floor(Math.random() * 9000));
    if (!rooms.has(c)) return c;
  }
  return null;
}
const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
const cleanName = n => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 16);
const cleanToken = t => (typeof t === 'string' && /^[a-z0-9]{8,40}$/i.test(t) ? t : null);

wss.on('connection', ws => {
  ws.alive = true; ws.room = null; ws.pid = null; ws.hits = 0;
  ws.on('pong', () => { ws.alive = true; });
  ws.send(CATALOG);

  ws.on('message', raw => {
    if (++ws.hits > 60) return; // הגבלת קצב פשוטה (מתאפס כל שנייה)
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    const room = ws.room, p = room && room.players.get(ws.pid);

    if (m.t === 'create' || m.t === 'join') {
      if (p) return;
      const name = cleanName(m.name), token = cleanToken(m.token);
      const avatar = R.AVATARS.includes(m.avatar) ? m.avatar : R.AVATARS[0];
      if (!token) return send(ws, { t: 'denied', why: 'bad' });
      let rm;
      if (m.t === 'create') {
        if (!name) return send(ws, { t: 'denied', why: 'name' });
        const code = newCode();
        if (!code) return send(ws, { t: 'denied', why: 'full' });
        rm = new Room(code, r => rooms.delete(r.code));
        rooms.set(code, rm);
      } else {
        rm = rooms.get(String(m.code || ''));
        if (!rm) return send(ws, { t: 'denied', why: 'noroom' });
        if (rm.banned.has(token)) return send(ws, { t: 'denied', why: 'banned' });
        const old = [...rm.players.values()].find(q => q.token === token);
        if (old) { // חזרה אחרי ניתוק / רענון
          ws.room = rm; ws.pid = old.id;
          send(ws, { t: 'joined', code: rm.code, you: old.id });
          return rm.reattach(old, ws);
        }
        if (!name) return send(ws, { t: 'denied', why: 'name' });
        if (rm.players.size >= 30) return send(ws, { t: 'denied', why: 'full' });
      }
      const np = rm.addPlayer(ws, name, avatar, token);
      ws.room = rm; ws.pid = np.id;
      return send(ws, { t: 'joined', code: rm.code, you: np.id });
    }

    if (!p) return;
    switch (m.t) {
      case 'leave': ws.room = null; ws.pid = null; return room.removePlayer(p.id, 'leave');
      case 'profile': return room.profile(p, m.name, m.avatar);
      case 'cfg': return p.id === room.hostId && room.setCfg(m.cfg);
      case 'host': return room.hostAction(p, m);
      case 'answer': return room.answer(p, m.text);
      case 'vote': return room.vote(p, m.target);
      case 'bet': return room.bet(p, m.v);
      case 'protect': return room.protect(p, m.target);
      case 'ready': return room.ready(p);
      case 'react': return room.react(p, m.e);
    }
  });

  ws.on('close', () => {
    const room = ws.room, p = room && room.players.get(ws.pid);
    if (p && p.ws === ws) room.disconnect(p);
  });
});

// זיהוי חיבורים מתים + איפוס מונה ההודעות
setInterval(() => wss.clients.forEach(ws => { ws.hits = 0; }), 1000);
setInterval(() => wss.clients.forEach(ws => {
  if (!ws.alive) return ws.terminate();
  ws.alive = false; try { ws.ping(); } catch (e) {}
}), 25000);

server.listen(PORT, () => console.log('המשחק רץ על פורט ' + PORT));
