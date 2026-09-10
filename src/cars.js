// A few slow cars driving on the subdivision roads. The road centrelines come from the dashed white centreline
// painted in the Blender model ("Pintura viaria" material): each dash is one small mesh island, the dashes are chained
// into polylines and turned into smooth curves. Cars keep to the LEFT of the centreline (Barbados drives on the left).
// Where the dashes stop (intersections, some bends, cul-de-sacs) a road graph joins the curves with paths found on the
// asphalt occupancy grid, so the cars turn at the corners instead of vanishing. The car is the Audi from the Blender
// file (assets/models/car.glb); a lofted hatchback is the fallback when the model cannot be loaded.
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
        if (best < 1.5 || best > 13) continue;
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
        if (t < 1.5 || t > 16 || lat > 1.2 + 0.22 * t) continue;
        const dot = Math.abs(e.dx * sx + e.dz * sz);
        if (dot < 0.72) continue;
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
    curves = lines.map((pts) => { const c = new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.3); c.arcLengthDivisions = Math.max(50, pts.length * 4); c.len = c.getLength(); return c; }).filter((c) => c.len > 12);
    const split = splitCurves(curves);
    curves = split.curves;
    for (const c of curves) c.lanes = { 1: laneProfile(c, 1), '-1': laneProfile(c, -1) };
    for (const [a, b] of split.joins) { blendLanes(curves[a].lanes[1], curves[b].lanes[1]); blendLanes(curves[b].lanes['-1'], curves[a].lanes['-1']); }
    report.cuts = split.cuts;
    const t0 = performance.now();
    buildGraph();
    report.graphMs = Math.round(performance.now() - t0);
    const n = nodes.some((N) => !N.dead) ? (ctx.count ?? (isTouch ? 4 : 7)) : 0;
    let seed = 20260909;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const live = nodes.filter((N) => !N.dead);
    const byLen = live.map((N, i) => i).sort((a, b) => curves[live[b].curve].len - curves[live[a].curve].len);
    for (let i = 0; i < n; i++) {
      const mesh = template ? makeModelCar(CAR_COLORS[Math.floor(rnd() * CAR_COLORS.length)]) : makeCar(CAR_COLORS[i % CAR_COLORS.length]);
      const car = { mesh, node: live[byLen[i % byLen.length]], u: rnd() * 0.8, link: null, s: 0, speed: 5.5 + rnd() * 2.5, rnd };
      cars.push(car); group.add(mesh);
      place(car);
    }
    if (ctx.debug) drawDebug();
    return { dashes: dashes.length, lines: lines.length, curves: curves.length, metres: Math.round(curves.reduce((s, c) => s + c.len, 0)), model: !!template, parts: template ? template.parts.map((p) => p.name) : [], ...report };
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

  // ------------------------------------------------------------------------------------------------------------
  // junctions. The dashes of a through street run past a T-junction without a break, so a side street would have
  // nowhere to join: every curve is split where another curve ends near it (heading into it) and where two curves
  // cross, which makes every junction a curve end for every street that meets there.
  // ------------------------------------------------------------------------------------------------------------
  function segX(p1, p2, p3, p4) {
    const d = (p2.x - p1.x) * (p4.z - p3.z) - (p2.z - p1.z) * (p4.x - p3.x); if (Math.abs(d) < 1e-9) return null;
    const t = ((p3.x - p1.x) * (p4.z - p3.z) - (p3.z - p1.z) * (p4.x - p3.x)) / d, u = ((p3.x - p1.x) * (p2.z - p1.z) - (p3.z - p1.z) * (p2.x - p1.x)) / d;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [t, u] : null;
  }
  function splitCurves(list) {
    const samples = list.map((c) => { const n = Math.max(2, Math.ceil(c.len / 2) + 1), pts = []; for (let i = 0; i < n; i++) pts.push(c.getPointAt(i / (n - 1))); return pts; });
    const spacing = list.map((c, i) => c.len / (samples[i].length - 1));
    const cuts = list.map(() => []);                                  // arc-length positions (m) where each curve is cut
    const ends = [];
    list.forEach((c, i) => {
      const s = samples[i];
      ends.push({ i, p: s[0], t: s[0].clone().sub(s[1]).normalize() });                                      // outward tangents
      ends.push({ i, p: s[s.length - 1], t: s[s.length - 1].clone().sub(s[s.length - 2]).normalize() });
    });
    for (const e of ends) list.forEach((c, j) => {
      if (j === e.i) return;
      const s = samples[j]; let best = 1e9, bi = -1;
      for (let k = 0; k < s.length; k++) { const d = s[k].distanceTo(e.p); if (d < best) { best = d; bi = k; } }
      if (best > 28) return;
      const v = s[bi].clone().sub(e.p).normalize();
      if (v.dot(e.t) < 0.5) return;                                   // the ending street does not head into this one
      cuts[j].push(bi * spacing[j]);
    });
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const A = samples[i], B = samples[j];
      for (let a = 1; a < A.length; a++) for (let b = 1; b < B.length; b++) {
        const r = segX(A[a - 1], A[a], B[b - 1], B[b]);
        if (r) { cuts[i].push((a - 1 + r[0]) * spacing[i]); cuts[j].push((b - 1 + r[1]) * spacing[j]); }
      }
    }
    const out = [], joins = [];
    let ncuts = 0;
    list.forEach((c, i) => {
      const cs = cuts[i].filter((s) => s > 8 && s < c.len - 8).sort((x, y) => x - y).filter((s, k, arr) => k === 0 || s - arr[k - 1] > 8);
      if (!cs.length) { out.push(c); return; }
      ncuts += cs.length;
      const bounds = [0, ...cs, c.len];
      for (let k = 1; k < bounds.length; k++) {
        const s0 = bounds[k - 1], s1 = bounds[k], n = Math.max(3, Math.ceil((s1 - s0) / 2) + 1), pts = [];
        for (let m = 0; m < n; m++) pts.push(c.getPointAt(Math.min(1, (s0 + (s1 - s0) * m / (n - 1)) / c.len)));
        const part = new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.3); part.arcLengthDivisions = Math.max(50, pts.length * 4); part.len = part.getLength();
        out.push(part);
        if (k > 1) joins.push([out.length - 2, out.length - 1]);
      }
    });
    return { curves: out, joins, cuts: ncuts };
  }
  // A ends where B starts (in travel order): make the lane offsets meet, so the car does not step sideways
  function blendLanes(A, B) {
    const m = (A[A.length - 1] + B[0]) / 2, k = 5, dA = m - A[A.length - 1], dB = m - B[0];
    for (let i = 0; i < k; i++) { const w = 1 - i / k; if (A.length - 1 - i >= 0) A[A.length - 1 - i] += dA * w; if (i < B.length) B[i] += dB * w; }
  }
  // the A* cell path zig-zags on the 1 m grid: moving average before the simplification
  function smoothCells(cells) {
    if (cells.length < 5) return cells;
    const out = [];
    for (let i = 0; i < cells.length; i++) { const p = new THREE.Vector3(); let n = 0; for (let k = Math.max(0, i - 2); k <= Math.min(cells.length - 1, i + 2); k++) { p.add(cells[k]); n++; } out.push(p.multiplyScalar(1 / n)); }
    return out;
  }

  // ------------------------------------------------------------------------------------------------------------
  // road graph. One node per (curve, driving direction). The dashes stop before every intersection (and are missing
  // on some bends and around the cul-de-sacs), so the nodes are joined by LINKS: a path found on the 1 m asphalt
  // occupancy grid (A*, keeping about 1.5-2 m from the curb like a car in its lane), corner-rounded, smoothed and
  // validated against the grid (centre and both sides of the car). Dead ends get a U-turn loop when the asphalt
  // allows it (cul-de-sac circles), otherwise the car drives out of the site and reappears elsewhere.
  // ------------------------------------------------------------------------------------------------------------
  const LINK_STEP = 0.5, MIN_CLEAR = 1.5;
  let nodes = [], field = null, report = {};
  const WIDE_CONCRETE = 2.5;   // concrete at least this far from grass (raised junctions, aprons) is drivable; sidewalks and driveways are not
  function clearanceField() {
    const g = ctx.pavedGrid; if (!g) return null;
    const { grid, w, h } = g, INF = 1e6;
    // two-pass chamfer distance (m) to the nearest cell outside the set
    const chamfer = (inside) => {
      const d = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) d[i] = inside(i) ? INF : 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x; if (d[i] === 0) continue;
        let v = d[i];
        if (x > 0) v = Math.min(v, d[i - 1] + 1);
        if (y > 0) { v = Math.min(v, d[i - w] + 1); if (x > 0) v = Math.min(v, d[i - w - 1] + 1.4142); if (x < w - 1) v = Math.min(v, d[i - w + 1] + 1.4142); }
        d[i] = v;
      }
      for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
        const i = y * w + x; if (d[i] === 0) continue;
        let v = d[i];
        if (x < w - 1) v = Math.min(v, d[i + 1] + 1);
        if (y < h - 1) { v = Math.min(v, d[i + w] + 1); if (x < w - 1) v = Math.min(v, d[i + w + 1] + 1.4142); if (x > 0) v = Math.min(v, d[i + w - 1] + 1.4142); }
        d[i] = v;
      }
      for (let i = 0; i < w * h; i++) if (d[i] > 999) d[i] = 6;
      return d;
    };
    const dAny = chamfer((i) => grid[i] >= 1);                       // distance to grass over every paved surface
    const drivable = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) drivable[i] = grid[i] >= 2 || (grid[i] === 1 && dAny[i] >= WIDE_CONCRETE) ? 1 : 0;
    const d = chamfer((i) => drivable[i] === 1);                     // distance to the nearest non-drivable cell
    return { d, grid, drivable, w, h, x0: g.x0, y0: g.y0 };
  }
  // straight line between two points that stays on the drivable surface (with margin)
  function clearSegment(A, B) {
    const n = Math.max(2, Math.ceil(A.distanceTo(B) / 0.5)), q = new THREE.Vector3();
    for (let k = 1; k < n; k++) { q.lerpVectors(A, B, k / n); if (clearAt(q) < MIN_CLEAR) return false; }
    return true;
  }
  // string pulling: replace the cell staircase by the longest straight runs that stay on the road
  function pullString(pts) {
    const out = [pts[0]]; let i = 0;
    while (i < pts.length - 1) {
      let j = pts.length - 1;
      for (; j > i + 1; j--) if (clearSegment(pts[i], pts[j])) break;
      out.push(pts[j]); i = j;
    }
    return out;
  }
  function makeHeap() {
    const a = [];
    return {
      size: () => a.length,
      push(n, f) { a.push([f, n]); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; const t = a[p]; a[p] = a[i]; a[i] = t; i = p; } },
      pop() { const top = a[0], last = a.pop(); if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r; if (m === i) break; const t = a[m]; a[m] = a[i]; a[i] = t; i = m; } } return top[1]; },
    };
  }
  let gS = null, par = null, stamp = null, closed = null, searchId = 0;
  const NB = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.4142], [1, -1, 1.4142], [-1, 1, 1.4142], [-1, -1, 1.4142]];
  function astar(ax, az, bx, bz, maxExp) {
    const f = field; if (!f) return null;
    const { d, w, h, x0, y0 } = f;
    const sx = Math.floor(ax - x0), sy = Math.floor(-az - y0), tx = Math.floor(bx - x0), ty = Math.floor(-bz - y0);
    const inb = (x, y) => x >= 0 && y >= 0 && x < w && y < h;
    if (!inb(sx, sy) || !inb(tx, ty)) return null;
    const s = sy * w + sx, t = ty * w + tx;
    if (d[s] <= 0 || d[t] <= 0) return null;
    if (!gS) { gS = new Float32Array(w * h); par = new Int32Array(w * h); stamp = new Int32Array(w * h); closed = new Int32Array(w * h); }
    searchId++;
    const open = makeHeap();
    gS[s] = 0; par[s] = -1; stamp[s] = searchId; open.push(s, Math.hypot(tx - sx, ty - sy));
    let exp = 0;
    while (open.size()) {
      const cur = open.pop();
      if (closed[cur] === searchId) continue;
      closed[cur] = searchId;
      if (cur === t) break;
      if (++exp > maxExp) return null;
      const cx = cur % w, cy = (cur - cx) / w;
      for (const [dx, dy, st] of NB) {
        const nx = cx + dx, ny = cy + dy; if (!inb(nx, ny)) continue;
        const ni = ny * w + nx; if (closed[ni] === searchId) continue;
        const cl = d[ni]; if (cl < MIN_CLEAR && ni !== t) continue;
        // sweet spot 1.5-2.2 m from the curb (the lane); the middle of the road and the open intersection cost a bit more
        const cost = st * (1 + Math.max(0, 1.5 - cl) + 0.2 * Math.max(0, cl - 2.2));
        const g = gS[cur] + cost;
        if (stamp[ni] !== searchId || g < gS[ni]) { stamp[ni] = searchId; gS[ni] = g; par[ni] = cur; open.push(ni, g + Math.hypot(tx - nx, ty - ny)); }
      }
    }
    if (closed[t] !== searchId) return null;
    const out = [];
    for (let i = t; i !== -1; i = par[i]) { const cx = i % w, cy = (i - cx) / w; out.push(new THREE.Vector3(cx + x0 + 0.5, 0.15, -(cy + y0 + 0.5))); }
    return out.reverse();
  }
  const clearAt = (q) => { const f = field; if (!f) return 9; const gx = Math.floor(q.x - f.x0), gy = Math.floor(-q.z - f.y0); if (gx < 0 || gy < 0 || gx >= f.w || gy >= f.h) return 0; return f.d[gy * f.w + gx]; };
  // point LEAD m beyond (sign 1) / before (sign -1) P along T, shortened while it falls off the road (bends, corners)
  function leadPoint(P, T, sign, max = LEAD) {
    for (const l of [max, 3, 2, 1, 0.5]) { if (l > max) continue; const q = P.clone().addScaledVector(T, sign * l); if (clearAt(q) >= MIN_CLEAR) return q; }
    return P.clone();
  }
  function pathValid(pts, side) {
    if (!field && !ctx.pavedClass) return true;
    const bad = (x, z) => (field ? clearAt({ x, z }) <= 0 : ctx.pavedClass(x, -z) < 2);
    const T = new THREE.Vector3(), L = new THREE.Vector3();
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[Math.min(pts.length - 1, i + 1)], o = pts[Math.max(0, i - 1)];
      T.subVectors(q, o).setY(0); if (T.lengthSq() < 1e-6) T.set(1, 0, 0); T.normalize(); L.crossVectors(UP, T);
      if (bad(p.x, p.z)) return false;
      // the first / last 1.5 m sit on the lane points (valid by construction); their arrival direction may differ from the road
      if (i >= 3 && i <= pts.length - 4 && (bad(p.x + L.x * side, p.z + L.z * side) || bad(p.x - L.x * side, p.z - L.z * side))) return false;
    }
    return true;
  }
  function roundCorners(pts, r) {
    if (r <= 0 || pts.length < 3) return pts.slice();
    const out = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      const a = pts[i - 1], b = pts[i], c = pts[i + 1];
      const u = b.clone().sub(a), v = c.clone().sub(b), lu = u.length(), lv = v.length();
      if (lu < 1e-6 || lv < 1e-6) continue;
      const ang = Math.acos(Math.max(-1, Math.min(1, u.dot(v) / (lu * lv))));
      if (ang < 0.12) { out.push(b); continue; }
      const dd = Math.min(r, lu * 0.45, lv * 0.45);
      out.push(b.clone().addScaledVector(u, -dd / lu), b.clone().addScaledVector(v, dd / lv));
    }
    out.push(pts[pts.length - 1]);
    return out;
  }
  function samplePath(raw, smooth) {
    const pts = [raw[0]];
    for (let i = 1; i < raw.length; i++) if (raw[i].distanceTo(pts[pts.length - 1]) > 0.3) pts.push(raw[i]);
    if (pts.length < 2) pts.push(raw[raw.length - 1].clone().add(new THREE.Vector3(0.01, 0, 0)));
    let curve;
    if (smooth) curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.5);
    else { curve = new THREE.CurvePath(); for (let i = 1; i < pts.length; i++) curve.add(new THREE.LineCurve3(pts[i - 1], pts[i])); }
    curve.arcLengthDivisions = Math.max(100, pts.length * 10);
    const len = curve.getLength(), n = Math.max(2, Math.ceil(len / LINK_STEP) + 1), out = [];
    for (let i = 0; i < n; i++) out.push(curve.getPointAt(i / (n - 1)).setY(0.15));
    return { pts: out, len, step: len / (n - 1) };
  }
  function finishLink(raw, from, to, kind, variants) {
    for (const [r, smooth] of variants) {
      const s = samplePath(roundCorners(raw, r), smooth);
      if (!pathValid(s.pts, 0.9)) continue;
      const st = Math.max(1, Math.round(4 / s.step)); let turn = 0;
      for (let i = 2 * st; i < s.pts.length; i += st) { const a = s.pts[i - st].clone().sub(s.pts[i - 2 * st]).normalize(), b = s.pts[i].clone().sub(s.pts[i - st]).normalize(); turn += Math.acos(Math.max(-1, Math.min(1, a.dot(b)))); }
      return { from, to, kind, pts: s.pts, len: s.len, step: s.step, turn, speed: turn > 0.6 ? 0.55 : turn > 0.25 ? 0.75 : 1 };
    }
    return null;
  }
  const LEAD = 4;
  const fail = (r) => { report.fail = report.fail || {}; report.fail[r] = (report.fail[r] || 0) + 1; return null; };
  function tryLink(E, S) {
    const P0 = E.end, T0 = E.et, P3 = S.start, T3 = S.st;
    const chord = P0.distanceTo(P3);
    if (chord < 2 && T0.dot(T3) > 0.8) return { from: E, to: S, kind: 'through', pts: [P0.clone(), P3.clone()], len: chord, step: Math.max(chord, 1e-3), turn: 0, speed: 1 };
    const lead = Math.min(LEAD, chord / 4);
    const a = leadPoint(P0, T0, 1, lead), b = leadPoint(P3, T3, -1, lead);
    const cells = astar(a.x, a.z, b.x, b.z, 3000 + 400 * chord); if (!cells) return fail('astar');
    let pts = [P0.clone(), a, ...cells.filter((p) => p.distanceTo(a) > 1.2 && p.distanceTo(b) > 1.2), b, P3.clone()];
    pts = simplify(pullString(pts.filter((p, i) => i === 0 || p.distanceTo(pts[i - 1]) > 0.3)), 0.5);
    for (let i = 1; i < pts.length - 1; i++) { const u = pts[i].clone().sub(pts[i - 1]).normalize(), v = pts[i + 1].clone().sub(pts[i]).normalize(); if (u.dot(v) < -0.2) return fail('reversal'); }
    let plen = 0; for (let i = 1; i < pts.length; i++) plen += pts[i].distanceTo(pts[i - 1]);
    if (plen > 1.8 * chord + 15) return fail('detour');        // a detour: another node is the natural continuation
    // a link that drives past the start of another node (same heading) skips that node: drop it
    const T = new THREE.Vector3(), Q = new THREE.Vector3();
    for (const N of nodes) {
      if (N === S || N === E || N === E.reverse) continue;
      for (let i = 1; i < pts.length; i++) {
        const A = pts[i - 1], B = pts[i]; T.subVectors(B, A); const l2 = T.lengthSq(); if (l2 < 1e-6) continue;
        const t = Math.max(0, Math.min(1, Q.subVectors(N.start, A).dot(T) / l2));
        Q.copy(A).addScaledVector(T, t);
        if (Q.distanceTo(N.start) < 3.5 && Q.distanceTo(P3) > 6 && T.normalize().dot(N.st) > 0.75) return fail('skip');
      }
    }
    return finishLink(pts, E, S, 'link', [[7, true], [4, true], [2, true], [0, true], [0, false]]) || fail('invalid');
  }
  function tryUturn(E) {
    // teardrop: straight run L1, half circle of radius R to the right, then an S-curve back into the opposite lane
    const P0 = E.end, T0 = E.et, S = E.reverse, P3 = S.start;
    const R = new THREE.Vector3().crossVectors(T0, UP).normalize();
    const lateral = P3.distanceTo(P0);
    for (const rad of [4.5, 6, 7.5, 9, 11, 13]) {
      const shift = 2 * rad - lateral;
      for (const L1 of [Math.max(4, 1.3 * shift), 1.3 * shift + 5, 1.3 * shift + 10, 1.3 * shift + 16]) {
        const pts = [P0.clone()];
        const A = P0.clone().addScaledVector(T0, L1), C = A.clone().addScaledVector(R, rad);
        for (let i = 0; i <= 12; i++) { const th = Math.PI * i / 12; pts.push(C.clone().addScaledVector(R, -Math.cos(th) * rad).addScaledVector(T0, Math.sin(th) * rad)); }
        const Qs = pts[pts.length - 1], back = Math.max(6, L1);
        const M1 = Qs.clone().addScaledVector(T0, -back * 0.5), M2 = P3.clone().addScaledVector(T0, back * 0.5);
        for (let i = 1; i <= 10; i++) { const t = i / 10, mt = 1 - t; pts.push(Qs.clone().multiplyScalar(mt * mt * mt).addScaledVector(M1, 3 * mt * mt * t).addScaledVector(M2, 3 * mt * t * t).addScaledVector(P3, t * t * t)); }
        const link = finishLink(pts, E, S, 'uturn', [[0, true], [0, false]]);
        if (link) return link;
      }
    }
    return null;
  }
  function exitLink(E) {
    const pts = [], n = 61;
    for (let i = 0; i < n; i++) pts.push(E.end.clone().addScaledVector(E.et, i * LINK_STEP).setY(0.15));
    return { from: E, to: null, kind: 'exit', pts, len: (n - 1) * LINK_STEP, step: LINK_STEP, turn: 0, speed: 1 };
  }
  function buildGraph() {
    field = clearanceField();
    nodes = [];
    curves.forEach((c, ci) => {
      const pair = [];
      for (const dir of [1, -1]) {
        const u0 = dir > 0 ? 0 : 1, u1 = 1 - u0;
        const st = c.getTangentAt(u0), et = c.getTangentAt(u1); if (dir < 0) { st.negate(); et.negate(); }
        const ls = new THREE.Vector3().crossVectors(UP, st).normalize(), le = new THREE.Vector3().crossVectors(UP, et).normalize();
        const start = c.getPointAt(u0).addScaledVector(ls, laneAt(c, 0, dir)).setY(0.15);
        const end = c.getPointAt(u1).addScaledVector(le, laneAt(c, 1, dir)).setY(0.15);
        const N = { id: nodes.length, curve: ci, dir, start, st, end, et, links: [], uturn: null, exit: null, reverse: null };
        nodes.push(N); pair.push(N);
      }
      pair[0].reverse = pair[1]; pair[1].reverse = pair[0];
    });
    let links = 0, uturns = 0, exits = 0, searches = 0;
    for (const E of nodes) {
      const cands = [];
      for (const S of nodes) {
        if (S === E.reverse) continue;
        const v = S.start.clone().sub(E.end), chord = v.length();
        if (chord > 220) continue;
        if (v.dot(E.et) < -3 || E.et.dot(S.st) < -0.5) continue;
        cands.push({ S, chord });
      }
      cands.sort((a, b) => a.chord - b.chord);
      let tries = 0;
      for (const { S, chord } of cands) {
        if (E.links.length >= 3 || (E.links.length && chord > 90) || tries >= 8) break;
        if (chord > 120 && E.links.length) break;
        tries++; searches++;
        const L = field ? tryLink(E, S) : null;
        if (L) { E.links.push(L); links++; }
      }
      if (!E.links.length) { E.uturn = field ? tryUturn(E) : null; if (E.uturn) uturns++; else { E.exit = exitLink(E); exits++; } }
    }
    // streets that lead nowhere (dead ends without room for a U-turn) are never entered: the cars stay on the
    // connected network instead of driving off the road or vanishing
    let changed = true;
    while (changed) {
      changed = false;
      for (const N of nodes) N.dead = !N.links.length && !N.uturn;
      for (const N of nodes) {
        const before = N.links.length;
        N.links = N.links.filter((L) => !L.to.dead);
        if (N.uturn && N.uturn.to.dead) N.uturn = null;
        if (N.links.length !== before) changed = true;
      }
    }
    for (const N of nodes) N.dead = !N.links.length && !N.uturn;
    Object.assign(report, { nodes: nodes.length, live: nodes.filter((N) => !N.dead).length, links: nodes.reduce((t, N) => t + N.links.length, 0), uturns, exits, searches });
  }
  function drawDebug() {
    const mk = (pts, color) => { const g = new THREE.BufferGeometry().setFromPoints(pts.map((p) => p.clone().setY(0.6))); const m = new THREE.Line(g, new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 })); m.renderOrder = 50; group.add(m); };
    for (const c of curves) mk(c.getSpacedPoints(Math.ceil(c.len / 2)), 0x2266ff);
    for (const N of nodes) { for (const L of N.links) mk(L.pts, 0x22cc44); if (N.uturn) mk(N.uturn.pts, 0xff44ff); if (N.dead) mk(curves[N.curve].getSpacedPoints(Math.ceil(curves[N.curve].len / 2)), 0xff3333); }
  }

  // ------------------------------------------------------------------------------------------------------------
  // driving
  // ------------------------------------------------------------------------------------------------------------
  const _p = new THREE.Vector3(), _t = new THREE.Vector3(), _l = new THREE.Vector3(), _look = new THREE.Vector3();
  function place(car) {
    if (car.link) { placeOnLink(car); return; }
    const N = car.node, c = curves[N.curve];
    const u = N.dir > 0 ? car.u : 1 - car.u;
    c.getPointAt(u, _p); c.getTangentAt(u, _t);
    if (N.dir < 0) _t.negate();
    _l.crossVectors(UP, _t).normalize();                 // left of the heading
    _p.addScaledVector(_l, laneAt(c, car.u, N.dir));     // precomputed, smooth along the road: no lateral stepping
    car.mesh.position.copy(_p).setY(0.15);
    _look.copy(_p).addScaledVector(_t, 6);
    car.mesh.lookAt(_look.x, 0.15, _look.z);
  }
  function placeOnLink(car) {
    const L = car.link, s = Math.max(0, Math.min(car.s, L.len)), n = L.pts.length;
    const f = s / L.step, i = Math.min(n - 2, Math.floor(f)), k = Math.min(1, Math.max(0, f - i));
    _p.lerpVectors(L.pts[i], L.pts[i + 1], k);
    const j = Math.min(n - 1, i + Math.round(4 / L.step));
    _look.copy(L.pts[j]);
    if (j === n - 1) _look.addScaledVector(L.to ? L.to.st : L.from.et, Math.max(0.5, 4 - (j - i) * L.step));
    car.mesh.position.copy(_p).setY(0.15);
    car.mesh.lookAt(_look.x, 0.15, _look.z);
  }
  function pickLink(car, N) {
    if (N.links.length) {
      const w = N.links.map((L) => (L.turn < 0.35 ? 1 : 0.7)), tot = w.reduce((s, x) => s + x, 0);
      let r = car.rnd() * tot;
      for (let i = 0; i < N.links.length; i++) { r -= w[i]; if (r <= 0) return N.links[i]; }
      return N.links[N.links.length - 1];
    }
    return N.uturn || N.exit;
  }
  function respawn(car) {
    const live = nodes.filter((N) => !N.dead);
    const N = live[Math.floor(car.rnd() * live.length)] || nodes[0];
    car.node = N; car.u = 0.02 + car.rnd() * 0.3; car.link = null; car.s = 0;
  }
  function update(dt) {
    if (!cars.length) return;
    dt = Math.min(dt, 0.1);
    for (const car of cars) {
      if (car.link) {
        const L = car.link;
        car.s += car.speed * L.speed * dt;
        if (car.s >= L.len) {
          if (!L.to) respawn(car);
          else { const c = curves[L.to.curve]; car.node = L.to; car.u = (car.s - L.len) / c.len; car.link = null; car.s = 0; }
        }
      } else {
        const c = curves[car.node.curve];
        car.u += (car.speed * dt) / c.len;
        if (car.u >= 1) {
          const L = pickLink(car, car.node); car.s = (car.u - 1) * c.len; car.u = 1;
          if (L.len <= 0.5 && L.to) { car.node = L.to; car.u = car.s / curves[L.to.curve].len; car.s = 0; }   // straight through a junction
          else car.link = L;
        }
      }
      place(car);
    }
  }
  function setNight(on) {
    night = on;
    lampMat.emissiveIntensity = on ? 7 : 0;
    tailMat.emissiveIntensity = on ? 3 : 0;
    for (const car of cars) { car.mesh.userData.cone.visible = on; if (car.mesh.userData.pool) car.mesh.userData.pool.visible = on; }
  }
  return { build, update, setNight, makeCar, get curves() { return curves; }, get nodes() { return nodes; }, get cars() { return cars; }, get group() { return group; }, get debug() { return { tryLink, tryUturn, astar, pathValid, finishLink, roundCorners, samplePath, simplify, field, report }; } };
}
