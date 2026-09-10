// Regional map: the georeferenced satellite imagery (assets/map) drawn on a 2D canvas with the points of interest
// around the site (data/poi.json, OpenStreetMap + OSRM driving routes, see tools/fetch_poi.py).
// Coordinates are the Blender/site frame (metres, x east, y north), the same frame the 3D scene uses.
import { POI_CAT as CAT } from './poi.js?v=18';

const ORDER = Object.keys(CAT);

export function createRegionMap({ canvas, listEl, meta, loadJson, imageUrl, t, lang, siteBounds, doc: docIn, onStatus, onSelect }) {
  const ctx = canvas.getContext('2d');
  let doc = docIn || null, images = {}, loading = null;
  const view = { cx: 0, cy: 0, scale: 0.02 };     // centre (metres) + pixels per metre
  let selected = null, hovered = null, hits = [];
  let drag = null;

  const siteCentre = () => [(siteBounds.min[0] + siteBounds.max[0]) / 2, (siteBounds.min[1] + siteBounds.max[1]) / 2];
  const toPx = (x, y) => [(x - view.cx) * view.scale + canvas.width / 2, (view.cy - y) * view.scale + canvas.height / 2];
  const toWorld = (px, py) => [(px - canvas.width / 2) / view.scale + view.cx, view.cy - (py - canvas.height / 2) / view.scale];

  function loadImage(key) {
    return new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = imageUrl(`assets/map/sat_${key}.jpg`); });
  }
  async function ensureLoaded() {
    if (images.vast !== undefined) return;
    if (!loading) loading = (async () => {
      const [d, vast, far] = await Promise.all([doc ? doc : loadJson('data/poi.json').catch(() => ({ pois: [], categories: {} })), loadImage('vast'), loadImage('far')]);
      doc = d; images = { vast, far };
      fitAll();
    })();
    await loading;
  }
  function fitAll() {
    const [sx, sy] = siteCentre();
    let minx = sx - 3000, maxx = sx + 3000, miny = sy - 3000, maxy = sy + 3000;
    for (const p of doc.pois) { if (p.drive_min > 25) continue; minx = Math.min(minx, p.x); maxx = Math.max(maxx, p.x); miny = Math.min(miny, p.y); maxy = Math.max(maxy, p.y); }
    view.cx = (minx + maxx) / 2; view.cy = (miny + maxy) / 2;
    view.scale = Math.min(canvas.width / (maxx - minx), canvas.height / (maxy - miny)) * 0.88;
  }
  function resize() {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      const wasScale = view.scale, wasW = canvas.width;
      canvas.width = w; canvas.height = h;
      if (wasW > 1) view.scale = wasScale * (w / wasW); else if (doc) fitAll();
    }
  }
  function drawImage(im, m) {
    if (!im || !m?.corners) return;
    const c = m.corners;
    const [x0, y0] = toPx(c.nw[0], c.nw[1]), [x1, y1] = toPx(c.se[0], c.se[1]);
    ctx.drawImage(im, x0, y0, x1 - x0, y1 - y0);
  }
  function draw() {
    if (!doc) return;
    const W = canvas.width, H = canvas.height, dpr = canvas.width / Math.max(1, canvas.getBoundingClientRect().width);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0d1b2a'; ctx.fillRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    drawImage(images.vast, meta.vast);
    drawImage(images.far, meta.far);
    ctx.fillStyle = 'rgba(8, 16, 28, 0.18)'; ctx.fillRect(0, 0, W, H);

    // driving route of the selected place, along the streets
    if (selected && selected.route && selected.route.length >= 2) {
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      for (const [w, col] of [[7 * dpr, 'rgba(10,14,20,0.55)'], [3.5 * dpr, '#ffb347']]) {
        ctx.lineWidth = w; ctx.strokeStyle = col; ctx.beginPath();
        selected.route.forEach(([x, y], i) => { const [px, py] = toPx(x, y); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); });
        ctx.stroke();
      }
    }

    // the site
    const [ax, ay] = toPx(siteBounds.min[0], siteBounds.max[1]), [bx, by] = toPx(siteBounds.max[0], siteBounds.min[1]);
    ctx.lineWidth = 2 * dpr; ctx.strokeStyle = '#ffb347'; ctx.fillStyle = 'rgba(255, 179, 71, 0.28)';
    ctx.beginPath(); ctx.rect(ax, ay, bx - ax, by - ay); ctx.fill(); ctx.stroke();
    label('Legacy Heights', (ax + bx) / 2, ay - 8 * dpr, dpr, '#ffb347', true);

    // markers (drawn far -> near so the closest ones stay on top)
    hits = [];
    const list = doc.pois.slice().sort((a, b) => b.dist_km - a.dist_km);
    for (const p of list) {
      const c = CAT[p.cat] || { icon: '•', hex: '#888' };
      const [x, y] = toPx(p.x, p.y);
      if (x < -40 || y < -40 || x > W + 40 || y > H + 40) continue;
      const active = p === selected || p === hovered;
      const r = ((c.big ? 15 : 11) + (active ? 3 : 0)) * dpr;
      ctx.beginPath(); ctx.arc(x, y, r + 2 * dpr, 0, Math.PI * 2); ctx.fillStyle = active ? '#fff' : 'rgba(255,255,255,0.85)'; ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = c.hex; ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = `${Math.round((c.big ? 15 : 11) * dpr)}px system-ui, "Segoe UI Emoji", "Apple Color Emoji", sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(c.icon, x, y + 0.5 * dpr);
      if (c.big || active) label(`${p.name} · ${p.drive_min} ${t('min')} · ${p.road_km} km`, x, y + r + 4 * dpr, dpr, '#fff', false, true);
      hits.push({ p, x, y, r: r + 4 * dpr });
    }
    scaleBar(dpr);
  }
  function label(text, x, y, dpr, color, above, below) {
    ctx.font = `${Math.round(12 * dpr)}px Inter, system-ui, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = below ? 'top' : 'bottom';
    const w = ctx.measureText(text).width + 12 * dpr, h = 18 * dpr;
    ctx.fillStyle = 'rgba(10, 14, 20, 0.72)';
    roundRect(x - w / 2, below ? y - 1 * dpr : y - h + 1 * dpr, w, h, 5 * dpr); ctx.fill();
    ctx.fillStyle = color; ctx.fillText(text, x, below ? y + 2 * dpr : y - 2 * dpr);
  }
  function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  function scaleBar(dpr) {
    const targets = [500, 1000, 2000, 5000, 10000];
    let m = targets[0];
    for (const v of targets) if (v * view.scale < canvas.width * 0.3) m = v;
    const w = m * view.scale, x = 16 * dpr, y = canvas.height - 18 * dpr;
    ctx.fillStyle = 'rgba(10,14,20,0.6)'; roundRect(x - 6 * dpr, y - 18 * dpr, w + 12 * dpr, 26 * dpr, 4 * dpr); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 * dpr; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + w, y); ctx.moveTo(x, y - 5 * dpr); ctx.lineTo(x, y + 4 * dpr); ctx.moveTo(x + w, y - 5 * dpr); ctx.lineTo(x + w, y + 4 * dpr); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.font = `${Math.round(11 * dpr)}px Inter, system-ui, sans-serif`; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText(m >= 1000 ? `${m / 1000} km` : `${m} m`, x, y - 4 * dpr);
  }
  function hitAt(px, py) {
    const dpr = canvas.width / Math.max(1, canvas.getBoundingClientRect().width);
    const x = px * dpr, y = py * dpr;
    let best = null, bd = Infinity;
    for (const h of hits) { const d = Math.hypot(h.x - x, h.y - y); if (d < h.r && d < bd) { best = h.p; bd = d; } }
    return best;
  }
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  function renderList() {
    const L = lang();
    const groups = ORDER.map((k) => ({ k, items: doc.pois.filter((p) => p.cat === k).sort((a, b) => a.drive_min - b.drive_min) })).filter((g) => g.items.length);
    listEl.innerHTML = groups.map((g) => `<div class="map-cat-title">${doc.categories?.[g.k]?.[L] || g.k}</div>` + g.items.map((p) => {
      const c = CAT[p.cat] || { icon: '•', hex: '#888' };
      return `<div class="poi ${p === selected ? 'active' : ''}" data-id="${p.id}"><span class="ic" style="background:${c.hex}">${c.icon}</span><span><div class="nm">${esc(p.name)}</div><div class="cat">${doc.categories?.[p.cat]?.[L] || p.cat}</div></span><span class="dist"><b>${p.drive_min} ${t('min')}</b>${p.road_km} km</span></div>`;
    }).join('')).join('');
    listEl.querySelectorAll('.poi').forEach((el) => {
      el.onclick = () => { selectPoi(doc.pois.find((p) => p.id === el.dataset.id), true); };
    });
  }
  function selectPoi(p, centre, silent = false) {
    selected = p;
    if (p && centre) {
      const [sx, sy] = siteCentre();
      let minx = Math.min(sx, p.x), maxx = Math.max(sx, p.x), miny = Math.min(sy, p.y), maxy = Math.max(sy, p.y);
      for (const [x, y] of p.route || []) { minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y); }
      view.cx = (minx + maxx) / 2; view.cy = (miny + maxy) / 2;
      view.scale = Math.min(canvas.width / Math.max(maxx - minx, 1500), canvas.height / Math.max(maxy - miny, 1500)) * 0.7;
    }
    if (doc) { draw(); renderList(); }
    const active = listEl.querySelector('.poi.active'); if (active) active.scrollIntoView({ block: 'nearest' });
    if (!silent && onSelect) onSelect(p);
  }

  canvas.addEventListener('pointerdown', (ev) => { drag = { x: ev.clientX, y: ev.clientY, cx: view.cx, cy: view.cy, moved: false }; canvas.setPointerCapture(ev.pointerId); });
  canvas.addEventListener('pointermove', (ev) => {
    const r = canvas.getBoundingClientRect();
    if (drag) {
      const dpr = canvas.width / Math.max(1, r.width);
      const dx = (ev.clientX - drag.x) * dpr, dy = (ev.clientY - drag.y) * dpr;
      if (Math.hypot(dx, dy) > 3) drag.moved = true;
      view.cx = drag.cx - dx / view.scale; view.cy = drag.cy + dy / view.scale; draw(); return;
    }
    const h = hitAt(ev.clientX - r.left, ev.clientY - r.top);
    if (h !== hovered) { hovered = h; canvas.style.cursor = h ? 'pointer' : 'grab'; draw(); }
  });
  canvas.addEventListener('pointerup', (ev) => {
    if (!drag) return;
    const wasDrag = drag.moved; drag = null;
    if (wasDrag) return;
    const r = canvas.getBoundingClientRect();
    const h = hitAt(ev.clientX - r.left, ev.clientY - r.top);
    selectPoi(h || null, false);
  });
  canvas.addEventListener('pointerleave', () => { hovered = null; draw(); });
  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const r = canvas.getBoundingClientRect(), dpr = canvas.width / Math.max(1, r.width);
    const [wx, wy] = toWorld((ev.clientX - r.left) * dpr, (ev.clientY - r.top) * dpr);
    const k = Math.exp(-ev.deltaY * 0.0015);
    view.scale = Math.max(0.004, Math.min(0.6, view.scale * k));
    const [nx, ny] = toWorld((ev.clientX - r.left) * dpr, (ev.clientY - r.top) * dpr);
    view.cx += wx - nx; view.cy += wy - ny;
    draw();
  }, { passive: false });
  canvas.style.cursor = 'grab';
  window.addEventListener('resize', () => { if (doc && canvas.isConnected && canvas.offsetWidth) { resize(); draw(); } });

  return {
    async open() {
      onStatus?.(true);
      try { await ensureLoaded(); } finally { onStatus?.(false); }
      resize(); if (!selected) fitAll();
      renderList(); draw();
    },
    refresh() { if (doc) { renderList(); draw(); } },
    fitAll() { if (doc) { selected = null; fitAll(); draw(); renderList(); } },
    selectPoi,
    get selected() { return selected; },
  };
}
