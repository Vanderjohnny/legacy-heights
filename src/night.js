// Time of day: one continuous parameter t (0 = midday, 0.5 = dusk, 1 = night) drives the global lighting of the
// world and of the houses: sun -> low orange sun -> moon (the cascaded shadow light), sky dome (day HDRI -> dusk
// glow -> night gradient with moon and stars), image-based light, fog, exposure, tints of the far imagery and of the
// tree cards. After dusk the streetlights come on (poles placed lot by lot along the street fronts, never in front
// of a driveway), warm pools on the pavement, a few real point lights near the camera, and about 45 % of the houses
// show lit windows.
import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';

const LAMP = { height: 5.6, arm: 1.3, spacing: 26, poolRadius: 9, pointIntensity: 70, pointDistance: 32, color: 0xffd28f, window: 0xffd9a5, litShare: 0.45 };
const MOON_DIR = new THREE.Vector3(0.55, 0.62, -0.45).normalize();
const C = (hex) => new THREE.Color(hex);
const COL = {
  sunDay: C(0xffffff), sunDusk: C(0xffa060), moon: C(0xb9c8ff),
  hemiSkyDay: C(0xcfe3ff), hemiSkyDusk: C(0xffb080), hemiSkyNight: C(0x2a3a5c), hemiGroundDay: C(0x6f7f52), hemiGroundNight: C(0x0d1016),
  fogDusk: C(0xc9957c), fogNight: C(0x0a0e18), seaDay: C(0x2f6d93), seaNight: C(0x0d1a2c), satDay: C(0xffffff), satNight: C(0x6a7488), treeDay: C(0xd6d6d6), treeNight: C(0x39414f),
};
const smooth = (a, b, x) => { const k = Math.min(1, Math.max(0, (x - a) / (b - a))); return k * k * (3 - 2 * k); };
const lerp = (a, b, k) => a + (b - a) * k;

