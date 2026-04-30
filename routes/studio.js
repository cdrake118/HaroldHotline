const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');
const crypto   = require('crypto');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const fetch    = require('node-fetch');
const { OpenAI, toFile } = require('openai');
const config   = require('../config/harold');
const db       = require('../db');
const { adminAuth, pageAuth } = require('../middleware/auth');

const HAROLD_REFS_DIR     = path.join(__dirname, '..', 'public', 'harold-refs');
const HAROLD_GALLERY_DIR  = path.join(__dirname, '..', 'public', 'harold-gallery');
const HAROLD_BADGES_DIR   = path.join(__dirname, '..', 'public', 'harold-badges');

// Whitelist badge names to prevent any path-traversal funny business via the body.
const VALID_BADGE_NAMES = new Set(['confession', 'chat', 'wisdom', 'advice', 'question']);
function findBadgeFile(name) {
  if (!name || !VALID_BADGE_NAMES.has(name)) return null;
  for (const ext of ['png', 'webp', 'jpg', 'jpeg']) {
    const p = path.join(HAROLD_BADGES_DIR, `${name}.${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Cache ElevenLabs voices for 1 hour to avoid a fresh API call on every studio load
const voicesCache = { voices: null, ts: 0 };
const VOICES_TTL_MS = 60 * 60 * 1000;

// In-memory video job tracker — polling endpoint reads from here
// Switched from SSE because Railway's proxy buffers event-stream responses.
const videoJobs = new Map(); // jobId -> { pct, msg, done, error, videoBase64, createdAt }
const JOB_MAX_AGE_MS = 30 * 60 * 1000;
function purgeOldJobs() {
  const now = Date.now();
  for (const [id, j] of videoJobs) {
    if (now - j.createdAt > JOB_MAX_AGE_MS) videoJobs.delete(id);
  }
}

const router = express.Router();

function wrapText(text, maxChars = 36) {
  const words = text.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    if (current && (current + ' ' + word).length > maxChars) {
      lines.push(current);
      current = word;
    } else {
      current = current ? current + ' ' + word : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// Splits text into 4-word phrases and builds timed drawtext filters for each phrase.
// startSec / endSec define the speaker's window in the final audio timeline.
function buildTimedCaptions(text, startSec, endSec, fontSize = 120) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length || endSec <= startSec) return [];
  // Ensure each phrase gets at least 0.7s — use fewer words per chunk for short audio
  const totalDur  = endSec - startSec;
  const maxChunks = Math.max(1, Math.floor(totalDur / 0.7));
  const CHUNK     = Math.max(2, Math.ceil(words.length / maxChunks));
  const chunks = [];
  for (let i = 0; i < words.length; i += CHUNK) chunks.push(words.slice(i, i + CHUNK).join(' '));
  const chunkDur = (endSec - startSec) / chunks.length;
  // Wrap width / padding / border / shadow all scale with fontSize so the layout
  // stays well-proportioned at any size (~0.55 = avg sans-serif char-width ratio).
  const wrapChars = Math.max(8, Math.floor(980 / (fontSize * 0.55)));
  const lineH     = Math.round(fontSize * 1.3);
  const padBottom = Math.round(fontSize * 0.6);
  const borderW   = Math.max(3, Math.round(fontSize * 0.05));
  const shadowOff = Math.max(2, Math.round(fontSize * 0.03));
  const filters = [];
  chunks.forEach((chunk, idx) => {
    const t0 = +(startSec + idx * chunkDur).toFixed(3);
    const t1 = +(startSec + (idx + 1) * chunkDur).toFixed(3);
    const lines = wrapText(chunk, wrapChars);
    const blockH = lines.length * lineH + padBottom;
    lines.forEach((line, li) => {
      const safe = line.replace(/\\/g, '\\\\').replace(/'/g, '\u2019').replace(/:/g, '\\:');
      filters.push(
        `drawtext=text='${safe}':x=(w-text_w)/2:y=h-${blockH - li * lineH}:fontsize=${fontSize}:fontcolor=white:borderw=${borderW}:bordercolor=black:shadowcolor=black@0.7:shadowx=${shadowOff}:shadowy=${shadowOff}:enable='between(t,${t0},${t1})'`
      );
    });
  });
  return filters;
}

// Runs ffmpeg with real-time progress reporting via -progress pipe:1.
// onPct(0..1) is called each time ffmpeg reports a new out_time_ms value.
// out_time_ms is in microseconds despite the name; totalSecs is in seconds.
function runFfmpegProgress(args, totalSecs, onPct) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args);
    let stderr = '';
    let lastPct = 0;
    proc.stdout.on('data', chunk => {
      const m = chunk.toString().match(/out_time_ms=(\d+)/);
      if (m && totalSecs > 0) {
        const pct = Math.min(parseInt(m[1]) / (totalSecs * 1e6), 1);
        if (pct > lastPct) { lastPct = pct; onPct(pct); }
      }
    });
    proc.stderr.on('data', chunk => { stderr += chunk.toString(); });
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-400)}`));
    });
    proc.on('error', reject);
  });
}

