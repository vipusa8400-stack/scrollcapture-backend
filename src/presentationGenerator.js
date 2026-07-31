const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { chromium, devices } = require("playwright");
const { updateJob } = require("./jobs");
const { isCancelled } = require("./jobs");
const { UserFacingError } = require("./errors");
const cache = require("./cache");
const { buildMusicBed, mixNarrationWithMusic } = require("./music");
const { buildSubtitleFilter } = require("./subtitles");
const { buildBeforeScene } = require("./beforeAfter");
const { generateScenePlan, CLICK_ACTIONS } = require("./aiScript");
const { synthesizeSpeech } = require("./fishAudio");
const { applyEmotionDirection, stripEmotionTags } = require("./emotionDirector");
const { PAGE_RUNTIME } = require("./pageRuntime");
const { resolveTarget, remeasure } = require("./sceneTargeting");
const { prepareAndMap, buildStrategyAndScenes, outlineFromMap } = require("./websiteAnalysis");
const { computeFraming, splitShots } = require("./camera");
const { validateAndFixShot, scoreShot, readChrome } = require("./sceneValidation");
const { performNavigation, needsNavigation, waitForReady } = require("./navigation");
const { classifyClick } = require("./safeClick");
const { planSceneTiming, sceneTimestamps } = require("./sceneTiming");
const {
  APPROVE_SCORE,
  MAX_RETRIES,
  captureCheckpoint,
  reviewScene,
  planRetry,
  safeFallbackAdjust,
} = require("./sceneReview");
const { dismissPopups } = require("./websitePreparation");
const {
  FPS,
  scrollTo,
  moveCursor,
  clickRipple,
  parkCursor,
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
    subtitleMode: subtitleModeParam,
    music,
    existingUrl,
    emotionStyle,
    scenes: approvedScenes,
    mode,
    websiteMap: providedMap,
    strategy: providedStrategy,
    scenePlan: providedPlan,
  } = params;

  const viewport = VIEWPORTS[device] || VIEWPORTS.desktop;
  const subtitleMode = subtitleModeParam || (subtitles ? "clean" : "off");
  const musicStyle = music && music !== "none" ? music : null;
  const ensureLive = () => {
    if (isCancelled(job.id)) throw new UserFacingError("cancelled", "This job was cancelled.");
  };
  const jobRoot = path.join(os.tmpdir(), "scrollcapture-presentation", job.id);
  const framesDir = path.join(jobRoot, "frames");
  const audioDir = path.join(jobRoot, "audio");
  await fs.promises.mkdir(framesDir, { recursive: true });
  await fs.promises.mkdir(audioDir, { recursive: true });
  const outputPath = path.join(jobRoot, "presentation.mp4");

  updateJob(job.id, { status: "preparing", step: "Preparing website", progress: 4 });

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

    // --- Stages 1 & 2: prepare the website, then map every section.
    const stageProgress = { preparing: 6, mapping: 14, strategizing: 22, planning: 28 };
    const onStage = ({ key, label, detail }) =>
      updateJob(job.id, {
        status: key,
        step: detail ? `${label} — ${detail}` : label,
        progress: stageProgress[key] || 8,
      });

    ensureLive();
    const mapKey = cache.key("map", websiteUrl, device);
    const cachedMap = providedMap ? null : cache.get(mapKey);
    const { preparation, websiteMap } = providedMap
      ? { preparation: providedMap.preparation || null, websiteMap: providedMap }
      : cachedMap ||
        cache.set(mapKey, await prepareAndMap(page, { websiteUrl, onStage, previews: true }));
    if (cachedMap) {
      // Reuse the analysis, but the recorder still needs a live prepared page.
      await prepareAndMap(page, { websiteUrl, onStage, previews: false });
    }
    if (providedMap) {
      // The recorder still needs a freshly prepared live page.
      await prepareAndMap(page, { websiteUrl, onStage, previews: false });
    }
    await ensureRuntime(page);

    updateJob(job.id, {
      websiteMap,
      preparation,
      sectionCount: websiteMap.sections.length,
    });

    const pageOutline = outlineFromMap(websiteMap);

    let plan;
    let strategy = providedStrategy || null;
    let scenePlan = providedPlan || null;
    if (Array.isArray(approvedScenes) && approvedScenes.length) {
      plan = {
        script: approvedScenes.map((s) => s.speech).join("\n\n"),
        scenes: approvedScenes,
      };
      if (!scenePlan) {
        scenePlan = approvedScenes.map((s) => s.plan).filter(Boolean);
        if (!scenePlan.length) scenePlan = null;
      }
    } else {
      // --- Stages 3 & 4: strategy, then a detailed scene plan.
      if (!strategy || !scenePlan) {
        const built = await buildStrategyAndScenes({
          websiteUrl,
          changes,
          language,
          tone,
          mode,
          websiteMap,
          onStage,
        });
        strategy = strategy || built.strategy;
        scenePlan = scenePlan || built.scenePlan;
      }
      updateJob(job.id, { status: "scripting", step: "Creating AI script", progress: 32 });
      plan = await generateScenePlan({
        websiteUrl,
        changes,
        language,
        tone,
        pageOutline,
        strategy,
        scenePlan,
      });
      updateJob(job.id, { step: "Directing voice emotions", progress: 20 });
      plan.scenes = await applyEmotionDirection({
        scenes: plan.scenes,
        emotionStyle: emotionStyle || "auto",
        language,
        changes,
      });
      plan.script = plan.scenes.map((s) => s.speech).join("\n\n");
    }

    // --- Before/After mode: open with a brief look at the current website.
    if (existingUrl && existingUrl !== websiteUrl) {
      plan.scenes = [buildBeforeScene({ existingUrl, language, changes }), ...plan.scenes];
      plan.script = plan.scenes.map((s) => s.speech).join("\n\n");
    }

    ensureLive();
    updateJob(job.id, {
      status: "voicing",
      step: "Generating voice",
      progress: 38,
      sceneCount: plan.scenes.length,
      strategy,
      scenePlan,
    });

    const audioClips = [];
    for (let i = 0; i < plan.scenes.length; i++) {
      ensureLive();
      const clipPath = path.join(audioDir, `scene-${i}.mp3`);
      updateJob(job.id, { step: `Generating Sarah voice (${i + 1}/${plan.scenes.length})` });
      await synthesizeSpeech({ text: plan.scenes[i].speech, outputPath: clipPath });
      const duration = await audioDuration(clipPath);
      audioClips.push({
        path: clipPath,
        duration,
        timing: planSceneTiming({
          speech: plan.scenes[i].speech,
          duration,
          cue: plan.scenes[i].cue,
        }),
      });
      updateJob(job.id, { progress: 38 + Math.round(((i + 1) / plan.scenes.length) * 6) });
    }

    updateJob(job.id, { status: "timing", step: "Matching timings", progress: 42 });
    updateJob(job.id, { status: "validating_scenes", step: "Validating scenes", progress: 44 });
    updateJob(job.id, {
      status: "recording",
      step: "Recording scenes",
      progress: 46,
      totalScenes: plan.scenes.length,
    });

    let timeline = 0;
    const srtParts = [];
    const sceneTimings = [];
    const sceneReports = [];
    const scenesDir = path.join(jobRoot, "scenes");
    await fs.promises.mkdir(scenesDir, { recursive: true });
    const state = {
      cursor: null,
      cursorEnabled: params.showCursor !== false,
      clickAnimation: params.clickAnimation !== false,
      cursorTrail: Boolean(params.cursorTrail),
    };

    // Every scene records into its own clip directory.
    let clipDir = framesDir;
    let clipFrames = 0;
    const shoot = async () => {
      clipFrames += 1;
      await page.screenshot({
        path: path.join(clipDir, `frame-${String(clipFrames).padStart(6, "0")}.png`),
        type: "png",
      });
    };

    /** Records ONE scene as a standalone clip and reviews it. */
    async function recordSceneAttempt(sceneInput, i, clip, adjust) {
      const scene = adjust.useHeading
        ? { ...sceneInput, selector: null, selectors: [], target: sceneInput.title || sceneInput.target }
        : adjust.selectorSkip
          ? {
              ...sceneInput,
              selector: null,
              selectors: (sceneInput.selectors || []).slice(adjust.selectorSkip - 1),
            }
          : sceneInput;
      const checkpoints = [];
      let lead = 0;
      let trail = 0;
      let cursorReached = false;
      const navigation = { expected: false, ok: true };
      const expectedRoute = (scene.plan && scene.plan.route) || "";
      const snap = async (label, rect, framing) =>
        checkpoints.push(
          await captureCheckpoint(page, {
            label,
            dir: clipDir,
            rect,
            safeArea: framing && framing.safeArea,
            expectedRoute,
            cursor: state.cursor,
          }),
        );

      await ensureRuntime(page);
      let metrics = await readMetrics(page);

      // --- 1. Locate the exact element for THIS scene (never a fixed position).
      let found = await resolveTarget(page, scene);
      let usedFallback = !found;

      // --- 3. Optional interaction: cursor -> hover -> click -> wait -> recalc.
      if (found && CLICK_ACTIONS.has(scene.action) && found.selector && !adjust.skipInteraction) {
        // Bring the control on screen first, then interact with it.
        const preChrome = await readChrome(page, viewport);
        const preFraming = computeFraming({
          rect: found.rect,
          viewport,
          chrome: preChrome,
          framing: { mode: "focus_element", preferredZoom: 1, minimumPadding: 56 },
          targetType: (scene.plan && scene.plan.targetType) || "button",
          subtitles,
          pageHeight: preChrome.pageHeight,
        });
        lead += await scrollTo(page, shoot, preChrome.scrollY, preFraming.scrollY, SCROLL_SECONDS);
        found = (await remeasure(page, found, scene)) || found;
        metrics = await readMetrics(page);
        const cx = Math.round(found.rect.x + found.rect.width / 2);
        const cy = Math.round(found.rect.y + found.rect.height / 2);
        lead += await moveCursor(page, shoot, state, cx, cy, { seconds: 0.9, hover: 0.3 });
        cursorReached = true;
        lead += await clickRipple(page, shoot, state, 0.4);

        const before = page.url();

        // Safe click rules: real payments, submissions, sign-ups, uploads,
        // logouts, calls and external apps are simulated, never triggered.
        const verdict = await classifyClick(page, found.selector);
        let navResult = { routeChanged: false, simulated: false };
        if (verdict.safe) {
          await page.locator(found.selector).first().hover({ timeout: 3000 }).catch(() => {});
          await page
            .locator(found.selector)
            .first()
            .click({ timeout: 4000, noWaitAfter: true })
            .catch(() => {});
          await waitForReady(page);
          navResult.routeChanged = page.url() !== before;
        } else {
          // Hover + highlight + ripple only.
          await page.locator(found.selector).first().hover({ timeout: 3000 }).catch(() => {});
          await page
            .evaluate((r) => window.__scWalkthrough.showHighlight(r, 8), found.rect)
            .catch(() => {});
          lead += await clickRipple(page, shoot, state, 0.4);
          navResult.simulated = true;
        }
        await page.waitForTimeout(700 + (adjust.extraWaitMs || 0)); // animations / menu open / content load
        lead += await hold(shoot, 0.9);

        // Menus, tabs, accordions, dropdowns and multi-page routes: if the
        // click did not reveal the destination, run smart navigation.
        if ((!navResult.simulated || adjust.openMenuFirst) && scene.expectedDestination) {
          const probe = await resolveTarget(page, {
            ...scene,
            selector: null,
            selectors: [],
            target: String(scene.expectedDestination).replace(/^[#/]/, "").replace(/[-_]/g, " "),
          });
          if ((!probe || adjust.openMenuFirst) && (await needsNavigation(page, scene, probe))) {
            const smart = await performNavigation(page, scene, {
              onSimulatedClick: async () => {
                lead += await clickRipple(page, shoot, state, 0.4);
              },
            });
            navResult.routeChanged = navResult.routeChanged || smart.routeChanged;
          }
        }

        await ensureRuntime(page);
        metrics = await readMetrics(page);

        // Recalculate everything after the layout / route change (lightweight
        // re-mapping of the destination document).
        const navigated = page.url() !== before;
        if (navigated) {
          await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
          metrics = await readMetrics(page);
          state.cursor = null;
        }
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
        found = next || null;
        usedFallback = !found;
        navigation.expected = Boolean(scene.expectedDestination);
        navigation.ok = Boolean(next) || navResult.routeChanged || navResult.simulated;
      }

      // --- 4. Validate the shot BEFORE recording it. Nothing is recorded until
      // the target is really there, really visible and correctly framed.
      const parkedScrollY = (await readMetrics(page)).scrollY;
      updateJob(job.id, { step: `Validating scene ${i + 1} of ${plan.scenes.length}` });
      const shot = await validateAndFixShot(page, {
        scene,
        found: adjust.forceSection ? null : found,
        viewport,
        subtitles,
        index: i,
        total: plan.scenes.length,
      });
      found = shot.found;
      usedFallback = !shot.recordable || found.source === "section" || found.source === "safe_wide";

      // Plan the shot list (a tall section such as pricing gets two shots so
      // every plan, price and CTA is shown in full).
      const chromeNow = await readChrome(page, viewport);
      const plannedFraming = { ...((scene.plan && scene.plan.framing) || {}) };
      if (adjust.zoomOut && plannedFraming.preferredZoom) {
        plannedFraming.preferredZoom = Math.max(1, plannedFraming.preferredZoom * adjust.zoomOut);
      }
      const shotMode = adjust.forceMode || shot.framing.mode;
      const shotList = shot.framing.overflow
        ? splitShots({
            rect: found.rect,
            viewport,
            chrome: chromeNow,
            framing: { ...plannedFraming, mode: shotMode },
            subtitles,
          })
        : [{ rect: found.rect, framing: { ...plannedFraming, mode: shotMode } }];

      // Return to where the camera actually is, then move cinematically.
      await page.evaluate((y) => window.scrollTo(0, y), parkedScrollY);
      let cameraY = parkedScrollY;

      const wantsHighlight =
        !usedFallback && scene.action !== "zoom" && scene.action !== "scroll_to";
      const wantsZoom = scene.action !== "highlight" && scene.action !== "scroll_to";

      const holdStart = timeline;
      const baseTiming = clip.timing;
      const timing = {
        ...baseTiming,
        holdDuration: Math.max(
          1.2,
          baseTiming.holdDuration + (adjust.extraHold || 0) - (adjust.trimHold || 0),
        ),
      };
      const perShot = timing.holdDuration / shotList.length;
      let held = 0;
      let leadCounted = false;

      for (let s = 0; s < shotList.length; s++) {
        const chromeShot = await readChrome(page, viewport);
        const framing = computeFraming({
          rect: shotList[s].rect,
          viewport,
          chrome: chromeShot,
          framing: shotList[s].framing,
          targetType: (scene.plan && scene.plan.targetType) || "section",
          subtitles,
          pageHeight: chromeShot.pageHeight,
        });

        const move = await scrollTo(page, shoot, cameraY, framing.scrollY, s === 0 ? SCROLL_SECONDS : 0.7);
        cameraY = framing.scrollY;
        if (!leadCounted) lead += move;
        else held += move;

        if (wantsHighlight) {
          await page.evaluate((r) => window.__scWalkthrough.showHighlight(r, 8), shotList[s].rect);
        }

        const scale = wantsZoom ? framing.scale : 1;
        const zin = await animateZoom(
          page,
          shoot,
          1,
          scale,
          framing.originX,
          framing.originY,
          ZOOM_IN_SECONDS,
        );
        if (!leadCounted) {
          lead += zin;
          await snap("start", shotList[s].rect, framing);
          // Park the cursor beside — never on top of — the target.
          if (state.cursor && !usedFallback) {
            const parkX = Math.round(shotList[s].rect.x + shotList[s].rect.width + 26);
            const parkY = Math.round(shotList[s].rect.y + shotList[s].rect.height + 22);
            lead += await moveCursor(page, shoot, state, parkX, parkY, { seconds: 0.4, hover: 0 });
          }
          leadCounted = true;
        } else {
          held += zin;
        }

        // Word-to-action sync: hold until just before the cue phrase, bring the
        // cursor to the element, then keep holding until the sentence is done.
        const cursorAt = s === 0 ? Math.max(0, timing.cursorAt) : 0;
        const useCue =
          s === 0 && state.cursor && !usedFallback && timing.cueWord && cursorAt < perShot;
        if (useCue) {
          if (cursorAt > 0.05) held += await hold(shoot, cursorAt);
          const cueX = Math.round(shotList[s].rect.x + shotList[s].rect.width / 2);
          const cueY = Math.round(shotList[s].rect.y + shotList[s].rect.height + 18);
          held += await moveCursor(page, shoot, state, cueX, cueY, { seconds: 0.45, hover: 0.15 });
          cursorReached = true;
          await snap("middle", shotList[s].rect, framing);
          held += await hold(shoot, Math.max(0.6, perShot - held));
        } else {
          // The camera never leaves before the narration for this scene ends.
          held += await hold(shoot, Math.max(1.2, perShot) / 2);
          await snap("middle", shotList[s].rect, framing);
          held += await hold(shoot, Math.max(1.2, perShot) / 2);
        }

        // Move the cursor out of the lower third before subtitles cover it.
        if (subtitles) held += await parkCursor(page, shoot, state, viewport);

        if (s < shotList.length - 1) {
          held += await animateZoom(page, shoot, scale, 1, framing.originX, framing.originY, 0.35);
          await page.evaluate(() => window.__scWalkthrough.setZoom(1, 0, 0));
        } else {
          await snap("end", shotList[s].rect, framing);
          trail += await animateZoom(
            page,
            shoot,
            scale,
            1,
            framing.originX,
            framing.originY,
            ZOOM_OUT_SECONDS,
          );
        }
      }

      // --- 6. Reset the camera before the next element.
      await page.evaluate(() => {
        window.__scWalkthrough.setZoom(1, 0, 0);
        window.__scWalkthrough.hideHighlight();
      });
      // Natural scene timing: 0.5-1s lead-in, hold through the narration,
      // then a short 0.3-0.8s transition out.
      if (lead < timing.leadIn) lead += await hold(shoot, timing.leadIn - lead);
      if (held < timing.holdDuration) held += await hold(shoot, timing.holdDuration - held);
      trail += await hold(shoot, Math.max(TAIL_SECONDS, timing.transitionOut - trail));

      // --- 7. Automated review of this clip.
      const review = reviewScene({
        checkpoints,
        found,
        timing,
        actual: { total: lead + held + trail, lead, hold: held, trail },
        navigation,
        cursorReached: CLICK_ACTIONS.has(scene.action) ? cursorReached : undefined,
        wideFallback: Boolean(adjust.wideFallback),
      });

      return {
        lead,
        hold: held,
        trail,
        timing,
        holdStart,
        frames: clipFrames,
        dir: clipDir,
        validationScore: shot.score,
        review,
      };
    }

    /** Restores the expected route and page state before a scene attempt. */
    async function restoreState(url) {
      await page
        .evaluate(() => {
          window.__scWalkthrough.setZoom(1, 0, 0);
          window.__scWalkthrough.hideHighlight();
        })
        .catch(() => {});
      if (page.url() !== url) {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
        await waitForReady(page).catch(() => {});
      }
      await ensureRuntime(page);
      await dismissPopups(page).catch(() => {});
      await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
      state.cursor = null;
    }

    let frameIndex = 0;

    for (let i = 0; i < plan.scenes.length; i++) {
      const scene = plan.scenes[i];
      const clip = audioClips[i];
      ensureLive();
      // Before/After scenes carry their own URL.
      if (scene.url && page.url() !== scene.url) await restoreState(scene.url);
      const sceneUrl = page.url();
      updateJob(job.id, { currentScene: i + 1, totalScenes: plan.scenes.length });

      let adjust = { attempt: 0 };
      let accepted = null;
      const attempts = [];

      for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
        clipDir = path.join(scenesDir, `scene-${i}-take-${attempt}`);
        await fs.promises.rm(clipDir, { recursive: true, force: true }).catch(() => {});
        await fs.promises.mkdir(clipDir, { recursive: true });
        clipFrames = 0;

        updateJob(job.id, {
          step:
            attempt === 1
              ? `Recording scene ${i + 1} of ${plan.scenes.length}`
              : `Re-recording scene ${i + 1} (${adjust.fix || "retry"}, take ${attempt})`,
          progress: 46 + Math.round((i / plan.scenes.length) * 34),
        });

        let take;
        try {
          take = await recordSceneAttempt(scene, i, clip, adjust);
        } catch (err) {
          take = {
            lead: 0,
            hold: 0,
            trail: 0,
            timing: clip.timing,
            holdStart: timeline,
            frames: clipFrames,
            dir: clipDir,
            review: { score: 0, issues: ["record_error"], reason: String(err.message || err), approved: false },
          };
        }

        attempts.push({ attempt, score: take.review.score, issues: take.review.issues, fix: adjust.fix || null });

        // Keep the best take so far so a difficult scene still ships something.
        if (!accepted || take.review.score > accepted.review.score) accepted = take;

        if (take.review.approved || take.frames === 0) {
          accepted = take.frames === 0 && accepted ? accepted : take;
          break;
        }
        if (attempt === MAX_RETRIES + 1 || adjust.wideFallback) break;

        // Only this scene is regenerated, with one targeted fix.
        adjust =
          attempt === MAX_RETRIES ? safeFallbackAdjust(adjust) : planRetry(take.review, adjust);
        await restoreState(sceneUrl);
      }

      // Append the accepted clip's frames to the master sequence.
      const files = (await fs.promises.readdir(accepted.dir))
        .filter((f) => f.startsWith("frame-") && f.endsWith(".png"))
        .sort();
      for (const f of files) {
        frameIndex += 1;
        await fs.promises.rename(
          path.join(accepted.dir, f),
          path.join(framesDir, `frame-${String(frameIndex).padStart(6, "0")}.png`),
        );
      }
      // Drop every take directory for this scene (frames of the accepted take
      // have already been moved into the master sequence).
      for (const t of attempts) {
        await fs.promises
          .rm(path.join(scenesDir, `scene-${i}-take-${t.attempt}`), { recursive: true, force: true })
          .catch(() => {});
      }

      const { lead, hold: held, trail, timing, holdStart } = accepted;
      timeline = holdStart + lead + held + trail;
      const stamps = sceneTimestamps({ timelineStart: holdStart, timing, lead, hold: held, trail });
      srtParts.push({
        start: stamps.speechStartSec,
        end: stamps.speechEndSec,
        text: stripEmotionTags(scene.speech),
      });
      sceneTimings.push({ lead, hold: held, trail, cueWord: timing.cueWord, ...stamps });
      sceneReports.push({
        index: i,
        title: scene.title || scene.target || `Scene ${i + 1}`,
        score: accepted.review.score,
        approved: accepted.review.score >= APPROVE_SCORE,
        issues: accepted.review.issues,
        takes: attempts,
        frames: files.length,
      });

      updateJob(job.id, {
        progress: 46 + Math.round(((i + 1) / plan.scenes.length) * 34),
        step: `Scene ${i + 1} of ${plan.scenes.length} approved (${accepted.review.score}/100)`,
        sceneTimings,
        sceneReports,
        retryCounts: sceneReports.map((r) => r.takes.length),
      });
    }

    await context.close();

    ensureLive();
    updateJob(job.id, { status: "reviewing", step: "Reviewing scenes", progress: 82 });
    updateJob(job.id, { status: "rendering", step: "Rendering final video", progress: 84 });

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

    // Background music sits under the narration and ducks while Sarah speaks.
    let finalAudioPath = trackPath;
    if (musicStyle) {
      updateJob(job.id, { status: "mixing", step: "Mixing background music", progress: 88 });
      try {
        const bedPath = path.join(audioDir, "music.m4a");
        await buildMusicBed(musicStyle, Math.max(4, timeline + 1), bedPath);
        const mixedPath = path.join(audioDir, "mixed.m4a");
        await mixNarrationWithMusic(trackPath, bedPath, mixedPath);
        finalAudioPath = mixedPath;
      } catch (err) {
        console.error(`[job ${job.id}] music mix failed, using narration only:`, err.message);
      }
    }

    const videoFilters = ["scale=trunc(iw/2)*2:trunc(ih/2)*2"];
    if (subtitleMode && subtitleMode !== "off") {
      const captionFilter = await buildSubtitleFilter(srtParts, {
        mode: subtitleMode,
        jobRoot,
        width: viewport.width,
        height: viewport.height,
        device,
      });
      if (captionFilter) videoFilters.push(captionFilter);
    }

    await run("ffmpeg", [
      "-y",
      "-framerate", String(FPS),
      "-i", path.join(framesDir, "frame-%06d.png"),
      "-i", finalAudioPath,
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

    updateJob(job.id, { status: "quality_check", step: "Final quality check", progress: 97 });
    await fs.promises.rm(framesDir, { recursive: true, force: true }).catch(() => {});
    await fs.promises.rm(path.join(jobRoot, "scenes"), { recursive: true, force: true }).catch(() => {});

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
    // Temporary frames/scene takes are always cleaned up, success or failure.
    await fs.promises.rm(framesDir, { recursive: true, force: true }).catch(() => {});
    await fs.promises.rm(path.join(jobRoot, "scenes"), { recursive: true, force: true }).catch(() => {});
    if (isCancelled(job.id)) {
      await fs.promises.rm(jobRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}

module.exports = { generatePresentation, MIN_OUTPUT_BYTES };
