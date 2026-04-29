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

const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'iQXyd2UUWDkTxpBxUhzQ';
const HAROLD_REFS_DIR     = path.join(__dirname, '..', 'public', 'harold-refs');

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

// ── Generate full synthetic call script ──────────────────────────────────────
router.post('/api/generate-script', adminAuth, async (req, res) => {
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'OPENAI_API_KEY not configured' });
  const { callType, callerPersona, mood } = req.body;
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

  const prompt =
    `You are writing a script for Harold's Hotline — a real cat hotline where callers leave messages for Harold, a judgmental tabby cat. Harold cannot speak; he only meows.\n\n` +
    `Call type: ${callTypeLabels[callType] || callType}\n` +
    `Caller persona: ${personaLabels[callerPersona] || callerPersona}\n` +
    `Mood: ${moodLabels[mood] || mood}\n\n` +
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
router.post('/api/generate-video', adminAuth, async (req, res) => {
  if (!process.env.ELEVENLABS_API_KEY) return res.status(503).json({ error: 'ELEVENLABS_API_KEY not configured' });
  const { imageData, callerAudioData, haroldAudioData, callerText, haroldText } = req.body;
  if (!imageData || !callerAudioData || !haroldAudioData || !callerText || !haroldText) {
    return res.status(400).json({ error: 'imageData, callerAudioData, haroldAudioData, callerText, and haroldText are required' });
  }

  const uid         = crypto.randomUUID();
  const tmpImg      = path.join(os.tmpdir(), `studio-img-${uid}.jpg`);
  const tmpCaller   = path.join(os.tmpdir(), `studio-caller-${uid}.mp3`);
  const tmpHarold   = path.join(os.tmpdir(), `studio-harold-${uid}.mp3`);
  const tmpCombined = path.join(os.tmpdir(), `studio-combined-${uid}.mp3`);
  const tmpVid      = path.join(os.tmpdir(), `studio-vid-${uid}.mp4`);

  try {
    fs.writeFileSync(tmpImg,    Buffer.from(imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64'));
    fs.writeFileSync(tmpCaller, Buffer.from(callerAudioData.replace(/^data:audio\/\w+;base64,/, ''), 'base64'));
    fs.writeFileSync(tmpHarold, Buffer.from(haroldAudioData.replace(/^data:audio\/\w+;base64,/, ''), 'base64'));

    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', tmpCaller,
    ]);
    const callerDur = parseFloat(stdout.trim()) || 0;

    await execFileAsync('ffmpeg', [
      '-i', tmpCaller, '-i', tmpHarold,
      '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[outa]',
      '-map', '[outa]', '-y', tmpCombined,
    ]);

    const watermark = `drawtext=text="Harold's Hotline":x=(w-text_w)/2:y=36:fontsize=30:fontcolor=white@0.85:shadowcolor=black@0.5:shadowx=1:shadowy=1`;

    const cLines  = wrapText(callerText.slice(0, 180));
    const hLines  = wrapText(`"${haroldText}"`);
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

    const vf = `scale=1080:1080:force_original_aspect_ratio=increase,crop=1080:1080,${watermark},${[...callerFilters, ...haroldFilters].join(',')}`;

    await execFileAsync('ffmpeg', [
      '-loop', '1', '-i', tmpImg, '-i', tmpCombined,
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
