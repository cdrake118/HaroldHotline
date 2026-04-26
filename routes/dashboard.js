const express = require('express');
const path = require('path');
const fetch = require('node-fetch');
const config = require('../config/harold');
const db = require('../db');

const router = express.Router();

// ── Dashboard page ────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'views', 'dashboard.html'));
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
