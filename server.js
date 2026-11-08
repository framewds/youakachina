// DRUGHILL портал: сайт + общее хранилище + вход через Telegram-бота. Без зависимостей (Node 18+).
//
// Переменные окружения (Railway → Variables):
//   BOT_TOKEN      токен бота от @BotFather (ОБЯЗАТЕЛЬНО, без него никто не сможет войти)
//   BOT_USERNAME   имя бота без @ (по умолчанию drughillsite_bot)
//   OWNER_TG       Telegram владельца-Лидера (по умолчанию @krystalovb)
//   DATA_DIR       куда писать данные; по умолчанию папка Volume Railway, иначе ./data
//   NOTIFY_CHAT_IDS  (необязательно) id чатов/групп через запятую, куда дублировать уведомления
//   TZ_NAME        часовой пояс для логов (по умолчанию Europe/Moscow)
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const BOT_USERNAME = process.env.BOT_USERNAME || 'drughillsite_bot';
const OWNER_TG = process.env.OWNER_TG || '@krystalovb';
const OWNER_L = OWNER_TG.toLowerCase();
const TG_API = process.env.TELEGRAM_API || 'https://api.telegram.org';
const TZ_NAME = process.env.TZ_NAME || 'Europe/Moscow';
const EXTRA_CHATS = (process.env.NOTIFY_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SEED_FILE = path.join(__dirname, 'seed', 'db.json');
const SESSION_TTL = 30 * 24 * 3600 * 1000;
const LOGIN_TTL = 10 * 60 * 1000;

fs.mkdirSync(path.join(DATA_DIR, 'avatars'), { recursive: true });

// ───────────────────────── хранилище ─────────────────────────
const LEVELS = { GUEST: 0, MEMBER: 1, SENIOR: 2, LEADER: 3 };
const LEADER_RANKS = ['Лидер', 'Зам. Лидера'];
const PLACEHOLDER = 'https://placehold.co/100x100/1c1c24/ffffff?text=DH';

const SPEC = {
  roster: ['id', 'nick', 'staticId', 'tg', 'rank', 'avatar'],
  applications: ['id', 'nick', 'staticId', 'tg', 'avatar', 'age', 'prime', 'exp', 'rolls', 'kind', 'status', 'createdAt'],
  promoReports: ['id', 'nick', 'staticId', 'tg', 'avatar', 'fromRank', 'toRank', 'tasks', 'proofs', 'status', 'createdAt'],
  payoutReports: ['id', 'nick', 'staticId', 'tg', 'avatar', 'total', 'items', 'proofs', 'status', 'createdAt'],
  vacations: ['id', 'nick', 'staticId', 'tg', 'avatar', 'rank', 'startDate', 'endDate', 'daysCount', 'reason', 'status', 'createdAt'],
  testSubmissions: ['id', 'testTitle', 'nick', 'staticId', 'tg', 'scorePct', 'passed', 'time', 'details', 'proof', 'proofComment', 'createdAt'],
  tests: ['id', 'title', 'passScore', 'questions', 'needProof', 'proofHint'],
  news: ['badge', 'date', 'title', 'desc', 'image', 'meta'],
  rules: ['badge', 'date', 'title', 'desc', 'image', 'meta'],
  diplomacy: ['badge', 'date', 'title', 'desc', 'image', 'meta'],
  fleet: ['badge', 'date', 'title', 'desc', 'image', 'meta'],
  estates: ['badge', 'date', 'title', 'desc', 'image', 'meta'],
  payoutItems: ['id', 'name', 'rate'],
  rollbacks: ['id', 'nick', 'staticId', 'tg', 'avatar', 'kind', 'title', 'link', 'comment', 'status', 'decidedBy', 'createdAt'],
  promoRequirements: ['id', 'rank', 'text'],
  promoClaims: ['id', 'nick', 'staticId', 'tg', 'avatar', 'status', 'decidedBy', 'createdAt'],
  promoCodes: ['id', 'code', 'type', 'uses', 'used', 'reward', 'active', 'createdBy', 'createdAt', 'usedBy'],
  logs: ['id', 'type', 'actor', 'action', 'time', 'ts']
};
const KEYS = Object.keys(SPEC);
const ID_COLLS = ['roster', 'applications', 'promoReports', 'payoutReports', 'vacations', 'testSubmissions', 'tests', 'rollbacks', 'promoClaims', 'promoCodes'];
const SET_COLLS = ['news', 'rules', 'diplomacy', 'fleet', 'estates', 'payoutItems', 'promoRequirements'];
const CONTENT = ['news', 'rules', 'diplomacy', 'fleet', 'estates'];
const URL_FIELDS = ['avatar', 'image'];
const STATUSES = ['PENDING', 'APPROVED', 'REJECTED'];
const PROMO_RANKS = ['1. Контракт', '2. Академ', '3. Мейн'];
const PROMO_TARGETS = ['2. Академ', '3. Мейн'];
const ROLLBACK_KINDS = ['Откат', 'Аттестация'];
const DEFAULT_REQUIREMENTS = [
  { id: 'rq1', rank: 'all', text: 'Сданы правила семьи DRUGHILL' },
  { id: 'rq2', rank: 'all', text: 'Выполнены семейные контракты' },
  { id: 'rq3', rank: 'all', text: 'Пополнен склад / общак' },
  { id: 'rq4', rank: 'all', text: 'Участие в строях / бизварах' }
];

function atomicWrite(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
function loadJson(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8')); } catch (e) { return fallback; }
}

let state, users, sessions, meta;
const dirty = new Set();
let flushTimer = null;
function markDirty(n) {
  dirty.add(n);
  if (!flushTimer) flushTimer = setTimeout(flush, 250);
}
function flush() {
  flushTimer = null;
  dirty.forEach(n => {
    const obj = n === 'state.json' ? state : n === 'users.json' ? users : n === 'sessions.json' ? sessions : meta;
    try { atomicWrite(path.join(DATA_DIR, n), JSON.stringify(obj)); } catch (e) { console.error('write failed', n, e.message); }
  });
  dirty.clear();
}

// ───────────────────────── очистка данных ─────────────────────────
function cleanStr(s, max) {
  s = String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  s = s.replace(/</g, '‹').replace(/>/g, '›').replace(/"/g, '”').replace(/'/g, '’').replace(/`/g, '’').replace(/\\/g, '/');
  return s.trim().slice(0, max || 2000);
}
function cleanUrl(s) {
  s = String(s == null ? '' : s).trim();
  return /^(https?:\/\/|\/avatars\/)[^\s"'<>`\\]{1,600}$/.test(s) ? s : PLACEHOLDER;
}
function cleanVal(v, depth) {
  if (typeof v === 'string') return cleanStr(v, 2000);
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  if (typeof v === 'boolean') return v;
  if (depth > 4 || v == null) return null;
  if (Array.isArray(v)) return v.slice(0, 100).map(x => cleanVal(x, depth + 1));
  if (typeof v === 'object') {
    const o = {};
    Object.keys(v).slice(0, 30).forEach(k => { o[cleanStr(k, 40)] = cleanVal(v[k], depth + 1); });
    return o;
  }
  return null;
}
function cleanRecord(coll, rec) {
  const out = {};
  if (!rec || typeof rec !== 'object') return out;
  SPEC[coll].forEach(f => {
    if (rec[f] === undefined) return;
    if (URL_FIELDS.indexOf(f) !== -1) out[f] = cleanUrl(rec[f]);
    else if (f === 'status') out[f] = STATUSES.indexOf(rec[f]) !== -1 ? rec[f] : 'PENDING';
    else if (f === 'id') out[f] = Number.isSafeInteger(rec[f]) && rec[f] > 0 ? rec[f] : (typeof rec[f] === 'string' ? cleanStr(rec[f], 40) : 0);
    else if (f === 'tg') out[f] = cleanStr(rec[f], 40);
    else if (f === 'nick') out[f] = cleanStr(rec[f], 40);
    else out[f] = cleanVal(rec[f], 0);
  });
  return out;
}
function cleanColl(coll, arr, cap) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, cap || 2000).map(r => cleanRecord(coll, r));
}

function seedState() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')); } catch (e) {}
  return normalizeState(raw);
}
function normalizeState(raw) {
  const S = { rev: 1, savedAt: new Date().toISOString() };
  KEYS.forEach(k => { S[k] = cleanColl(k, raw && raw[k], k === 'logs' ? 500 : 2000); });
  if (!S.payoutItems.length) {
    S.payoutItems = [
      { id: 'bizwar', name: 'Бизвар', rate: 25000 }, { id: 'factory', name: 'Цех / ВЗХ', rate: 35000 },
      { id: 'contract', name: 'Контракт', rate: 15000 }, { id: 'warehouse', name: 'Склад', rate: 10000 },
      { id: 'capt', name: 'Капт / война за территорию', rate: 30000 }, { id: 'cargo', name: 'Перевозка груза', rate: 12000 },
      { id: 'heist', name: 'Ограбление', rate: 20000 }, { id: 'recruit', name: 'Приглашение нового участника', rate: 10000 },
      { id: 'stroy', name: 'Участие в семейном строе', rate: 5000 }, { id: 'duty', name: 'Дежурство на территории', rate: 8000 }
    ];
  }
  if (!S.promoRequirements.length) S.promoRequirements = DEFAULT_REQUIREMENTS.map(r => Object.assign({}, r));
  S.rules.forEach(r => { if (r.badge) r.badge = r.badge.replace(/УСТАВ/g, 'ПРАВИЛА'); });
  S.promoRequirements.forEach(r => { if (r.text) r.text = r.text.replace(/устав семьи/gi, 'правила семьи').replace(/Сдан правила/, 'Сданы правила'); });
  ensureIds(S);
  ensureOwner(S);
  return S;
}
function ensureIds(S) {
  ID_COLLS.forEach(c => {
    const seen = new Set();
    S[c].forEach(r => {
      if (!r.id || seen.has(r.id)) r.id = nextId(seen);
      seen.add(r.id);
    });
  });
}
let idCounter = 0;
function nextId(taken) {
  let id;
  do { id = Date.now() * 1000 + (idCounter++ % 1000); } while (taken && taken.has(id));
  return id;
}
function ensureOwner(S) {
  const i = S.roster.findIndex(m => String(m.tg || '').toLowerCase() === OWNER_L);
  if (i < 0) S.roster.unshift({ id: nextId(), nick: 'Panic PR', staticId: '#15440', tg: OWNER_TG, rank: 'Лидер', avatar: PLACEHOLDER });
  else S.roster[i].rank = 'Лидер';
}

function initStore() {
  state = loadJson('state.json', null);
  if (!state || !Array.isArray(state.roster)) { state = seedState(); markDirty('state.json'); }
  users = loadJson('users.json', {});
  sessions = loadJson('sessions.json', {});
  meta = loadJson('meta.json', {});
  const now = Date.now();
  Object.keys(sessions).forEach(t => { if (now - sessions[t].created > SESSION_TTL) delete sessions[t]; });
}

// ───────────────────────── роли ─────────────────────────
function rankLevel(rank) {
  if (LEADER_RANKS.indexOf(rank) !== -1) return LEVELS.LEADER;
  if (rank === 'Старший состав') return LEVELS.SENIOR;
  return LEVELS.MEMBER;
}
function findRoster(S, tg) {
  const t = String(tg || '').toLowerCase();
  return S.roster.find(m => String(m.tg || '').toLowerCase() === t);
}
function resolveMe(uid) {
  const u = users[uid];
  if (!u) return null;
  const tgl = u.tg.toLowerCase();
  const entry = findRoster(state, u.tg);
  let level, rank, nick, staticId, avatar;
  if (tgl === OWNER_L) { level = LEVELS.LEADER; rank = 'Лидер'; }
  else if (entry) { level = rankLevel(entry.rank); rank = entry.rank; }
  else { level = LEVELS.GUEST; rank = 'Гость'; }
  if (entry) { nick = entry.nick; staticId = entry.staticId; } else { nick = u.nick; staticId = u.staticId; }
  avatar = u.avatar || (entry && entry.avatar) || PLACEHOLDER;
  return { uid, tg: u.tg, nick, staticId, avatar, rank, level };
}
function meView(me) {
  return {
    loggedIn: true, nick: me.nick, staticId: me.staticId, tg: me.tg, avatar: me.avatar,
    role: me.level >= LEVELS.SENIOR ? 'SENIOR' : me.level === LEVELS.MEMBER ? 'MEMBER' : 'GUEST',
    rankTitle: me.rank
  };
}
function sameTg(a, b) { return String(a || '').toLowerCase() === String(b || '').toLowerCase(); }

// что видит каждая роль
function viewFor(me) {
  const own = r => sameTg(r.tg, me.tg);
  const v = { rev: state.rev };
  KEYS.forEach(k => { v[k] = []; });
  if (me.level >= LEVELS.SENIOR) {
    KEYS.forEach(k => { v[k] = state[k]; });
  } else if (me.level === LEVELS.MEMBER) {
    CONTENT.forEach(k => { v[k] = state[k]; });
    v.roster = state.roster; v.payoutItems = state.payoutItems; v.tests = state.tests;
    v.vacations = state.vacations.map(x => own(x) ? x : Object.assign({}, x, { reason: '' }));
    v.promoReports = state.promoReports.filter(own);
    v.payoutReports = state.payoutReports.filter(own);
    v.testSubmissions = state.testSubmissions.filter(own);
    v.applications = state.applications.filter(own);
    v.rollbacks = state.rollbacks.filter(own);
    v.promoClaims = state.promoClaims.filter(own);
    v.promoRequirements = state.promoRequirements;
  } else {
    v.applications = state.applications.filter(own);
    v.promoClaims = state.promoClaims.filter(own);
  }
  return v;
}

// ───────────────────────── применение изменений клиента ─────────────────────────
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
function need(me, level, msg) { if (me.level < level) throw new HttpError(403, msg || 'Недостаточно прав'); }

function parseRuDate(s) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(s || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  return isNaN(d.getTime()) ? null : d;
}
function timeNow() {
  try { return new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: TZ_NAME }); }
  catch (e) { return new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }); }
}

