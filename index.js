// AI Image + Video Telegram Bot
// 3-day free trial, then Rs 20/month (UPI screenshot -> admin approves)
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const http = require('http');

const TOKEN = process.env.BOT_TOKEN;
const ADMIN = Number(process.env.ADMIN_ID);
const UPI = process.env.UPI_ID || 'yourupi@bank';
const REPLICATE = process.env.REPLICATE_API_TOKEN; // needed only for video
const VIDEO_MODEL = process.env.VIDEO_MODEL || 'minimax/video-01';
const IMG_LIMIT = 30, VID_LIMIT = 3; // per day
const DAY = 86400000;

if (!TOKEN) { console.error('BOT_TOKEN missing'); process.exit(1); }

// ---------- tiny storage (db.json) ----------
const DB = 'db.json';
let db = {};
try { db = JSON.parse(fs.readFileSync(DB)); } catch {}
const save = () => fs.writeFileSync(DB, JSON.stringify(db));
function getUser(id) {
  if (!db[id]) { db[id] = { start: Date.now(), paidUntil: 0, day: '', img: 0, vid: 0 }; save(); }
  const u = db[id], today = new Date().toDateString();
  if (u.day !== today) { u.day = today; u.img = 0; u.vid = 0; save(); }
  return u;
}
const isActive = u => Date.now() < u.start + 3 * DAY || Date.now() < u.paidUntil;
const daysLeft = u => Math.max(0, Math.ceil((Math.max(u.start + 3 * DAY, u.paidUntil) - Date.now()) / DAY));

// ---------- generators ----------
async function makeImage(prompt) {
  const seed = Math.floor(Math.random() * 1e9);
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&seed=${seed}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('image failed');
  return Buffer.from(await r.arrayBuffer());
}

async function makeVideo(prompt) {
  if (!REPLICATE) throw new Error('Video abhi setup nahi hai (REPLICATE_API_TOKEN missing).');
  const H = { Authorization: `Bearer ${REPLICATE}`, 'Content-Type': 'application/json' };
  let p = await (await fetch(`https://api.replicate.com/v1/models/${VIDEO_MODEL}/predictions`, {
    method: 'POST', headers: { ...H, Prefer: 'wait=60' }, body: JSON.stringify({ input: { prompt } })
  })).json();
  while (p.status && !['succeeded', 'failed', 'canceled'].includes(p.status)) {
    await new Promise(s => setTimeout(s, 4000));
    p = await (await fetch(p.urls.get, { headers: H })).json();
  }
  if (p.status !== 'succeeded') throw new Error(p.error || 'video failed');
  return Array.isArray(p.output) ? p.output[0] : p.output;
}

// ---------- bot ----------
const bot = new TelegramBot(TOKEN, { polling: true });
const menu = { reply_markup: { keyboard: [['🎨 Image', '🎬 Video'], ['💎 Subscribe', '📊 My Plan']], resize_keyboard: true } };
const waiting = {}; // chatId -> 'image' | 'video'

bot.onText(/^\/start/, msg => {
  const u = getUser(msg.from.id);
  bot.sendMessage(msg.chat.id,
    `Namaste ${msg.from.first_name}! 👋\nMain AI image aur video banata hu.\n\n🎁 3 din free trial (${daysLeft(u)} din baaki)\nuske baad sirf Rs 20/month.\n\nSeedha likho: kya banana hai? Ya neeche button dabao.`, menu);
});

bot.onText(/^\/image (.+)/, (m, x) => generate(m, 'image', x[1]));
bot.onText(/^\/video (.+)/, (m, x) => generate(m, 'video', x[1]));
bot.onText(/^(💎 Subscribe|\/subscribe)/, m => bot.sendMessage(m.chat.id,
  `💎 Rs 20 / 30 din\n\n1) UPI se Rs 20 bhejo: ${UPI}\n2) Payment ka screenshot yahi bhej do\n3) Admin approve karega, plan turant chalu.`));
