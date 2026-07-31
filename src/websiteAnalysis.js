/**
 * Shared pre-production pipeline for both AI features:
 *   1. Preparing website
 *   2. Mapping website sections
 *   3. Creating presentation strategy
 *   4. Planning scenes
 * Recording, voice generation and rendering are untouched and run afterwards.
 */

const { chromium, devices } = require("playwright");
const { prepareWebsite } = require("./websitePreparation");
const { mapWebsite, summariseMap } = require("./websiteMap");
const { createStrategy, planScenes } = require("./presentationStrategy");

const VIEWPORTS = {
  desktop: { width: 1280, height: 720 },
  mobile: { width: 390, height: 844 },
};

const STAGES = [
  { key: "preparing", label: "Preparing website" },
  { key: "mapping", label: "Mapping pages and sections" },
  { key: "strategizing", label: "Creating presentation strategy" },
  { key: "planning", label: "Planning scenes" },
];

function contextOptionsFor(device) {
  const viewport = VIEWPORTS[device] || VIEWPORTS.desktop;
  return device === "mobile"
    ? { ...devices["iPhone 13"], viewport, screen: viewport }
    : { viewport, deviceScaleFactor: 1 };
}

/** Turns the map into the legacy `pageOutline` string list other code still uses. */
function outlineFromMap(map) {
  const out = map.sections.map(
    (s) =>
      `${s.heading || s.accessibleName || s.type} | ${s.type} | ${s.selectorCandidates[0] || ""}`,
  );
  for (const n of map.navigation.slice(0, 20)) out.push(`${n.name} | nav-link | ${n.selector}`);
  for (const c of map.ctaButtons.slice(0, 15)) out.push(`${c.name} | cta | ${c.selector}`);
  return out.slice(0, 120);
}

/** Steps 1 + 2 on an existing page. */
async function prepareAndMap(page, { websiteUrl, onStage, previews = true }) {
  const stage = (key, label, detail) => {
    if (typeof onStage === "function") onStage({ key, label, detail });
  };

  stage("preparing", "Preparing website");
  const preparation = await prepareWebsite(page, {
    websiteUrl,
    onStep: (detail) => stage("preparing", "Preparing website", detail),
  });

  stage("mapping", "Mapping pages and sections");
  const websiteMap = await mapWebsite(page, { previews });
  websiteMap.preparation = preparation;

  return { preparation, websiteMap };
}

/** Steps 3 + 4. */
async function buildStrategyAndScenes({
  websiteUrl,
  changes,
  language,
  tone,
  mode,
  websiteMap,
  onStage,
}) {
  const stage = (key, label) => {
    if (typeof onStage === "function") onStage({ key, label });
  };

  stage("strategizing", "Creating presentation strategy");
  const strategy = await createStrategy({
    websiteUrl,
    changes,
    language,
    tone,
    mode,
    websiteMap,
  });

  stage("planning", "Planning scenes");
  const scenePlan = await planScenes({ websiteUrl, changes, strategy, websiteMap });

  return { strategy, scenePlan };
}

/** Full standalone pass with its own browser (used by the script endpoint). */
async function analyzeWebsite({
  websiteUrl,
  device,
  changes,
  language,
  tone,
  mode,
  onStage,
  previews = true,
}) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const context = await browser.newContext(contextOptionsFor(device));
    const page = await context.newPage();
    const { preparation, websiteMap } = await prepareAndMap(page, {
      websiteUrl,
      onStage,
      previews,
    });
    const { strategy, scenePlan } = await buildStrategyAndScenes({
      websiteUrl,
      changes,
      language,
      tone,
      mode,
      websiteMap,
      onStage,
    });
    await context.close();
    return {
      preparation,
      websiteMap,
      strategy,
      scenePlan,
      pageOutline: outlineFromMap(websiteMap),
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = {
  analyzeWebsite,
  prepareAndMap,
  buildStrategyAndScenes,
  outlineFromMap,
  summariseMap,
  contextOptionsFor,
  VIEWPORTS,
  STAGES,
};
