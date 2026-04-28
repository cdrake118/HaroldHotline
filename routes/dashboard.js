const express = require('express');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');
const { OpenAI } = require('openai');
const config = require('../config/harold');
const db = require('../db');

const router = express.Router();

// ── Dashboard page ────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'views', 'dashboard.html'));
});

// ── Diagnostics ──────────────────────────────────────────────────────────────
router.get('/api/debug', (req, res) => {
  const audioDir = process.env.AUDIO_DIR || path.join(__dirname, '..', 'public', 'audio');
  let audioFiles = [];
  try { audioFiles = fs.readdirSync(audioDir); } catch (e) { audioFiles = [`ERROR: ${e.message}`]; }

  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'harold.db');
  let dbExists = false;
  try { dbExists = fs.existsSync(dbPath); } catch (e) {}

  res.json({
    audioDir,
    audioFiles,
    dbPath,
    dbExists,
    env: {
      BASE_URL: process.env.BASE_URL || '(not set)',
      AUDIO_DIR: process.env.AUDIO_DIR || '(not set — using default)',
      DB_PATH: process.env.DB_PATH || '(not set — using default)',
      HOLD_MUSIC_URL: process.env.HOLD_MUSIC_URL || '(not set)',
      HAROLD_MEOWING_SHORT_URL: process.env.HAROLD_MEOWING_SHORT_URL || '(not set)',
      HAROLD_MEOWING_LONG_URL: process.env.HAROLD_MEOWING_LONG_URL || '(not set)',
      PORT: process.env.PORT || '(not set)',
    },
  });
});

// ── Admin auth ────────────────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return next();

  const auth = req.headers.authorization || '';
  if (auth.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString();
    const pass = decoded.slice(decoded.indexOf(':') + 1);
    if (pass === password) return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="Harold Admin"');
  res.status(401).json({ error: 'Authentication required' });
}

// ── REST API ──────────────────────────────────────────────────────────────────

router.get('/api/stats', (req, res) => {
  res.json(db.stats());
});

router.get('/api/calls', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  const offset = parseInt(req.query.offset || '0', 10);
  const calls = db.listCalls(limit, offset);
  const total = db.countCalls();
  res.json({ calls, total, limit, offset });
});

router.get('/api/calls/:id', (req, res) => {
  const call = db.getCallById(parseInt(req.params.id, 10));
  if (!call) return res.status(404).json({ error: 'Not found' });
  res.json(call);
});

// Proxy Twilio recording audio so the browser doesn't need Twilio credentials
router.get('/api/calls/:id/recording', async (req, res) => {
  const call = db.getCallById(parseInt(req.params.id, 10));
  if (!call || !call.recording_sid) {
    return res.status(404).json({ error: 'No recording for this call' });
  }

  const audioUrl =
    `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}` +
    `/Recordings/${call.recording_sid}.mp3`;

  const credentials = Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64');

  try {
    const upstream = await fetch(audioUrl, {
      headers: { Authorization: `Basic ${credentials}` },
    });
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: 'Failed to fetch recording from Twilio' });
    }
    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'private, max-age=3600');
    upstream.body.pipe(res);
  } catch (err) {
    console.error('Recording proxy error:', err);
    res.status(500).json({ error: 'Internal error fetching recording' });
  }
});

// ── Voiceover generator ───────────────────────────────────────────────────────
router.post('/api/voiceover', adminAuth, async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({ error: 'OPENAI_API_KEY is not configured' });
  }
  const { text, voice = 'fable', model = 'tts-1-hd' } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'Text is required' });

  const allowedVoices = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
  const allowedModels = ['tts-1', 'tts-1-hd'];
  if (!allowedVoices.includes(voice)) return res.status(400).json({ error: 'Invalid voice' });
  if (!allowedModels.includes(model)) return res.status(400).json({ error: 'Invalid model' });

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const mp3 = await openai.audio.speech.create({ model, voice, input: text.trim() });
    const buffer = Buffer.from(await mp3.arrayBuffer());
    res.set('Content-Type', 'audio/mpeg');
    res.set('Content-Disposition', 'attachment; filename="harold-voiceover.mp3"');
    res.send(buffer);
  } catch (err) {
    console.error('Voiceover error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate voiceover' });
  }
});

// ── Generate social post ──────────────────────────────────────────────────────
const TYPE_LABELS = {
  confession: 'confession',
  question:   'advice request',
  speak:      'message',
};

router.post('/api/calls/:id/generate-post', adminAuth, async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({ error: 'OPENAI_API_KEY is not configured' });
  }
  const call = db.getCallById(parseInt(req.params.id, 10));
  if (!call) return res.status(404).json({ error: 'Not found' });
  if (!call.transcript) return res.status(400).json({ error: 'No transcript available for this call' });

  const typeLabel = TYPE_LABELS[call.call_type] || 'message';
  const prompt =
    `You are the social media manager for Harold's Hotline — a phone hotline where people call to talk to Harold, a very judgmental tabby cat. Harold cannot speak; he only meows.\n\n` +
    `A caller left the following ${typeLabel}:\n"${call.transcript}"\n\n` +
    `Write a short, charming, and funny Instagram/TikTok caption about this. Rules:\n` +
    `- Keep it under 150 words\n` +
    `- If the caller used their real name, replace it with "a caller" or "someone"\n` +
    `- Write from the perspective of Harold's social media team\n` +
    `- Include Harold's implied cat reaction (unimpressed, napping, mildly judgmental)\n` +
    `- End with 3-5 hashtags including #HaroldsHotline and #HaroldTheCat`;

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 300,
    });
    res.json({ post: completion.choices[0].message.content });
  } catch (err) {
    console.error('Generate post error:', err);
    res.status(500).json({ error: 'Failed to generate post' });
  }
});

// ── Admin actions ─────────────────────────────────────────────────────────────

router.patch('/api/calls/:id/flag', adminAuth, (req, res) => {
  const call = db.getCallById(parseInt(req.params.id, 10));
  if (!call) return res.status(404).json({ error: 'Not found' });
  const newFlagged = call.flagged ? 0 : 1;
  db.flagCall(call.id, newFlagged);
  res.json({ flagged: newFlagged });
});

router.delete('/api/calls/:id/recording', adminAuth, async (req, res) => {
  const call = db.getCallById(parseInt(req.params.id, 10));
  if (!call) return res.status(404).json({ error: 'Not found' });
  if (!call.recording_sid) return res.status(404).json({ error: 'No recording for this call' });

  const url =
    `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}` +
    `/Recordings/${call.recording_sid}`;
  const credentials = Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64');

  try {
    const upstream = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Basic ${credentials}` },
    });
    if (!upstream.ok && upstream.status !== 404) {
      return res.status(502).json({ error: 'Failed to delete recording from Twilio' });
    }
  } catch (err) {
    console.error('Twilio recording delete error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }

  db.clearRecording(call.id);
  res.json({ success: true });
});

module.exports = router;
