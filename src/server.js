const express = require("express");
const cors = require("cors");
const fs = require("fs");

const { validateAndNormalizeUrl } = require("./urlSecurity");
const { createJob, getJob, publicJob, setWorker } = require("./jobs");
const { generateVideo } = require("./videoGenerator");
const { generateScreenshot } = require("./screenshotGenerator");
const { generatePdf } = require("./pdfGenerator");

const ALLOWED_DEVICES = new Set(["desktop", "mobile"]);
const ALLOWED_RATIOS = new Set(["vertical", "square", "horizontal"]);
const ALLOWED_SPEEDS = new Set(["slow", "normal", "fast"]);
const ALLOWED_FORMATS = new Set(["mp4", "webm", "gif"]);
const ALLOWED_DURATIONS = new Set([10, 15, 30, 45, 60]);

const MIME = {
  mp4: "video/mp4",
  webm: "video/webm",
  gif: "image/gif",
  png: "image/png",
  jpg: "image/jpeg",
  pdf: "application/pdf",
};

const RATIO_ALIASES = {
  "9:16": "vertical",
  "1:1": "square",
  "16:9": "horizontal",
  vertical: "vertical",
  square: "square",
  horizontal: "horizontal",
};

const ALLOWED_IMAGE_FORMATS = new Set(["png", "jpg"]);
const ALLOWED_QUALITIES = new Set([70, 85, 95]);
const ALLOWED_DELAYS = new Set([1000, 3000, 5000]);
const ALLOWED_PAPER_SIZES = new Set(["a4", "letter", "legal"]);
const ALLOWED_ORIENTATIONS = new Set(["portrait", "landscape"]);
const ALLOWED_MARGINS = new Set(["none", "small", "normal", "large"]);

function bad(res, code, message) {
  return res.status(code).json({ error: "invalid_request", message });
}

