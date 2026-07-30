const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

const TONE_GUIDE = {
  professional: "clear, confident and corporate; no slang",
  friendly: "warm, conversational and encouraging",
  premium: "calm, refined and cinematic, like a luxury brand film",
};

const LANGUAGE_NAME = { en: "English", ms: "Bahasa Malaysia (Malay)" };

/** Actions the recorder can perform. */
const SCENE_ACTIONS = [
  "scroll_to",
  "move_cursor",
  "hover",
  "click",
  "open_menu",
  "open_dropdown",
  "switch_tab",
  "navigate",
  "highlight",
  "zoom_to_element",
  "zoom_out",
  "hold",
  // legacy values kept for older saved scripts
  "highlight_zoom",
  "zoom",
  "move_click_wait_zoom",
];

const CLICK_ACTIONS = new Set([
  "click",
  "open_menu",
  "open_dropdown",
  "switch_tab",
  "navigate",
  "move_click_wait_zoom",
]);

function normaliseScene(s, i) {
  const action = SCENE_ACTIONS.includes(s.action) ? s.action : "zoom_to_element";
  return {
    title: String(s.title || `Scene ${i + 1}`).slice(0, 80),
    speech: String(s.speech || "").trim(),
    target: String(s.target || "").trim(),
    action,
    selectors: Array.isArray(s.selectors)
      ? s.selectors.map((x) => String(x).trim()).filter(Boolean).slice(0, 6)
      : [],
    expectedDestination: s.expectedDestination ? String(s.expectedDestination).slice(0, 200) : "",
  };
}

/**
 * Calls OpenAI to produce a natural narration script + structured scene plan
 * with multiple selector options and a concrete action per scene.
 */
async function generateScenePlan({ websiteUrl, changes, language, tone, pageOutline }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not configured on the backend. Add it in your Railway service variables.",
    );
  }

  const system = [
    "You are a real website designer personally walking a client through the site you built for them.",
    `Speak in ${LANGUAGE_NAME[language] || "English"}. Tone: ${TONE_GUIDE[tone] || TONE_GUIDE.professional}.`,
    "Narration rules: short natural sentences, simple everyday words, friendly and confident.",
    "Personalise with the business name when it is obvious from the page.",
    "No robotic intros, no repeated descriptions, no technical jargon, no feature lists.",
    "Focus only on the most important benefits for the client's customers.",
    'Bad: "We have implemented a floating WhatsApp communication functionality in the bottom-right area."',
    'Good: "We\'ve also added a WhatsApp button here, so customers can contact you instantly."',
    "The WHOLE presentation must be short: 30-60 seconds of speech total, 3 to 6 scenes, each speech 1-2 sentences (max ~28 words).",
    "",
    "For every scene also plan the camera work:",
    `'action' must be exactly one of: ${SCENE_ACTIONS.slice(0, 12).join(", ")}.`,
    "Only choose a clicking action (click, open_menu, open_dropdown, switch_tab, navigate) when the content you describe truly requires opening a menu, tab or another page. Otherwise use zoom_to_element or highlight.",
    "'target' is a short human description of the exact element being talked about.",
    "'selectors' MUST be an array of 2-5 concrete CSS or Playwright selector guesses for that exact element, most specific first (e.g. \"nav a[href='/services']\", \"a[href*='services']\", \"text=Services\").",
    "'expectedDestination' is the href/route or #anchor the click should lead to, or \"\" when there is no click.",
    "If the speech says words like 'here', 'this button' or 'this section', the target must be that exact element.",
  ].join(" ");

  const user = [
    `Website URL: ${websiteUrl}`,
    "",
    "Changes / points the client should hear about:",
    changes,
    "",
    "Visible elements detected on the page (text | tag | selector):",
    pageOutline.slice(0, 80).join("\n"),
    "",
    'Respond with JSON only: {"script": string, "scenes": [{"title","speech","target","selectors":[],"action","expectedDestination"}]}',
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
    .map(normaliseScene)
    .filter((s) => s.speech.length > 0)
    .slice(0, 6);

  if (!clean.length) throw new Error("The AI did not return any usable scenes.");

  return {
    script: String(parsed.script || clean.map((s) => s.speech).join(" ")),
    scenes: clean,
  };
}

module.exports = { generateScenePlan, SCENE_ACTIONS, CLICK_ACTIONS, normaliseScene };
