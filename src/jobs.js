const { randomUUID } = require("crypto");
const fs = require("fs");
const path = require("path");

const JOB_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

const VALID_STATUSES = new Set([
  "queued",
  "opening_page",
  "loading_content",
  "scrolling",
  "rendering",
  "completed",
  "failed",
]);

const jobs = new Map();
const queue = [];
let processing = false;
let worker = null;

function createJob(params) {
  const id = randomUUID();
  const job = {
    id,
    params,
    status: "queued",
    progress: 0,
    step: "queued",
    error: null,
    filePath: null,
    fileSize: 0,
    format: params.format,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    startedAt: null,
    completedAt: null,
  };
  jobs.set(id, job);
  queue.push(id);
  scheduleNext();
  return job;
}

function getJob(id) {
  return jobs.get(id) || null;
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
  return {
    id: job.id,
    status: job.status,
    step: job.step,
    progress: job.progress,
    error: job.error,
    format: job.format,
    fileSize: job.fileSize,
    estimatedSecondsRemaining,
    downloadUrl: job.status === "completed" ? `/api/jobs/${job.id}/download` : null,
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
}

function setWorker(fn) {
  worker = fn;
}

function scheduleNext() {
  if (processing) return;
  if (!worker) return;
  const next = queue.shift();
  if (!next) return;
  const job = jobs.get(next);
  if (!job) return scheduleNext();

  processing = true;
  job.startedAt = Date.now();
  Promise.resolve()
    .then(() => worker(job))
    .catch((err) => {
      console.error(`[job ${job.id}] failed`, err);
      updateJob(job.id, {
        status: "failed",
        error: err && err.message ? err.message : String(err),
      });
    })
    .finally(() => {
      processing = false;
      job.completedAt = Date.now();
      scheduleNext();
    });
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
      jobs.delete(id);
    }
  }
}

setInterval(cleanupExpired, CLEANUP_INTERVAL_MS).unref?.();

module.exports = {
  createJob,
  getJob,
  updateJob,
  publicJob,
  setWorker,
};