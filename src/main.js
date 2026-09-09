// Legacy Heights — interactive subdivision viewer (three.js)
import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { CSM } from 'three/addons/csm/CSM.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
// internal modules carry a version query so browsers never pair a new main.js with a cached old module
import { TYPES, PDF_TYPE, MODEL_KIND, COLOR_LABEL, IMAGE_COLOR, imageFor, I18N, SQFT_PER_M2, PARCELS, STATUS, BACKEND } from './config.js?v=6';
import { api } from './api.js?v=6';
import { createNight } from './night.js?v=6';
import { createCars } from './cars.js?v=6';
import { createRegionMap } from './region.js?v=6';

const THREE_VERSION = '0.170.0';
const ASSET_V = '2026-09-09a';   // bump when models/textures change so browsers do not keep stale copies
const asset = (url) => `${url}${url.includes('?') ? '&' : '?'}v=${ASSET_V}`;
// Single-file build (tools/build_single_html.py): every asset is embedded as base64 in window.LH_EMBED and nothing is fetched.
const EMBED = window.LH_EMBED || null;
const embedded = (url) => !!(EMBED && EMBED.files && EMBED.files[url]);
function embedBytes(url) {
  const bin = atob(EMBED.files[url]);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr.buffer;
}
const embedDataUri = (url) => `data:${EMBED.mime[url] || 'application/octet-stream'};base64,${EMBED.files[url]}`;
const imageUrl = (url) => (embedded(url) ? embedDataUri(url) : url);
async function loadJson(url) {
  if (EMBED && EMBED.json && EMBED.json[url]) return EMBED.json[url];
  return (await fetch(url, { cache: 'no-cache' })).json();
}
const DRACO_PATH = `https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/examples/jsm/libs/draco/gltf/`;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  lang: (navigator.language || 'en').toLowerCase().startsWith('pt') ? 'pt' : 'en',
  data: null,
  houses: [],           // enriched house records
  lots: [],             // lot records with polygons (Blender XY)
  byId: new Map(),
  hovered: null,        // house record or lot record
  selected: null,
  activeTypes: new Set([1, 2, 3, 4]),
  activeParcels: new Set(PARCELS),
  colorByType: false,
  flying: false,
  props: {},            // property registry (data/properties.json), keyed by the Blender property_id
  status: {},           // pid -> { status, updatedAt, by }  (sales backend / data/status.json)
  night: false,
};
const t = (k) => I18N[state.lang][k] ?? I18N.en[k] ?? k;
const fmt = (n, d = 0) => (n == null || Number.isNaN(n)) ? '–' : n.toLocaleString(state.lang === 'pt' ? 'pt-BR' : 'en-US', { maximumFractionDigits: d, minimumFractionDigits: d });

// ---------------------------------------------------------------------------
// Renderer / scene
// ---------------------------------------------------------------------------
const canvas = document.getElementById('scene');
const IS_TOUCH = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
const IS_PHONE = () => window.innerWidth <= 640;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, IS_TOUCH ? 1.5 : 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const HORIZON = new THREE.Color(0xdde8f2);
scene.fog = new THREE.Fog(HORIZON, 4000, 26000);   // light haze only: the coast and the sea stay visible on the horizon

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 1, 60000);
const controls = new MapControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.screenSpacePanning = false;
controls.minDistance = 12;
controls.maxDistance = 3200;
controls.maxPolarAngle = THREE.MathUtils.degToRad(84);
controls.zoomToCursor = true;

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;   // replaced by the sky HDRI once loaded
scene.environmentIntensity = 0.3;

// lights: a real sky HDRI (Poly Haven, CC0) lights the scene; cascaded shadow maps follow the HDRI's sun
const hemi = new THREE.HemisphereLight(0xcfe3ff, 0x6f7f52, 0.2);
scene.add(hemi);
const SUN_DIR = new THREE.Vector3(-0.55, 0.9, -0.35).normalize();   // overwritten by the brightest texel of the HDRI
let csm = null;
async function setupEnvironment() {
  let hdr;
  try {
    if (embedded('assets/env/sky_1k.hdr')) {
      const d = new RGBELoader().setDataType(THREE.FloatType).parse(embedBytes('assets/env/sky_1k.hdr'));
      hdr = new THREE.DataTexture(d.data, d.width, d.height, THREE.RGBAFormat, d.type);
      hdr.colorSpace = THREE.LinearSRGBColorSpace; hdr.minFilter = THREE.LinearFilter; hdr.magFilter = THREE.LinearFilter;
      hdr.generateMipmaps = false; hdr.flipY = true; hdr.needsUpdate = true;
    } else {
      hdr = await new Promise((res, rej) => new RGBELoader(manager).setDataType(THREE.FloatType).load(asset('assets/env/sky_1k.hdr'), res, undefined, rej));
    }
  } catch (e) { console.warn('sky HDRI not available', e); return; }
  hdr.mapping = THREE.EquirectangularReflectionMapping;
  const { data, width, height } = hdr.image;
  // sun direction = brightest texel (equirect: u = atan(z, x) / 2pi + 0.5, v = asin(y) / pi + 0.5)
  let best = -1, bi = 0;
  for (let i = 0; i < width * height; i++) {
    const l = data[i * 4] * 0.2126 + data[i * 4 + 1] * 0.7152 + data[i * 4 + 2] * 0.0722;
    if (l > best) { best = l; bi = i; }
  }
  const px = bi % width, py = Math.floor(bi / width), u = (px + 0.5) / width;
  for (const v of [1 - (py + 0.5) / height, (py + 0.5) / height]) {
    const phi = (u - 0.5) * 2 * Math.PI, theta = (v - 0.5) * Math.PI;
    const dir = new THREE.Vector3(Math.cos(theta) * Math.cos(phi), Math.sin(theta), Math.cos(theta) * Math.sin(phi));
    if (dir.y > 0.05) { SUN_DIR.copy(dir); break; }
  }
  // horizon colour -> fog colour
  let r = 0, g = 0, b = 0, n = 0;
  const row = Math.floor(height * 0.5);
  for (let x = 0; x < width; x += 2) { const i = (row * width + x) * 4; r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; }
  HORIZON.setRGB(Math.min(1, r / n), Math.min(1, g / n), Math.min(1, b / n), THREE.LinearSRGBColorSpace);
  scene.fog.color.copy(HORIZON);
  // lighting environment: the same sky with the sun disc clamped away, so that the direct sun (and its shadows)
  // comes only from the cascaded directional light and is not baked into the ambient term
  const clamped = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) clamped[i] = (i & 3) === 3 ? data[i] : Math.min(data[i], 2.2);
  const envTex = new THREE.DataTexture(clamped, width, height, THREE.RGBAFormat, THREE.FloatType);
  envTex.mapping = THREE.EquirectangularReflectionMapping;
  envTex.colorSpace = THREE.LinearSRGBColorSpace;
  envTex.flipY = hdr.flipY;
  envTex.needsUpdate = true;
  scene.environment = pmrem.fromEquirectangular(envTex).texture;
  scene.environmentIntensity = 0.85;
  envTex.dispose();
  scene.background = hdr;
  scene.backgroundIntensity = 1.0;
}
function setupShadows() {
  csm = new CSM({ camera, parent: scene, cascades: 3, maxFar: 1500, mode: 'practical', shadowMapSize: IS_TOUCH ? 1024 : 2048, shadowBias: -0.00012,
    lightDirection: SUN_DIR.clone().negate().normalize(), lightIntensity: 2.6, lightMargin: 150, lightNear: 1, lightFar: 3000 });
  csm.fade = true;
}
// every lit material gets the cascaded-shadow shader chunks (+ the anti-tiling texture blend where flagged)
function setupShaded(m) {
  if (m.userData.shaded) return;
  m.userData.shaded = true;
  if (csm) csm.setupMaterial(m);
  if (m.userData.antiTiling) {
    const prev = m.onBeforeCompile;
    m.onBeforeCompile = (shader, r) => { if (prev) prev.call(m, shader, r); antiTiling(shader); };
  }
  m.needsUpdate = true;
}
function applyShading() {
  scene.traverse((o) => {
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of mats) if (m.isMeshStandardMaterial || m.isMeshLambertMaterial || m.isMeshPhongMaterial) setupShaded(m);
  });
}
// blends the texture with a second, larger-scale copy of itself through low-frequency noise: no visible tiling from above
function antiTiling(shader) {
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>
      float lhHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float lhNoise(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(lhHash(i), lhHash(i + vec2(1.0, 0.0)), f.x), mix(lhHash(i + vec2(0.0, 1.0)), lhHash(i + vec2(1.0, 1.0)), f.x), f.y); }`)
    .replace('#include <map_fragment>', `#ifdef USE_MAP
      vec2 lhUv2 = mat2(0.8, -0.6, 0.6, 0.8) * vMapUv * 0.93 + vec2(0.31, 0.77);   // same scale, rotated: breaks repetition without giant features
      float lhN = lhNoise(vMapUv * 0.11) * 0.6 + lhNoise(vMapUv * 0.031) * 0.4;
      vec4 lhC = mix(texture2D(map, vMapUv), texture2D(map, lhUv2), smoothstep(0.38, 0.62, lhN));
      diffuseColor *= lhC;
      #endif`);
}

// post-processing: screen-space ambient occlusion (GTAO), optional
let composer = null, gtao = null;
const treeGroup = new THREE.Group();
scene.add(treeGroup);
state.ao = window.innerWidth > 900 && !('ontouchstart' in window);
function setupPost() {
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  gtao = new GTAOPass(scene, camera, window.innerWidth, window.innerHeight);
  gtao.output = GTAOPass.OUTPUT.Default;
  gtao.updateGtaoMaterial({ radius: 1.6, distanceExponent: 1, thickness: 1, distanceFallOff: 1, scale: 1.2, samples: 16, screenSpaceRadius: false });
  gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 4, radiusExponent: 1, rings: 2, samples: 16 });
  gtao.blendIntensity = 1;
  const orig = gtao.render.bind(gtao);
  gtao.render = (...args) => { treeGroup.visible = false; orig(...args); treeGroup.visible = true; };   // tree cards are alpha-tested: keep them out of the AO buffers
  composer.addPass(gtao);
  composer.addPass(new OutputPass());
}

