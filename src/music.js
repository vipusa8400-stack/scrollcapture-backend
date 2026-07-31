// Background music beds. Real audio files can be supplied through MUSIC_DIR
// (<style>.mp3); otherwise a soft synthesized pad is generated with FFmpeg.
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const MUSIC_DIR = process.env.MUSIC_DIR || "";

const STYLES = {
  none: null,
  "soft-corporate": { tones: [196, 293.66, 392], gain: 0.16, tremolo: 0.6 },
  calm: { tones: [174.61, 261.63, 349.23], gain: 0.13, tremolo: 0.25 },
  premium: { tones: [146.83, 220, 329.63], gain: 0.15, tremolo: 0.4 },
  upbeat: { tones: [261.63, 329.63, 493.88], gain: 0.18, tremolo: 1.6 },
};

const MUSIC_STYLE_IDS = Object.keys(STYLES);

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} failed (${code}): ${stderr.slice(-800)}`)),
    );
  });
}

async function fileBed(style) {
  if (!MUSIC_DIR) return null;
  for (const ext of ["mp3", "m4a", "wav"]) {
    const candidate = path.join(MUSIC_DIR, `${style}.${ext}`);
    try {
      await fs.promises.access(candidate);
      return candidate;
    } catch {
      /* try next */
    }
  }
  return null;
}

// Builds a looped/synthesized music bed of exactly `duration` seconds.
async function buildMusicBed(style, duration, outPath) {
  const preset = STYLES[style];
  if (!preset) return null;
  const seconds = Math.max(2, Math.ceil(duration));
  const supplied = await fileBed(style);

  if (supplied) {
    await run("ffmpeg", [
      "-y",
      "-stream_loop", "-1",
      "-i", supplied,
      "-t", String(seconds),
      "-af", `volume=${preset.gain},afade=t=in:d=1.5,afade=t=out:st=${Math.max(0, seconds - 2)}:d=2`,
      "-c:a", "aac",
      "-b:a", "128k",
      outPath,
    ]);
    return outPath;
  }

  const inputs = [];
  const mixLabels = [];
  preset.tones.forEach((freq, i) => {
    inputs.push("-f", "lavfi", "-i", `sine=frequency=${freq}:duration=${seconds}:sample_rate=44100`);
    mixLabels.push(`[${i}:a]`);
  });
  const filter =
    `${mixLabels.join("")}amix=inputs=${preset.tones.length}:normalize=1[m];` +
    `[m]tremolo=f=${preset.tremolo}:d=0.4,lowpass=f=1200,aecho=0.8:0.7:60:0.25,` +
    `volume=${preset.gain},afade=t=in:d=1.5,afade=t=out:st=${Math.max(0, seconds - 2)}:d=2[out]`;

  await run("ffmpeg", [
    "-y",
    ...inputs,
    "-filter_complex", filter,
    "-map", "[out]",
    "-t", String(seconds),
    "-c:a", "aac",
    "-b:a", "128k",
    outPath,
  ]);
  return outPath;
}

// Mixes narration over music, ducking the bed whenever Sarah is speaking.
async function mixNarrationWithMusic(narrationPath, musicPath, outPath) {
  const filter =
    "[1:a]aresample=44100,asplit=2[n1][sc];" +
    "[0:a]aresample=44100[m0];" +
    "[m0][sc]sidechaincompress=threshold=0.02:ratio=12:attack=25:release=450:makeup=1[duck];" +
    "[duck][n1]amix=inputs=2:duration=longest:dropout_transition=0,alimiter=limit=0.95[out]";
  await run("ffmpeg", [
    "-y",
    "-i", musicPath,
    "-i", narrationPath,
    "-filter_complex", filter,
    "-map", "[out]",
    "-c:a", "aac",
    "-b:a", "160k",
    outPath,
  ]);
  return outPath;
}

module.exports = { MUSIC_STYLE_IDS, buildMusicBed, mixNarrationWithMusic };