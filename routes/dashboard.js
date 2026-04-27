const express = require('express');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');
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

module.exports = router;
