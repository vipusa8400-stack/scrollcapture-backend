# ScrollCapture Backend

Node.js + Express + Playwright (Chromium) + FFmpeg service that renders smooth
scrolling website videos for the ScrollCapture frontend.

## Endpoints

- `GET /health` — liveness probe.
- `POST /api/jobs` — create a render job. JSON body fields:
  - `websiteUrl` (string, required)
  - `device` — `desktop` or `mobile`
  - `aspectRatio` — `vertical`, `square`, or `horizontal` (also accepts `9:16`, `1:1`, `16:9`)
  - `scrollSpeed` — `slow`, `normal`, or `fast`
  - `duration` — one of `10, 15, 30, 45, 60` (seconds)
  - `format` — `mp4`, `webm`, or `gif`
- `GET /api/jobs/:jobId` — poll status. Returns `id`, `status`, `step`,
  `progress` (0-100), `estimatedSecondsRemaining`, `downloadUrl`, `fileSize`,
  `format`.
- `GET /api/jobs/:jobId/download` — stream the rendered file (only when
  `status === "completed"`).

`status` is one of: `queued`, `opening_page`, `loading_content`, `scrolling`,
`rendering`, `completed`, `failed`.

## Security

- URL validation blocks non-http(s), `localhost`, `*.local`, `*.internal`,
  private/loopback/link-local/multicast IPv4 and IPv6 ranges, and DNS-resolves
  the host to reject domains that point at private IPs.
- Jobs run one at a time (MVP) to keep memory and CPU predictable.
- Rendered files must be larger than 10 KB or the job is marked `failed`.
- Temporary files are deleted 30 minutes after job creation.

## Environment

- `PORT` — Listening port (Railway sets this automatically).
- `ALLOWED_ORIGIN` — Comma-separated list of allowed CORS origins. Omit for `*`.

## Local development

```sh
npm install
npx playwright install chromium
# Requires ffmpeg on your PATH.
npm start
```

## Deploy to Railway

1. Push this repo to GitHub (`vipusa8400-stack/scrollcapture-backend`).
2. In Railway, **New Project → Deploy from GitHub Repo** and pick the repo.
3. Railway auto-detects the `Dockerfile`. No build command needed.
4. Set variables:
   - `ALLOWED_ORIGIN` = your ScrollCapture frontend origin, e.g.
     `https://your-app.lovable.app`
5. Deploy. Railway assigns a public URL like
   `https://scrollcapture-backend-production.up.railway.app`.
6. In the ScrollCapture frontend project, set the secret
   `VIDEO_GENERATOR_API_URL` to that Railway URL.

The `Dockerfile` is based on `mcr.microsoft.com/playwright:v1.47.2-jammy`
(ships Chromium + all shared libs) and installs `ffmpeg` on top, so no extra
system setup is needed on Railway.

## Notes

- Jobs are held in-memory. Restarting the process drops in-flight jobs — fine
  for MVP; swap in Redis/Postgres later if you need durability.
- Concurrency is intentionally 1. Increase carefully: Chromium + FFmpeg are
  memory-hungry.
## AI Website Presentation

Endpoints:

- `POST /api/presentations` — body: `websiteUrl`, `changes`, `language` (`en` | `ms`),
  `voiceId` (Fish Audio reference id, optional), `tone` (`professional` | `friendly` | `premium`),
  `device` (`desktop` | `mobile`), `subtitles` (boolean)
- `GET /api/presentations/:jobId`
- `GET /api/presentations/:jobId/download`

Required Railway environment variables:

- `OPENAI_API_KEY` — used to generate the narration script and scene plan (JSON)
- `OPENAI_MODEL` — optional, defaults to `gpt-4o-mini`
- `FISH_AUDIO_API_KEY` — used for text-to-speech
- `DEFAULT_FISH_MODEL` — fixed TTS model, defaults to `S2.1_PRO`
- `DEFAULT_FISH_VOICE` — fixed reference voice, defaults to `Sarah`
- `DEFAULT_FISH_VOICE_ID` — optional: exact Fish Audio `reference_id` for the voice above (skips the name lookup)

The voice is never chosen by the frontend: every TTS request uses the model/voice above,
and failed calls are retried automatically (429 / 5xx, 4 attempts with backoff).
- `FISH_AUDIO_MODEL` — optional, defaults to `speech-1.6`

Both keys are only ever read on the backend; the frontend never sees them.
