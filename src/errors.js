// User-facing error mapping. Technical details stay in the backend logs only.

class UserFacingError extends Error {
  constructor(code, message, technical) {
    super(message);
    this.name = "UserFacingError";
    this.code = code;
    this.technical = technical || message;
  }
}

const MESSAGES = {
  invalid_url: "That website address is not valid. Use a full public URL such as https://example.com.",
  private_url: "That address points to a private or internal network, so it cannot be captured.",
  timeout: "The website took too long to respond. Please try again or use a lighter page.",
  blocked: "This website blocks automated browsers, so we could not record it.",
  login_required: "This page requires a login. Please provide a publicly accessible URL.",
  missing_target: "We could not find the section to highlight, so a wide view was used instead.",
  openai_failed: "The AI script service is temporarily unavailable. Please try again in a moment.",
  fish_failed: "The voice service is temporarily unavailable. Please try again in a moment.",
  ffmpeg_failed: "We could not finish rendering the video. Please try again.",
  worker_crash: "The rendering worker stopped unexpectedly. Please start a new job.",
  cancelled: "This job was cancelled.",
  busy: "All rendering workers are busy right now. Please try again shortly.",
  unknown: "Something went wrong while building your video. Please try again.",
};

function classify(err) {
  if (err instanceof UserFacingError) return err.code;
  const raw = String((err && err.message) || err || "").toLowerCase();
  if (raw.includes("cancel")) return "cancelled";
  if (raw.includes("timeout") || raw.includes("timed out")) return "timeout";
  if (raw.includes("err_") || raw.includes("net::") || raw.includes("navigation")) return "blocked";
  if (raw.includes("403") || raw.includes("captcha") || raw.includes("cloudflare")) return "blocked";
  if (raw.includes("401") || raw.includes("sign in") || raw.includes("login")) return "login_required";
  if (raw.includes("private") || raw.includes("loopback") || raw.includes("internal network"))
    return "private_url";
  if (raw.includes("openai")) return "openai_failed";
  if (raw.includes("fish")) return "fish_failed";
  if (raw.includes("ffmpeg")) return "ffmpeg_failed";
  if (raw.includes("invalid url") || raw.includes("url")) return "invalid_url";
  return "unknown";
}

// Returns { code, message } for the client; logs the technical detail server-side.
function friendlyError(err, context = "job") {
  const code = classify(err);
  const technical = err && err.stack ? err.stack : String(err);
  console.error(`[${context}] ${code}: ${technical}`);
  return { code, message: MESSAGES[code] || MESSAGES.unknown };
}

module.exports = { UserFacingError, friendlyError, MESSAGES };