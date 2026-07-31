// Subtitle rendering: off | clean | highlight.
// Captions are limited to two lines and kept inside a safe area so they never
// cover CTA buttons or pricing cards at the bottom of the frame.
const fs = require("fs");
const path = require("path");

const SUBTITLE_MODES = ["off", "clean", "highlight"];

function wrapTwoLines(text, maxChars) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    if (!current.length) current = word;
    else if (current.length + word.length + 1 <= maxChars) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  if (lines.length <= 2) return lines;
  // Keep two lines: fold the remainder into the second line and trim.
  const head = lines[0];
  const tail = lines.slice(1).join(" ");
  return [head, tail.length > maxChars ? `${tail.slice(0, maxChars - 1)}…` : tail];
}

// Splits a cue into phrase chunks so highlight mode can emphasise one phrase.
function phrases(text, chunkWords = 5) {
  const words = text.split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = 0; i < words.length; i += chunkWords) {
    out.push(words.slice(i, i + chunkWords).join(" "));
  }
  return out.length ? out : [text];
}

function assTime(seconds) {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toFixed(2).padStart(5, "0");
  return `${h}:${String(m).padStart(2, "0")}:${sec}`;
}

function escapeAss(text) {
  return text.replace(/\{/g, "(").replace(/\}/g, ")").replace(/\n/g, " ");
}

function header(width, height, device) {
  // Mobile safe area: keep captions above the bottom gesture bar and away from CTAs.
  const marginV = device === "mobile" ? Math.round(height * 0.14) : Math.round(height * 0.09);
  const marginH = Math.round(width * 0.08);
  const fontSize = Math.max(18, Math.round(height / (device === "mobile" ? 32 : 28)));
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,DejaVu Sans,${fontSize},&H00FFFFFF,&H000BB7FF,&H99000000,&H64000000,0,0,0,0,100,100,0,0,3,2,0,2,${marginH},${marginH},${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
}

/**
 * @param parts [{ start, end, text }] narration timestamps
 * @returns ffmpeg video filter string, or null when subtitles are off
 */
async function buildSubtitleFilter(parts, { mode, jobRoot, width, height, device }) {
  if (!mode || mode === "off" || !parts || !parts.length) return null;
  const maxChars = Math.round((device === "mobile" ? 26 : 42) * 1.0);
  const lines = [];

  for (const part of parts) {
    const clean = escapeAss(String(part.text || "").trim());
    if (!clean) continue;
    const total = Math.max(0.6, part.end - part.start);

    if (mode === "clean") {
      const text = wrapTwoLines(clean, maxChars).join("\\N");
      lines.push(
        `Dialogue: 0,${assTime(part.start)},${assTime(part.end)},Caption,,0,0,0,,${text}`,
      );
      continue;
    }

    // highlight: same two-line block, current phrase emphasised in accent colour
    const chunks = phrases(clean);
    const per = total / chunks.length;
    chunks.forEach((chunk, i) => {
      const rendered = chunks
        .map((c, j) => (j === i ? `{\\c&H0BB7FF&\\b1}${c}{\\c&HFFFFFF&\\b0}` : c))
        .join(" ");
      const wrapped = wrapTwoLines(rendered.replace(/\s+/g, " "), maxChars + 24).join("\\N");
      lines.push(
        `Dialogue: 0,${assTime(part.start + i * per)},${assTime(
          part.start + (i + 1) * per,
        )},Caption,,0,0,0,,${wrapped}`,
      );
    });
  }

  if (!lines.length) return null;
  const assPath = path.join(jobRoot, "captions.ass");
  await fs.promises.writeFile(assPath, header(width, height, device) + lines.join("\n") + "\n", "utf8");
  return `ass='${assPath.replace(/'/g, "\\'")}'`;
}

module.exports = { SUBTITLE_MODES, buildSubtitleFilter, wrapTwoLines };