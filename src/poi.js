// Points of interest in the main 3D map: a dot per place (DOM markers projected every frame, constant pixel size),
// the airport labelled permanently, and on selection the driving route drawn as a line along the streets
// (data/poi.json, OpenStreetMap + OSRM, tools/fetch_poi.py) with a small info card.
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

export const POI_CAT = {
  airport:     { icon: '✈', hex: '#2b6cb0', big: true },
  supermarket: { icon: '🛒', hex: '#2f855a' },
  restaurant:  { icon: '🍽', hex: '#c05621' },
  hospital:    { icon: '✚', hex: '#c53030' },
  school:      { icon: '🎓', hex: '#6b46c1' },
  pharmacy:    { icon: '⚕', hex: '#2c7a7b' },
  park:        { icon: '🌳', hex: '#38a169' },
  beach:       { icon: '🏖', hex: '#d69e2e' },
};

export function createPois(ctx) {
  // ctx: scene, camera, layer (DOM container), card (DOM), tooltip (DOM), doc (poi.json), t, lang, siteCentre (Vector3), flyTo(pos, target, ms), onSelect(poi|null)
  const { scene, camera, layer, card, doc } = ctx;
  const pois = doc.pois || [];
  const markers = [];
  let selected = null, route = null;
  const _v = new THREE.Vector3();
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const catLabel = (p) => doc.categories?.[p.cat]?.[ctx.lang()] || p.cat;

  for (const p of pois) {
    const c = POI_CAT[p.cat] || { icon: '•', hex: '#888' };
    const el = document.createElement('button');
    el.className = `poi-dot${c.big ? ' big' : ''}`;
    el.style.setProperty('--c', c.hex);
    el.innerHTML = `<span class="ic">${c.icon}</span><span class="lbl"></span>`;
    el.dataset.id = p.id;
    el.onclick = (ev) => { ev.stopPropagation(); select(p, true); };
    el.onpointerenter = () => { ctx.tooltip.innerHTML = tooltipHtml(p); ctx.tooltip.classList.add('show'); };
    el.onpointermove = (ev) => { ctx.tooltip.style.left = `${ev.clientX + 16}px`; ctx.tooltip.style.top = `${ev.clientY + 16}px`; };
    el.onpointerleave = () => { ctx.tooltip.classList.remove('show'); };
    layer.appendChild(el);
    markers.push({ p, el, pos: new THREE.Vector3(p.x, 4, -p.y), lbl: el.querySelector('.lbl') });
  }
  function tooltipHtml(p) {
    return `<b>${esc(p.name)}</b><br><span class="dot" style="background:${(POI_CAT[p.cat] || {}).hex || '#888'}"></span>${esc(catLabel(p))} · ${p.road_km} km · ${p.drive_min} ${ctx.t('min')}<br><span class="muted">${ctx.t('clickForRoute')}</span>`;
  }
  function refreshLabels() {
    for (const m of markers) m.lbl.textContent = `${m.p.name} · ${m.p.drive_min} ${ctx.t('min')}`;
    if (selected) renderCard(selected);
  }
  refreshLabels();

  // --------------------------------------------------------------------------------------------------------------
  function update() {
    const W = window.innerWidth, H = window.innerHeight;
    for (const m of markers) {
      _v.copy(m.pos).project(camera);
      const behind = _v.z > 1 || _v.z < -1;
      const x = (_v.x + 1) / 2 * W, y = (1 - _v.y) / 2 * H;
      const off = behind || x < -60 || x > W + 60 || y < -40 || y > H + 40;
      if (off) { if (!m.el.hidden) m.el.hidden = true; continue; }
      if (m.el.hidden) m.el.hidden = false;
      m.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    }
  }
  function buildRoute(p) {
    clearRoute();
    const pts = (p.route && p.route.length >= 2) ? p.route : [[ctx.siteCentre.x, -ctx.siteCentre.z], [p.x, p.y]];
    const arr = [];
    for (const [x, y] of pts) arr.push(x, 3, -y);
    const geo = new LineGeometry().setPositions(arr);
    const mat = new LineMaterial({ color: 0xffb347, linewidth: 4, transparent: true, opacity: 0.95, depthTest: false, resolution: new THREE.Vector2(window.innerWidth, window.innerHeight) });
    route = new Line2(geo, mat);
    route.computeLineDistances(); route.renderOrder = 7; route.frustumCulled = false;
    scene.add(route);
  }
  function clearRoute() {
    if (route) { scene.remove(route); route.geometry.dispose(); route.material.dispose(); route = null; }
  }
  function frame(p) {
    const pts = (p.route && p.route.length >= 2) ? p.route : [[ctx.siteCentre.x, -ctx.siteCentre.z], [p.x, p.y]];
    let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
    for (const [x, y] of pts.concat([[ctx.siteCentre.x, -ctx.siteCentre.z], [p.x, p.y]])) { minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y); }
    const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2, ext = Math.max(maxx - minx, maxy - miny, 800);
    const target = new THREE.Vector3(cx, 0, -cy);
    const d = ext * (window.innerWidth < 700 ? 1.6 : 1.15);
    const pos = target.clone().add(new THREE.Vector3(0, d * 0.95, d * 0.75));
    ctx.flyTo(pos, target, 1800);
  }
  function renderCard(p) {
    const c = POI_CAT[p.cat] || { icon: '•', hex: '#888' };
    card.innerHTML = `
      <button class="icon-btn poi-card-close" aria-label="Close">×</button>
      <div class="poi-card-head"><span class="ic" style="background:${c.hex}">${c.icon}</span><div><div class="nm">${esc(p.name)}</div><div class="cat">${esc(catLabel(p))}</div></div></div>
      <div class="poi-facts"><div><b>${p.drive_min} ${ctx.t('min')}</b><span>${ctx.t('drive')}</span></div><div><b>${p.road_km} km</b><span>${ctx.t('byRoad')}</span></div><div><b>${p.dist_km} km</b><span>${ctx.t('straightLine')}</span></div></div>
      <div class="poi-card-actions"><button class="btn small" id="poi-frame">${ctx.t('showRoute')}</button><button class="btn ghost small" id="poi-map">${ctx.t('map')}</button></div>`;
    card.querySelector('.poi-card-close').onclick = () => select(null);
    card.querySelector('#poi-frame').onclick = () => frame(p);
    card.querySelector('#poi-map').onclick = () => ctx.openMap && ctx.openMap(p);
    card.hidden = false;
  }
  function select(p, fly = false, notify = true) {
    selected = p;
    for (const m of markers) m.el.classList.toggle('active', m.p === p);
    if (!p) { clearRoute(); card.hidden = true; if (notify && ctx.onSelect) ctx.onSelect(null); return; }
    buildRoute(p); renderCard(p);
    if (fly) frame(p);
    if (notify && ctx.onSelect) ctx.onSelect(p);
  }
  function resize() { if (route) route.material.resolution.set(window.innerWidth, window.innerHeight); }
  return { update, select, resize, refreshLabels, get selected() { return selected; }, get markers() { return markers; } };
}