const SUBS = {
  applications: { min: LEVELS.GUEST, fields: ['age', 'prime', 'exp', 'rolls', 'kind'], del: LEVELS.LEADER, decide: LEVELS.SENIOR },
  promoReports: { min: LEVELS.MEMBER, fields: ['toRank', 'tasks', 'proofs'], del: LEVELS.LEADER, decide: LEVELS.SENIOR },
  payoutReports: { min: LEVELS.MEMBER, fields: ['items', 'proofs'], del: LEVELS.LEADER, decide: LEVELS.SENIOR },
  vacations: { min: LEVELS.MEMBER, fields: ['startDate', 'endDate', 'reason'], del: LEVELS.SENIOR, decide: LEVELS.SENIOR },
  testSubmissions: { min: LEVELS.MEMBER, fields: ['testTitle', 'scorePct', 'passed', 'time', 'details', 'proof', 'proofComment'], del: LEVELS.LEADER, decide: LEVELS.LEADER + 1 },
  rollbacks: { min: LEVELS.MEMBER, fields: ['kind', 'title', 'link', 'comment'], del: LEVELS.SENIOR, decide: LEVELS.SENIOR },
  promoClaims: { min: LEVELS.GUEST, fields: [], del: LEVELS.LEADER, decide: LEVELS.SENIOR }
};
function rankIdx(rank) { return PROMO_RANKS.indexOf(rank); }

