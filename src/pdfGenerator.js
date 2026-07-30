const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium, devices } = require("playwright");
const { updateJob } = require("./jobs");

const MIN_OUTPUT_BYTES = 1024;

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
};

const MARGINS = {
  none: "0mm",
  small: "8mm",
  normal: "16mm",
  large: "28mm",
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
  return `PDF generation failed: ${msg}`;
}

function countPdfPages(buffer) {
  const text = buffer.toString("latin1");
  const counts = text.match(/\/Count\s+(\d+)/g);
  if (counts && counts.length) {
    const numbers = counts.map((c) => Number(c.replace(/\D+/g, "")));
    const max = Math.max(...numbers);
    if (max > 0) return max;
  }
  const pages = text.match(/\/Type\s*\/Page[^s]/g);
  return pages ? pages.length : 1;
}

async function generatePdf(job) {
  const { params } = job;
  const { websiteUrl, device, paperSize, orientation, margin, printBackground } = params;

  const viewport = VIEWPORTS[device] || VIEWPORTS.desktop;
  const jobRoot = path.join(os.tmpdir(), "scrollcapture-pdf", job.id);
  await fs.promises.mkdir(jobRoot, { recursive: true });
  const outputPath = path.join(jobRoot, "document.pdf");

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

    updateJob(job.id, { status: "opening_page", step: "Opening website", progress: 15 });

    try {
      await page.goto(websiteUrl, { waitUntil: "networkidle", timeout: 45000 }).catch(async () => {
        await page.goto(websiteUrl, { waitUntil: "load", timeout: 45000 });
      });
    } catch (err) {
      throw new Error(classifyError(err));
    }

    updateJob(job.id, { status: "loading_content", step: "Loading page", progress: 35 });
    await page.waitForTimeout(2000);

    // Trigger lazy-loaded content.
    await page
      .evaluate(async () => {
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
      })
      .catch(() => {});

    updateJob(job.id, {
      status: "preparing_print",
      step: "Preparing print layout",
      progress: 55,
    });
    await page.emulateMedia({ media: "print" }).catch(() => {});
    await page.waitForTimeout(500);

    updateJob(job.id, { status: "generating_pdf", step: "Generating PDF", progress: 75 });

    const marginValue = MARGINS[margin] || MARGINS.normal;
    try {
      await page.pdf({
        path: outputPath,
        format: paperSize === "letter" ? "Letter" : paperSize === "legal" ? "Legal" : "A4",
        landscape: orientation === "landscape",
        printBackground: Boolean(printBackground),
        preferCSSPageSize: false,
        margin: {
          top: marginValue,
          bottom: marginValue,
          left: marginValue,
          right: marginValue,
        },
      });
    } catch (err) {
      throw new Error(classifyError(err));
    }

    await context.close();

    updateJob(job.id, { status: "finalizing", step: "Finalizing", progress: 92 });

    const stat = await fs.promises.stat(outputPath);
    if (stat.size < MIN_OUTPUT_BYTES) {
      throw new Error(`Generated PDF is too small (${stat.size} bytes).`);
    }
    const buffer = await fs.promises.readFile(outputPath);
    const pageCount = countPdfPages(buffer);

    updateJob(job.id, {
      status: "completed",
      step: "Completed",
      progress: 100,
      filePath: outputPath,
      fileSize: stat.size,
      pageCount,
    });
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { generatePdf, MIN_OUTPUT_BYTES };