// Returns duration of a media file in seconds, parsed from ffmpeg's stderr.
// Avoids depending on ffprobe — some ffmpeg builds (e.g. headless variants) ship without it.
async function getMediaDuration(file) {
  try {
    // ffmpeg with -i and no output exits non-zero, but always prints "Duration:" to stderr
    await execFileAsync('ffmpeg', ['-hide_banner', '-i', file]);
  } catch (err) {
    const m = (err.stderr || '').match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (m) return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
  }
  return 0;
}

// ── Studio page ───────────────────────────────────────────────────────────────
router.get('/', pageAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'views', 'studio.html'));
});

// ── List ElevenLabs voices (cached 1h) ───────────────────────────────────────
router.get('/api/voices', adminAuth, async (req, res) => {
  if (!process.env.ELEVENLABS_API_KEY) return res.status(503).json({ error: 'ELEVENLABS_API_KEY not configured' });
  try {
    if (!voicesCache.voices || Date.now() - voicesCache.ts > VOICES_TTL_MS) {
      const voicesRes = await fetch('https://api.elevenlabs.io/v1/voices', {
        headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
      });
      if (!voicesRes.ok) throw new Error(`ElevenLabs voices error: ${voicesRes.status}`);
      const { voices } = await voicesRes.json();
      voicesCache.voices = voices
        .filter(v => v.category === 'premade' && v.voice_id !== config.elevenlabsHaroldVoiceId)
        .map(v => ({ id: v.voice_id, name: v.name, labels: v.labels || {} }));
      voicesCache.ts = Date.now();
    }
    res.json({ voices: voicesCache.voices });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Get a single call (for studio call-reference mode) ───────────────────────
router.get('/api/call/:id', adminAuth, (req, res) => {
  const call = db.getCallById(parseInt(req.params.id, 10));
  if (!call) return res.status(404).json({ error: 'Not found' });
  const { id, caller_number, call_type, created_at, transcript, wisdom_text, harold_response, recording_url, recording_sid } = call;
  res.json({ call: { id, caller_number, call_type, created_at, transcript, wisdom_text, harold_response, hasRecording: !!recording_url, recording_sid } });
});

// ── List which badge overlays are actually available on disk ────────────────
router.get('/api/badges', adminAuth, (req, res) => {
  const badgeLabels = {
    confession: 'Confession',
    chat:       'Chat with Harold',
    wisdom:     'Harold Wisdom',
    advice:     'Harold Advice',
    question:   'Question for Harold',
  };
  const badges = [];
  for (const [name, label] of Object.entries(badgeLabels)) {
    const file = findBadgeFile(name);
    if (file) {
      const ext = path.extname(file).slice(1);
      badges.push({ name, label, url: `/harold-badges/${name}.${ext}` });
    }
  }
  res.json({ badges });
});

// ── List wisdoms for the studio's wisdom-video mode ──────────────────────────
router.get('/api/wisdoms', adminAuth, (req, res) => {
  try {
    res.json({ wisdoms: db.listWisdoms(500) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Generate a single new wisdom (and persist it to the pool) ─────────────────
router.post('/api/generate-wisdom', adminAuth, async (req, res) => {
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'OPENAI_API_KEY not configured' });
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content:
          `Generate ONE unique piece of cat wisdom from Harold, a confident and mildly judgmental tabby cat dispensing life advice to humans. ` +
          `1-2 sentences. Direct, slightly smug, unexpectedly profound. ` +
          `Topics: sleep, food, territory, trust, presence, routine, observation, independence, contentment, warmth, patience. ` +
          `Do NOT use the word "sunbeam" or reference sunbeams. ` +
          `Return JSON: {"wisdom": "…"}`,
      }],
      max_tokens: 150,
      response_format: { type: 'json_object' },
    });
    const parsed = JSON.parse(completion.choices[0].message.content);
    const text   = (parsed.wisdom || '').trim();
    if (!text) throw new Error('Model returned an empty wisdom');
    // Persist to the pool so it shows up in subsequent picks. INSERT OR IGNORE
    // makes this safe if the wisdom happens to be a duplicate.
    try { db.insertWisdom(text, 'ai-studio'); } catch (_) {}
    res.json({ wisdom: text });
  } catch (err) {
    console.error('Generate wisdom error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate wisdom' });
  }
});