function buildSubmission(coll, me, rec, W) {
  const cfg = SUBS[coll];
  const clean = cleanRecord(coll, rec);
  const out = {
    id: 0, nick: me.nick, staticId: me.staticId, tg: me.tg, avatar: me.avatar,
    status: 'PENDING', createdAt: new Date().toISOString()
  };
  cfg.fields.forEach(f => { if (clean[f] !== undefined) out[f] = clean[f]; });
  if (coll === 'applications') {
    ['age', 'prime', 'exp', 'rolls'].forEach(f => { out[f] = cleanStr(out[f] || '—', 300); });
    out.kind = out.kind === 'Уже игрок семьи' ? 'Уже игрок семьи' : 'Заявка в семью';
  }
  if (coll === 'promoReports') {
    out.fromRank = me.rank;
    out.toRank = cleanStr(out.toRank || '', 60);
    if (PROMO_TARGETS.indexOf(out.toRank) === -1) throw new HttpError(400, 'Выберите ранг: 2. Академ или 3. Мейн');
    if (rankIdx(me.rank) === -1) throw new HttpError(400, 'Рапорт на повышение подают участники с 1 по 3 ранг');
    if (rankIdx(me.rank) >= rankIdx(out.toRank)) throw new HttpError(400, 'Этот ранг у вас уже есть или выше');
    out.tasks = cleanStr(out.tasks || '', 1000);
    out.proofs = cleanStr(out.proofs || '', 2000);
  }
  if (coll === 'payoutReports') {
    const rates = {};
    W.payoutItems.forEach(it => { rates[it.name] = it.rate; });
    const lines = [];
    let total = 0;
    (Array.isArray(out.items) ? out.items : []).slice(0, 40).forEach(l => {
      if (!l || typeof l !== 'object') return;
      const qty = Math.floor(Number(l.qty));
      const name = cleanStr(l.name, 80);
      if (!(qty > 0 && qty <= 1000) || rates[name] === undefined) return;
      lines.push({ name: name, qty: qty, rate: rates[name] });
      total += qty * rates[name];
    });
    if (!lines.length) throw new HttpError(400, 'В заявке на премию нет пунктов');
    out.items = lines;
    out.total = total;
    out.proofs = cleanStr(out.proofs || '', 2000);
  }
  if (coll === 'vacations') {
    const d1 = parseRuDate(out.startDate), d2 = parseRuDate(out.endDate);
    if (!d1 || !d2) throw new HttpError(400, 'Неверные даты отпуска (нужен формат ДД.ММ.ГГГГ)');
    let days = Math.round((d2 - d1) / 86400000);
    if (days < 1) days = 1;
    if (days > 365) throw new HttpError(400, 'Отпуск не может быть дольше 365 дней');
    out.daysCount = days;
    out.rank = me.rank;
    out.reason = cleanStr(out.reason || 'Семейные обстоятельства', 500);
  }
  if (coll === 'rollbacks') {
    out.kind = ROLLBACK_KINDS.indexOf(out.kind) !== -1 ? out.kind : 'Откат';
    out.title = cleanStr(out.title || (out.kind === 'Откат' ? 'Откат' : 'Аттестация'), 100);
    out.comment = cleanStr(out.comment || '', 500);
    out.link = cleanStr(out.link || '', 600);
    if (!/^https?:\/\/[^\s]{4,}$/.test(out.link)) throw new HttpError(400, 'Нужна ссылка на видео (https://...)');
  }
  if (coll === 'testSubmissions') {
    out.scorePct = Math.max(0, Math.min(100, Math.round(Number(out.scorePct) || 0)));
    out.passed = !!out.passed;
    out.time = cleanStr(out.time || timeNow(), 10);
    out.testTitle = cleanStr(out.testTitle || 'Тест', 100);
    const tst = W.tests.find(t => t.title === out.testTitle);
    if (tst && tst.needProof) {
      out.proof = cleanStr(out.proof || '', 600);
      out.proofComment = cleanStr(out.proofComment || '', 300);
      if (!/^https?:\/\/[^\s]{4,}$/.test(out.proof)) throw new HttpError(400, 'Для этого теста нужна ссылка на доки (https://...)');
    } else { delete out.proof; delete out.proofComment; }
  }
  if (coll === 'promoClaims') {
    if (W.promoClaims.some(r => sameTg(r.tg, me.tg) && r.status === 'PENDING')) throw new HttpError(400, 'Ваша заявка на награду уже на рассмотрении у Лидера');
  }
  const taken = new Set(W[coll].map(r => r.id));
  out.id = Number.isSafeInteger(rec && rec.id) && rec.id > 0 && !taken.has(rec.id) ? rec.id : nextId(taken);
  return out;
}