// sea plane beyond the island imagery + invisible pick plane. Satellite levels and this plane are drawn first without
// writing depth (renderOrder), so the stacked levels never z-fight at long distances.
const worldGround = new THREE.Mesh(new THREE.PlaneGeometry(200000, 200000), new THREE.MeshStandardMaterial({ color: 0x2f6d93, roughness: 0.55, metalness: 0.05, depthWrite: false }));
worldGround.rotation.x = -Math.PI / 2;
worldGround.position.y = -1.5;
worldGround.renderOrder = -10;
scene.add(worldGround);
const pickPlane = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), new THREE.MeshBasicMaterial({ visible: false }));
pickPlane.rotation.x = -Math.PI / 2;
scene.add(pickPlane);

// ---------------------------------------------------------------------------
// Coordinate helpers (Blender Z-up -> three.js Y-up)
// ---------------------------------------------------------------------------
const C = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1);
const CT = C.clone().transpose();
const b2t = (x, y, z = 0) => new THREE.Vector3(x, z, -y);
const _m1 = new THREE.Matrix4(), _m2 = new THREE.Matrix4();
function blenderMatrix(pos, rotDeg, scale) {
  const [rx, ry, rz] = rotDeg.map(THREE.MathUtils.degToRad);
  const R = _m1.makeRotationZ(rz).multiply(_m2.makeRotationY(ry)).multiply(new THREE.Matrix4().makeRotationX(rx)).clone();
  const M = new THREE.Matrix4().makeTranslation(pos[0], pos[1], pos[2]).multiply(R).multiply(new THREE.Matrix4().makeScale(scale[0], scale[1], scale[2]));
  return new THREE.Matrix4().multiplyMatrices(C, M).multiply(CT);
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------
const manager = new THREE.LoadingManager();
const loadingEl = document.getElementById('loading');
const barEl = document.getElementById('loading-bar');
manager.onProgress = (url, loaded, total) => { barEl.style.width = `${Math.round((loaded / total) * 100)}%`; };
const gltfLoader = new GLTFLoader(manager);
const draco = new DRACOLoader(manager);
draco.setDecoderPath(DRACO_PATH);
gltfLoader.setDRACOLoader(draco);
const loadGLB = (url) => new Promise((res, rej) => (embedded(url) ? gltfLoader.parse(embedBytes(url), '', res, rej) : gltfLoader.load(asset(url), res, undefined, rej)));

const houseGroups = [];      // InstancedMesh list (visible geometry)
const proxies = [];          // invisible instanced boxes for picking (one per model)
const modelInfo = {};        // model index -> { center: Vector3 (local three), size }
let lotLines, hoverLine, selectLine, selectFill;
let night = null, cars = null, regionMap = null;   // night mode / streetlights, moving cars, regional map

async function init() {
  const [data, registry, statusDoc] = await Promise.all([
    loadJson('data/site.json'),
    loadJson('data/properties.json').catch(() => ({ properties: {} })),
    api.statuses().catch(() => ({ statuses: {} })),
  ]);
  state.data = data;
  state.props = registry.properties || {};
  state.registry = registry;
  state.status = statusDoc.statuses || {};
  prepareData(data);
  buildLots(data);

  // the single-file build ships the six houses merged in one GLB (one scene per body) so their textures are shared
  const mergedHouses = embedded('assets/models/houses.glb');
  const [, , ground, ...houseGltfs] = await Promise.all([
    setupEnvironment(),
    setupSatellite(),
    loadGLB('assets/models/ground.glb'),
    ...(mergedHouses ? [loadGLB('assets/models/houses.glb')] : [1, 2, 3, 4, 5, 6].map((i) => loadGLB(`assets/models/house_${i}.glb`))),
  ]);
  setupShadows();
  setupGround(ground.scene);
  buildPavedGrid();
  completeHedges();
  if (mergedHouses) {
    // Blender exports every scene of the .blend; find each body by its node name across all scenes
    for (let i = 1; i <= 6; i++) {
      let node = null;
      for (const sc of houseGltfs[0].scenes) { node = sc.getObjectByName(`house_${i}`); if (node) break; }
      if (node) setupHouseModel(i, node, data.models[i]); else console.warn('house body missing in merged GLB', i);
    }
  } else houseGltfs.forEach((g, idx) => setupHouseModel(idx + 1, g.scene, data.models[idx + 1]));
  await buildTrees(data);
  night = createNight({ scene, renderer, controls, getCsm: () => csm, hemi, treeGroup, worldGround, satMeshes, HORIZON, pmrem, isTouch: IS_TOUCH, lots: state.lots, lotByHouse: state.lotByHouse, pavedClass, models, rebuildInstances, sunDir: SUN_DIR });
  night.build();
  cars = createCars({ scene, paintGeometries: groundMeshes.filter((o) => (Array.isArray(o.material) ? o.material[0] : o.material) === MATS.paint).map((o) => o.geometry), isTouch: IS_TOUCH });
  state.carReport = cars.build();
  applyShading();
  setupPost();
  applyFilter();

  setupUI();
  buildStatusLines();
  setOverview(true);
  // compile the night-only shaders now (asynchronously) so the first Day/Night toggle does not stall
  try { night.apply(true); await renderer.compileAsync(scene, camera); night.apply(false); await renderer.compileAsync(scene, camera); } catch (e) { night.apply(false); }
  loadingEl.classList.add('done');
  setTimeout(() => loadingEl.remove(), 900);
  handleHash();
  animate();
  if (api.hasBackend()) setInterval(refreshStatuses, Math.max(15, BACKEND.pollSeconds) * 1000);
}
async function refreshStatuses() {
  try {
    const doc = await api.statuses();
    state.status = doc.statuses || {};
    buildStatusLines();
    buildLegend();
    if (state.selected) renderPanel(state.selected);
  } catch (e) { console.warn('status refresh failed', e); }
}
const statusOf = (h) => (state.status[h.pid]?.status || 'available');

function prepareData(data) {
  const lotsById = data.lots;
  state.lots = Object.values(lotsById).map((l) => {
    const xs = l.poly.map((p) => p[0]), ys = l.poly.map((p) => p[1]);
    const num = l.id.replace(/\D+/g, '');
    // "label" = official lot number from the subdivision plan (e.g. A-20); falls back to the model's lot index
    return { ...l, num, name: l.label || num, hasHouse: false, minx: Math.min(...xs), maxx: Math.max(...xs), miny: Math.min(...ys), maxy: Math.max(...ys), isHouse: false };
  });
  const lotRecById = new Map(state.lots.map((l) => [l.id, l]));
  state.houses = data.houses.map((h, i) => {
    const type = PDF_TYPE[h.pdf] ?? 4;
    const kind = MODEL_KIND[h.model] ?? 'single';
    // lots from the Blender property ("Terrenos 010,Terrenos 015" for a duplex over two lots),
    // falling back to the lot polygon under the house
    const ids = String(h.lot || '').split(',').map((s) => s.trim()).filter(Boolean);
    let lots = ids.map((id) => lotRecById.get(id)).filter((l) => l && l.poly.length >= 3);
    if (!lots.length) { const l = lotAt(h.pos[0], h.pos[1]); if (l) lots = [l]; }
    lots.forEach((l) => { l.hasHouse = true; });
    const prop = state.props[h.pid] || null;
    return {
      ...h,
      index: i,
      num: h.id.replace(/\D+/g, ''),
      prop,
      code: prop?.code || lots.map((l) => l.name).join('/'),
      parcel: prop?.parcel || (lots.find((l) => /^[A-J]-/.test(l.name))?.name[0] ?? 'A'),
      lots,
      lotIds: lots.map((l) => l.id),
      lotNum: lots.length ? lots.map((l) => l.name).join(' + ') : (h.lot || '').replace(/\D+/g, ''),
      lotIndex: lots.map((l) => l.num).join(' '),
      lotArea: lots.length ? lots.reduce((s, l) => s + l.area_m2, 0) : (h.lotArea ?? null),
      type,
      kind,
      lotPolys: lots.map((l) => l.poly),
      lotCenter: lots[0]?.center ?? [h.pos[0], h.pos[1]],
      matrix: blenderMatrix(h.pos, h.rot, h.scale),
      isHouse: true,
    };
  });
  state.byId = new Map(state.houses.map((h) => [h.id, h]));
  state.lotByHouse = new Map();
  state.houses.forEach((h) => h.lotIds.forEach((id) => state.lotByHouse.set(id, h)));
}

// ---------------------------------------------------------------------------
// Textures (Poly Haven, CC0) + satellite imagery (Esri World Imagery, stitched offline by tools/fetch_tiles.py)
// ---------------------------------------------------------------------------
const texLoader = new THREE.TextureLoader(manager);
const MAX_ANISO = renderer.capabilities.getMaxAnisotropy();
function loadTex(url, srgb = true) {
  const t = texLoader.load(embedded(url) ? embedDataUri(url) : asset(url));
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = MAX_ANISO;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
function texturedMaterial({ diff, nor, rough, color = 0xffffff, roughness = 1, normalScale = 0.7 }) {
  const m = new THREE.MeshStandardMaterial({ color, roughness, metalness: 0, map: loadTex(diff) });
  if (nor) { m.normalMap = loadTex(nor, false); m.normalScale.set(normalScale, normalScale); }
  if (rough) m.roughnessMap = loadTex(rough, false);
  m.userData.antiTiling = true;
  return m;
}
const satMeshes = [];
async function setupSatellite() {
  let meta;
  try { meta = await loadJson('assets/map/sat_meta.json'); } catch { return; }
  state.satMeta = meta;
  for (const [key, y, order] of [['vast', -0.9, -8], ['far', -0.6, -7], ['mid', -0.45, -6], ['near', -0.3, -5]]) {
    const m = meta[key];
    if (!m || !m.corners) continue;
    const c = m.corners;   // Blender XY (metres) of the image corners
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([c.nw[0], y, -c.nw[1], c.ne[0], y, -c.ne[1], c.se[0], y, -c.se[1], c.sw[0], y, -c.sw[1]], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 1, 1, 1, 0, 0, 0], 2));
    geo.setIndex([0, 2, 1, 0, 3, 2]);
    geo.computeVertexNormals();
    const tex = loadTex(`assets/map/sat_${key}.jpg`);
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, roughness: 1, metalness: 0, side: THREE.DoubleSide, depthWrite: false }));
    mesh.receiveShadow = true;
    mesh.renderOrder = order;
    mesh.frustumCulled = false;
    scene.add(mesh);
    satMeshes.push(mesh);
  }
  if (meta.georef?.site_centre_latlng) state.siteLatLng = meta.georef.site_centre_latlng;
}

