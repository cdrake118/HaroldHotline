const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const fetch = require('node-fetch');
const { OpenAI, toFile } = require('openai');
const config = require('../config/harold');
const db = require('../db');

const HAROLD_REFS_DIR = path.join(__dirname, '..', 'public', 'harold-refs');
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'iQXyd2UUWDkTxpBxUhzQ';

const router = express.Router();

// -- Dashboard page ------------------------------------------------------------
router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'views', 'dashboard.html'));
});

// -- Diagnostics --------------------------------------------------------------
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

// -- Admin auth ----------------------------------------------------------------
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

// -- REST API ------------------------------------------------------------------

router.get('/api/stats', (req, res) => {
  res.json(db.stats());
});

router.get('/api/stats/daily', (req, res) => {
  res.json(db.statsDaily());
});

// Search must be registered before /:id to avoid route conflict
router.get('/api/calls/search', (req, res) => {
  const q = (req.query.q || '').trim();
  const limit  = Math.min(parseInt(req.query.limit  || '25', 10), 200);
  const offset = parseInt(req.query.offset || '0', 10);
  if (!q) return res.json({ calls: [], total: 0, limit, offset });
  const calls = db.searchCalls(q, limit, offset);
  const total = db.countSearchCalls(q);
  res.json({ calls, total, limit, offset });
});

router.get('/api/calls', (req, res) => {
  const limit        = Math.min(parseInt(req.query.limit  || '50', 10), 200);
  const offset       = parseInt(req.query.offset || '0', 10);
  const hasRecording = req.query.hasRecording === '1';
  const callType     = req.query.type || null;
  const dateFrom     = req.query.from || null;
  const dateTo       = req.query.to   || null;

  const calls = db.listCallsFiltered({ limit, offset, hasRecording, callType, dateFrom, dateTo });
  const total = db.countCallsFiltered({ hasRecording, callType, dateFrom, dateTo });
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

// -- Blocklist -----------------------------------------------------------------

router.get('/api/blocklist', adminAuth, (req, res) => {
  res.json(db.listBlocklist());
});

router.post('/api/blocklist', adminAuth, (req, res) => {
  const { number, reason } = req.body;
  if (!number || !number.trim()) return res.status(400).json({ error: 'number is required' });
  db.addToBlocklist(number.trim(), reason || null);
  res.json({ success: true });
});

router.delete('/api/blocklist/:id', adminAuth, (req, res) => {
  db.removeFromBlocklist(parseInt(req.params.id, 10));
  res.json({ success: true });
});

// -- Settings ------------------------------------------------------------------

router.get('/api/settings', adminAuth, (req, res) => {
  res.json({
    unavailable: db.getSetting('unavailable') === 'true',
    rateLimit:   parseInt(db.getSetting('rate_limit') || '20', 10),
  });
});

router.patch('/api/settings', adminAuth, (req, res) => {
  const { unavailable, rateLimit } = req.body;
  if (unavailable !== undefined) db.setSetting('unavailable', unavailable ? 'true' : 'false');
  if (rateLimit    !== undefined) db.setSetting('rate_limit', String(Math.max(1, parseInt(rateLimit, 10) || 20)));
  res.json({ success: true });
});

// -- Rate-limited callers ------------------------------------------------------

router.get('/api/rate-limited', adminAuth, (req, res) => {
  const limit = parseInt(db.getSetting('rate_limit') || '20', 10);
  res.json(db.getRateLimitedCallers(limit));
});

// -- Wisdom pool ---------------------------------------------------------------

router.get('/api/wisdoms/count', (req, res) => {
  res.json({ count: db.getWisdomCount() });
});

router.post('/api/wisdoms/generate', adminAuth, async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({ error: 'OPENAI_API_KEY is not configured' });
  }
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const batchSize = Math.min(parseInt(req.body.count || '20', 10), 50);
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content:
          `Generate ${batchSize} unique pieces of cat wisdom from Harold, a confident and mildly judgmental tabby cat dispensing life advice to humans. ` +
          `Each entry is a single self-contained piece of advice, 1-2 sentences. Harold's voice: direct, slightly smug, unexpectedly profound. ` +
          `Vary the topics — consider sleep, food, territory, trust, presence, routine, observation, independence, contentment, warmth, patience. ` +
          `Do NOT reference sunbeams. ` +
          `Return ONLY a valid JSON array of strings, nothing else.`,
      }],
      max_tokens: 2000,
    });
    const raw = completion.choices[0].message.content.trim();
    const lines = JSON.parse(raw);
    let added = 0;
    if (Array.isArray(lines)) {
      for (const text of lines) {
        if (typeof text === 'string' && text.trim()) {
          const result = db.insertWisdom(text.trim(), 'ai');
          if (result.changes) added++;
        }
      }
    }
    res.json({ added, total: db.getWisdomCount() });
  } catch (err) {
    console.error('Wisdom generate error:', err);
    res.status(500).json({ error: 'Failed to generate wisdoms' });
  }
});

