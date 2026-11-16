// Nokos Mini App server (Node.js 18+, tanpa dependency). Jalankan: node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

if (typeof fetch !== 'function') {
  console.error('Node.js kamu ' + process.version + ' terlalu lama. Butuh Node 18 ke atas (fetch bawaan).');
  process.exit(1);
}
const C = require('./config');
const DEBUG = String(process.env.DEBUG || C.DEBUG || '') === 'true';
const PORT = C.PORT;
const BASE = C.DITZ_BASE;
const KEY = C.DITZ_KEY;
const BOT = C.BOT_TOKEN;
const ADMINS = new Set((C.ADMIN_IDS || []).map(String));

const SALDO_FILE = C.SALDO_FILE || path.join(__dirname, 'saldo.json');
const DATA_DIR = C.DATA_DIR || path.dirname(SALDO_FILE);
const DEP_FILE = path.join(DATA_DIR, 'deposits.json');
const ORD_FILE = path.join(DATA_DIR, 'orders.json');
const LOG_FILE = path.join(DATA_DIR, 'activity.json');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}

const missing = v => !v || String(v).startsWith('ISI_');
if (missing(KEY) || missing(BOT)) {
  console.error('Isi DITZ_KEY dan BOT_TOKEN di config.js (atau environment variable).');
  process.exit(1);
}

// ============================================================
//  Daftar endpoint
// ============================================================
const OK = new Set([
  '/profile', '/countries', '/services', '/operators', '/order', '/order-multi', '/status', '/resend',
  '/reactivate', '/cancel', '/request-code', '/history',
  '/mail-domains', '/mail-rent', '/gmail-stock', '/gmail-order', '/mail-orders',
  '/smm-platforms', '/smm-services', '/smm-order', '/smm-orders',
  '/tg-countries', '/tg-buy', '/shopee-countries', '/shopee-buy', '/shopee-code', '/shopee-orders',
  '/otpwa-services', '/otpwa-buy', '/otpwa-orders', '/otpwa-code', '/otpwa-cancel', '/otpwa-confirm',
  '/tp-games', '/tp-products', '/tp-check', '/tp-order', '/tp-orders',
  // deposit (ditangani server, bukan proxy mentah)
  '/deposit/create', '/deposit/status', '/deposit/cancel', '/deposit/history'
]);

// Endpoint yang memakai saldo (dijaga ORDER_GUARD + dipotong AUTO_DEDUCT)
const SPEND = new Set([
  '/order', '/order-multi', '/reactivate', '/mail-rent', '/gmail-order', '/smm-order',
  '/tg-buy', '/shopee-buy', '/otpwa-buy', '/tp-order'
]);

// Endpoint daftar order (difilter per user + dipakai untuk refund otomatis)
const HIST = new Set(['/history', '/smm-orders', '/tp-orders', '/mail-orders', '/otpwa-orders', '/shopee-orders']);
// Endpoint yang statusnya bisa dicek lewat /status (untuk sapu refund di background)
const STATUS_EPS = new Set(['/order', '/order-multi', '/reactivate', '/tg-buy', '/mail-rent']);

const BAD_RE = /cancel|expire|refund|batal|fail|timeout|gagal|kadaluarsa/i;

// ============================================================
//  Util
// ============================================================
const rp = n => 'Rp ' + Number(n || 0).toLocaleString('id-ID');
const num = v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
const nowISO = () => new Date().toISOString();
const isAdmin = u => !!u && ADMINS.has(String(u.id));

const json = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
};

function readBody(req, max = 20000) {
  return new Promise((ok, no) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > max) { no(new Error('Body terlalu besar')); req.destroy(); } });
    req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { no(new Error('JSON tidak valid')); } });
    req.on('error', no);
  });
}

// ============================================================
//  Penyimpanan JSON (atomic write: tulis ke .tmp lalu rename)
// ============================================================
function readJSON(file, def) {
  try {
    const t = fs.readFileSync(file, 'utf8');
    return t.trim() ? JSON.parse(t) : def;
  } catch (e) {
    if (e.code === 'ENOENT') return def;
    throw e;
  }
}
function writeJSON(file, obj) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

