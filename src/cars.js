// A few slow cars driving on the subdivision roads. The road centrelines come from the dashed white centreline
// painted in the Blender model ("Pintura viaria" material): each dash is one small mesh island, the dashes are chained
// into polylines and turned into smooth curves. Cars keep to the LEFT of the centreline (Barbados drives on the left).
// The car body is a smooth lofted hatchback (cross sections along the length, shared vertices -> rounded shading).
import * as THREE from 'three';

const CAR_COLORS = [0x8f2a1e, 0xf2f2f2, 0x1f2a44, 0x8a8f96, 0x2b2b2b, 0xd8d8d8, 0x2d5d8f, 0xe0a94a];
const LANE = 1.75;          // metres from the centreline to the middle of the lane
const UP = new THREE.Vector3(0, 1, 0);

export function createCars(ctx) {
  // ctx: scene, paintGeometries (three.js coordinates, baked), isTouch, count
  const { scene, isTouch } = ctx;
  const cars = [];
  let curves = [], night = false;
  const group = new THREE.Group();
  group.name = '__cars';
  scene.add(group);

  // ------------------------------------------------------------------------------------------------------------
  // dashes -> polylines
  // ------------------------------------------------------------------------------------------------------------
  function extractDashes(geos) {
    const dashes = [];
    for (const g of geos) {
      const p = g.attributes.position, idx = g.index, n = idx ? idx.count : p.count;
      const I = (t) => (idx ? idx.getX(t) : t);
      const key = new Map(), vid = new Int32Array(p.count);
      for (let i = 0; i < p.count; i++) {
        const k = `${Math.round(p.getX(i) * 100)},${Math.round(p.getZ(i) * 100)}`;
        let v = key.get(k); if (v === undefined) { v = key.size; key.set(k, v); }
        vid[i] = v;
      }
      const parent = new Int32Array(key.size); for (let i = 0; i < parent.length; i++) parent[i] = i;
      const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
      const uni = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
      for (let t = 0; t < n; t += 3) { uni(vid[I(t)], vid[I(t + 1)]); uni(vid[I(t + 1)], vid[I(t + 2)]); }
      const comps = new Map();
      for (let i = 0; i < p.count; i++) {
        const r = find(vid[i]);
        let c = comps.get(r); if (!c) { c = { pts: [], seen: new Set() }; comps.set(r, c); }
        if (c.seen.has(vid[i])) continue;
        c.seen.add(vid[i]); c.pts.push([p.getX(i), p.getZ(i)]);
      }
      for (const c of comps.values()) {
        if (c.pts.length < 4 || c.pts.length > 40) continue;
        let best = 0, pa = null, pb = null;
        for (let i = 0; i < c.pts.length; i++) for (let j = i + 1; j < c.pts.length; j++) {
          const d = Math.hypot(c.pts[j][0] - c.pts[i][0], c.pts[j][1] - c.pts[i][1]);
          if (d > best) { best = d; pa = c.pts[i]; pb = c.pts[j]; }
        }
        if (best < 1.5 || best > 6) continue;
        const cx = c.pts.reduce((s, q) => s + q[0], 0) / c.pts.length, cz = c.pts.reduce((s, q) => s + q[1], 0) / c.pts.length;
        dashes.push({ x: cx, z: cz, dx: (pb[0] - pa[0]) / best, dz: (pb[1] - pa[1]) / best, len: best });
      }
    }
    return dashes;
  }
  function chain(dashes) {
    const cell = 12, grid = new Map();
    const gk = (x, z) => `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
    dashes.forEach((d, i) => { const k = gk(d.x, d.z); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); });
    const near = (d) => {
      const out = [], gx = Math.floor(d.x / cell), gz = Math.floor(d.z / cell);
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) { const l = grid.get(`${gx + a},${gz + b}`); if (l) out.push(...l); }
      return out;
    };
    const next = (i, sx, sz, used) => {
      const d = dashes[i];
      let best = null, bt = Infinity;
      for (const j of near(d)) {
        if (j === i || used.has(j)) continue;
        const e = dashes[j];
        const vx = e.x - d.x, vz = e.z - d.z;
        const t = vx * sx + vz * sz, lat = Math.abs(vx * sz - vz * sx);
        if (t < 1.5 || t > 14 || lat > 2.2) continue;
        const dot = Math.abs(e.dx * sx + e.dz * sz);
        if (dot < 0.7) continue;
        if (t < bt) { bt = t; best = j; }
      }
      return best;
    };
    const used = new Set(), lines = [];
    for (let s = 0; s < dashes.length; s++) {
      if (used.has(s)) continue;
      used.add(s);
      const walk = (sx, sz) => {
        const out = []; let i = s, dx = sx, dz = sz;
        for (let guard = 0; guard < 2000; guard++) {
          const j = next(i, dx, dz, used);
          if (j == null) break;
          used.add(j); out.push(j);
          const e = dashes[j];
          const flip = (e.dx * dx + e.dz * dz) < 0;
          dx = flip ? -e.dx : e.dx; dz = flip ? -e.dz : e.dz;
          i = j;
        }
        return out;
      };
      const fwd = walk(dashes[s].dx, dashes[s].dz), back = walk(-dashes[s].dx, -dashes[s].dz);
      const seq = [...back.reverse(), s, ...fwd];
      if (seq.length >= 3) lines.push(seq.map((i) => new THREE.Vector3(dashes[i].x, 0.15, dashes[i].z)));
    }
    return lines;
  }

  // ------------------------------------------------------------------------------------------------------------
  // car body: lofted cross sections. Local +Z is the front, +Y up, X to the right.
  // ------------------------------------------------------------------------------------------------------------
  function loft(sections, tint) {
    // each section: { z, pts: [[halfWidth, height], ...] } from the bottom centre (w = 0) to the top centre (w = 0)
    const rings = sections.map((s) => {
      const r = [];
      for (const [w, h] of s.pts) r.push([w, h]);
      for (let i = s.pts.length - 1; i >= 0; i--) { const [w, h] = s.pts[i]; if (w > 1e-4) r.push([-w, h]); }
      return r;
    });
    const m = rings[0].length, n = rings.length;
    const pos = [], col = [], idx = [];
    rings.forEach((ring, i) => ring.forEach(([w, h]) => { pos.push(w, h, sections[i].z); const k = tint ? tint(h, sections[i].z) : 1; col.push(k, k, k); }));
    for (let i = 0; i < n - 1; i++) for (let j = 0; j < m; j++) {
      const a = i * m + j, b = i * m + (j + 1) % m, c = (i + 1) * m + (j + 1) % m, d = (i + 1) * m + j;
      idx.push(a, c, b, a, d, c);
    }
    // end caps
    for (const [i, flip] of [[0, false], [n - 1, true]]) {
      const cx = 0, cy = rings[i].reduce((s, q) => s + q[1], 0) / m;
      const centre = pos.length / 3; pos.push(cx, cy, sections[i].z); col.push(1, 1, 1);
      for (let j = 0; j < m; j++) { const a = i * m + j, b = i * m + (j + 1) % m; if (flip) idx.push(centre, a, b); else idx.push(centre, b, a); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }
  // lower body (sill to belt line, hood and hatch deck); widths scaled at the ends so the corners round off
  const body = (k, yTop, dz = 0) => [[0, 0.3], [0.72 * k, 0.3], [0.84 * k, 0.5], [0.87 * k, 0.78], [0.8 * k, yTop], [0, yTop + 0.03]];
  const BODY_SECTIONS = [
    { z: 2.1, pts: body(0.55, 0.62) }, { z: 2.05, pts: body(0.86, 0.72) }, { z: 1.85, pts: body(0.97, 0.84) }, { z: 1.3, pts: body(1, 0.9) },
    { z: 0.6, pts: body(1, 0.96) }, { z: -0.5, pts: body(1, 0.99) }, { z: -1.5, pts: body(1, 1.0) }, { z: -1.9, pts: body(0.97, 0.98) },
    { z: -2.05, pts: body(0.86, 0.86) }, { z: -2.1, pts: body(0.55, 0.62) },
  ];
  // greenhouse (windscreen, side glass, hatch glass)
  const glassSec = (z, yBase, wBase, yRoof, wRoof) => ({ z, pts: [[0, yBase], [wBase, yBase], [wRoof, yRoof], [0, yRoof + 0.02]] });
  const GLASS_SECTIONS = [
    glassSec(0.62, 0.96, 0.8, 0.97, 0.79), glassSec(0.1, 0.98, 0.83, 1.3, 0.72), glassSec(-0.4, 0.99, 0.84, 1.38, 0.73),
    glassSec(-1.2, 1.0, 0.84, 1.36, 0.72), glassSec(-1.6, 1.0, 0.82, 1.14, 0.76), glassSec(-1.82, 0.99, 0.78, 1.0, 0.76),
  ];
  const ROOF_SECTIONS = [
    { z: 0.05, pts: [[0, 1.3], [0.66, 1.3], [0.7, 1.32], [0, 1.325]] }, { z: -0.4, pts: [[0, 1.38], [0.7, 1.38], [0.74, 1.4], [0, 1.405]] },
    { z: -1.2, pts: [[0, 1.36], [0.69, 1.36], [0.73, 1.38], [0, 1.385]] }, { z: -1.45, pts: [[0, 1.26], [0.64, 1.26], [0.68, 1.28], [0, 1.285]] },
  ];
  let bodyGeo = null, glassGeo = null, roofGeo = null;
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x141b26, roughness: 0.12, metalness: 0.35, envMapIntensity: 1.2 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.9 });
  const rimMat = new THREE.MeshStandardMaterial({ color: 0xc9ccd1, roughness: 0.35, metalness: 0.8 });
  const lampMat = new THREE.MeshStandardMaterial({ color: 0xe8e8e0, emissive: 0xfff4d6, emissiveIntensity: 0, roughness: 0.3 });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x7a1414, emissive: 0xff2a1a, emissiveIntensity: 0, roughness: 0.3 });
  let coneTex = null;
  function coneTexture() {
    if (coneTex) return coneTex;
    const c = document.createElement('canvas'); c.width = 128; c.height = 256;
    const cx = c.getContext('2d');
    const g = cx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, 'rgba(255,244,214,0.85)'); g.addColorStop(0.5, 'rgba(255,244,214,0.25)'); g.addColorStop(1, 'rgba(255,244,214,0)');
    cx.fillStyle = g; cx.beginPath(); cx.moveTo(44, 0); cx.lineTo(84, 0); cx.lineTo(128, 256); cx.lineTo(0, 256); cx.closePath(); cx.fill();
    coneTex = new THREE.CanvasTexture(c); coneTex.colorSpace = THREE.SRGBColorSpace;
    return coneTex;
  }
  function makeCar(color) {
    if (!bodyGeo) {
      bodyGeo = loft(BODY_SECTIONS, (h) => (h < 0.42 ? 0.32 : 1));          // dark sill / bumper band
      glassGeo = loft(GLASS_SECTIONS, null);
      roofGeo = loft(ROOF_SECTIONS, null);
    }
    const car = new THREE.Group();
    const paint = new THREE.MeshStandardMaterial({ color, roughness: 0.32, metalness: 0.45, vertexColors: true, envMapIntensity: 1.1 });
    const roofPaint = new THREE.MeshStandardMaterial({ color, roughness: 0.32, metalness: 0.45, envMapIntensity: 1.1 });
    car.add(new THREE.Mesh(bodyGeo, paint), new THREE.Mesh(glassGeo, glassMat), new THREE.Mesh(roofGeo, roofPaint));
    const tyre = new THREE.CylinderGeometry(0.33, 0.33, 0.24, 14).rotateZ(Math.PI / 2);
    const rim = new THREE.CylinderGeometry(0.2, 0.2, 0.25, 12).rotateZ(Math.PI / 2);
    for (const [x, z] of [[-0.75, 1.32], [0.75, 1.32], [-0.75, -1.3], [0.75, -1.3]]) {
      const w = new THREE.Mesh(tyre, darkMat); w.position.set(x, 0.33, z); car.add(w);
      const r = new THREE.Mesh(rim, rimMat); r.position.set(x, 0.33, z); car.add(r);
    }
    const hl = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.14, 0.08), lampMat);
    const hl2 = hl.clone(); hl.position.set(-0.52, 0.7, 2.06); hl2.position.set(0.52, 0.7, 2.06);
    const tl = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.12, 0.08), tailMat);
    const tl2 = tl.clone(); tl.position.set(-0.52, 0.72, -2.06); tl2.position.set(0.52, 0.72, -2.06);
    const grille = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.12, 0.05), darkMat); grille.position.set(0, 0.62, 2.1);
    const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.09, 0.07), paint);
    const mirror2 = mirror.clone(); mirror.position.set(-0.92, 1.04, 0.5); mirror2.position.set(0.92, 1.04, 0.5);
    car.add(hl, hl2, tl, tl2, grille, mirror, mirror2);
    const cone = new THREE.Mesh(new THREE.PlaneGeometry(4.5, 9).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: coneTexture(), transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
    cone.position.set(0, -0.42, 6.5); cone.rotation.y = Math.PI; cone.visible = false; cone.renderOrder = 3;
    car.add(cone);
    car.traverse((o) => { if (o.isMesh && o !== cone) { o.castShadow = true; o.receiveShadow = false; } });
    car.userData.cone = cone;
    return car;
  }

  function build() {
    const dashes = extractDashes(ctx.paintGeometries || []);
    const lines = chain(dashes);
    curves = lines.map((pts) => { const c = new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.3); c.arcLengthDivisions = Math.max(50, pts.length * 4); c.len = c.getLength(); return c; }).filter((c) => c.len > 25);
    const n = curves.length ? (ctx.count ?? (isTouch ? 4 : 7)) : 0;
    let seed = 20260909;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const byLen = curves.map((c, i) => i).sort((a, b) => curves[b].len - curves[a].len);
    for (let i = 0; i < n; i++) {
      const mesh = makeCar(CAR_COLORS[i % CAR_COLORS.length]);
      const ci = byLen[i % byLen.length];
      const car = { mesh, curve: ci, u: rnd() * 0.8, dir: rnd() < 0.5 ? 1 : -1, speed: 5.5 + rnd() * 2.5, rnd };
      cars.push(car); group.add(mesh);
      place(car);
    }
    return { dashes: dashes.length, lines: lines.length, curves: curves.length, metres: Math.round(curves.reduce((s, c) => s + c.len, 0)) };
  }
  const _p = new THREE.Vector3(), _t = new THREE.Vector3(), _l = new THREE.Vector3(), _look = new THREE.Vector3();
  function place(car) {
    const c = curves[car.curve];
    const u = car.dir > 0 ? car.u : 1 - car.u;
    c.getPointAt(u, _p); c.getTangentAt(u, _t);
    if (car.dir < 0) _t.negate();
    _l.crossVectors(UP, _t).normalize();                 // left of the heading
    _p.addScaledVector(_l, LANE);
    car.mesh.position.copy(_p).setY(0.15);
    _look.copy(_p).add(_t);
    car.mesh.lookAt(_look.x, 0.15, _look.z);
  }
  function nextCurve(car) {
    const c = curves[car.curve];
    const end = car.dir > 0 ? c.getPointAt(1) : c.getPointAt(0);
    const tan = c.getTangentAt(car.dir > 0 ? 1 : 0); if (car.dir < 0) tan.negate();
    const opts = [];
    curves.forEach((k, i) => {
      if (i === car.curve) return;
      for (const dir of [1, -1]) {
        const s = dir > 0 ? k.getPointAt(0) : k.getPointAt(1);
        const st = k.getTangentAt(dir > 0 ? 0 : 1); if (dir < 0) st.negate();
        const d = s.distanceTo(end);
        if (d < 30 && st.dot(tan) > -0.2) opts.push({ i, dir, d });
      }
    });
    if (opts.length) { const o = opts[Math.floor(car.rnd() * opts.length)]; car.curve = o.i; car.dir = o.dir; car.u = 0; return; }
    car.curve = Math.floor(car.rnd() * curves.length); car.dir = car.rnd() < 0.5 ? 1 : -1; car.u = 0;
  }
  function update(dt) {
    if (!cars.length) return;
    dt = Math.min(dt, 0.1);
    for (const car of cars) {
      const c = curves[car.curve];
      car.u += (car.speed * dt) / c.len;
      if (car.u >= 1) nextCurve(car);
      place(car);
    }
  }
  function setNight(on) {
    night = on;
    lampMat.emissiveIntensity = on ? 5 : 0;
    tailMat.emissiveIntensity = on ? 2.5 : 0;
    for (const car of cars) car.mesh.userData.cone.visible = on;
  }
  return { build, update, setNight, makeCar, get curves() { return curves; }, get cars() { return cars; }, get group() { return group; } };
}
