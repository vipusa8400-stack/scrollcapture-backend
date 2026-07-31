/**
 * Natural scene timing + word-to-action synchronisation.
 *
 * Every scene gets its own Fish Audio clip. Its exact duration drives the
 * camera: a short lead-in, narration, a hold until the sentence is finished
 * and a short transition out. Cue words let the cursor arrive at the element
 * just before it is mentioned.
 */

const LEAD_MIN = 0.5;
const LEAD_MAX = 1.0;
const TRANSITION_MIN = 0.3;
const TRANSITION_MAX = 0.8;
const TAIL_AFTER_SPEECH = 0.25;

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

function stripTags(text) {
  return String(text || "")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Estimates when a cue phrase is spoken inside a clip, by its word position.
 * Returns seconds from the start of the narration (0 when not found).
 */
function estimateCueTime({ speech, cueWord, duration }) {
  const words = stripTags(speech).split(" ").filter(Boolean);
  if (!words.length || !duration) return 0;
  const cue = stripTags(cueWord).toLowerCase();
  if (!cue) return 0;

  const cueWords = cue.split(" ").filter(Boolean);
  const lower = words.map((w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""));
  let index = -1;
  for (let i = 0; i <= lower.length - cueWords.length; i++) {
    const match = cueWords.every((cw, k) =>
      lower[i + k] ? lower[i + k].includes(cw.replace(/[^\p{L}\p{N}]/gu, "")) : false,
    );
    if (match) {
      index = i;
      break;
    }
  }
  if (index < 0) {
    const first = cueWords[0].replace(/[^\p{L}\p{N}]/gu, "");
    index = lower.findIndex((w) => first && w.includes(first));
  }
  if (index < 0) return 0;
  return clamp((index / words.length) * duration, 0, duration);
}

/**
 * Builds the timing contract for one scene from its measured audio duration.
 */
function planSceneTiming({ speech, duration, cue }) {
  const speechDuration = Math.max(0.4, Number(duration) || 0);
  const leadIn = clamp(0.5 + speechDuration * 0.05, LEAD_MIN, LEAD_MAX);
  const transitionOut = clamp(0.3 + speechDuration * 0.04, TRANSITION_MIN, TRANSITION_MAX);

  const cueWord = cue && cue.cueWord ? String(cue.cueWord) : "";
  const offsetBeforeCueMs = cue && Number.isFinite(Number(cue.offsetBeforeCueMs))
    ? clamp(Number(cue.offsetBeforeCueMs), 0, 2000)
    : 500;
  const cueAt = cueWord ? estimateCueTime({ speech, cueWord, duration: speechDuration }) : 0;
  // When the cursor should start being useful, relative to narration start.
  const cursorAt = clamp(cueAt - offsetBeforeCueMs / 1000, -leadIn, speechDuration);

  return {
    leadIn,
    speechDuration,
    // The camera never leaves before the sentence is finished.
    holdDuration: speechDuration + TAIL_AFTER_SPEECH,
    transitionOut,
    cueWord,
    cueAction: (cue && cue.action) || "focus_target",
    cueAt,
    cursorAt,
    offsetBeforeCueMs,
  };
}

/** Absolute start/end timestamps for a scene on the final timeline. */
function sceneTimestamps({ timelineStart, timing, lead, hold, trail }) {
  const leadUsed = Number.isFinite(lead) ? lead : timing.leadIn;
  const holdUsed = Number.isFinite(hold) ? hold : timing.holdDuration;
  const trailUsed = Number.isFinite(trail) ? trail : timing.transitionOut;
  return {
    startSec: timelineStart,
    speechStartSec: timelineStart + leadUsed,
    speechEndSec: timelineStart + leadUsed + timing.speechDuration,
    endSec: timelineStart + leadUsed + holdUsed + trailUsed,
  };
}

module.exports = {
  planSceneTiming,
  sceneTimestamps,
  estimateCueTime,
  stripTags,
  LEAD_MIN,
  LEAD_MAX,
  TRANSITION_MIN,
  TRANSITION_MAX,
};