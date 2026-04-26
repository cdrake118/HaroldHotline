# Harold's Hotline 🐱📞

A real phone hotline for Harold the cat. People call in, choose to leave a
confession or "speak" to Harold directly, hear his meows, and all calls are
logged to a dashboard with recordings and transcripts.

## How it works

```
Caller dials in
  └─ rings → automated greeting → IVR menu
       ├─ Press 1 (Confession)
       │    └─ "Please hold…" → hold music → Harold meowing
       │         → "Leave your confession, press 1 when done"
       │         → recording starts → caller presses 1
       │         → "Thank you, Harold will review your confession…"
       │
       └─ Press 2 (Speak to Harold)
            └─ "[Excuse why Harold is a moment]" → hold music
                 → Harold meowing (10s, fades out)
                 → "[Excuse why Harold had to go] → thank you → goodbye"
```

Calls, recordings, and transcripts appear in the web dashboard at `/dashboard`.

## Quick start

### 1. Prerequisites

- **Node.js 18+**
- A **Twilio account** with a phone number ([console.twilio.com](https://console.twilio.com))
- A **publicly accessible URL** for your server (ngrok works great for local dev)

### 2. Install

```bash
npm install
```

### 3. Configure

```bash
cp .env.example .env
```

Edit `.env` with your Twilio credentials and server URL.

### 4. (Optional) Add Harold's audio

See `public/audio/README.md` for instructions. The hotline works without audio
files — it uses timed pauses in their place.

### 5. Run

```bash
# Development (auto-restarts on changes)
npm run dev

# Production
npm start
```

### 6. Configure Twilio webhooks

In the [Twilio console](https://console.twilio.com), open your phone number and set:

| Setting | Value |
|---|---|
| **A call comes in** → Webhook | `https://your-server.com/voice/incoming` |
| **Call status changes** → Webhook | `https://your-server.com/voice/status` |

### 7. Local development with ngrok

```bash
ngrok http 3000
```

Use the `https://xxxx.ngrok.io` URL as your `BASE_URL` in `.env` and in the
Twilio webhook settings.

## Configuration

All messages, excuses, and behavior are in `config/harold.js`.  
You can edit them directly, or many settings respect env vars (see `.env.example`).

Key things to customize:
- `greeting` — the initial IVR message callers hear
- `confession.holdMessage` — "please hold for Harold…"
- `speak.introExcuses` — rotating array of reasons Harold is taking a moment
- `speak.exitExcuses` — rotating array of reasons Harold had to leave
- `haroldInstagram` — if set, mentioned in the confession thank-you message
- `announcerVoice` — any [Twilio/Polly voice](https://www.twilio.com/docs/voice/twiml/say/text-speech#amazon-polly-voices)

## Dashboard

Visit `/dashboard` to see all calls. Each row is expandable and shows:
- Transcript of the confession (when available)
- Playable recording
- Call SID and status

The dashboard polls for new calls every 30 seconds automatically.

## Project structure

```
HaroldHotline/
├── server.js              Express app
├── config/harold.js       All configurable messages and settings
├── routes/
│   ├── voice.js           Twilio TwiML webhook handlers
│   └── dashboard.js       Dashboard page + REST API
├── db/index.js            SQLite database (auto-created as harold.db)
├── public/audio/          Put Harold's audio files here
├── views/dashboard.html   Dashboard frontend
└── .env.example           Environment variable template
```

## Recording transcripts

Confessions are transcribed automatically by Twilio (up to 2 minutes).
Transcription arrives asynchronously via webhook — it may take 30–60 seconds
after the call ends to appear in the dashboard.

> Twilio's built-in transcription is optimized for clear speech, not cat meows.
> Harold's portion will not transcribe accurately. That's fine.

## Webhook security (production)

Twilio signs all webhooks. To validate signatures in production, add the
`twilio.webhook()` middleware to your voice routes:

```javascript
const twilio = require('twilio');
router.use(twilio.webhook({ authToken: config.authToken }));
```

For local ngrok dev, either skip validation or pass `{ validate: false }`.
