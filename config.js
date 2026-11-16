// Semua nilai bisa diisi di sini ATAU lewat environment variable (lebih aman).
// Jangan pernah commit key/token asli ke GitHub.
const path = require('path');

module.exports = {
  PORT: process.env.PORT || 3000,

  // Ditznesia
  DITZ_BASE: process.env.DITZ_BASE || 'https://www.ditznesia.com/api/dev',
  DITZ_KEY:  process.env.DITZ_KEY  || 'ae4674b4b4b9d22a91d8c2615a976ceb',

  // Bot Telegram (verifikasi ID user dari Mini App + kirim notifikasi/broadcast)
  BOT_TOKEN: process.env.BOT_TOKEN || '9228355451:AAGe6mmyvtBN-uO2nu-xSqkPwjD1V2vH-MI',

  // ID Telegram admin (boleh banyak, pisahkan koma). Admin dapat tab "Admin" di Mini App.
  ADMIN_IDS: String(process.env.ADMIN_IDS || '7523570109').split(',').map(s => s.trim()).filter(Boolean),

  // File saldo user. Isi: { "ID_TELEGRAM": { "saldo": 1000, "banned": false, ... } }
  SALDO_FILE: process.env.SALDO_FILE || path.join(__dirname, 'saldo.json'),

  // Folder data tambahan (deposits.json, orders.json, activity.json). Default: satu folder dengan saldo.json
  DATA_DIR: process.env.DATA_DIR || '',

  // true = order hanya boleh kalau user terdaftar, tidak banned, dan saldo cukup
  ORDER_GUARD: (process.env.ORDER_GUARD || 'true') !== 'false',

  // true = saldo user otomatis dipotong sesuai harga order (dan dikembalikan kalau order batal/expired)
  AUTO_DEDUCT: (process.env.AUTO_DEDUCT || 'true') !== 'false',

  // true = admin boleh order tanpa saldo & tanpa dipotong
  ADMIN_FREE: (process.env.ADMIN_FREE || 'true') !== 'false',

  // true = Riwayat hanya menampilkan order milik user itu sendiri (admin lihat semua)
  PRIVATE_HISTORY: (process.env.PRIVATE_HISTORY || 'true') !== 'false',

  // Deposit
  MIN_DEPOSIT: Number(process.env.MIN_DEPOSIT || 1000),
  MAX_DEPOSIT: Number(process.env.MAX_DEPOSIT || 5000000),
  MAX_PENDING_DEPOSIT: Number(process.env.MAX_PENDING_DEPOSIT || 3),   // per user

  // true = kirim notifikasi Telegram ke user (deposit berhasil, saldo diubah admin)
  NOTIFY: (process.env.NOTIFY || 'true') !== 'false'
};
