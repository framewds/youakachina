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
const dns = require('dns');
const https = require('https');
const net = require('net');

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
// Подпись сессий: токен входа несёт данные пользователя и подписан секретом, поэтому после деплоя
// (даже если файлы на сервере потерялись) человека не выкидывает с сайта. Секрет стабилен между деплоями:
// берётся из SESSION_SECRET, иначе выводится из BOT_TOKEN.
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('drughill-session:' + (BOT_TOKEN || 'no-bot-token')).digest('hex');
function b64u(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function macOf(body) { return b64u(crypto.createHmac('sha256', SESSION_SECRET).update(body).digest()); }
function signToken(u) {
  const body = b64u(JSON.stringify({ uid: String(u.id), tg: u.tg, chatId: u.chatId || null, nick: u.nick, staticId: u.staticId, iat: Date.now() }));
  return 's1.' + body + '.' + macOf('s1.' + body);
}
function verifyToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== 's1') return null;
  const want = Buffer.from(macOf('s1.' + parts[1])), got = Buffer.from(parts[2]);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  try {
    const p = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (!p || !p.uid || !p.tg || !(Date.now() - p.iat < SESSION_TTL)) return null;
    return p;
  } catch (e) { return null; }
}
function tokenId(token) { return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 24); }
const LOGIN_TTL = 10 * 60 * 1000;