// ---------------------------------------------------------------------------
// Ground (materials matched by the Blender material name; planar UVs in metres generated at load time)
// ---------------------------------------------------------------------------
const MATS = {
  grass: texturedMaterial({ diff: 'assets/tex/grass_diff.jpg', nor: 'assets/tex/grass_nor.jpg', color: 0xe6efd8, normalScale: 0.5 }),
  asphalt: texturedMaterial({ diff: 'assets/tex/asphalt_diff.jpg', nor: 'assets/tex/asphalt_nor.jpg', rough: 'assets/tex/asphalt_rough.jpg', color: 0x767472 }),
  concrete: texturedMaterial({ diff: 'assets/tex/concrete_diff.jpg', nor: 'assets/tex/concrete_nor.jpg', color: 0xd9d5cb, normalScale: 0.5 }),
  path: texturedMaterial({ diff: 'assets/tex/concrete_diff.jpg', nor: 'assets/tex/concrete_nor.jpg', color: 0xcdbfa0, normalScale: 0.5 }),
  hedge: texturedMaterial({ diff: 'assets/tex/grass_diff.jpg', nor: 'assets/tex/grass_nor.jpg', color: 0x6a9a52, normalScale: 0.8 }),
  paint: new THREE.MeshStandardMaterial({ color: 0xe9e7df, roughness: 0.8, metalness: 0 }),
  curb: new THREE.MeshStandardMaterial({ color: 0x8e8e8b, roughness: 0.92, metalness: 0 }),   // plain grey concrete curb
  other: new THREE.MeshStandardMaterial({ color: 0xa8a49b, roughness: 0.9, metalness: 0 }),
};
const TILE = new Map([[MATS.grass, 1.6], [MATS.asphalt, 3.2], [MATS.concrete, 1.2], [MATS.path, 1.2], [MATS.hedge, 1.2], [MATS.curb, 1.0]]);
const PAVED = new Set([MATS.asphalt, MATS.concrete, MATS.path, MATS.curb, MATS.paint]);
const groundMeshes = [];
function materialFor(name = '') {
  // Blender names carry the collection as a prefix ("01 - Terreno SKP atual | Legacy Ruas"): match only the material part
  const n = name.toLowerCase().split('|').pop().trim();
  if (n.includes('meio') || n.includes('curb')) return MATS.curb;
  if (n.includes('terreno')) return MATS.grass;
  if (n.includes('hedge') || n.includes('cerca')) return MATS.hedge;
  if (n.includes('pintura')) return MATS.paint;
  if (n.includes('rua') || n.includes('asfalto')) return MATS.asphalt;
  if (n.includes('caminho')) return MATS.path;
  if (n.includes('calcada') || n.includes('concreto') || n.includes('acesso') || n.includes('rampa')) return MATS.concrete;
  return MATS.other;
}
// KHR_mesh_quantization stores attributes as int8/int16: convert to float before baking world transforms into them
function toFloatAttributes(geo) {
  for (const name of ['position', 'normal', 'uv']) {
    const a = geo.attributes[name];
    if (!a || a.array instanceof Float32Array) continue;
    const out = new Float32Array(a.count * a.itemSize);
    for (let i = 0; i < a.count; i++) for (let k = 0; k < a.itemSize; k++) out[i * a.itemSize + k] = a.getComponent(i, k);
    geo.setAttribute(name, new THREE.BufferAttribute(out, a.itemSize));
  }
  return geo;
}
const HEDGE_BASE = 0.15, HEDGE_SCALE = 0.72;   // the modelled hedges are 1.4 m tall; the site shows them at ~1.0 m
function lowerHedges(geo) {
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) { const y = p.getY(i); if (y > HEDGE_BASE) p.setY(i, HEDGE_BASE + (y - HEDGE_BASE) * HEDGE_SCALE); }
  p.needsUpdate = true;
  geo.computeBoundingSphere();
}
function planarUV(geo, tile, vertical) {
  const p = geo.attributes.position, n = p.count, uv = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const y = vertical ? p.getY(i) : 0;
    uv[i * 2] = (p.getX(i) + y) / tile;
    uv[i * 2 + 1] = (p.getZ(i) + y) / tile;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}
// bake the node transforms (incl. the KHR_mesh_quantization scale that sits on the parent node) into the geometry and
// re-parent every mesh to a plain group at identity
function bakeAndCollect(root) {
  root.updateMatrixWorld(true);
  const meshes = [];
  root.traverse((o) => { if (o.isMesh) meshes.push(o); });
  const group = new THREE.Group();
  for (const o of meshes) {
    toFloatAttributes(o.geometry);
    o.geometry.applyMatrix4(o.matrixWorld);
    o.position.set(0, 0, 0); o.quaternion.identity(); o.scale.set(1, 1, 1); o.updateMatrix();
    group.add(o);
  }
  scene.add(group);
  return meshes;
}
function setupGround(root) {
  for (const o of bakeAndCollect(root)) {
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const mapped = mats.map((m) => materialFor(m?.name));
    o.material = Array.isArray(o.material) ? mapped : mapped[0];
    const first = mapped[0];
    if (first === MATS.hedge) lowerHedges(o.geometry);
    if (TILE.has(first)) planarUV(o.geometry, TILE.get(first), first === MATS.hedge);
    o.receiveShadow = true;
    o.castShadow = first === MATS.hedge;
    groundMeshes.push(o);
  }
}
// 1 m occupancy grid of paved surfaces (roads, sidewalks, park paths) in Blender XY, used to keep scattered trees off them
let paved = null;
function buildPavedGrid() {
  const b = state.data.bounds, x0 = Math.floor(b.min[0]) - 2, y0 = Math.floor(b.min[1]) - 2;
  const w = Math.ceil(b.max[0] - x0) + 4, h = Math.ceil(b.max[1] - y0) + 4;
  const grid = new Uint8Array(w * h);
  for (const o of groundMeshes) {
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    if (!PAVED.has(mat)) continue;
    const cls = mat === MATS.asphalt ? 2 : mat === MATS.paint ? 3 : 1;
    const p = o.geometry.attributes.position, idx = o.geometry.index;
    const n = idx ? idx.count : p.count;
    const X = (i) => p.getX(i), Y = (i) => -p.getZ(i);   // three -> Blender XY
    for (let t = 0; t < n; t += 3) {
      const a = idx ? idx.getX(t) : t, bb = idx ? idx.getX(t + 1) : t + 1, c = idx ? idx.getX(t + 2) : t + 2;
      const ax = X(a), ay = Y(a), bx = X(bb), by = Y(bb), cx = X(c), cy = Y(c);
      const minx = Math.max(0, Math.floor(Math.min(ax, bx, cx) - x0)), maxx = Math.min(w - 1, Math.ceil(Math.max(ax, bx, cx) - x0));
      const miny = Math.max(0, Math.floor(Math.min(ay, by, cy) - y0)), maxy = Math.min(h - 1, Math.ceil(Math.max(ay, by, cy) - y0));
      for (let gy = miny; gy <= maxy; gy++) for (let gx = minx; gx <= maxx; gx++) {
        const px = gx + x0 + 0.5, py = gy + y0 + 0.5;
        const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by), d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy), d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
        const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
        if (!(neg && pos) || (maxx - minx <= 1 && maxy - miny <= 1)) grid[gy * w + gx] = Math.max(grid[gy * w + gx], cls);
      }
    }
  }
  paved = { grid, x0, y0, w, h };
}
function pavedClass(x, y) {
  if (!paved) return 0;
  const gx = Math.floor(x - paved.x0), gy = Math.floor(y - paved.y0);
  if (gx < 0 || gy < 0 || gx >= paved.w || gy >= paved.h) return 0;
  return paved.grid[gy * paved.w + gx];
}
function isPaved(x, y, margin = 1) {
  if (!paved) return false;
  const gx = Math.floor(x - paved.x0), gy = Math.floor(y - paved.y0);
  for (let dy = -margin; dy <= margin; dy++) for (let dx = -margin; dx <= margin; dx++) {
    const xx = gx + dx, yy = gy + dy;
    if (xx < 0 || yy < 0 || xx >= paved.w || yy >= paved.h) continue;
    if (paved.grid[yy * paved.w + xx]) return true;
  }
  return false;
}
// ---------------------------------------------------------------------------
// Hedge audit: every lot should have a hedge on its side and back boundaries (street fronts excepted).
// Existing hedges are rasterised into a 0.5 m grid; uncovered boundary runs get a hedge box added.
// ---------------------------------------------------------------------------
function buildHedgeGrid() {
  const b = state.data.bounds, cell = 0.5, x0 = Math.floor(b.min[0]) - 4, y0 = Math.floor(b.min[1]) - 4;
  const w = Math.ceil((b.max[0] - x0) / cell) + 16, h = Math.ceil((b.max[1] - y0) / cell) + 16;
  const grid = new Uint8Array(w * h);
  for (const o of groundMeshes) {
    if ((Array.isArray(o.material) ? o.material[0] : o.material) !== MATS.hedge) continue;
    const p = o.geometry.attributes.position, idx = o.geometry.index, n = idx ? idx.count : p.count;
    for (let t = 0; t < n; t += 3) {
      let minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9;
      for (let k = 0; k < 3; k++) {
        const i = idx ? idx.getX(t + k) : t + k;
        const gx = (p.getX(i) - x0) / cell, gy = (-p.getZ(i) - y0) / cell;
        minx = Math.min(minx, gx); maxx = Math.max(maxx, gx); miny = Math.min(miny, gy); maxy = Math.max(maxy, gy);
      }
      if ((maxx - minx) * (maxy - miny) > 400) continue;
      for (let gy = Math.max(0, Math.floor(miny)); gy <= Math.min(h - 1, Math.floor(maxy)); gy++)
        for (let gx = Math.max(0, Math.floor(minx)); gx <= Math.min(w - 1, Math.floor(maxx)); gx++) grid[gy * w + gx] = 1;
    }
  }
  return { grid, x0, y0, w, h, cell };
}
function hedgeNear(hg, x, y, r) {
  const gx = Math.floor((x - hg.x0) / hg.cell), gy = Math.floor((y - hg.y0) / hg.cell);
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const xx = gx + dx, yy = gy + dy;
    if (xx >= 0 && yy >= 0 && xx < hg.w && yy < hg.h && hg.grid[yy * hg.w + xx]) return true;
  }
  return false;
}
function completeHedges() {
  const hg = buildHedgeGrid();
  const edges = new Map();
  for (const l of state.lots) {
    if (l.hidden || l.area_m2 < 60 || l.poly.length < 3) continue;
    for (let i = 0; i < l.poly.length; i++) {
      const a = l.poly[i], b = l.poly[(i + 1) % l.poly.length];
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1.5) continue;
      const key = [a, b].map((p) => `${Math.round(p[0] * 2)},${Math.round(p[1] * 2)}`).sort().join('|');
      const e = edges.get(key) || { a, b, lots: [] };
      e.lots.push(l.id);
      edges.set(key, e);
    }
  }
  const segs = [];
  let checked = 0, fronts = 0, skippedDuplex = 0;
  for (const e of edges.values()) {
    // an edge shared by the two lots of one duplex runs under the building: no hedge there
    if (e.lots.length === 2 && state.lotByHouse.get(e.lots[0]) && state.lotByHouse.get(e.lots[0]) === state.lotByHouse.get(e.lots[1])) { skippedDuplex++; continue; }
    const [a, b] = [e.a, e.b];
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy), nx = -dy / len, ny = dx / len;
    const n = Math.max(4, Math.round(len / 0.75));
    let paved = 0, covered = 0, cur = null; const runs = [];
    for (let k = 0; k <= n; k++) {
      const t = k / n, x = a[0] + dx * t, y = a[1] + dy * t;
      if (isPaved(x + nx * 1.6, y + ny * 1.6, 0) || isPaved(x - nx * 1.6, y - ny * 1.6, 0)) paved++;
      const cov = hedgeNear(hg, x, y, 2) || isPaved(x, y, 3);   // the first ~3 m from the street are left open on purpose
      if (cov) covered++;
      if (!cov) { if (!cur) cur = [t, t]; else cur[1] = t; } else if (cur) { runs.push(cur); cur = null; }
    }
    if (cur) runs.push(cur);
    checked++;
    if (paved > n * 0.45) { fronts++; continue; }
    if (covered > n * 0.9) continue;
    for (const [t0, t1] of runs) {
      if ((t1 - t0) * len < 2.5) continue;
      const s0 = Math.max(0, t0 - 0.25 / len), s1 = Math.min(1, t1 + 0.25 / len);
      segs.push([a[0] + dx * s0, a[1] + dy * s0, a[0] + dx * s1, a[1] + dy * s1]);
    }
  }
  if (segs.length) {
    const geos = segs.map(([x1, y1, x2, y2]) => {
      const len = Math.hypot(x2 - x1, y2 - y1);
      const g = new THREE.BoxGeometry(len, (1.4 * HEDGE_SCALE), 0.45).translate(0, (1.4 * HEDGE_SCALE) / 2, 0);
      g.applyMatrix4(new THREE.Matrix4().makeRotationY(Math.atan2(y2 - y1, x2 - x1)));
      g.translate((x1 + x2) / 2, HEDGE_BASE, -(y1 + y2) / 2);
      return g;
    });
    const merged = BufferGeometryUtils.mergeGeometries(geos, false);
    planarUV(merged, TILE.get(MATS.hedge), true);
    const mesh = new THREE.Mesh(merged, MATS.hedge);
    mesh.name = '__hedges_added';
    mesh.castShadow = mesh.receiveShadow = true;
    scene.add(mesh);
    groundMeshes.push(mesh);
  }
  state.hedgeReport = { edges: checked, streetFronts: fronts, duplexShared: skippedDuplex, addedSegments: segs.length, addedMetres: Math.round(segs.reduce((s, q) => s + Math.hypot(q[2] - q[0], q[3] - q[1]), 0)) };
}

