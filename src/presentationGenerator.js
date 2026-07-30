const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { chromium, devices } = require("playwright");
const { updateJob } = require("./jobs");
const { generateScenePlan } = require("./aiScript");
const { synthesizeSpeech } = require("./fishAudio");

const MIN_OUTPUT_BYTES = 10 * 1024;
const FPS = 24;
const SCROLL_SECONDS = 1.0;
const ZOOM_IN_SECONDS = 0.9;
const ZOOM_OUT_SECONDS = 0.5;
const TAIL_SECONDS = 0.35;
const ZOOM_SCALE = 1.35;

const VIEWPORTS = {
  desktop: { width: 1280, height: 720 },
  mobile: { width: 390, height: 844 },
};

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(stdout)
        : reject(new Error(`${cmd} exited with ${code}: ${stderr.slice(-500)}`)),
    );
  });
}

async function audioDuration(file) {
  const out = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  const seconds = Number(String(out).trim());
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 3;
}

function srtTime(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = String(Math.floor(ms / 3600000)).padStart(2, "0");
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0");
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
  const f = String(ms % 1000).padStart(3, "0");
  return `${h}:${m}:${s},${f}`;
}

const OVERLAY_SCRIPT = `
window.__scWalkthrough = {
  ensureOverlay() {
    if (document.getElementById('__sc_overlay')) return;
    const style = document.createElement('style');
    style.id = '__sc_overlay_style';
    style.textContent = \`
      #__sc_overlay{position:absolute;pointer-events:none;z-index:2147483646;border-radius:14px;
        border:3px solid rgba(59,130,246,.95);
        box-shadow:0 0 0 6px rgba(59,130,246,.18),0 0 34px 8px rgba(59,130,246,.45);
        transition:opacity .25s ease;opacity:0;}
      html{scroll-behavior:auto !important;}
    \`;
    document.head.appendChild(style);
    const el = document.createElement('div');
    el.id = '__sc_overlay';
    document.body.appendChild(el);
  },
  findTarget(query) {
    const q = String(query || '').toLowerCase().trim();
    if (!q) return null;
    const words = q.split(/\\s+/).filter((w) => w.length > 2);
    const candidates = Array.from(document.querySelectorAll(
      'section,header,footer,nav,main,article,aside,div,a,button,form,img,h1,h2,h3,[role],[aria-label]'
    ));
    let best = null;
    let bestScore = 0;
    for (const el of candidates) {
      const r = el.getBoundingClientRect();
      if (r.width < 24 || r.height < 18) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.1) continue;
      const hay = [
        el.getAttribute('aria-label') || '',
        el.getAttribute('id') || '',
        el.className && typeof el.className === 'string' ? el.className : '',
        el.getAttribute('href') || '',
        el.getAttribute('alt') || '',
        (el.textContent || '').slice(0, 240),
        el.tagName,
      ].join(' ').toLowerCase();
      let score = 0;
      if (hay.includes(q)) score += 6;
      for (const w of words) if (hay.includes(w)) score += 2;
      if (score === 0) continue;
      const area = r.width * r.height;
      if (area > window.innerWidth * window.innerHeight * 3) score -= 3;
      if (el.children.length === 0) score += 1;
      if (score > bestScore) { bestScore = score; best = el; }
    }
    if (!best) return null;
    const r = best.getBoundingClientRect();
    return {
      x: r.left + window.scrollX,
      y: r.top + window.scrollY,
      width: r.width,
      height: r.height,
    };
  },
  showHighlight(rect, pad) {
    this.ensureOverlay();
    const el = document.getElementById('__sc_overlay');
    el.style.left = (rect.x - pad) + 'px';
    el.style.top = (rect.y - pad) + 'px';
    el.style.width = (rect.width + pad * 2) + 'px';
    el.style.height = (rect.height + pad * 2) + 'px';
    el.style.opacity = '1';
  },
  hideHighlight() {
    const el = document.getElementById('__sc_overlay');
    if (el) el.style.opacity = '0';
  },
  setZoom(scale, originX, originY) {
    const root = document.documentElement;
    if (scale === 1) {
      root.style.transform = '';
      root.style.transformOrigin = '';
      return;
    }
    root.style.transformOrigin = originX + 'px ' + originY + 'px';
    root.style.transform = 'scale(' + scale + ')';
  },
};
`;

