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
    c.style.transform = 'scale(' + inv + ')';
    c.style.transformOrigin = 'top left';
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
