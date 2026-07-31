/**
 * Smart navigation: resolves menu items, tabs, accordions, dropdowns, mobile
 * hamburger menus, anchors, carousels, modals and multi-page routes before the
 * camera commits to a shot. Clicking only happens when scrolling alone cannot
 * reveal the target, and never for unsafe actions (see safeClick.js).
 */

const { classifyClick } = require("./safeClick");

const HAMBURGER_SELECTORS = [
  "[aria-label*='menu' i][aria-expanded]",
  "button[aria-label*='menu' i]",
  "button.hamburger",
  ".navbar-toggler",
  "[class*='hamburger' i]",
  "[class*='menu-toggle' i]",
  "[data-testid*='menu' i]",
];

const MODAL_CLOSE_SELECTORS = [
  "[aria-label*='close' i]",
  "[data-dismiss]",
  ".modal button.close",
  "[class*='close' i][role='button']",
];

function textSelector(label) {
  const t = String(label || "").trim().slice(0, 60).replace(/"/g, '\\"');
  if (!t) return [];
  return [
    `a:has-text("${t}")`,
    `button:has-text("${t}")`,
    `[role="tab"]:has-text("${t}")`,
    `summary:has-text("${t}")`,
    `nav :text-is("${t}")`,
  ];
}

async function firstVisible(page, selectors) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    const ok = await loc.isVisible().catch(() => false);
    if (ok) return { locator: loc, selector: sel };
  }
  return null;
}

/** True when the viewport is narrow enough that nav links collapse. */
async function isMobileLayout(page) {
  return page.evaluate(() => window.innerWidth < 900).catch(() => false);
}

/** Opens the hamburger menu when nav links are hidden. Returns true if opened. */
async function openMobileMenu(page) {
  const toggle = await firstVisible(page, HAMBURGER_SELECTORS);
  if (!toggle) return false;
  const expanded = await toggle.locator
    .getAttribute("aria-expanded")
    .catch(() => null);
  if (expanded === "true") return true;
  await toggle.locator.click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(500);
  return true;
}

/** Hovers a parent nav item so its dropdown panel renders. */
async function openDropdownFor(page, label) {
  const parent = await firstVisible(page, [
    `nav li:has(> a:has-text("${label}"))`,
    `[aria-haspopup="true"]:has-text("${label}")`,
    `nav a:has-text("${label}")`,
  ]);
  if (!parent) return false;
  await parent.locator.hover({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(450);
  return true;
}

/** Expands an accordion / details element containing the label. */
async function expandAccordion(page, label) {
  const trigger = await firstVisible(page, [
    `details:has-text("${label}") summary`,
    `[aria-expanded="false"]:has-text("${label}")`,
    `[class*='accordion' i] [role='button']:has-text("${label}")`,
  ]);
  if (!trigger) return false;
  await trigger.locator.click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(450);
  return true;
}

/** Activates a tab by label. */
async function activateTab(page, label) {
  const tab = await firstVisible(page, [
    `[role="tab"]:has-text("${label}")`,
    `[class*='tab' i][data-*]:has-text("${label}")`,
    `[class*='tab' i]:has-text("${label}")`,
  ]);
  if (!tab) return false;
  await tab.locator.click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(500);
  return true;
}

/** Advances a carousel one slide, preferring the next-arrow control. */
async function advanceCarousel(page) {
  const next = await firstVisible(page, [
    "[aria-label*='next' i]",
    "button[class*='next' i]",
    ".swiper-button-next",
    ".slick-next",
  ]);
  if (!next) return false;
  await next.locator.click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(700);
  return true;
}

async function closeModal(page) {
  const close = await firstVisible(page, MODAL_CLOSE_SELECTORS);
  if (!close) {
    await page.keyboard.press("Escape").catch(() => {});
    return false;
  }
  await close.locator.click({ timeout: 2500 }).catch(() => {});
  await page.waitForTimeout(400);
  return true;
}

async function goBack(page) {
  await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
  await waitForReady(page);
}

/** Waits until the destination page/content is genuinely ready. */
async function waitForReady(page, { timeout = 12000 } = {}) {
  await page.waitForLoadState("domcontentloaded", { timeout }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
  await page
    .waitForFunction(() => document.body && document.body.innerText.trim().length > 40, null, {
      timeout: 6000,
    })
    .catch(() => {});
  await page.waitForTimeout(400);
}

/**
 * Decides whether the scene actually needs a click. Scrolling wins whenever
 * the target already exists in the current document.
 */
async function needsNavigation(page, scene, resolvedTarget) {
  if (resolvedTarget) return false;
  const action = String(scene?.action || "").toLowerCase();
  return ["click", "open_menu", "open_tab", "open_accordion", "navigate", "next_slide"].includes(
    action,
  );
}

/**
 * Executes the navigation intent for a scene.
 * Returns { navigated, routeChanged, simulated, reason }.
 */
async function performNavigation(page, scene, { onSimulatedClick } = {}) {
  const label = scene?.targetLabel || scene?.label || scene?.menuItem || "";
  const action = String(scene?.action || "click").toLowerCase();
  const urlBefore = page.url();
  const result = { navigated: false, routeChanged: false, simulated: false, reason: "" };

  if (action === "next_slide") {
    result.navigated = await advanceCarousel(page);
    return result;
  }
  if (action === "close_modal") {
    result.navigated = await closeModal(page);
    return result;
  }
  if (action === "back") {
    await goBack(page);
    result.navigated = true;
    result.routeChanged = true;
    return result;
  }
  if (action === "open_accordion") {
    result.navigated = await expandAccordion(page, label);
    return result;
  }
  if (action === "open_tab") {
    result.navigated = await activateTab(page, label);
    return result;
  }

  // Menu-style navigation.
  if (await isMobileLayout(page)) await openMobileMenu(page);

  let item = await firstVisible(page, textSelector(label));
  if (!item) {
    await openDropdownFor(page, scene?.parentMenu || label);
    item = await firstVisible(page, textSelector(label));
  }
  if (!item) {
    result.reason = "not_found";
    return result;
  }

  await item.locator.scrollIntoViewIfNeeded().catch(() => {});
  const verdict = await classifyClick(page, item.selector);

  if (!verdict.safe) {
    // Unsafe action: hover + highlight + ripple only, never a real click.
    await item.locator.hover({ timeout: 3000 }).catch(() => {});
    if (onSimulatedClick) await onSimulatedClick(item.locator);
    result.simulated = true;
    result.reason = verdict.reason;
    return result;
  }

  const href = verdict.info?.href || "";
  await item.locator.hover({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(220);
  await item.locator.click({ timeout: 5000 }).catch(() => {});
  result.navigated = true;

  if (href.startsWith("#")) {
    await page.waitForTimeout(700); // in-page anchor scroll
    return result;
  }

  await waitForReady(page);
  result.routeChanged = page.url() !== urlBefore;
  return result;
}

module.exports = {
  performNavigation,
  needsNavigation,
  waitForReady,
  openMobileMenu,
  openDropdownFor,
  activateTab,
  expandAccordion,
  advanceCarousel,
  closeModal,
  goBack,
  isMobileLayout,
};