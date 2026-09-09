// Night mode: procedural night sky + moon, moonlight through the cascaded shadow light, streetlights placed lot by
// lot along the street fronts (never in front of a driveway), warm light pools on the pavement, a handful of real
// point lights near the camera, and lit windows in about 45% of the houses.
import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';

const DAY = { exposure: 0.95, hemi: [0xcfe3ff, 0x6f7f52, 0.2], sun: 2.6, sunColor: 0xffffff, env: 0.85, fog: [4000, 26000], sea: 0x2f6d93, sat: 0xffffff, tree: 0xd6d6d6, lens: 0 };
const NIGHT = { exposure: 1.0, hemi: [0x22304a, 0x0a0c10, 0.35], sun: 0.32, sunColor: 0xb9c8ff, env: 0.55, fog: [1200, 14000], fogColor: 0x070a12, sea: 0x0a1526, sat: 0x5a6274, tree: 0x2b3240, lens: 6 };
const LAMP = { height: 5.6, arm: 1.3, spacing: 26, poolRadius: 10, pointIntensity: 90, pointDistance: 34, color: 0xffd28f, window: 0xffd9a5, litShare: 0.45 };
const MOON_DIR = new THREE.Vector3(0.55, 0.62, -0.45).normalize();

export function createNight(ctx) {
  // ctx: scene, renderer, camera, controls, getCsm, hemi, treeGroup, worldGround, satMeshes, HORIZON, pmrem, isTouch,
  //      lots, lotByHouse, pavedClass, models (hi prims per model), rebuildInstances
  const { scene, renderer, controls, hemi, treeGroup, worldGround, satMeshes, HORIZON, pmrem, isTouch } = ctx;
  const S = { on: false, lamps: [], poles: null, lenses: null, pools: null, points: [], windows: {}, sky: null, env: null, stars: null, moon: null, daySky: null, dayEnv: null, lastTarget: new THREE.Vector3(Infinity, 0, 0) };

  // ------------------------------------------------------------------------------------------------------------
  // Sky: low-res gradient equirect (background + environment, with a bright blob for the moon reflections),
  // a crisp starfield (points, no attenuation) and a moon sprite far away.
  // ------------------------------------------------------------------------------------------------------------
  function buildSky() {
    const w = 256, h = 128, data = new Float32Array(w * h * 4);
    const zen = [0.010, 0.014, 0.036], hor = [0.055, 0.068, 0.105];
    for (let y = 0; y < h; y++) {
      const v = 1 - (y + 0.5) / h, el = (v - 0.5) * Math.PI;        // elevation (-pi/2 .. pi/2)
      for (let x = 0; x < w; x++) {
        const u = (x + 0.5) / w, az = (u - 0.5) * 2 * Math.PI;
        const dir = new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az));
        const k = Math.pow(Math.max(0, 1 - Math.max(el, 0) / (Math.PI / 2)), 2.2);
        let r = zen[0] + (hor[0] - zen[0]) * k, g = zen[1] + (hor[1] - zen[1]) * k, b = zen[2] + (hor[2] - zen[2]) * k;
        if (el < 0) { r *= 0.35; g *= 0.35; b *= 0.35; }                       // below the horizon (sea / ground)
        const m = Math.max(0, dir.dot(MOON_DIR));
        const halo = Math.pow(m, 60) * 0.9 + Math.pow(m, 400) * 6;           // soft halo + bright core
        r += halo * 0.75; g += halo * 0.8; b += halo * 1.0;
        const i = (y * w + x) * 4; data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 1;
      }
    }
    const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
    tex.mapping = THREE.EquirectangularReflectionMapping; tex.colorSpace = THREE.LinearSRGBColorSpace;
    tex.minFilter = tex.magFilter = THREE.LinearFilter; tex.needsUpdate = true;
    S.sky = tex;
    S.env = pmrem.fromEquirectangular(tex).texture;

    // stars
    const n = isTouch ? 900 : 2200, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let i = 0; i < n; i++) {
      const el = Math.asin(rnd() * 0.97 + 0.03), az = rnd() * Math.PI * 2, R = 30000;
      pos[i * 3] = Math.cos(el) * Math.cos(az) * R; pos[i * 3 + 1] = Math.sin(el) * R; pos[i * 3 + 2] = Math.cos(el) * Math.sin(az) * R;
      const br = 0.35 + Math.pow(rnd(), 3) * 0.9, warm = rnd() < 0.3;
      col[i * 3] = br * (warm ? 1 : 0.85); col[i * 3 + 1] = br * 0.9; col[i * 3 + 2] = br * (warm ? 0.8 : 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    S.stars = new THREE.Points(g, new THREE.PointsMaterial({ size: isTouch ? 2.2 : 1.8, sizeAttenuation: false, vertexColors: true, fog: false, transparent: true, opacity: 0.9, depthWrite: false }));
    S.stars.frustumCulled = false; S.stars.visible = false; S.stars.renderOrder = -20;
    scene.add(S.stars);

    // moon: a soft disc sprite far away
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const cx = c.getContext('2d');
    const grd = cx.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, 'rgba(255,250,235,1)'); grd.addColorStop(0.42, 'rgba(255,248,230,1)'); grd.addColorStop(0.5, 'rgba(240,238,225,0.55)'); grd.addColorStop(1, 'rgba(200,210,240,0)');
    cx.fillStyle = grd; cx.fillRect(0, 0, 128, 128);
    const mt = new THREE.CanvasTexture(c); mt.colorSpace = THREE.SRGBColorSpace;
    S.moon = new THREE.Sprite(new THREE.SpriteMaterial({ map: mt, fog: false, depthWrite: false, transparent: true }));
    S.moon.position.copy(MOON_DIR).multiplyScalar(24000); S.moon.scale.set(900, 900, 1); S.moon.visible = false; S.moon.renderOrder = -19;
    scene.add(S.moon);
  }

  // ------------------------------------------------------------------------------------------------------------
  // Streetlight placement: every street-front edge of every lot gives candidate positions at its two corners
  // (shared with the neighbour), pushed 1 m onto the pavement. Corners in front of a driveway (concrete access
  // inside the lot) are moved along the edge past the driveway. Same-side lamps keep >= LAMP.spacing metres.
  // ------------------------------------------------------------------------------------------------------------
  function placeLamps() {
    const cands = new Map();
    for (const l of ctx.lots) {
      if (l.hidden || l.poly.length < 3 || l.area_m2 < 60) continue;
      const poly = l.poly;
      const cx = poly.reduce((s, p) => s + p[0], 0) / poly.length, cy = poly.reduce((s, p) => s + p[1], 0) / poly.length;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
        if (len < 6) continue;
        let nx = -dy / len, ny = dx / len;
        const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        if ((mx - cx) * nx + (my - cy) * ny < 0) { nx = -nx; ny = -ny; }        // outward
        const n = Math.max(3, Math.round(len / 2));
        let road = 0;
        for (let k = 0; k <= n; k++) {
          const t = k / n, x = a[0] + dx * t, y = a[1] + dy * t;
          for (const off of [2, 3.5, 5, 6.5, 8]) if (ctx.pavedClass(x + nx * off, y + ny * off) >= 2) { road++; break; }
        }
        if (road < (n + 1) * 0.6) continue;                                        // not a street front
        // driveway = concrete (class 1) just inside the lot along this edge
        const drive = []; let cur = null; const m = n * 2;
        for (let k = 0; k <= m; k++) {
          const t = k / m, x = a[0] + dx * t, y = a[1] + dy * t;
          const inside = ctx.pavedClass(x - nx * 1.5, y - ny * 1.5) === 1 || ctx.pavedClass(x - nx * 3, y - ny * 3) === 1;
          if (inside) { if (!cur) cur = [t, t]; else cur[1] = t; } else if (cur) { drive.push(cur); cur = null; }
        }
        if (cur) drive.push(cur);
        const clear = (t) => drive.every(([t0, t1]) => t < t0 - 3.5 / len || t > t1 + 3.5 / len);
        for (const end of [0, 1]) {
          let t = end === 0 ? 0.6 / len : 1 - 0.6 / len;
          if (!clear(t)) {
            const dir = end === 0 ? 1 : -1; let found = false;
            for (let s = 0; s <= len / 2; s += 0.5) { const tt = t + dir * s / len; if (tt < 0 || tt > 1) break; if (clear(tt)) { t = tt; found = true; break; } }
            if (!found) continue;
          }
          const x = a[0] + dx * t + nx * 1.0, y = a[1] + dy * t + ny * 1.0;
          if (ctx.pavedClass(x, y) >= 2) continue;                                 // would stand on the asphalt
          const key = `${Math.round(x / 1.5)},${Math.round(y / 1.5)}`;             // shared corners of neighbours -> one lamp
          if (!cands.has(key)) cands.set(key, { x, y, nx, ny });
        }
      }
    }
    const list = [...cands.values()].sort((p, q) => p.y - q.y || p.x - q.x);
    const lamps = [];
    for (const c of list) {
      let ok = true;
      for (const l of lamps) if ((l.nx * c.nx + l.ny * c.ny) > 0.5 && Math.hypot(l.x - c.x, l.y - c.y) < LAMP.spacing) { ok = false; break; }
      if (ok) lamps.push(c);
    }
    return lamps;
  }

  function buildLamps() {
    S.lamps = placeLamps();
    const n = S.lamps.length;
    // pole + arm + head in one geometry (local +Z points to the road)
    const pole = new THREE.CylinderGeometry(0.055, 0.09, LAMP.height, 8).translate(0, LAMP.height / 2, 0);
    const arm = new THREE.BoxGeometry(0.08, 0.08, LAMP.arm).translate(0, LAMP.height - 0.05, LAMP.arm / 2);
    const head = new THREE.BoxGeometry(0.3, 0.14, 0.62).translate(0, LAMP.height - 0.1, LAMP.arm - 0.05);
    const body = BufferGeometryUtils.mergeGeometries([pole, arm, head].map((g) => g.toNonIndexed()), false);
    const lens = new THREE.BoxGeometry(0.24, 0.025, 0.5).translate(0, LAMP.height - 0.18, LAMP.arm - 0.05);
    S.poles = new THREE.InstancedMesh(body, new THREE.MeshStandardMaterial({ color: 0x5c6066, roughness: 0.6, metalness: 0.6 }), Math.max(n, 1));
    S.lenses = new THREE.InstancedMesh(lens, new THREE.MeshStandardMaterial({ color: 0x33322e, roughness: 0.5, emissive: new THREE.Color(LAMP.color), emissiveIntensity: 0 }), Math.max(n, 1));
    // light pools: additive radial gradient on the pavement
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const cx = c.getContext('2d');
    const grd = cx.createRadialGradient(128, 128, 0, 128, 128, 128);
    grd.addColorStop(0, 'rgba(255,255,255,0.9)'); grd.addColorStop(0.25, 'rgba(255,255,255,0.45)'); grd.addColorStop(0.6, 'rgba(255,255,255,0.12)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
    cx.fillStyle = grd; cx.fillRect(0, 0, 256, 256);
    const pt = new THREE.CanvasTexture(c); pt.colorSpace = THREE.SRGBColorSpace;
    const poolGeo = new THREE.PlaneGeometry(LAMP.poolRadius * 2, LAMP.poolRadius * 2).rotateX(-Math.PI / 2);
    S.pools = new THREE.InstancedMesh(poolGeo, new THREE.MeshBasicMaterial({ map: pt, color: new THREE.Color(LAMP.color), transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, fog: true }), Math.max(n, 1));
    S.pools.renderOrder = 3; S.pools.visible = false;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), p = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
    S.lamps.forEach((l, i) => {
      const yaw = Math.atan2(l.nx, -l.ny);                                          // local +Z -> outward (three: x = X, z = -Y)
      q.setFromAxisAngle(up, yaw);
      p.set(l.x, 0.12, -l.y);
      m.compose(p, q, one);
      S.poles.setMatrixAt(i, m); S.lenses.setMatrixAt(i, m);
      l.head = new THREE.Vector3(l.x + l.nx * (LAMP.arm - 0.05), LAMP.height - 0.2, -(l.y + l.ny * (LAMP.arm - 0.05)));
      p.set(l.head.x, 0.2, l.head.z); q.identity(); m.compose(p, q, one);
      S.pools.setMatrixAt(i, m);
    });
    S.poles.count = S.lenses.count = S.pools.count = n;
    S.poles.castShadow = true; S.poles.receiveShadow = true;
    S.poles.frustumCulled = S.lenses.frustumCulled = S.pools.frustumCulled = false;
    scene.add(S.poles, S.lenses, S.pools);
    // real lights: a few, re-assigned to the lamps nearest to the camera target
    const np = isTouch ? 4 : 8;
    for (let i = 0; i < np; i++) {
      const pl = new THREE.PointLight(LAMP.color, 0, LAMP.pointDistance, 2);
      pl.position.set(0, -100, 0);
      scene.add(pl); S.points.push(pl);
    }
  }

  // ------------------------------------------------------------------------------------------------------------
  // Lit windows: one instanced copy of each model's glass primitive with a warm unlit material
  // ------------------------------------------------------------------------------------------------------------
  function buildWindows() {
    for (const [idx, m] of Object.entries(ctx.models)) {
      const glass = m.hi.find((e) => /glass|vidro/i.test(e.im.material?.name || ''));
      if (!glass) continue;
      const im = new THREE.InstancedMesh(glass.im.geometry, new THREE.MeshBasicMaterial({ color: LAMP.window, toneMapped: true }), Math.max(m.houses.length, 1));
      im.count = 0; im.frustumCulled = false; im.renderOrder = 1;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      scene.add(im);
      S.windows[idx] = im;
    }
  }
  const isLit = (h) => {
    if (h.lit === undefined) { let x = 0; for (const ch of (h.pid || h.id)) x = (x * 31 + ch.charCodeAt(0)) & 0xffff; h.lit = (x % 100) / 100 < LAMP.litShare; }
    return h.lit;
  };
  function setWindows(modelIdx, near) {
    const im = S.windows[modelIdx];
    if (!im) return;
    if (!S.on) { im.count = 0; return; }
    let k = 0;
    for (const h of near) if (isLit(h)) im.setMatrixAt(k++, h.matrix);
    im.count = k;
    im.instanceMatrix.needsUpdate = true;
  }

  // ------------------------------------------------------------------------------------------------------------
  function apply(on) {
    S.on = on;
    const P = on ? NIGHT : DAY;
    const csm = ctx.getCsm();
    if (!S.daySky) { S.daySky = scene.background; S.dayEnv = scene.environment; }
    scene.background = on ? S.sky : S.daySky;
    scene.environment = on ? S.env : S.dayEnv;
    scene.environmentIntensity = P.env;
    renderer.toneMappingExposure = P.exposure;
    hemi.color.set(P.hemi[0]); hemi.groundColor.set(P.hemi[1]); hemi.intensity = P.hemi[2];
    if (csm) {
      csm.lightDirection.copy(on ? MOON_DIR.clone().negate() : ctx.sunDir.clone().negate()).normalize();
      csm.lightIntensity = P.sun;
      for (const l of csm.lights) { l.intensity = P.sun; l.color.set(P.sunColor); }
    }
    scene.fog.color.set(on ? P.fogColor : HORIZON); scene.fog.near = P.fog[0]; scene.fog.far = P.fog[1];
    worldGround.material.color.set(P.sea);
    for (const sm of satMeshes) sm.material.color.set(P.sat);
    treeGroup.traverse((o) => { if (o.material?.isMeshBasicMaterial) o.material.color.set(P.tree); });
    S.lenses.material.emissiveIntensity = P.lens;
    S.pools.visible = on; S.stars.visible = on; S.moon.visible = on;
    for (const pl of S.points) pl.intensity = on ? LAMP.pointIntensity : 0;
    S.lastTarget.set(Infinity, 0, 0);
    ctx.rebuildInstances(true);
  }
  // point lights follow the camera target: the nearest lamps get the real lights
  const _tmp = new THREE.Vector3();
  function update() {
    if (!S.on || !S.points.length || !S.lamps.length) return;
    if (controls.target.distanceToSquared(S.lastTarget) < 4) return;
    S.lastTarget.copy(controls.target);
    const tx = controls.target.x, tz = controls.target.z;
    const near = S.lamps.map((l) => ({ l, d: (l.x - tx) * (l.x - tx) + (l.y + tz) * (l.y + tz) })).sort((a, b) => a.d - b.d).slice(0, S.points.length);
    S.points.forEach((pl, i) => { const e = near[i]; if (e) pl.position.copy(e.l.head).setY(LAMP.height - 0.35); else pl.position.set(0, -100, 0); });
  }

  function build() { buildSky(); buildLamps(); buildWindows(); }
  return { build, apply, update, setWindows, isLit, get lamps() { return S.lamps; }, get on() { return S.on; }, get objects() { return S; } };
}