// extra trees inside the open spaces (the parks are drawn in the plan as empty lawns with a few trees only)
function scatterParkTrees(data) {
  const speciesIdx = (k) => data.species.findIndex((s) => s.name.toLowerCase().includes(k));
  const acer = speciesIdx('acer'), palm = speciesIdx('palm'), pine = speciesIdx('pine');
  const parks = state.lots.filter((l) => l.hidden && l.poly.length >= 3);
  const placed = data.trees.map((t) => [t.p[0], t.p[1]]);
  let seed = 20260905;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const out = [];
  for (const park of parks) {
    const step = 7;
    for (let x = park.minx + 2; x < park.maxx - 2; x += step) {
      for (let y = park.miny + 2; y < park.maxy - 2; y += step) {
        const px = x + (rnd() - 0.5) * 5, py = y + (rnd() - 0.5) * 5;
        if (!pointInPoly(px, py, park.poly)) continue;
        if (isPaved(px, py, 2)) continue;
        let tooClose = false;
        for (const q of placed) { if (Math.abs(q[0] - px) < 5 && Math.abs(q[1] - py) < 5 && Math.hypot(q[0] - px, q[1] - py) < 4.5) { tooClose = true; break; } }
        if (tooClose) continue;
        const r = rnd();
        const s = r < 0.5 ? acer : r < 0.85 ? palm : pine;
        if (s < 0) continue;
        const sc = 0.36 + rnd() * 0.2;
        out.push({ s, p: [+px.toFixed(2), +py.toFixed(2), 0.15], r: +(rnd() * 360).toFixed(1), sc, sz: sc });
        placed.push([px, py]);
      }
    }
  }
  return out;
}
function setupCurbs(root) {
  for (const o of bakeAndCollect(root)) {
    planarUV(o.geometry, TILE.get(MATS.curb), true);
    o.material = MATS.curb;
    o.receiveShadow = true;
    o.castShadow = true;
    groundMeshes.push(o);
  }
}

// ---------------------------------------------------------------------------
// Houses (instanced)
// ---------------------------------------------------------------------------
// Two detail levels per model: "hi" = every primitive, "lo" = only the large primitives (walls, roof, glass, doors).
// Instances are re-distributed between the two sets as the camera moves (see rebuildInstances).
const models = {};           // modelIdx -> { houses, hi: [{im,isFacade}], lo: [{im,isFacade}] }
const LOD_DIST = 240;        // metres: houses closer than this get the detailed mesh
function setupHouseModel(modelIdx, root, meta) {
  const houses = state.houses.filter((h) => h.model === modelIdx);
  root.updateMatrixWorld(true);
  const prims = [];
  root.traverse((o) => { if (o.isMesh) prims.push(o); });
  const triCount = (g) => (g.index ? g.index.count : g.attributes.position.count) / 3;
  const total = prims.reduce((s, p) => s + triCount(p.geometry), 0);
  const count = Math.max(houses.length, 1);
  const hi = [], lo = [];
  const make = (geo, mat, isFacade) => {
    const im = new THREE.InstancedMesh(geo, mat, count);
    im.count = 0;
    im.frustumCulled = false;
    im.castShadow = true;
    im.receiveShadow = true;
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.userData = { modelIdx, isFacade, houses: [] };
    scene.add(im);
    houseGroups.push(im);
    return { im, isFacade };
  };
  for (const p of prims) {
    const geo = toFloatAttributes(p.geometry.clone()).applyMatrix4(p.matrixWorld);
    // the SketchUp bodies mix face windings; rebuild normals from the winding so double-sided lighting is right on both sides
    // (otherwise walls whose stored normal disagrees with the winding render almost black and look like openings)
    geo.computeVertexNormals();
    const name = p.material?.name || '';
    const isFacade = name.toUpperCase().includes('FACADE');
    let mat = p.material;
    if (isFacade) mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 });
    else {
      mat = mat.clone(); mat.envMapIntensity = 0.6;
      if (mat.transparent) { mat.depthWrite = false; }
      if (/metal/i.test(name)) { mat.color.multiplyScalar(0.58); mat.roughness = Math.min(1, (mat.roughness ?? 1) * 0.8 + 0.1); }   // darker metal roof
    }
    mat.side = THREE.DoubleSide;   // the SketchUp-derived bodies have inconsistent face orientation
    hi.push(make(geo, mat, isFacade));
  }
  // far level of detail: a simple walls box (facade colour) + roof slab built from the model's bounding box
  const mn = meta.bbox_min, mx = meta.bbox_max;
  const size = new THREE.Vector3(mx[0] - mn[0], mx[2] - mn[2], mx[1] - mn[1]);
  const center = b2t((mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2);
  modelInfo[modelIdx] = { center, size, front: new THREE.Vector3(0, 0, 1) };
  {
    const wallH = size.y * 0.78, inset = 0.35;
    const walls = new THREE.BoxGeometry(size.x - inset * 2, wallH, size.z - inset * 2).translate(center.x, mn[2] + wallH / 2, center.z);
    const roof = new THREE.BoxGeometry(size.x, size.y - wallH, size.z).translate(center.x, mn[2] + wallH + (size.y - wallH) / 2, center.z);
    lo.push(make(walls, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 }), true));
    const roofEntry = make(roof, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7, metalness: 0.15 }), false);
    roofEntry.isRoof = true;
    lo.push(roofEntry);
  }
  // picking proxy: instanced box covering the model's bounding box (Blender coords -> three)
  const boxGeo = new THREE.BoxGeometry(size.x, size.y, size.z).translate(center.x, center.y, center.z);
  const proxy = new THREE.InstancedMesh(boxGeo, new THREE.MeshBasicMaterial({ color: 0xff0000, wireframe: true }), count);
  proxy.visible = false;
  proxy.frustumCulled = false;
  proxy.userData = { modelIdx, houses };
  houses.forEach((h, k) => proxy.setMatrixAt(k, h.matrix));
  proxy.instanceMatrix.needsUpdate = true;
  scene.add(proxy);
  proxies.push(proxy);
  models[modelIdx] = { houses, hi, lo, proxy };
}
const _col = new THREE.Color();
function facadeColor(h) {
  if (state.colorByType) return _col.set(TYPES[h.type].hex).clone();
  const c = state.data.colors[h.color] || [0.8, 0.8, 0.8];
  return _col.setRGB(c[0], c[1], c[2], THREE.LinearSRGBColorSpace).clone();
}
const ROOF_GREY = new THREE.Color(0x8c8f92);
function fillGroup(group, list) {
  for (const { im, isFacade, isRoof } of group) {
    im.count = list.length;
    im.userData.houses = list;
    for (let k = 0; k < list.length; k++) {
      im.setMatrixAt(k, list[k].matrix);
      if (isFacade) im.setColorAt(k, facadeColor(list[k]));
      else if (isRoof) im.setColorAt(k, state.colorByType ? _col.set(TYPES[list[k].type].hex).clone() : ROOF_GREY);
    }
    im.instanceMatrix.needsUpdate = true;
    if ((isFacade || isRoof) && im.instanceColor) im.instanceColor.needsUpdate = true;
  }
}
const _lodPos = new THREE.Vector3(Infinity, Infinity, Infinity), _hp = new THREE.Vector3();
function rebuildInstances(force = false) {
  if (!force && camera.position.distanceToSquared(_lodPos) < 36) return;
  _lodPos.copy(camera.position);
  const d2 = LOD_DIST * LOD_DIST;
  for (const [mIdx, m] of Object.entries(models)) {
    const near = [], far = [];
    for (const h of m.houses) {
      if (!isVisibleHouse(h)) continue;
      _hp.setFromMatrixPosition(h.matrix);
      (_hp.distanceToSquared(camera.position) < d2 ? near : far).push(h);
    }
    fillGroup(m.hi, near);
    fillGroup(m.lo, far);
    if (night) night.setWindows(mIdx, near);
  }
}
function refreshFacadeColors() { rebuildInstances(true); }
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const isVisibleHouse = (h) => state.activeTypes.has(h.type) && state.activeParcels.has(h.parcel);
function applyFilter() {
  const visible = isVisibleHouse;
  for (const im of proxies) {
    im.userData.houses.forEach((h, k) => im.setMatrixAt(k, visible(h) ? h.matrix : ZERO));
    im.instanceMatrix.needsUpdate = true;
  }
  rebuildInstances(true);
  updateCounter();
}

