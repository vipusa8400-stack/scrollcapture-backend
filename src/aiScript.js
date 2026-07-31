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
  const cue = s.cue && typeof s.cue === "object" ? s.cue : {};
  return {
    title: String(s.title || `Scene ${i + 1}`).slice(0, 80),
    speech: String(s.speech || "").trim(),
    target: String(s.target || "").trim(),
    action,
    cue: {
      cueWord: String(cue.cueWord || s.cueWord || "").slice(0, 60),
      action: String(cue.action || s.cueAction || "focus_target").slice(0, 40),
      offsetBeforeCueMs: Number.isFinite(Number(cue.offsetBeforeCueMs))
        ? Math.max(0, Math.min(2000, Number(cue.offsetBeforeCueMs)))
        : 500,
    },
    selectors: Array.isArray(s.selectors)
      ? s.selectors.map((x) => String(x).trim()).filter(Boolean).slice(0, 6)
      : [],
    expectedDestination: s.expectedDestination ? String(s.expectedDestination).slice(0, 200) : "",
  };
}

/** Shared human-script rules for both presentation and outreach modes. */
const SCRIPT_RULES = [
  "Sound like a real website designer talking to the client, not like marketing copy.",
  "Short sentences. Simple everyday words. Speak directly to the client using 'you' and 'your'.",
  "Mention the business name naturally once or twice, never in every sentence.",
  "Focus on what the customer gains. No technical terms, no exaggerated sales language.",
  "No repeated phrases, no long introduction, one main point per scene.",
  "Whole video stays around 30-60 seconds of speech: 3-6 scenes, 1-2 sentences each (max ~28 words).",
  'Bad: "We have implemented an advanced communication integration."',
  'Good: "We\'ve added a WhatsApp button here, so customers can contact you instantly."',
].join(" ");

const CUE_RULES = [
  "For every scene also return a 'cue' object that synchronises the cursor with the words:",
  '{"cueWord": exact short phrase from the speech naming the element (e.g. "WhatsApp button"), "action": one of focus_target|highlight|click|hover, "offsetBeforeCueMs": 300-800}.',
  "The cueWord MUST appear verbatim inside that scene's speech so the cursor can arrive just before it is spoken.",
].join(" ");

/**
 * Calls OpenAI to produce a natural narration script + structured scene plan
 * with multiple selector options and a concrete action per scene.
 */
async function generateScenePlan({
  websiteUrl,
  changes,
  language,
  tone,
  pageOutline,
  strategy = null,
  scenePlan = null,
}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not configured on the backend. Add it in your Railway service variables.",
    );
  }

  if (Array.isArray(scenePlan) && scenePlan.length) {
    return narratePlannedScenes({
      websiteUrl,
      changes,
      language,
      tone,
      strategy,
      scenePlan,
      apiKey,
    });
  }

  const system = [
    "You are a real website designer personally walking a client through the site you built for them.",
    `Speak in ${LANGUAGE_NAME[language] || "English"}. Tone: ${TONE_GUIDE[tone] || TONE_GUIDE.professional}.`,
    "Narration rules: short natural sentences, simple everyday words, friendly and confident.",
    "Personalise with the business name when it is obvious from the page.",
    "No robotic intros, no repeated descriptions, no technical jargon, no feature lists.",
    SCRIPT_RULES,
    CUE_RULES,
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
    'Respond with JSON only: {"script": string, "scenes": [{"title","speech","target","selectors":[],"action","expectedDestination","cue":{"cueWord","action","offsetBeforeCueMs"}}]}',
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

/** Maps a planned scene onto the action vocabulary the recorder already understands. */
function actionForPlan(planned) {
  const nav = planned.navigationActions && planned.navigationActions[0];
  if (nav) {
    if (nav.action === "open_accordion") return "click";
    return SCENE_ACTIONS.includes(nav.action) ? nav.action : "click";
  }
  if (planned.framing.mode === "wide_context") return "scroll_to";
  if (planned.visualActions.includes("highlight_group") && planned.isLargeSection)
    return "zoom_to_element";
  return "zoom_to_element";
}

/**
 * Writes the narration for an already-planned scene list. The visual plan is
 * authoritative — the AI only supplies the words for each planned scene.
 */
async function narratePlannedScenes({
  websiteUrl,
  changes,
  language,
  tone,
  strategy,
  scenePlan,
  apiKey,
}) {
  const system = [
    "You are a real website designer personally walking a client through the site you built for them.",
    `Speak in ${LANGUAGE_NAME[language] || "English"}. Tone: ${TONE_GUIDE[tone] || TONE_GUIDE.professional}.`,
    "You are given a FIXED scene plan. Write one short narration for each scene, in the same order.",
    "Do not add, remove or reorder scenes. Do not describe the camera work.",
    SCRIPT_RULES,
    CUE_RULES,
    strategy && strategy.mode === "outreach"
      ? "This is a cold-outreach demo: say early that this demo was made specifically for this business, show the main benefits, mention the package price, domain, hosting and support where the plan asks for it, and end with a soft, low-pressure call to action."
      : "This is a client walkthrough of completed changes: explain each finished change clearly and simply, one change per scene.",
    "JSON only.",
  ].join(" ");

  const user = [
    `Website: ${websiteUrl}`,
    "",
    "Strategy:",
    JSON.stringify(strategy || {}),
    "",
    "Client notes / changes:",
    changes,
    "",
    "Scene plan:",
    JSON.stringify(
      scenePlan.map((s) => ({
        sceneId: s.sceneId,
        targetName: s.targetName,
        targetType: s.targetType,
        purpose: s.purpose,
        narrationGoal: s.narrationGoal,
        estimatedDuration: s.estimatedDuration,
      })),
    ),
    "",
    'Respond with JSON: {"scenes": [{"sceneId": string, "title": string, "speech": string, "cue": {"cueWord": string, "action": string, "offsetBeforeCueMs": number}}]}',
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
      temperature: 0.7,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`OpenAI narration failed (${res.status}): ${text.slice(0, 400)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(JSON.parse(text).choices[0].message.content);
  } catch (err) {
    throw new Error(`Could not parse the AI narration response: ${err.message}`);
  }

  const spoken = Array.isArray(parsed.scenes) ? parsed.scenes : [];
  const scenes = scenePlan
    .map((planned, i) => {
      const match =
        spoken.find((s) => String(s.sceneId || "") === planned.sceneId) || spoken[i] || {};
      const speech = String(match.speech || "").trim();
      if (!speech) return null;
      return {
        title: String(match.title || planned.targetName || `Scene ${i + 1}`).slice(0, 80),
        speech,
        target: planned.targetName,
        action: actionForPlan(planned),
        cue: normaliseScene({ ...match, speech }, i).cue,
        selectors: planned.selectorCandidates.slice(0, 6),
        selector: planned.selectorCandidates[0] || null,
        expectedDestination:
          (planned.navigationActions[0] && planned.navigationActions[0].expectedDestination) || "",
        plan: planned,
      };
    })
    .filter(Boolean);

  if (!scenes.length) throw new Error("The AI did not return narration for the planned scenes.");

  return { script: scenes.map((s) => s.speech).join("\n\n"), scenes };
}

module.exports = {
  generateScenePlan,
  narratePlannedScenes,
  actionForPlan,
  SCENE_ACTIONS,
  CLICK_ACTIONS,
  normaliseScene,
};
