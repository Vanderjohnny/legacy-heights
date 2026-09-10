// Aircraft at Grantley Adams: one landing on runway 09 (from the sea, west to east) and one taking off, on random
// cycles. Low-poly airliner built here (fuselage, swept wings, tail, two engines). At night: navigation lights,
// strobes and a landing light cone. Runway geometry: data/airport.json (OpenStreetMap), site frame in metres.
import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';

const UP = new THREE.Vector3(0, 1, 0);
const GLIDE = Math.tan(THREE.MathUtils.degToRad(3.2));       // approach slope
const CLIMB = Math.tan(THREE.MathUtils.degToRad(9));         // initial climb

export function createPlanes(ctx) {
  // ctx: scene, runway (centreline [[x, y], ...] in site metres, west -> east), isTouch, groundY
  const { scene } = ctx;
  const planes = [];
  const group = new THREE.Group(); group.name = '__planes'; scene.add(group);
  let seed = 20260911;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let nightK = 0;

  // runway axis
  const pts = (ctx.runway || []).map(([x, y]) => new THREE.Vector3(x, ctx.groundY ?? 0, -y));
  if (pts.length < 2) return { update() {}, setNight() {}, get planes() { return planes; } };
  const A = pts[0].clone(), B = pts[pts.length - 1].clone();
  const axis = B.clone().sub(A).setY(0); const runwayLen = axis.length(); axis.normalize();

  // ------------------------------------------------------------------------------------------------------------
  function colorize(geo, hex) {
    const g = geo.index ? geo.toNonIndexed() : geo; g.deleteAttribute('uv');
    const c = new THREE.Color(hex), n = g.attributes.position.count, arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    return g;
  }
  function airlinerGeometry() {
    // local +Z = nose, +Y up, X to the right; A320-ish dimensions (37 m long, 34 m span)
    const parts = [];
    const fus = new THREE.CapsuleGeometry(1.95, 30, 6, 14).rotateX(Math.PI / 2);           // along Z
    parts.push(colorize(fus, 0xf4f4f6));
    const cockpit = new THREE.SphereGeometry(1.95, 12, 8).scale(1, 0.9, 1.6).translate(0, 0, 16.2);
    parts.push(colorize(cockpit, 0xe9eaee));
    const wing = (side) => {
      const s = new THREE.Shape();
      s.moveTo(0, 0); s.lineTo(0, 7); s.lineTo(17 * side, -6.5); s.lineTo(17 * side, -9); s.lineTo(0, -5); s.closePath();
      const g = new THREE.ExtrudeGeometry(s, { depth: 0.55, bevelEnabled: false }).rotateX(Math.PI / 2).translate(0, -0.4, 0.8);
      g.rotateX(0); return colorize(g, 0xd9dbe0);
    };
    parts.push(wing(1), wing(-1));
    const stab = (side) => {
      const s = new THREE.Shape(); s.moveTo(0, 0); s.lineTo(0, 3); s.lineTo(6.2 * side, -0.5); s.lineTo(6.2 * side, -2); s.lineTo(0, -1.8); s.closePath();
      return colorize(new THREE.ExtrudeGeometry(s, { depth: 0.3, bevelEnabled: false }).rotateX(Math.PI / 2).translate(0, 1.2, -14.5), 0xd9dbe0);
    };
    parts.push(stab(1), stab(-1));
    const fin = new THREE.Shape(); fin.moveTo(0, 0); fin.lineTo(6.5, 0); fin.lineTo(2.2, 6.5); fin.lineTo(-1, 6.5); fin.closePath();
    const finG = new THREE.ExtrudeGeometry(fin, { depth: 0.35, bevelEnabled: false }).rotateY(-Math.PI / 2).translate(0.17, 1.4, -11.5);
    parts.push(colorize(finG, 0x2b6cb0));
    for (const side of [-1, 1]) {
      const eng = new THREE.CylinderGeometry(1.1, 1.25, 4.6, 12).rotateX(Math.PI / 2).translate(5.6 * side, -1.9, 2.2);
      parts.push(colorize(eng, 0x9aa0a8));
    }
    const merged = BufferGeometryUtils.mergeGeometries(parts, false);
    merged.computeVertexNormals();
    return merged;
  }
  const bodyGeo = airlinerGeometry();
  const bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.35, envMapIntensity: 0.9 });
  let lightTex = null;
  function lightSprite(hex, size) {
    if (!lightTex) {
      const c = document.createElement('canvas'); c.width = c.height = 64;
      const g = c.getContext('2d'); const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.3, 'rgba(255,255,255,0.8)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
      lightTex = new THREE.CanvasTexture(c); lightTex.colorSpace = THREE.SRGBColorSpace;
    }
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: lightTex, color: hex, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
    s.scale.set(size, size, 1);
    return s;
  }
  function makePlane() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(bodyGeo, bodyMat); body.castShadow = false;
    g.add(body);
    const nav = { left: lightSprite(0xff2020, 5), right: lightSprite(0x20ff40, 5), tail: lightSprite(0xffffff, 4), beacon: lightSprite(0xff3030, 4), strobeL: lightSprite(0xffffff, 8), strobeR: lightSprite(0xffffff, 8) };
    nav.left.position.set(-17, -0.4, -7); nav.right.position.set(17, -0.4, -7); nav.tail.position.set(0, 1.5, -16); nav.beacon.position.set(0, 2.4, 2);
    nav.strobeL.position.set(-17.4, -0.4, -7.2); nav.strobeR.position.set(17.4, -0.4, -7.2);
    for (const s of Object.values(nav)) g.add(s);
    const cone = new THREE.Mesh(new THREE.PlaneGeometry(90, 260).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: coneTexture(), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    cone.position.set(0, -2, 150); cone.rotation.y = Math.PI;
    g.add(cone);
    g.userData = { nav, cone };
    g.visible = false;
    return g;
  }
  let coneTex = null;
  function coneTexture() {
    if (coneTex) return coneTex;
    const c = document.createElement('canvas'); c.width = 128; c.height = 256;
    const cx = c.getContext('2d'); const g = cx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, 'rgba(255,244,214,0.7)'); g.addColorStop(0.6, 'rgba(255,244,214,0.15)'); g.addColorStop(1, 'rgba(255,244,214,0)');
    cx.fillStyle = g; cx.beginPath(); cx.moveTo(56, 0); cx.lineTo(72, 0); cx.lineTo(128, 256); cx.lineTo(0, 256); cx.closePath(); cx.fill();
    coneTex = new THREE.CanvasTexture(c); coneTex.colorSpace = THREE.SRGBColorSpace;
    return coneTex;
  }

  // ------------------------------------------------------------------------------------------------------------
  // flight profiles: distance along the runway axis (s, metres from the west threshold) + altitude, as functions of time
  // ------------------------------------------------------------------------------------------------------------
  const APPROACH = 5200, VAPP = 72, ROLL = 1900, VROT = 78, CLIMB_OUT = 7000;
  function landing(tm) {
    // tm seconds since start: approach from s = -APPROACH, touchdown at s = 320, roll-out to s = 320 + ROLL
    const tTouch = APPROACH / VAPP;
    if (tm < tTouch) { const s = -APPROACH + VAPP * tm; return { s: s + 320, h: Math.max(0, -s) * GLIDE, v: VAPP, phase: 'approach' }; }
    const tr = tm - tTouch, tRoll = 2 * ROLL / VAPP;                          // uniform deceleration
    if (tr < tRoll) { const s = 320 + VAPP * tr - (VAPP / (2 * tRoll)) * tr * tr; return { s, h: 0, v: VAPP * (1 - tr / tRoll), phase: 'roll' }; }
    return null;
  }
  function takeoff(tm) {
    // start at s = 150, accelerate to VROT over 1500 m, rotate, climb
    const aTO = VROT * VROT / (2 * 1500), tRot = VROT / aTO;
    if (tm < tRot) { const s = 150 + 0.5 * aTO * tm * tm; return { s, h: 0, v: aTO * tm, phase: 'roll' }; }
    const tc = tm - tRot, v = VROT + Math.min(25, tc * 1.2);
    const s = 1650 + VROT * tc + 0.6 * tc * tc * 0.5;
    const h = (s - 1650) * CLIMB;
    if (s - 1650 > CLIMB_OUT) return null;
    return { s, h, v, phase: 'climb' };
  }
  const _pos = new THREE.Vector3(), _next = new THREE.Vector3();
  function place(p, st, prev) {
    _pos.copy(A).addScaledVector(axis, st.s).setY(A.y + st.h + 2.2);
    const st2 = p.profile(p.tm + 0.5) || st;
    _next.copy(A).addScaledVector(axis, st2.s).setY(A.y + st2.h + 2.2);
    p.mesh.position.copy(_pos);
    if (_next.distanceToSquared(_pos) > 0.01) p.mesh.lookAt(_next);
    p.mesh.updateMatrixWorld();
  }
  for (const kind of ['landing', 'takeoff']) {
    const mesh = makePlane(); group.add(mesh);
    planes.push({ kind, mesh, profile: kind === 'landing' ? landing : takeoff, tm: -(15 + rnd() * 40), active: false, fade: 0 });
  }
  planes[1].tm = -(60 + rnd() * 40);   // the take-off waits for the first landing

  function update(dt, now) {
    dt = Math.min(dt, 0.2);
    for (const p of planes) {
      p.tm += dt;
      if (p.tm < 0) { p.mesh.visible = false; continue; }
      const st = p.profile(p.tm);
      if (!st) { p.mesh.visible = false; p.tm = -(25 + rnd() * 70); continue; }   // done: wait a random while, then again
      p.mesh.visible = true;
      place(p, st);
      // lights
      const nav = p.mesh.userData.nav;
      const k = nightK;
      nav.left.material.opacity = k; nav.right.material.opacity = k; nav.tail.material.opacity = k;
      nav.beacon.material.opacity = k * (Math.sin(now / 1000 * 2 * Math.PI * 0.9) > 0.3 ? 1 : 0.1);
      const strobe = (now % 1600) < 60 || ((now + 120) % 1600) < 60 ? 1 : 0;
      nav.strobeL.material.opacity = k * strobe; nav.strobeR.material.opacity = k * strobe;
      const low = st.h < 500 ? 1 : 0;
      p.mesh.userData.cone.material.opacity = 0.55 * k * low * (st.phase === 'approach' || st.phase === 'roll' ? 1 : 0.6);
      p.mesh.userData.cone.visible = k > 0 && low > 0;
    }
  }
  function setNight(k) { nightK = k; }
  return { update, setNight, get planes() { return planes; }, get runway() { return { A, B, axis, length: runwayLen }; } };
}