// ---- saldo.json (dipakai bersama bot, jadi selalu baca ulang sebelum menulis) ----
let uCache = { users: null, mtime: 0 };
function getUsers() {
  let st;
  try { st = fs.statSync(SALDO_FILE); }
  catch { throw new Error('File saldo tidak ditemukan: ' + SALDO_FILE); }
  if (!uCache.users || st.mtimeMs !== uCache.mtime) {
    try { uCache = { users: JSON.parse(fs.readFileSync(SALDO_FILE, 'utf8') || '{}'), mtime: st.mtimeMs }; }
    catch (e) {
      if (uCache.users) return uCache.users; // file sedang ditulis bot: pakai data terakhir yang valid
      throw new Error('saldo.json bukan JSON yang valid: ' + e.message);
    }
  }
  return uCache.users;
}
const normalize = raw => raw == null ? null : (typeof raw === 'number' ? { saldo: raw } : raw);

async function lookup(tgUser) {
  const row = normalize(getUsers()[String(tgUser.id)]);
  return { found: !!row, row: row || null };
}

// Ubah satu user secara atomik. init = data user baru kalau belum ada (null = jangan buat baru)
function mutateUser(id, fn, init) {
  let users;
  try { users = JSON.parse(fs.readFileSync(SALDO_FILE, 'utf8') || '{}'); }
  catch (e) { throw new Error('saldo.json tidak bisa dibaca: ' + e.message); }
  const key = String(id);
  const raw = users[key];
  const wasNum = typeof raw === 'number';
  let row = raw == null ? null : (wasNum ? { id: Number(id), saldo: raw } : raw);
  if (!row) {
    if (!init) return null;
    row = { id: Number(id), name: init.name || '', username: init.username || '', saldo: 0, banned: false,
      joinedAt: nowISO(), totalDeposit: 0, totalOrder: 0, totalSpent: 0 };
  }
  const out = fn(row);
  users[key] = (wasNum && Object.keys(row).every(k => k === 'id' || k === 'saldo')) ? row.saldo : row;
  writeJSON(SALDO_FILE, users);
  return { row, out };
}

// ---- log aktivitas ----
function logAct(by, act, target, detail) {
  try {
    const l = readJSON(LOG_FILE, []);
    l.push({ t: nowISO(), by: String(by), act, target: target == null ? '' : String(target), detail: detail || '' });
    writeJSON(LOG_FILE, l.slice(-500));
  } catch (e) { console.error('[log]', e.message); }
}

// ============================================================
//  Telegram (notifikasi / broadcast)
// ============================================================
async function tgSend(chatId, text) {
  if (!C.NOTIFY) return false;
  try {
    const r = await fetch('https://api.telegram.org/bot' + BOT + '/sendMessage', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15000)
    });
    return r.ok;
  } catch (e) { return false; }
}

// ============================================================
//  Verifikasi initData Telegram (ID user TIDAK bisa dipalsukan)
// ============================================================
function verify(init) {
  const p = new URLSearchParams(init);
  const hash = p.get('hash');
  if (!hash) return null;
  p.delete('hash');
  const data = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT).digest();
  const calc = crypto.createHmac('sha256', secret).update(data).digest('hex');
  const a = Buffer.from(calc), b = Buffer.from(hash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Date.now() / 1000 - Number(p.get('auth_date') || 0) > 86400) return null;
  try { return JSON.parse(p.get('user')); } catch { return null; }
}

// ============================================================
//  Ditznesia
// ============================================================
async function ditz(ep, params) {
  const t = new URL(BASE + ep);
  const entries = params instanceof URLSearchParams ? [...params.entries()] : Object.entries(params || {});
  for (const [k, v] of entries) if (k !== 'path' && k !== 'apikey') t.searchParams.set(k, v);
  t.searchParams.set('apikey', KEY);
  const r = await fetch(t, { signal: AbortSignal.timeout(30000) });
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) {}
  return { status: r.status, text, data };
}

// ============================================================
//  DEPOSIT
// ============================================================
const DEP_FIELDS = ['status', 'nominal', 'total_bayar', 'total_diterima', 'trx_id', 'qr_link', 'created_at',
  'expires_at_ms', 'cashback_code', 'cashback_amount'];

const pubDep = d => ({
  id: d.id, nominal: d.nominal, total_bayar: d.total_bayar, total_diterima: d.total_diterima, trx_id: d.trx_id,
  qr_link: d.qr_link, status: d.status, created_at: d.created_at, expires_at_ms: d.expires_at_ms,
  cashback_code: d.cashback_code || null, cashback_amount: d.cashback_amount || 0, credited: !!d.credited, uid: d.uid
});

