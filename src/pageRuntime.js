/**
 * Script injected into the presented page. Provides the highlight overlay,
 * a human-like cursor, and element-anchored zoom.
 * Everything is positioned in DOCUMENT coordinates so it stays glued to the
 * element while the page scrolls and while the camera zooms.
 */
const PAGE_RUNTIME = `
window.__scWalkthrough = {
  _scale: 1,
  ensureOverlay() {
    if (document.getElementById('__sc_overlay')) return;
    const style = document.createElement('style');
    style.id = '__sc_overlay_style';
    style.textContent = \`
      #__sc_overlay{position:absolute;pointer-events:none;z-index:2147483646;border-radius:14px;
        border:3px solid rgba(59,130,246,.95);
        box-shadow:0 0 0 6px rgba(59,130,246,.18),0 0 34px 8px rgba(59,130,246,.45);
        transition:opacity .18s ease;opacity:0;}
      #__sc_cursor{position:absolute;pointer-events:none;z-index:2147483647;width:26px;height:26px;
        margin-left:-3px;margin-top:-2px;opacity:0;transition:opacity .2s ease;
        filter:drop-shadow(0 2px 4px rgba(15,23,42,.45));}
      #__sc_ripple{position:absolute;pointer-events:none;z-index:2147483645;width:14px;height:14px;
        margin-left:-7px;margin-top:-7px;border-radius:999px;opacity:0;
        background:rgba(59,130,246,.35);border:2px solid rgba(59,130,246,.8);}
      .__sc_trail{position:absolute;pointer-events:none;z-index:2147483644;width:9px;height:9px;
        margin-left:-4px;margin-top:-4px;border-radius:999px;opacity:0;
        background:rgba(59,130,246,.28);}
      html{scroll-behavior:auto !important;}
    \`;
    document.head.appendChild(style);
    const box = document.createElement('div');
    box.id = '__sc_overlay';
    document.body.appendChild(box);
    const ripple = document.createElement('div');
    ripple.id = '__sc_ripple';
    document.body.appendChild(ripple);
    const cursor = document.createElement('div');
    cursor.id = '__sc_cursor';
    cursor.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M4 2l14 8.5-6.1 1.3 3.2 6.6-2.7 1.3-3.2-6.6L4 17.6z" fill="#0f172a" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    document.body.appendChild(cursor);
  },
  metrics() {
    return {
      scrollY: window.scrollY,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      pageHeight: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
      stickyHeaderHeight: (() => {
        let h = 0;
        for (const el of Array.from(document.querySelectorAll('header,nav,[class*="header"],[class*="navbar"]'))) {
          const cs = getComputedStyle(el);
          if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
          const r = el.getBoundingClientRect();
          if (r.top <= 4 && r.height > h && r.height < window.innerHeight * 0.4) h = r.height;
        }
        return Math.round(h);
      })(),
    };
  },
  findTarget(query) {
    return this._findTarget(query);
  },
  chrome() {
    let top = 0;
    let bottom = 0;
    const overlays = [];
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
      if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.1) continue;
      if (el.id && el.id.indexOf('__sc_') === 0) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 8) continue;
      if (r.top <= 6 && r.height < window.innerHeight * 0.4 && r.height > top) top = r.height;
      else if (r.bottom >= window.innerHeight - 6 && r.height < window.innerHeight * 0.35 && r.height > bottom) bottom = r.height;
      else if (r.height > window.innerHeight * 0.4 && r.width > window.innerWidth * 0.5) {
        overlays.push({ x: r.left, y: r.top, width: r.width, height: r.height });
      }
    }
    return {
      stickyHeaderHeight: Math.round(top),
      bottomBarHeight: Math.round(bottom),
      blockingOverlays: overlays.length,
      scrollY: window.scrollY,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      pageHeight: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
    };
  },
  assetsReady() {
    const imgs = Array.from(document.images).filter((i) => {
      const r = i.getBoundingClientRect();
      return r.bottom > -200 && r.top < window.innerHeight + 200 && r.width > 8;
    });
    const loaded = imgs.filter((i) => i.complete && i.naturalWidth > 0).length;
    const fonts = !document.fonts || document.fonts.status === 'loaded';
    return { fonts: fonts, images: imgs.length ? loaded / imgs.length : 1 };
  },
  /** How much of the target is really visible and un-covered, 0..1 each. */
  inspect(rect, safeTop, safeBottom) {
    const top = safeTop || 0;
    const bottom = safeBottom || 0;
    const vt = window.scrollY + top;
    const vb = window.scrollY + window.innerHeight - bottom;
    const iy = Math.max(0, Math.min(rect.y + rect.height, vb) - Math.max(rect.y, vt));
    const vl = window.scrollX;
    const vr = window.scrollX + window.innerWidth;
    const ix = Math.max(0, Math.min(rect.x + rect.width, vr) - Math.max(rect.x, vl));
    const visibleRatio = (ix * iy) / Math.max(1, rect.width * rect.height);

    let sampled = 0;
    let covered = 0;
    let behindHeader = 0;
    for (let gx = 1; gx <= 3; gx++) {
      for (let gy = 1; gy <= 3; gy++) {
        const px = rect.x + (rect.width * gx) / 4 - window.scrollX;
        const py = rect.y + (rect.height * gy) / 4 - window.scrollY;
        if (px < 0 || py < 0 || px > window.innerWidth || py > window.innerHeight) continue;
        sampled++;
        if (py < top || py > window.innerHeight - bottom) { behindHeader++; continue; }
        const el = document.elementFromPoint(px, py);
        if (!el) { covered++; continue; }
        const cs = getComputedStyle(el);
        let node = el;
        let fixed = false;
        while (node && node !== document.body) {
          const s = getComputedStyle(node);
          if (s.position === 'fixed' || Number(s.zIndex) > 9000) { fixed = true; break; }
          node = node.parentElement;
        }
        if (fixed && (el.id || '').indexOf('__sc_') !== 0) covered++;
        else if (cs.visibility === 'hidden') covered++;
      }
    }
    return {
      visibleRatio: Math.max(0, Math.min(1, visibleRatio)),
      coveredRatio: sampled ? covered / sampled : 1,
      behindChromeRatio: sampled ? behindHeader / sampled : 1,
      sampled: sampled,
    };
  },
  _findTarget(query) {
    const q = String(query || '').toLowerCase().trim();
    if (!q) return null;
    const words = q.split(/\\s+/).filter((w) => w.length > 2);
    const candidates = Array.from(document.querySelectorAll(
      'section,header,footer,nav,main,article,aside,div,a,button,form,img,h1,h2,h3,[role],[aria-label]'
    ));
    let best = null;
    let bestScore = 0;
    for (const el of candidates) {
      const r = el.getBoundingClientRect();
      if (r.width < 24 || r.height < 18) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.1) continue;
      const hay = [
        el.getAttribute('aria-label') || '',
        el.getAttribute('id') || '',
        el.className && typeof el.className === 'string' ? el.className : '',
        el.getAttribute('href') || '',
        el.getAttribute('alt') || '',
        (el.textContent || '').slice(0, 240),
        el.tagName,
      ].join(' ').toLowerCase();
      let score = 0;
      if (hay.includes(q)) score += 6;
      for (const w of words) if (hay.includes(w)) score += 2;
      if (score === 0) continue;
      const area = r.width * r.height;
      if (area > window.innerWidth * window.innerHeight * 3) score -= 3;
      if (el.children.length === 0) score += 1;
      if (score > bestScore) { bestScore = score; best = el; }
    }
    if (!best) return null;
    const r = best.getBoundingClientRect();
    return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
  },
  showHighlight(rect, pad) {
    this.ensureOverlay();
    const el = document.getElementById('__sc_overlay');
    el.style.left = (rect.x - pad) + 'px';
    el.style.top = (rect.y - pad) + 'px';
    el.style.width = (rect.width + pad * 2) + 'px';
    el.style.height = (rect.height + pad * 2) + 'px';
    el.style.opacity = '1';
  },
  hideHighlight() {
    const el = document.getElementById('__sc_overlay');
    if (el) el.style.opacity = '0';
  },
  showCursor(on) {
    this.ensureOverlay();
    const c = document.getElementById('__sc_cursor');
    if (c) c.style.opacity = on ? '1' : '0';
  },
  moveCursor(x, y) {
    this.ensureOverlay();
    const c = document.getElementById('__sc_cursor');
    if (!c) return;
    c.style.left = x + 'px';
    c.style.top = y + 'px';
    c.style.opacity = '1';
    const inv = 1 / (this._scale || 1);
    c.style.transform = 'scale(' + (inv * (this._press || 1)) + ')';
    c.style.transformOrigin = 'top left';
    if (this._trail) this.pushTrail(x, y, inv);
  },
  setPress(amount) {
    this._press = 1 - Math.max(0, Math.min(0.25, amount || 0));
    const c = document.getElementById('__sc_cursor');
    if (!c) return;
    const inv = 1 / (this._scale || 1);
    c.style.transform = 'scale(' + (inv * this._press) + ')';
    c.style.transformOrigin = 'top left';
  },
  enableTrail(on) {
    this._trail = Boolean(on);
    if (!on) this.clearTrail();
  },
  pushTrail(x, y, inv) {
    this.ensureOverlay();
    this._trailNodes = this._trailNodes || [];
    const dot = document.createElement('div');
    dot.className = '__sc_trail';
    dot.style.left = x + 'px';
    dot.style.top = y + 'px';
    dot.style.opacity = '0.55';
    dot.style.transform = 'scale(' + inv + ')';
    document.body.appendChild(dot);
    this._trailNodes.push(dot);
    if (this._trailNodes.length > 10) {
      const old = this._trailNodes.shift();
      if (old && old.parentNode) old.parentNode.removeChild(old);
    }
    this._trailNodes.forEach((n, i) => {
      n.style.opacity = String(0.06 + (i / this._trailNodes.length) * 0.4);
    });
  },
  clearTrail() {
    (this._trailNodes || []).forEach((n) => n.parentNode && n.parentNode.removeChild(n));
    this._trailNodes = [];
  },
  ripple(x, y, progress) {
    this.ensureOverlay();
    const r = document.getElementById('__sc_ripple');
    if (!r) return;
    const inv = 1 / (this._scale || 1);
    r.style.left = x + 'px';
    r.style.top = y + 'px';
    r.style.opacity = String(Math.max(0, 1 - progress) * 0.9);
    r.style.transform = 'scale(' + (inv * (1 + progress * 3.2)) + ')';
  },
  hideRipple() {
    const r = document.getElementById('__sc_ripple');
    if (r) r.style.opacity = '0';
  },
  setZoom(scale, originX, originY) {
    const root = document.documentElement;
    this._scale = scale;
    const c = document.getElementById('__sc_cursor');
    if (c) { c.style.transform = 'scale(' + (1 / scale) + ')'; c.style.transformOrigin = 'top left'; }
    if (scale === 1) {
      root.style.transform = '';
      root.style.transformOrigin = '';
      return;
    }
    root.style.transformOrigin = originX + 'px ' + originY + 'px';
    root.style.transform = 'scale(' + scale + ')';
  },
};
`;

module.exports = { PAGE_RUNTIME };
