const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { chromium, devices } = require("playwright");
const { updateJob } = require("./jobs");

const MIN_OUTPUT_BYTES = 10 * 1024;
const FPS = 30;

const ASPECT_SIZES = {
  desktop: {
    horizontal: { width: 1280, height: 720 },
    square: { width: 1080, height: 1080 },
    vertical: { width: 720, height: 1280 },
  },
  mobile: {
    horizontal: { width: 896, height: 504 },
    square: { width: 720, height: 720 },
    vertical: { width: 390, height: 844 },
  },
};

const SPEED_MULTIPLIER = { slow: 0.6, normal: 1.0, fast: 1.6 };

function resolveViewport(device, aspectRatio) {
  const bucket = ASPECT_SIZES[device] || ASPECT_SIZES.desktop;
  return bucket[aspectRatio] || bucket.horizontal;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`));
    });
  });
}

async function encode(framesDir, outputPath, format) {
  const input = path.join(framesDir, "frame-%06d.png");
  const common = ["-y", "-framerate", String(FPS), "-i", input];
  if (format === "mp4") {
    await runFfmpeg([
      ...common,
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-preset", "medium",
      "-crf", "20",
      "-movflags", "+faststart",
      "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
      outputPath,
    ]);
  } else if (format === "webm") {
    await runFfmpeg([
      ...common,
      "-c:v", "libvpx-vp9",
      "-b:v", "0",
      "-crf", "32",
      "-pix_fmt", "yuv420p",
      "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
      outputPath,
    ]);
  } else if (format === "gif") {
    const palette = path.join(framesDir, "palette.png");
    await runFfmpeg([
      "-y", "-framerate", String(FPS), "-i", input,
      "-vf", "fps=15,scale=720:-2:flags=lanczos,palettegen",
      palette,
    ]);
    await runFfmpeg([
      "-y", "-framerate", String(FPS), "-i", input, "-i", palette,
      "-lavfi", "fps=15,scale=720:-2:flags=lanczos[x];[x][1:v]paletteuse",
      outputPath,
    ]);
  } else {
    throw new Error(`Unsupported format: ${format}`);
  }
}

async function generateVideo(job) {
  const { params } = job;
  const { websiteUrl, device, aspectRatio, scrollSpeed, duration, format } = params;

  const viewport = resolveViewport(device, aspectRatio);
  const jobRoot = path.join(os.tmpdir(), "scrollcapture", job.id);
  const framesDir = path.join(jobRoot, "frames");
  await fs.promises.mkdir(framesDir, { recursive: true });

  const outputPath = path.join(jobRoot, `output.${format}`);

  updateJob(job.id, { status: "opening_page", step: "Opening webpage", progress: 5 });

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

    updateJob(job.id, { status: "loading_content", step: "Loading content", progress: 15 });

    await page.goto(websiteUrl, { waitUntil: "networkidle", timeout: 45000 }).catch(async () => {
      await page.goto(websiteUrl, { waitUntil: "load", timeout: 45000 });
    });
    await page.waitForTimeout(1200);

    await page.addStyleTag({ content: "html,body{scroll-behavior:auto !important;}" });

    const pageHeight = await page.evaluate(() =>
      Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight,
        document.body.offsetHeight,
        document.documentElement.offsetHeight,
      ),
    );
    const vh = viewport.height;
    const scrollDistance = Math.max(0, pageHeight - vh);

    const totalFrames = duration * FPS;
    const speed = SPEED_MULTIPLIER[scrollSpeed] || 1.0;

    updateJob(job.id, { status: "scrolling", step: "Capturing frames", progress: 25 });

    for (let i = 0; i < totalFrames; i++) {
      const t = i / Math.max(1, totalFrames - 1);
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const travel = Math.min(1, eased * speed);
      const y = Math.round(scrollDistance * travel);
      await page.evaluate((sy) => window.scrollTo(0, sy), y);
      await page.waitForTimeout(5);
      const framePath = path.join(
        framesDir,
        `frame-${String(i + 1).padStart(6, "0")}.png`,
      );
      await page.screenshot({ path: framePath, type: "png", fullPage: false });

      if (i % Math.max(1, Math.floor(totalFrames / 20)) === 0) {
        const pct = 25 + Math.round((i / totalFrames) * 55);
        updateJob(job.id, { progress: pct });
      }
    }

    await context.close();

    updateJob(job.id, { status: "rendering", step: "Rendering video", progress: 85 });

    await encode(framesDir, outputPath, format);

    const stat = await fs.promises.stat(outputPath);
    if (stat.size < MIN_OUTPUT_BYTES) {
      throw new Error(`Rendered file too small (${stat.size} bytes).`);
    }

    await fs.promises.rm(framesDir, { recursive: true, force: true }).catch(() => {});

    updateJob(job.id, {
      status: "completed",
      step: "Completed",
      progress: 100,
      filePath: outputPath,
      fileSize: stat.size,
    });
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { generateVideo, MIN_OUTPUT_BYTES };