// Tambahkan saldo dari deposit yang berhasil. Hanya sekali (flag credited disimpan DULU sebelum saldo diubah).
function creditDeposit(deps, dep) {
  if (dep.credited) return 0;
  const amount = num(dep.total_diterima) || num(dep.nominal);
  if (!amount) return 0;
  dep.credited = true; dep.credited_at = nowISO();
  writeJSON(DEP_FILE, deps);
  try {
    mutateUser(dep.uid, row => {
      row.saldo = (Number(row.saldo) || 0) + amount;
      row.totalDeposit = (Number(row.totalDeposit) || 0) + amount;
    }, { name: dep.name, username: dep.username });
  } catch (e) {
    dep.credited = false; delete dep.credited_at; writeJSON(DEP_FILE, deps);
    throw e;
  }
  logAct('system', 'deposit_ok', dep.uid, rp(amount) + ' · ' + dep.id);
  tgSend(dep.uid, 'Deposit berhasil. Saldo bertambah ' + rp(amount) + '.');
  return amount;
}

// Terapkan data Ditznesia ke catatan lokal (baca ulang file setelah await supaya aman)
function applyDeposit(id, d) {
  const deps = readJSON(DEP_FILE, {});
  const dep = deps[id];
  if (!dep) return null;
  if (d && typeof d === 'object') for (const f of DEP_FIELDS) if (d[f] !== undefined) dep[f] = d[f];
  let credited = 0;
  if (dep.status === 'berhasil' && !dep.credited) credited = creditDeposit(deps, dep);
  else writeJSON(DEP_FILE, deps);
  return { dep, credited };
}

const pendingOf = (deps, uid) => Object.values(deps).filter(d => String(d.uid) === String(uid) && d.status === 'pending');
const lastCreate = new Map();

async function depositRoute(ep, u, user, res) {
  const admin = isAdmin(user);
  const id = u.searchParams.get('id');

  if (ep === '/deposit/create') {
    const { row } = await lookup(user);
    if (row && row.banned) return json(res, 403, { detail: 'Akun diblokir' });
    const nominal = Math.floor(Number(u.searchParams.get('nominal')));
    if (!(nominal >= C.MIN_DEPOSIT && nominal <= C.MAX_DEPOSIT))
      return json(res, 400, { detail: 'Nominal deposit ' + rp(C.MIN_DEPOSIT) + ' – ' + rp(C.MAX_DEPOSIT) });
    if (Date.now() - (lastCreate.get(user.id) || 0) < 4000) return json(res, 429, { detail: 'Terlalu cepat, coba lagi sebentar' });
    lastCreate.set(user.id, Date.now());
    if (pendingOf(readJSON(DEP_FILE, {}), user.id).length >= C.MAX_PENDING_DEPOSIT)
      return json(res, 429, { detail: 'Masih ada ' + C.MAX_PENDING_DEPOSIT + ' deposit menunggu. Selesaikan atau batalkan dulu.' });

    const r = await ditz('/deposit/create', { nominal });
    if (r.status !== 200 || !r.data || !r.data.id) {
      console.error('[deposit/create]', r.status, r.text.slice(0, 200));
      if (r.status === 401 || r.status === 403) return json(res, 502, { detail: 'Layanan deposit belum siap' });
      return json(res, r.status === 200 ? 502 : r.status, { detail: (r.data && r.data.detail) || 'Gagal membuat deposit' });
    }
    const deps = readJSON(DEP_FILE, {});
    const dep = { uid: user.id, name: [user.first_name, user.last_name].filter(Boolean).join(' '),
      username: user.username || '', credited: false, local_at: nowISO() };
    for (const f of ['id', ...DEP_FIELDS]) if (r.data[f] !== undefined) dep[f] = r.data[f];
    if (!dep.status) dep.status = 'pending';
    deps[dep.id] = dep;
    writeJSON(DEP_FILE, deps);
    logAct(user.id, 'deposit_create', user.id, rp(dep.nominal) + ' · ' + dep.id);
    return json(res, 200, pubDep(dep));
  }

  if (ep === '/deposit/history') {
    const deps = Object.values(readJSON(DEP_FILE, {}));
    const st = u.searchParams.get('status');
    const limit = Math.min(50, Math.max(1, Number(u.searchParams.get('limit')) || 20));
    const mine = deps.filter(d => String(d.uid) === String(user.id) && (!st || d.status === st));
    mine.sort((a, b) => String(b.local_at).localeCompare(String(a.local_at)));
    return json(res, 200, mine.slice(0, limit).map(pubDep));
  }

  // status & cancel butuh id milik sendiri
  const dep = id ? readJSON(DEP_FILE, {})[id] : null;
  if (!dep || (String(dep.uid) !== String(user.id) && !admin)) return json(res, 404, { detail: 'Deposit tidak ditemukan' });

  if (ep === '/deposit/status') {
    if (dep.status !== 'pending') return json(res, 200, pubDep(dep));
    const r = await ditz('/deposit/status', { id });
    if (r.status !== 200 || !r.data) return json(res, 200, pubDep(dep)); // Ditznesia lagi gangguan: tampilkan data terakhir
    const out = applyDeposit(id, r.data);
    return json(res, 200, pubDep(out ? out.dep : dep));
  }

  if (ep === '/deposit/cancel') {
    if (dep.status !== 'pending') return json(res, 400, { detail: 'Deposit sudah ' + dep.status });
    const r = await ditz('/deposit/cancel', { id });
    if (r.status !== 200 || !r.data) return json(res, r.status === 200 ? 502 : r.status, { detail: (r.data && r.data.detail) || 'Gagal membatalkan' });
    const out = applyDeposit(id, r.data);
    logAct(user.id, 'deposit_cancel', dep.uid, dep.id);
    return json(res, 200, pubDep(out ? out.dep : dep));
  }
}