// ---------------------------------------------------------------------------
// Lots (outlines + highlight)
// ---------------------------------------------------------------------------
function buildLots(data) {
  const pos = [];
  for (const l of Object.values(data.lots)) {
    if (l.hidden || l.poly.length < 3) continue;
    for (let i = 0; i < l.poly.length; i++) {
      const a = l.poly[i], b = l.poly[(i + 1) % l.poly.length];
      pos.push(a[0], 0.07, -a[1], b[0], 0.07, -b[1]);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  lotLines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.28, depthWrite: false }));
  lotLines.renderOrder = 2;
  scene.add(lotLines);

  const res = new THREE.Vector2(window.innerWidth, window.innerHeight);
  hoverLine = new LineSegments2(new LineSegmentsGeometry(), new LineMaterial({ color: 0xffffff, linewidth: 2.5, transparent: true, opacity: 0.95, depthTest: false, resolution: res }));
  selectLine = new LineSegments2(new LineSegmentsGeometry(), new LineMaterial({ color: 0xffb347, linewidth: 3.5, transparent: true, opacity: 1, depthTest: false, resolution: res }));
  hoverLine.visible = selectLine.visible = false;
  hoverLine.renderOrder = selectLine.renderOrder = 5;
  scene.add(hoverLine, selectLine);
  selectFill = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.22, depthWrite: false }));
  selectFill.rotation.x = -Math.PI / 2;
  selectFill.position.y = 0.05;
  selectFill.visible = false;
  selectFill.renderOrder = 3;
  scene.add(selectFill);
}
function setLineFromPolys(line, polys, y = 0.12) {
  const arr = [];
  for (const poly of polys || []) {
    if (!poly || poly.length < 3) continue;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      arr.push(a[0], y, -a[1], b[0], y, -b[1]);
    }
  }
  if (!arr.length) { line.visible = false; return; }
  line.geometry.dispose();
  line.geometry = new LineSegmentsGeometry().setPositions(arr);
  line.computeLineDistances();
  line.visible = true;
}
function setFillFromPolys(mesh, polys) {
  const geos = (polys || []).filter((p) => p && p.length >= 3).map((p) => new THREE.ShapeGeometry(new THREE.Shape(p.map((q) => new THREE.Vector2(q[0], q[1])))));
  if (!geos.length) { mesh.visible = false; return; }
  mesh.geometry.dispose();
  mesh.geometry = geos.length === 1 ? geos[0] : BufferGeometryUtils.mergeGeometries(geos, false);
  mesh.visible = true;
}
function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function lotAt(x, y) {
  for (const l of state.lots) {
    if (x < l.minx || x > l.maxx || y < l.miny || y > l.maxy) continue;
    if (pointInPoly(x, y, l.poly)) return l;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Trees (procedural, instanced)
// ---------------------------------------------------------------------------
function colorize(geoIn, hex) {
  const geo = geoIn.index ? geoIn.toNonIndexed() : geoIn;   // polyhedra are non-indexed; merge needs uniform attributes
  geo.deleteAttribute('uv');
  const c = new THREE.Color(hex);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}
function treeGeometry(kind, h, w) {
  const parts = [];
  if (kind === 'palm') {
    const trunkH = h * 0.72;
    parts.push(colorize(new THREE.CylinderGeometry(0.16, 0.3, trunkH, 6).translate(0, trunkH / 2, 0), 0x7a5a3a));
    const n = 7;
    for (let i = 0; i < n; i++) {
      const f = new THREE.PlaneGeometry(w * 0.22, h * 0.42, 1, 2);
      f.translate(0, h * 0.21, 0).rotateX(-1.15).rotateY((i / n) * Math.PI * 2 + 0.3).translate(0, trunkH, 0);
      parts.push(colorize(f, i % 2 ? 0x4c8f3a : 0x5aa347));
    }
    parts.push(colorize(new THREE.SphereGeometry(w * 0.09, 6, 5).translate(0, trunkH, 0), 0x4c8f3a));
  } else if (kind === 'pine') {
    const trunkH = h * 0.3;
    parts.push(colorize(new THREE.CylinderGeometry(0.15, 0.28, trunkH, 6).translate(0, trunkH / 2, 0), 0x6e4f34));
    parts.push(colorize(new THREE.ConeGeometry(w * 0.5, h * 0.42, 7).translate(0, trunkH + h * 0.21, 0), 0x2f6b3a));
    parts.push(colorize(new THREE.ConeGeometry(w * 0.38, h * 0.36, 7).translate(0, trunkH + h * 0.5, 0), 0x38773f));
    parts.push(colorize(new THREE.ConeGeometry(w * 0.24, h * 0.3, 7).translate(0, trunkH + h * 0.72, 0), 0x3f8245));
  } else {
    const trunkH = h * 0.38;
    parts.push(colorize(new THREE.CylinderGeometry(0.22, 0.36, trunkH, 6).translate(0, trunkH / 2, 0), 0x6b4d33));
    parts.push(colorize(new THREE.IcosahedronGeometry(w * 0.5, 1).scale(1, 0.85, 1).translate(0, trunkH + h * 0.28, 0), 0x4a8a3c));
    parts.push(colorize(new THREE.IcosahedronGeometry(w * 0.36, 1).translate(w * 0.18, trunkH + h * 0.42, -w * 0.1), 0x58994a));
    parts.push(colorize(new THREE.IcosahedronGeometry(w * 0.32, 1).translate(-w * 0.2, trunkH + h * 0.4, w * 0.12), 0x3f7f35));
  }
  const merged = BufferGeometryUtils.mergeGeometries(parts, false);
  merged.computeBoundingSphere();
  return merged;
}
// Trees: impostor cards rendered in Blender from the scene's own tree assets (front / side / top views in one atlas,
// see tools/blender_trees.py). Falls back to procedural low-poly trees if the atlases are missing.
function impostorGeometry(m, topFrac) {
  // Blender places a collection instance so that its instance_offset sits on the empty: subtract it from the render frame
  const off = m.offset || [0, 0, 0];
  const S = m.ortho, cx = m.center[0] - off[0], cy = m.center[1] - off[1], z0 = m.min[2] - off[2], zTop = z0 + m.size[2] * topFrac;
  const pos = [], uv = [], idx = [];
  const quad = (p, u0, u1) => {   // p = [bl, br, tr, tl] in three.js coordinates; both windings so the card is visible from either side
    const b = pos.length / 3;
    for (const c of p) pos.push(...c);
    uv.push(u0, 0, u1, 0, u1, 1, u0, 1);
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3, b, b + 2, b + 1, b, b + 3, b + 2);
  };
  quad([[cx - S / 2, z0, -cy], [cx + S / 2, z0, -cy], [cx + S / 2, z0 + S, -cy], [cx - S / 2, z0 + S, -cy]], 0, 1 / 3);                                   // front (image u -> +X)
  quad([[cx, z0, -(cy - S / 2)], [cx, z0, -(cy + S / 2)], [cx, z0 + S, -(cy + S / 2)], [cx, z0 + S, -(cy - S / 2)]], 1 / 3, 2 / 3);                       // side (image u -> Blender +Y)
  quad([[cx - S / 2, zTop, -(cy - S / 2)], [cx + S / 2, zTop, -(cy - S / 2)], [cx + S / 2, zTop, -(cy + S / 2)], [cx - S / 2, zTop, -(cy + S / 2)]], 2 / 3, 1); // top (image v -> Blender +Y)
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}
async function buildTrees(data) {
  let meta = null;
  try { meta = await loadJson('assets/trees/meta.json'); } catch { meta = null; }
  const groups = data.species.map((s, i) => ({ s, i, items: [] }));
  if (!paved) buildPavedGrid();
  const extra = scatterParkTrees(data);
  state.parkTrees = extra.length;
  data.trees.concat(extra).forEach((tr) => groups[tr.s]?.items.push(tr));
  const tmp = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), sc = new THREE.Vector3(), ax = new THREE.Vector3(0, 1, 0);
  for (const g of groups) {
    if (!g.items.length) continue;
    const name = g.s.name.toLowerCase();
    const kind = name.includes('palm') ? 'palm' : name.includes('pine') ? 'pine' : 'acer';
    let geo, mat;
    if (meta && meta[kind]) {
      geo = impostorGeometry(meta[kind], kind === 'palm' ? 0.82 : kind === 'pine' ? 0.6 : 0.62);
      const tex = loadTex(`assets/trees/${kind}.webp`);
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      mat = new THREE.MeshBasicMaterial({ map: tex, alphaTest: 0.45, side: THREE.FrontSide, color: 0xd6d6d6 });
    } else {
      const h = Math.max(g.s.size[2], 3), w = Math.max(Math.min(g.s.size[0], g.s.size[1]) * 0.9, 2);
      geo = treeGeometry(kind === 'acer' ? 'broadleaf' : kind, h, w);
      mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, side: THREE.DoubleSide });
    }
    const im = new THREE.InstancedMesh(geo, mat, g.items.length);
    im.frustumCulled = false;
    im.castShadow = true;
    g.items.forEach((tr, k) => {
      q.setFromAxisAngle(ax, THREE.MathUtils.degToRad(tr.r));
      v.set(tr.p[0], tr.p[2], -tr.p[1]);
      sc.set(tr.sc, tr.sz, tr.sc);
      im.setMatrixAt(k, tmp.compose(v, q, sc));
      const j = 0.9 + ((k * 7919) % 100) / 500;
      im.setColorAt(k, new THREE.Color(j, j * (0.97 + ((k * 31) % 7) / 100), j * 0.95));
    });
    im.instanceMatrix.needsUpdate = true;
    im.instanceColor.needsUpdate = true;
    treeGroup.add(im);
  }
}

