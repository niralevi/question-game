'use strict';
const crypto = require('crypto');
const QUESTIONS = require('./questions');
const R = require('./roles');

const PHASES = ['answer', 'discuss', 'vote', 'reveal'];
const GRACE_LOBBY = 30e3;   // כמה זמן שחקן מנותק נשאר בלובי
const GRACE_GAME = 120e3;   // כמה זמן שחקן מנותק נשאר במשחק
const HOST_GRACE = 10e3;    // אחרי כמה זמן מארח מנותק מעביר את הניהול
const MIN_PLAYERS = 3;

const newId = () => crypto.randomBytes(6).toString('hex');

class Room {
  constructor(code, onEmpty) {
    this.code = code;
    this.onEmpty = onEmpty;
    this.players = new Map();   // id -> player
    this.hostId = null;
    this.cfg = R.defaultCfg();
    this.round = null;          // הסבב הנוכחי (null בלובי)
    this.game = null;           // { total, n, stats }
    this.timer = null;
    this.deck = [];
    this.banned = new Set();
    this.events = [];           // אירועים קצרים להצגה כהודעה (טוסט)
    this.syncQueued = false;
    this.hostTimer = null;
  }

  uniqueName(name, exceptId) {
    const taken = new Set([...this.players.values()].filter(p => p.id !== exceptId).map(p => p.name));
    if (!taken.has(name)) return name;
    for (let i = 2; i < 99; i++) { const n = (name.slice(0, 13) + ' ' + i); if (!taken.has(n)) return n; }
    return name;
  }

