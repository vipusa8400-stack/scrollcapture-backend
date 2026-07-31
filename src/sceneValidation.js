/**
 * Exact scene validation. Runs BEFORE any frame is recorded.
 * Produces a 0-100 visibility score and applies automatic fixes
 * (re-scroll, re-centre, zoom out, close popup, fallback selector,
 * section-wide fallback) until the shot is safe to record.
 */

const { computeFraming } = require("./camera");
const { resolveTarget, remeasure, sectionFallback } = require("./sceneTargeting");
const { dismissPopups } = require("./websitePreparation");

const MIN_SCORE = 80;

async function readChrome(page, viewport) {
  const c = await page.evaluate(() => window.__scWalkthrough.chrome()).catch(() => null);
  return (
    c || {
      stickyHeaderHeight: 0,
      bottomBarHeight: 0,
      blockingOverlays: 0,
      scrollY: 0,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      pageHeight: viewport.height,
    }
  );
}

/** Scores one candidate shot after the page has actually been scrolled to it. */
async function scoreShot(page, { rect, framing, chrome, route, expectedRoute }) {
  const issues = [];
  let score = 0;

  // Target exists + bounding box valid (30)
  if (rect && rect.width >= 8 && rect.height >= 8) score += 30;
  else issues.push("invalid_box");

  const inspect = await page
    .evaluate(
      ([r, t, b]) => window.__scWalkthrough.inspect(r, t, b),
      [rect, framing.safeArea.top, framing.safeArea.bottom],
    )
    .catch(() => null);

  if (inspect) {
    // Visible inside the safe area (25)
    score += Math.round(25 * inspect.visibleRatio);
    if (inspect.visibleRatio < 0.9) issues.push("partially_out_of_view");
    // Not covered by popups / overlays (15)
    score += Math.round(15 * (1 - inspect.coveredRatio));
    if (inspect.coveredRatio > 0.15) issues.push("covered");
    // Not behind the sticky header / bottom bar (10)
    score += Math.round(10 * (1 - inspect.behindChromeRatio));
    if (inspect.behindChromeRatio > 0.1) issues.push("behind_sticky_chrome");
  } else {
    issues.push("inspect_failed");
  }

  // Framing matches the plan — the whole target fits (10)
  if (framing.fits) score += 10;
  else issues.push("does_not_fit");

  // Images + fonts ready (5)
  const assets = await page.evaluate(() => window.__scWalkthrough.assetsReady()).catch(() => null);
  if (assets && assets.fonts && assets.images > 0.85) score += 5;
  else issues.push("assets_loading");

  // Correct route (5)
  if (!expectedRoute || expectedRoute === "/" || route.includes(expectedRoute)) score += 5;
  else issues.push("wrong_route");

  if (chrome.blockingOverlays > 0) issues.push("overlay_present");

  return { score: Math.max(0, Math.min(100, score)), issues, inspect };
}

/**
 * Validates and, if needed, repairs one scene's shot.
 * The page is left scrolled at the validated position with zoom reset to 1.
 *
 * Returns { found, framing, score, issues, attempts, fixes, recordable }.
 */