// ── Gallery: list reference & previously generated images ────────────────────
router.get('/api/gallery', adminAuth, (req, res) => {
  const refs = [];
  const generated = [];
  try {
    fs.readdirSync(HAROLD_REFS_DIR)
      .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))
      .forEach(f => refs.push({ name: f, url: `/harold-refs/${f}` }));
  } catch (_) {}
  try {
    fs.mkdirSync(HAROLD_GALLERY_DIR, { recursive: true });
    fs.readdirSync(HAROLD_GALLERY_DIR)
      .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))
      .sort().reverse()
      .forEach(f => generated.push({ name: f, url: `/harold-gallery/${f}` }));
  } catch (_) {}
  res.json({ refs, generated });
});

// ── Save a generated image to the gallery ────────────────────────────────────
router.post('/api/save-image', adminAuth, (req, res) => {
  const { imageData } = req.body;
  if (!imageData) return res.status(400).json({ error: 'imageData required' });
  try {
    fs.mkdirSync(HAROLD_GALLERY_DIR, { recursive: true });
    const fname = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.png`;
    const buf = Buffer.from(imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    fs.writeFileSync(path.join(HAROLD_GALLERY_DIR, fname), buf);
    res.json({ url: `/harold-gallery/${fname}`, name: fname });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Generate Harold's response from a real call's transcript ─────────────────
router.post('/api/generate-response', adminAuth, async (req, res) => {
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'OPENAI_API_KEY not configured' });
  const { transcript, callType, callId } = req.body;
  if (!transcript) return res.status(400).json({ error: 'transcript required' });

  const typeLabel = { confession: 'confession', question: 'question', speak: 'message', wisdom: 'wisdom reading' }[callType] || 'message';
  const prompt =
    `You write responses for Harold's Hotline. Harold is a real tabby cat — dry, direct, a little cutting. ` +
    `He speaks his own mind through a British announcer, always in the third person.\n\n` +
    `A caller left the following ${typeLabel}:\n"${transcript}"\n\n` +
    `Write 3 distinct Harold responses. Return ONLY valid JSON:\n{"variations":["...","...","..."]}\n\n` +
    `Rules for each:\n` +
    `- 1-2 sentences. Punchy. Under 35 words.\n` +
    `- Always third person — "Harold thinks...", "Harold is unmoved." — never "I"\n` +
    `- Harold judges. He does not comfort or moralize. He is a cat.\n` +
    `- Vary tone: try cutting/judgmental, absurdly deadpan, and unexpectedly profound.\n` +
    `- No hashtags, emojis, or filler.\n` +
    `- Do NOT use the word "sunbeam" or reference sunbeams.\n` +
    `- Replace any real names with "the caller".`;

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 250,
      response_format: { type: 'json_object' },
    });
    const parsed    = JSON.parse(completion.choices[0].message.content);
    const variations = Array.isArray(parsed.variations) ? parsed.variations.filter(Boolean) : [];
    const response  = variations[0] || '';
    if (callId && db.updateHaroldResponse) {
      try { db.updateHaroldResponse(parseInt(callId, 10), response); } catch (_) {}
    }
    res.json({ response, variations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Generate social media post caption ───────────────────────────────────────
router.post('/api/generate-post', adminAuth, async (req, res) => {
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'OPENAI_API_KEY not configured' });
  const { callerScript, haroldResponse, callType, isSynthetic } = req.body;
  if (!haroldResponse) return res.status(400).json({ error: 'haroldResponse required' });

  const typeLabels = {
    confession: 'confession', question: 'advice request', speak: 'message',
    wisdom: 'wisdom reading', emergency: 'emergency call', complaint: 'complaint',
    advice: 'life advice request', wellness: 'wellness check', tribute: 'tribute',
    meandering: 'meandering call',
  };
  const typeLabel = typeLabels[callType] || 'message';
  const callerPart = callerScript ? `Caller's message:\n"${callerScript.slice(0, 300)}"\n\n` : '';

  const prompt =
    `You are the social media manager for Harold's Hotline — a phone hotline where people call Harold, a very judgmental tabby cat. Harold cannot speak; he only meows.\n\n` +
    `This is ${isSynthetic ? 'a scripted call' : 'a real caller'} (${typeLabel}).\n\n` +
    `${callerPart}Harold's response:\n"${haroldResponse}"\n\n` +
    `Write a short, charming Instagram/TikTok caption. Rules:\n` +
    `- Under 150 words\n` +
    `- Write from Harold's social media team perspective\n` +
    `- Include Harold's implied cat reaction (unimpressed, napping, mildly judgmental)\n` +
    `- If a real name is in the caller's message, replace it with "a caller" or "someone"\n` +
    `- End with 3-5 hashtags including #HaroldsHotline and #HaroldTheCat`;

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 300,
    });
    res.json({ post: completion.choices[0].message.content.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Generate full synthetic call script ──────────────────────────────────────
router.post('/api/generate-script', adminAuth, async (req, res) => {
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'OPENAI_API_KEY not configured' });
  const { callType, callerPersona, mood, scenario } = req.body;
  if (!callType || !callerPersona || !mood) return res.status(400).json({ error: 'callType, callerPersona, and mood are required' });

  const callTypeLabels = {
    emergency:  'a frantic cat emergency (cat stuck, acting strange, missing)',
    complaint:  'a complaint about the caller\'s own cat\'s baffling behavior',
    confession: 'a specific, embarrassing, real-sounding confession — the kind that makes people cringe and share. Make it petty, selfish, or mildly terrible. Not vague.',
    advice:     'a request for life advice from Harold the cat',
    wellness:   'a wellness check — the caller wants to make sure Harold is okay',
    tribute:    'a tribute — the caller is sharing how Harold has inspired them',
    question:   'a random and possibly absurd question for Harold',
    meandering: 'a long, rambling, going-nowhere call about nothing in particular',
  };
  const personaLabels = {
    panicked:    'a panicked, breathless pet parent',
    grumpy:      'a grumpy older cat person who feels deeply misunderstood',
    confused:    'a sweet but confused older caller who isn\'t totally sure how hotlines work',
    dramatic:    'an extremely dramatic millennial who treats everything like a crisis',
    sincere:     'a genuinely sincere and earnest caller',
    deadpan:     'a completely dry, deadpan caller who barely inflects',
    enthusiastic:'an overwhelmingly enthusiastic, upbeat caller',
  };
  const moodLabels = {
    urgent:   'urgent and frantic',
    calm:     'calm and sincere',
    funny:    'absurd and comedic',
    emotional:'emotional, maybe on the verge of tears',
  };

  const scenarioBlock = scenario && scenario.trim()
    ? `Specific scenario / extra context (incorporate this faithfully):\n"${scenario.trim()}"\n\n`
    : '';

  const prompt =
    `You are writing a script for Harold's Hotline — a real cat hotline where callers leave voicemails for Harold, a ruthlessly judgmental tabby cat.\n\n` +
    `Call type: ${callTypeLabels[callType] || callType}\n` +
    `Caller persona: ${personaLabels[callerPersona] || callerPersona}\n` +
    `Mood: ${moodLabels[mood] || mood}\n\n` +
    scenarioBlock +
    `Return ONLY valid JSON (no markdown, no explanation):\n` +
    `{\n` +
    `  "callerScript": "What the caller says. Sound like a real voicemail — a little nervous, specific, conversational. 2-4 sentences. Natural filler words where appropriate. For confessions: specific and cringeworthy, not vague.",\n` +
    `  "haroldVariations": ["first response", "second response", "third response"],\n` +
    `  "scene": "1-2 sentence description for a realistic photo of a tabby cat matching the mood — natural setting, no props, no text."\n` +
    `}\n\n` +
    `Rules for haroldVariations: EXACTLY 3 items. Each: 1-2 sentences, under 35 words, always third person ("Harold...", never "I"). ` +
    `Vary tone across the three — e.g. cutting/judgmental, absurdly matter-of-fact, and unexpectedly profound. ` +
    `Do NOT use the word "sunbeam" or reference sunbeams in any variation.`;

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 400,
      response_format: { type: 'json_object' },
    });
    const parsed = JSON.parse(completion.choices[0].message.content);
    res.json(parsed);
  } catch (err) {
    console.error('Generate script error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate script' });
  }
});

