# Legacy Heights · Interactive 3D masterplan

Static site (three.js, no build step). Everything the browser needs is in this folder.

## Run locally

Any static server works. Because the page loads modules and GLB files with `fetch`, it cannot be opened directly as `file://`.

```bash
# option 1 (Python, already on this machine)
python -m http.server 5173 --directory "G:\Meu Drive\01 - PROJETOS\CLIENTES\UNK\BARBADOS\LEGACY\SITE"

# option 2 (Node)
npx serve "G:\Meu Drive\01 - PROJETOS\CLIENTES\UNK\BARBADOS\LEGACY\SITE"
```

Then open http://localhost:5173

## Sharing: single-file build

`python tools/build_single_html.py` writes `dist/legacy-heights.html` (about 14 MB): the whole site in one HTML file with
every asset embedded as base64 (reduced satellite levels, 512 px HDRI, quantized models, the six houses merged into one
GLB). It needs no server: it can be published as a private Claude artifact, sent by e-mail/drive, or dropped on any host.
three.js still comes from jsdelivr, so the viewer needs internet access. `dist/preview.html` is the same page wrapped in
a full HTML document for local testing. Rebuild it after changing anything in `src/`, `data/` or `dist/assets/`.

## Deploy

Upload the folder as-is to Netlify (drag and drop), Vercel, Cloudflare Pages, GitHub Pages or any web host.
three.js and the Draco decoder are loaded from jsdelivr, so the page needs internet access.

## Structure

| Path | What it is |
| --- | --- |
| `index.html`, `styles.css` | Page shell and UI |
| `src/main.js` | three.js scene, instancing, picking, camera flights, panel |
| `src/config.js` | House types (areas from the RGA drawings), colour names, image mapping, UI texts EN/PT |
| `data/site.json` | Exported from Blender: 604 houses (lot, model, PDF pattern, facade colour, transform), 676 lot polygons + areas, 703 trees |
| `assets/models/ground.glb` | Whole ground (lots, roads, sidewalks, parks, hedges) merged, Draco compressed |
| `assets/models/house_1..6.glb` | The six house bodies (decimated, facade material named `FACADE` so it can be tinted per house). Face windings are mixed in the source, so the site renders them double-sided and recomputes normals at load |
| `assets/img/house_N.jpg` | Reference renders (1 Caramel Cloud single, 2 Isle Dreams duplex, 3 Oak Tone single, 4 Marzipan single, 5 In the Blue duplex, 6 Pinkathon duplex) |

## Updating from Blender

1. Run `tools/blender_export.py` inside the open Blender file (Text Editor > Run Script) or headless:
   `blender -b Legacy_Heights_REV05.blend --python tools/blender_export.py`.
   It rewrites `assets/models/ground.glb`, `assets/models/house_1..6.glb` (raw, with PNG textures) and `data/site.json`
   without saving or changing the `.blend`. Existing official lot labels in `site.json` are carried over.
2. Run `tools/optimize_models.bat` (needs Node.js): renames the facade material to `FACADE` and recompresses the houses
   (WebP textures, Draco) — from ~2 MB to ~250 KB each.

House data comes from the custom properties on each house instance (`lotes`, `modelo`, `padrao_pdf`, `cor_fachada`).
PDF pattern -> type: `azul` = Type 3 (3-bed 2-bath), `verde` = Type 1 (2-bed 2-bath), `lilas` = Type 2 (3-bed 1-bath), `ouro` = Type 4 duplex.

## Official lot numbers (A-20, B-30 …)

The PDF plan has no text layer (the CAD text is outlined), so `tools/pdf_lot_labels.py` reads the "LOT X-NN" labels from the
vector strokes of `2504-02D-OVERALL SUB.pdf`, georeferences them (1:1250 on A1) and matches them to the Blender lot polygons.
Result: `data/lot_labels.json` (Blender lot id -> label), merged into `data/site.json` as `lots[id].label`.
631 of the 645 lots on the plan were matched automatically; `tools/label_overrides.json` holds the hand-checked fixes and
merged lots (`H-98/H-99`, `F-83/F-84`, `H-101/H-102/H-103`, `Parcel J`). Lots without a label fall back to the Blender lot index.
Known ambiguity: the plan draws lots F-19 to F-24 twice; the second copies (Blender lots 169, 170, 171, 356, 368) were left unlabelled.

