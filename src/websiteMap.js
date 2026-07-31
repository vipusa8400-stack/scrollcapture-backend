/**
 * Website mapping: builds a structured map of every meaningful section and
 * interactive element on the prepared page, with multiple selector candidates,
 * bounding boxes and small screenshot previews.
 */

const MAX_SECTIONS = 24;
const MAX_PREVIEWS = 10;

const SECTION_RULES = [
  ["navigation", /\b(nav|navbar|menu|main-menu|primary-menu)\b/i],
  ["hero", /\b(hero|banner|masthead|jumbotron|intro|slider)\b/i],
  ["pricing", /\b(pricing|price|plans?|packages?|tariff|harga|pakej)\b/i],
  ["testimonials", /\b(testimonial|review|feedback|clients?-say|rating)\b/i],
  ["services", /\b(services?|what-we-do|solutions?|offerings?|perkhidmatan)\b/i],
  ["products", /\b(products?|shop|store|catalog|menu-items?|produk)\b/i],
  ["portfolio", /\b(portfolio|projects?|work|case-stud)/i],
  ["gallery", /\b(gallery|photos?|images?|galeri)\b/i],
  ["faq", /\b(faq|questions?|q-?and-?a|soalan)\b/i],
  ["about", /\b(about|who-we-are|our-story|company|tentang)\b/i],
  ["team", /\b(team|staff|our-people)\b/i],
  ["contact", /\b(contact|reach-us|get-in-touch|hubungi|location|map)\b/i],
  ["features", /\b(features?|benefits?|why-(us|choose))\b/i],
  ["cta", /\b(cta|call-to-action|get-started|book-now)\b/i],
  ["footer", /\b(footer|site-info)\b/i],
];

/** Serialisable extraction that runs inside the page. */
const MAP_SCRIPT = ({ rules, maxSections }) => {
  const compiled = rules.map(([type, src, flags]) => [type, new RegExp(src, flags)]);
  const text = (el) => (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();

  const cssPath = (el) => {
    if (!el || el.nodeType !== 1) return null;
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 4) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      const parent = node.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = node.parentElement;
      depth += 1;
    }
    return parts.join(" > ");
  };

  const box = (el) => {
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.left + window.scrollX),
      y: Math.round(r.top + window.scrollY),
      width: Math.round(r.width),
      height: Math.round(r.height),
    };
  };

  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) < 0.05)
      return false;
    const r = el.getBoundingClientRect();
    return r.width > 40 && r.height > 20;
  };

  const classify = (el, heading) => {
    const hay = `${el.id || ""} ${typeof el.className === "string" ? el.className : ""} ${
      el.getAttribute("data-section") || ""
    } ${heading || ""}`;
    for (const [type, re] of compiled) if (re.test(hay)) return type;
    if (el.tagName === "NAV") return "navigation";
    if (el.tagName === "HEADER") return "hero";
    if (el.tagName === "FOOTER") return "footer";
    if (el.querySelector("form")) return "contact";
    return "content";
  };

  const selectorsFor = (el, heading) => {
    const out = [];
    if (el.id) out.push(`#${CSS.escape(el.id)}`);
    const dataId = el.getAttribute("data-section") || el.getAttribute("data-id");
    if (dataId) out.push(`[data-section="${dataId}"]`);
    if (heading) {
      const safe = heading.slice(0, 40).replace(/'/g, "\\'");
      out.push(`${el.tagName.toLowerCase()}:has-text('${safe}')`);
      out.push(`section:has-text('${safe}')`);
    }
    const aria = el.getAttribute("aria-label");
    if (aria) out.push(`[aria-label="${aria}"]`);
    const path = cssPath(el);
    if (path) out.push(path);
    return Array.from(new Set(out)).slice(0, 6);
  };

  const candidates = Array.from(
    document.querySelectorAll(
      "header, nav, main > section, main > div, section, footer, [id][class], div[class*='section']",
    ),
  );

  const seen = new Set();
  const sections = [];
  for (const el of candidates) {
    if (sections.length >= maxSections) break;
    if (seen.has(el)) continue;
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.height < 80 && el.tagName !== "NAV" && el.tagName !== "HEADER") continue;
    // Skip elements whose parent was already captured with almost the same box.
    let skip = false;
    for (const prev of sections) {
      if (Math.abs(prev.boundingBox.y - (r.top + window.scrollY)) < 24 &&
          Math.abs(prev.boundingBox.height - r.height) < 40) {
        skip = true;
        break;
      }
    }
    if (skip) continue;
    seen.add(el);

    const headingEl = el.querySelector("h1, h2, h3, [role='heading']");
    const heading = headingEl ? text(headingEl).slice(0, 120) : "";
    const type = classify(el, heading);
    const body = text(el);
    const children = Array.from(el.querySelectorAll("a, button, [role='button'], input, h3, h4"))
      .filter((c) => visible(c))
      .slice(0, 10)
      .map((c) => ({
        tag: c.tagName.toLowerCase(),
        name: (c.getAttribute("aria-label") || text(c)).slice(0, 60),
        role: c.getAttribute("role") || null,
        href: c.getAttribute("href") || null,
        selector: c.id ? `#${CSS.escape(c.id)}` : cssPath(c),
      }))
      .filter((c) => c.name);

    const b = box(el);
    sections.push({
      sectionId: `sec-${String(sections.length + 1).padStart(2, "0")}`,
      type,
      route: location.pathname + location.hash,
      heading,
      summary: body.slice(0, 220),
      selectorCandidates: selectorsFor(el, heading),
      ariaRole: el.getAttribute("role") || el.tagName.toLowerCase(),
      accessibleName: el.getAttribute("aria-label") || heading || "",
      href: el.getAttribute("href") || null,
      boundingBox: b,
      width: b.width,
      height: b.height,
      isLargeSection: b.height > window.innerHeight * 0.75,
      childElements: children,
      requiresNavigation: false,
      requiresOpen:
        el.querySelector("[role='tab'], details, [aria-expanded], .accordion, [data-accordion]")
          ? "tab_or_accordion"
          : null,
    });
  }

  const collect = (selector, mapper) =>
    Array.from(document.querySelectorAll(selector))
      .filter((el) => visible(el))
      .slice(0, 12)
      .map(mapper)
      .filter(Boolean);

  const linkInfo = (el) => ({
    name: (el.getAttribute("aria-label") || text(el)).slice(0, 60),
    href: el.getAttribute("href") || null,
    selector: el.id ? `#${CSS.escape(el.id)}` : cssPath(el),
    boundingBox: box(el),
  });

  const navigation = collect("nav a, header nav a, [role='navigation'] a", linkInfo).filter(
    (l) => l.name,
  );

  const allLinks = Array.from(document.querySelectorAll("a[href]"));
  const internalRoutes = Array.from(
    new Set(
      allLinks
        .map((a) => a.getAttribute("href") || "")
        .filter((h) => h && !/^(https?:)?\/\//i.test(h) && !/^(mailto:|tel:|javascript:)/i.test(h))
        .map((h) => h.split("?")[0]),
    ),
  ).slice(0, 20);

  const ctaButtons = collect(
    "a[class*='btn'], button, [role='button'], a[class*='button']",
    (el) => {
      const name = (el.getAttribute("aria-label") || text(el)).slice(0, 50);
      if (!name) return null;
      return { ...linkInfo(el), name };
    },
  );

  const whatsappButton =
    collect("a[href*='wa.me'], a[href*='whatsapp'], [class*='whatsapp']", linkInfo)[0] || null;
  const bookingButtons = ctaButtons.filter((b) =>
    /book|appointment|reserve|schedule|tempah/i.test(b.name),
  );
  const forms = collect("form", (el) => ({
    selector: el.id ? `#${CSS.escape(el.id)}` : cssPath(el),
    fields: Array.from(el.querySelectorAll("input, textarea, select")).length,
    boundingBox: box(el),
  }));
  const tabs = collect("[role='tab'], [data-tab], .tab", linkInfo);
  const accordions = collect("details, [data-accordion], [aria-expanded]", linkInfo);
  const dropdowns = collect("select, [role='menu'], [aria-haspopup='true']", linkInfo);
  const footerEl = document.querySelector("footer");

  return {
    url: location.href,
    title: document.title,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    pageHeight: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
    sections,
    navigation,
    internalRoutes,
    ctaButtons: ctaButtons.slice(0, 10),
    whatsappButton,
    bookingButtons,
    forms,
    tabs,
    accordions,
    dropdowns,
    footer: footerEl ? { selector: "footer", boundingBox: box(footerEl) } : null,
  };
};

