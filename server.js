require('dotenv').config();
const express = require('express');
const path = require('path');
const config = require('./config/harold');

const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Serve Harold audio files — AUDIO_DIR env var overrides the default for production
const audioDir = process.env.AUDIO_DIR || path.join(__dirname, 'public', 'audio');
app.use('/audio', express.static(audioDir));

// Routes
app.use('/voice', require('./routes/voice'));
app.use('/dashboard', require('./routes/dashboard'));

// Root redirect → dashboard
app.get('/', (req, res) => res.redirect('/dashboard'));

// Return a TwiML error response so Twilio logs something useful instead of a blank 500
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  const twilio = require('twilio');
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say('An internal error occurred. Please try again later.');
  res.status(500).type('text/xml').send(twiml.toString());
});

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
