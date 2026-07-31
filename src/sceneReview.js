/**
 * Automated scene review, quality scoring (0-100) and retry planning.
 *
 * Every scene is recorded as its own clip. Three checkpoints (start, middle,
 * end) are captured while the clip records; afterwards the checkpoints are
 * reviewed and scored. Scenes below APPROVE_SCORE are re-recorded with a
 * targeted fix (zoom out, next selector, section fallback, open menu first,
 * wait longer) - never more than MAX_RETRIES times, after which a safe
 * wide-view fallback clip is used so one difficult scene can never fail the
 * whole video.
 */

const path = require("path");

const APPROVE_SCORE = 85;
const MAX_RETRIES = 3;

/**
 * Captures one review checkpoint: a screenshot plus live measurements of the
 * target, the page state and the cursor.
 */
async function captureCheckpoint(page, { label, dir, rect, safeArea, expectedRoute, cursor }) {
  const file = path.join(dir, `review-${label}.png`);
  await page.screenshot({ path: file, type: "png" }).catch(() => {});

  const inspect = rect
    ? await page
        .evaluate(
          ([r, t, b]) => window.__scWalkthrough.inspect(r, t, b),
          [rect, (safeArea && safeArea.top) || 0, (safeArea && safeArea.bottom) || 0],
        )
        .catch(() => null)
    : null;

  const pageState = await page
    .evaluate(() => {
      const text = (document.body && document.body.innerText) || "";
      const spinner = document.querySelector(
        '[class*="spinner" i],[class*="loading" i],[class*="skeleton" i],[aria-busy="true"]',
      );
      const overlays = Array.from(document.querySelectorAll("body *")).filter((el) => {
        const cs = getComputedStyle(el);
        if (cs.position !== "fixed" || cs.visibility === "hidden" || Number(cs.opacity) < 0.2)
          return false;
        const r = el.getBoundingClientRect();
        return (
          r.width > innerWidth * 0.6 &&
          r.height > innerHeight * 0.4 &&
          Number(cs.zIndex || 0) > 500
        );
      }).length;
      return {
        textLength: text.replace(/\s+/g, " ").trim().length,
        loading: Boolean(spinner),
        overlays,
        route: location.pathname,
        url: location.href,
      };
    })
    .catch(() => ({ textLength: 0, loading: true, overlays: 0, route: "/", url: "" }));

  return {
    label,
    file,
    inspect,
    pageState,
    cursor: cursor ? { x: cursor.x, y: cursor.y } : null,
    expectedRoute: expectedRoute || "",
  };
}

function avg(values) {
  const list = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (!list.length) return 0;
  return list.reduce((a, b) => a + b, 0) / list.length;
}

/**
 * Reviews the three checkpoints of a recorded scene clip and returns
 * { score, issues, reason, approved }.
 */
