// A few slow cars driving on the subdivision roads. The road centrelines come from the dashed white centreline
// painted in the Blender model ("Pintura viaria" material): each dash is one small mesh island, the dashes are chained
// into polylines and turned into smooth curves. Cars keep to the LEFT of the centreline (Barbados drives on the left).
// The car body is a smooth lofted hatchback (cross sections along the length, shared vertices -> rounded shading).
import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';

const CAR_COLORS = [0x8f2a1e, 0xf2f2f2, 0x1f2a44, 0x8a8f96, 0x2b2b2b, 0xd8d8d8, 0x2d5d8f, 0xe0a94a, 0x4a6b3a, 0xc8b8a0];
const CAR_MODEL = 'assets/models/car.glb';   // the car chosen in the Blender file (decimated, materials consolidated by tools/... see README)
const LANE = 1.6;           // metres from the centreline to the middle of the lane
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
  // Douglas-Peucker on the XZ plane: straight runs collapse to their end points, bends keep their vertices
  function simplify(pts, tol) {
    if (pts.length < 3) return pts;
    const a = pts[0], b = pts[pts.length - 1];
    const dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz;
    let best = -1, bi = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const p = pts[i];
      let d;
      if (L2 === 0) d = Math.hypot(p.x - a.x, p.z - a.z);
      else { const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / L2)); d = Math.hypot(p.x - (a.x + t * dx), p.z - (a.z + t * dz)); }
      if (d > best) { best = d; bi = i; }
    }
    if (best <= tol) return [a, b];
    return simplify(pts.slice(0, bi + 1), tol).slice(0, -1).concat(simplify(pts.slice(bi), tol));
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
      if (seq.length >= 3) lines.push(simplify(seq.map((i) => new THREE.Vector3(dashes[i].x, 0.15, dashes[i].z)), 0.45));
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
  let template = null;   // { parts: [{ geo, mat, name }], box }
  async function loadTemplate() {
    if (!ctx.loadGLB) return null;
    try {
      const gltf = await ctx.loadGLB(CAR_MODEL);
      const root = gltf.scene; root.updateMatrixWorld(true);
      const byMat = new Map();
      root.traverse((o) => {
        if (!o.isMesh) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        const g = o.geometry.clone();
        for (const name of ['normal', 'position', 'uv']) { const a = g.attributes[name]; if (a && !(a.array instanceof Float32Array)) { const out = new Float32Array(a.count * a.itemSize); for (let i = 0; i < a.count; i++) for (let k = 0; k < a.itemSize; k++) out[i * a.itemSize + k] = a.getComponent(i, k); g.setAttribute(name, new THREE.BufferAttribute(out, a.itemSize)); } }
        g.applyMatrix4(o.matrixWorld);
        const groups = g.groups.length ? g.groups : [{ start: 0, count: g.index ? g.index.count : g.attributes.position.count, materialIndex: 0 }];
        for (const gr of groups) {
          const m = mats[gr.materialIndex] || mats[0];
          const key = (m.name || 'mat').replace(/^CAR_/, '');
          const part = new THREE.BufferGeometry();
          for (const [name, attr] of Object.entries(g.attributes)) part.setAttribute(name, attr);
          if (g.index) part.setIndex(g.index);
          part.setDrawRange(gr.start, gr.count);
          // bake the draw range into a standalone geometry
          const sub = part.toNonIndexed ? bakeRange(g, gr) : part;
          if (!byMat.has(key)) byMat.set(key, { geos: [], mat: m });
          byMat.get(key).geos.push(sub);
        }
      });
      const parts = [];
      for (const [name, e] of byMat) {
        const geo = e.geos.length === 1 ? e.geos[0] : BufferGeometryUtils.mergeGeometries(e.geos, false);
        if (!geo) continue;
        parts.push({ name, geo, mat: e.mat });
      }
      const box = new THREE.Box3();
      for (const pt of parts) { pt.geo.computeBoundingBox(); box.union(pt.geo.boundingBox); }
      return { parts, box };
    } catch (e) { console.warn('car model not available, using the built-in body', e); return null; }
  }
  // copies the triangles of one material group into its own non-indexed geometry
  function bakeRange(g, gr) {
    const idx = g.index, pos = g.attributes.position, nor = g.attributes.normal;
    const n = gr.count, P = new Float32Array(n * 3), N = nor ? new Float32Array(n * 3) : null;
    for (let i = 0; i < n; i++) {
      const vi = idx ? idx.getX(gr.start + i) : gr.start + i;
      P[i * 3] = pos.getX(vi); P[i * 3 + 1] = pos.getY(vi); P[i * 3 + 2] = pos.getZ(vi);
      if (N) { N[i * 3] = nor.getX(vi); N[i * 3 + 1] = nor.getY(vi); N[i * 3 + 2] = nor.getZ(vi); }
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(P, 3));
    if (N) out.setAttribute('normal', new THREE.BufferAttribute(N, 3)); else out.computeVertexNormals();
    return out;
  }
  const MODEL_MATS = {};   // shared materials of the model (glass, chrome, lights...), the paint is per car
  function modelMaterial(name, src) {
    if (MODEL_MATS[name]) return MODEL_MATS[name];
    let m;
    switch (name) {
      case 'Glass': m = new THREE.MeshPhysicalMaterial({ color: 0x1a2430, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.5, envMapIntensity: 1.3, depthWrite: false }); break;
      case 'Lights': m = lampMat; break;
      case 'TailLight': m = tailMat; break;
      case 'Chrome': m = new THREE.MeshStandardMaterial({ color: 0xd8d8d8, roughness: 0.15, metalness: 1.0, envMapIntensity: 1.2 }); break;
      case 'Rim': m = rimMat; break;
      case 'Tyre': m = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.92, metalness: 0 }); break;
      case 'Grey': m = new THREE.MeshStandardMaterial({ color: 0x3a3d40, roughness: 0.5, metalness: 0.2 }); break;
      case 'Black': m = darkMat; break;
      default: m = src ? src.clone() : darkMat;
    }
    MODEL_MATS[name] = m;
    return m;
  }
  function makeModelCar(color) {
    const car = new THREE.Group();
    const inner = new THREE.Group();
    inner.rotation.y = Math.PI / 2;            // Blender: length along X, front at -X  ->  site: front at +Z
    const paint = new THREE.MeshStandardMaterial({ color, roughness: 0.28, metalness: 0.55, envMapIntensity: 1.2 });
    for (const pt of template.parts) {
      const m = new THREE.Mesh(pt.geo, pt.name === 'Paint' ? paint : modelMaterial(pt.name, pt.mat));
      m.castShadow = pt.name !== 'Glass'; m.receiveShadow = false;
      if (pt.name === 'Glass') m.renderOrder = 2;
      inner.add(m);
    }
    inner.position.y = -template.box.min.y;    // wheels on the ground
    car.add(inner);
    const cone = new THREE.Mesh(new THREE.PlaneGeometry(4.5, 9).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: coneTexture(), transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
    cone.position.set(0, -0.42, 6.8); cone.rotation.y = Math.PI; cone.visible = false; cone.renderOrder = 3;
    car.add(cone);
    const pool = new THREE.Mesh(new THREE.PlaneGeometry(5.5, 7).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: poolTexture(), color: 0xffe6c0, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false }));
    pool.position.set(0, -0.4, 4.2); pool.visible = false; pool.renderOrder = 3;
    car.add(pool);
    car.userData.cone = cone; car.userData.pool = pool;
    return car;
  }
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x141b26, roughness: 0.12, metalness: 0.35, envMapIntensity: 1.2 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.9 });
  const rimMat = new THREE.MeshStandardMaterial({ color: 0xc9ccd1, roughness: 0.35, metalness: 0.8 });
  const lampMat = new THREE.MeshStandardMaterial({ color: 0xe8e8e0, emissive: 0xfff4d6, emissiveIntensity: 0, roughness: 0.3 });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x7a1414, emissive: 0xff2a1a, emissiveIntensity: 0, roughness: 0.3 });
  let poolTex = null;
  function poolTexture() {
    if (poolTex) return poolTex;
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const cx = c.getContext('2d'); const g = cx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,0.9)'); g.addColorStop(0.5, 'rgba(255,255,255,0.3)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    cx.fillStyle = g; cx.fillRect(0, 0, 128, 128);
    poolTex = new THREE.CanvasTexture(c); poolTex.colorSpace = THREE.SRGBColorSpace;
    return poolTex;
  }
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

  async function build() {
    template = await loadTemplate();
    const dashes = extractDashes(ctx.paintGeometries || []);
    const lines = chain(dashes);
    curves = lines.map((pts) => { const c = new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.3); c.arcLengthDivisions = Math.max(50, pts.length * 4); c.len = c.getLength(); return c; }).filter((c) => c.len > 25);
    for (const c of curves) c.lanes = { 1: laneProfile(c, 1), '-1': laneProfile(c, -1) };
    const n = curves.length ? (ctx.count ?? (isTouch ? 4 : 7)) : 0;
    let seed = 20260909;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const byLen = curves.map((c, i) => i).sort((a, b) => curves[b].len - curves[a].len);
    for (let i = 0; i < n; i++) {
      const mesh = template ? makeModelCar(CAR_COLORS[Math.floor(rnd() * CAR_COLORS.length)]) : makeCar(CAR_COLORS[i % CAR_COLORS.length]);
      const ci = byLen[i % byLen.length];
      const car = { mesh, curve: ci, u: rnd() * 0.8, dir: rnd() < 0.5 ? 1 : -1, speed: 5.5 + rnd() * 2.5, rnd };
      cars.push(car); group.add(mesh);
      place(car);
    }
    return { dashes: dashes.length, lines: lines.length, curves: curves.length, metres: Math.round(curves.reduce((s, c) => s + c.len, 0)), model: !!template, parts: template ? template.parts.map((p) => p.name) : [] };
  }
  // how far left of the centreline a 2 m wide car can sit at each point of a curve, for one driving direction;
  // sampled every 2 m, then a min-filter (+-6 m) and a moving average (+-10 m) so the offset changes gently
  function laneProfile(curve, dir) {
    const n = Math.max(2, Math.ceil(curve.len / 2) + 1), raw = new Float32Array(n);
    const P = new THREE.Vector3(), T = new THREE.Vector3(), Lf = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const u = i / (n - 1), uu = dir > 0 ? u : 1 - u;
      curve.getPointAt(uu, P); curve.getTangentAt(uu, T); if (dir < 0) T.negate();
      Lf.crossVectors(UP, T).normalize();
      let lane = LANE;
      if (ctx.pavedClass) {
        const ok = (d) => ctx.pavedClass(P.x + Lf.x * d, -(P.z + Lf.z * d)) >= 2;
        while (lane > 0.2 && !(ok(lane) && ok(lane + 0.6) && ok(lane + 1.15))) lane -= 0.1;
      }
      raw[i] = lane;
    }
    const mn = new Float32Array(n), out = new Float32Array(n);
    for (let i = 0; i < n; i++) { let v = raw[i]; for (let k = Math.max(0, i - 3); k <= Math.min(n - 1, i + 3); k++) v = Math.min(v, raw[k]); mn[i] = v; }
    for (let i = 0; i < n; i++) { let sum = 0, cnt = 0; for (let k = Math.max(0, i - 5); k <= Math.min(n - 1, i + 5); k++) { sum += mn[k]; cnt++; } out[i] = sum / cnt; }
    return out;
  }
  const laneAt = (curve, u, dir) => {
    const prof = curve.lanes ? curve.lanes[dir] : null;
    if (!prof) return LANE;
    const f = u * (prof.length - 1), i = Math.min(prof.length - 2, Math.floor(f)), k = f - i;
    return prof[i] * (1 - k) + prof[i + 1] * k;
  };
  const _p = new THREE.Vector3(), _t = new THREE.Vector3(), _l = new THREE.Vector3(), _look = new THREE.Vector3();
  function place(car) {
    const c = curves[car.curve];
    const u = car.dir > 0 ? car.u : 1 - car.u;
    c.getPointAt(u, _p); c.getTangentAt(u, _t);
    if (car.dir < 0) _t.negate();
    _l.crossVectors(UP, _t).normalize();                 // left of the heading
    const lane = laneAt(c, car.u, car.dir);          // precomputed, smooth along the road: no lateral stepping
    _p.addScaledVector(_l, lane);
    car.mesh.position.copy(_p).setY(0.15);
    _look.copy(_p).addScaledVector(_t, 6);
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
        if (d < 20 && st.dot(tan) > -0.2 && onAsphalt(end, s)) opts.push({ i, dir, d });
      }
    });
    if (opts.length) { const o = opts[Math.floor(car.rnd() * opts.length)]; car.curve = o.i; car.dir = o.dir; car.u = 0; return; }
    car.curve = Math.floor(car.rnd() * curves.length); car.dir = car.rnd() < 0.5 ? 1 : -1; car.u = 0;
  }
  // the straight hop between two curves must stay on the road (a corner cut would cross the sidewalk)
  function onAsphalt(a, b) {
    if (!ctx.pavedClass) return true;
    for (let k = 0.1; k < 1; k += 0.2) { const x = a.x + (b.x - a.x) * k, z = a.z + (b.z - a.z) * k; if (ctx.pavedClass(x, -z) < 2) return false; }
    return true;
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
    lampMat.emissiveIntensity = on ? 7 : 0;
    tailMat.emissiveIntensity = on ? 3 : 0;
    for (const car of cars) { car.mesh.userData.cone.visible = on; if (car.mesh.userData.pool) car.mesh.userData.pool.visible = on; }
  }
  return { build, update, setNight, makeCar, get curves() { return curves; }, get cars() { return cars; }, get group() { return group; } };
}