/** Small JPEG previews for the most important sections. */
async function attachPreviews(page, map) {
  const ranked = [...map.sections]
    .filter((s) => s.type !== "content")
    .slice(0, MAX_PREVIEWS);
  for (const section of ranked) {
    const b = section.boundingBox;
    if (!b || b.width < 40 || b.height < 40) continue;
    try {
      const buf = await page.screenshot({
        type: "jpeg",
        quality: 35,
        clip: {
          x: Math.max(0, b.x),
          y: Math.max(0, b.y),
          width: Math.min(b.width, map.viewport.width),
          height: Math.min(b.height, Math.round(map.viewport.height * 1.2)),
        },
        fullPage: true,
        timeout: 8000,
      });
      section.preview = `data:image/jpeg;base64,${buf.toString("base64")}`;
    } catch {
      /* preview is optional */
    }
  }
  return map;
}

/** Builds the complete website map for an already-prepared page. */
async function mapWebsite(page, { previews = true } = {}) {
  const rules = SECTION_RULES.map(([type, re]) => [type, re.source, re.flags]);
  const map = await page.evaluate(MAP_SCRIPT, { rules, maxSections: MAX_SECTIONS });
  if (previews) await attachPreviews(page, map).catch(() => {});
  map.sectionTypes = Array.from(new Set(map.sections.map((s) => s.type)));
  map.mappedAt = Date.now();
  return map;
}

/** Compact, token-friendly view of the map for the AI planner. */
function summariseMap(map) {
  const lines = map.sections.map((s) =>
    [
      s.sectionId,
      s.type,
      s.heading || s.accessibleName || "(no heading)",
      `${s.width}x${s.height}${s.isLargeSection ? " LARGE" : ""}`,
      s.selectorCandidates.slice(0, 3).join(" | "),
      s.summary.slice(0, 110),
    ].join(" :: "),
  );
  if (map.navigation.length)
    lines.push(`NAV :: ${map.navigation.map((n) => `${n.name}->${n.href || ""}`).join(", ")}`);
  if (map.whatsappButton) lines.push(`WHATSAPP :: ${map.whatsappButton.selector}`);
  if (map.bookingButtons.length)
    lines.push(`BOOKING :: ${map.bookingButtons.map((b) => b.name).join(", ")}`);
  if (map.internalRoutes.length) lines.push(`ROUTES :: ${map.internalRoutes.join(", ")}`);
  return lines.join("\n").slice(0, 9000);
}

/** Strips heavy preview images before sending the map to the client. */
function lightMap(map) {
  if (!map) return null;
  return {
    ...map,
    sections: map.sections.map(({ preview, ...rest }) => ({
      ...rest,
      hasPreview: Boolean(preview),
    })),
  };
}

module.exports = { mapWebsite, summariseMap, lightMap, SECTION_RULES };