// ---------------------------------------------------------------------------
// Picking
// ---------------------------------------------------------------------------
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let pointerDown = null;
function pick(ev) {
  const r = renderer.domElement.getBoundingClientRect();
  pointer.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(proxies, false);
  if (hits.length) {
    const im = hits[0].object;
    const h = im.userData.houses[hits[0].instanceId];
    if (h && isVisibleHouse(h)) return h;
  }
  const g = raycaster.intersectObject(pickPlane, false);
  if (g.length) {
    const p = g[0].point;
    const lot = lotAt(p.x, -p.z);
    if (lot) {
      const h = state.lotByHouse.get(lot.id);
      if (h && isVisibleHouse(h)) return h;
      if (!lot.hasHouse && (lot.hidden || lot.area_m2 > 60)) return lot;
    }
  }
  return null;
}
const tooltip = document.getElementById('tooltip');
function setHover(obj, ev) {
  if (obj !== state.hovered) {
    state.hovered = obj;
    if (obj) setLineFromPolys(hoverLine, obj.isHouse ? obj.lotPolys : [obj.poly], 0.1); else hoverLine.visible = false;
    renderer.domElement.style.cursor = obj ? 'pointer' : '';
    if (obj) tooltip.innerHTML = tooltipHtml(obj);
    tooltip.classList.toggle('show', !!obj);
  }
  if (obj && ev) { tooltip.style.left = `${ev.clientX + 16}px`; tooltip.style.top = `${ev.clientY + 16}px`; }
}
function tooltipHtml(o) {
  if (o.isHouse) {
    const ty = TYPES[o.type], st = statusOf(o);
    return `<b>${t('lot')} ${o.code}</b> · <span class="dot" style="background:${STATUS[st].hex}"></span>${STATUS[st].label[state.lang]}<br><span class="dot" style="background:${ty.hex}"></span>${ty.label[state.lang]} · ${o.prop?.planName || ''} · ${ty.beds} ${t('beds')} · ${ty.baths} ${t('baths')}${ty.units > 1 ? ` (${t('perUnit')})` : ''}<br><span class="muted">${t('parcel')} ${o.parcel} · ${fmt(o.lotArea * SQFT_PER_M2)} ${t('sqft')} · ${fmt(o.lotArea)} ${t('sqm')}</span>`;
  }
  return `<b>${t('lot')} ${o.name}</b><br><span class="muted">${o.hidden ? t('openSpace') : t('freeLot')} · ${fmt(o.area_m2 * SQFT_PER_M2)} ${t('sqft')} · ${fmt(o.area_m2)} ${t('sqm')}</span>`;
}
renderer.domElement.addEventListener('pointermove', (ev) => { if (state.flying) return; setHover(pick(ev), ev); });
renderer.domElement.addEventListener('pointerleave', () => setHover(null));
renderer.domElement.addEventListener('pointerdown', (ev) => { pointerDown = { x: ev.clientX, y: ev.clientY, t: performance.now() }; });
renderer.domElement.addEventListener('pointerup', (ev) => {
  if (!pointerDown) return;
  const moved = Math.hypot(ev.clientX - pointerDown.x, ev.clientY - pointerDown.y);
  const dt = performance.now() - pointerDown.t;
  pointerDown = null;
  if (moved > 6 || dt > 600 || ev.button !== 0) return;
  const obj = pick(ev);
  if (obj && obj.isHouse) select(obj, true);
  else if (!obj) { /* click on nothing keeps the selection */ }
});

