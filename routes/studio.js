const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');
const crypto   = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const fetch    = require('node-fetch');
const { OpenAI, toFile } = require('openai');
const config   = require('../config/harold');
const db       = require('../db');

const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'iQXyd2UUWDkTxpBxUhzQ';
const HAROLD_REFS_DIR     = path.join(__dirname, '..', 'public', 'harold-refs');
const HAROLD_GALLERY_DIR  = path.join(__dirname, '..', 'public', 'harold-gallery');

const router = express.Router();

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

// ── Studio page ───────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'views', 'studio.html'));
});

// ── List ElevenLabs voices ────────────────────────────────────────────────────
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

// ── Get a single call (for studio call-reference mode) ───────────────────────
router.get('/api/call/:id', adminAuth, (req, res) => {
  const call = db.getCallById(parseInt(req.params.id, 10));
  if (!call) return res.status(404).json({ error: 'Not found' });
  const { id, caller_number, call_type, created_at, transcript, wisdom_text, harold_response, recording_url, recording_sid } = call;
  res.json({ call: { id, caller_number, call_type, created_at, transcript, wisdom_text, harold_response, hasRecording: !!recording_url, recording_sid } });
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
    `You write responses for Harold's Hotline. Harold is a real tabby cat — dry, composed, mildly judgmental, unexpectedly wise. ` +
    `A British announcer speaks on Harold's behalf, always in the third person.\n\n` +
    `A caller left the following ${typeLabel}:\n"${transcript}"\n\n` +
    `Write Harold's response in 2-4 sentences. Rules:\n` +
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
    if (callId && db.updateHaroldResponse) {
      try { db.updateHaroldResponse(parseInt(callId, 10), response); } catch (_) {}
    }
    res.json({ response });
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
    confession: 'a heartfelt confession that the caller is telling Harold',
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
    `You are writing a script for Harold's Hotline — a real cat hotline where callers leave messages for Harold, a judgmental tabby cat. Harold cannot speak; he only meows.\n\n` +
    `Call type: ${callTypeLabels[callType] || callType}\n` +
    `Caller persona: ${personaLabels[callerPersona] || callerPersona}\n` +
    `Mood: ${moodLabels[mood] || mood}\n\n` +
    scenarioBlock +
    `Write a realistic, charming call script. Return ONLY valid JSON (no markdown, no explanation):\n` +
    `{\n` +
    `  "callerScript": "What the caller says — conversational, like leaving a voicemail. 3-5 sentences. Natural speech, including small filler words if appropriate.",\n` +
    `  "haroldResponse": "Harold's response in 2-4 sentences. Written in third person by a dry British announcer speaking on Harold's behalf. Always third person (Harold never says I). Dry, composed, mildly judgmental. Under 60 words.",\n` +
    `  "scene": "A 1-2 sentence description for a realistic photo of a tabby cat in a setting matching the mood — natural, no props, no text."\n` +
    `}`;

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
    const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`, {
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
      const result = await openai.images.edit({ model: 'gpt-image-2', image: refFile, prompt: imagePrompt, size: '1024x1024', response_format: 'b64_json' });
      imageB64 = result.data[0].b64_json;
    } else {
      const result = await openai.images.generate({ model: 'gpt-image-2', prompt: imagePrompt, size: '1024x1024', response_format: 'b64_json' });
      imageB64 = result.data[0].b64_json;
    }

    res.json({ image: `data:image/png;base64,${imageB64}`, scene });
  } catch (err) {
    console.error('Generate image error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate image' });
  }
});

// ── Assemble final video ──────────────────────────────────────────────────────
// Supports three modes:
//   - haroldOnly:  no caller audio
//   - aiCaller:    callerAudioData (base64 mp3) + callerText
//   - realCaller:  useRecording=true + callId (Twilio fetch) + callerText
router.post('/api/generate-video', adminAuth, async (req, res) => {
  if (!process.env.ELEVENLABS_API_KEY) return res.status(503).json({ error: 'ELEVENLABS_API_KEY not configured' });
  const { imageData, callerAudioData, haroldAudioData, callerText, haroldText, useRecording, callId } = req.body;
  if (!imageData || !haroldAudioData || !haroldText) {
    return res.status(400).json({ error: 'imageData, haroldAudioData, and haroldText are required' });
  }

  const hasCallerAudio = !!(callerAudioData || (useRecording && callId));
  if (hasCallerAudio && !callerText) {
    return res.status(400).json({ error: 'callerText required when including caller audio' });
  }

  const uid         = crypto.randomUUID();
  const tmpImg      = path.join(os.tmpdir(), `studio-img-${uid}.jpg`);
  const tmpCaller   = path.join(os.tmpdir(), `studio-caller-${uid}.mp3`);
  const tmpHarold   = path.join(os.tmpdir(), `studio-harold-${uid}.mp3`);
  const tmpCombined = path.join(os.tmpdir(), `studio-combined-${uid}.mp3`);
  const tmpVid      = path.join(os.tmpdir(), `studio-vid-${uid}.mp4`);

  try {
    fs.writeFileSync(tmpImg,    Buffer.from(imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64'));
    fs.writeFileSync(tmpHarold, Buffer.from(haroldAudioData.replace(/^data:audio\/\w+;base64,/, ''), 'base64'));

    if (hasCallerAudio) {
      if (callerAudioData) {
        fs.writeFileSync(tmpCaller, Buffer.from(callerAudioData.replace(/^data:audio\/\w+;base64,/, ''), 'base64'));
      } else {
        const call = db.getCallById(parseInt(callId, 10));
        if (!call || !call.recording_sid) throw new Error('Call recording not available');
        const recUrl = `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Recordings/${call.recording_sid}.mp3`;
        const creds  = Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64');
        const recRes = await fetch(recUrl, { headers: { Authorization: `Basic ${creds}` } });
        if (!recRes.ok) throw new Error(`Failed to fetch recording: ${recRes.status}`);
        fs.writeFileSync(tmpCaller, await recRes.buffer());
      }
    }

    let audioFile = tmpHarold;
    let callerDur = 0;
    if (hasCallerAudio) {
      const { stdout } = await execFileAsync('ffprobe', [
        '-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', tmpCaller,
      ]);
      callerDur = parseFloat(stdout.trim()) || 0;
      await execFileAsync('ffmpeg', [
        '-i', tmpCaller, '-i', tmpHarold,
        '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[outa]',
        '-map', '[outa]', '-y', tmpCombined,
      ]);
      audioFile = tmpCombined;
    }

    const watermark = `drawtext=text="Harold's Hotline":x=(w-text_w)/2:y=36:fontsize=30:fontcolor=white@0.85:shadowcolor=black@0.5:shadowx=1:shadowy=1`;

    let captionFilters;
    if (hasCallerAudio && callerDur > 0) {
      const cLines  = wrapText(callerText.slice(0, 180));
      const hLines  = wrapText(`"${haroldText}"`);
      const cTotalH = cLines.length * 52 + 30;
      const hTotalH = hLines.length * 52 + 30;
      const callerFilters = cLines.map((line, i) => {
        const safe = line.replace(/\\/g, '\\\\').replace(/'/g, '’').replace(/:/g, '\\:');
        return `drawtext=text='${safe}':x=(w-text_w)/2:y=h-${cTotalH - i * 52}:fontsize=40:fontcolor=white:shadowcolor=black@0.8:shadowx=2:shadowy=2:enable='between(t,0,${callerDur})'`;
      });
      const haroldFilters = hLines.map((line, i) => {
        const safe = line.replace(/\\/g, '\\\\').replace(/'/g, '’').replace(/:/g, '\\:');
        return `drawtext=text='${safe}':x=(w-text_w)/2:y=h-${hTotalH - i * 52}:fontsize=40:fontcolor=white:shadowcolor=black@0.8:shadowx=2:shadowy=2:enable='gte(t,${callerDur})'`;
      });
      captionFilters = [...callerFilters, ...haroldFilters].join(',');
    } else {
      const lines  = wrapText(`"${haroldText}"`);
      const totalH = lines.length * 52 + 30;
      captionFilters = lines.map((line, i) => {
        const safe = line.replace(/\\/g, '\\\\').replace(/'/g, '’').replace(/:/g, '\\:');
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
    res.set('Content-Disposition', `attachment; filename="harold-studio-${Date.now()}.mp4"`);
    res.send(videoBuffer);
  } catch (err) {
    console.error('Studio generate video error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate video' });
  } finally {
    [tmpImg, tmpCaller, tmpHarold, tmpCombined, tmpVid].forEach(f => { try { fs.unlinkSync(f); } catch (_) {} });
  }
});

module.exports = router;
