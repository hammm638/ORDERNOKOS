// Mini App server (Node.js 18+, tanpa dependency). Jalankan: node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const C = require('./config');
const PORT = process.env.PORT || C.PORT || 3000;
const BASE = C.DITZ_BASE || 'https://www.ditznesia.com/api/dev';
const KEY = C.DITZ_KEY;
const BOT = C.BOT_TOKEN;
const ALLOW = (C.ALLOWED_IDS || []).map(String).filter(x => /^\d+$/.test(x));
if (!KEY || KEY.startsWith('ISI_') || !BOT || BOT.startsWith('ISI_')) { console.error('Isi DITZ_KEY dan BOT_TOKEN di config.js'); process.exit(1); }

const OK = new Set([
  '/profile', '/countries', '/services', '/operators', '/order', '/order-multi', '/status', '/resend',
  '/reactivate', '/cancel', '/request-code', '/history',
  '/mail-domains', '/mail-rent', '/gmail-stock', '/gmail-order', '/mail-orders',
  '/smm-platforms', '/smm-services', '/smm-order', '/smm-orders',
  '/tg-countries', '/tg-buy', '/shopee-countries', '/shopee-buy', '/shopee-code', '/shopee-orders',
  '/otpwa-services', '/otpwa-buy', '/otpwa-orders', '/otpwa-code', '/otpwa-cancel', '/otpwa-confirm',
  '/tp-games', '/tp-products', '/tp-check', '/tp-order', '/tp-orders'
]);

function verify(init) {
  const p = new URLSearchParams(init);
  const hash = p.get('hash');
  if (!hash) return null;
  p.delete('hash');
  const data = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT).digest();
  const calc = crypto.createHmac('sha256', secret).update(data).digest('hex');
  if (calc !== hash) return null;
  if (Date.now() / 1000 - Number(p.get('auth_date') || 0) > 86400) return null;
  try { return JSON.parse(p.get('user')); } catch { return null; }
}

const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/' || u.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
  }
  if (u.pathname !== '/api/proxy') return json(res, 404, { detail: 'Tidak ditemukan' });

  const ep = u.searchParams.get('path');
  if (!OK.has(ep)) return json(res, 404, { detail: 'Endpoint tidak diizinkan' });
  const user = verify(req.headers['x-init-data'] || '');
  if (!user) return json(res, 401, { detail: 'Buka lewat Telegram Mini App' });
  if (ALLOW.length && !ALLOW.includes(String(user.id))) return json(res, 403, { detail: 'Akses ditolak' });

  const t = new URL(BASE + ep);
  for (const [k, v] of u.searchParams) if (k !== 'path' && k !== 'apikey') t.searchParams.set(k, v);
  t.searchParams.set('apikey', KEY);
  try {
    const r = await fetch(t);
    res.writeHead(r.status, { 'content-type': 'application/json' });
    res.end(await r.text());
  } catch (e) { json(res, 502, { detail: 'Server tidak merespons' }); }
}).listen(PORT, () => console.log('Mini App jalan di port ' + PORT));