// ── Generate caller audio (ElevenLabs, chosen voice) ─────────────────────────
router.post('/api/generate-caller-audio', adminAuth, async (req, res) => {
  if (!process.env.ELEVENLABS_API_KEY) return res.status(503).json({ error: 'ELEVENLABS_API_KEY not configured' });
  const { voiceId, text } = req.body;
  if (!voiceId || !text) return res.status(400).json({ error: 'voiceId and text are required' });
  try {
    const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.4, similarity_boost: 0.7 } }),
    });
    if (!ttsRes.ok) throw new Error(`ElevenLabs error: ${ttsRes.status}`);
    const buffer = await ttsRes.buffer();
    res.set('Content-Type', 'audio/mpeg');
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Generate Harold audio ─────────────────────────────────────────────────────
router.post('/api/generate-harold-audio', adminAuth, async (req, res) => {
  if (!process.env.ELEVENLABS_API_KEY) return res.status(503).json({ error: 'ELEVENLABS_API_KEY not configured' });
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });
  try {
    const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${config.elevenlabsHaroldVoiceId}`, {
      method: 'POST',
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model_id: config.elevenlabsModel, voice_settings: config.elevenlabsHaroldSettings }),
    });
    if (!ttsRes.ok) throw new Error(`ElevenLabs error: ${ttsRes.status}`);
    const buffer = await ttsRes.buffer();
    res.set('Content-Type', 'audio/mpeg');
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Generate Harold photo ─────────────────────────────────────────────────────
router.post('/api/generate-image', adminAuth, async (req, res) => {
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'OPENAI_API_KEY not configured' });
  const { haroldResponse, scene: providedScene } = req.body;
  if (!haroldResponse) return res.status(400).json({ error: 'haroldResponse is required' });

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    let scene = providedScene;
    if (!scene) {
      const sceneComp = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content:
          `Based on this Harold's Hotline response, describe a single realistic cat photo scene.\n"${haroldResponse}"\n\n` +
          `Rules: natural and realistic only — a real cat in a real setting. No props, no text. 1-2 sentences, specific and visual.`,
        }],
        max_tokens: 80,
      });
      scene = sceneComp.choices[0].message.content.trim();
    }

    const imagePrompt = `A natural, candid photograph of a tabby cat. ${scene} Photorealistic, natural lighting, no anthropomorphism, no props, no text.`;

    let refFiles = [];
    try { refFiles = fs.readdirSync(HAROLD_REFS_DIR).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f)); } catch (_) {}

    let imageB64;
    if (refFiles.length > 0) {
      const refBuffer = fs.readFileSync(path.join(HAROLD_REFS_DIR, refFiles[0]));
      const refFile   = await toFile(refBuffer, refFiles[0], { type: 'image/jpeg' });
      const result = await openai.images.edit({ model: 'gpt-image-1', image: refFile, prompt: imagePrompt, size: '1024x1024' });
      imageB64 = result.data[0].b64_json;
    } else {
      const result = await openai.images.generate({ model: 'gpt-image-1', prompt: imagePrompt, size: '1024x1024' });
      imageB64 = result.data[0].b64_json;
    }

    res.json({ image: `data:image/png;base64,${imageB64}`, scene });
  } catch (err) {
    console.error('Generate image error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate image' });
  }
});