async function generatePresentation(job) {
  const { params } = job;
  const { websiteUrl, changes, language, voiceId, tone, device, subtitles } = params;

  const viewport = VIEWPORTS[device] || VIEWPORTS.desktop;
  const jobRoot = path.join(os.tmpdir(), "scrollcapture-presentation", job.id);
  const framesDir = path.join(jobRoot, "frames");
  const audioDir = path.join(jobRoot, "audio");
  await fs.promises.mkdir(framesDir, { recursive: true });
  await fs.promises.mkdir(audioDir, { recursive: true });
  const outputPath = path.join(jobRoot, "presentation.mp4");

  updateJob(job.id, { status: "analyzing", step: "Analyzing website", progress: 4 });

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

    await page.goto(websiteUrl, { waitUntil: "networkidle", timeout: 45000 }).catch(async () => {
      await page.goto(websiteUrl, { waitUntil: "load", timeout: 45000 });
    });
    await page.waitForTimeout(1500);
    await page.addInitScript(OVERLAY_SCRIPT).catch(() => {});
    await page.evaluate(OVERLAY_SCRIPT);

    const pageOutline = await page.evaluate(() => {
      const out = [];
      const nodes = document.querySelectorAll(
        "h1,h2,h3,a,button,section[id],nav,header,footer,[aria-label]",
      );
      for (const el of Array.from(nodes).slice(0, 120)) {
        const text = (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 70);
        if (!text) continue;
        const sel = el.id ? `#${el.id}` : el.tagName.toLowerCase();
        out.push(`${text} | ${el.tagName.toLowerCase()} | ${sel}`);
      }
      return out;
    });

    updateJob(job.id, { status: "scripting", step: "Creating AI script", progress: 14 });
    const plan = await generateScenePlan({
      websiteUrl,
      changes,
      language,
      tone,
      pageOutline,
    });

    updateJob(job.id, {
      status: "voicing",
      step: "Generating voice",
      progress: 26,
      sceneCount: plan.scenes.length,
    });

    const audioClips = [];
    for (let i = 0; i < plan.scenes.length; i++) {
      const clipPath = path.join(audioDir, `scene-${i}.mp3`);
      await synthesizeSpeech({ text: plan.scenes[i].speech, voiceId, outputPath: clipPath });
      audioClips.push({ path: clipPath, duration: await audioDuration(clipPath) });
      updateJob(job.id, {
        progress: 26 + Math.round(((i + 1) / plan.scenes.length) * 12),
      });
    }

    updateJob(job.id, { status: "locating", step: "Finding elements", progress: 40 });

    const pageHeight = await page.evaluate(() =>
      Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
    );
    const maxScroll = Math.max(0, pageHeight - viewport.height);

    const targets = [];
    for (let i = 0; i < plan.scenes.length; i++) {
      const rect = await page.evaluate(
        (q) => window.__scWalkthrough.findTarget(q),
        plan.scenes[i].target || plan.scenes[i].title,
      );
      targets.push(
        rect || {
          x: 0,
          y: Math.min(maxScroll, Math.round((i / Math.max(1, plan.scenes.length)) * maxScroll)),
          width: viewport.width,
          height: viewport.height * 0.6,
        },
      );
    }

    updateJob(job.id, { status: "recording", step: "Recording scenes", progress: 46 });

    let frameIndex = 0;
    let currentScroll = 0;
    let timeline = 0;
    const srtParts = [];

    const shoot = async () => {
      frameIndex += 1;
      await page.screenshot({
        path: path.join(framesDir, `frame-${String(frameIndex).padStart(6, "0")}.png`),
        type: "png",
      });
    };

    for (let i = 0; i < plan.scenes.length; i++) {
      const scene = plan.scenes[i];
      const rect = targets[i];
      const clip = audioClips[i];
      const wantsZoom = scene.action !== "highlight";
      const wantsHighlight = scene.action !== "zoom";

      const targetCenterY = rect.y + rect.height / 2;
      const destScroll = Math.max(
        0,
        Math.min(maxScroll, Math.round(targetCenterY - viewport.height / 2)),
      );

      // Cinematic scroll to the element.
      const scrollFrames = Math.round(SCROLL_SECONDS * FPS);
      const from = currentScroll;
      for (let f = 0; f < scrollFrames; f++) {
        const y = Math.round(from + (destScroll - from) * easeInOut(f / (scrollFrames - 1 || 1)));
        await page.evaluate((sy) => window.scrollTo(0, sy), y);
        await shoot();
      }
      currentScroll = destScroll;
      timeline += SCROLL_SECONDS;

      if (wantsHighlight) {
        await page.evaluate(
          (r) => window.__scWalkthrough.showHighlight(r, 8),
          rect,
        );
      }

      const originX = rect.x + rect.width / 2;
      const originY = rect.y + rect.height / 2;

      // Zoom in.
      const zoomInFrames = Math.round(ZOOM_IN_SECONDS * FPS);
      for (let f = 0; f < zoomInFrames; f++) {
        const p = easeInOut(f / (zoomInFrames - 1 || 1));
        const scale = wantsZoom ? 1 + (ZOOM_SCALE - 1) * p : 1;
        await page.evaluate(
          ([s, ox, oy]) => window.__scWalkthrough.setZoom(s, ox, oy),
          [scale, originX, originY],
        );
        await shoot();
      }
      timeline += ZOOM_IN_SECONDS;

      // Hold while the narration plays.
      const holdStart = timeline;
      const holdFrames = Math.max(1, Math.round(clip.duration * FPS));
      for (let f = 0; f < holdFrames; f++) await shoot();
      timeline += clip.duration;

      srtParts.push({ start: holdStart, end: timeline, text: scene.speech });

      // Zoom back out.
      const zoomOutFrames = Math.round(ZOOM_OUT_SECONDS * FPS);
      for (let f = 0; f < zoomOutFrames; f++) {
        const p = easeInOut(f / (zoomOutFrames - 1 || 1));
        const scale = wantsZoom ? ZOOM_SCALE + (1 - ZOOM_SCALE) * p : 1;
        await page.evaluate(
          ([s, ox, oy]) => window.__scWalkthrough.setZoom(s, ox, oy),
          [scale, originX, originY],
        );
        await shoot();
      }
      await page.evaluate(() => {
        window.__scWalkthrough.setZoom(1, 0, 0);
        window.__scWalkthrough.hideHighlight();
      });
      timeline += ZOOM_OUT_SECONDS;

      // Small breath between scenes.
      const tailFrames = Math.round(TAIL_SECONDS * FPS);
      for (let f = 0; f < tailFrames; f++) await shoot();
      timeline += TAIL_SECONDS;

      updateJob(job.id, {
        progress: 46 + Math.round(((i + 1) / plan.scenes.length) * 34),
        step: `Recording scene ${i + 1} of ${plan.scenes.length}`,
      });
    }

    await context.close();

    updateJob(job.id, { status: "rendering", step: "Rendering video", progress: 84 });

    // Build the narration track: silence padding + speech, per scene.
    const trackPath = path.join(audioDir, "narration.m4a");
    const inputs = [];
    const filters = [];
    let idx = 0;
    for (let i = 0; i < audioClips.length; i++) {
      const lead = SCROLL_SECONDS + ZOOM_IN_SECONDS;
      const trail = ZOOM_OUT_SECONDS + TAIL_SECONDS;
      inputs.push("-i", audioClips[i].path);
      filters.push(
        `[${idx}:a]aresample=44100,adelay=${Math.round(lead * 1000)}|${Math.round(
          lead * 1000,
        )},apad=pad_dur=${trail.toFixed(2)}[a${idx}]`,
      );
      idx += 1;
    }
    const concat = `${filters.map((_, i) => `[a${i}]`).join("")}concat=n=${idx}:v=0:a=1[out]`;
    await run("ffmpeg", [
      "-y",
      ...inputs,
      "-filter_complex", `${filters.join(";")};${concat}`,
      "-map", "[out]",
      "-c:a", "aac",
      "-b:a", "160k",
      trackPath,
    ]);

    const videoFilters = ["scale=trunc(iw/2)*2:trunc(ih/2)*2"];
    if (subtitles) {
      const srtPath = path.join(jobRoot, "subs.srt");
      const srt = srtParts
        .map(
          (p, i) =>
            `${i + 1}\n${srtTime(p.start)} --> ${srtTime(p.end)}\n${p.text}\n`,
        )
        .join("\n");
      await fs.promises.writeFile(srtPath, srt, "utf8");
      videoFilters.push(
        `subtitles='${srtPath.replace(/'/g, "\\'")}':force_style='FontSize=18,Outline=1,Shadow=0,MarginV=40'`,
      );
    }

    await run("ffmpeg", [
      "-y",
      "-framerate", String(FPS),
      "-i", path.join(framesDir, "frame-%06d.png"),
      "-i", trackPath,
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-preset", "medium",
      "-crf", "20",
      "-vf", videoFilters.join(","),
      "-c:a", "aac",
      "-b:a", "160k",
      "-shortest",
      "-movflags", "+faststart",
      outputPath,
    ]);

    const stat = await fs.promises.stat(outputPath);
    if (stat.size < MIN_OUTPUT_BYTES) {
      throw new Error(`Rendered presentation is too small (${stat.size} bytes).`);
    }

    await fs.promises.rm(framesDir, { recursive: true, force: true }).catch(() => {});

    updateJob(job.id, {
      status: "completed",
      step: "Completed",
      progress: 100,
      filePath: outputPath,
      fileSize: stat.size,
      durationSeconds: Math.round(timeline),
      script: plan.script,
      scenes: plan.scenes,
    });
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { generatePresentation, MIN_OUTPUT_BYTES };
