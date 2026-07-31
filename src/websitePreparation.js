/**
 * Website preparation: makes sure the page is fully loaded, lazy content is
 * triggered, popups are closed and layout facts (sticky bars, viewport) are known
 * BEFORE any mapping, planning or recording happens.
 */

const COOKIE_TEXTS = [
  "accept all",
  "accept cookies",
  "allow all",
  "i agree",
  "agree",
  "got it",
  "ok, got it",
  "understood",
  "continue",
  "close",
  "terima",
  "setuju",
];

async function waitForAssets(page) {
  await page
    .evaluate(async () => {
      if (document.fonts && document.fonts.ready) {
        await document.fonts.ready.catch(() => {});
      }
      const images = Array.from(document.images || []).slice(0, 120);
      await Promise.all(
        images.map((img) =>
          img.complete
            ? Promise.resolve()
            : new Promise((resolve) => {
                const done = () => resolve();
                img.addEventListener("load", done, { once: true });
                img.addEventListener("error", done, { once: true });
                setTimeout(done, 2500);
              }),
        ),
      );
    })
    .catch(() => {});
}

/** Clicks obvious cookie / consent / newsletter close controls. Never navigates. */
async function dismissPopups(page) {
  const dismissed = [];
  for (const label of COOKIE_TEXTS) {
    const locator = page
      .locator(`button, [role="button"], a[role="button"]`)
      .filter({ hasText: new RegExp(`^\\s*${label}\\s*$`, "i") });
    const count = await locator.count().catch(() => 0);
    if (!count) continue;
    const first = locator.first();
    const visible = await first.isVisible().catch(() => false);
    if (!visible) continue;
    const href = await first.getAttribute("href").catch(() => null);
    if (href && href !== "#") continue;
    await first.click({ timeout: 1500, noWaitAfter: true }).catch(() => {});
    dismissed.push(label);
    await page.waitForTimeout(250);
    if (dismissed.length >= 3) break;
  }

  // Hide any remaining consent/newsletter overlays that block the view.
  const hidden = await page
    .evaluate(() => {
      const KEY = /cookie|consent|gdpr|newsletter|popup|modal|subscribe|interstitial/i;
      let count = 0;
      for (const el of Array.from(document.body.querySelectorAll("div,section,aside,dialog"))) {
        const cs = getComputedStyle(el);
        if (cs.position !== "fixed" && cs.position !== "sticky") continue;
        const r = el.getBoundingClientRect();
        if (r.width < 200 || r.height < 80) continue;
        const id = `${el.id} ${el.className}`;
        const isOverlay =
          KEY.test(typeof id === "string" ? id : "") ||
          (r.height > window.innerHeight * 0.5 && Number(cs.zIndex) > 500);
        if (!isOverlay) continue;
        el.setAttribute("data-sc-hidden", "1");
        el.style.setProperty("display", "none", "important");
        count += 1;
        if (count >= 6) break;
      }
      document.documentElement.style.setProperty("overflow", "auto", "important");
      document.body.style.setProperty("overflow", "auto", "important");
      return count;
    })
    .catch(() => 0);

  return { clicked: dismissed, hiddenOverlays: hidden };
}

/** Scrolls the entire page once (triggering lazy loading) and returns to the top. */
async function primeLazyContent(page) {
  await page
    .evaluate(async () => {
      const step = Math.max(300, Math.round(window.innerHeight * 0.8));
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      let y = 0;
      let guard = 0;
      while (guard < 60) {
        guard += 1;
        window.scrollTo(0, y);
        await sleep(180);
        const max = Math.max(
          document.body.scrollHeight,
          document.documentElement.scrollHeight,
        ) - window.innerHeight;
        if (y >= max) break;
        y = Math.min(max, y + step);
      }
      window.scrollTo(0, 0);
      await sleep(400);
    })
    .catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  await waitForAssets(page);
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await page.waitForTimeout(400);
}

/** Measures sticky headers and fixed bottom bars. */
async function measureChrome(page) {
  return (
    (await page
      .evaluate(() => {
        let header = 0;
        let bottom = 0;
        for (const el of Array.from(document.body.querySelectorAll("*")).slice(0, 3000)) {
          const cs = getComputedStyle(el);
          if (cs.position !== "fixed" && cs.position !== "sticky") continue;
          const r = el.getBoundingClientRect();
          if (r.width < window.innerWidth * 0.5) continue;
          if (r.height > window.innerHeight * 0.6) continue;
          if (r.top <= 4) header = Math.max(header, Math.round(r.height));
          if (r.bottom >= window.innerHeight - 4) bottom = Math.max(bottom, Math.round(r.height));
        }
        return {
          stickyHeaderHeight: header,
          fixedBottomHeight: bottom,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          pageHeight: Math.max(
            document.body.scrollHeight,
            document.documentElement.scrollHeight,
          ),
        };
      })
      .catch(() => null)) || {
      stickyHeaderHeight: 0,
      fixedBottomHeight: 0,
      viewportWidth: 0,
      viewportHeight: 0,
      pageHeight: 0,
    }
  );
}

/**
 * Full preparation pass. The page must already be created; navigation happens here.
 */
async function prepareWebsite(page, { websiteUrl, onStep } = {}) {
  const step = (s) => {
    if (typeof onStep === "function") onStep(s);
  };

  if (websiteUrl) {
    step("Opening the website");
    await page
      .goto(websiteUrl, { waitUntil: "domcontentloaded", timeout: 45000 })
      .catch(async () => {
        await page.goto(websiteUrl, { waitUntil: "load", timeout: 45000 });
      });
  }
  await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});

  step("Loading fonts and images");
  await waitForAssets(page);

  step("Closing cookie banners and popups");
  const popups = await dismissPopups(page);

  step("Loading lazy content");
  await primeLazyContent(page);

  // Popups sometimes reappear after the scroll pass.
  await dismissPopups(page).catch(() => {});

  step("Measuring page layout");
  const chrome = await measureChrome(page);

  return {
    url: page.url(),
    ...chrome,
    popupsClosed: popups.clicked,
    overlaysHidden: popups.hiddenOverlays,
    preparedAt: Date.now(),
  };
}

module.exports = { prepareWebsite, dismissPopups, primeLazyContent, measureChrome };
