// Publish queue for sending studio-rendered videos to Instagram (Reels) and
// Facebook Pages via the Meta Graph API. Persisted in SQLite (publish_jobs)
// and processed by a single setInterval scheduler started from server.js.
//
// Required env vars:
//   META_ACCESS_TOKEN  — long-lived Page access token (from /me/accounts)
//   META_PAGE_ID       — Facebook Page id (e.g. 1161567350363151)
//   META_IG_USER_ID    — Instagram Business user id linked to the Page
//   BASE_URL           — public origin used to build the video_url Meta fetches
//
// The studio uploads a base64 mp4 to POST /api/publish; we write it to
// public/studio-videos/<uuid>.mp4 so Meta can fetch it. Files are cleaned up
// 7 days after a successful post.

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const fetch   = require('node-fetch');
const config  = require('../config/harold');
const db      = require('../db');
const { adminAuth } = require('../middleware/auth');

const router = express.Router();

const VIDEOS_DIR = process.env.STUDIO_VIDEOS_DIR
  || path.join(__dirname, '..', 'public', 'studio-videos');
fs.mkdirSync(VIDEOS_DIR, { recursive: true });

const GRAPH_VERSION = 'v23.0';
const GRAPH_BASE    = `https://graph.facebook.com/${GRAPH_VERSION}`;

const VALID_TARGETS = new Set(['ig', 'fb']);

// 25 MB cap on incoming base64 — express.json is limited to 15mb but a base64
// payload of 18mb decodes to ~13mb of mp4, which is plenty for short Reels.
const MAX_VIDEO_BYTES = 25 * 1024 * 1024;

function metaConfig() {
  return {
    token:    process.env.META_ACCESS_TOKEN,
    pageId:   process.env.META_PAGE_ID,
    igUserId: process.env.META_IG_USER_ID,
  };
}

function publicVideoUrl(filename) {
  const base = (config.baseUrl || '').replace(/\/$/, '');
  if (!base) throw new Error('BASE_URL is not set — Meta cannot fetch the video');
  return `${base}/studio-videos/${filename}`;
}

// ── Routes ───────────────────────────────────────────────────────────────────

// POST /api/publish — body: { videoBase64, caption, scheduledAt?, targets: ['ig','fb'] }
router.post('/api/publish', adminAuth, (req, res) => {
  try {
    const { videoBase64, caption = '', scheduledAt, targets } = req.body || {};
    if (!videoBase64) return res.status(400).json({ error: 'videoBase64 required' });
    const tList = Array.isArray(targets) ? targets.filter(t => VALID_TARGETS.has(t)) : [];
    if (!tList.length) return res.status(400).json({ error: 'targets must include at least one of ig|fb' });

    const meta = metaConfig();
    if (!meta.token)  return res.status(503).json({ error: 'META_ACCESS_TOKEN not configured' });
    if (tList.includes('fb') && !meta.pageId)   return res.status(503).json({ error: 'META_PAGE_ID not configured' });
    if (tList.includes('ig') && !meta.igUserId) return res.status(503).json({ error: 'META_IG_USER_ID not configured' });

    const b64 = videoBase64.replace(/^data:video\/\w+;base64,/, '');
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) return res.status(400).json({ error: 'videoBase64 decoded to empty buffer' });
    if (buf.length > MAX_VIDEO_BYTES) {
      return res.status(413).json({ error: `Video too large (${buf.length} bytes). Max ${MAX_VIDEO_BYTES}.` });
    }

    // One file is shared by all target jobs — Meta fetches it independently.
    const filename = `${crypto.randomUUID()}.mp4`;
    const fullPath = path.join(VIDEOS_DIR, filename);
    fs.writeFileSync(fullPath, buf);

    let videoUrl;
    try { videoUrl = publicVideoUrl(filename); }
    catch (err) {
      try { fs.unlinkSync(fullPath); } catch (_) {}
      return res.status(500).json({ error: err.message });
    }

    const when = Number(scheduledAt) || Date.now();
    const createdIds = tList.map(target =>
      db.insertPublishJob({
        target,
        videoPath:   fullPath,
        videoUrl,
        caption,
        scheduledAt: when,
      }).lastInsertRowid
    );

    res.json({ jobIds: createdIds, videoUrl, scheduledAt: when });

    // Kick the scheduler immediately if it's due now — keeps the "publish now"
    // path snappy without waiting for the next 30s tick.
    if (when <= Date.now()) {
      setImmediate(() => { try { tickScheduler(); } catch (_) {} });
    }
  } catch (err) {
    console.error('Publish enqueue error:', err);
    res.status(500).json({ error: err.message || 'Failed to enqueue publish' });
  }
});