// ---------------------------------------------------------------------------
// Selection + camera
// ---------------------------------------------------------------------------
function houseWorldCenter(h) {
  const info = modelInfo[h.model];
  return info.center.clone().applyMatrix4(h.matrix);
}
function houseFrontDir(h) {
  const info = modelInfo[h.model];
  return info.front.clone().transformDirection(h.matrix).normalize();
}
function select(h, fly = true) {
  state.selected = h;
  setLineFromPolys(selectLine, h.lotPolys, 0.14);
  setFillFromPolys(selectFill, h.lotPolys);
  renderPanel(h);
  try { history.replaceState(null, '', `#${h.pid ? 'p-' + h.pid.replace(/^LH_/, '') : 'casa-' + h.num}`); } catch { /* sandboxed page */ }
  if (fly) flyToHouse(h);
}
// reserved / sold lots get a permanent coloured outline in the scene
let statusLines = null;
function buildStatusLines() {
  const pos = [], col = [];
  for (const h of state.houses) {
    const st = statusOf(h);
    if (st === 'available') continue;
    const c = new THREE.Color(STATUS[st].hex);
    for (const poly of h.lotPolys) {
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        pos.push(a[0], 0.13, -a[1], b[0], 0.13, -b[1]);
        col.push(c.r, c.g, c.b, c.r, c.g, c.b);
      }
    }
  }
  if (!statusLines) {
    statusLines = new LineSegments2(new LineSegmentsGeometry(), new LineMaterial({ vertexColors: true, linewidth: 3, transparent: true, opacity: 0.95, depthTest: false, resolution: new THREE.Vector2(window.innerWidth, window.innerHeight) }));
    statusLines.renderOrder = 4;
    scene.add(statusLines);
  }
  statusLines.visible = pos.length > 0;
  if (pos.length) {
    statusLines.geometry.dispose();
    statusLines.geometry = new LineSegmentsGeometry().setPositions(pos).setColors(col);
    statusLines.computeLineDistances();
  }
}
function clearSelection() {
  state.selected = null;
  selectLine.visible = selectFill.visible = false;
  document.getElementById('panel').classList.remove('open');
  try { history.replaceState(null, '', location.pathname + location.search); } catch { /* sandboxed page */ }
}
function flyToHouse(h) {
  const center = houseWorldCenter(h);
  const front = houseFrontDir(h);
  const up = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(front, up).normalize();
  const info = modelInfo[h.model];
  const d = Math.max(info.size.x, info.size.z) * 1.9;
  const pos = center.clone().addScaledVector(front, d).addScaledVector(right, d * 0.42).addScaledVector(up, d * 0.62);
  const target = center.clone().setY(center.y - info.size.y * 0.2);
  // keep the house clear of the detail panel: on desktop shift the view so the house sits in the left two thirds,
  // on phones (bottom sheet) lift the house into the upper part of the screen
  const panelW = document.getElementById('panel').offsetWidth || 380;
  const viewDir = new THREE.Vector3().subVectors(target, pos).normalize();
  if (IS_PHONE()) {
    const camUp = up.clone().addScaledVector(viewDir, -up.dot(viewDir)).normalize();
    const shift = d * 0.2;
    pos.addScaledVector(viewDir, -d * 0.35);   // a little further back: the visible strip above the sheet is small
    pos.addScaledVector(camUp, -shift);
    target.addScaledVector(camUp, -shift);
  } else if (window.innerWidth > 900) {
    const camRight = viewDir.clone().cross(up).normalize();
    const shift = d * 0.55 * (panelW / window.innerWidth);
    pos.addScaledVector(camRight, shift);
    target.addScaledVector(camRight, shift);
  }
  flyTo(pos, target, 1500);
}
let flight = null;
function flyTo(pos, target, dur = 1400) {
  flight = { p0: camera.position.clone(), t0: controls.target.clone(), p1: pos, t1: target, start: performance.now(), dur };
  state.flying = true;
  controls.enabled = false;
  setHover(null);
}
function updateFlight(now) {
  if (!flight) return;
  const k = Math.min(1, (now - flight.start) / flight.dur);
  const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
  camera.position.lerpVectors(flight.p0, flight.p1, e);
  controls.target.lerpVectors(flight.t0, flight.t1, e);
  camera.lookAt(controls.target);
  if (k >= 1) { flight = null; state.flying = false; controls.enabled = true; controls.update(); }
}
function siteCenter() {
  const b = state.data.bounds;
  return b2t((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, 0);
}
function setOverview(instant = false) {
  const c = siteCenter();
  // portrait phones need a higher, more distant viewpoint to fit the whole site between the header and the legend
  const portrait = window.innerHeight > window.innerWidth;
  const target = c.clone().add(new THREE.Vector3(0, 0, portrait ? -80 : -30));
  const pos = c.clone().add(portrait ? new THREE.Vector3(-30, 900, 760) : new THREE.Vector3(-60, 500, 610));
  if (instant) { camera.position.copy(pos); controls.target.copy(target); controls.update(); }
  else flyTo(pos, target, 1600);
}
function setTopView() {
  const target = state.selected ? houseWorldCenter(state.selected).setY(0) : siteCenter();
  const h = state.selected ? 120 : 1150;
  flyTo(target.clone().add(new THREE.Vector3(0, h, 0.01)), target, 1400);
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
function setupUI() {
  applyI18n();
  $('btn-overview').onclick = () => { clearSelection(); setOverview(false); };
  $('btn-top').onclick = () => setTopView();
  $('btn-colortype').onclick = () => { state.colorByType = !state.colorByType; $('btn-colortype').classList.toggle('active', state.colorByType); refreshFacadeColors(); };
  $('btn-ao').classList.toggle('active', state.ao);
  $('btn-ao').onclick = () => { state.ao = !state.ao; $('btn-ao').classList.toggle('active', state.ao); };
  $('btn-lang').onclick = () => { state.lang = state.lang === 'en' ? 'pt' : 'en'; applyI18n(); if (state.selected) renderPanel(state.selected); };
  $('panel-close').onclick = () => clearSelection();
  $('panel-fly').onclick = () => state.selected && flyToHouse(state.selected);
  $('panel-prev').onclick = () => step(-1);
  $('panel-next').onclick = () => step(1);
  buildLegend();
  const search = $('search'), results = $('search-results');
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase().replace(/^(casa|house|lot|lote|terrenos?)\s*/, '').replace(/\s+/g, '');
    results.innerHTML = '';
    if (!q) { results.classList.remove('show'); return; }
    const found = state.houses.filter((h) => h.num.includes(q) || h.code.toLowerCase().replace(/\s+/g, '').includes(q) || h.lotNum.toLowerCase().replace(/\s+/g, '').includes(q) || h.lotIndex.includes(q) || h.num === q.padStart(3, '0') || (h.pid && h.pid.toLowerCase().includes(q))).slice(0, 8);
    results.innerHTML = found.length ? found.map((h) => `<div data-id="${h.id}"><b>${t('lot')} ${h.code}</b> · ${t('house')} ${h.num} <span class="dot" style="background:${TYPES[h.type].hex}"></span>${TYPES[h.type].label[state.lang]} <span class="dot" style="background:${STATUS[statusOf(h)].hex}"></span></div>`).join('') : `<div class="muted">${t('noResults')}</div>`;
    results.classList.add('show');
  });
  results.addEventListener('click', (ev) => {
    const id = ev.target.closest('[data-id]')?.dataset.id;
    if (!id) return;
    results.classList.remove('show'); search.value = '';
    const h = state.byId.get(id);
    if (h) { state.activeTypes.add(h.type); state.activeParcels.add(h.parcel); applyFilter(); buildLegend(); select(h, true); }
  });
  // property panel v2: lightbox, sheet toggle, sales actions
  $('panel-expand').onclick = () => $('panel').classList.toggle('expanded');
  const openLightbox = () => { if (!state.selected) return; $('lightbox-img').src = $('panel-plan').src; $('lightbox-caption').textContent = $('panel-plan-name').textContent; $('lightbox').hidden = false; };
  $('plan-expand').onclick = openLightbox;
  $('panel-plan').onclick = openLightbox;
  $('lightbox').onclick = (ev) => { if (ev.target.id === 'lightbox' || ev.target.classList.contains('lb-close')) $('lightbox').hidden = true; };
  $('modal').onclick = (ev) => { if (ev.target.id === 'modal' || ev.target.classList.contains('modal-close')) closeModal(); };
  $('btn-interest').onclick = () => state.selected && openLeadForm(state.selected);
  $('btn-reserve').onclick = () => state.selected && openStatusChange(state.selected, statusOf(state.selected) === 'reserved' ? 'release' : 'reserve');
  $('btn-sold').onclick = () => state.selected && openStatusChange(state.selected, statusOf(state.selected) === 'sold' ? 'release' : 'sold');
  $('btn-night').onclick = () => setNight(!state.night);
  $('btn-map').onclick = () => openRegionMap();
  document.querySelector('.map-close').onclick = () => { $('map-modal').hidden = true; };
  $('map-modal').onclick = (ev) => { if (ev.target.id === 'map-modal') $('map-modal').hidden = true; };
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      if (!$('lightbox').hidden) { $('lightbox').hidden = true; return; }
      if (!$('modal').hidden) { closeModal(); return; }
      if (!$('map-modal').hidden) { $('map-modal').hidden = true; return; }
      clearSelection(); results.classList.remove('show');
    }
    if (ev.target === search) return;
    if (ev.key === 'ArrowRight' && state.selected) step(1);
    if (ev.key === 'ArrowLeft' && state.selected) step(-1);
  });
}
function step(dir) {
  if (!state.selected) return;
  const list = state.houses.filter(isVisibleHouse);
  const i = list.indexOf(state.selected);
  const next = list[(i + dir + list.length) % list.length];
  select(next, true);
}
function buildLegend() {
  const el = $('legend-items');
  const counts = {};
  state.houses.forEach((h) => { counts[h.type] = (counts[h.type] || 0) + 1; });
  el.innerHTML = Object.entries(TYPES).map(([k, ty]) => {
    const on = state.activeTypes.has(+k);
    return `<button class="chip ${on ? '' : 'off'}" data-type="${k}" title="${t('onlyType')}"><span class="dot" style="background:${ty.hex}"></span><span class="chip-label">${ty.label[state.lang]}</span><span class="chip-sub">${ty.beds}${state.lang === 'pt' ? 'q' : 'bd'} · ${ty.baths}${state.lang === 'pt' ? 'b' : 'ba'}${ty.units > 1 ? ' ×2' : ''}</span><span class="chip-count">${counts[k] || 0}</span></button>`;
  }).join('') + `<button class="chip all" id="chip-all">${t('showAll')}</button>`;
  el.querySelectorAll('.chip[data-type]').forEach((b) => {
    b.onclick = (ev) => {
      const k = +b.dataset.type;
      if (ev.shiftKey || ev.altKey) { if (state.activeTypes.has(k) && state.activeTypes.size > 1) state.activeTypes.delete(k); else state.activeTypes.add(k); }
      else if (state.activeTypes.size === 1 && state.activeTypes.has(k)) state.activeTypes = new Set([1, 2, 3, 4]);
      else state.activeTypes = new Set([k]);
      if (state.selected && !state.activeTypes.has(state.selected.type)) clearSelection();
      applyFilter(); buildLegend();
    };
  });
  $('chip-all').onclick = () => { state.activeTypes = new Set([1, 2, 3, 4]); applyFilter(); buildLegend(); };
  // parcels / phases
  const perParcel = {};
  state.houses.forEach((h) => { perParcel[h.parcel] = (perParcel[h.parcel] || 0) + 1; });
  const pel = $('parcel-items');
  pel.innerHTML = PARCELS.map((p) => `<button class="pchip ${state.activeParcels.has(p) ? '' : 'off'}" data-parcel="${p}">${p}<small>${perParcel[p] || 0}</small></button>`).join('');
  pel.querySelectorAll('.pchip').forEach((b) => {
    b.onclick = (ev) => {
      const p = b.dataset.parcel;
      if (ev.shiftKey || ev.altKey) state.activeParcels = new Set([p]);
      else if (state.activeParcels.has(p)) { if (state.activeParcels.size > 1) state.activeParcels.delete(p); }
      else state.activeParcels.add(p);
      if (state.selected && !isVisibleHouse(state.selected)) clearSelection();
      applyFilter(); buildLegend();
    };
  });
  // status legend
  const perStatus = { available: 0, reserved: 0, sold: 0 };
  state.houses.forEach((h) => { perStatus[statusOf(h)]++; });
  $('status-items').innerHTML = Object.entries(STATUS).map(([k, s]) => `<span class="schip"><span class="dot" style="background:${s.hex}"></span>${s.label[state.lang]} <b>${perStatus[k]}</b></span>`).join('');
}
function updateCounter() {
  const n = state.houses.filter(isVisibleHouse).length;
  $('count-houses').textContent = fmt(n);
  $('count-lots').textContent = fmt(state.lots.filter((l) => !l.hidden && l.area_m2 > 60).length);
}
function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
  $('btn-lang').textContent = state.lang === 'en' ? 'PT' : 'EN';
  $('btn-night').textContent = state.night ? t('day') : t('night');
  document.documentElement.lang = state.lang === 'pt' ? 'pt-BR' : 'en';
  buildLegend();
  updateCounter();
  if (regionMap) regionMap.refresh();
}
function renderPanel(h) {
  const ty = TYPES[h.type];
  const img = imageFor(h.kind, h.color);
  const imgColor = COLOR_LABEL[IMAGE_COLOR[img.index]] || IMAGE_COLOR[img.index];
  const c = state.data.colors[h.color] || [0.8, 0.8, 0.8];
  const swatch = new THREE.Color().setRGB(c[0], c[1], c[2], THREE.LinearSRGBColorSpace).getStyle();
  const gfa = ty.gfaSqft, roof = ty.roofSqft;
  const per = ty.units > 1 ? ` <small>(${t('perUnit')})</small>` : '';
  const st = statusOf(h), sinfo = state.status[h.pid] || {};
  const prop = h.prop || {};
  $('panel-img').src = imageUrl(`assets/img/house_${img.index}.jpg`);
  $('panel-img').alt = `${ty.label[state.lang]} — ${imgColor}`;
  $('panel-imgnote').textContent = img.exact ? t('imgExact') : `${t('imgNote')} ${imgColor}`;
  $('panel-title').textContent = `${t('lot')} ${h.code}`;
  const badge = $('panel-status'); badge.className = `status-badge ${st}`; badge.textContent = STATUS[st].label[state.lang];
  $('panel-sub').innerHTML = `${prop.planName ? `<b>${prop.planName}</b> · ` : ''}<span class="dot" style="background:${ty.hex}"></span>${ty.label[state.lang]} · ${t('parcel')} ${h.parcel}${prop.parcelInferred ? ` <span class="inferred-note">(${t('inferred')})</span>` : ''}`;
  $('panel-pid').textContent = h.pid || h.id;
  $('panel-updated').textContent = sinfo.updatedAt ? ` · ${t('lastUpdate')} ${new Date(sinfo.updatedAt).toLocaleDateString(state.lang === 'pt' ? 'pt-BR' : 'en-GB')}` : '';
  $('panel-body').innerHTML = `
    <div class="facts">
      <div class="fact"><span class="k">${t('houseModel')}</span><span class="v">${prop.planName || '–'} <em>${state.lang === 'pt' ? 'Opção' : 'Option'} ${state.registry?.plans?.[h.type]?.option ?? '–'} · ${h.kind === 'duplex' ? 'Duplex' : (state.lang === 'pt' ? 'Casa isolada' : 'Single house')}</em></span></div>
      <div class="fact"><span class="k">${state.lang === 'pt' ? 'Programa' : 'Layout'}</span><span class="v">${ty.beds} ${t('beds')} · ${ty.baths} ${t('baths')}${ty.units > 1 ? ` <em>2 ${t('units')}</em>` : ''}</span></div>
      <div class="fact"><span class="k">${t('gfa')}${per}</span><span class="v">${fmt(gfa)} ${t('sqft')} <em>${fmt(gfa / SQFT_PER_M2, 1)} ${t('sqm')}</em></span></div>
      <div class="fact"><span class="k">${t('roof')}${per}</span><span class="v">${fmt(roof)} ${t('sqft')} <em>${fmt(roof / SQFT_PER_M2, 1)} ${t('sqm')}</em></span></div>
      <div class="fact"><span class="k">${t('lotArea')}${h.lots.length > 1 ? ` <small>(${h.lots.length} ${t('lots')})</small>` : ''}</span><span class="v">${fmt(h.lotArea == null ? null : h.lotArea * SQFT_PER_M2)} ${t('sqft')} <em>${fmt(h.lotArea, 1)} ${t('sqm')}</em></span></div>
      <div class="fact"><span class="k">${t('facade')}</span><span class="v"><span class="swatch" style="background:${swatch}"></span>${COLOR_LABEL[h.color] || h.color}</span></div>
      <div class="fact wide"><span class="k">${t('model')}</span><span class="v">${h.id} · Casa ${h.model} · ${t('lot')} ${h.lotIndex.split(' ').join(' + ')}${h.prevLot ? ` <em>${state.lang === 'pt' ? 'lote anterior' : 'previous lot'}: ${h.prevLot.replace(/\D+/g, '')}</em>` : ''}</span></div>
    </div>
    <p class="source">${t('source')}</p>`;
  const plan = prop.plan || state.registry?.plans?.[h.type]?.file;
  $('panel-plan').src = plan ? imageUrl(`assets/plans/${plan}`) : '';
  $('panel-plan-name').textContent = plan ? `${prop.planName || ''} · ${ty.beds} ${t('beds')} · ${ty.baths} ${t('baths')}${ty.units > 1 ? ` · ${t('perUnit')}` : ''}` : '';
  // sales actions: reserve only while available; "sold" for staff; nothing writes without a backend
  const canWrite = api.hasBackend();
  $('btn-reserve').textContent = st === 'reserved' ? t('cancelReservation') : t('reserve');
  $('btn-sold').textContent = st === 'sold' ? t('release') : t('markSold');
  $('btn-reserve').disabled = !canWrite || st === 'sold';
  $('btn-sold').disabled = !canWrite;
  $('btn-reserve').title = canWrite ? '' : t('readOnly');
  $('btn-sold').title = canWrite ? '' : t('readOnly');
  $('panel').classList.add('open');
}