async function validateAndFixShot(page, options) {
  const { scene, viewport, subtitles, index, total } = options;
  const planned = scene.plan || {};
  const baseFraming = planned.framing || { mode: "focus_element", preferredZoom: 1.35, minimumPadding: 56 };
  const expectedRoute = planned.route && planned.route !== "/" ? planned.route : "";

  let found = options.found || null;
  let framingInput = { ...baseFraming };
  const fixes = [];
  let best = null;

  for (let attempt = 0; attempt < 6; attempt++) {
    const chrome = await readChrome(page, viewport);

    if (!found) {
      found = await resolveTarget(page, scene);
      if (!found) {
        // Section-wide fallback: never zoom somewhere random.
        found = sectionFallback({
          index,
          total,
          maxScroll: Math.max(0, chrome.pageHeight - viewport.height),
          viewport,
        });
        framingInput = { ...framingInput, mode: "wide_overview", preferredZoom: 1 };
        fixes.push("section_wide_fallback");
      }
    }

    let framing = computeFraming({
      rect: found.rect,
      viewport,
      chrome,
      framing: framingInput,
      targetType: planned.targetType || scene.targetType || "section",
      subtitles,
      pageHeight: chrome.pageHeight,
    });

    // Move there instantly, let layout settle, then RE-MEASURE. Old coordinates
    // are never trusted after a scroll.
    await page.evaluate((y) => window.scrollTo(0, y), framing.scrollY);
    await page.waitForTimeout(320);
    if (found.selector) {
      const re = await remeasure(page, found, scene);
      if (re && re.rect) found = re;
    }
    const chrome2 = await readChrome(page, viewport);
    framing = computeFraming({
      rect: found.rect,
      viewport,
      chrome: chrome2,
      framing: framingInput,
      targetType: planned.targetType || scene.targetType || "section",
      subtitles,
      pageHeight: chrome2.pageHeight,
    });
    if (Math.abs(chrome2.scrollY - framing.scrollY) > 4) {
      await page.evaluate((y) => window.scrollTo(0, y), framing.scrollY);
      await page.waitForTimeout(180);
    }

    const result = await scoreShot(page, {
      rect: found.rect,
      framing,
      chrome: chrome2,
      route: page.url(),
      expectedRoute,
    });

    const shot = { found, framing, ...result, attempts: attempt + 1, fixes: [...fixes] };
    if (!best || shot.score > best.score) best = shot;
    if (shot.score >= MIN_SCORE) return { ...shot, recordable: true };

    // ---- automatic fixes, cheapest first ----
    if (result.issues.includes("covered") || result.issues.includes("overlay_present")) {
      await dismissPopups(page).catch(() => {});
      fixes.push("close_popup");
      continue;
    }
    if (result.issues.includes("assets_loading")) {
      await page.waitForTimeout(700);
      fixes.push("wait_assets");
      continue;
    }
    if (result.issues.includes("behind_sticky_chrome") || result.issues.includes("partially_out_of_view")) {
      framingInput = {
        ...framingInput,
        minimumPadding: Math.min(80, (framingInput.minimumPadding || 56) + 12),
      };
      fixes.push("re_center");
      continue;
    }
    if (result.issues.includes("does_not_fit") || framing.scale > 1.05) {
      // Prefer a wider view instead of an incorrect close-up.
      framingInput = {
        ...framingInput,
        mode: framingInput.mode === "focus_element" ? "show_context_and_target" : "wide_overview",
        preferredZoom: 1,
      };
      fixes.push("zoom_out");
      continue;
    }
    if (found.selector) {
      // Try the next selector candidate.
      const rest = (scene.selectors || []).filter((s) => s !== found.selector);
      found = rest.length ? await resolveTarget(page, { ...scene, selector: null, selectors: rest }) : null;
      fixes.push("fallback_selector");
      continue;
    }
    found = null;
    fixes.push("relocate");
  }

  // Could not validate: fall back to a safe wide shot, never a random zoom.
  const chrome = await readChrome(page, viewport);
  const safeRect = {
    x: 0,
    y: best && best.found ? best.found.rect.y : chrome.scrollY,
    width: viewport.width,
    height: Math.min(viewport.height, Math.max(200, best ? best.found.rect.height : viewport.height)),
  };
  const framing = computeFraming({
    rect: safeRect,
    viewport,
    chrome,
    framing: { mode: "wide_overview", preferredZoom: 1, minimumPadding: 48 },
    subtitles,
    pageHeight: chrome.pageHeight,
  });
  await page.evaluate((y) => window.scrollTo(0, y), framing.scrollY);
  return {
    found: { rect: safeRect, selector: null, source: "safe_wide" },
    framing,
    score: best ? best.score : 0,
    issues: best ? best.issues : ["unresolved"],
    attempts: 6,
    fixes: [...fixes, "safe_wide"],
    recordable: false,
  };
}

module.exports = { validateAndFixShot, scoreShot, readChrome, MIN_SCORE };