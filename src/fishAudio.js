const fs = require("fs");

const FISH_TTS_URL = "https://api.fish.audio/v1/tts";
const FISH_MODEL_URL = "https://api.fish.audio/model";

// Fixed, product-wide voice identity. Never selectable by the user or frontend.
const DEFAULT_FISH_MODEL = process.env.DEFAULT_FISH_MODEL || "S2.1_PRO";
const DEFAULT_FISH_VOICE = process.env.DEFAULT_FISH_VOICE || "Sarah";

const MODEL_HEADERS = {
  S2_1_PRO: "s2.1-pro",
  "S2.1_PRO": "s2.1-pro",
  "S2.1 PRO": "s2.1-pro",
  S1: "s1",
  "SPEECH-1.6": "speech-1.6",
};

function modelHeader() {
  const key = String(DEFAULT_FISH_MODEL).trim().toUpperCase();
  return MODEL_HEADERS[key] || "s2.1-pro";
}

const HEX_ID = /^[a-f0-9]{24,}$/i;
let cachedVoiceId = null;

/** Resolves the fixed "Sarah" voice to a Fish Audio reference_id (cached per process). */
async function resolveVoiceId(apiKey) {
  if (cachedVoiceId !== null) return cachedVoiceId;

  const explicit = (process.env.DEFAULT_FISH_VOICE_ID || "").trim();
  if (explicit) {
    cachedVoiceId = explicit;
    return cachedVoiceId;
  }
  if (HEX_ID.test(DEFAULT_FISH_VOICE.trim())) {
    cachedVoiceId = DEFAULT_FISH_VOICE.trim();
    return cachedVoiceId;
  }

  try {
    const url = `${FISH_MODEL_URL}?title=${encodeURIComponent(DEFAULT_FISH_VOICE)}&page_size=10&page_number=1`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (res.ok) {
      const data = await res.json();
      const items = Array.isArray(data?.items) ? data.items : [];
      const exact =
        items.find(
          (m) => String(m.title || "").trim().toLowerCase() === DEFAULT_FISH_VOICE.toLowerCase(),
        ) || items[0];
      cachedVoiceId = exact?._id || exact?.id || "";
    } else {
      cachedVoiceId = "";
    }
  } catch {
    cachedVoiceId = "";
  }
  return cachedVoiceId;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Calls Fish Audio and returns the raw mp3 buffer. Emotion tags stay in the text. */
async function synthesizeBuffer({ text }) {
  const apiKey = process.env.FISH_AUDIO_API_KEY;
  if (!apiKey) {
    throw new Error(
      "FISH_AUDIO_API_KEY is not configured on the backend. Add it in your Railway service variables.",
    );
  }

  const referenceId = await resolveVoiceId(apiKey);
  const body = { text, format: "mp3", mp3_bitrate: 128, normalize: true };
  if (referenceId) body.reference_id = referenceId;

  const attempts = 4;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(FISH_TTS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          model: modelHeader(),
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        const retryable = res.status === 429 || res.status >= 500;
        const err = new Error(`Fish Audio TTS failed (${res.status}): ${errText.slice(0, 300)}`);
        if (!retryable) throw err;
        lastError = err;
      } else {
        const buffer = Buffer.from(await res.arrayBuffer());
        if (buffer.length < 512) {
          lastError = new Error("Fish Audio returned an empty audio file.");
        } else {
          return buffer;
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Fish Audio TTS failed (4")) throw err;
      lastError = err;
    }

    if (attempt < attempts) await sleep(700 * attempt);
  }
  throw lastError || new Error("Fish Audio TTS failed.");
}

/** Synthesizes speech with Fish Audio and writes an mp3 to outputPath. */
async function synthesizeSpeech({ text, outputPath }) {
  const buffer = await synthesizeBuffer({ text });
  await fs.promises.writeFile(outputPath, buffer);
  return buffer.length;
}

module.exports = { synthesizeSpeech, synthesizeBuffer, DEFAULT_FISH_MODEL, DEFAULT_FISH_VOICE };