// GET /api/publish/jobs — recent jobs (most recent first)
router.get('/api/publish/jobs', adminAuth, (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const jobs = db.listPublishJobs(limit).map(jobForClient);
    res.json({ jobs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/publish/jobs/:id/cancel', adminAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = db.cancelPublishJob(id);
  if (!r.changes) return res.status(404).json({ error: 'Job not found or not cancellable' });
  res.json({ ok: true });
});

router.post('/api/publish/jobs/:id/retry', adminAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = db.retryPublishJob(id);
  if (!r.changes) return res.status(404).json({ error: 'Job not found or not retryable' });
  res.json({ ok: true });
  setImmediate(() => { try { tickScheduler(); } catch (_) {} });
});

// Public endpoint — checks that creds + IG/FB ids look configured. Useful for
// surfacing a warning in the studio UI without exposing the token.
router.get('/api/publish/status', adminAuth, (req, res) => {
  const m = metaConfig();
  res.json({
    configured: {
      ig: !!(m.token && m.igUserId),
      fb: !!(m.token && m.pageId),
    },
    hasBaseUrl: !!config.baseUrl,
  });
});

function jobForClient(j) {
  return {
    id:               j.id,
    target:           j.target,
    caption:          j.caption,
    scheduledAt:      j.scheduled_at,
    status:           j.status,
    externalPostId:   j.external_post_id,
    error:            j.error,
    attempts:         j.attempts,
    createdAt:        j.created_at,
    updatedAt:        j.updated_at,
    videoUrl:         j.video_url,
  };
}

// ── Scheduler ────────────────────────────────────────────────────────────────

let schedulerStarted = false;
let processing = false;

function startScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;
  // Process due jobs every 30s. Single instance — safe with a single Railway
  // worker. If we ever scale out, switch to a row-level lock.
  setInterval(() => { tickScheduler().catch(err => console.error('Scheduler tick error:', err)); }, 30 * 1000);
  // Daily-ish cleanup of old posted videos and stale on-disk files.
  setInterval(() => { cleanupOldFiles(); }, 6 * 60 * 60 * 1000);
  // First run after startup so jobs queued while the process was down get picked up
  setTimeout(() => { tickScheduler().catch(() => {}); cleanupOldFiles(); }, 5 * 1000);
}

async function tickScheduler() {
  if (processing) return;
  processing = true;
  try {
    const now = Date.now();
    const due = db.duePublishJobs(now);
    for (const job of due) {
      // Mark processing first so a re-entrant tick won't pick it up again.
      db.updatePublishStatus({ id: job.id, status: 'processing', incAttempts: 1 });
      try {
        const externalPostId = await processJob(job);
        db.updatePublishStatus({ id: job.id, status: 'posted', externalPostId });
        console.log(`[publish] job ${job.id} (${job.target}) → ${externalPostId}`);
      } catch (err) {
        console.error(`[publish] job ${job.id} (${job.target}) failed:`, err.message);
        db.updatePublishStatus({ id: job.id, status: 'failed', error: String(err.message || err).slice(0, 500) });
      }
    }
  } finally {
    processing = false;
  }
}