// ── Assemble final video (SSE — streams real % progress) ─────────────────────
// Supports three modes:
//   - haroldOnly:  no caller audio
//   - aiCaller:    callerAudioData (base64 mp3) + callerText
//   - realCaller:  useRecording=true + callId (Twilio fetch) + callerText
//
// Emits { pct, msg } events during encoding, then { pct:100, done:true, videoBase64 }.
router.post('/api/generate-video', adminAuth, (req, res) => {
  const { imageData, callerAudioData, haroldAudioData, callerText, haroldText,
          useRecording, callId } = req.body || {};

  if (!imageData || !haroldAudioData || !haroldText) {
    return res.status(400).json({ error: 'imageData, haroldAudioData, and haroldText are required' });
  }
  const hasCallerAudio = !!(callerAudioData || (useRecording && callId));
  if (hasCallerAudio && !callerText) {
    return res.status(400).json({ error: 'callerText required when including caller audio' });
  }

  purgeOldJobs();

  const jobId = crypto.randomUUID();
  const job = { jobId, pct: 0, msg: 'Queued', done: false, error: null, videoBase64: null, createdAt: Date.now() };
  videoJobs.set(jobId, job);

  // Kick off the work in the background — response returns immediately
  runVideoJob(job, req.body).catch(err => {
    console.error('Studio generate video error:', err);
    job.error = err.message || 'Failed to generate video';
    job.done  = true;
  });

  res.json({ jobId });
});