function reviewScene({ checkpoints, found, timing, actual, navigation, cursorReached, wideFallback }) {
  const issues = [];
  let score = 100;

  const penalise = (points, issue) => {
    score -= points;
    issues.push(issue);
  };

  // --- Correct target shown at all
  if (!found || !found.rect || found.rect.width < 8 || found.rect.height < 8) {
    penalise(35, "no_target");
  } else if (found.source === "safe_wide") {
    penalise(10, "safe_wide_fallback");
  } else if (found.source === "section" && !wideFallback) {
    penalise(8, "section_fallback");
  }

  const visible = avg(checkpoints.map((c) => c.inspect && c.inspect.visibleRatio));
  const covered = avg(checkpoints.map((c) => c.inspect && c.inspect.coveredRatio));
  const behind = avg(checkpoints.map((c) => c.inspect && c.inspect.behindChromeRatio));

  // --- Target fully visible / not cropped
  if (visible < 0.995) penalise(Math.round((1 - visible) * 40), "cropped");
  // --- No popup obstruction
  if (covered > 0.02) penalise(Math.round(covered * 40) + 5, "popup_obstruction");
  // --- Not hidden behind a sticky header / bottom bar
  if (behind > 0.02) penalise(Math.round(behind * 25) + 3, "behind_sticky_chrome");

  // --- Correct zoom (target should fill a healthy part of the frame)
  const fill = avg(checkpoints.map((c) => c.inspect && c.inspect.frameFill));
  if (fill && fill < 0.18) penalise(8, "zoom_too_wide");
  if (fill && fill > 0.98) penalise(8, "zoom_too_tight");

  // --- No loading / blank screen
  const blank = checkpoints.some((c) => c.pageState.textLength < 40);
  const loading = checkpoints.some((c) => c.pageState.loading);
  if (blank) penalise(30, "blank_screen");
  else if (loading) penalise(8, "still_loading");

  // --- Navigation succeeded
  if (navigation && navigation.expected && !navigation.ok) penalise(20, "navigation_failed");

  // --- Cursor reached the right element
  if (cursorReached === false) penalise(10, "cursor_missed_target");

  // --- Narration must not continue after the camera moved
  if (timing && actual) {
    const narrationEnd = timing.leadIn + timing.speechDuration;
    if (actual.total + 0.05 < narrationEnd) penalise(25, "camera_left_early");
    const slack = actual.total - narrationEnd;
    if (slack > 3.5) penalise(8, "scene_too_slow");
    if (actual.total < 1.6) penalise(8, "scene_too_fast");
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const reason = issues[0] || "ok";
  return { score, issues, reason, approved: score >= APPROVE_SCORE };
}

/**
 * Chooses the single targeted fix for the next attempt of a failed scene.
 * Only the failing scene is ever re-recorded.
 */
function planRetry(review, previous = {}) {
  const next = { ...previous, attempt: (previous.attempt || 0) + 1 };
  const issues = review.issues || [];
  const has = (k) => issues.includes(k);

  if (has("cropped") || has("zoom_too_tight") || has("does_not_fit")) {
    // Pricing / large sections: zoom out and centre the whole section.
    next.zoomOut = Math.min(1, (previous.zoomOut ?? 1) * 0.8);
    next.forceMode = "fit_section";
    next.center = true;
    next.fix = "zoom_out_and_center";
    return next;
  }
  if (has("no_target") || has("cursor_missed_target") || has("section_fallback")) {
    // Wrong target: try the next selector, then heading association, then the
    // section-wide fallback.
    next.selectorSkip = (previous.selectorSkip || 0) + 1;
    if (next.selectorSkip >= 2) next.useHeading = true;
    if (next.selectorSkip >= 3) next.forceSection = true;
    next.fix = "next_selector";
    return next;
  }
  if (has("navigation_failed") || has("blank_screen") || has("still_loading")) {
    next.openMenuFirst = true;
    next.extraWaitMs = Math.min(6000, (previous.extraWaitMs || 0) + 2000);
    next.remapDestination = true;
    next.fix = "navigate_slower";
    return next;
  }
  if (has("popup_obstruction")) {
    next.dismissPopups = true;
    next.fix = "dismiss_popups";
    return next;
  }
  if (has("camera_left_early")) {
    next.extraHold = (previous.extraHold || 0) + 0.8;
    next.fix = "hold_longer";
    return next;
  }
  if (has("scene_too_slow")) {
    next.trimHold = (previous.trimHold || 0) + 0.6;
    next.fix = "trim_hold";
    return next;
  }
  next.zoomOut = Math.min(1, (previous.zoomOut ?? 1) * 0.85);
  next.fix = "generic_widen";
  return next;
}

/** The last-resort attempt: a calm, wide, interaction-free view of the section. */
function safeFallbackAdjust(previous = {}) {
  return {
    ...previous,
    attempt: (previous.attempt || 0) + 1,
    wideFallback: true,
    forceSection: true,
    forceMode: "wide_overview",
    zoomOut: 1,
    skipInteraction: true,
    fix: "safe_wide_fallback",
  };
}

module.exports = {
  APPROVE_SCORE,
  MAX_RETRIES,
  captureCheckpoint,
  reviewScene,
  planRetry,
  safeFallbackAdjust,
};