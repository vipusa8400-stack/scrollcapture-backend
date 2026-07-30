const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

const TONE_GUIDE = {
  professional: "clear, confident and corporate; no slang",
  friendly: "warm, conversational and encouraging",
  premium: "calm, refined and cinematic, like a luxury brand film",
};

const LANGUAGE_NAME = { en: "English", ms: "Bahasa Malaysia (Malay)" };

/**
 * Calls OpenAI to produce a narration script + structured scene plan.
 * Returns { script, scenes: [{ title, speech, target, action }] }
 */
async function generateScenePlan({ websiteUrl, changes, language, tone, pageOutline }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not configured on the backend. Add it in your Railway service variables.",
    );
  }

  const system = [
    "You are a senior web agency presenter.",
    "You write short spoken narration for a client walkthrough video of a website.",
    `Write every 'speech' value in ${LANGUAGE_NAME[language] || "English"}.`,
    `Tone: ${TONE_GUIDE[tone] || TONE_GUIDE.professional}.`,
    "Each scene speech must be 1-3 sentences (max ~45 words) and sound natural when spoken aloud.",
    "'target' must be a short human description of a visible element on the page (e.g. 'hero section', 'WhatsApp button', 'pricing table').",
    "'action' must be one of: highlight_zoom, zoom, highlight.",
    "Return between 3 and 8 scenes.",
  ].join(" ");

  const user = [
    `Website URL: ${websiteUrl}`,
    "",
    "Changes / points the client should hear about:",
    changes,
    "",
    "Visible elements detected on the page (text | tag | selector):",
    pageOutline.slice(0, 60).join("\n"),
    "",
    'Respond with JSON only: {"script": string, "scenes": [{"title","speech","target","action"}]}',
  ].join("\n");

  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
      temperature: 0.7,
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`OpenAI script generation failed (${res.status}): ${text.slice(0, 400)}`);
  }

  let parsed;
  try {
    const body = JSON.parse(text);
    parsed = JSON.parse(body.choices[0].message.content);
  } catch (err) {
    throw new Error(`Could not parse the AI script response: ${err.message}`);
  }

  const scenes = Array.isArray(parsed.scenes) ? parsed.scenes : [];
  const clean = scenes
    .map((s, i) => ({
      title: String(s.title || `Scene ${i + 1}`).slice(0, 80),
      speech: String(s.speech || "").trim(),
      target: String(s.target || "").trim(),
      action: ["highlight_zoom", "zoom", "highlight"].includes(s.action)
        ? s.action
        : "highlight_zoom",
    }))
    .filter((s) => s.speech.length > 0)
    .slice(0, 8);

  if (!clean.length) throw new Error("The AI did not return any usable scenes.");

  return {
    script: String(parsed.script || clean.map((s) => s.speech).join(" ")),
    scenes: clean,
  };
}

module.exports = { generateScenePlan };
