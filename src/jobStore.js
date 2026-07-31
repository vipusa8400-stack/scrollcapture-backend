// Optional persistent snapshots so jobs survive a backend restart.
// Enabled when PERSIST_DIR points at a writable (ideally mounted) directory.
const fs = require("fs");
const path = require("path");

const PERSIST_DIR = process.env.PERSIST_DIR || "";
const enabled = Boolean(PERSIST_DIR);

const PERSISTED_FIELDS = [
  "id",
  "kind",
  "params",
  "status",
  "progress",
  "step",
  "error",
  "errorCode",
  "filePath",
  "fileSize",
  "format",
  "durationSeconds",
  "sceneCount",
  "script",
  "scenes",
  "websiteMap",
  "preparation",
  "strategy",
  "scenePlan",
  "sceneTimings",
  "sceneReports",
  "retryCounts",
  "voiceFiles",
  "validation",
  "currentScene",
  "totalScenes",
  "sectionCount",
  "createdAt",
  "updatedAt",
  "startedAt",
  "completedAt",
];

function ensureDir() {
  if (!enabled) return false;
  try {
    fs.mkdirSync(PERSIST_DIR, { recursive: true });
    return true;
  } catch (err) {
    console.error("[jobStore] cannot create PERSIST_DIR", err.message);
    return false;
  }
}

const ready = ensureDir();

function fileFor(id) {
  return path.join(PERSIST_DIR, `${id}.json`);
}

function snapshot(job) {
  if (!ready || !job) return;
  const data = {};
  for (const field of PERSISTED_FIELDS) {
    if (job[field] !== undefined) data[field] = job[field];
  }
  fs.promises.writeFile(fileFor(job.id), JSON.stringify(data), "utf8").catch(() => {});
}

function remove(id) {
  if (!ready) return;
  fs.promises.unlink(fileFor(id)).catch(() => {});
}

// Called at boot: returns persisted jobs so in-flight work can be reported
// as recoverable instead of silently disappearing.
function loadAll() {
  if (!ready) return [];
  let names = [];
  try {
    names = fs.readdirSync(PERSIST_DIR).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const jobs = [];
  for (const name of names) {
    try {
      const job = JSON.parse(fs.readFileSync(path.join(PERSIST_DIR, name), "utf8"));
      if (job && job.id) jobs.push(job);
    } catch {
      /* skip corrupt snapshot */
    }
  }
  return jobs;
}

module.exports = { enabled: ready, snapshot, remove, loadAll, PERSIST_DIR };