// -- Social content pipeline ---------------------------------------------------

// Step 1 — Harold's third-person response text
router.post('/api/calls/:id/generate-response', adminAuth, async (req, res) => {
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'OPENAI_API_KEY not configured' });
  const call = db.getCallById(parseInt(req.params.id, 10));
  if (!call) return res.status(404).json({ error: 'Not found' });

  const sourceText = call.transcript || call.wisdom_text;
  if (!sourceText) return res.status(400).json({ error: 'No transcript or wisdom to respond to' });

  const typeLabel = { confession: 'confession', question: 'question', speak: 'message', wisdom: 'wisdom reading' }[call.call_type] || 'message';

  const prompt =
    `You write responses for Harold's Hotline. Harold is a real tabby cat — dry, composed, mildly judgmental, unexpectedly wise. ` +
    `A British announcer speaks on Harold's behalf, always in the third person.\n\n` +
    `A caller left the following ${typeLabel}:\n"${sourceText}"\n\n` +
    `Write Harold's response in 2–4 sentences. Rules:\n` +
    `- Always third person — "Harold..." never "I..."\n` +
    `- Dry and composed — Harold is quietly amused, never ruffled\n` +
    `- If silly content, be wry. If serious, be unexpectedly profound.\n` +
    `- Under 60 words\n` +
    `- No hashtags, emojis, or social media language\n` +
    `- Replace any real names with "the caller"`;

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 150,
    });
    const response = completion.choices[0].message.content.trim();
    db.updateHaroldResponse(call.id, response);
    res.json({ response });
  } catch (err) {
    console.error('Generate response error:', err);
    res.status(500).json({ error: 'Failed to generate response' });
  }
});

// Step 2 — Realistic Harold photo via gpt-image-2
router.post('/api/calls/:id/generate-image', adminAuth, async (req, res) => {
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'OPENAI_API_KEY not configured' });
  const call = db.getCallById(parseInt(req.params.id, 10));
  if (!call) return res.status(404).json({ error: 'Not found' });

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // Generate a realistic scene description from Harold's response or source content
    const sourceText = call.harold_response || call.transcript || call.wisdom_text || '';
    const sceneComp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content:
        `Based on this text from Harold's Hotline, describe a single realistic cat photo scene.\n"${sourceText}"\n\n` +
        `Rules: natural and realistic only — a real cat in a real setting (napping, looking out a window, sitting still, watching something, grooming, perched somewhere). ` +
        `No human props, no staged or anthropomorphic poses. 1–2 sentences, specific and visual.`,
      }],
      max_tokens: 80,
    });
    const scene = sceneComp.choices[0].message.content.trim();

    const imagePrompt =
      `A natural, candid photograph of a tabby cat. ${scene} ` +
      `Photorealistic, natural lighting, no anthropomorphism, no props, no text.`;

    // Use reference photos if available
    let refFiles = [];
    try { refFiles = fs.readdirSync(HAROLD_REFS_DIR).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f)); } catch (_) {}

    let imageB64;
    if (refFiles.length > 0) {
      const refBuffer = fs.readFileSync(path.join(HAROLD_REFS_DIR, refFiles[0]));
      const refFile   = await toFile(refBuffer, refFiles[0], { type: 'image/jpeg' });
      const result = await openai.images.edit({
        model: 'gpt-image-2',
        image: refFile,
        prompt: imagePrompt,
        size: '1024x1024',
        response_format: 'b64_json',
      });
      imageB64 = result.data[0].b64_json;
    } else {
      const result = await openai.images.generate({
        model: 'gpt-image-2',
        prompt: imagePrompt,
        size: '1024x1024',
        response_format: 'b64_json',
      });
      imageB64 = result.data[0].b64_json;
    }

    res.json({ image: `data:image/png;base64,${imageB64}`, scene });
  } catch (err) {
    console.error('Generate image error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate image' });
  }
});

