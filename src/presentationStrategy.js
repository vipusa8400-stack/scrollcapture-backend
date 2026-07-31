/**
 * Presentation strategy + detailed scene planning.
 * Runs BEFORE the narration script so the video is planned, not improvised.
 */

const { summariseMap } = require("./websiteMap");

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

const VISUAL_ACTIONS = [
  "scroll_to",
  "fit_section",
  "zoom_to_element",
  "highlight",
  "highlight_group",
  "move_cursor",
  "hover",
  "hold",
  "zoom_out",
];

const NAV_ACTIONS = ["click", "open_menu", "open_dropdown", "switch_tab", "open_accordion", "navigate"];
const FRAMING_MODES = [
  "show_entire_section",
  "focus_element",
  "show_group",
  "show_context_and_target",
  "wide_overview",
  "mobile_showcase",
];
const FALLBACKS = ["show_section_wide", "show_nearest_heading", "show_page_top", "skip_scene"];

async function callOpenAI({ system, user, temperature = 0.5 }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not configured on the backend. Add it in your Railway service variables.",
    );
  }
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
      temperature,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenAI request failed (${res.status}): ${text.slice(0, 400)}`);
  try {
    return JSON.parse(JSON.parse(text).choices[0].message.content);
  } catch (err) {
    throw new Error(`Could not parse the AI response: ${err.message}`);
  }
}

/** Step 3 — presentation strategy. */
async function createStrategy({ websiteUrl, changes, language, tone, mode, websiteMap }) {
  const outreach = mode === "outreach";
  const system = [
    "You are a senior video presentation director planning a short website walkthrough video.",
    outreach
      ? "MODE: AI Cold Outreach. The video is a personalised demo sent to a prospect. Show the demo website, the business benefits, the price, the domain, hosting, support, and end with a soft, non-pushy call to action."
      : "MODE: AI Website Presentation. The video explains the completed changes to the existing client, clearly and confidently.",
    "Pick only sections that genuinely help the viewer. Skip filler, duplicated or empty sections.",
    "Large sections such as pricing, plans, services grids and testimonials must be shown ENTIRELY, never partially.",
    "Answer with JSON only.",
  ].join(" ");

  const user = [
    `Website: ${websiteUrl}`,
    `Language: ${language}. Tone: ${tone}.`,
    "",
    "Client notes / changes:",
    changes,
    "",
    "Website map:",
    summariseMap(websiteMap),
    "",
    'Respond with JSON: {"videoPurpose": string, "targetViewer": string, "presentationMode": string,',
    '"keyPoints": [3-6 strings], "sectionsToSkip": [string sectionIds or names],',
    '"sceneOrder": [sectionIds in the best order], "businessBenefits": [strings],',
    '"finalCta": string, "targetDurationSeconds": number}',
  ].join("\n");

  const raw = await callOpenAI({ system, user, temperature: 0.4 });
  const arr = (v, n) => (Array.isArray(v) ? v.map((x) => String(x).slice(0, 200)).slice(0, n) : []);
  return {
    mode: outreach ? "outreach" : "presentation",
    videoPurpose: String(raw.videoPurpose || "").slice(0, 400),
    targetViewer: String(raw.targetViewer || "").slice(0, 200),
    presentationMode: String(raw.presentationMode || (outreach ? "cold outreach demo" : "client walkthrough")).slice(0, 120),
    keyPoints: arr(raw.keyPoints, 6),
    sectionsToSkip: arr(raw.sectionsToSkip, 12),
    sceneOrder: arr(raw.sceneOrder, 8),
    businessBenefits: arr(raw.businessBenefits, 6),
    finalCta: String(raw.finalCta || "").slice(0, 300),
    targetDurationSeconds: Math.min(
      120,
      Math.max(20, Number(raw.targetDurationSeconds) || (outreach ? 60 : 45)),
    ),
  };
}

function normalisePlannedScene(s, i, websiteMap) {
  const id = String(s.sceneId || `scene-${String(i + 1).padStart(2, "0")}`).slice(0, 40);
  const targetName = String(s.targetName || s.target || "").slice(0, 120);
  const mapped =
    websiteMap.sections.find(
      (sec) =>
        sec.sectionId === s.sectionId ||
        (targetName && sec.heading && sec.heading.toLowerCase() === targetName.toLowerCase()) ||
        (targetName && sec.type === targetName.toLowerCase()),
    ) || null;

  const selectorCandidates = Array.from(
    new Set(
      [
        ...(Array.isArray(s.selectorCandidates) ? s.selectorCandidates : []),
        ...(mapped ? mapped.selectorCandidates : []),
      ]
        .map((x) => String(x).trim())
        .filter(Boolean),
    ),
  ).slice(0, 8);

  const targetType = String(s.targetType || (mapped ? "section" : "element")).slice(0, 30);
  const large = mapped ? mapped.isLargeSection : targetType === "section";
  const isPricing = Boolean(
    (mapped && mapped.type === "pricing") || /pricing|plan|package/i.test(targetName),
  );
  const framingIn = s.framing || {};
  let mode = FRAMING_MODES.includes(framingIn.mode)
    ? framingIn.mode
    : large || targetType === "section"
      ? "show_entire_section"
      : "focus_element";
  // Pricing and other tall grids are always framed wide so nothing is cropped.
  if (isPricing || large) {
    if (mode === "focus_element") mode = "show_entire_section";
  }

  const preferredZoom = Math.min(
    1.8,
    Math.max(
      1,
      Number(framingIn.preferredZoom) ||
        (mode === "show_entire_section" ? 1.1 : targetType === "button" ? 1.6 : 1.35),
    ),
  );
  const cappedZoom =
    mode === "show_entire_section" || mode === "show_group" || mode === "wide_overview"
      ? Math.min(preferredZoom, 1.25)
      : preferredZoom;

  return {
    sceneId: id,
    sectionId: mapped ? mapped.sectionId : s.sectionId || null,
    purpose: String(s.purpose || "").slice(0, 200),
    route: String(s.route || (mapped ? mapped.route : "/")).slice(0, 200),
    targetName: targetName || (mapped ? mapped.heading || mapped.type : "Section"),
    targetType,
    selectorCandidates,
    navigationActions: (Array.isArray(s.navigationActions) ? s.navigationActions : [])
      .map((a) => (typeof a === "string" ? { action: a } : a))
      .filter((a) => a && NAV_ACTIONS.includes(String(a.action)))
      .slice(0, 3)
      .map((a) => ({
        action: String(a.action),
        selector: a.selector ? String(a.selector).slice(0, 200) : null,
        expectedDestination: a.expectedDestination
          ? String(a.expectedDestination).slice(0, 200)
          : "",
      })),
    visualActions: (Array.isArray(s.visualActions) ? s.visualActions : [])
      .map((a) => String(a))
      .filter((a) => VISUAL_ACTIONS.includes(a))
      .slice(0, 6),
    framing: {
      mode,
      preferredZoom: Number(cappedZoom.toFixed(2)),
      minimumPadding: Math.min(80, Math.max(40, Number(framingIn.minimumPadding) || 56)),
    },
    narrationGoal: String(s.narrationGoal || s.purpose || "").slice(0, 200),
    estimatedDuration: Math.min(14, Math.max(3, Number(s.estimatedDuration) || 6)),
    fallbackBehavior: FALLBACKS.includes(s.fallbackBehavior)
      ? s.fallbackBehavior
      : "show_section_wide",
    isLargeSection: Boolean(large),
    isPricing,
    multiShot: isPricing || Boolean(large),
  };
}

/** Step 4 — detailed scene plan (strict structured JSON, no vague instructions). */
async function planScenes({ websiteUrl, changes, strategy, websiteMap }) {
  const system = [
    "You are a technical video scene planner. You output strict machine-readable scene plans.",
    "Every scene must name an exact target with real selector candidates copied from the website map.",
    'Vague instructions such as "zoom on pricing" are forbidden.',
    `framing.mode must be one of: ${FRAMING_MODES.join(", ")}.`,
    "Large sections (pricing, plans, services grid, testimonials, gallery) MUST use show_entire_section or show_group with preferredZoom between 1.0 and 1.25, so nothing is cut off.",
    "Card, plan or form targets use focus_element with preferredZoom 1.2 to 1.5. Single small buttons or icons use focus_element with 1.4 to 1.8.",
    "Pricing: always show every plan card first; only after that may a second scene focus the recommended plan. Never crop a plan name, price or CTA.",
    "minimumPadding must be between 40 and 80.",
    `visualActions must be chosen from: ${VISUAL_ACTIONS.join(", ")}.`,
    `navigationActions must be chosen from: ${NAV_ACTIONS.join(", ")} and only when the target truly needs a menu, tab, accordion or route change.`,
    `fallbackBehavior must be one of: ${FALLBACKS.join(", ")}.`,
    "Return 3 to 6 scenes total. JSON only.",
  ].join(" ");

  const user = [
    `Website: ${websiteUrl}`,
    "",
    "Strategy:",
    JSON.stringify(strategy),
    "",
    "Client notes / changes:",
    changes,
    "",
    "Website map:",
    summariseMap(websiteMap),
    "",
    'Respond with JSON: {"scenes": [{"sceneId","sectionId","purpose","route","targetName","targetType",',
    '"selectorCandidates":[],"navigationActions":[],"visualActions":[],',
    '"framing":{"mode","preferredZoom","minimumPadding"},"narrationGoal","estimatedDuration","fallbackBehavior"}]}',
  ].join("\n");

  const raw = await callOpenAI({ system, user, temperature: 0.3 });
  const list = Array.isArray(raw.scenes) ? raw.scenes : [];
  const scenes = list
    .slice(0, 6)
    .map((s, i) => normalisePlannedScene(s, i, websiteMap))
    .filter((s) => s.selectorCandidates.length || s.targetName);

  if (!scenes.length) throw new Error("The AI did not return any usable planned scenes.");
  return scenes;
}

module.exports = {
  createStrategy,
  planScenes,
  VISUAL_ACTIONS,
  NAV_ACTIONS,
  FRAMING_MODES,
  FALLBACKS,
};
