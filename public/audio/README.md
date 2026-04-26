# Harold's Audio Files

Place your audio files here. All files must be in a format Twilio supports:
**MP3, WAV, AIFF, GSM, or μ-law** — MP3 at 128kbps works well.

## Required files

| File | Description | Suggested length |
|---|---|---|
| `hold-music.mp3` | Waiting room / hold music | ~5–8 seconds |
| `harold-meowing-short.mp3` | Harold meowing (confession intro) | ~3–5 seconds |
| `harold-meowing-long.mp3` | Harold meowing (full conversation), **pre-faded at the end** | ~10–12 seconds |

## Setting it up

Once your files are here, set these env vars in your `.env` so the server
references them by full public URL:

```
HOLD_MUSIC_URL=https://your-server.com/audio/hold-music.mp3
HAROLD_MEOWING_SHORT_URL=https://your-server.com/audio/harold-meowing-short.mp3
HAROLD_MEOWING_LONG_URL=https://your-server.com/audio/harold-meowing-long.mp3
```

Or, if you'd rather host the files elsewhere (S3, Cloudflare R2, etc.), just
point the env vars at those URLs instead.

## No audio files yet?

The hotline works without them — it will use silent pauses of the appropriate
length in place of each audio clip. You can add audio incrementally.

## Recording Harold

Use your phone's voice memo app and record Harold mid-meow. For the long clip,
record 15+ seconds and then use Audacity or ffmpeg to add a fade-out at the end:

```bash
ffmpeg -i harold-raw.m4a -af "afade=t=out:st=9:d=2" -t 11 harold-meowing-long.mp3
```