router.get('/api/video-progress/:jobId', adminAuth, (req, res) => {
  const job = videoJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found or expired' });
  res.json({ pct: job.pct, msg: job.msg, done: job.done, error: job.error, videoBase64: job.videoBase64 });
  // Schedule deletion 10s after the client first sees done=true (gives time for retries)
  if (job.done && !job._deleteScheduled) {
    job._deleteScheduled = true;
    setTimeout(() => videoJobs.delete(job.jobId), 10000);
  }
});

async function runVideoJob(job, body) {
  const { imageData, callerAudioData, haroldAudioData, callerText, haroldText,
          useRecording, callId, aspectRatio = '1:1', includeRing = false,
          includeCaptions = true,
          badge = null, badgeX = 79, badgeY = 11, badgeSize = 34, badgeRotation = 0 } = body;
  const hasCallerAudio = !!(callerAudioData || (useRecording && callId));

  function setProgress(pct, msg) { job.pct = pct; if (msg) job.msg = msg; }

  const uid         = crypto.randomUUID();
  const tmpImg      = path.join(os.tmpdir(), `studio-img-${uid}.jpg`);
  const tmpCaller   = path.join(os.tmpdir(), `studio-caller-${uid}.mp3`);
  const tmpHarold   = path.join(os.tmpdir(), `studio-harold-${uid}.mp3`);
  const tmpCombined = path.join(os.tmpdir(), `studio-combined-${uid}.mp3`);
  const tmpVid      = path.join(os.tmpdir(), `studio-vid-${uid}.mp4`);
  const ringAudioPath = path.join(__dirname, '..', 'public', 'audio', 'ring.mp3');

  try {
    setProgress(5, 'Preparing files…');
    fs.writeFileSync(tmpImg,    Buffer.from(imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64'));
    fs.writeFileSync(tmpHarold, Buffer.from(haroldAudioData.replace(/^data:audio\/\w+;base64,/, ''), 'base64'));

    if (hasCallerAudio) {
      if (callerAudioData) {
        fs.writeFileSync(tmpCaller, Buffer.from(callerAudioData.replace(/^data:audio\/\w+;base64,/, ''), 'base64'));
      } else {
        setProgress(10, 'Fetching recording…');
        const call = db.getCallById(parseInt(callId, 10));
        if (!call || !call.recording_sid) throw new Error('Call recording not available');
        const recUrl = `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Recordings/${call.recording_sid}.mp3`;
        const creds  = Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64');
        const recRes = await fetch(recUrl, { headers: { Authorization: `Basic ${creds}` } });
        if (!recRes.ok) throw new Error(`Failed to fetch recording: ${recRes.status}`);
        fs.writeFileSync(tmpCaller, await recRes.buffer());
      }
    }

    let callerDur = 0;
    if (hasCallerAudio) {
      setProgress(14, 'Measuring audio…');
      callerDur = await getMediaDuration(tmpCaller);
    }

    const hasRing = includeRing && fs.existsSync(ringAudioPath);
    let ringDur = 0;
    if (hasRing) {
      ringDur = await getMediaDuration(ringAudioPath);
    }

    setProgress(18, 'Combining audio…');
    let audioFile = tmpHarold;
    if (hasCallerAudio && hasRing) {
      await execFileAsync('ffmpeg', [
        '-i', ringAudioPath, '-i', tmpCaller, '-i', tmpHarold,
        '-filter_complex', '[0:a][1:a][2:a]concat=n=3:v=0:a=1[outa]',
        '-map', '[outa]', '-y', tmpCombined,
      ]);
      audioFile = tmpCombined;
    } else if (hasCallerAudio) {
      await execFileAsync('ffmpeg', [
        '-i', tmpCaller, '-i', tmpHarold,
        '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[outa]',
        '-map', '[outa]', '-y', tmpCombined,
      ]);
      audioFile = tmpCombined;
    } else if (hasRing) {
      await execFileAsync('ffmpeg', [
        '-i', ringAudioPath, '-i', tmpHarold,
        '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[outa]',
        '-map', '[outa]', '-y', tmpCombined,
      ]);
      audioFile = tmpCombined;
    }

    setProgress(20, 'Starting encode…');
    const totalSecs = await getMediaDuration(audioFile);

    const callerStart  = ringDur;
    const callerEnd    = ringDur + callerDur;
    const haroldStart  = hasCallerAudio ? callerEnd : ringDur;
    const haroldText_q = `"${haroldText}"`;

    const allCaptionFilters = includeCaptions ? [
      ...(hasCallerAudio ? buildTimedCaptions(callerText.slice(0, 200), callerStart, callerEnd) : []),
      ...buildTimedCaptions(haroldText_q, haroldStart, totalSecs),
    ] : [];

    const [W, H] = aspectRatio === '9:16' ? [1080, 1920] : [1080, 1080];
    const scaleCrop = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`;

    // Resolve the badge — if it exists on disk, overlay it instead of the text watermark.
    const badgeFile = findBadgeFile(badge);
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || 0));

    const ffmpegArgs = ['-loop', '1', '-i', tmpImg, '-i', audioFile];
    if (badgeFile) ffmpegArgs.push('-loop', '1', '-i', badgeFile);

    const captionsChain = allCaptionFilters.join(',');

    let filterArg;
    if (badgeFile) {
      // Badge overlay path — uses filter_complex with the badge as input [2:v].
      // Order: scale image → scale badge to size → optional rotate (canvas grows
      // to fit) → overlay at (x,y) with badge centered on that point → captions.
      const sizePct = clamp(badgeSize, 5, 60);
      const rotDeg  = clamp(badgeRotation, -180, 180);
      const xPct    = clamp(badgeX, 0, 100);
      const yPct    = clamp(badgeY, 0, 100);
      const badgeW  = Math.floor(W * sizePct / 100);
      const xPx     = Math.floor(W * xPct / 100);
      const yPx     = Math.floor(H * yPct / 100);
      const rotRad  = (rotDeg * Math.PI / 180).toFixed(4);

      const rotateFilter = rotDeg === 0
        ? ''
        : `,rotate=${rotRad}:c=none@0:ow=rotw(${rotRad}):oh=roth(${rotRad})`;

      const chains = [
        `[0:v]${scaleCrop}[base]`,
        `[2:v]scale=${badgeW}:-1${rotateFilter}[badge]`,
        `[base][badge]overlay=${xPx}-overlay_w/2:${yPx}-overlay_h/2${captionsChain ? '[withbadge]' : '[v]'}`,
      ];
      if (captionsChain) {
        chains.push(`[withbadge]${captionsChain}[v]`);
      }
      filterArg = chains.join(';');
    } else {
      // No badge — keep the original text watermark + optional captions.
      const watermark = `drawtext=text='haroldshotline.com':x=(w-text_w)/2:y=36:fontsize=30:fontcolor=white@0.85:shadowcolor=black@0.5:shadowx=1:shadowy=1`;
      const chain = [scaleCrop, watermark, ...allCaptionFilters].filter(Boolean).join(',');
      filterArg = `[0:v]${chain}[v]`;
    }

    await runFfmpegProgress([
      ...ffmpegArgs,
      '-filter_complex', filterArg,
      '-map', '[v]', '-map', '1:a',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k',
      '-shortest',
      '-progress', 'pipe:1', '-nostats',
      '-y', tmpVid,
    ], totalSecs, pct => {
      setProgress(Math.round(20 + pct * 70), 'Encoding video…');
    });

    setProgress(93, 'Packaging…');
    job.videoBase64 = fs.readFileSync(tmpVid).toString('base64');
    setProgress(100, 'Done');
    job.done = true;
  } finally {
    [tmpImg, tmpCaller, tmpHarold, tmpCombined, tmpVid].forEach(f => { try { fs.unlinkSync(f); } catch (_) {} });
  }
}

// ── Save a produced post to history ──────────────────────────────────────────
router.post('/api/save-post', adminAuth, (req, res) => {
  const { callId, callType, caption } = req.body;
  if (!caption) return res.status(400).json({ error: 'caption required' });
  try {
    const info = db.savePost(callId || null, callType || null, caption);
    res.json({ id: info.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── List post history ─────────────────────────────────────────────────────────
router.get('/api/post-history', adminAuth, (req, res) => {
  try {
    res.json({ posts: db.listPosts(50) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
