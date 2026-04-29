const express = require('express');
const twilio = require('twilio');
const fetch = require('node-fetch');
const { OpenAI, toFile } = require('openai');
const config = require('../config/harold');
const db = require('../db');

const router = express.Router();

// ── Wisdom pool ───────────────────────────────────────────────────────────────
const WISDOM_POOL_MIN  = 50;
const WISDOM_BATCH_SIZE = 20;

async function generateWisdomBatch() {
  if (!process.env.OPENAI_API_KEY) return;
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content:
          `Generate ${WISDOM_BATCH_SIZE} unique pieces of cat wisdom from Harold, a confident and mildly judgmental tabby cat dispensing life advice to humans. ` +
          `Each entry is a single self-contained piece of advice, 1-2 sentences. Harold's voice: direct, slightly smug, unexpectedly profound. ` +
          `Vary the topics — consider sleep, food, territory, trust, presence, routine, observation, independence, contentment, warmth, patience. ` +
          `Do NOT reference sunbeams. ` +
          `Return ONLY a valid JSON array of strings, nothing else.`,
      }],
      max_tokens: 1500,
    });
    const raw = completion.choices[0].message.content.trim();
    const lines = JSON.parse(raw);
    if (Array.isArray(lines)) {
      for (const text of lines) {
        if (typeof text === 'string' && text.trim()) {
          db.insertWisdom(text.trim(), 'ai');
        }
      }
      console.log(`Generated ${lines.length} new wisdoms (pool now ${db.getWisdomCount()})`);
    }
  } catch (err) {
    console.error('Wisdom generation error:', err);
  }
}

function topUpWisdomPool() {
  if (db.getWisdomCount() < WISDOM_POOL_MIN) {
    generateWisdomBatch().catch(err => console.error('Wisdom top-up error:', err));
  }
}

// Seed hardcoded wisdoms into DB on startup and top up if needed
setImmediate(() => {
  for (const text of config.wisdom.lines) {
    db.insertWisdom(text, 'seed');
  }
  topUpWisdomPool();
});

// Helper: build a VoiceResponse, optionally playing audio or pausing
function audioOrPause(node, url, pauseSecs) {
  if (url) {
    node.play(url);
  } else {
    node.pause({ length: pauseSecs });
  }
}