fs.mkdirSync(path.join(DATA_DIR, 'avatars'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

// ───────────────────────── хранилище ─────────────────────────
const LEVELS = { GUEST: 0, MEMBER: 1, SENIOR: 2, LEADER: 3 };
const LEADER_RANKS = ['Лидер', 'Зам. Лидера'];
const PLACEHOLDER = '/avatars/ph.svg?w=100&h=100&bg=1c1c24&fg=ffffff&text=DH';

const SPEC = {
  roster: ['id', 'nick', 'staticId', 'tg', 'rank', 'avatar'],
  applications: ['id', 'nick', 'staticId', 'tg', 'avatar', 'age', 'prime', 'exp', 'rolls', 'kind', 'status', 'createdAt'],
  promoReports: ['id', 'nick', 'staticId', 'tg', 'avatar', 'fromRank', 'toRank', 'tasks', 'proofs', 'status', 'createdAt'],
  payoutReports: ['id', 'nick', 'staticId', 'tg', 'avatar', 'total', 'items', 'proofs', 'status', 'createdAt'],
  vacations: ['id', 'nick', 'staticId', 'tg', 'avatar', 'rank', 'startDate', 'endDate', 'daysCount', 'reason', 'status', 'createdAt'],
  testSubmissions: ['id', 'testTitle', 'nick', 'staticId', 'tg', 'scorePct', 'passed', 'time', 'details', 'proof', 'proofComment', 'proofs', 'createdAt'],
  tests: ['id', 'title', 'passScore', 'questions', 'needProof', 'proofHint', 'proofCount'],
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
const PROMO_RANKS = ['1. Контракт', '2. Лил Драгхилл', '3. Драгхилл', '4. Проверенный'];
const PROMO_TARGETS = PROMO_RANKS.slice(1);
// старые названия рангов → новые (данные и старые открытые вкладки)
const RANK_RENAME = { '2. Академ': '2. Лил Драгхилл', '3. Мейн': '3. Драгхилл', '2 ранг — Академ': '2. Лил Драгхилл', '3 ранг — Мейн': '3. Драгхилл', '1 РАНГ': '1. Контракт', '2 РАНГ': '2. Лил Драгхилл', '3 РАНГ': '3. Драгхилл', '4 РАНГ': '4. Проверенный' };
function mapRank(v) { return typeof v === 'string' && RANK_RENAME[v] ? RANK_RENAME[v] : v; }
const ROLLBACK_KINDS = ['Откат', 'Аттестация'];
const DEFAULT_REQUIREMENTS = [
  { id: 'rq1', rank: 'all', text: 'Сданы правила семьи DRUGHILL' },
  { id: 'rq2', rank: 'all', text: 'Выполнены семейные контракты' },
  { id: 'rq3', rank: 'all', text: 'Пополнен склад / общак' },
  { id: 'rq4', rank: 'all', text: 'Участие в строях / бизварах' }
];
// у каждого повышения (2, 3 и 4 ранг) свой список: старые требования «Для всех» дублируются в оба
function splitReqs(arr) {
  const out = [];
  let changed = false;
  (arr || []).forEach(r => {
    if (r && r.rank === 'all') {
      changed = true;
      PROMO_TARGETS.forEach((rk, i) => out.push({ id: String(r.id) + '_' + (i + 2), rank: rk, text: r.text }));
    } else out.push(r);
  });
  return { list: out, changed: changed };
}

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
  if (n === 'state.json' && typeof scheduleWarm === 'function') scheduleWarm();
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
  s = s.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return s.trim().slice(0, max || 2000);
}
// «Имя Фамилия» только кириллицей (допускается дефис: Анна-Мария Иванова-Петрова)
const RU_WORD = '[А-ЯЁа-яё]{2,20}(?:-[А-ЯЁа-яё]{2,20})?';
const RU_FULLNAME_RE = new RegExp('^' + RU_WORD + '\\s+' + RU_WORD + '$');
function capWord(w) {
  return w.split('-').map(x => x.charAt(0).toUpperCase() + x.slice(1).toLowerCase()).join('-');
}
// возвращает аккуратно оформленное «Имя Фамилия» или '' если формат неверный
function normalizeFullName(s) {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  if (!RU_FULLNAME_RE.test(s)) return '';
  return s.split(' ').map(capWord).join(' ');
}
const FULLNAME_ERR = 'Укажите Имя и Фамилию по-русски через пробел';

// внешний placehold.co у многих не открывается — заменяем на свою заглушку (/avatars/ph.svg)
function localPh(s) {
  const m = /^https?:\/\/placehold\.co\/(\d{1,4})x(\d{1,4})\/([0-9a-fA-F]{3,6})\/([0-9a-fA-F]{3,6})(?:\.\w+)?\?text=(.*)$/.exec(s);
  if (!m) return PLACEHOLDER;
  let t = m[5];
  try { t = decodeURIComponent(t.replace(/\+/g, ' ')); } catch (e) {}
  return '/avatars/ph.svg?w=' + m[1] + '&h=' + m[2] + '&bg=' + m[3] + '&fg=' + m[4] + '&text=' + encodeURIComponent(t.slice(0, 14));
}
function placeholderSvg(q) {
  const num = (v, d) => Math.max(20, Math.min(1200, parseInt(v, 10) || d));
  const hex = (v, d) => /^[0-9a-fA-F]{3,6}$/.test(String(v || '')) ? v : d;
  const w = num(q.get('w'), 100), h = num(q.get('h'), 100);
  const bg = hex(q.get('bg'), '1c1c24'), fg = hex(q.get('fg'), 'ffffff');
  const t = String(q.get('text') || '').slice(0, 14).replace(/[&<>"']/g, '');
  const size = Math.round(Math.max(10, Math.min(h * 0.3, (w * 0.86) / Math.max(1, t.length) * 1.5)));
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '"><rect width="100%" height="100%" fill="#' + bg + '"/>' +
    '<text x="50%" y="50%" fill="#' + fg + '" font-family="Arial,Helvetica,sans-serif" font-weight="700" font-size="' + size + '" text-anchor="middle" dominant-baseline="central">' + t + '</text></svg>';
}
function cleanUrl(s) {
  s = String(s == null ? '' : s).trim();
  if (/^https?:\/\/placehold\.co\//i.test(s)) return localPh(s);
  if (/^\/\//.test(s)) s = 'https:' + s;
  if (/^https?:\/\//i.test(s)) s = s.replace(/\s+/g, '').replace(/'/g, '%27').replace(/"/g, '%22').replace(/</g, '%3C').replace(/>/g, '%3E').replace(/`/g, '%60').replace(/\\/g, '%5C');
  return /^(https?:\/\/|\/avatars\/|\/uploads\/)[^\s"'<>`\\]{1,2000}$/.test(s) ? s : PLACEHOLDER;
}
// любая ссылка: с https://, без протокола (youtu.be/abc, drive.google.com/...), с www. — всё приводим к https://...
function normLink(s) {
  s = String(s == null ? '' : s).trim().replace(/\s+/g, '');
  if (!s) return '';
  if (/^\/\//.test(s)) s = 'https:' + s;
  else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s.replace(/^[a-z]+:(?!\d)/i, '');
  if (!/^https?:\/\/[^\s\/]+/i.test(s) || s.length < 10) return '';
  return cleanStr(s, 600);
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
    else if (f === 'rank' || f === 'fromRank' || f === 'toRank') out[f] = mapRank(cleanStr(rec[f], 60));
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
  S.promoRequirements = splitReqs(S.promoRequirements).list;
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
  { let ch = false;
    const ren = (o, f) => { if (o && typeof o[f] === 'string' && RANK_RENAME[o[f]]) { o[f] = RANK_RENAME[o[f]]; ch = true; } };
    (state.roster || []).forEach(o => ren(o, 'rank'));
    (state.promoReports || []).forEach(o => { ren(o, 'fromRank'); ren(o, 'toRank'); });
    (state.promoRequirements || []).forEach(o => ren(o, 'rank'));
    (state.fleet || []).forEach(o => ren(o, 'badge'));
    if (ch) markDirty('state.json'); }
  { const sp = splitReqs(state.promoRequirements); if (sp.changed) { state.promoRequirements = sp.list; markDirty('state.json'); } }
  { // у каждого повышения должен быть свой список требований: для новых рангов копируем с предыдущего
    const reqs = state.promoRequirements = state.promoRequirements || [];
    PROMO_TARGETS.forEach((rk, i) => {
      if (i === 0 || reqs.some(r => r.rank === rk)) return;
      const prev = reqs.filter(r => r.rank === PROMO_TARGETS[i - 1]);
      prev.forEach((r, j) => reqs.push({ id: 'rq' + (j + 1) + '_' + (i + 2), rank: rk, text: r.text }));
      markDirty('state.json');
    }); }
  users = loadJson('users.json', {});
  // миграция: старые ссылки placehold.co → своя заглушка
  { let ch = false;
    const fix = o => { ['avatar', 'image'].forEach(f => { if (o && typeof o[f] === 'string' && /^https?:\/\/placehold\.co\//i.test(o[f])) { o[f] = localPh(o[f]); ch = true; } }); };
    KEYS.forEach(k => { if (Array.isArray(state[k])) state[k].forEach(fix); });
    if (ch) markDirty('state.json');
    let uch = false;
    Object.keys(users).forEach(id => { const u = users[id]; if (u && typeof u.avatar === 'string' && /^https?:\/\/placehold\.co\//i.test(u.avatar)) { u.avatar = localPh(u.avatar); uch = true; } });
    if (uch) markDirty('users.json'); }
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
  maybeRefreshAvatar(uid);
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
  Object.keys(v).forEach(k => { if (Array.isArray(v[k])) v[k] = withAvatars(v[k]); });
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
  testSubmissions: { min: LEVELS.MEMBER, fields: ['testTitle', 'scorePct', 'passed', 'time', 'details', 'proof', 'proofComment', 'proofs'], del: LEVELS.LEADER, decide: LEVELS.LEADER + 1 },
  rollbacks: { min: LEVELS.MEMBER, fields: ['kind', 'title', 'link', 'comment'], del: LEVELS.SENIOR, decide: LEVELS.SENIOR },
  promoClaims: { min: LEVELS.GUEST, fields: [], del: LEVELS.LEADER, decide: LEVELS.SENIOR }
};
function rankIdx(rank) { return PROMO_RANKS.indexOf(rank); }
// ранги, которые выдаёт и снимает только Лидер / Зам. Лидера
function isHighRank(rank) { return rank === 'Старший состав' || LEADER_RANKS.indexOf(rank) !== -1; }

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
    if (PROMO_TARGETS.indexOf(out.toRank) === -1) throw new HttpError(400, 'Выберите ранг: ' + PROMO_TARGETS.join(', '));
    if (rankIdx(me.rank) === -1) throw new HttpError(400, 'Рапорт на повышение подают участники до ранга ' + PROMO_RANKS[PROMO_RANKS.length - 1]);
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
      const need = Math.max(1, Math.min(10, Math.round(Number(tst.proofCount) || 1)));
      let list = Array.isArray(out.proofs) ? out.proofs : [];
      if (!list.length && out.proof) list = [{ link: out.proof, comment: out.proofComment }];
      const proofs = [];
      list.slice(0, 20).forEach(x => {
        const link = normLink(x && typeof x === 'object' ? x.link : x);
        if (link) proofs.push({ link: link, comment: cleanStr(x && x.comment || '', 300) });
      });
      if (proofs.length < need) throw new HttpError(400, 'Нужно приложить ссылок на видео: ' + need);
      out.proofs = proofs;
      out.proof = proofs.map(x => x.link).join(' ');
      out.proofComment = cleanStr(out.proofComment || proofs[0].comment || '', 300);
    } else { delete out.proof; delete out.proofComment; delete out.proofs; }
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
        if (isHighRank(clean.rank)) need(me, LEVELS.LEADER, 'Старший состав, замов и Лидера назначает только Лидер или Зам. Лидера');
        const taken = new Set(W.roster.map(r => r.id));
        clean.id = nextId(taken);
        clean.staticId = clean.staticId || '#0';
        clean.avatar = clean.avatar || PLACEHOLDER;
        W.roster.push(clean);
      } else {
        const old = W.roster[idx];
        clean.tg = old.tg; // Telegram у существующего участника менять нельзя
        if (clean.rank !== old.rank) {
          if (sameTg(old.tg, me.tg)) throw new HttpError(403, 'Свой ранг менять нельзя');
          if (isHighRank(old.rank) || isHighRank(clean.rank)) need(me, LEVELS.LEADER, 'Ранги Старшего состава, замов и Лидера меняет только Лидер или Зам. Лидера');
        }
        if (sameTg(old.tg, OWNER_TG)) clean.rank = 'Лидер';
        W.roster[idx] = Object.assign({}, old, clean, { id: old.id });
        if (clean.rank !== old.rank) events.push({ type: 'rank', coll: 'roster', item: W.roster[idx], from: old.rank, to: W.roster[idx].rank, by: me });
      }
    });
    (Array.isArray(p.del) ? p.del : []).slice(0, 50).forEach(id => {
      const idx = W.roster.findIndex(r => r.id === id);
      if (idx === -1) return;
      need(me, LEVELS.SENIOR, 'Исключать может только Старший состав');
      const old = W.roster[idx];
      if (sameTg(old.tg, OWNER_TG)) throw new HttpError(403, 'Владельца семьи исключить нельзя');
      if (sameTg(old.tg, me.tg)) throw new HttpError(403, 'Себя исключить нельзя');
      if (isHighRank(old.rank)) need(me, LEVELS.LEADER, 'Старший состав, замов и Лидера исключает только Лидер или Зам. Лидера');
      W.roster.splice(idx, 1);
      events.push({ type: 'kick', coll: 'roster', item: old, from: old.rank, by: me });
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
      clean.proofCount = clean.needProof ? Math.max(1, Math.min(10, Math.round(Number(clean.proofCount) || 1))) : 0;
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
function chatsOfHandle(handle, set) {
  const h = String(handle || '');
  const mId = /^@id(\d+)$/i.exec(h);
  Object.keys(users).forEach(id => {
    const u = users[id];
    if (!u || !u.chatId) return;
    if (sameTg(u.tg, h) || (mId && String(u.id || id) === mId[1])) set.add(String(u.chatId));
  });
}
// все, у кого на сайте роль «Лидер» или «Зам. Лидера» (+ владелец + доп. чаты из NOTIFY_CHAT_IDS)
function leaderChats() {
  const set = new Set(EXTRA_CHATS);
  const missing = [];
  const seen = new Set();
  const leaders = state.roster.filter(m => rankLevel(m.rank) === LEVELS.LEADER).map(m => m.tg).concat([OWNER_TG])
    .filter(h => { const k = String(h).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  leaders.forEach(h => {
    const mine = new Set();
    chatsOfHandle(h, mine);
    if (!mine.size) missing.push(h);
    mine.forEach(c => set.add(c));
  });
  if (missing.length) console.warn('Лидеры без чата с ботом (должны один раз войти через бота):', missing.join(', '));
  return Array.from(set);
}
// профиль человека на сайте: ник, Static ID, ранг в составе, статистика тестов
function siteProfile(it) {
  const entry = findRoster(state, it.tg);
  const tests = state.testSubmissions.filter(t => sameTg(t.tg, it.tg));
  return {
    nick: entry ? entry.nick : it.nick,
    staticId: entry ? entry.staticId : it.staticId,
    tg: it.tg,
    rank: entry ? entry.rank : 'Гость (не в составе)',
    inRoster: !!entry,
    tests: tests.length,
    passed: tests.filter(t => t.passed).length
  };
}
// ── оформление сообщений бота: тексты прежние, меняется только начертание ──
function head(emoji, title) { return emoji + ' <b><u>' + title + '</u></b>'; }
function who(it) { return '<b>' + esc(it.nick) + '</b> (<code>' + esc(it.staticId) + '</code>, ' + esc(it.tg) + ')'; }
function fld(label, val) { return '\n<b>' + label + ':</b> ' + val; }
function profileLine(it, ev) {
  const p = siteProfile(it);
  if (ev && ev.type === 'kick') p.rank = 'исключён (был: ' + ev.from + ')';
  return '\n\n🌐 <b><u>Профиль на сайте</u></b>\n<b>Ник:</b> ' + esc(p.nick) + ' · <b>Static ID:</b> <code>' + esc(p.staticId) +
    '</code>\n<b>Ранг на сайте:</b> <u>' + esc(p.rank) + '</u>\n<b>Telegram:</b> ' + esc(p.tg) +
    (p.tests ? '\n<b>Тесты:</b> ' + p.tests + ' (сдано ' + p.passed + ')' : '');
}
function profileButtons(it, site) {
  if (!/^https:\/\//.test(site)) return null; // Telegram не принимает http/localhost в кнопках
  const base = site.replace(/#.*$/, '');
  const row = [{ text: '🌐 Профиль на сайте', url: base + '#profile/' + encodeURIComponent(String(it.tg || '').replace(/^@/, '')) }];
  const h = String(it.tg || '').replace(/^@/, '');
  if (/^[A-Za-z0-9_]{4,32}$/.test(h) && !/^id\d+$/.test(h)) row.push({ text: '✈️ Telegram', url: 'https://t.me/' + h });
  return { inline_keyboard: [row] };
}
function chatOf(tgHandle) {
  const id = Object.keys(users).find(i => sameTg(users[i].tg, tgHandle) && users[i].chatId);
  return id ? users[id].chatId : null;
}
const COLL_TITLE = { promoClaims: 'заявка «Награда за промокод»', applications: 'заявка в семью', vacations: 'заявка на отпуск', promoReports: 'рапорт на повышение', payoutReports: 'заявка на премию', rollbacks: 'заявка с видео' };
function eventText(ev, site) {
  const it = ev.item;
  const w = who(it);
  let body = '';
  if (ev.coll === 'applications' && it.kind === 'Уже игрок семьи') body = head('👤', 'Запрос доступа: «Игрок семьи»') + '\n' + w + '\n<i>Проверьте и примите в состав.</i>';
  else if (ev.coll === 'applications') body = head('📝', 'Новая заявка в семью') + '\n' + w + fld('Возраст', esc(it.age)) + fld('Прайм', esc(it.prime)) + fld('Опыт', esc(it.exp)) + fld('Откаты', esc(it.rolls));
  else if (ev.coll === 'vacations') body = head('🏖', 'Заявка на отпуск') + '\n' + w + ' · <u>' + esc(it.rank) + '</u>\n<b>' + esc(it.startDate) + ' — ' + esc(it.endDate) + '</b> (' + esc(it.daysCount) + ' дн.)' + fld('Причина', esc(it.reason));
  else if (ev.coll === 'promoReports') body = head('⬆️', 'Рапорт на повышение') + '\n' + w + '\n<u>' + esc(it.fromRank) + '</u> → <b><u>' + esc(it.toRank) + '</u></b>' + fld('Выполнено', esc(it.tasks)) + fld('Док-ва', esc(it.proofs));
  else if (ev.coll === 'payoutReports') body = head('💰', 'Заявка на премию') + '\n' + w + fld('Сумма', '<b><u>' + Number(it.total).toLocaleString('ru-RU') + ' ₽</u></b>') + '\n' + (it.items || []).map(l => esc(l.name) + ' × <b>' + esc(l.qty) + '</b>').join(', ') + (it.proofs ? fld('Док-ва', esc(it.proofs)) : '');
  else if (ev.coll === 'rollbacks') body = head('🎬', it.kind === 'Аттестация' ? 'Видео для аттестации' : 'Новый откат') + '\n' + w + '\n<b>' + esc(it.title) + '</b>' + (it.comment ? fld('Комментарий', esc(it.comment)) : '') + '\n' + esc(it.link);
  else if (ev.coll === 'promoClaims') body = head('🎟', 'Награда за промокод') + '\n' + w + '\n<i>Игрок активировал промокод в игре и просит награду. Проверьте и выдайте.</i>';
  else if (ev.coll === 'testSubmissions' && it.proof) body = head('📎', 'Тест с докой: ' + esc(it.testTitle)) + '\n' + w + fld('Результат', '<b>' + esc(it.scorePct) + '%</b>') + (Array.isArray(it.proofs) && it.proofs.length ? it.proofs.map((x, i) => fld('Видео ' + (i + 1), esc(x.link) + (x.comment ? ' — ' + esc(x.comment) : ''))).join('') : fld('Доки', esc(it.proof)) + (it.proofComment ? fld('Комментарий', esc(it.proofComment)) : ''));
  else if (ev.coll === 'roster' && ev.type === 'rank') body = head('🎖', 'Смена ранга') + '\n' + w + '\n<s>' + esc(ev.from) + '</s> → <b><u>' + esc(ev.to) + '</u></b>' + fld('Изменил', esc(ev.by.nick));
  else if (ev.coll === 'roster' && ev.type === 'kick') body = head('🚪', 'Участник исключён') + '\n' + w + fld('Ранг был', '<u>' + esc(ev.from) + '</u>') + fld('Исключил', esc(ev.by.nick));
  else return '';
  return body + profileLine(it, ev) + '\n\n<b>Рассмотреть:</b> ' + esc(site);
}
function dispatchEvents(events, site) {
  events.forEach(ev => {
    if (ev.type === 'new' || ev.type === 'rank' || ev.type === 'kick') {
      if (ev.coll === 'testSubmissions' && !ev.item.proof) return;
      const text = eventText(ev, site);
      if (!text) return;
      const markup = profileButtons(ev.item, site);
      leaderChats().forEach(c => send(c, text, markup ? { reply_markup: markup } : null));
    } else if (ev.type === 'decided') {
      const ok = ev.item.status === 'APPROVED';
      const title = COLL_TITLE[ev.coll];
      if (!title) return;
      const chat = chatOf(ev.item.tg);
      if (chat) send(chat, (ok ? '✅ Ваша ' : '❌ Ваша ') + '<b><u>' + esc(title) + '</u></b> ' + (ok ? '<b>одобрена</b>.' : '<b>отклонена</b>.') + '\n<b>Решение:</b> ' + esc(ev.by.nick));
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
    if (buf.length < 100) return null;
    fs.writeFileSync(path.join(DATA_DIR, 'avatars', userId + '.jpg'), buf);
    return '/avatars/' + userId + '.jpg?v=' + Date.now();
  } catch (e) { console.warn('avatar', userId, e.message); return null; }
}
const isRealAvatar = a => typeof a === 'string' && /^\/avatars\/\d+\.jpg/.test(a);
function avatarByTg(tgHandle) {
  const t = String(tgHandle || '').toLowerCase();
  const u = Object.keys(users).map(k => users[k]).find(x => x && String(x.tg || '').toLowerCase() === t && isRealAvatar(x.avatar));
  return u ? u.avatar : null;
}
// сохраняем свежий аватар в профиль и в состав
function applyAvatar(uid, av) {
  const u = users[uid]; if (!u || !av) return;
  u.avatar = av; u.avatarAt = Date.now(); markDirty('users.json');
  const entry = findRoster(state, u.tg);
  if (entry && entry.avatar !== av) { entry.avatar = av; state.rev += 1; markDirty('state.json'); }
}
const avatarBusy = {};
const avatarMiss = {};
function maybeRefreshAvatar(uid) {
  const u = users[uid];
  if (!BOT_TOKEN || !u || avatarBusy[uid]) return;
  const stale = !isRealAvatar(u.avatar) || !u.avatarAt || Date.now() - u.avatarAt > 12 * 3600 * 1000;
  if (!stale || (u.avatarTry && Date.now() - u.avatarTry < 10 * 60 * 1000)) return;
  avatarBusy[uid] = true; u.avatarTry = Date.now();
  fetchAvatar(uid).then(av => { if (av) applyAvatar(uid, av); }).finally(() => { delete avatarBusy[uid]; });
}
// в списках подставляем настоящую аватарку по @tg, если в записи заглушка
function withAvatars(arr) {
  if (!Array.isArray(arr) || !arr.length || !arr[0] || !('avatar' in arr[0] || arr.some(r => r && 'avatar' in r))) return arr;
  const cache = {};
  return arr.map(r => {
    if (!r || !('avatar' in r) || isRealAvatar(r.avatar)) return r;
    const key = String(r.tg || '').toLowerCase();
    const a = key in cache ? cache[key] : (cache[key] = avatarByTg(r.tg));
    return a ? Object.assign({}, r, { avatar: a }) : r;
  });
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
  const ap = fetchAvatar(from.id);
  ap.then(late => { if (late) applyAvatar(uid, late); });   // если Telegram ответил позже — всё равно сохраним
  const av = await Promise.race([ap, new Promise(r => setTimeout(() => r(null), 7000))]);
  if (av) { users[uid].avatar = av; users[uid].avatarAt = Date.now(); }
  // аватар и актуальный ник/static в составе
  const entry = findRoster(state, handle);
  if (entry && av && entry.avatar !== av) { entry.avatar = av; state.rev += 1; markDirty('state.json'); }
  if (sameTg(handle, OWNER_TG)) { ensureOwner(state); markDirty('state.json'); }
  const token = signToken(users[uid]);
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
      if (!L || L.status !== 'pending') return send(m.chat.id, 'Ссылка для входа устарела. Вернитесь на сайт и нажмите <b>«Войти через Telegram»</b> ещё раз.');
      L.from = from;
      if (!users[uid]) { users[uid] = { id: uid, tg: tgHandleOf(from), chatId: m.chat.id, nick: L.nick || cleanStr(from.first_name || '', 40), staticId: L.staticId || '—', avatar: null }; markDirty('users.json'); }
      else if (users[uid].chatId !== m.chat.id) { users[uid].chatId = m.chat.id; markDirty('users.json'); }
      return send(m.chat.id,
        '🔐 <b><u>Вход на портал DRUGHILL</u></b>\nЗапрос от имени: <b>' + esc(L.nick || tgHandleOf(from)) + '</b>\n<b>Это вы?</b>',
        { reply_markup: { inline_keyboard: [[{ text: '✅ Да, это я', callback_data: 'ok:' + mm[1] }, { text: '❌ Нет, не я', callback_data: 'no:' + mm[1] }]] } });
    }
    if (/^\/start/.test(m.text || '')) {
      return send(m.chat.id, 'Это бот портала <b><u>DRUGHILL</u></b>. Чтобы войти, откройте сайт и нажмите <b>«Войти через Telegram»</b>. Сюда же будут приходить <u>уведомления по заявкам</u>.');
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
      cq.message ? tg('editMessageText', { chat_id: cq.message.chat.id, message_id: cq.message.message_id, text: txt, parse_mode: 'HTML' }).catch(() => {}) : null
    ]);
    if (!L || L.status !== 'pending' || !L.from || L.from.id !== cq.from.id) return done('<b>Запрос входа устарел.</b>');
    if (mm[1] === 'no') { L.status = 'denied'; return done('❌ <b><u>Вход отклонён.</u></b>'); }
    await finalizeLogin(mm[2], cq.from);
    return done('✅ <b><u>Вход выполнен.</u></b> Вернитесь на сайт.');
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
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > limit) { reject(new HttpError(413, 'Файл слишком большой (максимум 10 МБ)')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
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
  let s = token && sessions[token];
  if (!s && token) {
    const p = verifyToken(token);
    if (p && (meta.revoked || []).indexOf(tokenId(token)) === -1) {
      s = sessions[token] = { uid: p.uid, created: p.iat };
      if (!users[p.uid]) users[p.uid] = { id: p.uid, tg: p.tg, chatId: p.chatId, nick: p.nick, staticId: p.staticId, avatar: null };
      markDirty('users.json'); markDirty('sessions.json');
    }
  }
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
    const fullName = normalizeFullName(b.nick);
    if (!fullName) throw new HttpError(400, FULLNAME_ERR);
    if (!sid) throw new HttpError(400, 'Укажите Static ID (цифры)');
    logins[code] = { created: Date.now(), status: 'pending', nick: fullName, staticId: '#' + sid };
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

  if (p === '/api/logout' && req.method === 'POST') {
      delete sessions[me.token];
      meta.revoked = (meta.revoked || []).concat(tokenId(me.token)).slice(-500);
      markDirty('sessions.json'); markDirty('meta.json');
      return json(res, 200, { ok: true });
    }

  // фото, которое браузер смог загрузить (а сервер нет): сохраняем на сервер, чтобы оно больше не пропадало
  if (p === '/api/img/save' && req.method === 'POST') {
    need(me, LEVELS.MEMBER, 'Войдите как участник семьи');
    if (limited(req, 'imgsave', 120, 10 * 60 * 1000)) throw new HttpError(429, 'Слишком много запросов');
    const target = String(url.searchParams.get('u') || '').trim();
    const known = CONTENT.some(c => (state[c] || []).some(it => it && it.image === target));
    if (!known) throw new HttpError(400, 'Эта ссылка не используется на сайте');
    const buf = await readRaw(req, IMG_MAX);
    const type = sniffImage(buf);
    if (!type) throw new HttpError(400, 'Это не картинка');
    if (!cacheRead(target)) cacheWrite(target, { buf: buf, ct: type });
    return json(res, 200, { ok: true });
  }
  // загрузка фото с устройства: файл хранится в Volume и не зависит от внешних ссылок
  if (p === '/api/upload' && req.method === 'POST') {
    need(me, LEVELS.SENIOR, 'Загружать фото может только Старший состав');
    if (limited(req, 'upload', 60, 10 * 60 * 1000)) throw new HttpError(429, 'Слишком много загрузок, подождите');
    const buf = await readRaw(req, IMG_MAX);
    const type = sniffImage(buf);
    const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' }[type];
    if (!ext) throw new HttpError(400, 'Нужна картинка JPG, PNG, WEBP или GIF');
    const name = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 24) + ext;
    fs.writeFileSync(path.join(DATA_DIR, 'uploads', name), buf);
    return json(res, 200, { url: '/uploads/' + name });
  }

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
    let nick = cleanStr(b.nick, 32);
    const sid = cleanStr(b.staticId, 12).replace(/[^\d]/g, '');
    const u = users[me.uid];
    // имя менять можно только на корректное «Имя Фамилия»; старый ник без изменений пропускаем
    if (nick && nick !== me.nick) {
      const fullName = normalizeFullName(nick);
      if (!fullName) throw new HttpError(400, FULLNAME_ERR);
      nick = fullName;
    }
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

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };

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


// ───────────────────────── прокси картинок ─────────────────────────
// Внешние фото (imgur, discord, postimages и т.п.) грузятся через сервер: так не мешают блокировки
// провайдера, защита от «чужого» referer и ссылки-страницы (imgur.com/xxxx, альбомы).
function isPrivateIp(ip) {
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::' || l.indexOf('fc') === 0 || l.indexOf('fd') === 0 || l.indexOf('fe8') === 0 || l.indexOf('fe9') === 0 || l.indexOf('fea') === 0 || l.indexOf('feb') === 0) return true;
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l);
    return m ? isPrivateIp(m[1]) : false;
  }
  const o = ip.split('.').map(Number);
  if (o.length !== 4 || o.some(n => !(n >= 0 && n <= 255))) return true;
  return o[0] === 0 || o[0] === 10 || o[0] === 127 || (o[0] === 169 && o[1] === 254) || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) ||
    (o[0] === 192 && o[1] === 168) || (o[0] === 100 && o[1] >= 64 && o[1] <= 127) || o[0] >= 224;
}
function safeLookup(host, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  dns.lookup(host, Object.assign({}, opts, { all: true }), (err, list) => {
    if (err) return cb(err);
    const ok = list.filter(a => !isPrivateIp(a.address)).sort((a, b) => a.family - b.family);
    if (!ok.length) return cb(new Error('blocked address'));
    if (opts && opts.all) return cb(null, ok);
    cb(null, ok[0].address, ok[0].family);
  });
}
const UA_BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const UA_BOT = 'Mozilla/5.0 (compatible; Googlebot-Image/1.0; +http://www.google.com/bot.html)';
const UA_DISCORD = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)';
const IMG_MAX = 10 * 1024 * 1024;

// ref: undefined → referer = origin самого сайта, null → без referer
function getRemote(u, hops, ua, ref) {
  return new Promise((resolve, reject) => {
    let U;
    try { U = new URL(u); } catch (e) { return reject(new Error('bad url')); }
    if (U.protocol !== 'http:' && U.protocol !== 'https:') return reject(new Error('bad protocol'));
    if (U.port && U.port !== '80' && U.port !== '443') return reject(new Error('bad port'));
    if (net.isIP(U.hostname) && isPrivateIp(U.hostname)) return reject(new Error('blocked address'));
    const mod = U.protocol === 'https:' ? https : http;
    const headers = { 'User-Agent': ua || UA_BROWSER, 'Accept': 'image/avif,image/webp,image/apng,image/*,text/html;q=0.8,*/*;q=0.5', 'Accept-Language': 'ru,en;q=0.8' };
    if (ref !== null) headers['Referer'] = ref || (U.origin + '/');
    const rq = mod.request(U, { method: 'GET', lookup: safeLookup, timeout: 9000, headers: headers }, res => {
      if ([301, 302, 303, 307, 308].indexOf(res.statusCode) !== -1 && res.headers.location) {
        res.resume();
        if (hops >= 5) return reject(new Error('too many redirects'));
        let next;
        try { next = new URL(res.headers.location, U).href; } catch (e) { return reject(new Error('bad redirect')); }
        return resolve(getRemote(next, hops + 1, ua, ref));
      }
      resolve(res);
    });
    rq.on('timeout', () => rq.destroy(new Error('timeout')));
    rq.on('error', reject);
    rq.end();
  });
}
// читает ответ целиком (не больше max); too=true, если ответ больше лимита
function readLimited(res, max) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0, done = false;
    const timer = setTimeout(() => { if (!done) { done = true; res.destroy(); reject(new Error('read timeout')); } }, 20000);
    res.on('data', c => { if (done) return; n += c.length; chunks.push(c); if (n > max) { done = true; clearTimeout(timer); res.destroy(); resolve({ buf: Buffer.concat(chunks), too: true }); } });
    res.on('end', () => { if (done) return; done = true; clearTimeout(timer); resolve({ buf: Buffer.concat(chunks), too: false }); });
    res.on('error', e => { if (done) return; done = true; clearTimeout(timer); reject(e); });
    res.on('close', () => { if (done) return; done = true; clearTimeout(timer); resolve({ buf: Buffer.concat(chunks), too: false }); });
  });
}
// определяем настоящий тип по первым байтам (не верим Content-Type: бывает octet-stream, text/plain и т.п.)
function sniffImage(b) {
  if (!b || b.length < 12) return '';
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
  if (b.slice(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (b.slice(4, 8).toString('latin1') === 'ftyp') { const br = b.slice(8, 12).toString('latin1'); if (/^(avif|avis)$/.test(br)) return 'image/avif'; if (/^(heic|heix|mif1|msf1)$/.test(br)) return 'image/heic'; }
  if (b[0] === 0x42 && b[1] === 0x4D) return 'image/bmp';
  return '';
}
function normalizeImageUrl(u) {
  let m = /^https?:\/\/(?:www\.|m\.)?imgur\.com\/(?:gallery\/)?([A-Za-z0-9]{5,10})(?:\.(?:jpe?g|png|gif|webp|gifv|mp4))?\/?(?:[?#].*)?$/.exec(u);
  if (m && !/^(a|gallery|t|r|user)$/i.test(m[1])) return 'https://i.imgur.com/' + m[1] + '.jpg';
  m = /^https?:\/\/(?:i\.)?imgur\.com\/([A-Za-z0-9]{5,10})\.gifv(?:[?#].*)?$/.exec(u);
  if (m) return 'https://i.imgur.com/' + m[1] + '.gif';
  return u;
}
// из HTML-страницы (альбом imgur, postimages, prnt.sc, lightshot…) достаём адрес картинки
function imageFromHtml(html, base) {
  const pats = [
    /<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url|:url)?|twitter:image(?::src)?)["'][^>]*content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image(?::secure_url|:url)?|twitter:image(?::src)?)["']/i,
    /<link[^>]+rel=["']image_src["'][^>]*href=["']([^"']+)["']/i,
    /(https?:\/\/i\.imgur\.com\/[A-Za-z0-9]{5,10}\.(?:jpe?g|png|gif|webp))/i,
    /<img[^>]+id=["']main-image["'][^>]*src=["']([^"']+)["']/i,
    /<img[^>]+class=["'][^"']*no-click[^"']*["'][^>]*src=["']([^"']+)["']/i
  ];
  for (const re of pats) {
    const mm = re.exec(html);
    if (mm) { try { return new URL(mm[1].replace(/&amp;/g, '&'), base).href; } catch (e) {} }
  }
  return '';
}
// варианты одной и той же ссылки (Discord: cdn ↔ media, без подписи)
function urlVariants(u) {
  const out = [u];
  try {
    const U = new URL(u);
    if (/(^|\.)discordapp\.(com|net)$/i.test(U.hostname) || /(^|\.)discord\.com$/i.test(U.hostname)) {
      const swap = new URL(u);
      swap.hostname = /^cdn\./i.test(U.hostname) ? 'media.discordapp.net' : 'cdn.discordapp.com';
      out.push(swap.href);
      if (U.search) { const bare = new URL(u); bare.search = ''; out.push(bare.href); const bare2 = new URL(swap.href); bare2.search = ''; out.push(bare2.href); }
    }
  } catch (e) {}
  return out.filter((x, i) => out.indexOf(x) === i);
}
async function tryFetchImage(u, ua, ref, depth) {
  const r = await getRemote(u, 0, ua, ref);
  if (r.statusCode !== 200) { r.resume(); throw new Error('http ' + r.statusCode); }
  const ct = String(r.headers['content-type'] || '').toLowerCase();
  const len = parseInt(r.headers['content-length'] || '0', 10);
  if (len > IMG_MAX) { r.resume(); throw new Error('too big'); }
  const isHtml = /^(text\/html|application\/xhtml)/.test(ct);
  const got = await readLimited(r, isHtml ? 800 * 1024 : IMG_MAX);
  if (got.too && !isHtml) throw new Error('too big');
  const type = sniffImage(got.buf);
  if (type) return { buf: got.buf, ct: type };
  if (isHtml && depth < 1) {
    const next = imageFromHtml(got.buf.toString('utf8'), u);
    if (next && next !== u) return fetchImageAny(next, depth + 1);
  }
  throw new Error('not an image');
}
const EXTERNAL_PROXIES = [
  u => 'https://wsrv.nl/?n=-1&url=' + encodeURIComponent(u),
  u => 'https://images.weserv.nl/?n=-1&url=' + encodeURIComponent(u)
];
// перебор способов: прямые (разные User-Agent и referer, варианты ссылки), затем внешние прокси-кэши
async function fetchImageAny(raw, depth) {
  const target = normalizeImageUrl(raw);
  const variants = urlVariants(target);
  const profiles = [[UA_BROWSER, undefined], [UA_BROWSER, null], [UA_DISCORD, null], [UA_BOT, null]];
  const deadline = Date.now() + 35000;
  let lastErr = new Error('failed');
  const attempt = async (u, ua, ref, d) => {
    if (Date.now() > deadline) throw new Error('deadline');
    try { return await tryFetchImage(u, ua, ref, d); } catch (e) { lastErr = e; return null; }
  };
  let res = await attempt(variants[0], profiles[0][0], profiles[0][1], depth);
  if (res) return res;
  // сразу пробуем внешний прокси: для imgur и подобных, которые режут IP дата-центров, это самый надёжный путь
  if (depth === 0 && !/(^https?:\/\/(wsrv|images\.weserv)\.)/i.test(target)) {
    res = await attempt(EXTERNAL_PROXIES[0](target), UA_BROWSER, null, 1);
    if (res) return res;
  }
  for (let vi = 0; vi < variants.length; vi++) {
    for (let pi = 0; pi < profiles.length; pi++) {
      if (vi === 0 && pi === 0) continue;
      res = await attempt(variants[vi], profiles[pi][0], profiles[pi][1], depth);
      if (res) return res;
    }
  }
  if (depth === 0) {
    for (let i = 1; i < EXTERNAL_PROXIES.length; i++) {
      res = await attempt(EXTERNAL_PROXIES[i](target), UA_BROWSER, null, 1);
      if (res) return res;
    }
  }
  throw lastErr;
}

// ─── дисковый кэш: фото сохраняется, пока ссылка жива (Discord-ссылки протухают, imgur удаляет) ───
const IMG_CACHE_DIR = path.join(DATA_DIR, 'imgcache');
const IMG_CACHE_LIMIT = 600 * 1024 * 1024;
try { fs.mkdirSync(IMG_CACHE_DIR, { recursive: true }); } catch (e) { console.warn('imgcache dir:', e.message); }
const imgKey = u => crypto.createHash('sha1').update(u).digest('hex');
const imgInflight = new Map();
const imgFailAt = new Map();
function cacheRead(u) {
  try {
    const k = imgKey(u);
    const ct = fs.readFileSync(path.join(IMG_CACHE_DIR, k + '.ct'), 'utf8');
    const buf = fs.readFileSync(path.join(IMG_CACHE_DIR, k + '.img'));
    return buf.length ? { buf: buf, ct: ct } : null;
  } catch (e) { return null; }
}
function cacheWrite(u, img) {
  try {
    const k = imgKey(u);
    fs.writeFileSync(path.join(IMG_CACHE_DIR, k + '.img.tmp'), img.buf);
    fs.renameSync(path.join(IMG_CACHE_DIR, k + '.img.tmp'), path.join(IMG_CACHE_DIR, k + '.img'));
    fs.writeFileSync(path.join(IMG_CACHE_DIR, k + '.ct'), img.ct);
  } catch (e) { console.warn('imgcache write:', e.message); }
}
function pruneImgCache() {
  try {
    const files = fs.readdirSync(IMG_CACHE_DIR).filter(f => /\.img$/.test(f)).map(f => { const st = fs.statSync(path.join(IMG_CACHE_DIR, f)); return { f: f, size: st.size, t: st.atimeMs || st.mtimeMs }; });
    let total = files.reduce((a, x) => a + x.size, 0);
    files.sort((a, b) => a.t - b.t);
    for (const x of files) { if (total <= IMG_CACHE_LIMIT) break; total -= x.size; try { fs.unlinkSync(path.join(IMG_CACHE_DIR, x.f)); fs.unlinkSync(path.join(IMG_CACHE_DIR, x.f.replace(/\.img$/, '.ct'))); } catch (e) {} }
  } catch (e) {}
}
setInterval(pruneImgCache, 6 * 3600 * 1000).unref();
// отдаёт из кэша, а если там нет, качает (один запрос на одну ссылку одновременно) и кладёт в кэш
async function getImage(raw) {
  const hit = cacheRead(raw);
  if (hit) return hit;
  if (imgInflight.has(raw)) return imgInflight.get(raw);
  const p = fetchImageAny(raw, 0).then(img => { cacheWrite(raw, img); imgFailAt.delete(raw); return img; }).finally(() => imgInflight.delete(raw));
  imgInflight.set(raw, p);
  return p;
}
// прогрев: все фото из новостей, автопарка, недвижимости и дипломатии скачиваются на сервер сразу после сохранения
let warmTimer = null, warmBusy = false;
function scheduleWarm(delay) {
  if (warmTimer) return;
  warmTimer = setTimeout(() => { warmTimer = null; warmImages(); }, delay || 1500);
  if (warmTimer.unref) warmTimer.unref();
}
async function warmImages() {
  if (warmBusy || !state) return;
  warmBusy = true;
  try {
    const urls = [];
    CONTENT.forEach(c => (state[c] || []).forEach(it => {
      const u = it && it.image;
      if (typeof u === 'string' && /^https?:\/\//.test(u) && !/^https?:\/\/placehold\.co\//i.test(u) && urls.indexOf(u) === -1) urls.push(u);
    }));
    for (const u of urls) {
      if (cacheRead(u)) continue;
      const f = imgFailAt.get(u);
      if (f && Date.now() - f < 20 * 60 * 1000) continue;
      try { await getImage(u); } catch (e) { imgFailAt.set(u, Date.now()); console.warn('img warm failed:', u.slice(0, 100), '-', e.message); }
    }
  } finally { warmBusy = false; }
}
setInterval(() => scheduleWarm(10), 30 * 60 * 1000).unref();
setTimeout(() => scheduleWarm(10), 4000).unref();

async function imageProxy(req, res, url) {
  const fail = (code, msg) => { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(msg); };
  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(405, 'method');
  if (limited(req, 'img', 1200, 60 * 1000)) return fail(429, 'too many requests');
  let raw = String(url.searchParams.get('u') || '').trim();
  if (/^\/\//.test(raw)) raw = 'https:' + raw;
  if (!/^https?:\/\/[^\s"'<>`\\]{4,2000}$/.test(raw)) return fail(400, 'bad url');
  try {
    const img = await getImage(raw);
    res.writeHead(200, {
      'Content-Type': img.ct,
      'Content-Length': img.buf.length,
      'Cache-Control': 'public, max-age=604800',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'"
    });
    res.end(req.method === 'HEAD' ? undefined : img.buf);
  } catch (e) {
    console.warn('img proxy:', raw.slice(0, 120), '-', e.message);
    if (!res.headersSent) fail(502, 'fetch failed: ' + e.message); else res.destroy();
  }
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch (e) { res.writeHead(400); return res.end('Bad request'); }
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch (e) { res.writeHead(400); return res.end('Bad request'); }
  if (pathname.indexOf('\0') !== -1) { res.writeHead(400); return res.end('Bad request'); }

  if (pathname === '/api/img') return imageProxy(req, res, url);
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
  if (pathname === '/avatars/ph.svg') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=604800', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
    return res.end(placeholderSvg(url.searchParams));
  }
  const av = /^\/avatars\/(\d+\.jpg)$/.exec(pathname);
  if (av) {
    const f = path.join(DATA_DIR, 'avatars', av[1]);
    if (!fs.existsSync(f) && BOT_TOKEN) {
      const id = av[1].replace('.jpg', '');
      if (!avatarBusy['f' + id] && !(avatarMiss[id] && Date.now() - avatarMiss[id] < 10 * 60 * 1000)) {
        avatarBusy['f' + id] = true;
        const got = await fetchAvatar(id); delete avatarBusy['f' + id];
        if (got) { if (users[id]) applyAvatar(id, got); } else avatarMiss[id] = Date.now();
      }
    }
    return serveFile(req, res, f, 'public, max-age=3600');
  }
  const up = /^\/uploads\/([a-f0-9]{24}\.(?:jpg|png|gif|webp))$/.exec(pathname);
  if (up) return serveFile(req, res, path.join(DATA_DIR, 'uploads', up[1]), 'public, max-age=31536000, immutable');
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