// Cek deposit pending di background supaya saldo masuk walau Mini App sudah ditutup
let pollBusy = false;
async function pollDeposits() {
  if (pollBusy) return;
  pollBusy = true;
  try {
    const deps = Object.values(readJSON(DEP_FILE, {})).filter(d => d.status === 'pending').slice(0, 20);
    for (const d of deps) {
      try {
        const r = await ditz('/deposit/status', { id: d.id });
        if (r.status === 200 && r.data) {
          const out = applyDeposit(d.id, r.data);
          if (out && out.dep.status === 'pending' && Date.now() > (Number(out.dep.expires_at_ms) || 0) + 15 * 60 * 1000) {
            applyDeposit(d.id, { status: 'kadaluarsa' });
          }
        }
      } catch (e) { console.error('[poll deposit]', e.message); }
    }
  } finally { pollBusy = false; }
}

// ============================================================
//  ORDER: potong saldo, refund, filter riwayat
// ============================================================
const costOf = o => (!o || typeof o !== 'object') ? 0 :
  num(o.total) || num(o.total_price) || num(o.total_harga) || num(o.price) || num(o.harga) || num(o.cost) || num(o.amount);

function extractOrders(data, params) {
  let items = [];
  if (Array.isArray(data)) items = data.map(o => ({ id: o && o.id, cost: costOf(o) }));
  else if (data && Array.isArray(data.orders)) {
    items = data.orders.map(o => ({ id: o && o.id, cost: costOf(o) }));
    if (items.length && items.every(i => !i.cost) && num(data.total)) items[0].cost = num(data.total);
  } else if (data && typeof data === 'object') items = [{ id: data.id, cost: costOf(data) }];
  if (items.length === 1 && !items[0].cost && num(params.get('price'))) items[0].cost = num(params.get('price'));
  return items;
}

function chargeUser(user, ep, items) {
  const total = items.reduce((s, i) => s + i.cost, 0);
  if (!total) { logAct('system', 'cost_unknown', user.id, ep); return 0; }
  const ord = readJSON(ORD_FILE, {});
  let overdraft = false;
  mutateUser(user.id, row => {
    const s = Number(row.saldo) || 0;
    overdraft = s < total;
    row.saldo = Math.max(0, s - total);
    row.totalOrder = (Number(row.totalOrder) || 0) + items.length;
    row.totalSpent = (Number(row.totalSpent) || 0) + total;
  }, { name: [user.first_name, user.last_name].filter(Boolean).join(' '), username: user.username || '' });
  for (const i of items) {
    if (i.id == null) continue;
    ord[String(i.id)] = { id: String(i.id), uid: user.id, ep, cost: i.cost, t: Date.now(), refunded: false, done: false };
  }
  writeJSON(ORD_FILE, ord);
  if (overdraft) logAct('system', 'overdraft', user.id, ep + ' ' + rp(total));
  return total;
}

const hasOtp = d => !!(d && d.otp && d.otp !== 'Waiting') || !!(d && d.code && String(d.code).length > 0);