// ── Incoming call ─────────────────────────────────────────────────────────────
router.post('/incoming', (req, res) => {
  const { CallSid, From } = req.body;

  // Harold unavailable mode
  if (db.getSetting('unavailable') === 'true') {
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say({ voice: config.announcerVoice }, config.unavailableMessage);
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  // Blocklist check
  if (From && db.isBlocked(From)) {
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  // Rate limit check
  const rateLimit = parseInt(db.getSetting('rate_limit') || '20', 10);
  if (From && db.countCallsByNumberInLastHour(From) >= rateLimit) {
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say({ voice: config.announcerVoice }, config.rateLimitMessage);
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  // Returning caller detection (check before upserting so count excludes current call)
  const isReturning = From && db.countCallsByNumber(From) > 0;

  db.upsertCall(CallSid, From, null);

  const twiml = new twilio.twiml.VoiceResponse();

  const gather = twiml.gather({
    numDigits: '1',
    action: `${config.baseUrl}/voice/menu`,
    method: 'POST',
    timeout: 10,
  });
  gather.say({ voice: config.announcerVoice }, config.recordingDisclosure);
  gather.say(
    { voice: config.announcerVoice },
    isReturning ? config.pickReturningGreeting() : config.pickGreeting()
  );

  // Fallback if caller doesn't press anything
  twiml.say({ voice: config.announcerVoice }, config.noInputMessage);
  twiml.hangup();

  res.type('text/xml');
  res.send(twiml.toString());
});

// ── Menu routing ──────────────────────────────────────────────────────────────
router.post('/menu', (req, res) => {
  const { Digits, CallSid, From } = req.body;

  const respond = (twiml) => { res.type('text/xml'); res.send(twiml.toString()); };

  if (Digits === '1') {
    db.upsertCall(CallSid, From, 'confession');
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.redirect({ method: 'POST' }, `${config.baseUrl}/voice/confession`);
    respond(twiml);
  } else if (Digits === '2') {
    db.upsertCall(CallSid, From, 'speak');
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.redirect({ method: 'POST' }, `${config.baseUrl}/voice/speak`);
    respond(twiml);
  } else if (Digits === '3') {
    db.upsertCall(CallSid, From, 'question');
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.redirect({ method: 'POST' }, `${config.baseUrl}/voice/question`);
    respond(twiml);
  } else if (Digits === '4') {
    db.upsertCall(CallSid, From, 'wisdom');
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.redirect({ method: 'POST' }, `${config.baseUrl}/voice/wisdom`);
    respond(twiml);
  } else if (Digits === '9') {
    // Repeat menu
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.redirect({ method: 'POST' }, `${config.baseUrl}/voice/incoming`);
    respond(twiml);
  } else {
    const twiml = new twilio.twiml.VoiceResponse();
    const gather = twiml.gather({
      numDigits: '1',
      action: `${config.baseUrl}/voice/menu`,
      method: 'POST',
      timeout: 10,
    });
    gather.say(
      { voice: config.announcerVoice },
      "Sorry, that wasn't a valid option. " + config.greeting
    );
    twiml.say({ voice: config.announcerVoice }, config.noInputMessage);
    twiml.hangup();
    res.type('text/xml');
    res.send(twiml.toString());
  }
});

// ── Confession flow ───────────────────────────────────────────────────────────
router.post('/confession', (req, res) => {
  const { CallSid, From } = req.body;
  db.upsertCall(CallSid, From, 'confession');

  const twiml = new twilio.twiml.VoiceResponse();

  twiml.say({ voice: config.announcerVoice }, config.pickIntroExcuse());

  audioOrPause(twiml, config.audio.holdMusic, config.audio.holdMusicPauseSecs);
  audioOrPause(twiml, config.audio.haroldMeowingShort, config.audio.haroldMeowingShortPauseSecs);

  twiml.say({ voice: config.announcerVoice }, config.confession.recordingPrompt);

  twiml.record({
    maxLength: 180,
    finishOnKey: '1',
    action: `${config.baseUrl}/voice/confession/complete`,
    recordingStatusCallback: `${config.baseUrl}/voice/recording-status`,
    recordingStatusCallbackMethod: 'POST',
  });

  res.type('text/xml');
  res.send(twiml.toString());
});

router.post('/confession/complete', (req, res) => {
  const { CallSid, RecordingUrl, RecordingSid } = req.body;

  if (RecordingUrl && RecordingSid) {
    db.updateRecording(CallSid, RecordingUrl, RecordingSid);
  }

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ voice: config.announcerVoice }, config.confession.thankYouMessage());
  twiml.hangup();

  res.type('text/xml');
  res.send(twiml.toString());
});

// ── Speak-to-Harold flow ──────────────────────────────────────────────────────
router.post('/speak', (req, res) => {
  const { CallSid, From } = req.body;
  db.upsertCall(CallSid, From, 'speak');

  const introExcuse = config.pickIntroExcuse();
  const exitExcuse = config.pickExitExcuse();

  const twiml = new twilio.twiml.VoiceResponse();

  twiml.say({ voice: config.announcerVoice }, introExcuse);

  audioOrPause(twiml, config.audio.holdMusic, config.audio.holdMusicPauseSecs);
  audioOrPause(twiml, config.audio.haroldMeowingLong, config.audio.haroldMeowingLongPauseSecs);

  twiml.say({ voice: config.announcerVoice }, exitExcuse);

  const gather = twiml.gather({
    numDigits: '1',
    action: `${config.baseUrl}/voice/speak/message-option`,
    method: 'POST',
    timeout: 8,
  });
  gather.say({ voice: config.announcerVoice }, config.speak.messagePrompt);

  twiml.say({ voice: config.announcerVoice }, config.speak.thankYouMessage());
  twiml.hangup();

  res.type('text/xml');
  res.send(twiml.toString());
});

router.post('/speak/message-option', (req, res) => {
  const { Digits } = req.body;
  const twiml = new twilio.twiml.VoiceResponse();
  if (Digits === '1') {
    twiml.redirect({ method: 'POST' }, `${config.baseUrl}/voice/speak/message`);
  } else {
    twiml.say({ voice: config.announcerVoice }, config.speak.thankYouMessage());
    twiml.hangup();
  }
  res.type('text/xml');
  res.send(twiml.toString());
});

router.post('/speak/message', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ voice: config.announcerVoice }, config.speak.messageRecordingPrompt);
  twiml.record({
    maxLength: 180,
    finishOnKey: '1',
    action: `${config.baseUrl}/voice/speak/message/complete`,
    recordingStatusCallback: `${config.baseUrl}/voice/recording-status`,
    recordingStatusCallbackMethod: 'POST',
  });
  res.type('text/xml');
  res.send(twiml.toString());
});

router.post('/speak/message/complete', (req, res) => {
  const { CallSid, RecordingUrl, RecordingSid } = req.body;
  if (RecordingUrl && RecordingSid) {
    db.updateRecording(CallSid, RecordingUrl, RecordingSid);
  }
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ voice: config.announcerVoice }, config.speak.messageThankYouMessage());
  twiml.hangup();
  res.type('text/xml');
  res.send(twiml.toString());
});

