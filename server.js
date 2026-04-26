require('dotenv').config();
const express = require('express');
const path = require('path');
const config = require('./config/harold');

const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Serve Harold audio files and any other static assets
app.use('/audio', express.static(path.join(__dirname, 'public', 'audio')));

// Routes
app.use('/voice', require('./routes/voice'));
app.use('/dashboard', require('./routes/dashboard'));

// Root redirect → dashboard
app.get('/', (req, res) => res.redirect('/dashboard'));

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