function applyPatch(me, patch, events) {
  const W = {};
  KEYS.forEach(k => { W[k] = state[k].slice(); });
  patch = patch && typeof patch === 'object' ? patch : {};

  // заявки, отчёты, отпуска, результаты тестов
  Object.keys(SUBS).forEach(coll => {
    const p = patch[coll];
    if (!p) return;
    const cfg = SUBS[coll];
    (Array.isArray(p.up) ? p.up : []).slice(0, 20).forEach(rec => {
      if (!rec || typeof rec !== 'object') return;
      const idx = W[coll].findIndex(r => r.id === rec.id);
      if (idx === -1) {
        need(me, cfg.min, coll === 'applications' ? 'Войдите через Telegram' : 'Эта функция доступна только участникам семьи');
        const pending = W[coll].filter(r => sameTg(r.tg, me.tg) && r.status === 'PENDING').length;
        if (me.level < LEVELS.SENIOR && coll !== 'testSubmissions' && pending >= 10) throw new HttpError(429, 'Слишком много неразобранных заявок');
        if (coll === 'applications' && me.level >= LEVELS.MEMBER) throw new HttpError(400, 'Вы уже в составе семьи');
        const item = buildSubmission(coll, me, rec, W);
        W[coll].unshift(item);
        events.push({ type: 'new', coll: coll, item: item });
      } else {
        need(me, cfg.decide, 'Решения принимает только Старший состав');
        const old = W[coll][idx];
        const st = STATUSES.indexOf(rec.status) !== -1 ? rec.status : old.status;
        if (st !== old.status) {
          W[coll][idx] = Object.assign({}, old, { status: st, decidedBy: me.nick });
          events.push({ type: 'decided', coll: coll, item: W[coll][idx], by: me });
        }
      }
    });
    (Array.isArray(p.del) ? p.del : []).slice(0, 50).forEach(id => {
      const idx = W[coll].findIndex(r => r.id === id);
      if (idx === -1) return;
      need(me, cfg.del, 'Удалять может только ' + (cfg.del >= LEVELS.LEADER ? 'Лидер или Зам. Лидера' : 'Старший состав'));
      W[coll].splice(idx, 1);
    });
  });

  // состав
  if (patch.roster) {
    const p = patch.roster;
    (Array.isArray(p.up) ? p.up : []).slice(0, 50).forEach(rec => {
      need(me, LEVELS.SENIOR, 'Менять состав может только Старший состав');
      const clean = cleanRecord('roster', rec);
      if (!clean.nick || !clean.tg) throw new HttpError(400, 'У участника нужны ник и Telegram');
      if (clean.tg.charAt(0) !== '@') clean.tg = '@' + clean.tg;
      clean.rank = cleanStr(clean.rank || '1. Контракт', 40);
      const idx = W.roster.findIndex(r => r.id === (rec && rec.id));
      if (idx === -1) {
        if (W.roster.some(r => sameTg(r.tg, clean.tg))) return;
        if (rankLevel(clean.rank) === LEVELS.LEADER) need(me, LEVELS.LEADER, 'Лидера и замов назначает только Лидер или Зам. Лидера');
        const taken = new Set(W.roster.map(r => r.id));
        clean.id = nextId(taken);
        clean.staticId = clean.staticId || '#0';
        clean.avatar = clean.avatar || PLACEHOLDER;
        W.roster.push(clean);
      } else {
        const old = W.roster[idx];
        const touchesLeader = rankLevel(old.rank) === LEVELS.LEADER || rankLevel(clean.rank) === LEVELS.LEADER;
        if (touchesLeader && clean.rank !== old.rank) need(me, LEVELS.LEADER, 'Ранги Лидера и замов меняет только Лидер или Зам. Лидера');
        if (sameTg(old.tg, OWNER_TG)) clean.rank = 'Лидер';
        W.roster[idx] = Object.assign({}, old, clean, { id: old.id });
      }
    });
    (Array.isArray(p.del) ? p.del : []).slice(0, 50).forEach(id => {
      const idx = W.roster.findIndex(r => r.id === id);
      if (idx === -1) return;
      need(me, LEVELS.SENIOR, 'Исключать может только Старший состав');
      const old = W.roster[idx];
      if (sameTg(old.tg, OWNER_TG)) throw new HttpError(403, 'Владельца семьи исключить нельзя');
      if (rankLevel(old.rank) === LEVELS.LEADER) need(me, LEVELS.LEADER, 'Лидера и замов исключает только Лидер или Зам. Лидера');
      W.roster.splice(idx, 1);
    });
  }

  // тесты
  if (patch.tests) {
    const p = patch.tests;
    (Array.isArray(p.up) ? p.up : []).slice(0, 20).forEach(rec => {
      need(me, LEVELS.SENIOR, 'Тесты создаёт только Старший состав');
      const clean = cleanRecord('tests', rec);
      if (!Array.isArray(clean.questions) || !clean.questions.length) throw new HttpError(400, 'В тесте нет вопросов');
      clean.title = cleanStr(clean.title || 'Аттестация', 100);
      clean.passScore = Math.max(1, Math.min(100, Math.round(Number(clean.passScore) || 70)));
      clean.needProof = clean.needProof === true;
      clean.proofHint = clean.needProof ? cleanStr(clean.proofHint || 'Приложите ссылку на доки (скрин, видео, отчёт)', 200) : '';
      const idx = W.tests.findIndex(r => r.id === (rec && rec.id));
      if (idx === -1) { clean.id = nextId(new Set(W.tests.map(r => r.id))); W.tests.push(clean); }
      else W.tests[idx] = Object.assign({}, clean, { id: W.tests[idx].id });
    });
    (Array.isArray(p.del) ? p.del : []).slice(0, 100).forEach(id => {
      const idx = W.tests.findIndex(r => r.id === id);
      if (idx === -1) return;
      need(me, LEVELS.SENIOR, 'Тесты удаляет только Старший состав');
      W.tests.splice(idx, 1);
    });
  }

  // разделы с контентом и пункты премий
  SET_COLLS.forEach(coll => {
    if (!Array.isArray(patch[coll])) return;
    need(me, LEVELS.SENIOR, 'Редактировать разделы может только Старший состав');
    const next = cleanColl(coll, patch[coll], 200);
    if (coll === 'payoutItems') {
      if (!next.length) throw new HttpError(400, 'Нужен хотя бы один пункт премии');
      const seen = new Set();
      next.forEach((it, i) => {
        it.name = cleanStr(it.name, 80);
        it.rate = Math.max(0, Math.floor(Number(it.rate) || 0));
        if (!it.id || seen.has(it.id)) it.id = 'p' + Date.now() + '_' + i;
        seen.add(it.id);
      });
    } else if (coll === 'promoRequirements') {
      if (!next.length) throw new HttpError(400, 'Нужно хотя бы одно требование');
      const seen = new Set();
      next.forEach((it, i) => {
        it.text = cleanStr(it.text, 120);
        it.rank = it.rank === 'all' || PROMO_TARGETS.indexOf(it.rank) !== -1 ? it.rank : 'all';
        if (!it.id || seen.has(it.id)) it.id = 'rq' + Date.now() + '_' + i;
        seen.add(it.id);
      });
      if (next.some(it => !it.text)) throw new HttpError(400, 'У требования не заполнен текст');
    } else {
      const old = W[coll].map(r => JSON.stringify(r));
      const nxt = next.map(r => JSON.stringify(r));
      const onlyAdded = old.every(o => nxt.indexOf(o) !== -1);
      if (!onlyAdded) need(me, LEVELS.LEADER, 'Удалять и менять записи может только Лидер или Зам. Лидера');
      next.forEach(r => { if (!r.date) r.date = 'Сегодня'; });
    }
    W[coll] = next;
  });

  // журнал действий
  if (patch.logs && Array.isArray(patch.logs.add)) {
    patch.logs.add.slice(0, 20).reverse().forEach(l => {
      if (!l || typeof l !== 'object') return;
      W.logs.unshift({
        id: nextId(), type: cleanStr(l.type || 'AUTH', 12).toUpperCase(), actor: me.nick,
        action: cleanStr(l.action, 300), time: timeNow(), ts: new Date().toISOString()
      });
    });
    W.logs = W.logs.slice(0, 500);
  }

  // если одобрили заявку / рапорт, а клиент не прислал roster, ничего не делаем автоматически:
  // изменения состава всегда приходят явно и проверяются выше.
  return W;
}

