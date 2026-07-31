/**
 * Scene splitting + section matching.
 *
 * If the AI returns one long scene for a long narration, the camera would sit
 * on the hero for the whole video. This module splits that narration into one
 * scene per website section that the script actually talks about, and matches
 * any scene to the best section in the website map.
 */

const SECTION_KEYWORDS = [
  ["hero", ["welcome", "homepage", "home page", "first impression", "landing", "hero"]],
  ["services", ["service", "services", "what we do", "solution", "solutions", "offering", "perkhidmatan"]],
  ["features", ["feature", "features", "benefit", "benefits", "why choose", "why us"]],
  ["products", ["product", "products", "shop", "store", "catalog", "menu"]],
  ["portfolio", ["portfolio", "project", "projects", "our work", "case study", "case studies"]],
  ["gallery", ["gallery", "photos", "images"]],
  ["pricing", ["pricing", "price", "prices", "plan", "plans", "package", "packages", "cost"]],
  ["testimonials", ["testimonial", "testimonials", "review", "reviews", "clients say", "feedback"]],
  ["about", ["about", "our story", "who we are", "company", "mission"]],
  ["team", ["team", "our people", "staff"]],
  ["faq", ["faq", "faqs", "question", "questions", "answers"]],
  ["contact", ["contact", "get in touch", "reach us", "enquiry", "inquiry", "book", "booking", "location"]],
  ["cta", ["get started", "call to action", "sign up", "start now"]],
  ["footer", ["footer"]],
];

function normalise(text) {
  return String(text || "").toLowerCase();
}

/** Which section type does this sentence / scene talk about? */
function sectionTypeFor(text) {
  const hay = normalise(text);
  let best = null;
  let bestScore = 0;
  for (const [type, words] of SECTION_KEYWORDS) {
    let score = 0;
    for (const w of words) if (hay.includes(w)) score += w.length;
    if (score > bestScore) {
      bestScore = score;
      best = type;
    }
  }
  return bestScore > 0 ? best : null;
}

/** Finds the website-map section that best fits a scene. */
function matchSection(scene, websiteMap) {
  const sections = (websiteMap && websiteMap.sections) || [];
  if (!sections.length) return null;
  const hay = normalise(
    [scene && scene.target, scene && scene.title, scene && scene.sectionType, scene && scene.speech]
      .filter(Boolean)
      .join(" "),
  );
  const wanted =
    (scene && scene.sectionType) ||
    (scene && scene.plan && scene.plan.sectionType) ||
    sectionTypeFor(hay);

  if (wanted) {
    const byType = sections.find((s) => s.type === wanted);
    if (byType) return byType;
  }
  // Heading text match.
  let best = null;
  let bestScore = 0;
  for (const s of sections) {
    const heading = normalise(s.heading || s.accessibleName);
    if (!heading || heading.length < 3) continue;
    if (hay.includes(heading)) {
      const score = heading.length;
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
  }
  return best;
}

function sentences(text) {
  return String(text || "")
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function wordCount(text) {
  return String(text || "").trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Splits a too-short scene list (usually one scene) into several scenes, each
 * anchored to a real website section mentioned in the narration.
 */
function splitLongScenes({ scenes, websiteMap, minWords = 45, maxScenes = 10 }) {
  if (!Array.isArray(scenes) || scenes.length > 1) return scenes;
  const base = scenes[0];
  if (!base) return scenes;
  const parts = sentences(base.speech);
  if (parts.length < 2 || wordCount(base.speech) < minWords) return scenes;

  const sectionList = ((websiteMap && websiteMap.sections) || []).filter(
    (s) => s.type !== "navigation" && s.type !== "footer",
  );

  // Group consecutive sentences that talk about the same section.
  const groups = [];
  for (const sentence of parts) {
    const type = sectionTypeFor(sentence);
    const last = groups[groups.length - 1];
    if (last && (type === null || type === last.type)) {
      last.text.push(sentence);
      if (type && !last.type) last.type = type;
      continue;
    }
    groups.push({ type: type || null, text: [sentence] });
  }

  // Merge tiny groups forward so no scene has a one-word narration.
  const merged = [];
  for (const g of groups) {
    const prev = merged[merged.length - 1];
    if (prev && wordCount(g.text.join(" ")) < 8) {
      prev.text.push(...g.text);
      prev.type = prev.type || g.type;
      continue;
    }
    merged.push(g);
  }

  if (merged.length < 2) return scenes;

  const used = new Set();
  const out = merged.slice(0, maxScenes).map((g, index) => {
    let section = null;
    if (g.type) section = sectionList.find((s) => s.type === g.type && !used.has(s.sectionId));
    if (!section && g.type) section = sectionList.find((s) => s.type === g.type);
    if (!section) {
      // Walk the page in order for untyped chunks.
      section = sectionList.find((s) => !used.has(s.sectionId)) || null;
    }
    if (section) used.add(section.sectionId);

    const speech = g.text.join(" ");
    return {
      ...base,
      speech,
      action: "scroll_to",
      title: section ? section.heading || section.type : base.title || `Scene ${index + 1}`,
      target: section ? section.heading || section.type : g.type || base.target,
      sectionType: g.type || (section && section.type) || null,
      selector: section ? (section.selectorCandidates || [])[0] || null : null,
      selectors: section ? section.selectorCandidates || [] : [],
      expectedDestination: null,
      cue: null,
      plan: {
        ...(base.plan || {}),
        sectionId: section ? section.sectionId : null,
        sectionType: g.type || (section && section.type) || null,
        targetType: "section",
        framing: { mode: "show_entire_section", preferredZoom: 1.1, minimumPadding: 48 },
      },
    };
  });

  return out;
}

module.exports = { splitLongScenes, matchSection, sectionTypeFor };