// ---------------------------------------------------------------------------
// Sales actions: lead form (I'm interested), reserve / sold with a staff password checked server-side
// ---------------------------------------------------------------------------
let toastTimer = null;
function toast(msg, ms = 3200) {
  const el = $('toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}
function openModal(html) { $('modal-content').innerHTML = html; $('modal').hidden = false; const f = $('modal').querySelector('input, textarea'); if (f) setTimeout(() => f.focus(), 50); }
function closeModal() { $('modal').hidden = true; $('modal-content').innerHTML = ''; }
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
function leadContext(h) {
  return { pid: h.pid, code: h.code, house: h.id, model: h.prop?.planName || `Casa ${h.model}`, type: TYPES[h.type].label.en, parcel: h.parcel, page: location.href, lang: state.lang, timestamp: new Date().toISOString() };
}
function openLeadForm(h) {
  const ctx = leadContext(h);
  openModal(`
    <h2>${t('leadTitle')}</h2>
    <p class="intro">${t('leadIntro')}</p>
    <div class="ref"><b>${t('lot')} ${esc(h.code)}</b> · ${esc(ctx.model)} · ${t('parcel')} ${esc(h.parcel)} · <code>${esc(h.pid)}</code></div>
    <form id="lead-form">
      <div class="field"><label for="lead-name">${t('name')}</label><input id="lead-name" name="name" required autocomplete="name" /></div>
      <div class="field"><label for="lead-email">${t('email')}</label><input id="lead-email" name="email" type="email" required autocomplete="email" /></div>
      <div class="field"><label for="lead-phone">${t('phone')}</label><input id="lead-phone" name="phone" type="tel" autocomplete="tel" /></div>
      <div class="field"><label for="lead-msg">${t('message')}</label><textarea id="lead-msg" name="message"></textarea></div>
      <div class="field hp" aria-hidden="true"><label for="lead-web">Website</label><input id="lead-web" name="website" tabindex="-1" autocomplete="off" /></div>
      <div class="form-msg" id="lead-msg-out"></div>
      <div class="modal-actions"><button type="button" class="btn ghost" id="lead-cancel">${t('cancel')}</button><button type="submit" class="btn primary" id="lead-send">${t('send')}</button></div>
    </form>`);
  $('lead-cancel').onclick = closeModal;
  $('lead-form').onsubmit = async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const lead = { ...ctx, name: fd.get('name'), email: fd.get('email'), phone: fd.get('phone'), message: fd.get('message'), website: fd.get('website') };
    const out = $('lead-msg-out'); const btn = $('lead-send');
    if (!api.hasBackend()) {
      // no server yet: hand the lead to the visitor's e-mail client with everything pre-filled
      const subject = `Legacy Heights - ${t('lot')} ${h.code} - ${lead.name}`;
      const body = `${t('interested')}: ${t('lot')} ${h.code} (${ctx.model}, ${t('parcel')} ${h.parcel})\nID: ${h.pid}\n\n${t('name')}: ${lead.name}\n${t('email')}: ${lead.email}\n${t('phone')}: ${lead.phone || '-'}\n\n${lead.message || ''}\n\n${ctx.page}`;
      window.location.href = `mailto:${BACKEND.salesEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      out.className = 'form-msg ok'; out.textContent = t('leadSent');
      setTimeout(closeModal, 1800);
      return;
    }
    btn.disabled = true; btn.textContent = t('sending'); out.className = 'form-msg'; out.textContent = '';
    try {
      await api.interest(lead);
      out.className = 'form-msg ok'; out.textContent = t('leadSent');
      setTimeout(closeModal, 1800);
    } catch (e) {
      out.className = 'form-msg err'; out.textContent = `${t('leadFailed')} ${BACKEND.salesEmail}`;
      btn.disabled = false; btn.textContent = t('send');
    }
  };
}
function openStatusChange(h, action) {
  if (!api.hasBackend()) { toast(t('readOnly')); return; }
  const title = action === 'reserve' ? t('reserve') : action === 'sold' ? t('markSold') : (statusOf(h) === 'reserved' ? t('cancelReservation') : t('release'));
  openModal(`
    <h2>${title}</h2>
    <p class="intro">${action === 'reserve' ? t('authIntro') : t('authIntroAdmin')}</p>
    <div class="ref"><b>${t('lot')} ${esc(h.code)}</b> · ${esc(h.prop?.planName || '')} · <code>${esc(h.pid)}</code></div>
    <form id="auth-form">
      <div class="field"><label for="auth-by">${t('name')}</label><input id="auth-by" name="by" autocomplete="name" /></div>
      <div class="field"><label for="auth-pw">${t('password')}</label><input id="auth-pw" name="password" type="password" required autocomplete="current-password" /></div>
      <div class="form-msg" id="auth-msg"></div>
      <div class="modal-actions"><button type="button" class="btn ghost" id="auth-cancel">${t('cancel')}</button><button type="submit" class="btn primary" id="auth-ok">${t('confirm')}</button></div>
    </form>`);
  $('auth-cancel').onclick = closeModal;
  $('auth-form').onsubmit = async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target); const out = $('auth-msg'); const btn = $('auth-ok');
    btn.disabled = true; btn.textContent = t('sending'); out.className = 'form-msg'; out.textContent = '';
    try {
      const fn = action === 'reserve' ? api.reserve : action === 'sold' ? api.markSold : api.release;
      const res = await fn(h.pid, h.code, fd.get('password'), fd.get('by'));
      if (res.statuses) state.status = res.statuses; else if (res.status) state.status[h.pid] = res.status;
      buildStatusLines(); buildLegend(); renderPanel(h);
      toast(action === 'reserve' ? t('reserveOk') : action === 'sold' ? t('soldOk') : t('releaseOk'));
      closeModal();
    } catch (e) {
      const msg = e.message === 'unauthorized' ? t('wrongPassword') : e.message === 'not-available' ? t('notAvailable') : e.message === 'throttled' ? t('throttled') : e.message === 'busy' ? t('busy') : t('networkError');
      out.className = 'form-msg err'; out.textContent = msg;
      btn.disabled = false; btn.textContent = t('confirm');
      if (e.message === 'not-available') refreshStatuses();
    }
  };
}
function setNight(on) {
  state.night = on;
  document.body.classList.toggle('night', on);
  $('btn-night').textContent = on ? t('day') : t('night');
  $('btn-night').classList.toggle('active', on);
  if (night) night.apply(on);
  if (cars) cars.setNight(on);
}
async function openRegionMap() {
  $('map-modal').hidden = false;
  if (!regionMap) {
    regionMap = createRegionMap({ canvas: $('map-canvas'), listEl: $('map-list'), meta: state.satMeta || {}, loadJson, imageUrl, t, lang: () => state.lang, siteBounds: state.data.bounds,
      onStatus: (busy) => { if (busy) $('map-list').innerHTML = `<div class="muted" style="padding:8px">${t('loading')}</div>`; } });
  }
  try { await regionMap.open(); } catch (e) { console.warn('region map failed', e); $('map-list').innerHTML = `<div class="muted" style="padding:8px">${t('networkError')}</div>`; }
}
function handleHash() {
  const p = location.hash.match(/p-([0-9a-f]{8,})/i);
  if (p) { const h = state.houses.find((x) => x.pid === `LH_${p[1]}`); if (h) { select(h, true); return; } }
  const m = location.hash.match(/casa-(\d+)/);
  if (!m) return;
  const h = state.byId.get(`Casa ${m[1].padStart(3, '0')}`);
  if (h) select(h, true);
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------
const compass = document.getElementById('compass');
let lastFrame = 0;
function animate(now) {
  requestAnimationFrame(animate);
  now = now || performance.now();
  const dt = lastFrame ? (now - lastFrame) / 1000 : 0.016;
  lastFrame = now;
  updateFlight(now);
  if (cars) cars.update(dt);
  if (night) night.update();
  if (controls.enabled) controls.update();
  rebuildInstances();
  camera.updateMatrixWorld();
  if (csm) csm.update();
  compass.style.transform = `rotate(${THREE.MathUtils.radToDeg(controls.getAzimuthalAngle())}deg)`;
  if (state.ao && composer) composer.render(); else renderer.render(scene, camera);
}
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (composer) composer.setSize(window.innerWidth, window.innerHeight);
  if (csm) csm.updateFrustums();
  const res = new THREE.Vector2(window.innerWidth, window.innerHeight);
  if (hoverLine) { hoverLine.material.resolution.copy(res); selectLine.material.resolution.copy(res); }
  if (statusLines) statusLines.material.resolution.copy(res);
});

window.__app = { scene, camera, renderer, controls, state, houseGroups, proxies, modelInfo, select, flyTo, setOverview, SUN_DIR, MATS, setNight, openRegionMap, get night() { return night; }, get cars() { return cars; }, get regionMap() { return regionMap; }, get csm() { return csm; }, get composer() { return composer; }, get gtao() { return gtao; } };

init().catch((err) => {
  console.error(err);
  document.getElementById('loading-text').textContent = `Error: ${err.message}`;
});
