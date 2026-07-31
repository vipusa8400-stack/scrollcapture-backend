const { randomUUID } = require("crypto");
const fs = require("fs");
const path = require("path");

const JOB_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

const VALID_STATUSES = new Set([
  "queued",
  "validating",
  "opening_page",
  "loading_content",
  "scrolling",
  "preparing_capture",
  "capturing",
  "preparing_print",
  "generating_pdf",
  "finalizing",
  "rendering",
  "analyzing",
  "preparing",
  "mapping",
  "strategizing",
  "planning",
  "scripting",
  "voicing",
  "locating",
  "recording",
  "reviewing",
  "fixing",
  "timing",
  "validating_scenes",
  "mixing",
  "quality_check",
  "cancelled",
  "interrupted",
  "completed",
  "failed",
]);

const jobs = new Map();
const { lightMap } = require("./websiteMap");
const jobStore = require("./jobStore");
const queue = [];
const MAX_CONCURRENT = Math.max(1, Number(process.env.MAX_CONCURRENT_JOBS || 1));
let running = 0;
let worker = null;

function createJob(params, kind = "video") {
  const id = randomUUID();
  const job = {
    id,
    kind,
    params,
    status: "queued",
    progress: 0,
    step: "queued",
    error: null,
    filePath: null,
    fileSize: 0,
    format: params.format,
    pageCount: null,
    width: null,
    height: null,
    durationSeconds: null,
    sceneCount: null,
    script: null,
    scenes: null,
    websiteMap: null,
    preparation: null,
    strategy: null,
    scenePlan: null,
    sectionCount: null,
    sceneTimings: null,
    sceneReports: null,
    retryCounts: null,
    currentScene: null,
    totalScenes: null,
    errorCode: null,
    cancelRequested: false,
    recovered: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    startedAt: null,
    completedAt: null,
  };
  jobs.set(id, job);
  jobStore.snapshot(job);
  queue.push(id);
  scheduleNext();
  return job;
}

function getJob(id) {
  return jobs.get(id) || null;
}

function cancelJob(id) {
  const job = jobs.get(id);
  if (!job) return null;
  if (job.status === "completed" || job.status === "failed" || job.status === "cancelled")
    return job;
  job.cancelRequested = true;
  const queuedAt = queue.indexOf(id);
  if (queuedAt >= 0) {
    queue.splice(queuedAt, 1);
    updateJob(id, { status: "cancelled", step: "Cancelled", error: "This job was cancelled." });
  } else {
    updateJob(id, { step: "Cancelling…" });
  }
  return jobs.get(id);
}

function isCancelled(id) {
  const job = jobs.get(id);
  return Boolean(job && job.cancelRequested);
}

function publicJob(job) {
  if (!job) return null;
  const now = Date.now();
  let estimatedSecondsRemaining = null;
  if (job.status !== "completed" && job.status !== "failed" && job.startedAt && job.progress > 2) {
    const elapsed = (now - job.startedAt) / 1000;
    const total = elapsed / (job.progress / 100);
    estimatedSecondsRemaining = Math.max(1, Math.round(total - elapsed));
  }
  const base =
    job.kind === "screenshot"
      ? "screenshots"
      : job.kind === "pdf"
        ? "pdf"
        : job.kind === "presentation"
          ? "presentations"
          : "jobs";
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    step: job.step,
    progress: job.progress,
    error: job.error,
    errorCode: job.errorCode || null,
    cancelRequested: Boolean(job.cancelRequested),
    recovered: Boolean(job.recovered),
    format: job.format,
    fileSize: job.fileSize,
    pageCount: job.pageCount,
    width: job.width,
    height: job.height,
    durationSeconds: job.durationSeconds,
    sceneCount: job.sceneCount,
    script: job.script,
    scenes: job.scenes,
    websiteMap: lightMap(job.websiteMap),
    preparation: job.preparation,
    strategy: job.strategy,
    scenePlan: job.scenePlan,
    sceneTimings: job.sceneTimings,
    sceneReports: job.sceneReports,
    retryCounts: job.retryCounts,
    currentScene: job.currentScene,
    totalScenes: job.totalScenes,
    sectionCount: job.sectionCount,
    estimatedSecondsRemaining,
    downloadUrl: job.status === "completed" ? `/api/${base}/${job.id}/download` : null,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
  };
}

function updateJob(id, patch) {
  const job = jobs.get(id);
  if (!job) return;
  if (patch.status && !VALID_STATUSES.has(patch.status)) {
    throw new Error(`invalid status ${patch.status}`);
  }
  Object.assign(job, patch, { updatedAt: Date.now() });
  jobStore.snapshot(job);
}

function setWorker(fn) {
  worker = fn;
}

function scheduleNext() {
  if (running >= MAX_CONCURRENT) return;
  if (!worker) return;
  const next = queue.shift();
  if (!next) return;
  const job = jobs.get(next);
  if (!job) return scheduleNext();
  if (job.cancelRequested) return scheduleNext();

  running += 1;
  job.startedAt = Date.now();
  Promise.resolve()
    .then(() => worker(job))
    .catch((err) => {
      const { friendlyError } = require("./errors");
      const { code, message } = friendlyError(err, `job ${job.id}`);
      updateJob(job.id, {
        status: job.cancelRequested ? "cancelled" : "failed",
        step: job.cancelRequested ? "Cancelled" : "Failed",
        errorCode: code,
        error: job.cancelRequested ? "This job was cancelled." : message,
      });
    })
    .finally(() => {
      running = Math.max(0, running - 1);
      job.completedAt = Date.now();
      scheduleNext();
    });
  scheduleNext();
}

function cleanupExpired() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    const age = now - job.createdAt;
    if (age > JOB_EXPIRY_MS) {
      if (job.filePath) {
        fs.promises.unlink(job.filePath).catch(() => {});
        const dir = path.dirname(job.filePath);
        fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
      jobStore.remove(id);
      jobs.delete(id);
    }
  }
}

setInterval(cleanupExpired, CLEANUP_INTERVAL_MS).unref?.();

// --- Job recovery -----------------------------------------------------------
// Snapshots let a restarted backend report what happened to in-flight jobs
// (and keep completed downloads alive when PERSIST_DIR is a mounted volume).
function recoverJobs() {
  if (!jobStore.enabled) return 0;
  let restored = 0;
  for (const saved of jobStore.loadAll()) {
    if (jobs.has(saved.id)) continue;
    const job = { ...saved, recovered: true, cancelRequested: false };
    const terminal = job.status === "completed" || job.status === "failed" || job.status === "cancelled";
    if (!terminal) {
      job.status = "interrupted";
      job.step = "Interrupted by a backend restart";
      job.error = "The rendering worker restarted. Your plan was saved — start the render again.";
      job.errorCode = "worker_crash";
    }
    if (job.status === "completed" && job.filePath && !fs.existsSync(job.filePath)) {
      job.status = "interrupted";
      job.error = "The rendered file was removed when the worker restarted.";
    }
    jobs.set(job.id, job);
    restored += 1;
  }
  if (restored) console.info(`[jobs] recovered ${restored} persisted job(s)`);
  return restored;
}

module.exports = {
  createJob,
  getJob,
  updateJob,
  publicJob,
  setWorker,
  cancelJob,
  isCancelled,
  recoverJobs,
};