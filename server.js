require('dotenv').config();
const express = require('express');
const compression = require('compression');
const path = require('path');
const fs = require('fs');
const config = require('./config/harold');
const db = require('./db');
const { makeToken } = require('./middleware/auth');

const app = express();

// gzip text responses (HTML, JSON, JS) — big win on the now-sizable dashboard/studio HTML
app.use(compression());

app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: '15mb' }));   // base64 image/audio payloads can exceed default 100kb

// Long-cache static media so browsers don't re-fetch on each dashboard render
const STATIC_MAX_AGE = '7d';

// Serve Harold audio files — AUDIO_DIR env var overrides the default for production
const audioDir = process.env.AUDIO_DIR || path.join(__dirname, 'public', 'audio');
app.use('/audio', express.static(audioDir, { maxAge: STATIC_MAX_AGE, immutable: false }));

// Reference photos & gallery: long cache (filenames change when content changes)
app.use('/harold-refs',    express.static(path.join(__dirname, 'public', 'harold-refs'),    { maxAge: STATIC_MAX_AGE }));
app.use('/harold-gallery', express.static(path.join(__dirname, 'public', 'harold-gallery'), { maxAge: STATIC_MAX_AGE }));

// Serve other static assets (favicon, etc.)
app.use(express.static(path.join(__dirname, 'public')));

// Login page
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'views', 'login.html')));

app.post('/login', (req, res) => {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return res.json({ ok: true });
  const submitted = (req.body || {}).password;
  if (!submitted || submitted !== password) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  const token   = makeToken(password);
  const maxAge  = 7 * 24 * 60 * 60; // 7 days in seconds
  const secure  = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `harold_auth=${token}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax${secure}`);
  res.json({ ok: true });
});

app.get('/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'harold_auth=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax');
  res.redirect('/login');
});

// Routes
app.use('/voice', require('./routes/voice'));
app.use('/dashboard', require('./routes/dashboard'));
app.use('/studio', require('./routes/studio'));

// Health check for Railway
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Generate phone ring tone for studio videos (once, on first boot)
const ringPath = path.join(__dirname, 'public', 'audio', 'ring.mp3');
if (!fs.existsSync(ringPath)) {
  const { execFile: _execFile } = require('child_process');
  _execFile('ffmpeg', [
    '-f', 'lavfi',
    '-i', 'aevalsrc=0.25*sin(2*PI*440*t)+0.25*sin(2*PI*480*t):c=stereo:s=44100',
    '-t', '1.8',
    '-af', 'afade=t=in:st=0:d=0.1,afade=t=out:st=1.4:d=0.4',
    '-y', ringPath,
  ], (err) => {
    if (err) console.warn('Could not generate ring.mp3:', err.message);
    else console.log('Generated ring.mp3');
  });
}

// Public stats — aggregate call counts only, no sensitive data
app.get('/api/stats', (req, res) => {
  try {
    res.json(db.stats());
  } catch (err) {
    res.status(500).json({ error: 'unavailable' });
  }
});

// Public landing page
app.get('/', (req, res) => {
  const template = fs.readFileSync(path.join(__dirname, 'views', 'landing.html'), 'utf8');

  const raw = config.phoneNumber || '';
  const digits = raw.replace(/\D/g, '');
  const phoneDisplay = digits.length === 11 && digits.startsWith('1')
    ? `(${digits.slice(1,4)}) ${digits.slice(4,7)}-${digits.slice(7)}`
    : raw;

  const haroldPhoto = process.env.HAROLD_PHOTO_URL
    ? `<img src="${process.env.HAROLD_PHOTO_URL}" alt="Harold" width="360" height="360">`
    : '🐱';

  const ig = config.haroldInstagram;
  const tt = config.haroldTikTok;
  const igSlug = ig ? ig.replace(/\s+/g, '').replace(/^@/, '') : '';
  const ttSlug = tt ? tt.replace(/\s+/g, '').replace(/^@/, '') : '';
  const igGlyph = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="vertical-align:middle;flex-shrink:0"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none"/></svg>`;
  const ttGlyph = `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:middle;flex-shrink:0"><path d="M16.5 3c.4 2.4 1.9 4 4.5 4.3v3.1c-1.6.1-3.1-.3-4.5-1.1v6.6c0 4-3.3 6.4-6.5 6.1-3-.3-5.4-2.7-5.5-5.7-.1-3.1 2.4-5.7 5.5-5.9.5 0 1 0 1.5.1v3.2c-.5-.2-1-.3-1.5-.3-1.5.1-2.7 1.3-2.7 2.8 0 1.5 1.2 2.8 2.7 2.8 1.5 0 2.7-1.2 2.7-2.8V3h3.8z"/></svg>`;
  const socialParts = [];
  if (ig) socialParts.push(`<a href="https://www.instagram.com/${igSlug}" target="_blank" rel="noopener">${igGlyph} @${igSlug}</a>`);
  if (ig && tt) socialParts.push(`<span class="social-star">★</span>`);
  if (tt) socialParts.push(`<a href="https://www.tiktok.com/@${ttSlug}" target="_blank" rel="noopener">${ttGlyph} @${ttSlug}</a>`);
  const socialsHtml = socialParts.length ? `<div class="socials-bar">${socialParts.join('')}</div>` : '';

  const baseUrl   = config.baseUrl || `https://haroldshotline.com`;
  const ogImage   = process.env.OG_IMAGE_URL || process.env.HAROLD_PHOTO_URL || '';

  const html = template
    .replace('{{BASE_URL}}',     baseUrl)
    .replace(/\{\{OG_IMAGE_URL\}\}/g, ogImage)
    .replace('{{HAROLD_PHOTO}}', haroldPhoto)
    .replace('{{PHONE_RAW}}',    raw)
    .replace('{{PHONE_DISPLAY}}', phoneDisplay)
    .replace('{{SOCIALS}}',      socialsHtml);

  res.type('text/html').send(html);
});

// Return a TwiML error response so Twilio logs something useful instead of a blank 500
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  const twilio = require('twilio');
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say('An internal error occurred. Please try again later.');
  res.status(500).type('text/xml').send(twiml.toString());
});

process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

app.listen(config.port, () => {
  console.log(`\nHarold's Hotline is running on port ${config.port}`);
  console.log(`Dashboard: ${config.baseUrl || `http://localhost:${config.port}`}/dashboard\n`);
  if (!config.accountSid || !config.authToken) {
    console.warn('⚠  TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set — voice routes will not work.');
  }
  if (!config.baseUrl) {
    console.warn('⚠  BASE_URL not set — Twilio cannot reach your webhooks.');
  }
});
