// Shared TTL cache for website maps, screenshots, validated selectors and voice clips.
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_TTL_MS = Number(process.env.CACHE_TTL_MS || 20 * 60 * 1000);
const store = new Map();

const VOICE_DIR = path.join(process.env.CACHE_DIR || os.tmpdir(), "scrollcapture-voice-cache");

function key(...parts) {
  return crypto.createHash("sha1").update(parts.map(String).join("::")).digest("hex");
}

function get(k) {
  const hit = store.get(k);
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    store.delete(k);
    return null;
  }
  return hit.value;
}

function set(k, value, ttl = DEFAULT_TTL_MS) {
  store.set(k, { value, expires: Date.now() + ttl });
  return value;
}

async function remember(k, factory, ttl = DEFAULT_TTL_MS) {
  const hit = get(k);
  if (hit) return hit;
  const value = await factory();
  return set(k, value, ttl);
}

async function voiceCachePath(text, voiceId, model) {
  await fs.promises.mkdir(VOICE_DIR, { recursive: true });
  return path.join(VOICE_DIR, `${key(text, voiceId, model)}.mp3`);
}

async function readVoiceCache(file) {
  try {
    const stat = await fs.promises.stat(file);
    if (stat.size < 512) return null;
    return await fs.promises.readFile(file);
  } catch {
    return null;
  }
}

async function writeVoiceCache(file, buffer) {
  try {
    await fs.promises.writeFile(file, buffer);
  } catch {
    /* cache writes are best effort */
  }
}

function clearPrefix(prefix) {
  for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of store) if (now > v.expires) store.delete(k);
}, 60_000).unref?.();

module.exports = {
  key,
  get,
  set,
  remember,
  clearPrefix,
  voiceCachePath,
  readVoiceCache,
  writeVoiceCache,
  VOICE_DIR,
};