// Step 3 — Combine image + ElevenLabs TTS into downloadable mp4
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

// -- List ElevenLabs voices (for caller voice picker) -------------------------
router.get('/api/voices', adminAuth, async (req, res) => {
  if (!process.env.ELEVENLABS_API_KEY) return res.status(503).json({ error: 'ELEVENLABS_API_KEY not configured' });
  try {
    const voicesRes = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
    });
    if (!voicesRes.ok) throw new Error(`ElevenLabs voices error: ${voicesRes.status}`);
    const { voices } = await voicesRes.json();
    const filtered = voices
      .filter(v => v.category === 'premade' && v.voice_id !== ELEVENLABS_VOICE_ID)
      .map(v => ({ id: v.voice_id, name: v.name, labels: v.labels || {} }));
    res.json({ voices: filtered });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -- Generate AI-voiced caller audio ------------------------------------------
router.post('/api/calls/:id/generate-caller-audio', adminAuth, async (req, res) => {
  if (!process.env.ELEVENLABS_API_KEY) return res.status(503).json({ error: 'ELEVENLABS_API_KEY not configured' });
  const { voiceId, text } = req.body;
  if (!voiceId || !text) return res.status(400).json({ error: 'voiceId and text are required' });
  try {
    const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
    });
    if (!ttsRes.ok) throw new Error(`ElevenLabs error: ${ttsRes.status}`);
    const buffer = await ttsRes.buffer();
    res.set('Content-Type', 'audio/mpeg');
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/calls/:id/generate-video', adminAuth, async (req, res) => {
  if (!process.env.ELEVENLABS_API_KEY) return res.status(503).json({ error: 'ELEVENLABS_API_KEY not configured' });
  const call = db.getCallById(parseInt(req.params.id, 10));
  if (!call) return res.status(404).json({ error: 'Not found' });

  const { imageData, responseText, callerAudioData, callerText, useRecording } = req.body;
  if (!imageData || !responseText) return res.status(400).json({ error: 'imageData and responseText are required' });

  const uid = crypto.randomUUID();
  const tmpImg      = path.join(os.tmpdir(), `harold-${uid}.jpg`);
  const tmpAud      = path.join(os.tmpdir(), `harold-${uid}.mp3`);
  const tmpVid      = path.join(os.tmpdir(), `harold-${uid}.mp4`);
  const tmpCaller   = path.join(os.tmpdir(), `caller-${uid}.mp3`);
  const tmpCombined = path.join(os.tmpdir(), `combined-${uid}.mp3`);
  const hasCallerAudio = !!(callerAudioData || (useRecording && call.recording_sid));

  try {
    fs.writeFileSync(tmpImg, Buffer.from(imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64'));

    // Optionally fetch/save caller audio
    if (hasCallerAudio) {
      if (callerAudioData) {
        fs.writeFileSync(tmpCaller, Buffer.from(callerAudioData.replace(/^data:audio\/\w+;base64,/, ''), 'base64'));
      } else {
        const recUrl = `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Recordings/${call.recording_sid}.mp3`;
        const creds  = Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64');
        const recRes = await fetch(recUrl, { headers: { Authorization: `Basic ${creds}` } });
        if (!recRes.ok) throw new Error(`Failed to fetch recording: ${recRes.status}`);
        fs.writeFileSync(tmpCaller, await recRes.buffer());
      }
    }

    // Harold TTS
    const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`, {
      method: 'POST',
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: responseText, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
    });
    if (!ttsRes.ok) throw new Error(`ElevenLabs error: ${ttsRes.status}`);
    fs.writeFileSync(tmpAud, await ttsRes.buffer());

    let audioFile = tmpAud;
    let callerDur  = 0;

    if (hasCallerAudio) {
      const { stdout } = await execFileAsync('ffprobe', [
        '-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', tmpCaller,
      ]);
      callerDur = parseFloat(stdout.trim()) || 0;
      await execFileAsync('ffmpeg', [
        '-i', tmpCaller, '-i', tmpAud,
        '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[outa]',
        '-map', '[outa]', '-y', tmpCombined,
      ]);
      audioFile = tmpCombined;
    }

    const watermark = `drawtext=text="Harold's Hotline":x=(w-text_w)/2:y=36:fontsize=30:fontcolor=white@0.85:shadowcolor=black@0.5:shadowx=1:shadowy=1`;

    let captionFilters;
    if (hasCallerAudio && callerDur > 0 && callerText) {
      const cLines  = wrapText(callerText.slice(0, 180));
      const hLines  = wrapText(`"${responseText}"`);
      const cTotalH = cLines.length * 52 + 30;
      const hTotalH = hLines.length * 52 + 30;
      const callerFilters = cLines.map((line, i) => {
        const safe = line.replace(/\\/g, '\\\\').replace(/'/g, "'").replace(/:/g, '\\:');
        return `drawtext=text='${safe}':x=(w-text_w)/2:y=h-${cTotalH - i * 52}:fontsize=40:fontcolor=white:shadowcolor=black@0.8:shadowx=2:shadowy=2:enable='between(t,0,${callerDur})'`;
      });
      const haroldFilters = hLines.map((line, i) => {
        const safe = line.replace(/\\/g, '\\\\').replace(/'/g, "'").replace(/:/g, '\\:');
        return `drawtext=text='${safe}':x=(w-text_w)/2:y=h-${hTotalH - i * 52}:fontsize=40:fontcolor=white:shadowcolor=black@0.8:shadowx=2:shadowy=2:enable='gte(t,${callerDur})'`;
      });
      captionFilters = [...callerFilters, ...haroldFilters].join(',');
    } else {
      const lines   = wrapText(`"${responseText}"`);
      const totalH  = lines.length * 52 + 30;
      captionFilters = lines.map((line, i) => {
        const safe = line.replace(/\\/g, '\\\\').replace(/'/g, "'").replace(/:/g, '\\:');
        return `drawtext=text='${safe}':x=(w-text_w)/2:y=h-${totalH - i * 52}:fontsize=40:fontcolor=white:shadowcolor=black@0.8:shadowx=2:shadowy=2`;
      }).join(',');
    }

    const vf = `scale=1080:1080:force_original_aspect_ratio=increase,crop=1080:1080,${watermark},${captionFilters}`;

    await execFileAsync('ffmpeg', [
      '-loop', '1', '-i', tmpImg, '-i', audioFile,
      '-vf', vf,
      '-c:v', 'libx264', '-preset', 'fast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k',
      '-shortest', '-y', tmpVid,
    ]);

    const videoBuffer = fs.readFileSync(tmpVid);
    res.set('Content-Type', 'video/mp4');
    res.set('Content-Disposition', `attachment; filename="harold-${call.id}.mp4"`);
    res.send(videoBuffer);
  } catch (err) {
    console.error('Generate video error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate video' });
  } finally {
    [tmpImg, tmpAud, tmpVid, tmpCaller, tmpCombined].forEach(f => { try { fs.unlinkSync(f); } catch (_) {} });
  }
});

// -- Voiceover generator -------------------------------------------------------
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

// -- Generate social post ------------------------------------------------------
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

// -- Admin actions -------------------------------------------------------------

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
