const fs = require("fs");

const FISH_TTS_URL = "https://api.fish.audio/v1/tts";

/** Synthesizes speech with Fish Audio and writes an mp3 to outputPath. */
async function synthesizeSpeech({ text, voiceId, outputPath }) {
  const apiKey = process.env.FISH_AUDIO_API_KEY;
  if (!apiKey) {
    throw new Error(
      "FISH_AUDIO_API_KEY is not configured on the backend. Add it in your Railway service variables.",
    );
  }

  const body = { text, format: "mp3", mp3_bitrate: 128, normalize: true };
  if (voiceId) body.reference_id = voiceId;

  const res = await fetch(FISH_TTS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      model: process.env.FISH_AUDIO_MODEL || "speech-1.6",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Fish Audio TTS failed (${res.status}): ${errText.slice(0, 300)}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < 512) throw new Error("Fish Audio returned an empty audio file.");
  await fs.promises.writeFile(outputPath, buffer);
  return buffer.length;
}

module.exports = { synthesizeSpeech };
