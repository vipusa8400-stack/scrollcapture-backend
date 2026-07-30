const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { chromium, devices } = require("playwright");
const { updateJob } = require("./jobs");
const { generateScenePlan, CLICK_ACTIONS } = require("./aiScript");
const { synthesizeSpeech } = require("./fishAudio");
const { applyEmotionDirection, stripEmotionTags } = require("./emotionDirector");
const { PAGE_RUNTIME } = require("./pageRuntime");
const { resolveTarget, remeasure, sectionFallback } = require("./sceneTargeting");
const {
  FPS,
  zoomScaleFor,
  scrollTargetFor,
  scrollTo,
  moveCursor,
  clickRipple,
  animateZoom,
  hold,
} = require("./cinematics");

const MIN_OUTPUT_BYTES = 10 * 1024;
const SCROLL_SECONDS = 1.0;
const ZOOM_IN_SECONDS = 0.9;
const ZOOM_OUT_SECONDS = 0.5;
const TAIL_SECONDS = 0.35;

const VIEWPORTS = {
  desktop: { width: 1280, height: 720 },
  mobile: { width: 390, height: 844 },
};

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

async function ensureRuntime(page) {
  await page.evaluate(PAGE_RUNTIME).catch(() => {});
  await page.evaluate(() => window.__scWalkthrough.ensureOverlay()).catch(() => {});
}

async function readMetrics(page) {
  return (
    (await page.evaluate(() => window.__scWalkthrough.metrics()).catch(() => null)) || {
      scrollY: 0,
      viewportWidth: 0,
      viewportHeight: 0,
      pageHeight: 0,
      stickyHeaderHeight: 0,
    }
  );
}