function commit(W) {
  KEYS.forEach(k => { state[k] = W[k]; });
  ensureOwner(state);
  state.rev += 1;
  state.savedAt = new Date().toISOString();
  markDirty('state.json');
}

// ───────────────────────── Telegram ─────────────────────────
async function tg(method, params) {
  const r = await fetch(TG_API + '/bot' + BOT_TOKEN + '/' + method, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params || {})
  });
  return r.json();
}
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function send(chatId, text, extra) {
  if (!BOT_TOKEN || !chatId) return Promise.resolve();
  return tg('sendMessage', Object.assign({ chat_id: chatId, text: text, parse_mode: 'HTML', disable_web_page_preview: true }, extra || {}))
    .catch(e => console.error('tg send failed', e.message));
}
function leaderChats() {
  const set = new Set(EXTRA_CHATS);
  state.roster.forEach(m => {
    if (rankLevel(m.rank) !== LEVELS.LEADER) return;
    Object.keys(users).forEach(id => { if (sameTg(users[id].tg, m.tg) && users[id].chatId) set.add(String(users[id].chatId)); });
  });
  Object.keys(users).forEach(id => { if (sameTg(users[id].tg, OWNER_TG) && users[id].chatId) set.add(String(users[id].chatId)); });
  return Array.from(set);
}
function chatOf(tgHandle) {
  const id = Object.keys(users).find(i => sameTg(users[i].tg, tgHandle) && users[i].chatId);
  return id ? users[id].chatId : null;
}
const COLL_TITLE = { promoClaims: 'заявка «Награда за промокод»', applications: 'заявка в семью', vacations: 'заявка на отпуск', promoReports: 'рапорт на повышение', payoutReports: 'заявка на премию', rollbacks: 'заявка с видео' };
function eventText(ev, site) {
  const it = ev.item;
  const who = '<b>' + esc(it.nick) + '</b> (' + esc(it.staticId) + ', ' + esc(it.tg) + ')';
  let body = '';
  if (ev.coll === 'applications' && it.kind === 'Уже игрок семьи') body = '👤 <b>Запрос доступа: «Игрок семьи»</b>\n' + who + '\nПроверьте и примите в состав.';
  else if (ev.coll === 'applications') body = '📝 <b>Новая заявка в семью</b>\n' + who + '\nВозраст: ' + esc(it.age) + '\nПрайм: ' + esc(it.prime) + '\nОпыт: ' + esc(it.exp) + '\nОткаты: ' + esc(it.rolls);
  else if (ev.coll === 'vacations') body = '🏖 <b>Заявка на отпуск</b>\n' + who + ' · ' + esc(it.rank) + '\n' + esc(it.startDate) + ' — ' + esc(it.endDate) + ' (' + it.daysCount + ' дн.)\nПричина: ' + esc(it.reason);
  else if (ev.coll === 'promoReports') body = '⬆️ <b>Рапорт на повышение</b>\n' + who + '\n' + esc(it.fromRank) + ' → ' + esc(it.toRank) + '\nВыполнено: ' + esc(it.tasks) + '\nДок-ва: ' + esc(it.proofs);
  else if (ev.coll === 'payoutReports') body = '💰 <b>Заявка на премию</b>\n' + who + '\nСумма: $' + Number(it.total).toLocaleString('en-US') + '\n' + (it.items || []).map(l => esc(l.name) + ' × ' + l.qty).join(', ') + (it.proofs ? '\nДок-ва: ' + esc(it.proofs) : '');
  else if (ev.coll === 'rollbacks') body = '🎬 <b>' + (it.kind === 'Аттестация' ? 'Видео для аттестации' : 'Новый откат') + '</b>\n' + who + '\n' + esc(it.title) + (it.comment ? '\nКомментарий: ' + esc(it.comment) : '') + '\n' + esc(it.link);
  else if (ev.coll === 'promoClaims') body = '🎟 <b>Награда за промокод</b>\n' + who + '\nИгрок активировал промокод в игре и просит награду. Проверьте и выдайте.';
  else if (ev.coll === 'testSubmissions' && it.proof) body = '📎 <b>Тест с докой: ' + esc(it.testTitle) + '</b>\n' + who + '\nРезультат: ' + it.scorePct + '%\nДоки: ' + esc(it.proof) + (it.proofComment ? '\nКомментарий: ' + esc(it.proofComment) : '');
  else return '';
  return body + '\n\nРассмотреть: ' + site;
}
function dispatchEvents(events, site) {
  events.forEach(ev => {
    if (ev.type === 'new') {
      if (ev.coll === 'testSubmissions' && !ev.item.proof) return;
      const text = eventText(ev, site);
      if (text) leaderChats().forEach(c => send(c, text));
    } else if (ev.type === 'decided') {
      const ok = ev.item.status === 'APPROVED';
      if (ev.coll === 'vacations' && !ok) { /* отказ тоже сообщаем */ }
      const title = COLL_TITLE[ev.coll];
      if (!title) return;
      const chat = chatOf(ev.item.tg);
      if (chat) send(chat, (ok ? '✅ Ваша ' : '❌ Ваша ') + title + (ok ? ' одобрена.' : ' отклонена.') + '\nРешение: ' + esc(ev.by.nick));
    }
  });
}

