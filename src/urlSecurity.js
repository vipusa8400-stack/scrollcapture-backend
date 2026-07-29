const dns = require("dns").promises;
const net = require("net");

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

function isPrivateIPv4(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateIPv6(ip) {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA
  if (lower.startsWith("fe80")) return true; // link-local
  if (lower.startsWith("::ffff:")) {
    const v4 = lower.slice(7);
    if (net.isIPv4(v4)) return isPrivateIPv4(v4);
  }
  return false;
}

function isPrivateHost(host) {
  const h = host.toLowerCase();
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (net.isIPv4(h)) return isPrivateIPv4(h);
  if (net.isIPv6(h)) return isPrivateIPv6(h);
  return false;
}

async function validateAndNormalizeUrl(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("A website URL is required.");
  }
  const trimmed = raw.trim();
  const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url;
  try {
    url = new URL(withProto);
  } catch {
    throw new Error("Invalid URL.");
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new Error("Only http and https URLs are allowed.");
  }
  const host = url.hostname;
  if (!host || !host.includes(".") && !net.isIP(host)) {
    throw new Error("URL host is not resolvable on the public internet.");
  }
  if (isPrivateHost(host)) {
    throw new Error("Private, local, or internal URLs are not allowed.");
  }

  // Resolve DNS to make sure it doesn't point at a private range.
  if (!net.isIP(host)) {
    let records = [];
    try {
      records = await dns.lookup(host, { all: true });
    } catch {
      throw new Error("Could not resolve the domain.");
    }
    for (const r of records) {
      if (r.family === 4 && isPrivateIPv4(r.address)) {
        throw new Error("Domain resolves to a private IP address.");
      }
      if (r.family === 6 && isPrivateIPv6(r.address)) {
        throw new Error("Domain resolves to a private IP address.");
      }
    }
  }

  return url.toString();
}

module.exports = { validateAndNormalizeUrl };