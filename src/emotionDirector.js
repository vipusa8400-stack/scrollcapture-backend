const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const { SCENE_ACTIONS } = require("./aiScript");

/** Emotion tags that Fish Audio understands well. */
const EMOTION_TAGS = [
  "friendly",
  "excited",
  "confident",
  "professional",
  "calm",
  "warm",
  "serious",
  "curious",
  "laughing",
  "surprised",
];

const EMOTION_STYLES = {
  auto: "Let the content decide. Pick the most natural emotion for each moment like a professional presenter.",
  professional: "Consistently professional and clear. Mostly [professional] and [confident].",
  friendly: "Consistently warm and conversational. Mostly [friendly] and [warm].",
  excited: "Energetic and enthusiastic throughout. Mostly [excited], softened by [friendly].",
  confident: "Assured and authoritative throughout. Mostly [confident] and [professional].",
  calm: "Relaxed, unhurried and reassuring. Mostly [calm] and [warm].",
  warm: "Personal, caring and appreciative. Mostly [warm] and [friendly].",
  luxury: "Refined, cinematic and premium, like a luxury brand film. Mostly [calm] and [confident].",
  corporate: "Formal boardroom delivery. Mostly [professional] and [serious].",
  "sales-pitch": "Persuasive and benefit-driven with momentum. Mostly [confident] and [excited].",
  storytelling: "Narrative and engaging, building curiosity. Mostly [curious], [warm] and [excited].",
};

const EMOTION_STYLE_IDS = Object.keys(EMOTION_STYLES);

const TAG_RE = /\[(?:pause:\s*[\d.]+s?|[a-z_-]+)\]/gi;

/** Removes emotion / pause tags so the text can be used for subtitles. */
function stripEmotionTags(text) {
  return String(text || "")
    .replace(TAG_RE, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Renders the scene list as a single editable, tagged script. */
function scenesToScript(scenes) {
  return scenes
    .map((s) =>
      [
        `## ${s.title}`,
        `@target: ${s.target}`,
        `@action: ${s.action}`,
        s.selectors && s.selectors.length ? `@selectors: ${s.selectors.join(" | ")}` : null,
        s.expectedDestination ? `@destination: ${s.expectedDestination}` : null,
        s.speech.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
}

/** Parses the editable script back into scenes. Unknown fields fall back to the original scene. */
function scriptToScenes(script, fallbackScenes = []) {
  const blocks = String(script || "")
    .split(/\n(?=##\s)/)
    .map((b) => b.trim())
    .filter(Boolean);

  const scenes = blocks.map((block, i) => {
    const lines = block.split("\n");
    const base = fallbackScenes[i] || {};
    let title = base.title || `Scene ${i + 1}`;
    let target = base.target || "";
    let action = base.action || "zoom_to_element";
    let selectors = Array.isArray(base.selectors) ? base.selectors : [];
    let expectedDestination = base.expectedDestination || "";
    const speechLines = [];

    for (const line of lines) {
      const t = line.trim();
      if (t.startsWith("##")) {
        title = t.replace(/^##\s*/, "").slice(0, 80) || title;
      } else if (/^@target:/i.test(t)) {
        target = t.replace(/^@target:\s*/i, "").trim();
      } else if (/^@action:/i.test(t)) {
        const a = t.replace(/^@action:\s*/i, "").trim();
        if (SCENE_ACTIONS.includes(a)) action = a;
      } else if (/^@selectors:/i.test(t)) {
        selectors = t
          .replace(/^@selectors:\s*/i, "")
          .split("|")
          .map((x) => x.trim())
          .filter(Boolean);
      } else if (/^@destination:/i.test(t)) {
        expectedDestination = t.replace(/^@destination:\s*/i, "").trim();
      } else {
        speechLines.push(line);
      }
    }

    return {
      title,
      target,
      action,
      selectors,
      expectedDestination,
      speech: speechLines.join("\n").trim(),
      selector: base.selector || selectors[0] || null,
      plan: base.plan || null,
    };
  });

  return scenes.filter((s) => stripEmotionTags(s.speech).length > 0).slice(0, 8);
}

/**
 * Rewrites every scene speech with Fish Audio compatible emotion tags.
 * Returns the same scene objects with tagged `speech` values.
 */
async function applyEmotionDirection({ scenes, emotionStyle, language, changes }) {
  const style = EMOTION_STYLES[emotionStyle] ? emotionStyle : "auto";
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not configured on the backend. Add it in your Railway service variables.",
    );
  }

  const system = [
    "You are an AI Emotion Director for a text-to-speech voice-over.",
    "You receive presentation scenes and rewrite each 'speech' so it sounds like a real human presenter.",
    `Insert Fish Audio emotion tags on their own line before the sentence they affect. Allowed tags: ${EMOTION_TAGS.map((t) => `[${t}]`).join(", ")}.`,
    "Use tags sparingly: at most ONE emotion tag per scene, and only in about half of the scenes.",
    "Most scenes should have no tag at all. Only tag a scene where the feeling genuinely changes.",
    "A timing tag like [pause:0.6s] is allowed at most once in the whole script.",
    "Do not translate, do not change the meaning, and do not add new claims about the website.",
    `Emotion style: ${EMOTION_STYLES[style]}`,
    "The first scene should open warmly and the last scene should close with [warm] gratitude.",
    "Keep the language exactly as provided (do not switch languages).",
    'Return JSON only: {"scenes":[{"index":number,"speech":string}]}',
  ].join(" ");

  const user = [
    `Language: ${language === "ms" ? "Bahasa Malaysia" : "English"}`,
    `Context (website changes): ${changes}`,
    "",
    "Scenes:",
    JSON.stringify(scenes.map((s, i) => ({ index: i, title: s.title, speech: stripEmotionTags(s.speech) }))),
  ].join("\n");

  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
      temperature: 0.6,
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Emotion director failed (${res.status}): ${text.slice(0, 400)}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(JSON.parse(text).choices[0].message.content);
  } catch (err) {
    throw new Error(`Could not parse the emotion director response: ${err.message}`);
  }

  const byIndex = new Map();
  for (const item of Array.isArray(parsed.scenes) ? parsed.scenes : []) {
    const idx = Number(item.index);
    const speech = String(item.speech || "").trim();
    if (Number.isInteger(idx) && speech) byIndex.set(idx, speech);
  }

  return scenes.map((s, i) => ({ ...s, speech: byIndex.get(i) || s.speech }));
}

module.exports = {
  EMOTION_TAGS,
  EMOTION_STYLES,
  EMOTION_STYLE_IDS,
  stripEmotionTags,
  scenesToScript,
  scriptToScenes,
  applyEmotionDirection,
};