// ── Words of Wisdom flow ──────────────────────────────────────────────────────
router.post('/wisdom', (req, res) => {
  const { CallSid, From } = req.body;
  db.upsertCall(CallSid, From, 'wisdom');

  const twiml = new twilio.twiml.VoiceResponse();

  twiml.say({ voice: config.announcerVoice }, config.pickIntroExcuse());

  audioOrPause(twiml, config.audio.holdMusic, config.audio.holdMusicPauseSecs);
  audioOrPause(twiml, config.audio.haroldMeowingShort, config.audio.haroldMeowingShortPauseSecs);

  const wisdomRow = db.pickWisdom();
  const wisdomText = wisdomRow ? wisdomRow.text : config.pickWisdom();

  twiml.say({ voice: config.announcerVoice }, config.wisdom.intro);
  twiml.say({ voice: config.announcerVoice }, wisdomText);
  twiml.say({ voice: config.announcerVoice }, config.wisdom.thankYouMessage());

  // Non-blocking: top up pool in background if running low
  setImmediate(topUpWisdomPool);
  twiml.hangup();

  res.type('text/xml');
  res.send(twiml.toString());
});

// ── Ask-Harold-a-Question flow ────────────────────────────────────────────────
router.post('/question', (req, res) => {
  const { CallSid, From } = req.body;
  db.upsertCall(CallSid, From, 'question');

  const twiml = new twilio.twiml.VoiceResponse();

  twiml.say({ voice: config.announcerVoice }, config.pickIntroExcuse());

  audioOrPause(twiml, config.audio.holdMusic, config.audio.holdMusicPauseSecs);
  audioOrPause(twiml, config.audio.haroldMeowingShort, config.audio.haroldMeowingShortPauseSecs);

  twiml.say({ voice: config.announcerVoice }, config.question.recordingPrompt);

  twiml.record({
    maxLength: 180,
    finishOnKey: '1',
    action: `${config.baseUrl}/voice/question/complete`,
    recordingStatusCallback: `${config.baseUrl}/voice/recording-status`,
    recordingStatusCallbackMethod: 'POST',
  });

  res.type('text/xml');
  res.send(twiml.toString());
});

router.post('/question/complete', (req, res) => {
  const { CallSid, RecordingUrl, RecordingSid } = req.body;

  if (RecordingUrl && RecordingSid) {
    db.updateRecording(CallSid, RecordingUrl, RecordingSid);
  }

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ voice: config.announcerVoice }, config.question.thankYouMessage());
  twiml.hangup();

  res.type('text/xml');
  res.send(twiml.toString());
});

// ── Async callbacks from Twilio ───────────────────────────────────────────────

async function transcribeWithWhisper(callSid, recordingSid) {
  if (!process.env.OPENAI_API_KEY) return;
  try {
    db.updateTranscript(callSid, '', 'pending');
    const audioUrl =
      `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}` +
      `/Recordings/${recordingSid}.mp3`;
    const credentials = Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64');
    const audioRes = await fetch(audioUrl, { headers: { Authorization: `Basic ${credentials}` } });
    if (!audioRes.ok) throw new Error(`Twilio audio fetch failed: ${audioRes.status}`);
    const audioBuffer = await audioRes.buffer();
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const result = await openai.audio.transcriptions.create({
      file: await toFile(audioBuffer, `${recordingSid}.mp3`, { type: 'audio/mpeg' }),
      model: 'whisper-1',
    });
    db.updateTranscript(callSid, result.text, 'completed');
  } catch (err) {
    console.error('Whisper transcription error:', err);
    db.updateTranscript(callSid, '', 'failed');
  }
}

router.post('/recording-status', (req, res) => {
  const { CallSid, RecordingSid, RecordingUrl, RecordingStatus } = req.body;
  if (RecordingStatus === 'completed' && CallSid && RecordingSid) {
    db.updateRecording(CallSid, RecordingUrl, RecordingSid);
    transcribeWithWhisper(CallSid, RecordingSid);
  }
  res.sendStatus(204);
});

router.post('/transcription', (req, res) => {
  const { CallSid, RecordingSid, TranscriptionText, TranscriptionStatus } = req.body;
  if (CallSid) {
    db.updateTranscript(CallSid, TranscriptionText || '', TranscriptionStatus || 'completed');
  } else if (RecordingSid) {
    db.updateTranscriptByRecordingSid(RecordingSid, TranscriptionText || '', TranscriptionStatus || 'completed');
  }
  res.sendStatus(204);
});

router.post('/status', (req, res) => {
  const { CallSid, CallStatus, CallDuration } = req.body;
  if (CallSid) {
    db.updateStatus(CallSid, CallStatus, CallDuration);
  }
  res.sendStatus(204);
});

module.exports = router;