bot.onText(/^(📊 My Plan|\/plan)/, m => {
  const u = getUser(m.from.id);
  bot.sendMessage(m.chat.id, isActive(u)
    ? `✅ Plan active: ${daysLeft(u)} din baaki\nAaj: images ${u.img}/${IMG_LIMIT}, videos ${u.vid}/${VID_LIMIT}`
    : '❌ Plan khatam. 💎 Subscribe dabao.');
});
bot.onText(/^🎨 Image/, m => { waiting[m.chat.id] = 'image'; bot.sendMessage(m.chat.id, 'Image ka description likho:'); });
bot.onText(/^🎬 Video/, m => { waiting[m.chat.id] = 'video'; bot.sendMessage(m.chat.id, 'Video ka description likho:'); });

bot.on('message', msg => {
  if (msg.photo) return paymentProof(msg);
  const t = msg.text || '';
  if (!t || t.startsWith('/') || /^(🎨|🎬|💎|📊)/.test(t)) return;
  generate(msg, waiting[msg.chat.id] || 'image', t);
  delete waiting[msg.chat.id];
});

async function generate(msg, type, prompt) {
  const id = msg.from.id, chat = msg.chat.id, u = getUser(id);
  if (!isActive(u)) return bot.sendMessage(chat, '⏰ Trial/plan khatam. 💎 Subscribe dabao (Rs 20/month).');
  if (type === 'image' && u.img >= IMG_LIMIT) return bot.sendMessage(chat, 'Aaj ki image limit khatam. Kal aao!');
  if (type === 'video' && u.vid >= VID_LIMIT) return bot.sendMessage(chat, 'Aaj ki video limit khatam. Kal aao!');
  const wait = await bot.sendMessage(chat, type === 'image' ? '🎨 Ban rahi hai...' : '🎬 Video ban rahi hai (1-2 min lagte hain)...');
  try {
    if (type === 'image') {
      const buf = await makeImage(prompt);
      await bot.sendPhoto(chat, buf, { caption: `✨ ${prompt.slice(0, 150)}` });
      u.img++;
    } else {
      const url = await makeVideo(prompt);
      await bot.sendVideo(chat, url, { caption: `🎬 ${prompt.slice(0, 150)}` });
      u.vid++;
    }
    save();
  } catch (e) {
    bot.sendMessage(chat, `⚠️ Nahi bana: ${e.message}`);
  }
  bot.deleteMessage(chat, wait.message_id).catch(() => {});
}

// ---------- payment approval ----------
async function paymentProof(msg) {
  const fileId = msg.photo[msg.photo.length - 1].file_id, uid = msg.from.id;
  await bot.sendPhoto(ADMIN, fileId, {
    caption: `Payment request\n${msg.from.first_name} (@${msg.from.username || '-'})\nID: ${uid}`,
    reply_markup: { inline_keyboard: [[
      { text: '✅ Approve 30 din', callback_data: `ok_${uid}` },
      { text: '❌ Reject', callback_data: `no_${uid}` }]] }
  });
  bot.sendMessage(msg.chat.id, '📨 Screenshot admin ko bhej diya. Approve hote hi plan chalu ho jayega.');
}

bot.on('callback_query', async q => {
  if (q.from.id !== ADMIN) return bot.answerCallbackQuery(q.id);
  const [act, uid] = q.data.split('_');
  const u = getUser(uid);
  if (act === 'ok') {
    u.paidUntil = Math.max(Date.now(), u.paidUntil) + 30 * DAY; save();
    bot.sendMessage(uid, '🎉 Payment approved! Plan 30 din ke liye chalu.');
  } else {
    bot.sendMessage(uid, '❌ Payment verify nahi hua. Sahi screenshot dobara bhejo.');
  }
  bot.answerCallbackQuery(q.id, { text: act === 'ok' ? 'Approved' : 'Rejected' });
  bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch(() => {});
});

// Render needs an open port
http.createServer((_, r) => r.end('Bot running')).listen(process.env.PORT || 3000);
console.log('Bot started');
