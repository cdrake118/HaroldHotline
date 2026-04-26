const express = require('express');
const twilio = require('twilio');
const config = require('../config/harold');
const db = require('../db');

const router = express.Router();

// Helper: build a VoiceResponse, optionally playing audio or pausing
function audioOrPause(node, url, pauseSecs) {
  if (url) {
    node.play(url);
  } else {
    node.pause({ length: pauseSecs });
  }
}

// ── Incoming call ─────────────────────────────────────────────────────────────
// Twilio calls this webhook when someone dials the Harold Hotline number.
// Set this as the "A call comes in" webhook in your Twilio phone number config.
router.post('/incoming', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const gather = twiml.gather({
    numDigits: '1',
    action: `${config.baseUrl}/voice/menu`,
    method: 'POST',
    timeout: 10,
  });
  gather.say({ voice: config.announcerVoice }, config.greeting);

  // Fallback if caller doesn't press anything
  twiml.say({ voice: config.announcerVoice }, config.noInputMessage);
  twiml.hangup();

  res.type('text/xml');
  res.send(twiml.toString());
});

// ── Menu routing ──────────────────────────────────────────────────────────────
router.post('/menu', (req, res) => {
  const { Digits, CallSid, From } = req.body;

  if (Digits === '1') {
    db.upsertCall(CallSid, From, 'confession');
    res.redirect(307, `${config.baseUrl}/voice/confession`);
  } else if (Digits === '2') {
    db.upsertCall(CallSid, From, 'speak');
    res.redirect(307, `${config.baseUrl}/voice/speak`);
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

  twiml.say({ voice: config.announcerVoice }, config.confession.holdMessage);

  audioOrPause(twiml, config.audio.holdMusic, config.audio.holdMusicPauseSecs);
  audioOrPause(twiml, config.audio.haroldMeowingShort, config.audio.haroldMeowingShortPauseSecs);

  twiml.say({ voice: config.announcerVoice }, config.confession.recordingPrompt);

  twiml.record({
    maxLength: 180,
    finishOnKey: '1',
    action: `${config.baseUrl}/voice/confession/complete`,
    recordingStatusCallback: `${config.baseUrl}/voice/recording-status`,
    recordingStatusCallbackMethod: 'POST',
    transcribe: true,
    transcribeCallback: `${config.baseUrl}/voice/transcription`,
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
  const instagram = config.haroldInstagram;
  twiml.say({ voice: config.announcerVoice }, config.confession.thankYouMessage(instagram));
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
  twiml.say({ voice: config.announcerVoice }, config.speak.thankYouMessage);
  twiml.hangup();

  res.type('text/xml');
  res.send(twiml.toString());
});

// ── Async callbacks from Twilio ───────────────────────────────────────────────

// Fires when recording status changes (completed, failed)
router.post('/recording-status', (req, res) => {
  const { CallSid, RecordingSid, RecordingUrl, RecordingStatus } = req.body;
  if (RecordingStatus === 'completed' && CallSid && RecordingSid) {
    db.updateRecording(CallSid, RecordingUrl, RecordingSid);
  }
  res.sendStatus(204);
});

// Fires when Twilio finishes transcribing a recording
router.post('/transcription', (req, res) => {
  const { CallSid, RecordingSid, TranscriptionText, TranscriptionStatus } = req.body;
  if (CallSid) {
    db.updateTranscript(CallSid, TranscriptionText || '', TranscriptionStatus || 'completed');
  } else if (RecordingSid) {
    db.updateTranscriptByRecordingSid(RecordingSid, TranscriptionText || '', TranscriptionStatus || 'completed');
  }
  res.sendStatus(204);
});

// Fires on call status changes — used to capture duration
router.post('/status', (req, res) => {
  const { CallSid, CallStatus, CallDuration } = req.body;
  if (CallSid) {
    db.updateStatus(CallSid, CallStatus, CallDuration);
  }
  res.sendStatus(204);
});

module.exports = router;
