require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const config = require('./config/harold');

const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Serve Harold audio files — AUDIO_DIR env var overrides the default for production
const audioDir = process.env.AUDIO_DIR || path.join(__dirname, 'public', 'audio');
app.use('/audio', express.static(audioDir));

// Serve other static assets (images, etc.)
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.use('/voice', require('./routes/voice'));
app.use('/dashboard', require('./routes/dashboard'));

// Health check for Railway
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Public landing page
app.get('/', (req, res) => {
  const template = fs.readFileSync(path.join(__dirname, 'views', 'landing.html'), 'utf8');

  const raw = config.phoneNumber || '';
  const digits = raw.replace(/\D/g, '');
  const phoneDisplay = digits.length === 11 && digits.startsWith('1')
    ? `(${digits.slice(1,4)}) ${digits.slice(4,7)}-${digits.slice(7)}`
    : raw;

  const haroldPhoto = process.env.HAROLD_PHOTO_URL
    ? `<img src="${process.env.HAROLD_PHOTO_URL}" alt="Harold">`
    : '🐱';

  const ig = config.haroldInstagram;
  const tt = config.haroldTikTok;
  const igSlug = ig ? ig.replace(/\s+/g, '') : '';
  const ttSlug = tt ? tt.replace(/\s+/g, '') : '';
  const socialsHtml = (ig || tt) ? `
    <div class="socials">
      ${ig ? `<a class="social-btn" href="https://www.instagram.com/${igSlug}" target="_blank" rel="noopener">📸 Instagram</a>` : ''}
      ${tt ? `<a class="social-btn" href="https://www.tiktok.com/@${ttSlug}" target="_blank" rel="noopener">🎵 TikTok</a>` : ''}
    </div>` : '';

  const html = template
    .replace('{{HAROLD_PHOTO}}', haroldPhoto)
    .replace('{{PHONE_RAW}}', raw)
    .replace('{{PHONE_DISPLAY}}', phoneDisplay)
    .replace('{{SOCIALS}}', socialsHtml);

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