// вход через бота
const logins = {};
function sweepLogins() {
  const now = Date.now();
  Object.keys(logins).forEach(c => { if (now - logins[c].created > LOGIN_TTL) delete logins[c]; });
}
function tgHandleOf(from) { return from.username ? '@' + from.username : '@id' + from.id; }

async function fetchAvatar(userId) {
  try {
    const p = await tg('getUserProfilePhotos', { user_id: userId, limit: 1 });
    if (!p.ok || !p.result || !p.result.total_count) return null;
    const ph = p.result.photos[0];
    const f = await tg('getFile', { file_id: ph[ph.length - 1].file_id });
    if (!f.ok) return null;
    const r = await fetch(TG_API + '/file/bot' + BOT_TOKEN + '/' + f.result.file_path);
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    fs.writeFileSync(path.join(DATA_DIR, 'avatars', userId + '.jpg'), buf);
    return '/avatars/' + userId + '.jpg?v=' + Date.now();
  } catch (e) { return null; }
}

async function finalizeLogin(code, from) {
  const L = logins[code];
  if (!L) return;
  const uid = String(from.id);
  const handle = tgHandleOf(from);
  const prev = users[uid] || {};
  users[uid] = {
    id: uid, tg: handle, chatId: prev.chatId || from.id,
    nick: L.nick || prev.nick || cleanStr(from.first_name || handle, 40),
    staticId: L.staticId || prev.staticId || '—',
    avatar: prev.avatar || null
  };
  const av = await Promise.race([fetchAvatar(from.id), new Promise(r => setTimeout(() => r(null), 4000))]);
  if (av) users[uid].avatar = av;
  // аватар и актуальный ник/static в составе
  const entry = findRoster(state, handle);
  if (entry && av && entry.avatar !== av) { entry.avatar = av; state.rev += 1; markDirty('state.json'); }
  if (sameTg(handle, OWNER_TG)) { ensureOwner(state); markDirty('state.json'); }
  const token = crypto.randomBytes(32).toString('hex');
  sessions[token] = { uid: uid, created: Date.now() };
  L.token = token;
  L.status = 'ok';
  markDirty('users.json'); markDirty('sessions.json');
}

