/**
 * Safe click rules. Real payments, checkouts, form submissions, calls,
 * WhatsApp messages, sign-ups, uploads, logouts, destructive actions and
 * external apps are NEVER triggered — they are simulated visually instead.
 */

const UNSAFE_TEXT =
  /(pay|payment|checkout|buy now|purchase|order now|subscribe|donate|submit|send message|send enquiry|send inquiry|contact us now|call now|whats\s?app|sign\s?up|register|create account|log\s?out|sign\s?out|delete|remove|cancel account|upload|book now|reserve|apply now|add to cart)/i;

const UNSAFE_HREF = /^(tel:|mailto:|sms:|whatsapp:|https?:\/\/(wa\.me|api\.whatsapp|m\.me|t\.me|calendly|paypal|stripe|checkout))/i;

/** Decides whether a real click is allowed on the resolved element. */
async function classifyClick(page, selector) {
  if (!selector) return { safe: false, reason: "no_selector" };
  const info = await page
    .locator(selector)
    .first()
    .evaluate((el) => {
      const form = el.closest("form");
      return {
        tag: el.tagName.toLowerCase(),
        type: (el.getAttribute("type") || "").toLowerCase(),
        href: el.getAttribute("href") || "",
        target: el.getAttribute("target") || "",
        text: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 120),
        inForm: Boolean(form),
        isSubmit:
          el.tagName.toLowerCase() === "button"
            ? (el.getAttribute("type") || "submit").toLowerCase() === "submit" && Boolean(form)
            : el.tagName.toLowerCase() === "input" &&
              ["submit", "file", "image"].includes((el.getAttribute("type") || "").toLowerCase()),
        externalHost: (() => {
          const href = el.getAttribute("href") || "";
          if (!/^https?:/i.test(href)) return false;
          try {
            return new URL(href).host !== location.host;
          } catch {
            return false;
          }
        })(),
      };
    })
    .catch(() => null);

  if (!info) return { safe: false, reason: "unreadable" };
  if (info.isSubmit) return { safe: false, reason: "form_submit", info };
  if (info.tag === "input" && info.type === "file") return { safe: false, reason: "file_upload", info };
  if (UNSAFE_HREF.test(info.href)) return { safe: false, reason: "external_app", info };
  if (info.externalHost || info.target === "_blank")
    return { safe: false, reason: "external_link", info };
  if (UNSAFE_TEXT.test(info.text)) return { safe: false, reason: "sensitive_action", info };
  return { safe: true, reason: "safe", info };
}

module.exports = { classifyClick, UNSAFE_TEXT, UNSAFE_HREF };