function maybeRefund(d) {
  if (!d || typeof d !== 'object' || d.id == null) return;
  const ord = readJSON(ORD_FILE, {});
  const L = ord[String(d.id)];
  if (!L) return;
  if (hasOtp(d)) { if (!L.done) { L.done = true; writeJSON(ORD_FILE, ord); } return; }
  if (L.refunded || !L.cost || !BAD_RE.test(String(d.status || ''))) return;
  L.refunded = true; L.done = true;
  writeJSON(ORD_FILE, ord);
  try {
    mutateUser(L.uid, row => {
      row.saldo = (Number(row.saldo) || 0) + L.cost;
      row.totalSpent = Math.max(0, (Number(row.totalSpent) || 0) - L.cost);
      row.totalOrder = Math.max(0, (Number(row.totalOrder) || 0) - 1);
    });
    logAct('system', 'refund', L.uid, rp(L.cost) + ' · ' + L.id);
    tgSend(L.uid, 'Order dibatalkan/kedaluwarsa. Saldo dikembalikan ' + rp(L.cost) + '.');
  } catch (e) {
    L.refunded = false; writeJSON(ORD_FILE, ord);
    console.error('[refund]', e.message);
  }
}

// Sapu refund di background untuk order nomor yang kedaluwarsa saat user tidak membuka app
let sweepBusy = false;
async function sweepOrders() {
  if (sweepBusy) return;
  sweepBusy = true;
  try {
    const ord = readJSON(ORD_FILE, {});
    const now = Date.now();
    const list = Object.values(ord).filter(o => !o.done && !o.refunded && STATUS_EPS.has(o.ep) && now - o.t > 60 * 1000).slice(0, 15);
    for (const o of list) {
      if (now - o.t > 3 * 3600 * 1000) { // sudah terlalu lama, anggap selesai
        const cur = readJSON(ORD_FILE, {}); if (cur[o.id]) { cur[o.id].done = true; writeJSON(ORD_FILE, cur); }
        continue;
      }
      try {
        const r = await ditz('/status', { id: o.id });
        if (r.status === 200 && r.data) maybeRefund(r.data);
      } catch (e) {}
    }
    // bersihkan ledger > 60 hari
    const cur = readJSON(ORD_FILE, {});
    let ch = false;
    for (const k of Object.keys(cur)) if (now - cur[k].t > 60 * 86400 * 1000) { delete cur[k]; ch = true; }
    if (ch) writeJSON(ORD_FILE, cur);
  } catch (e) { console.error('[sweep]', e.message); }
  finally { sweepBusy = false; }
}

const inFlight = new Set();

// ============================================================
//  ADMIN
// ============================================================
const userView = (id, raw) => {
  const r = normalize(raw) || {};
  return { id: String(id), name: r.name || '', username: r.username || '', saldo: Number(r.saldo) || 0,
    banned: !!r.banned, totalDeposit: Number(r.totalDeposit) || 0, totalOrder: Number(r.totalOrder) || 0,
    totalSpent: Number(r.totalSpent) || 0, joinedAt: r.joinedAt || null };
};
const wibDay = ms => new Date(ms + 7 * 3600 * 1000).toISOString().slice(0, 10);
let bc = { running: false, total: 0, sent: 0, failed: 0, startedAt: null };

