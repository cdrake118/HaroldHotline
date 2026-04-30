# Harold's Hotline — agent operations

A Twilio voice hotline where callers leave voicemails for Harold (a real tabby cat) and Harold "responds" via AI-generated audio. Express + SQLite, deployed on Railway via nixpacks. The studio (`/studio`) is a content pipeline that turns calls into TikTok/Reels videos.

## Verification before claiming "done"

These are the failure modes that have actually happened on this codebase. Run through this list before reporting work complete.

1. **Server code parses.** After any edit to `routes/*.js`, `server.js`, or `middleware/*.js`, run `node -e "require('./<file>')" 2>&1 | grep -v Deprecation` and confirm no errors. Cheap, catches stupid typos.
2. **External APIs / model names are real.** Don't invent OpenAI model IDs. Known good: `gpt-image-1` (not `gpt-image-2`), `gpt-4o`, `gpt-4o-mini`. `images.generate` and `images.edit` with `gpt-image-1` do **not** accept `response_format` — base64 is the default.
3. **Don't assume binaries are on PATH.** ffmpeg/ffprobe is the canonical example. The previous `nixPkgs = ["ffmpeg"]` setup did not actually put it on PATH at runtime. Current setup uses `aptPkgs = ["...", "ffmpeg"]` in `nixpacks.toml`. Debian's ffmpeg includes ffprobe; the Nix `ffmpeg` does not always.
4. **Frontend code I cannot run.** Say so explicitly when finishing a UI change. The user has to test it on Railway. Don't claim it works.
5. **State and DB migrations are additive.** SQLite migrations live in `db/index.js` and use `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE` patterns — never drop or rename in place.

## Deployment quirks (Railway)

- **Railway proxies SSE poorly.** Long-lived `text/event-stream` responses get buffered end-to-end. The video progress endpoint uses **polling** (`/api/video-progress/:jobId`), not SSE. Don't reintroduce SSE for progress reporting.
- **System packages go in `nixpacks.toml` under `aptPkgs`** with the `"..."` prefix to preserve defaults. Avoid `nixPkgs` for things like ffmpeg — Nix variants are unpredictable.
- **`HAROLD_PHOTO_URL`** and **`OG_IMAGE_URL`** are env vars for the landing page. Hosted images, not local files.
- **`AUDIO_DIR`** env var overrides the default audio directory for production.

## Auth conventions

- Single shared module: `middleware/auth.js`. Don't duplicate auth logic in route files.
- `pageAuth` for HTML page routes (redirects to `/login`).
- `adminAuth` for API routes (returns 401 JSON; accepts both Basic Auth header and `harold_auth` HMAC cookie).
- Login flow: form POSTs `/login`, server sets HttpOnly cookie, client also stores `localStorage.adminCreds` for Basic Auth on API calls.
- New API endpoints that read or modify call data must use `adminAuth`. Public endpoints (e.g. landing-page stats at `/api/stats` in `server.js`) are fine without it but should be obviously aggregate-only.

## Studio content pipeline

- `routes/studio.js` orchestrates: ElevenLabs TTS → OpenAI image gen → ffmpeg compose → polling-based progress.
- Gallery (`public/harold-refs/` for hand-uploaded refs, `public/harold-gallery/` for saved generated images) is the **default** image source. Generation is a fallback.
- Auto-generate picks a fresh ElevenLabs voice each run, tracking last 5 used in `localStorage.haroldRecentCallerVoices`.
- Default video aspect ratio is **9:16**. Captions are phrase-timed via `buildTimedCaptions`.
- **Harold's voice is fixed.** Always use `config.elevenlabsHaroldVoiceId` and `config.elevenlabsHaroldSettings` from `config/harold.js`. Never hardcode an alternate voice id in any route. The `/api/voices` filter excludes Harold's voice from the caller dropdown.

## ffmpeg drawtext gotchas

ffmpeg's filter graph parser treats bare `'` (ASCII apostrophe) as a strong-quote delimiter, **even inside `"..."`**. Any apostrophe in drawtext text will silently consume everything up to the next `'` in the filter chain, corrupting the whole graph.

Always either:
- Use the curly apostrophe `’` (U+2019) in literal text — `'Harold’s Hotline'`, not `"Harold's Hotline"`.
- Use `buildTimedCaptions` for any user-supplied text — it already replaces `'` with U+2019 and escapes `:` and `\`.

## Things to avoid

- Don't add new npm packages without a clear reason; the codebase deliberately stays close to stdlib (manual cookie parsing, no `cookie-parser`; manual SSE/polling, no `socket.io`).
- Don't add backwards-compatibility shims when changing client-side state shapes — `localStorage` is for one user (the admin), so just change it.
- Don't introduce ffprobe back. Duration parsing uses `ffmpeg -i <file>` stderr matching in `getMediaDuration`.
- Don't write big speculative refactors. Fix the immediate issue, commit, push.
