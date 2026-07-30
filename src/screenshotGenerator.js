const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium, devices } = require("playwright");
const { updateJob } = require("./jobs");

const MIN_OUTPUT_BYTES = 10 * 1024;

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
};

const COOKIE_HIDE_CSS = `
[id*="cookie" i], [class*="cookie" i],
[id*="consent" i], [class*="consent" i],
[id*="gdpr" i], [class*="gdpr" i],
[aria-label*="cookie" i], [data-testid*="cookie" i],
#onetrust-consent-sdk, #CybotCookiebotDialog, .cc-window, .fc-consent-root {
  display: none !important;
}
html, body { overflow: auto !important; }
`;

const FIXED_HEADER_HIDE_JS = () => {
  const nodes = Array.from(document.querySelectorAll("body *"));
  for (const el of nodes) {
    const style = window.getComputedStyle(el);
    if (style.position === "fixed" || style.position === "sticky") {
      el.style.setProperty("display", "none", "important");
    }
  }
};

function classifyError(err) {
  const msg = err && err.message ? err.message : String(err);
  if (/ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_REFUSED|ERR_ADDRESS_UNREACHABLE/i.test(msg)) {
    return "The website is unavailable or could not be reached.";
  }
  if (/Timeout|timed out/i.test(msg)) {
    return "The website took too long to respond and timed out.";
  }
  if (/ERR_BLOCKED|403|captcha|Access Denied/i.test(msg)) {
    return "The website blocked automated capture.";
  }
  return `Screenshot generation failed: ${msg}`;
}

async function generateScreenshot(job) {
  const { params } = job;
  const {
    websiteUrl,
    device,
    format,
    quality,
    delay,
    hideCookiePopups,
    hideFixedHeaders,
    transparentBackground,
  } = params;

  const viewport = VIEWPORTS[device] || VIEWPORTS.desktop;
  const jobRoot = path.join(os.tmpdir(), "scrollcapture-shots", job.id);
  await fs.promises.mkdir(jobRoot, { recursive: true });
  const outputPath = path.join(jobRoot, `screenshot.${format === "jpg" ? "jpg" : "png"}`);

  updateJob(job.id, { status: "validating", step: "Validating URL", progress: 4 });

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const contextOptions =
      device === "mobile"
        ? { ...devices["iPhone 13"], viewport, screen: viewport }
        : { viewport, deviceScaleFactor: 1 };
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    updateJob(job.id, { status: "opening_page", step: "Opening webpage", progress: 15 });

    try {
      await page.goto(websiteUrl, { waitUntil: "networkidle", timeout: 45000 }).catch(async () => {
        await page.goto(websiteUrl, { waitUntil: "load", timeout: 45000 });
      });
    } catch (err) {
      throw new Error(classifyError(err));
    }

    updateJob(job.id, { status: "loading_content", step: "Loading content", progress: 35 });
    await page.waitForTimeout(Math.min(10000, Math.max(0, Number(delay) || 0)));

    updateJob(job.id, {
      status: "preparing_capture",
      step: "Preparing full-page capture",
      progress: 55,
    });

    if (hideCookiePopups) {
      await page.addStyleTag({ content: COOKIE_HIDE_CSS }).catch(() => {});
    }
    if (hideFixedHeaders) {
      await page.evaluate(FIXED_HEADER_HIDE_JS).catch(() => {});
    }
    await page
      .addStyleTag({ content: "html,body{scroll-behavior:auto !important;}" })
      .catch(() => {});

    // Trigger lazy-loaded content by scrolling through the page once.
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let y = 0;
        const step = window.innerHeight;
        const timer = setInterval(() => {
          window.scrollTo(0, y);
          y += step;
          if (y >= document.body.scrollHeight) {
            clearInterval(timer);
            window.scrollTo(0, 0);
            resolve();
          }
        }, 100);
      });
    });
    await page.waitForTimeout(500);

    updateJob(job.id, { status: "capturing", step: "Capturing screenshot", progress: 75 });

    const transparent = Boolean(transparentBackground) && format === "png";
    if (transparent) {
      await page
        .addStyleTag({ content: "html,body{background:transparent !important;}" })
        .catch(() => {});
    }

    const shotOptions = {
      path: outputPath,
      fullPage: true,
      type: format === "jpg" ? "jpeg" : "png",
    };
    if (format === "jpg") shotOptions.quality = Number(quality) || 85;
    if (transparent) shotOptions.omitBackground = true;

    try {
      await page.screenshot(shotOptions);
    } catch (err) {
      throw new Error(classifyError(err));
    }

    const dimensions = await page.evaluate(() => ({
      width: Math.max(document.documentElement.clientWidth, window.innerWidth || 0),
      height: Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight,
        document.body.offsetHeight,
        document.documentElement.offsetHeight,
      ),
    }));

    await context.close();

    updateJob(job.id, { status: "finalizing", step: "Finalizing image", progress: 92 });

    const stat = await fs.promises.stat(outputPath);
    if (stat.size < MIN_OUTPUT_BYTES) {
      throw new Error(`Generated image is too small (${stat.size} bytes).`);
    }

    updateJob(job.id, {
      status: "completed",
      step: "Completed",
      progress: 100,
      filePath: outputPath,
      fileSize: stat.size,
      width: dimensions.width,
      height: dimensions.height,
    });
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { generateScreenshot, MIN_OUTPUT_BYTES };