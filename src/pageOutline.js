const { chromium, devices } = require("playwright");

const VIEWPORTS = {
  desktop: { width: 1280, height: 720 },
  mobile: { width: 390, height: 844 },
};

/** Opens the site headlessly and returns a list of visible landmark elements. */
async function fetchPageOutline({ websiteUrl, device }) {
  const viewport = VIEWPORTS[device] || VIEWPORTS.desktop;
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const context = await browser.newContext(
      device === "mobile"
        ? { ...devices["iPhone 13"], viewport, screen: viewport }
        : { viewport, deviceScaleFactor: 1 },
    );
    const page = await context.newPage();
    await page.goto(websiteUrl, { waitUntil: "networkidle", timeout: 45000 }).catch(async () => {
      await page.goto(websiteUrl, { waitUntil: "load", timeout: 45000 });
    });
    await page.waitForTimeout(1200);
    const outline = await page.evaluate(() => {
      const out = [];
      const nodes = document.querySelectorAll(
        "h1,h2,h3,a,button,section[id],nav,header,footer,[aria-label]",
      );
      for (const el of Array.from(nodes).slice(0, 140)) {
        const text = (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 70);
        if (!text) continue;
        const sel = el.id
          ? `#${el.id}`
          : el.getAttribute("href")
            ? `${el.tagName.toLowerCase()}[href="${el.getAttribute("href")}"]`
            : el.tagName.toLowerCase();
        out.push(`${text} | ${el.tagName.toLowerCase()} | ${sel}`);
      }
      return out;
    });
    await context.close();
    return outline;
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { fetchPageOutline };
