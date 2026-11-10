'use strict';
/**
 * Backend del sito di compleanno di Loris.
 *  - serve il frontend statico (public/)
 *  - /api/config      configurazione pubblica (senza il contenuto del regalo)
 *  - /api/gallery     elenco foto in public/img/gallery
 *  - /api/scores      classifica del gioco
 *  - /api/wishes      messaggi di auguri degli amici
 *  - /api/game/complete  rilascia un token firmato quando il gioco e' finito
 *  - /api/gift        il contenuto del regalo, restituito SOLO se lo sblocco e' valido
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const config = require('./config.json');
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PREVIEW_KEY = process.env.PREVIEW_KEY || ''; // ?preview=KEY salta i blocchi del regalo (per testarlo)

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------- piccolo "database" su file JSON ---------- */
function readJson(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8')); }
  catch { return fallback; }
}
function writeJson(name, data) {
  const file = path.join(DATA_DIR, name);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

/* ---------- segreto per firmare i token ---------- */
function getSecret() {
  if (process.env.SECRET) return process.env.SECRET;
  const f = path.join(DATA_DIR, 'secret.txt');
  try { return fs.readFileSync(f, 'utf8').trim(); }
  catch {
    const s = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(f, s);
    return s;
  }
}
const SECRET = getSecret();
const sign = (payload) => crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');

function makeToken(extra) {
  const payload = Buffer.from(JSON.stringify({ t: Date.now(), ...extra })).toString('base64url');
  return payload + '.' + sign(payload);
}
function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const good = sign(payload);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
}

/* ---------- rate limit minimale (per IP e per rotta) ---------- */
const hits = new Map();
function limit(name, max, windowMs) {
  return (req, res, next) => {
    const key = name + ':' + (req.ip || 'x');
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) return res.status(429).json({ error: 'Troppe richieste, riprova tra poco.' });
    arr.push(now);
    hits.set(key, arr);
    next();
  };
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some((t) => now - t < 3600e3)) hits.delete(k); }, 600e3).unref();

const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/* ---------- app ---------- */
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

const unlockAtMs = () => Date.parse(config.gift.unlockAt);

app.get('/api/config', (req, res) => {
  const { gift, ...rest } = config;
  res.json({
    ...rest,
    gift: { unlock: gift.unlock, unlockAt: gift.unlockAt },
    serverTime: Date.now(),
  });
});

app.get('/api/gallery', (req, res) => {
  const dir = path.join(PUBLIC_DIR, 'img', 'gallery');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /\.(jpe?g|png|webp|gif|avif)$/i.test(f)).sort(); } catch { /* vuota */ }
  const captions = (config.gallery && config.gallery.captions) || {};
  res.json(files.map((f) => ({ src: '/img/gallery/' + encodeURIComponent(f), caption: captions[f] || '' })));
});

/* --- classifica --- */
app.get('/api/scores', (req, res) => {
  const scores = readJson('scores.json', []);
  res.json(scores.slice(0, 10));
});
app.post('/api/scores', limit('scores', 5, 60e3), (req, res) => {
  const name = clean(req.body && req.body.name, 12) || 'Anonimo';
  const score = Math.floor(Number(req.body && req.body.score));
  if (!Number.isFinite(score) || score < 0 || score > 5_000_000) return res.status(400).json({ error: 'Punteggio non valido' });
  const scores = readJson('scores.json', []);
  scores.push({ name, score, date: new Date().toISOString() });
  scores.sort((a, b) => b.score - a.score);
  writeJson('scores.json', scores.slice(0, 50));
  res.json(scores.slice(0, 10));
});

/* --- auguri degli amici --- */
app.get('/api/wishes', (req, res) => {
  res.json(readJson('wishes.json', []).slice(-100).reverse());
});
app.post('/api/wishes', limit('wishes', 3, 60e3), (req, res) => {
  const name = clean(req.body && req.body.name, 30);
  const message = clean(req.body && req.body.message, 300);
  if (!name || !message) return res.status(400).json({ error: 'Scrivi nome e messaggio' });
  const wishes = readJson('wishes.json', []);
  wishes.push({ name, message, date: new Date().toISOString() });
  writeJson('wishes.json', wishes.slice(-500));
  res.json({ ok: true });
});

/* --- fine gioco: token firmato --- */
app.post('/api/game/complete', limit('complete', 10, 60e3), (req, res) => {
  const score = Math.max(0, Math.floor(Number(req.body && req.body.score) || 0));
  res.json({ token: makeToken({ done: true, score }) });
});

/* --- regalo --- */
app.get('/api/gift', limit('gift', 60, 60e3), (req, res) => {
  const g = config.gift;
  const dateOk = Date.now() >= unlockAtMs();
  const tok = verifyToken(req.get('x-game-token'));
  const gameOk = !!(tok && tok.done);
  const preview = PREVIEW_KEY && req.query.preview === PREVIEW_KEY;

  let open;
  switch (g.unlock) {
    case 'date': open = dateOk; break;
    case 'game': open = gameOk; break;
    case 'either': open = dateOk || gameOk; break;
    default: open = dateOk && gameOk;
  }
  if (!open && !preview) {
    return res.json({ status: 'locked', dateOk, gameOk, unlock: g.unlock, unlockAt: g.unlockAt, serverTime: Date.now() });
  }
  res.json({
    status: 'open',
    gift: { title: g.title, text: g.text, image: g.image, linkLabel: g.linkLabel, linkUrl: g.linkUrl },
  });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Non trovato' }));

app.use(express.static(PUBLIC_DIR, { extensions: ['html'], maxAge: '1h' }));

app.listen(PORT, () => console.log(`Sito di compleanno su http://localhost:${PORT}`));