async function adminRoute(req, res, user) {
  let b;
  try { b = await readBody(req); } catch (e) { return json(res, 400, { detail: e.message }); }
  const a = String(b.action || '');
  const me = user.id;
  const idOf = () => { const s = String(b.id || '').trim(); if (!/^\d{4,15}$/.test(s)) throw new Error('ID Telegram tidak valid'); return s; };
  const amt = () => { const n = Math.floor(Number(b.amount)); if (!(n > 0) || n > 1e10) throw new Error('Nominal tidak valid'); return n; };
  const note = () => String(b.note || '').slice(0, 120);

  try {
    if (a === 'stats') {
      const users = getUsers();
      const rows = Object.entries(users).map(([i, r]) => userView(i, r));
      const deps = Object.values(readJSON(DEP_FILE, {}));
      const ord = Object.values(readJSON(ORD_FILE, {}));
      const today = wibDay(Date.now());
      const okDep = deps.filter(d => d.credited);
      const todayDep = okDep.filter(d => d.credited_at && wibDay(Date.parse(d.credited_at)) === today);
      const todayOrd = ord.filter(o => wibDay(o.t) === today && !o.refunded);
      return json(res, 200, {
        users: rows.length,
        banned: rows.filter(r => r.banned).length,
        totalSaldo: rows.reduce((s, r) => s + r.saldo, 0),
        totalDeposit: okDep.reduce((s, d) => s + (num(d.total_diterima) || num(d.nominal)), 0),
        depositToday: todayDep.reduce((s, d) => s + (num(d.total_diterima) || num(d.nominal)), 0),
        depositTodayCount: todayDep.length,
        pendingDeposit: deps.filter(d => d.status === 'pending').length,
        orderToday: todayOrd.length,
        spentToday: todayOrd.reduce((s, o) => s + o.cost, 0),
        orderTotal: ord.length,
        broadcast: bc
      });
    }

    if (a === 'api') {
      const r = await ditz('/profile', {});
      if (r.status !== 200 || !r.data) return json(res, 502, { detail: (r.data && r.data.detail) || 'Ditznesia tidak merespons' });
      return json(res, 200, { name: r.data.name, email: r.data.email, balance: r.data.balance });
    }

    if (a === 'users') {
      const q = String(b.q || '').trim().toLowerCase();
      let rows = Object.entries(getUsers()).map(([i, r]) => userView(i, r));
      if (q) rows = rows.filter(r => (r.id + ' ' + r.name + ' ' + r.username).toLowerCase().includes(q));
      if (b.filter === 'banned') rows = rows.filter(r => r.banned);
      const sort = b.sort || 'saldo';
      rows.sort(sort === 'new' ? (x, y) => String(y.joinedAt || '').localeCompare(String(x.joinedAt || ''))
        : sort === 'deposit' ? (x, y) => y.totalDeposit - x.totalDeposit
        : sort === 'order' ? (x, y) => y.totalOrder - x.totalOrder
        : (x, y) => y.saldo - x.saldo);
      const off = Math.max(0, Number(b.offset) || 0), lim = Math.min(100, Math.max(1, Number(b.limit) || 30));
      return json(res, 200, { total: rows.length, items: rows.slice(off, off + lim) });
    }

    if (a === 'user') {
      const id = idOf();
      const raw = getUsers()[id];
      const deps = Object.values(readJSON(DEP_FILE, {})).filter(d => String(d.uid) === id)
        .sort((x, y) => String(y.local_at).localeCompare(String(x.local_at))).slice(0, 10).map(pubDep);
      const ords = Object.values(readJSON(ORD_FILE, {})).filter(o => String(o.uid) === id)
        .sort((x, y) => y.t - x.t).slice(0, 10);
      return json(res, 200, { found: raw != null, user: userView(id, raw), isAdmin: ADMINS.has(id), deposits: deps, orders: ords });
    }

    if (a === 'addsaldo' || a === 'subsaldo' || a === 'setsaldo') {
      const id = idOf();
      const n = a === 'setsaldo' ? Math.floor(Number(b.amount)) : amt();
      if (a === 'setsaldo' && !(n >= 0 && n <= 1e10)) throw new Error('Nominal tidak valid');
      let before = 0, after = 0;
      mutateUser(id, row => {
        before = Number(row.saldo) || 0;
        after = a === 'addsaldo' ? before + n : a === 'subsaldo' ? Math.max(0, before - n) : n;
        row.saldo = after;
      }, {});
      logAct(me, a, id, rp(before) + ' -> ' + rp(after) + (note() ? ' · ' + note() : ''));
      if (b.notify !== false) {
        const d = after - before;
        if (d > 0) tgSend(id, 'Saldo kamu bertambah ' + rp(d) + '. Saldo sekarang ' + rp(after) + '.' + (note() ? '\nCatatan: ' + note() : ''));
        else if (d < 0) tgSend(id, 'Saldo kamu dikurangi ' + rp(-d) + '. Saldo sekarang ' + rp(after) + '.' + (note() ? '\nCatatan: ' + note() : ''));
      }
      return json(res, 200, { ok: true, before, after });
    }

    if (a === 'ban' || a === 'unban') {
      const id = idOf();
      if (a === 'ban' && ADMINS.has(id)) throw new Error('Admin tidak bisa diblokir');
      const rr = mutateUser(id, row => { row.banned = a === 'ban'; }, {});
      logAct(me, a, id, note());
      if (a === 'unban') tgSend(id, 'Akun kamu sudah dibuka blokirnya.');
      return json(res, 200, { ok: true, banned: !!rr.row.banned });
    }

    if (a === 'message') {
      const id = idOf();
      const t = String(b.text || '').trim();
      if (!t || t.length > 3500) throw new Error('Pesan kosong atau terlalu panjang');
      const ok = await tgSend(id, t);
      logAct(me, 'message', id, ok ? 'terkirim' : 'gagal');
      return json(res, 200, { ok });
    }

    if (a === 'broadcast') {
      const t = String(b.text || '').trim();
      if (!t || t.length > 3500) throw new Error('Pesan kosong atau terlalu panjang');
      if (bc.running) throw new Error('Broadcast sebelumnya masih berjalan');
      const ids = Object.entries(getUsers()).filter(([, r]) => !(normalize(r) || {}).banned).map(([i]) => i);
      bc = { running: true, total: ids.length, sent: 0, failed: 0, startedAt: nowISO() };
      logAct(me, 'broadcast', '', ids.length + ' user · ' + t.slice(0, 60));
      (async () => {
        for (const id of ids) {
          (await tgSend(id, t)) ? bc.sent++ : bc.failed++;
          await new Promise(r => setTimeout(r, 50));
        }
        bc.running = false;
      })();
      return json(res, 200, { ok: true, total: ids.length });
    }

    if (a === 'deposits') {
      let deps = Object.values(readJSON(DEP_FILE, {}));
      if (b.status) deps = deps.filter(d => d.status === b.status);
      deps.sort((x, y) => String(y.local_at).localeCompare(String(x.local_at)));
      return json(res, 200, deps.slice(0, 50).map(d => ({ ...pubDep(d), name: d.name, username: d.username })));
    }

    if (a === 'dep_check' || a === 'dep_cancel') {
      const id = String(b.id || '');
      const dep = readJSON(DEP_FILE, {})[id];
      if (!dep) throw new Error('Deposit tidak ditemukan');
      const r = await ditz(a === 'dep_check' ? '/deposit/status' : '/deposit/cancel', { id });
      if (r.status !== 200 || !r.data) throw new Error((r.data && r.data.detail) || 'Ditznesia tidak merespons');
      const out = applyDeposit(id, r.data);
      logAct(me, a, dep.uid, id);
      return json(res, 200, { ...pubDep(out.dep), credited_now: out.credited });
    }

    if (a === 'orders') {
      const list = Object.values(readJSON(ORD_FILE, {})).sort((x, y) => y.t - x.t).slice(0, 50);
      return json(res, 200, list);
    }

    if (a === 'logs') {
      return json(res, 200, readJSON(LOG_FILE, []).slice(-60).reverse());
    }

    return json(res, 400, { detail: 'Aksi tidak dikenal' });
  } catch (e) {
    return json(res, 400, { detail: e.message });
  }
}

