/**
 * Dynamic, target-based camera framing.
 *
 * Every shot is computed from a FRESHLY measured bounding box, the live
 * viewport, the sticky header / fixed bottom bar heights and the subtitle
 * safe zone. No fixed positions, no reused coordinates.
 */

const FRAMING_MODES = [
  "show_entire_section",
  "focus_element",
  "show_group",
  "show_context_and_target",
  "wide_overview",
  "mobile_showcase",
];

const MIN_PAD = 40;
const MAX_PAD = 80;
const SUBTITLE_SAFE = 84;

/** Fit-to-view zoom band per target size / framing mode. */
function zoomBand({ mode, targetType, rect, viewport }) {
  const areaRatio = (rect.width * rect.height) / (viewport.width * viewport.height);
  const type = String(targetType || "").toLowerCase();

  if (mode === "wide_overview" || mode === "show_context_and_target") return [1.0, 1.15];
  if (mode === "show_entire_section" || mode === "show_group") return [1.0, 1.25];
  if (mode === "mobile_showcase") return [1.0, 1.2];

  // focus_element — decide from the real measured size.
  if (/button|link|icon|badge|cta|whatsapp/.test(type) || areaRatio < 0.045) return [1.4, 1.8];
  if (/card|form|plan|price|field|input|testimonial/.test(type) || areaRatio < 0.3) return [1.2, 1.5];
  return [1.0, 1.25];
}

function clampPadding(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 56;
  return Math.min(MAX_PAD, Math.max(MIN_PAD, Math.round(n)));
}

/**
 * Computes the exact camera shot for one target.
 * Returns scale, scroll position, zoom origin and whether the target fits.
 */
function computeFraming({
  rect,
  viewport,
  chrome = {},
  framing = {},
  targetType = "section",
  subtitles = false,
  pageHeight = 0,
}) {
  const mode = FRAMING_MODES.includes(framing.mode) ? framing.mode : "focus_element";
  const pad = clampPadding(framing.minimumPadding);

  const top = Math.max(0, Math.round(chrome.stickyHeaderHeight || 0));
  const bottom =
    Math.max(0, Math.round(chrome.bottomBarHeight || 0)) + (subtitles ? SUBTITLE_SAFE : 0);

  const safeH = Math.max(120, viewport.height - top - bottom);
  const availW = Math.max(60, viewport.width - pad * 2);
  const availH = Math.max(60, safeH - pad * 2);

  // The largest zoom that still shows the WHOLE target inside the safe area.
  const fitScale = Math.min(availW / Math.max(1, rect.width), availH / Math.max(1, rect.height));
  const overflow = fitScale < 1; // target is taller/wider than the safe area at 1x

  const [minZoom, maxZoom] = zoomBand({ mode, targetType, rect, viewport });
  const preferred = Math.min(
    maxZoom,
    Math.max(minZoom, Number(framing.preferredZoom) || (minZoom + maxZoom) / 2),
  );

  // Prefer a wider view over an incorrect close-up: never exceed the fit scale.
  const scale = overflow ? 1 : Number(Math.max(1, Math.min(preferred, fitScale)).toFixed(3));

  const maxScroll = Math.max(0, (pageHeight || viewport.height) - viewport.height);

  // Vertical placement inside the safe area (below sticky header, above the
  // subtitle strip). Tall targets are top-aligned so the start is never cut.
  let desired;
  if (overflow || rect.height > safeH - pad) {
    desired = rect.y - top - pad;
  } else {
    desired = rect.y + rect.height / 2 - top - safeH / 2;
  }
  const scrollY = Math.max(0, Math.min(maxScroll, Math.round(desired)));

  // Zoom origin = the point that must stay put = the target centre on screen.
  const visibleTop = Math.max(rect.y, scrollY + top);
  const visibleBottom = Math.min(rect.y + rect.height, scrollY + top + safeH);
  const originY = Math.round((visibleTop + visibleBottom) / 2);
  const originX = Math.round(
    Math.min(
      Math.max(rect.x + rect.width / 2, pad),
      Math.max(pad, viewport.width - pad),
    ),
  );

  return {
    mode,
    scale,
    scrollY,
    originX,
    originY,
    padding: pad,
    safeArea: { top, bottom, height: safeH },
    fits: !overflow,
    overflow,
    fitScale: Number(fitScale.toFixed(3)),
  };
}

/**
 * Splits a target that is taller than the safe area into planned shots.
 * Shot 1 shows the top (all pricing plans / the whole grid start), shot 2
 * optionally focuses the highlighted item lower in the section.
 */
function splitShots({ rect, viewport, chrome = {}, framing = {}, focusRect = null, subtitles }) {
  const base = computeFraming({ rect, viewport, chrome, framing, subtitles });
  if (base.fits) return [{ rect, framing }];

  const safeH = base.safeArea.height - base.padding * 2;
  const shots = [
    {
      rect: { ...rect, height: Math.min(rect.height, safeH) },
      framing: { ...framing, mode: "show_group", preferredZoom: 1 },
    },
  ];
  if (focusRect) {
    shots.push({ rect: focusRect, framing: { ...framing, mode: "focus_element" } });
  } else if (rect.height > safeH * 1.35) {
    shots.push({
      rect: {
        ...rect,
        y: rect.y + rect.height - Math.min(rect.height, safeH),
        height: Math.min(rect.height, safeH),
      },
      framing: { ...framing, mode: "show_group", preferredZoom: 1 },
    });
  }
  return shots;
}

module.exports = { computeFraming, splitShots, zoomBand, FRAMING_MODES, MIN_PAD, MAX_PAD };