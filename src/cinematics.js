/**
 * Camera + cursor choreography helpers. Every movement is frame-accurate:
 * each helper renders its own frames through the `shoot` callback and returns
 * the number of seconds it consumed so audio stays perfectly in sync.
 */

const FPS = 24;

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}
function easeOut(t) {
  return 1 - Math.pow(1 - t, 3);
}

/** Zoom strength derived from the real element size (rules 8). */
function zoomScaleFor(rect, viewport) {
  const areaRatio = (rect.width * rect.height) / (viewport.width * viewport.height);
  let scale;
  if (areaRatio > 0.35) scale = 1.15 + (1 - Math.min(1, areaRatio)) * 0.15; // large section
  else if (areaRatio > 0.06) scale = 1.35; // card / form
  else scale = 1.65; // small button or icon

  // Never crop the target: keep padding around it.
  const pad = 48;
  const maxByWidth = viewport.width / Math.max(1, rect.width + pad * 2);
  const maxByHeight = viewport.height / Math.max(1, rect.height + pad * 2);
  const cap = Math.max(1, Math.min(maxByWidth, maxByHeight));
  return Math.max(1, Math.min(scale, cap, 1.8));
}

/** Scroll target that centres the element, allowing for sticky headers. */
function scrollTargetFor(rect, viewport, metrics) {
  const sticky = metrics?.stickyHeaderHeight || 0;
  const visible = viewport.height - sticky;
  const center = rect.y + rect.height / 2;
  const maxScroll = Math.max(0, (metrics?.pageHeight || viewport.height) - viewport.height);
  const desired = center - sticky - visible / 2;
  return Math.max(0, Math.min(maxScroll, Math.round(desired)));
}

async function scrollTo(page, shoot, from, to, seconds) {
  if (Math.abs(to - from) < 2) {
    await page.evaluate((y) => window.scrollTo(0, y), to);
    return 0;
  }
  const frames = Math.max(2, Math.round(seconds * FPS));
  for (let f = 0; f < frames; f++) {
    const y = Math.round(from + (to - from) * easeInOut(f / (frames - 1)));
    await page.evaluate((sy) => window.scrollTo(0, sy), y);
    await shoot();
  }
  return frames / FPS;
}

/** Natural curved cursor travel with acceleration, deceleration and a hover beat. */
async function moveCursor(page, shoot, state, toX, toY, { seconds = 0.9, hover = 0.25 } = {}) {
  if (state.cursorEnabled === false) return 0;
  const from = state.cursor || { x: toX - 260, y: toY - 180 };
  const dist = Math.hypot(toX - from.x, toY - from.y);
  const dur = Math.max(0.35, Math.min(seconds, 0.35 + dist / 1400));
  const frames = Math.max(3, Math.round(dur * FPS));

  // Control point offset perpendicular to the path -> curved, human path.
  const mx = (from.x + toX) / 2;
  const my = (from.y + toY) / 2;
  const nx = -(toY - from.y);
  const ny = toX - from.x;
  const norm = Math.hypot(nx, ny) || 1;
  const bow = Math.min(120, dist * 0.18);
  const cx = mx + (nx / norm) * bow;
  const cy = my + (ny / norm) * bow;

  await page.evaluate(() => window.__scWalkthrough.showCursor(true));
  await page
    .evaluate((on) => window.__scWalkthrough.enableTrail(on), Boolean(state.cursorTrail))
    .catch(() => {});
  for (let f = 0; f < frames; f++) {
    // Ease-in on departure, strong ease-out so the cursor slows near the target.
    const raw = f / (frames - 1);
    const t = easeInOut(raw) * 0.35 + easeOut(raw) * 0.65;
    const inv = 1 - t;
    const x = inv * inv * from.x + 2 * inv * t * cx + t * t * toX;
    const y = inv * inv * from.y + 2 * inv * t * cy + t * t * toY;
    await page.evaluate(([px, py]) => window.__scWalkthrough.moveCursor(px, py), [
      Math.round(x),
      Math.round(y),
    ]);
    await shoot();
  }
  state.cursor = { x: toX, y: toY };

  let hoverSeconds = 0;
  if (hover > 0) {
    const hf = Math.max(1, Math.round(hover * FPS));
    for (let f = 0; f < hf; f++) await shoot();
    hoverSeconds = hf / FPS;
  }
  return frames / FPS + hoverSeconds;
}

/** Subtle click ripple at the cursor position. */
async function clickRipple(page, shoot, state, seconds = 0.4) {
  if (state.cursorEnabled === false || state.clickAnimation === false) return 0;
  const frames = Math.max(2, Math.round(seconds * FPS));
  const { x, y } = state.cursor || { x: 0, y: 0 };
  for (let f = 0; f < frames; f++) {
    const p = f / (frames - 1);
    // Click compression: cursor squashes down then springs back.
    await page
      .evaluate((amt) => window.__scWalkthrough.setPress(amt), p < 0.35 ? 0.18 : 0)
      .catch(() => {});
    await page.evaluate(
      ([px, py, p]) => window.__scWalkthrough.ripple(px, py, p),
      [x, y, p],
    );
    await shoot();
  }
  await page.evaluate(() => window.__scWalkthrough.hideRipple());
  await page.evaluate(() => window.__scWalkthrough.setPress(0)).catch(() => {});
  return frames / FPS;
}

/** Move the cursor out of the lower-third before subtitles cover the target. */
async function parkCursor(page, shoot, state, viewport) {
  if (state.cursorEnabled === false || !state.cursor) return 0;
  const safeY = Math.round(viewport.height * 0.22);
  if (state.cursor.y < viewport.height * 0.72) return 0;
  return moveCursor(page, shoot, state, Math.round(viewport.width * 0.86), safeY, {
    seconds: 0.6,
    hover: 0,
  });
}

async function animateZoom(page, shoot, from, to, originX, originY, seconds) {
  if (Math.abs(to - from) < 0.005) return 0;
  const frames = Math.max(2, Math.round(seconds * FPS));
  for (let f = 0; f < frames; f++) {
    const p = easeOut(f / (frames - 1));
    const scale = from + (to - from) * p;
    await page.evaluate(
      ([s, ox, oy]) => window.__scWalkthrough.setZoom(s, ox, oy),
      [scale, originX, originY],
    );
    await shoot();
  }
  return frames / FPS;
}

async function hold(shoot, seconds) {
  const frames = Math.max(1, Math.round(seconds * FPS));
  for (let f = 0; f < frames; f++) await shoot();
  return frames / FPS;
}

module.exports = {
  FPS,
  easeInOut,
  zoomScaleFor,
  scrollTargetFor,
  scrollTo,
  moveCursor,
  clickRipple,
  parkCursor,
  animateZoom,
  hold,
};
