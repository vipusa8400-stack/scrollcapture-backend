/**
 * Resolves a scene's target element on the live page and returns an accurate,
 * freshly measured document-space bounding box. Never guesses a fixed position.
 */

const MIN_W = 8;
const MIN_H = 8;

function uniq(list) {
  return Array.from(new Set(list.filter((s) => typeof s === "string" && s.trim()))).map((s) =>
    s.trim(),
  );
}

/** Builds the prioritised selector candidate list for a scene. */
function candidateSelectors(scene) {
  const out = [];
  if (scene.selector) out.push(scene.selector); // 1. exact saved selector
  if (Array.isArray(scene.selectors)) out.push(...scene.selectors); // AI alternatives
  const dest = scene.expectedDestination;
  if (dest) {
    // 2. href / route
    out.push(`a[href="${dest}"]`, `a[href$="${dest}"]`, `a[href*="${dest}"]`);
  }
  const label = String(scene.target || scene.title || "").trim();
  if (label) {
    // 3. aria-label  4. button/menu text  5. heading text
    out.push(
      `[aria-label="${label}"]`,
      `[aria-label*="${label}" i]`,
      `nav >> text="${label}"`,
      `role=link[name="${label}" i]`,
      `role=button[name="${label}" i]`,
      `role=tab[name="${label}" i]`,
      `role=heading[name="${label}" i]`,
      `text="${label}"`,
    );
    const short = label.replace(/\b(section|button|link|menu|item|tab|area|block)\b/gi, "").trim();
    if (short && short !== label) {
      out.push(`[aria-label*="${short}" i]`, `role=link[name="${short}" i]`, `text=${short}`);
      out.push(`#${short.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
    }
  }
  return uniq(out);
}

/** Measures a Playwright locator in document coordinates. */
async function measureLocator(page, locator) {
  try {
    const handle = await locator.first().elementHandle({ timeout: 800 });
    if (!handle) return null;
    const visible = await handle.isVisible().catch(() => false);
    if (!visible) {
      await handle.dispose();
      return null;
    }
    const rect = await handle.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) < 0.05) {
        return null;
      }
      return {
        x: r.left + window.scrollX,
        y: r.top + window.scrollY,
        width: r.width,
        height: r.height,
      };
    });
    await handle.dispose();
    if (!rect || rect.width < MIN_W || rect.height < MIN_H) return null;
    return rect;
  } catch {
    return null;
  }
}

/**
 * Finds the target element for a scene.
 * Returns { rect, selector, source } or null when nothing reliable was found.
 */
async function resolveTarget(page, scene) {
  for (const selector of candidateSelectors(scene)) {
    let locator;
    try {
      locator = page.locator(selector);
    } catch {
      continue;
    }
    const count = await locator.count().catch(() => 0);
    if (!count) continue;
    const rect = await measureLocator(page, locator);
    if (rect) return { rect, selector, source: "selector" };
  }

  // 6-8. Fallback: in-page heuristic text / role / nearby-content scoring.
  const rect = await page
    .evaluate((q) => window.__scWalkthrough.findTarget(q), scene.target || scene.title || "")
    .catch(() => null);
  if (rect && rect.width >= MIN_W && rect.height >= MIN_H) {
    return { rect, selector: null, source: "heuristic" };
  }
  return null;
}

/** Re-measures a previously found selector after scroll / navigation / layout change. */
async function remeasure(page, found, scene) {
  if (found && found.selector) {
    const rect = await measureLocator(page, page.locator(found.selector));
    if (rect) return { ...found, rect };
  }
  return (await resolveTarget(page, scene)) || found;
}

/**
 * Wider section fallback when the element cannot be found: shows the section of
 * the page that best matches the scene index instead of zooming somewhere random.
 */
function sectionFallback({ index, total, maxScroll, viewport }) {
  const y = total > 1 ? Math.round((index / (total - 1)) * maxScroll) : 0;
  return {
    rect: {
      x: 0,
      y: Math.max(0, Math.min(maxScroll, y)),
      width: viewport.width,
      height: viewport.height,
    },
    selector: null,
    source: "section",
  };
}

module.exports = { resolveTarget, remeasure, sectionFallback, candidateSelectors };