async function handleUpdate(u) {
  if (u.message && u.message.chat && u.message.chat.type === 'private' && u.message.from) {
    const m = u.message, from = m.from;
    const uid = String(from.id);
    const prev = users[uid];
    if (prev && prev.chatId !== m.chat.id) { prev.chatId = m.chat.id; markDirty('users.json'); }
    const mm = /^\/start\s+(auth_[a-f0-9]{16})\s*$/.exec(m.text || '');
    if (mm) {
      sweepLogins();
      const L = logins[mm[1]];
      if (!L || L.status !== 'pending') return send(m.chat.id, 'Ссылка для входа устарела. Вернитесь на сайт и нажмите «Войти через Telegram» ещё раз.');
      L.from = from;
      if (!users[uid]) { users[uid] = { id: uid, tg: tgHandleOf(from), chatId: m.chat.id, nick: L.nick || cleanStr(from.first_name || '', 40), staticId: L.staticId || '—', avatar: null }; markDirty('users.json'); }
      else if (users[uid].chatId !== m.chat.id) { users[uid].chatId = m.chat.id; markDirty('users.json'); }
      return send(m.chat.id,
        '🔐 <b>Вход на портал DRUGHILL</b>\nЗапрос от имени: <b>' + esc(L.nick || tgHandleOf(from)) + '</b>\nЭто вы?',
        { reply_markup: { inline_keyboard: [[{ text: '✅ Да, это я', callback_data: 'ok:' + mm[1] }, { text: '❌ Нет, не я', callback_data: 'no:' + mm[1] }]] } });
    }
    if (/^\/start/.test(m.text || '')) {
      return send(m.chat.id, 'Это бот портала DRUGHILL. Чтобы войти, откройте сайт и нажмите «Войти через Telegram». Сюда же будут приходить уведомления по заявкам.');
    }
    return;
  }
  if (u.callback_query) {
    const cq = u.callback_query;
    const mm = /^(ok|no):(auth_[a-f0-9]{16})$/.exec(cq.data || '');
    if (!mm) return;
    const L = logins[mm[2]];
    const done = txt => Promise.all([
      tg('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {}),
      cq.message ? tg('editMessageText', { chat_id: cq.message.chat.id, message_id: cq.message.message_id, text: txt }).catch(() => {}) : null
    ]);
    if (!L || L.status !== 'pending' || !L.from || L.from.id !== cq.from.id) return done('Запрос входа устарел.');
    if (mm[1] === 'no') { L.status = 'denied'; return done('❌ Вход отклонён.'); }
    await finalizeLogin(mm[2], cq.from);
    return done('✅ Вход выполнен. Вернитесь на сайт.');
  }
}

async function pollTelegram() {
  if (!BOT_TOKEN) { console.warn('BOT_TOKEN не задан: вход через Telegram работать не будет'); return; }
  try { await tg('deleteWebhook', {}); } catch (e) {}
  let offset = meta.tgOffset || 0;
  for (;;) {
    try {
      const d = await tg('getUpdates', { offset: offset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
      if (!d.ok) { await new Promise(r => setTimeout(r, 5000)); continue; }
      for (const u of d.result) {
        offset = u.update_id + 1;
        try { await handleUpdate(u); } catch (e) { console.error('update failed', e); }
      }
      if (d.result.length) { meta.tgOffset = offset; markDirty('meta.json'); }
    } catch (e) {
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

// ───────────────────────── HTTP ─────────────────────────
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > limit) { reject(new HttpError(413, 'Слишком большой запрос')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(new HttpError(400, 'Некорректный JSON')); }
    });
    req.on('error', reject);
  });
}
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function authMe(req) {
  const h = String(req.headers.authorization || '');
  const token = h.indexOf('Bearer ') === 0 ? h.slice(7) : '';
  const s = token && sessions[token];
  if (!s || Date.now() - s.created > SESSION_TTL) return null;
  const me = resolveMe(s.uid);
  if (me) me.token = token;
  return me;
}
function siteUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL;
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return proto + '://' + host + '/';
}
const rate = {};
function limited(req, key, max, windowMs) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const k = key + ':' + ip, now = Date.now();
  const arr = (rate[k] || []).filter(t => now - t < windowMs);
  arr.push(now); rate[k] = arr;
  return arr.length > max;
}
setInterval(() => { const now = Date.now(); Object.keys(rate).forEach(k => { rate[k] = rate[k].filter(t => now - t < 3600000); if (!rate[k].length) delete rate[k]; }); }, 600000).unref();