async function main() {
  const app = express();
  const allowedOrigin = process.env.ALLOWED_ORIGIN;
  app.use(
    cors({
      origin: allowedOrigin ? allowedOrigin.split(",").map((s) => s.trim()) : true,
    }),
  );
  app.use(express.json({ limit: "64kb" }));

  setWorker((job) => {
    if (job.kind === "screenshot") return generateScreenshot(job);
    if (job.kind === "pdf") return generatePdf(job);
    return generateVideo(job);
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, uptime: process.uptime() });
  });

  app.post("/api/jobs", async (req, res) => {
    try {
      const body = req.body || {};
      const rawRatio = String(body.aspectRatio || "");
      const aspectRatio = RATIO_ALIASES[rawRatio];
      const device = String(body.device || "");
      const scrollSpeed = String(body.scrollSpeed || "");
      const format = String(body.format || "");
      const duration = Number(body.duration);

      if (!ALLOWED_DEVICES.has(device)) return bad(res, 400, "Invalid device.");
      if (!aspectRatio || !ALLOWED_RATIOS.has(aspectRatio))
        return bad(res, 400, "Invalid aspectRatio.");
      if (!ALLOWED_SPEEDS.has(scrollSpeed)) return bad(res, 400, "Invalid scrollSpeed.");
      if (!ALLOWED_FORMATS.has(format)) return bad(res, 400, "Invalid format.");
      if (!ALLOWED_DURATIONS.has(duration)) return bad(res, 400, "Invalid duration.");

      let websiteUrl;
      try {
        websiteUrl = await validateAndNormalizeUrl(body.websiteUrl);
      } catch (err) {
        return bad(res, 400, err.message);
      }

      const job = createJob({
        websiteUrl,
        device,
        aspectRatio,
        scrollSpeed,
        duration,
        format,
      });
      res.status(202).json(publicJob(job));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "server_error", message: err.message });
    }
  });

  app.get("/api/jobs/:jobId", (req, res) => {
    const job = getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: "not_found" });
    res.json(publicJob(job));
  });

  app.post("/api/screenshots", async (req, res) => {
    try {
      const body = req.body || {};
      const device = String(body.device || "");
      const format = String(body.format || "png").toLowerCase();
      const quality = body.quality === undefined ? 85 : Number(body.quality);
      const delay = body.delay === undefined ? 3000 : Number(body.delay);

      if (!ALLOWED_DEVICES.has(device)) return bad(res, 400, "Invalid device.");
      if (!ALLOWED_IMAGE_FORMATS.has(format)) return bad(res, 400, "Invalid format.");
      if (format === "jpg" && !ALLOWED_QUALITIES.has(quality))
        return bad(res, 400, "Invalid quality.");
      if (!ALLOWED_DELAYS.has(delay)) return bad(res, 400, "Invalid delay.");

      let websiteUrl;
      try {
        websiteUrl = await validateAndNormalizeUrl(body.websiteUrl);
      } catch (err) {
        return bad(res, 400, err.message);
      }

      const job = createJob(
        {
          websiteUrl,
          device,
          format,
          quality,
          delay,
          hideCookiePopups: Boolean(body.hideCookiePopups),
          hideFixedHeaders: Boolean(body.hideFixedHeaders),
          transparentBackground: Boolean(body.transparentBackground),
        },
        "screenshot",
      );
      res.status(202).json(publicJob(job));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "server_error", message: err.message });
    }
  });

  app.get("/api/screenshots/:jobId", (req, res) => {
    const job = getJob(req.params.jobId);
    if (!job || job.kind !== "screenshot") return res.status(404).json({ error: "not_found" });
    res.json(publicJob(job));
  });

  app.post("/api/pdf", async (req, res) => {
    try {
      const body = req.body || {};
      const device = String(body.device || "");
      const paperSize = String(body.paperSize || "a4").toLowerCase();
      const orientation = String(body.orientation || "portrait").toLowerCase();
      const margin = String(body.margin || "normal").toLowerCase();

      if (!ALLOWED_DEVICES.has(device)) return bad(res, 400, "Invalid device.");
      if (!ALLOWED_PAPER_SIZES.has(paperSize)) return bad(res, 400, "Invalid paperSize.");
      if (!ALLOWED_ORIENTATIONS.has(orientation)) return bad(res, 400, "Invalid orientation.");
      if (!ALLOWED_MARGINS.has(margin)) return bad(res, 400, "Invalid margin.");

      let websiteUrl;
      try {
        websiteUrl = await validateAndNormalizeUrl(body.websiteUrl);
      } catch (err) {
        return bad(res, 400, err.message);
      }

      const job = createJob(
        {
          websiteUrl,
          device,
          paperSize,
          orientation,
          margin,
          printBackground: body.printBackground !== false,
          format: "pdf",
        },
        "pdf",
      );
      res.status(202).json(publicJob(job));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "server_error", message: err.message });
    }
  });

  app.get("/api/pdf/:jobId", (req, res) => {
    const job = getJob(req.params.jobId);
    if (!job || job.kind !== "pdf") return res.status(404).json({ error: "not_found" });
    res.json(publicJob(job));
  });

  app.get("/api/pdf/:jobId/download", (req, res) => {
    const job = getJob(req.params.jobId);
    if (!job || job.kind !== "pdf") return res.status(404).send("Not found");
    if (job.status !== "completed" || !job.filePath) {
      return res.status(409).send("Job not completed");
    }
    if (!fs.existsSync(job.filePath)) {
      return res.status(410).send("File expired");
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="scrollcapture-${job.id}.pdf"`,
    );
    res.setHeader("Content-Length", String(job.fileSize));
    fs.createReadStream(job.filePath).pipe(res);
  });

  app.get("/api/screenshots/:jobId/download", (req, res) => {
    const job = getJob(req.params.jobId);
    if (!job || job.kind !== "screenshot") return res.status(404).send("Not found");
    if (job.status !== "completed" || !job.filePath) {
      return res.status(409).send("Job not completed");
    }
    if (!fs.existsSync(job.filePath)) {
      return res.status(410).send("File expired");
    }
    const filename = `scrollcapture-${job.id}.${job.format}`;
    res.setHeader("Content-Type", MIME[job.format] || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", String(job.fileSize));
    fs.createReadStream(job.filePath).pipe(res);
  });

  app.get("/api/jobs/:jobId/download", (req, res) => {
    const job = getJob(req.params.jobId);
    if (!job) return res.status(404).send("Not found");
    if (job.status !== "completed" || !job.filePath) {
      return res.status(409).send("Job not completed");
    }
    if (!fs.existsSync(job.filePath)) {
      return res.status(410).send("File expired");
    }
    const filename = `scrollcapture-${job.id}.${job.format}`;
    res.setHeader("Content-Type", MIME[job.format] || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", String(job.fileSize));
    fs.createReadStream(job.filePath).pipe(res);
  });

  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: "server_error", message: err.message });
  });

  const port = Number(process.env.PORT) || 8080;
  app.listen(port, "0.0.0.0", () => {
    console.log(`scrollcapture-backend listening on 0.0.0.0:${port}`);
  });
}

main().catch((err) => {
  console.error("fatal", err);
  process.exit(1);
});