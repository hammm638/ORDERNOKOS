module.exports = {
  PORT: process.env.PORT || 3000,

  // Ditznesia
  DITZ_BASE: process.env.DITZ_BASE || 'https://www.ditznesia.com/api/dev',
  DITZ_KEY:  process.env.DITZ_KEY  || 'ae4674b4b4b9d22a91d8c2615a976ceb',

  // Bot Telegram (dipakai untuk memverifikasi ID user dari Mini App)
  BOT_TOKEN: process.env.BOT_TOKEN || '9228355451:AAGe6mmyvtBN-uO2nu-xSqkPwjD1V2vH-MI',

  // Database saldo di GitHub: https://github.com/<GH_OWNER>/<GH_REPO>/blob/<GH_BRANCH>/<GH_PATH>
  SALDO_FILE: process.env.SALDO_FILE || require('path').join(__dirname, 'saldo.json'),

  // true = order hanya boleh kalau saldo user di users.json > 0 dan tidak banned
  ORDER_GUARD: (process.env.ORDER_GUARD || 'true') !== 'false'
};