function stateResponse(me, full) {
  const out = { me: meView(me), rev: state.rev, vsig: me.level + '|' + me.rank };
  if (full) out.state = viewFor(me);
  return out;
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  if (p === '/api/auth/start' && req.method === 'POST') {
    if (!BOT_TOKEN) throw new HttpError(503, 'Бот не настроен: в Railway не задана переменная BOT_TOKEN');
    if (limited(req, 'login', 12, 10 * 60 * 1000)) throw new HttpError(429, 'Слишком много попыток входа, подождите');
    const b = await readBody(req, 4096);
    sweepLogins();
    if (Object.keys(logins).length > 500) throw new HttpError(429, 'Слишком много попыток входа, подождите');
    const code = 'auth_' + crypto.randomBytes(8).toString('hex');
    let sid = cleanStr(b.staticId, 12).replace(/[^\d]/g, '');
    if (cleanStr(b.nick, 32).length < 2 || !sid) throw new HttpError(400, 'Укажите игровой ник и Static ID');
    logins[code] = { created: Date.now(), status: 'pending', nick: cleanStr(b.nick, 32), staticId: sid ? '#' + sid : '' };
    return json(res, 200, { code: code, link: 'https://t.me/' + BOT_USERNAME + '?start=' + code });
  }
  if (p === '/api/auth/status' && req.method === 'GET') {
    const code = url.searchParams.get('code') || '';
    const L = logins[code];
    if (!L || Date.now() - L.created > LOGIN_TTL) return json(res, 200, { status: 'expired' });
    if (L.status === 'ok') { delete logins[code]; return json(res, 200, { status: 'ok', token: L.token }); }
    return json(res, 200, { status: L.status });
  }

  const me = authMe(req);
  if (!me) throw new HttpError(401, 'Нужно войти');

  if (p === '/api/logout' && req.method === 'POST') { delete sessions[me.token]; markDirty('sessions.json'); return json(res, 200, { ok: true }); }

  if (p === '/api/state' && req.method === 'GET') {
    const rev = parseInt(url.searchParams.get('rev'), 10);
    const vsig = url.searchParams.get('vsig');
    const full = !(rev === state.rev && vsig === me.level + '|' + me.rank);
    return json(res, 200, stateResponse(me, full));
  }

  if (p === '/api/sync' && req.method === 'POST') {
    const b = await readBody(req, 1024 * 1024);
    const events = [];
    try {
      const W = applyPatch(me, b.patch, events);
      commit(W);
      dispatchEvents(events, siteUrl(req));
      return json(res, 200, stateResponse(resolveMe(me.uid), true));
    } catch (e) {
      if (e instanceof HttpError && e.code !== 413) {
        const fresh = resolveMe(me.uid) || me;
        const out = stateResponse(fresh, true);
        out.error = e.message;
        return json(res, e.code, out);
      }
      throw e;
    }
  }

  if (p === '/api/profile' && req.method === 'POST') {
    const b = await readBody(req, 4096);
    const nick = cleanStr(b.nick, 32);
    const sid = cleanStr(b.staticId, 12).replace(/[^\d]/g, '');
    const u = users[me.uid];
    if (nick) u.nick = nick;
    if (sid) u.staticId = '#' + sid;
    markDirty('users.json');
    const entry = findRoster(state, me.tg);
    if (entry) { if (nick) entry.nick = nick; if (sid) entry.staticId = '#' + sid; state.rev += 1; markDirty('state.json'); }
    return json(res, 200, stateResponse(resolveMe(me.uid), true));
  }

  if (p.indexOf('/api/admin/') === 0) {
    need(me, LEVELS.LEADER, 'Доступно только Лидеру и Заму Лидера');
    if (p === '/api/admin/export' && req.method === 'GET') {
      const out = {};
      KEYS.forEach(k => { out[k] = state[k]; });
      out.savedAt = new Date().toISOString();
      out.savedBy = me.nick;
      return json(res, 200, out);
    }
    if (p === '/api/admin/import' && req.method === 'POST') {
      const b = await readBody(req, 8 * 1024 * 1024);
      if (!b || !Array.isArray(b.roster)) throw new HttpError(400, 'Это не файл базы DRUGHILL');
      const S = normalizeState(b);
      S.rev = state.rev + 1;
      state = S;
      markDirty('state.json');
      return json(res, 200, stateResponse(resolveMe(me.uid), true));
    }
    if (p === '/api/admin/reset' && req.method === 'POST') {
      const S = seedState();
      S.rev = state.rev + 1;
      state = S;
      markDirty('state.json');
      return json(res, 200, stateResponse(resolveMe(me.uid), true));
    }
  }
  throw new HttpError(404, 'Не найдено');
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };

function serveFile(req, res, filePath, cache) {
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404 Not Found'); }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': TYPES[ext] || 'application/octet-stream', 'Content-Length': st.size,
      'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff'
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch (e) { res.writeHead(400); return res.end('Bad request'); }
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch (e) { res.writeHead(400); return res.end('Bad request'); }
  if (pathname.indexOf('\0') !== -1) { res.writeHead(400); return res.end('Bad request'); }

  if (pathname.indexOf('/api/') === 0) {
    try { await handleApi(req, res, url); }
    catch (e) {
      if (e instanceof HttpError) return json(res, e.code, { error: e.message });
      console.error(e);
      json(res, 500, { error: 'Ошибка сервера' });
    }
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
  if (pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  const av = /^\/avatars\/(\d+\.jpg)$/.exec(pathname);
  if (av) return serveFile(req, res, path.join(DATA_DIR, 'avatars', av[1]), 'public, max-age=86400');
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.join(PUBLIC_DIR, pathname);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  serveFile(req, res, filePath, path.extname(filePath) === '.html' ? 'no-store' : 'public, max-age=3600');
});

initStore();
function shutdown() { if (flushTimer) clearTimeout(flushTimer); flush(); process.exit(0); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
server.listen(PORT, '0.0.0.0', () => {
  console.log('DRUGHILL portal on port ' + PORT + ', data: ' + DATA_DIR);
  pollTelegram();
});