async function processJob(job) {
  const meta = metaConfig();
  if (!meta.token) throw new Error('META_ACCESS_TOKEN not configured');
  if (job.target === 'fb') {
    if (!meta.pageId) throw new Error('META_PAGE_ID not configured');
    return await postFacebookVideo({
      pageId: meta.pageId, token: meta.token,
      videoUrl: job.video_url, description: job.caption || '',
    });
  }
  if (job.target === 'ig') {
    if (!meta.igUserId) throw new Error('META_IG_USER_ID not configured');
    return await postInstagramReel({
      igUserId: meta.igUserId, token: meta.token,
      videoUrl: job.video_url, caption: job.caption || '',
    });
  }
  throw new Error(`Unknown target ${job.target}`);
}

// ── Graph API helpers ────────────────────────────────────────────────────────

async function graphPost(url, params) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) body.set(k, String(v));
  }
  const res = await fetch(url, { method: 'POST', body });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = { raw: text }; }
  if (!res.ok || json.error) {
    const msg = json.error?.message || json.raw || `HTTP ${res.status}`;
    throw new Error(`Graph ${res.status}: ${msg}`);
  }
  return json;
}

async function graphGet(url) {
  const res = await fetch(url);
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = { raw: text }; }
  if (!res.ok || json.error) {
    const msg = json.error?.message || json.raw || `HTTP ${res.status}`;
    throw new Error(`Graph ${res.status}: ${msg}`);
  }
  return json;
}

async function postFacebookVideo({ pageId, token, videoUrl, description }) {
  // Page Videos endpoint — Meta downloads from file_url asynchronously.
  // Returns { id: '<video_id>' } once the upload begins.
  const json = await graphPost(`${GRAPH_BASE}/${pageId}/videos`, {
    file_url: videoUrl,
    description,
    access_token: token,
  });
  return json.id;
}

// IG Reels publishing is a 2-step container flow. We poll status_code until
// FINISHED (typical: 10-90s depending on video length) then call media_publish.
async function postInstagramReel({ igUserId, token, videoUrl, caption }) {
  const create = await graphPost(`${GRAPH_BASE}/${igUserId}/media`, {
    media_type: 'REELS',
    video_url:  videoUrl,
    caption,
    access_token: token,
  });
  const creationId = create.id;
  if (!creationId) throw new Error('IG: no creation id returned');

  // Poll up to 5 minutes — Reels processing can take a while for longer clips.
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(5000);
    const status = await graphGet(`${GRAPH_BASE}/${creationId}?fields=status_code,status&access_token=${encodeURIComponent(token)}`);
    if (status.status_code === 'FINISHED') break;
    if (status.status_code === 'ERROR' || status.status_code === 'EXPIRED') {
      throw new Error(`IG container ${status.status_code}: ${status.status || ''}`);
    }
  }

  const publish = await graphPost(`${GRAPH_BASE}/${igUserId}/media_publish`, {
    creation_id: creationId,
    access_token: token,
  });
  return publish.id;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Cleanup ──────────────────────────────────────────────────────────────────

function cleanupOldFiles() {
  // Delete on-disk video for any job that was posted more than 7 days ago.
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  try {
    const old = db.listOldPublishedJobs(cutoff);
    for (const j of old) {
      try { fs.unlinkSync(j.video_path); } catch (_) {}
    }
  } catch (err) { console.error('cleanupOldFiles db:', err.message); }

  // Sweep any orphaned mp4s in the videos dir older than 7 days (edge case:
  // server crashed between writing the file and inserting jobs).
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(VIDEOS_DIR)) {
      if (!/\.mp4$/i.test(f)) continue;
      const p = path.join(VIDEOS_DIR, f);
      try {
        const st = fs.statSync(p);
        if (now - st.mtimeMs > 7 * 24 * 60 * 60 * 1000) fs.unlinkSync(p);
      } catch (_) {}
    }
  } catch (_) {}
}

module.exports = router;
module.exports.startScheduler = startScheduler;
module.exports.VIDEOS_DIR = VIDEOS_DIR;
