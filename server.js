// Mini App server (Node.js 18+, tanpa dependency). Jalankan: node server.js
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

const SALDO_FILE = C.SALDO_FILE || path.join(__dirname, 'saldo.json');

const missing = v => !v || String(v).startsWith('ISI_');
if (missing(KEY) || missing(BOT)) {
  console.error('Isi DITZ_KEY dan BOT_TOKEN di config.js (atau environment variable).');
  process.exit(1);
}

// Endpoint yang boleh diteruskan ke Ditznesia
const OK = new Set([
  '/profile', '/countries', '/services', '/operators', '/order', '/order-multi', '/status', '/resend',
  '/reactivate', '/cancel', '/request-code', '/history',
  '/mail-domains', '/mail-rent', '/gmail-stock', '/gmail-order', '/mail-orders',
  '/smm-platforms', '/smm-services', '/smm-order', '/smm-orders',
  '/tg-countries', '/tg-buy', '/shopee-countries', '/shopee-buy', '/shopee-code', '/shopee-orders',
  '/otpwa-services', '/otpwa-buy', '/otpwa-orders', '/otpwa-code', '/otpwa-cancel', '/otpwa-confirm',
  '/tp-games', '/tp-products', '/tp-check', '/tp-order', '/tp-orders'
]);

// Endpoint yang memakai saldo (dijaga oleh ORDER_GUARD)
const SPEND = new Set([
  '/order', '/order-multi', '/reactivate', '/mail-rent', '/gmail-order', '/smm-order',
  '/tg-buy', '/shopee-buy', '/otpwa-buy', '/tp-order'
]);

// ===== Verifikasi initData Telegram (ID user TIDAK bisa dipalsukan) =====
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

const json = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
};

// ===== Baca saldo.json (lokal). Dibaca ulang otomatis kalau file berubah =====
let cache = { users: null, mtime: 0 };

function getUsers() {
  let st;
  try { st = fs.statSync(SALDO_FILE); }
  catch { throw new Error('File saldo tidak ditemukan: ' + SALDO_FILE); }
  if (!cache.users || st.mtimeMs !== cache.mtime) {
    try { cache = { users: JSON.parse(fs.readFileSync(SALDO_FILE, 'utf8') || '{}'), mtime: st.mtimeMs }; }
    catch (e) {
      if (cache.users) return cache.users; // file sedang ditulis bot: pakai data terakhir yang valid
      throw new Error('saldo.json bukan JSON yang valid: ' + e.message);
    }
  }
  return cache.users;
}

// Dukung dua bentuk: { "id": { saldo, banned, ... } } atau { "id": 5000 }
function normalize(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number') return { saldo: raw };
  return raw;
}

// Cari user berdasarkan ID Telegram. Siapa pun boleh membuka; tidak ada daftar ID yang diizinkan.
async function lookup(tgUser) {
  const users = getUsers();
  const row = normalize(users[String(tgUser.id)]);
  return { found: !!row, row: row || null };
}

async function proxyDitz(ep, params) {
  const t = new URL(BASE + ep);
  for (const [k, v] of params) if (k !== 'path' && k !== 'apikey') t.searchParams.set(k, v);
  t.searchParams.set('apikey', KEY);
  const r = await fetch(t);
  return { status: r.status, text: await r.text() };
}

const INDEX = path.join(__dirname, 'public', 'index.html');

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');

  if (u.pathname === '/' || u.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(fs.readFileSync(INDEX));
  }
  if (u.pathname !== '/api/proxy') return json(res, 404, { detail: 'Tidak ditemukan' });

  const ep = u.searchParams.get('path');
  if (!OK.has(ep)) return json(res, 404, { detail: 'Endpoint tidak diizinkan' });

  const user = verify(req.headers['x-init-data'] || '');
  if (!user) return json(res, 401, { detail: 'Buka lewat Telegram Mini App' });

  // ============ /profile: ID dari Telegram -> saldo dari users.json di GitHub ============
  if (ep === '/profile') {
    try {
      const { found, row } = await lookup(user);
      const tgName = [user.first_name, user.last_name].filter(Boolean).join(' ');
      if (row && row.banned) return json(res, 403, { detail: 'Akun diblokir', banned: true, id: user.id });
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
        joinedAt: row ? row.joinedAt : null
      });
    } catch (e) {
      console.error('[profile]', e.message);
      return json(res, 503, { detail: DEBUG ? 'DEBUG: ' + e.message : 'Saldo belum bisa dimuat, coba lagi' }); // TIDAK fallback ke saldo Ditznesia
    }
  }

  // ============ Penjaga order ============
  if (C.ORDER_GUARD && SPEND.has(ep)) {
    try {
      const { row } = await lookup(user);
      if (!row) return json(res, 403, { detail: 'Akun belum terdaftar. Buka bot dan kirim /start dulu.' });
      if (row.banned) return json(res, 403, { detail: 'Akun diblokir' });
      if (!(Number(row.saldo) > 0)) return json(res, 402, { detail: 'Saldo tidak cukup. Silakan deposit di bot.' });
    } catch (e) {
      console.error('[guard]', e.message);
      return json(res, 503, { detail: 'Saldo belum bisa diverifikasi, coba lagi' });
    }
  }

  // ============ Endpoint lain: proxy ke Ditznesia ============
  try {
    const r = await proxyDitz(ep, u.searchParams);
    res.writeHead(r.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(r.text);
  } catch (e) {
    json(res, 502, { detail: 'Server tidak merespons' });
  }
}).listen(PORT, () => {
  try { console.log('[SALDO OK] ' + SALDO_FILE + ' terbaca, ' + Object.keys(getUsers()).length + ' user'); }
  catch (e) { console.error('[SALDO GAGAL] ' + e.message); }
  console.log('Mini App jalan di port ' + PORT + (DEBUG ? ' | DEBUG ON' : ''));
});