async function generatePresentation(job) {
  const { params } = job;
  const {
    websiteUrl,
    changes,
    language,
    tone,
    device,
    subtitles,
    emotionStyle,
    scenes: approvedScenes,
  } = params;

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

    // Inject before navigation so the runtime survives route changes too.
    await context.addInitScript(PAGE_RUNTIME).catch(() => {});

    await page.goto(websiteUrl, { waitUntil: "networkidle", timeout: 45000 }).catch(async () => {
      await page.goto(websiteUrl, { waitUntil: "load", timeout: 45000 });
    });
    await page.waitForTimeout(1500);
    await ensureRuntime(page);

    const pageOutline = await page.evaluate(() => {
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

    let plan;
    if (Array.isArray(approvedScenes) && approvedScenes.length) {
      plan = {
        script: approvedScenes.map((s) => s.speech).join("\n\n"),
        scenes: approvedScenes,
      };
    } else {
      updateJob(job.id, { status: "scripting", step: "Creating AI script", progress: 14 });
      plan = await generateScenePlan({ websiteUrl, changes, language, tone, pageOutline });
      updateJob(job.id, { step: "Directing voice emotions", progress: 20 });
      plan.scenes = await applyEmotionDirection({
        scenes: plan.scenes,
        emotionStyle: emotionStyle || "auto",
        language,
        changes,
      });
      plan.script = plan.scenes.map((s) => s.speech).join("\n\n");
    }

    updateJob(job.id, {
      status: "voicing",
      step: "Generating voice",
      progress: 26,
      sceneCount: plan.scenes.length,
    });

    const audioClips = [];
    for (let i = 0; i < plan.scenes.length; i++) {
      const clipPath = path.join(audioDir, `scene-${i}.mp3`);
      await synthesizeSpeech({ text: plan.scenes[i].speech, outputPath: clipPath });
      audioClips.push({ path: clipPath, duration: await audioDuration(clipPath) });
      updateJob(job.id, { progress: 26 + Math.round(((i + 1) / plan.scenes.length) * 12) });
    }

    updateJob(job.id, { status: "locating", step: "Finding elements", progress: 40 });
    updateJob(job.id, { status: "recording", step: "Recording scenes", progress: 46 });

    let frameIndex = 0;
    let timeline = 0;
    const srtParts = [];
    const sceneTimings = [];
    const state = { cursor: null };

    const shoot = async () => {
      frameIndex += 1;
      await page.screenshot({
        path: path.join(framesDir, `frame-${String(frameIndex).padStart(6, "0")}.png`),
        type: "png",
      });
    };

    for (let i = 0; i < plan.scenes.length; i++) {
      const scene = plan.scenes[i];
      const clip = audioClips[i];
      let lead = 0;
      let trail = 0;

      await ensureRuntime(page);
      let metrics = await readMetrics(page);

      // --- 1. Locate the exact element for THIS scene (never a fixed position).
      let found = await resolveTarget(page, scene);
      let usedFallback = false;
      if (!found) {
        found = sectionFallback({
          index: i,
          total: plan.scenes.length,
          maxScroll: Math.max(0, metrics.pageHeight - viewport.height),
          viewport,
        });
        usedFallback = true;
      }

      // --- 2. Scroll so the element sits in the centre (below sticky headers).
      let dest = scrollTargetFor(found.rect, viewport, metrics);
      lead += await scrollTo(page, shoot, metrics.scrollY, dest, SCROLL_SECONDS);
      metrics = await readMetrics(page);
      found = usedFallback ? found : await remeasure(page, found, scene);

      // --- 3. Optional interaction: cursor -> hover -> click -> wait -> recalc.
      if (CLICK_ACTIONS.has(scene.action) && found.selector) {
        const cx = Math.round(found.rect.x + found.rect.width / 2);
        const cy = Math.round(found.rect.y + found.rect.height / 2);
        lead += await moveCursor(page, shoot, state, cx, cy, { seconds: 0.9, hover: 0.3 });
        lead += await clickRipple(page, shoot, state, 0.4);

        const before = page.url();
        await page
          .locator(found.selector)
          .first()
          .click({ timeout: 4000, noWaitAfter: true })
          .catch(() => {});
        await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(900); // animations / menu open / content load
        lead += await hold(shoot, 0.9);

        await ensureRuntime(page);
        metrics = await readMetrics(page);

        // Recalculate everything after the layout / route change.
        const navigated = page.url() !== before;
        const followUp = {
          ...scene,
          selector: null,
          selectors: [],
          target: scene.expectedDestination
            ? String(scene.expectedDestination).replace(/^[#/]/, "").replace(/[-_]/g, " ")
            : scene.target,
        };
        const next =
          (scene.expectedDestination ? await resolveTarget(page, followUp) : null) ||
          (navigated ? null : await remeasure(page, found, scene));
        if (next) {
          found = next;
          usedFallback = false;
          dest = scrollTargetFor(found.rect, viewport, metrics);
          lead += await scrollTo(page, shoot, metrics.scrollY, dest, 0.8);
          metrics = await readMetrics(page);
          found = await remeasure(page, found, scene);
        } else {
          // Landed on a new page: present the top section instead of a random zoom.
          found = {
            rect: { x: 0, y: metrics.scrollY, width: viewport.width, height: viewport.height },
            selector: null,
            source: "section",
          };
          usedFallback = true;
        }
      }

      // --- 4. Highlight the exact element and zoom around it.
      const wantsHighlight = !usedFallback && scene.action !== "zoom" && scene.action !== "scroll_to";
      const wantsZoom = scene.action !== "highlight" && scene.action !== "scroll_to";
      if (wantsHighlight) {
        await page.evaluate((r) => window.__scWalkthrough.showHighlight(r, 8), found.rect);
      }

      const targetScale = wantsZoom
        ? usedFallback
          ? Math.min(1.15, zoomScaleFor(found.rect, viewport))
          : zoomScaleFor(found.rect, viewport)
        : 1;
      const originX = Math.round(found.rect.x + found.rect.width / 2);
      const originY = Math.round(found.rect.y + found.rect.height / 2);

      lead += await animateZoom(page, shoot, 1, targetScale, originX, originY, ZOOM_IN_SECONDS);

      // Keep the cursor near — but not on top of — the text while speaking.
      if (state.cursor && !usedFallback) {
        const parkX = Math.round(found.rect.x + found.rect.width + 26);
        const parkY = Math.round(found.rect.y + found.rect.height + 22);
        lead += await moveCursor(page, shoot, state, parkX, parkY, { seconds: 0.4, hover: 0 });
      }

      // --- 5. Hold while the narration plays.
      const holdStart = timeline + lead;
      const held = await hold(shoot, clip.duration);
      srtParts.push({
        start: holdStart,
        end: holdStart + held,
        text: stripEmotionTags(scene.speech),
      });

      // --- 6. Zoom back out and reset the camera before the next element.
      trail += await animateZoom(
        page,
        shoot,
        targetScale,
        1,
        originX,
        originY,
        ZOOM_OUT_SECONDS,
      );
      await page.evaluate(() => {
        window.__scWalkthrough.setZoom(1, 0, 0);
        window.__scWalkthrough.hideHighlight();
      });
      trail += await hold(shoot, TAIL_SECONDS);

      timeline += lead + held + trail;
      sceneTimings.push({ lead, hold: held, trail });

      updateJob(job.id, {
        progress: 46 + Math.round(((i + 1) / plan.scenes.length) * 34),
        step: `Recording scene ${i + 1} of ${plan.scenes.length}`,
      });
    }

    await context.close();

    updateJob(job.id, { status: "rendering", step: "Rendering video", progress: 84 });

    // Narration track: per-scene silence lead + speech + trail, matching the video.
    const trackPath = path.join(audioDir, "narration.m4a");
    const inputs = [];
    const filters = [];
    for (let i = 0; i < audioClips.length; i++) {
      const { lead, trail } = sceneTimings[i];
      const leadMs = Math.max(0, Math.round(lead * 1000));
      inputs.push("-i", audioClips[i].path);
      filters.push(
        `[${i}:a]aresample=44100,adelay=${leadMs}|${leadMs},apad=pad_dur=${Math.max(
          0.05,
          trail,
        ).toFixed(2)}[a${i}]`,
      );
    }
    const n = audioClips.length;
    const concat = `${filters.map((_, i) => `[a${i}]`).join("")}concat=n=${n}:v=0:a=1[out]`;
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
        .map((p, i) => `${i + 1}\n${srtTime(p.start)} --> ${srtTime(p.end)}\n${p.text}\n`)
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