export function createNight(ctx) {
  // ctx: scene, renderer, camera, controls, getCsm, hemi, treeGroup, worldGround, satMeshes, HORIZON, pmrem, isTouch,
  //      lots, lotByHouse, pavedClass, models (hi prims per model), rebuildInstances, sunDir, onTime(t)
  const { scene, renderer, camera, controls, hemi, treeGroup, worldGround, satMeshes, HORIZON, pmrem, isTouch } = ctx;
  const S = { t: 0, anim: null, lamps: [], poles: null, lenses: null, pools: null, points: [], windows: {}, nightEnv: null, dayEnv: null, dayBg: null, dome: null, stars: null, moon: null, lastTarget: new THREE.Vector3(Infinity, 0, 0) };
  const SUN_LOW = new THREE.Vector3();
  const _dir = new THREE.Vector3(), _c1 = new THREE.Color(), _c2 = new THREE.Color();

  // ------------------------------------------------------------------------------------------------------------
  // Sky dome: the day HDRI, a dusk glow around the setting sun and a night gradient with the moon halo, mixed by t.
  // Rendered on a sphere that follows the camera (replaces scene.background). Stars are crisp points, the moon a sprite.
  // ------------------------------------------------------------------------------------------------------------
  function buildSky() {
    S.dayBg = scene.background; S.dayEnv = scene.environment;
    const dayMap = S.dayBg && S.dayBg.isTexture ? S.dayBg : null;
    const mat = new THREE.ShaderMaterial({
      uniforms: { dayMap: { value: dayMap }, dayInt: { value: 1 }, dusk: { value: 0 }, nightK: { value: 0 }, sunDir: { value: new THREE.Vector3(0, 1, 0) }, moonDir: { value: MOON_DIR.clone() } },
      vertexShader: `varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position.z = gl_Position.w; }`,
      fragmentShader: `#include <common>
        uniform sampler2D dayMap; uniform float dayInt, dusk, nightK; uniform vec3 sunDir, moonDir; varying vec3 vDir;
        void main() {
          vec3 dir = normalize(vDir);
          vec3 day = ${dayMap ? 'texture2D(dayMap, equirectUv(dir)).rgb' : 'mix(vec3(0.5, 0.65, 0.9), vec3(0.85, 0.9, 1.0), pow(max(1.0 - dir.y, 0.0), 3.0))'} * dayInt;
          float sd = max(dot(dir, sunDir), 0.0);
          float hz = pow(max(1.0 - abs(dir.y), 0.0), 6.0);
          vec3 glow = vec3(1.0, 0.42, 0.16) * pow(sd, 8.0) * 1.4 + vec3(0.95, 0.55, 0.35) * hz * 0.45 + vec3(0.35, 0.22, 0.35) * pow(max(1.0 - dir.y, 0.0), 2.0) * 0.12;
          float k = pow(clamp(1.0 - max(dir.y, 0.0), 0.0, 1.0), 2.2);
          vec3 night = mix(vec3(0.010, 0.014, 0.036), vec3(0.055, 0.068, 0.105), k);
          if (dir.y < 0.0) night *= 0.35;
          float m = max(dot(dir, moonDir), 0.0);
          night += (pow(m, 60.0) * 0.9 + pow(m, 400.0) * 6.0) * vec3(0.75, 0.8, 1.0);
          vec3 col = mix(day + glow * dusk, night, nightK);
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
    });
    S.dome = new THREE.Mesh(new THREE.SphereGeometry(40000, 48, 24), mat);
    S.dome.frustumCulled = false; S.dome.renderOrder = -30;
    scene.add(S.dome);
    scene.background = null;
    // low-res night sky for the image-based light (reflections, ambient)
    const w = 128, h = 64, data = new Float32Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const el = (1 - (y + 0.5) / h - 0.5) * Math.PI, az = ((x + 0.5) / w - 0.5) * 2 * Math.PI;
      _dir.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az));
      const k = Math.pow(Math.max(0, 1 - Math.max(el, 0) / (Math.PI / 2)), 2.2);
      let r = 0.010 + (0.055 - 0.010) * k, g = 0.014 + (0.068 - 0.014) * k, b = 0.036 + (0.105 - 0.036) * k;
      if (el < 0) { r *= 0.35; g *= 0.35; b *= 0.35; }
      const m = Math.max(0, _dir.dot(MOON_DIR)), halo = Math.pow(m, 60) * 0.9 + Math.pow(m, 400) * 6;
      const i = (y * w + x) * 4; data[i] = r + halo * 0.75; data[i + 1] = g + halo * 0.8; data[i + 2] = b + halo; data[i + 3] = 1;
    }
    const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
    tex.mapping = THREE.EquirectangularReflectionMapping; tex.colorSpace = THREE.LinearSRGBColorSpace; tex.needsUpdate = true;
    S.nightEnv = pmrem.fromEquirectangular(tex).texture;
    tex.dispose();

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
    S.stars = new THREE.Points(g, new THREE.PointsMaterial({ size: isTouch ? 2.2 : 1.8, sizeAttenuation: false, vertexColors: true, fog: false, transparent: true, opacity: 0, depthWrite: false, depthTest: false }));
    S.stars.frustumCulled = false; S.stars.visible = false; S.stars.renderOrder = -29;
    scene.add(S.stars);

    // moon sprite far away
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const cx = c.getContext('2d');
    const grd = cx.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, 'rgba(255,250,235,1)'); grd.addColorStop(0.42, 'rgba(255,248,230,1)'); grd.addColorStop(0.5, 'rgba(240,238,225,0.55)'); grd.addColorStop(1, 'rgba(200,210,240,0)');
    cx.fillStyle = grd; cx.fillRect(0, 0, 128, 128);
    const mt = new THREE.CanvasTexture(c); mt.colorSpace = THREE.SRGBColorSpace;
    S.moon = new THREE.Sprite(new THREE.SpriteMaterial({ map: mt, fog: false, depthWrite: false, depthTest: false, transparent: true, opacity: 0 }));
    S.moon.scale.set(900, 900, 1); S.moon.visible = false; S.moon.renderOrder = -28;
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
      if (l.park || l.poly.length < 3 || l.area_m2 < 60) continue;
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
          const key = `${Math.round(x / 1.5)},${Math.round(y / 1.5)}`;
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
    const pole = new THREE.CylinderGeometry(0.055, 0.09, LAMP.height, 8).translate(0, LAMP.height / 2, 0);
    const arm = new THREE.BoxGeometry(0.08, 0.08, LAMP.arm).translate(0, LAMP.height - 0.05, LAMP.arm / 2);
    const head = new THREE.BoxGeometry(0.3, 0.14, 0.62).translate(0, LAMP.height - 0.1, LAMP.arm - 0.05);
    const body = BufferGeometryUtils.mergeGeometries([pole, arm, head].map((g) => g.toNonIndexed()), false);
    const lens = new THREE.BoxGeometry(0.24, 0.025, 0.5).translate(0, LAMP.height - 0.18, LAMP.arm - 0.05);
    S.poles = new THREE.InstancedMesh(body, new THREE.MeshStandardMaterial({ color: 0x5c6066, roughness: 0.6, metalness: 0.6 }), Math.max(n, 1));
    S.lenses = new THREE.InstancedMesh(lens, new THREE.MeshStandardMaterial({ color: 0x33322e, roughness: 0.5, emissive: new THREE.Color(LAMP.color), emissiveIntensity: 0 }), Math.max(n, 1));
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const cx = c.getContext('2d');
    const grd = cx.createRadialGradient(128, 128, 0, 128, 128, 128);
    grd.addColorStop(0, 'rgba(255,255,255,0.8)'); grd.addColorStop(0.3, 'rgba(255,255,255,0.4)'); grd.addColorStop(0.65, 'rgba(255,255,255,0.1)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
    cx.fillStyle = grd; cx.fillRect(0, 0, 256, 256);
    const pt = new THREE.CanvasTexture(c); pt.colorSpace = THREE.SRGBColorSpace;
    const poolGeo = new THREE.PlaneGeometry(LAMP.poolRadius * 2, LAMP.poolRadius * 2).rotateX(-Math.PI / 2);
    S.pools = new THREE.InstancedMesh(poolGeo, new THREE.MeshBasicMaterial({ map: pt, color: new THREE.Color(LAMP.color), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }), Math.max(n, 1));
    S.pools.renderOrder = 3; S.pools.visible = false;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), p = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
    S.lamps.forEach((l, i) => {
      const yaw = Math.atan2(l.nx, -l.ny);
      q.setFromAxisAngle(up, yaw); p.set(l.x, 0.12, -l.y); m.compose(p, q, one);
      S.poles.setMatrixAt(i, m); S.lenses.setMatrixAt(i, m);
      l.head = new THREE.Vector3(l.x + l.nx * (LAMP.arm - 0.05), LAMP.height - 0.2, -(l.y + l.ny * (LAMP.arm - 0.05)));
      p.set(l.head.x, 0.2, l.head.z); q.identity(); m.compose(p, q, one);
      S.pools.setMatrixAt(i, m);
    });
    S.poles.count = S.lenses.count = S.pools.count = n;
    S.poles.castShadow = true; S.poles.receiveShadow = true;
    S.poles.frustumCulled = S.lenses.frustumCulled = S.pools.frustumCulled = false;
    scene.add(S.poles, S.lenses, S.pools);
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
      const im = new THREE.InstancedMesh(glass.im.geometry, new THREE.MeshBasicMaterial({ color: LAMP.window }), Math.max(m.houses.length, 1));
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
  const lampK = () => smooth(0.5, 0.72, S.t);
  function setWindows(modelIdx, near) {
    const im = S.windows[modelIdx];
    if (!im) return;
    if (lampK() <= 0) { im.count = 0; return; }
    let k = 0;
    for (const h of near) if (isLit(h)) im.setMatrixAt(k++, h.matrix);
    im.count = k;
    im.instanceMatrix.needsUpdate = true;
  }

  // ------------------------------------------------------------------------------------------------------------
  // The time of day
  // ------------------------------------------------------------------------------------------------------------
  function setTime(t) {
    t = Math.min(1, Math.max(0, t));
    const wasOn = lampK() > 0;
    S.t = t;
    const s1 = smooth(0, 0.5, t), s2 = smooth(0.5, 1, t), dusk = Math.sin(Math.PI * t), k = lampK();
    const csm = ctx.getCsm();
    // sun -> low sun -> moon
    if (t < 0.5) {
      _dir.copy(ctx.sunDir).lerp(SUN_LOW, s1).normalize();
      _c1.copy(COL.sunDay).lerp(COL.sunDusk, s1);
      var sunI = lerp(2.6, 1.0, s1);
    } else {
      _dir.copy(MOON_DIR);
      _c1.copy(COL.sunDusk).lerp(COL.moon, s2);
      var sunI = lerp(1.0, 0.8, s2);
    }
    if (csm) {
      csm.lightDirection.copy(_dir).negate().normalize();
      csm.lightIntensity = sunI;
      for (const l of csm.lights) { l.intensity = sunI; l.color.copy(_c1); }
    }
    // sky dome
    const u = S.dome.material.uniforms;
    u.dayInt.value = lerp(1, 0.35, s1) * (1 - s2 * 0.6);
    u.dusk.value = dusk;
    u.nightK.value = s2;
    u.sunDir.value.copy(t < 0.5 ? _dir : SUN_LOW);
    S.stars.material.opacity = smooth(0.62, 0.95, t); S.stars.visible = S.stars.material.opacity > 0;
    S.moon.material.opacity = smooth(0.55, 0.8, t); S.moon.visible = S.moon.material.opacity > 0;
    // image-based light, ambient, fog, exposure
    scene.environment = t < 0.5 ? S.dayEnv : S.nightEnv;
    scene.environmentIntensity = t < 0.5 ? lerp(0.85, 0.4, s1) : lerp(0.4, 0.75, s2);
    hemi.color.copy(t < 0.5 ? _c2.copy(COL.hemiSkyDay).lerp(COL.hemiSkyDusk, s1) : _c2.copy(COL.hemiSkyDusk).lerp(COL.hemiSkyNight, s2));
    hemi.groundColor.copy(_c2.copy(COL.hemiGroundDay).lerp(COL.hemiGroundNight, smooth(0.3, 0.9, t)));
    hemi.intensity = t < 0.5 ? lerp(0.2, 0.45, s1) : lerp(0.45, 0.6, s2);
    scene.fog.color.copy(t < 0.5 ? _c2.copy(HORIZON).lerp(COL.fogDusk, s1) : _c2.copy(COL.fogDusk).lerp(COL.fogNight, s2));
    scene.fog.near = lerp(4000, 1500, smooth(0.3, 0.9, t)); scene.fog.far = lerp(26000, 15000, smooth(0.3, 0.9, t));
    renderer.toneMappingExposure = lerp(0.95, 1.0, s2);
    // tints of things that are not lit by the scene lights (imagery, tree cards, sea)
    const tint = smooth(0.25, 0.9, t);
    worldGround.material.color.copy(_c2.copy(COL.seaDay).lerp(COL.seaNight, tint));
    for (const sm of satMeshes) sm.material.color.copy(_c2.copy(COL.satDay).lerp(COL.satNight, tint));
    _c2.copy(COL.treeDay).lerp(COL.treeNight, tint);
    treeGroup.traverse((o) => { if (o.material?.isMeshBasicMaterial) o.material.color.copy(_c2); });
    // lights of the houses and of the streets
    S.lenses.material.emissiveIntensity = 6 * k;
    S.pools.material.opacity = 0.4 * k; S.pools.visible = k > 0;
    for (const pl of S.points) pl.intensity = LAMP.pointIntensity * k;
    for (const im of Object.values(S.windows)) { im.material.color.set(LAMP.window).multiplyScalar(0.25 + 0.75 * k); im.visible = k > 0; }
    if ((k > 0) !== wasOn) ctx.rebuildInstances(true);
    S.lastTarget.set(Infinity, 0, 0);
    if (ctx.onTime) ctx.onTime(t);
  }
  function animateTo(target, ms = 2600) {
    S.anim = { from: S.t, to: target, start: performance.now(), dur: ms };
  }
  const _v = new THREE.Vector3();
  function update(now) {
    if (S.anim) {
      const k = Math.min(1, (now - S.anim.start) / S.anim.dur), e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      setTime(lerp(S.anim.from, S.anim.to, e));
      if (k >= 1) S.anim = null;
    }
    if (S.dome) S.dome.position.copy(camera.position);
    if (S.moon && S.moon.visible) S.moon.position.copy(camera.position).addScaledVector(MOON_DIR, 24000);
    if (S.stars && S.stars.visible) S.stars.position.copy(camera.position);
    if (lampK() <= 0 || !S.points.length || !S.lamps.length) return;
    if (controls.target.distanceToSquared(S.lastTarget) < 4) return;
    S.lastTarget.copy(controls.target);
    const tx = controls.target.x, tz = controls.target.z;
    const near = S.lamps.map((l) => ({ l, d: (l.x - tx) * (l.x - tx) + (l.y + tz) * (l.y + tz) })).sort((a, b) => a.d - b.d).slice(0, S.points.length);
    S.points.forEach((pl, i) => { const e = near[i]; if (e) pl.position.copy(e.l.head).setY(LAMP.height - 0.35); else pl.position.set(0, -100, 0); });
  }

  function build() {
    SUN_LOW.copy(ctx.sunDir).setY(0).normalize().multiplyScalar(0.98).setY(0.14).normalize();
    buildSky(); buildLamps(); buildWindows();
    setTime(0);
  }
  return { build, setTime, animateTo, update, setWindows, isLit, get t() { return S.t; }, get on() { return S.t >= 0.5; }, get lamps() { return S.lamps; }, get objects() { return S; } };
}