// ============================================================
//  HTTP
// ============================================================
const INDEX = path.join(__dirname, 'public', 'index.html');

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');

  if (u.pathname === '/' || u.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(fs.readFileSync(INDEX));
  }
  if (u.pathname === '/healthz') return json(res, 200, { ok: true });

  // ---------- Admin ----------
  if (u.pathname === '/api/admin') {
    if (req.method !== 'POST') return json(res, 405, { detail: 'Gunakan POST' });
    const user = verify(req.headers['x-init-data'] || '');
    if (!user) return json(res, 401, { detail: 'Buka lewat Telegram Mini App' });
    if (!isAdmin(user)) return json(res, 403, { detail: 'Khusus admin' });
    return adminRoute(req, res, user);
  }

  if (u.pathname !== '/api/proxy') return json(res, 404, { detail: 'Tidak ditemukan' });

  const ep = u.searchParams.get('path');
  if (!OK.has(ep)) return json(res, 404, { detail: 'Endpoint tidak diizinkan' });

  const user = verify(req.headers['x-init-data'] || '');
  if (!user) return json(res, 401, { detail: 'Buka lewat Telegram Mini App' });
  const admin = isAdmin(user);

  try {
    // ============ /profile: ID dari Telegram -> saldo dari saldo.json ============
    if (ep === '/profile') {
      try {
        const { found, row } = await lookup(user);
        const tgName = [user.first_name, user.last_name].filter(Boolean).join(' ');
        if (row && row.banned && !admin) return json(res, 403, { detail: 'Akun diblokir', banned: true, id: user.id });
        const pend = pendingOf(readJSON(DEP_FILE, {}), user.id).length;
        return json(res, 200, {
          id: user.id,
          found,
          name: tgName || (row && row.name) || user.username || 'User',
          username: user.username || (row && row.username) || '',
          balance: row ? Number(row.saldo) || 0 : 0,
          totalDeposit: row ? row.totalDeposit || 0 : 0,
          totalOrder: row ? row.totalOrder || 0 : 0,
          totalSpent: row ? row.totalSpent || 0 : 0,
          banned: false,
          joinedAt: row ? row.joinedAt : null,
          isAdmin: admin,
          pendingDeposit: pend,
          minDeposit: C.MIN_DEPOSIT,
          maxDeposit: C.MAX_DEPOSIT
        });
      } catch (e) {
        console.error('[profile]', e.message);
        return json(res, 503, { detail: DEBUG ? 'DEBUG: ' + e.message : 'Saldo belum bisa dimuat, coba lagi' });
      }
    }

    // ============ Deposit ============
    if (ep.startsWith('/deposit/')) return await depositRoute(ep, u, user, res);

    // ============ Penjaga order ============
    const spending = SPEND.has(ep);
    const free = admin && C.ADMIN_FREE;
    if (spending && !free) {
      if (inFlight.has(user.id)) return json(res, 429, { detail: 'Masih ada order yang diproses, tunggu sebentar' });
      if (C.ORDER_GUARD) {
        try {
          const { row } = await lookup(user);
          if (!row) return json(res, 403, { detail: 'Akun belum terdaftar. Buka bot dan kirim /start dulu.' });
          if (row.banned) return json(res, 403, { detail: 'Akun diblokir' });
          const s = Number(row.saldo) || 0;
          if (!(s > 0)) return json(res, 402, { detail: 'Saldo tidak cukup. Silakan deposit.' });
          const need = num(u.searchParams.get('price'));
          if (need && s < need) return json(res, 402, { detail: 'Saldo tidak cukup. Butuh ' + rp(need) + ', saldo kamu ' + rp(s) + '.' });
        } catch (e) {
          console.error('[guard]', e.message);
          return json(res, 503, { detail: 'Saldo belum bisa diverifikasi, coba lagi' });
        }
      }
    }

    // Kepemilikan order: /status, /cancel, dll hanya untuk pemilik (kalau tercatat di ledger)
    const oid = u.searchParams.get('id');
    if (oid && !admin && C.PRIVATE_HISTORY && ['/status', '/resend', '/cancel', '/request-code', '/otpwa-code', '/otpwa-cancel', '/otpwa-confirm', '/shopee-code'].includes(ep)) {
      const L = readJSON(ORD_FILE, {})[String(oid)];
      if (L && String(L.uid) !== String(user.id)) return json(res, 403, { detail: 'Order ini bukan milikmu' });
    }

    // ============ Teruskan ke Ditznesia ============
    const lock = spending && !free;
    if (lock) inFlight.add(user.id);
    let r;
    try { r = await ditz(ep, u.searchParams); }
    finally { if (lock) inFlight.delete(user.id); }

    // Potong saldo kalau order sukses
    if (spending && !free && C.AUTO_DEDUCT && r.status === 200 && r.data && !r.data.detail && !r.data.error) {
      try { chargeUser(user, ep, extractOrders(r.data, u.searchParams)); }
      catch (e) { console.error('[charge]', e.message); logAct('system', 'charge_fail', user.id, ep + ' ' + e.message); }
    }

    // Refund otomatis + filter riwayat
    if (r.status === 200 && r.data) {
      try {
        if (Array.isArray(r.data)) r.data.forEach(maybeRefund); else maybeRefund(r.data);
        if (HIST.has(ep) && Array.isArray(r.data) && !admin && C.PRIVATE_HISTORY) {
          const ord = readJSON(ORD_FILE, {});
          r.data = r.data.filter(o => o && o.id != null && ord[String(o.id)] && String(ord[String(o.id)].uid) === String(user.id));
          r.text = JSON.stringify(r.data);
        }
      } catch (e) { console.error('[post]', e.message); }
    }

    res.writeHead(r.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(r.text);
  } catch (e) {
    console.error('[proxy]', ep, e.message);
    json(res, 502, { detail: 'Server tidak merespons' });
  }
}).listen(PORT, () => {
  try { console.log('[SALDO OK] ' + SALDO_FILE + ' terbaca, ' + Object.keys(getUsers()).length + ' user'); }
  catch (e) { console.error('[SALDO GAGAL] ' + e.message); }
  console.log('Admin: ' + [...ADMINS].join(', ') + ' | Data: ' + DATA_DIR);
  console.log('Mini App jalan di port ' + PORT + (DEBUG ? ' | DEBUG ON' : ''));
  setInterval(pollDeposits, 20000);
  setInterval(sweepOrders, 60000);
});

process.on('unhandledRejection', e => console.error('[unhandledRejection]', e && e.message || e));
process.on('uncaughtException', e => console.error('[uncaughtException]', e && e.message || e));