  profile(p, name, avatar) {
    if (this.round && this.round.active.includes(p.id)) return;
    const n = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 16);
    if (n) p.name = this.uniqueName(n, p.id);
    if (R.AVATARS.includes(avatar)) p.avatar = avatar;
    this.sync();
  }

  /* ---------- שחקנים ---------- */
  addPlayer(ws, name, avatar, token) {
    const id = newId();
    name = this.uniqueName(name);
    const p = {
      id, token, ws, name, avatar, online: true, score: 0, joinedAt: Date.now(),
      spectator: !!this.round, dropTimer: null, lastReact: 0
    };
    this.players.set(id, p);
    if (!this.hostId) this.hostId = id;
    this.event('join', `${name} הצטרף/ה`, id);
    this.sync();
    return p;
  }

  reattach(p, ws) {
    if (p.ws && p.ws !== ws) { try { p.ws.close(4000, 'replaced'); } catch (e) {} }
    p.ws = ws; p.online = true;
    clearTimeout(p.dropTimer); p.dropTimer = null;
    this.event('back', `${p.name} חזר/ה`, p.id);
    this.sync();
    this.checkAuto();
  }

  disconnect(p) {
    p.ws = null; p.online = false;
    clearTimeout(p.dropTimer);
    p.dropTimer = setTimeout(() => this.removePlayer(p.id, 'timeout'), this.round ? GRACE_GAME : GRACE_LOBBY);
    if (p.id === this.hostId) {
      clearTimeout(this.hostTimer);
      this.hostTimer = setTimeout(() => {
        const h = this.players.get(this.hostId);
        if (h && !h.online) this.pickNewHost();
      }, HOST_GRACE);
    }
    this.event('off', `${p.name} התנתק/ה`, p.id);
    this.sync();
    this.checkAuto();
  }

  pickNewHost() {
    const next = [...this.players.values()].find(p => p.online && p.id !== this.hostId);
    if (next) { this.hostId = next.id; this.event('host', `${next.name} הוא/היא המארח/ת עכשיו`, next.id); this.sync(); }
  }

  removePlayer(id, why) {
    const p = this.players.get(id);
    if (!p) return;
    clearTimeout(p.dropTimer);
    this.players.delete(id);
    if (why === 'kick') { this.banned.add(p.token); this.send(p, { t: 'kicked' }); p.ws && (p.ws.room = null); }
    this.event('leave', why === 'kick' ? `${p.name} הוצא/ה מהמשחק` : `${p.name} יצא/ה`, id);
    if (this.players.size === 0) return this.destroy();
    if (this.hostId === id) {
      const next = [...this.players.values()].find(q => q.online) || this.players.values().next().value;
      this.hostId = next.id;
      this.event('host', `${next.name} הוא/היא המארח/ת עכשיו`, next.id);
    }
    if (this.round) this.dropFromRound(id);
    this.sync();
  }

  dropFromRound(id) {
    const r = this.round;
    if (!r.active.includes(id)) return;
    r.active = r.active.filter(x => x !== id);
    delete r.answers[id]; delete r.votes[id]; delete r.bets[id]; delete r.protects[id]; r.ready.delete(id);
    for (const v in r.votes) if (r.votes[v] === id) delete r.votes[v]; // מי שהצביע לו מצביע מחדש
    for (const v in r.protects) if (r.protects[v] === id) delete r.protects[v];
    if (r.info.client === id) r.info.client = null;
    if (r.info.watch) r.info.watch = r.info.watch.filter(x => x !== id);
    if (r.info.pair && r.info.pair.includes(id)) r.info.pair = r.info.pair.filter(x => x !== id);
    const wasImp = r.imps.includes(id);
    r.imps = r.imps.filter(x => x !== id);
    if (r.info.target === id) r.info.target = null;
    if (r.info.check && r.info.check.who === id) r.info.check = null;
    if (r.info.twins && r.info.twins.includes(id)) r.info.twins = r.info.twins.filter(x => x !== id);
    if (r.phase === 'reveal') return;
    if (r.active.length < MIN_PLAYERS) { this.event('info', 'נשארו פחות מ-3 שחקנים, חוזרים ללובי'); return this.toLobby(); }
    if (wasImp && !r.imps.length && r.kind !== 'none') { this.event('info', 'האימפוסטר יצא, מחלקים את הסבב מחדש'); return this.startRound(true); }
    if (r.kind === 'some' && r.imps.length === 1) r.kind = 'one';
    this.checkAuto();
  }

  online() { return [...this.players.values()].filter(p => p.online); }

  /* ---------- הגדרות ---------- */
  setCfg(raw) {
    if (this.round) return;
    this.cfg = R.sanitizeCfg(raw, this.cfg);
    this.sync();
  }

  /* ---------- סבבים ---------- */
  drawPair() {
    if (!this.deck.length) {
      this.deck = R.shuffle(QUESTIONS.map((_, i) => i));
      // לא לחזור מיד על שאלות מהחפיסה הקודמת
      if (this.lastQ != null && this.deck[this.deck.length - 1] === this.lastQ) this.deck.unshift(this.deck.pop());
    }
    const i = this.deck.pop(); this.lastQ = i;
    const q = QUESTIONS[i];
    return Math.random() < 0.5 ? [q[0], q[1]] : [q[1], q[0]];
  }

  startGame() {
    const ok = this.online();
    if (ok.length < MIN_PLAYERS) return this.event('info', 'צריך לפחות 3 שחקנים מחוברים');
    this.players.forEach(p => { p.score = 0; });
    this.game = { total: this.cfg.rounds, n: 0, stats: {}, history: [] };
    this.startRound(false);
  }

  startRound(redeal) {
    const act = this.online();
    if (act.length < MIN_PLAYERS) { this.event('info', 'אין מספיק שחקנים מחוברים'); return this.toLobby(); }
    if (!redeal) this.game.n++;
    act.forEach(p => { p.spectator = false; });
    [...this.players.values()].filter(p => !p.online).forEach(p => { p.spectator = true; });
    const ids = act.map(p => p.id);
    const a = R.assignRoles(ids, this.cfg);
    const [qa, qb] = this.drawPair();
    this.round = {
      rid: newId(), n: this.game.n, kind: a.kind, imps: a.imps, roles: a.roles, info: a.info,
      a: qa, b: qb, active: ids, answers: {}, votes: {}, bets: {}, protects: {}, ready: new Set(),
      phase: null, endsAt: 0, paused: false, remaining: 0, result: null
    };
    this.setPhase('answer');
  }

  duration(ph) {
    const c = this.cfg;
    if (ph === 'answer') return c.ansT;
    if (ph === 'discuss') return c.disT;
    if (ph === 'vote') return c.votT;
    if (ph === 'reveal') return this.isLast() ? 0 : c.revT;
    return 0;
  }
  isLast() { return this.game && this.round && this.round.n >= this.game.total; }

  setPhase(ph) {
    const r = this.round;
    if (!r) return;
    clearTimeout(this.timer);
    r.phase = ph; r.paused = false;
    if (ph === 'reveal') this.score();
    const d = this.duration(ph) * 1000;
    r.endsAt = d ? Date.now() + d : 0;
    if (d) this.timer = setTimeout(() => this.onTimer(), d);
    this.sync();
  }

  onTimer() {
    const r = this.round;
    if (!r || r.paused) return;
    if (r.phase === 'reveal') return this.isLast() ? null : this.startRound(false);
    this.setPhase(PHASES[PHASES.indexOf(r.phase) + 1]);
  }

  /** מעבר אוטומטי כשכל המחוברים סיימו */
  checkAuto() {
    const r = this.round;
    if (!r || r.paused) return;
    const live = r.active.filter(id => { const p = this.players.get(id); return p && p.online; });
    if (!live.length) return;
    if (r.phase === 'answer' && live.every(id => r.answers[id] !== undefined)) this.setPhase('discuss');
    else if (r.phase === 'discuss' && live.every(id => r.ready.has(id))) this.setPhase('vote');
    else if (r.phase === 'vote' && live.every(id => r.votes[id] !== undefined && (r.roles[id] !== 'gambler' || r.bets[id]) && (r.roles[id] !== 'guardian' || r.protects[id]))) this.setPhase('reveal');
  }

  toLobby() {
    clearTimeout(this.timer);
    this.round = null; this.game = null;
    this.players.forEach(p => { p.spectator = false; });
    this.sync();
  }

  /* ---------- פעולות שחקנים ---------- */
  answer(p, text) {
    const r = this.round;
    if (!r || r.phase !== 'answer' || !r.active.includes(p.id) || r.answers[p.id] !== undefined) return;
    const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!t) return;
    r.answers[p.id] = t;
    this.sync(); this.checkAuto();
  }

  voteOptions() {
    const c = this.cfg;
    return { none: c.randomImps && c.impDist.zero > 0, all: c.randomImps && c.impDist.all > 0 };
  }

  vote(p, target) {
    const r = this.round;
    if (!r || r.phase !== 'vote' || !r.active.includes(p.id)) return;
    const o = this.voteOptions();
    const ok = (r.active.includes(target) && target !== p.id) || (target === 'none' && o.none) || (target === 'all' && o.all);
    if (!ok) return;
    r.votes[p.id] = target;
    this.sync(); this.checkAuto();
  }

  bet(p, v) {
    const r = this.round;
    if (!r || r.phase !== 'vote' || r.roles[p.id] !== 'gambler' || !['right', 'wrong'].includes(v)) return;
    r.bets[p.id] = v;
    this.sync(); this.checkAuto();
  }

  protect(p, target) {
    const r = this.round;
    if (!r || r.phase !== 'vote' || r.roles[p.id] !== 'guardian' || !r.active.includes(target)) return;
    if (target === p.id && !this.cfg.roles.guardian.toggles.self) return;
    r.protects[p.id] = target;
    this.sync(); this.checkAuto();
  }

  ready(p) {
    const r = this.round;
    if (!r || r.phase !== 'discuss' || !r.active.includes(p.id)) return;
    if (r.ready.has(p.id)) r.ready.delete(p.id); else r.ready.add(p.id);
    this.sync(); this.checkAuto();
  }

  react(p, e) {
    if (!R.REACTIONS.includes(e) || Date.now() - p.lastReact < 600) return;
    p.lastReact = Date.now();
    this.broadcast({ t: 'react', from: p.id, e });
  }

  hostAction(p, m) {
    if (p.id !== this.hostId) return;
    const r = this.round, a = m.a;
    if (a === 'start' && !r) return this.startGame();
    if (a === 'kick' && m.id !== p.id && this.players.has(m.id)) return this.removePlayer(m.id, 'kick');
    if (a === 'transfer' && m.id !== p.id && this.players.has(m.id) && this.players.get(m.id).online) {
      this.hostId = m.id; this.event('host', `${this.players.get(m.id).name} הוא/היא המארח/ת עכשיו`, m.id); return this.sync();
    }
    if (a === 'close') { this.broadcast({ t: 'closed' }); return this.destroy(); }
    if (!r) return;
    if (a === 'lobby') return this.toLobby();
    if (a === 'skip') {
      if (r.phase === 'reveal') return this.isLast() ? this.toLobby() : this.startRound(false);
      return this.setPhase(PHASES[PHASES.indexOf(r.phase) + 1]);
    }
    if (a === 'restart' && r.phase === 'reveal' && this.isLast()) return this.startGame();
    if (a === 'redeal' && r.phase === 'answer') { this.event('info', 'המארח החליף את השאלה וחילק תפקידים מחדש'); return this.startRound(true); }
    if (a === 'pause' && !r.paused && r.endsAt) {
      clearTimeout(this.timer); r.paused = true; r.remaining = Math.max(1000, r.endsAt - Date.now());
      this.event('info', 'המשחק הושהה'); return this.sync();
    }
    if (a === 'resume' && r.paused) {
      r.paused = false; r.endsAt = Date.now() + r.remaining;
      this.timer = setTimeout(() => this.onTimer(), r.remaining);
      this.event('info', 'המשחק ממשיך'); this.sync(); return this.checkAuto();
    }
    if (a === 'addTime' && r.endsAt && r.phase !== 'reveal') {
      if (r.paused) r.remaining += 30e3;
      else { clearTimeout(this.timer); r.endsAt += 30e3; this.timer = setTimeout(() => this.onTimer(), r.endsAt - Date.now()); }
      return this.sync();
    }
  }

  /* ---------- ניקוד ---------- */
  score() {
    const r = this.round, c = this.cfg.roles, st = this.game.stats;
    if (r.result) return;
    const isImp = id => r.imps.includes(id);
    const roleOf = id => r.roles[id];
    const holder = rid => r.active.find(id => roleOf(id) === rid) || null;
    const weight = id => roleOf(id) === 'mayor' ? c.mayor.nums.weight : 1;
    const tally = {};
    for (const [v, t] of Object.entries(r.votes)) tally[t] = (tally[t] || 0) + weight(v);
    const max = Math.max(0, ...Object.values(tally));
    const tops = max > 0 ? Object.keys(tally).filter(k => tally[k] === max) : [];
    let top = tops.length === 1 ? tops[0] : null; // תיקו = אף אחד לא הודח
    // שומר ראש: אם המוגן היה אמור להיות מודח — הוא ניצל
    let saved = null, guardFail = false;
    const guard = holder('guardian'), prot = guard ? r.protects[guard] : null;
    if (top && prot && top === prot) {
      if (!isImp(top) || c.guardian.toggles.protectImp) { saved = top; top = null; } else guardFail = true;
    }
    const kind = r.kind;
    const good = t => kind === 'none' ? t === 'none' : kind === 'all' ? t === 'all' : isImp(t);
    const groupRight = top !== null && good(top);
    const gain = {};
    const S = id => (st[id] = st[id] || { good: 0, esc: 0, sus: 0, mis: 0, jest: 0, bet: 0, save: 0, law: 0 });
    const avenger = holder('avenger'), avengerHit = !!(avenger && top === avenger);
    for (const id of r.active) {
      const role = roleOf(id);
      let g = 0;
      if (role === 'imposter' && kind !== 'all') {
        const fooled = r.active.filter(q => !isImp(q) && r.votes[q] !== id).length;
        g = fooled * c.imposter.nums.fooled + (top === id ? 0 : c.imposter.nums.escape);
        if (top !== id) S(id).esc++;
      } else if (role === 'accomplice') g = groupRight ? 0 : c.accomplice.nums.win;
      else if (role === 'forger') g = groupRight ? 0 : c.forger.nums.win;
      else if (role === 'agent') { if (r.info.target && top === r.info.target) { g = c.agent.nums.win; S(id).mis++; } }
      else if (role === 'jester') { if (top === id) { g = c.jester.nums.win; S(id).jest++; } }
      else if (role === 'shadow') {
        const v = r.votes[id];
        if (v !== undefined && (v === top || (c.shadow.toggles.tie && tops.length > 1 && tops.includes(v)))) g = c.shadow.nums.win;
      } else if (role === 'lawyer') {
        const cl = r.info.client;
        if (cl && top !== cl) { g = c.lawyer.nums.win + (tally[cl] ? 0 : c.lawyer.nums.zero); S(id).law++; }
      } else if (role === 'gambler') {
        const b = r.bets[id];
        if (b && (b === 'right') === groupRight) { g = c.gambler.nums.win; S(id).bet++; }
        else if (b && c.gambler.toggles.penalty) g = -c.gambler.nums.lose;
      } else {
        // צד הטוב (בלש, ראש העיר, מודיע, תאומים, שומר, רואה, מציץ, נוקם) — וגם כולם בסבב "כולם אימפוסטרים"
        if (good(r.votes[id])) { g += c.crew.nums.correct; S(id).good++; }
        if (groupRight) g += c.crew.nums.group;
        if (role === 'guardian' && saved && !isImp(saved)) { g += c.guardian.nums.save; S(id).save++; }
      }
      gain[id] = g;
      S(id).sus += (tally[id] || 0);
    }
    const tw = r.info.twins;
    if (tw && tw.length === 2 && tw.every(id => good(r.votes[id]))) tw.forEach(id => { gain[id] += c.twins.nums.bonus; });
    const hitList = [];
    if (avengerHit) for (const [v, t] of Object.entries(r.votes)) if (t === avenger && gain[v] !== undefined) { gain[v] -= c.avenger.nums.penalty; hitList.push(v); }
    for (const id of r.active) { const p = this.players.get(id); if (p) p.score += gain[id]; }
    r.result = {
      tally, top, tops, groupRight, gain, saved, guardFail, avengerHit, hitList,
      agentOk: !!(r.info.target && top === r.info.target),
      lawyerOk: !!(r.info.client && top !== r.info.client),
      jesterWon: r.active.some(id => roleOf(id) === 'jester' && top === id)
    };
    this.game.history.push({ n: r.n, kind, groupRight, imps: r.imps.length });
  }

  awards() {
    const st = this.game ? this.game.stats : {};
    const list = [
      ['🔍', 'עין של נץ', 'good', 'הצבעות נכונות'],
      ['🎭', 'מלך ההסוואה', 'esc', 'בריחות'],
      ['👀', 'הכי חשוד', 'sus', 'קולות נגדו'],
      ['🎯', 'הסוכן החשאי', 'mis', 'משימות'],
      ['🃏', 'הליצן', 'jest', 'ניצחונות ג׳וקר'],
      ['🎰', 'יד חמה', 'bet', 'הימורים נכונים'],
      ['🛡️', 'המגן', 'save', 'הצלות'],
      ['⚖️', 'הפרקליט', 'law', 'לקוחות שניצלו']
    ];
    const out = [];
    for (const [e, title, k, unit] of list) {
      const ids = Object.keys(st).filter(id => this.players.has(id));
      const mx = Math.max(0, ...ids.map(id => st[id][k] || 0));
      if (!mx) continue;
      out.push({ e, title, unit, value: mx, who: ids.filter(id => (st[id][k] || 0) === mx) });
    }
    return out;
  }

  /* ---------- תצוגה אישית לכל שחקן ---------- */
  view(pid) {
    const r = this.round, me = this.players.get(pid);
    const cfgR = this.cfg.roles;
    const publicMayor = r && cfgR.mayor.toggles.public ? Object.keys(r.roles).find(id => r.roles[id] === 'mayor') : null;
    const players = [...this.players.values()].map(p => ({
      id: p.id, name: p.name, avatar: p.avatar, online: p.online, score: p.score,
      host: p.id === this.hostId, spectator: !!(r && !r.active.includes(p.id)),
      answered: !!(r && r.answers[p.id] !== undefined),
      voted: !!(r && r.votes[p.id] !== undefined),
      ready: !!(r && r.ready.has(p.id)),
      badge: p.id === publicMayor && r.phase !== 'reveal' ? 'mayor' : null
    }));
    const v = {
      code: this.code, you: pid, hostId: this.hostId, serverNow: Date.now(), cfg: this.cfg,
      phase: r ? r.phase : 'lobby', players, events: this.events.slice(-5), round: null, voteOptions: this.voteOptions()
    };
    if (!r) return v;
    const inRound = r.active.includes(pid);
    const role = inRound ? r.roles[pid] : null;
    const aware = cfgR.imposter.toggles.aware;
    const past = ph => PHASES.indexOf(r.phase) >= PHASES.indexOf(ph);
    const out = {
      rid: r.rid, n: r.n, total: this.game.total, phase: r.phase, endsAt: r.endsAt, paused: r.paused,
      remaining: r.paused ? r.remaining : 0, duration: this.duration(r.phase) * 1000,
      inRound, active: r.active, last: this.isLast(),
      myAnswer: r.answers[pid] ?? null, myVote: r.votes[pid] ?? null, myBet: r.bets[pid] ?? null, myProtect: r.protects[pid] ?? null,
      banners: (cfgR.avenger.toggles.announce && r.phase !== 'reveal' && Object.values(r.roles).includes('avenger')) ? ['avenger'] : [],
      answeredCount: Object.keys(r.answers).length, votedCount: Object.keys(r.votes).length, readyCount: r.ready.size
    };
    if (inRound) {
      const jesterB = role === 'jester' && cfgR.jester.toggles.impQuestion;
      out.myQuestion = role === 'imposter' || jesterB ? r.b : r.a;
      // אימפוסטר שלא יודע רואה בדיוק את מה ששחקן רגיל רואה
      out.myRole = role === 'imposter' && !aware ? 'crew' : role;
      const info = {};
      if (out.myRole === 'imposter') {
        if (cfgR.imposter.toggles.team && r.kind !== 'all') info.mates = r.imps.filter(x => x !== pid);
        if (cfgR.accomplice.toggles.known) info.accomplice = Object.keys(r.roles).find(id => r.roles[id] === 'accomplice') || null;
      }
      if (role === 'accomplice') info.imps = r.imps;
      if (role === 'agent') info.target = r.info.target;
      if (role === 'detective') info.check = r.info.check || null;
      if (role === 'insider') { info.other = r.b; if (cfgR.insider.toggles.seesCount) info.count = r.imps.length; }
      if (role === 'twins') info.twin = (r.info.twins || []).find(x => x !== pid) || null;
      if (role === 'mayor') info.weight = cfgR.mayor.nums.weight;
      if (role === 'guardian') info.canSelf = cfgR.guardian.toggles.self;
      if (role === 'seer' && (!cfgR.seer.toggles.lateVision || past('discuss'))) { info.pair = r.info.pair || null; info.vision = true; }
      if (role === 'seer' && cfgR.seer.toggles.lateVision && !past('discuss')) info.visionLater = true;
      if (role === 'snoop') {
        info.watch = r.info.watch || [];
        if (r.phase === 'vote') info.watchVotes = Object.fromEntries(info.watch.map(id => [id, r.votes[id] ?? null]));
      }
      if (role === 'forger') { info.other = r.b; if (cfgR.forger.toggles.knowsImps) info.imps = r.imps; }
      if (role === 'lawyer') { info.client = r.info.client || null; info.clientImp = !!(cfgR.lawyer.toggles.impClient && r.info.client && r.imps.includes(r.info.client)); }
      out.info = info;
    }
    // בסבב "כולם אימפוסטרים" כולם קיבלו את שאלה ב׳ — מציגים אותה, כדי שהסבב ייראה רגיל לגמרי
    if (past('discuss')) { out.crewQuestion = r.kind === 'all' ? r.b : r.a; out.answers = r.answers; }
    if (r.phase === 'reveal') {
      out.result = Object.assign({}, r.result, {
        kind: r.kind, imps: r.imps, roles: r.roles, a: r.a, b: r.b, votes: r.votes, bets: r.bets,
        target: r.info.target || null, check: r.info.check || null, twins: r.info.twins || null,
        protects: r.protects, client: r.info.client || null, pair: r.info.pair || null, watch: r.info.watch || null
      });
      if (this.isLast()) out.awards = this.awards();
    }
    v.round = out;
    return v;
  }

  /* ---------- תקשורת ---------- */
  event(kind, text, who) {
    this.events.push({ id: newId(), kind, text, who: who || null, at: Date.now() });
    if (this.events.length > 20) this.events.shift();
  }
  send(p, obj) { if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(obj)); }
  broadcast(obj) { this.players.forEach(p => this.send(p, obj)); }
  sync() {
    if (this.syncQueued) return;
    this.syncQueued = true;
    setImmediate(() => {
      this.syncQueued = false;
      this.players.forEach(p => this.send(p, { t: 'state', s: this.view(p.id) }));
    });
  }
  destroy() {
    clearTimeout(this.timer); clearTimeout(this.hostTimer);
    this.players.forEach(p => { clearTimeout(p.dropTimer); if (p.ws) p.ws.room = null; });
    this.players.clear();
    this.onEmpty(this);
  }
}

module.exports = { Room, MIN_PLAYERS };