## Satellite background and ground textures

`assets/map/sat_near|mid|far.jpg` are Esri World Imagery tiles (zoom 19 / 17 / 15) stitched by `tools/fetch_tiles.py`
around the site (13.0908 N, 59.4990 W). `tools/georef.py` ties the Blender model to the Barbados National Grid (EPSG:21292)
through the grid reference point printed on the plan (36607.39 mE / 65041.85 mN) and writes the image corners in model
coordinates into `assets/map/sat_meta.json`; `src/main.js` draws them as three ground quads under the site.
The imagery credit ("Esri, Maxar, Earthstar Geographics") must stay visible. Google Maps imagery was not used because its
terms do not allow the tiles to be used as a WebGL texture outside the Maps SDK.

Ground materials (`assets/tex/`) are Poly Haven CC0 textures (asphalt_01, leafy_grass recoloured to lawn green,
concrete_pavement), mapped in metres with planar UVs generated at load time. Road markings stay a flat white material.

## Horizon, hedges

- Four satellite levels are stacked (`near` 1.2 km, `mid` 2.4 km, `far` 9.5 km, `vast` 38 km = the whole island) plus a
  sea plane beyond; they are drawn first without depth writes so they never z-fight. The dark ESRI ocean in the two far
  levels was recoloured to sea blue (`tools/fetch_vast.py` fetches the island level; originals kept as `*_orig.jpg`).
  Fog is only a light haze (4-26 km), so the coast and the sea stay visible from the site.
- Hedges: the modelled hedges are shown 28 % lower (~1 m). At load, `completeHedges()` audits every lot boundary
  (2071 edges): street fronts and the shared edge under a duplex are skipped, and uncovered side/back runs get a hedge box
  (75 segments, ~1.1 km on the current model). The report is in `state.hedgeReport` (browser console: `__app.state.hedgeReport`).

## Lighting, trees, curbs

- Lighting: `assets/env/sky_1k.hdr` (Poly Haven "kloofendal_48d_partly_cloudy_puresky", CC0) is the visible sky and the
  image-based light. The sun direction is read from the brightest texel of the HDRI; a 3-cascade shadow map (three.js CSM)
  follows it. The HDRI copy used for lighting has its sun disc clamped, otherwise the direct sun would be baked into the
  ambient light and shadows would vanish. GTAO ambient occlusion runs as a post-process (toggle "AO", off on touch devices).
- Ground materials blend two scales of each texture through low-frequency noise (`antiTiling` in `src/main.js`) so no
  repetition shows from above. Tile sizes are in the `TILE` map (metres).
- Trees: `assets/trees/{acer,palm,pine}.webp` are front / side / top renders of the scene's own tree assets
  (`tools/blender_trees.py`, run inside the open Blender file); the site draws them as three crossed cards per tree.
  `meta.json` carries each collection's Blender `instance_offset` (the trunk base) — without it every tree lands
  ~20-30 m away from its empty. Extra trees are scattered inside the open-space lots at load time (`scatterParkTrees`),
  kept off paths/roads by a 1 m occupancy grid of the paved surfaces.
- Ground export: use `tools/headless_ground.py` (`blender -b file.blend --python tools/headless_ground.py`). It exports
  Blender's loop triangles and flips downward-facing triangles; the park surfaces from SketchUp face down and are
  otherwise culled (they showed the satellite photo through). Bump `ASSET_V` in `src/main.js` after regenerating assets.
- Curbs: `assets/models/curbs.glb` is the hidden "Meios-fios instanciados" geometry-nodes object realised by
  `tools/headless_curbs.py` (15 cm curb between road at 0.00 and sidewalk at 0.15).

## Adding more reference renders

Drop a new file in `assets/img/` and add it to `IMAGES` in `src/config.js`, keyed by body kind (`single` / `duplex`) and facade colour name. The panel picks the exact kind+colour render when it exists, otherwise a render of the same kind.

## Deep links

`index.html#casa-042` opens the page on house 042.
