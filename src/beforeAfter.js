// Before/After mode.
// The current website is shown briefly and factually — never criticised — and
// the narration only mentions improvements the user actually described.

const INTRO = {
  en: (host) =>
    `[calm] Here is the current version of ${host}. [pause:0.6s] Let's look at what has been updated.`,
  ms: (host) =>
    `[calm] Ini versi laman web ${host} yang sedia ada. [pause:0.6s] Mari kita lihat apa yang telah dikemas kini.`,
};

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "your website";
  }
}

// A single opening scene recorded on the existing website.
function buildBeforeScene({ existingUrl, language }) {
  const host = hostOf(existingUrl);
  const speech = (INTRO[language] || INTRO.en)(host);
  return {
    title: "Current website",
    speech,
    target: "hero",
    action: "scroll_to",
    framing: "wide",
    url: existingUrl,
    beforeAfter: "before",
    cue: null,
  };
}

module.exports = { buildBeforeScene, hostOf };