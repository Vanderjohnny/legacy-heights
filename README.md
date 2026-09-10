# Legacy Heights · Interactive 3D masterplan

Static site (three.js, no build step). Everything the browser needs is in this folder.
Public site: **https://vanderjohnny.github.io/legacy-heights/**

## Run locally

The page loads ES modules and GLB files with `fetch`, so it cannot be opened as `file://`. Use the dev server:

```bash
python tools/dev_server.py
```

It serves this folder on http://localhost:5173 with caching disabled and exposes a **mock of the sales backend** at
`/api` (in-memory, passwords `reserve123` / `admin123`, or the `LH_RESERVE_PASSWORD` / `LH_ADMIN_PASSWORD` env vars).
Open `http://localhost:5173/?backend=http://localhost:5173/api` to test the Reserve / Sold / lead flows without Google.
Any other static server works for the read-only site (`python -m http.server 5173`, `npx serve`).

## What the site does

- 605 houses on 651 lots, instanced with two levels of detail; click a house to fly to it. Search by lot (A-21), house
  number or property ID. Filters by house type and by **parcel / phase (A–H)**, independent of each other.
- **Property panel**: status badge, lot code, model name (Altura / Horizon / Pinnacle / Vista), parcel, property ID,
  areas (sq ft / sq m), facade colour, reference render, **floor plan** with enlarge/fullscreen, previous/next navigation.
- **Sales status** (AVAILABLE / RESERVED / SOLD) shown in the panel, the tooltip, the legend counters and as coloured lot
  outlines in the scene. The status chips in the legend filter the houses shown (shift-click: only that status) and
  "By phase" opens the available / reserved / sold counts per parcel. Reserve, Mark as sold and Release ask for a
  password that is checked **server-side**
  (see *Sales backend*). "I'm interested" sends a lead to the sales team (never blocks the property).
- **Time of day** (button Day/Night animates it, slider in the legend): the global lighting of the world and of the
  houses changes continuously (sun -> low orange sun -> moonlight, sky dome day -> dusk -> night with moon and stars,
  image-based light, fog, exposure). After dusk ~245 streetlights come on (placed lot by lot along the street fronts,
  never in front of a driveway), with light pools and real point lights near the camera, and ~45 % of the houses show
  lit windows.
- **Cars**: seven slow cars drive on the left along the road centrelines (extracted from the dashed road paint), with
  headlights and light cones at night. The dashes stop before every junction, so `src/cars.js` builds a road graph:
  the centrelines are split where side streets meet them or where they cross, and the ends are joined by links found
  on the 1 m asphalt grid (A* keeping ~1.5-2 m from the curb, straightened by line of sight, corners rounded, then
  validated on the grid), so the cars turn at the corners (slowing down in the turn) instead of disappearing. Wide
  concrete junction tables count as road; sidewalks and driveways do not. Dead-end streets without room for a U-turn
  are never entered. `?carsdebug=1` draws the graph (blue centrelines, green links, red = dead ends). The body is
  `assets/models/car.glb`: the Audi A7 chosen in the Blender file, decimated to ~52k triangles and its ~60 materials
  consolidated into 9 (Paint, Glass, Lights, TailLight, Chrome, Rim, Black, Grey, Tyre) by the export script kept in
  `tools/blender_export_car.py`; the paint colour is randomised per car. If the GLB is missing the site falls back to
  a lofted low-poly hatchback built in `src/cars.js`.
- **Branding**: the header and the loading card show the Legacy Heights logotype (`assets/logo.png`, black ink on a
  transparent background, inverted by CSS at night) above the address line; a "Powered by UNK.GROUP" card below the
  legend (`assets/unk.png`) links to https://unk.group.
- **Phases gate**: only phase A is open when the page loads; the other phases show a lock in the legend and open a
  "Phase X · under construction" dialog asking for the access password. The password is checked by the sales backend
  (`unlock` action, or a harmless `release` probe on older deployments), never in the page; once accepted, every
  phase is shown for the rest of the browser session. `OPEN_PARCELS` in `src/config.js` lists the open phases.
- **House names**: the legend, tooltips and panel use the plan names (House Altura / Horizon / Pinnacle / Vista); the
  panel title reads "Lot A-21 · Pinnacle" and shows the phase, the plan, layout, areas and facade colour only.
- **Loading screen**: the aerial panorama of the site (`assets/img/loading.jpg`) with the logotype and a thin bar.
- **Language**: the public site is English only (`state.lang = 'en'`, no toggle); the Portuguese strings remain in
  `src/config.js` for a future switch.
- **Materials**: the ground uses PBR texture sets (Poly Haven, CC0, `tools/fetch_textures.py`: grass, asphalt,
  concrete). The houses keep their original colours and textures; a subtle plaster bump + roughness (facades), a
  corrugated-metal normal map across the ridge (roofs) and a concrete grain (base) are added through a second UV set
  box-projected in metres at load. At night the neighbouring areas show ~9,800 light points sampled from the bright,
  low-saturation pixels of the satellite imagery (roofs and roads), excluding the site and the sea.
- **Points of interest**: 53 places (airport emphasised, supermarkets, restaurants, hospitals/clinics, schools,
  pharmacies, parks, beaches) drawn as dots in the main 3D map; clicking one draws its driving route along the streets
  (OSRM geometry) with road distance and time, and frames it. The **Region** button opens the same places on a 2D
  satellite map with the list per category.
- **Parks**: the open-space lots (Blender "hidden" flag plus `PARK_LOTS` in `src/config.js`) are filled with trees,
  are not selectable and show no tooltip.
- **Airport**: `data/airport.json` (OpenStreetMap runway centreline / outline, aprons, terminal) drives the runway
  lighting at night (edge, centreline, threshold and approach lights, floodlit aprons and terminal, `src/night.js`)
  and two aircraft (`src/planes.js`): one landing on runway 09 from the sea and one taking off, on random cycles,
  with navigation lights, strobes and a landing light after dark.
- Responsive: desktop, tablet (narrower panel below the header), phone (bottom-sheet panel, chip legend).
- Deep links: `#p-<property id without LH_>` (also `#casa-042`).

## Property registry and stable IDs

Every house in Blender carries a `property_id` custom property (`LH_<uuid>`), exported into `data/site.json` (`pid`).
`tools/build_properties.py` builds `data/properties.json` from it: lot code (from the plan labels), parcel (letter of the
lot label, or inferred from the neighbours for the 16 lots without a letter — flagged `parcelInferred`), house model and
floor plan (`assets/plans/`, copied from `G:\Meu Drive\CODEX\SKETCHUP LEGACY\florrplans houses`). The mapping
type -> plan is explicit in that script: Type 1 = Altura (option 2), Type 2 = Horizon (option 3), Type 3 = Pinnacle
(option 4), Type 4 duplex = Vista (option 6); the ASCENT plan is kept as `extraPlans` and not assigned.
Status records are keyed by the property ID, so re-exporting the model never loses a reservation.

**Units.** What is sold is a unit: a single house is one unit, a semi-detached (duplex) body holds two, one per side,
because each side can be reserved or sold on its own. Two-lot duplexes use their two lots (codes A-19 / A-20); the
312 duplexes drawn on a single lot have that lot split along the party wall (the body's local X = 0) into
"B-12 A" / "B-12 B". Unit ids are `<property_id>` for singles and `<property_id>-1` / `-2` for the two sides; the
backend, the deep links (`#p-<hex>-1`) and the status sheet use these ids. 967 units in total.

## Sales backend (statuses, passwords, leads)

`tools/backend/Code.gs` is a Google Apps Script web app bound to a Google Sheet; `tools/backend/README.md` has the
10-minute deployment. It is the only place the passwords live (script properties) and the only writer of the status
sheet; two simultaneous reservations are serialised by a script lock, the second one is refused. The site talks to it
through `src/api.js` (`BACKEND.url` in `src/config.js` points at the deployment of 2026-09-10; the sheet is
*Legacy Heights - Vendas* on the client's Google account).
Without a backend URL the page runs **read-only**: statuses come from `data/status.json` (edit that file to publish a
status by hand) and the lead form falls back to a pre-filled e-mail to `BACKEND.salesEmail`.
`tools/backend/test_backend.py <url>` runs the happy, failure and concurrency tests against any deployment (18 checks).

## Sharing: single-file build

`python tools/build_single_html.py` writes `dist/legacy-heights.html` (about 10 MB): the whole site in one HTML file with
every asset embedded as base64 (reduced satellite levels, 512 px HDRI, the current Draco models, plans, photos, data).
It needs no server and can be published as a Claude artifact or sent by e-mail / drive. three.js still comes from
jsdelivr, so the viewer needs internet access. `dist/preview.html` is the same page wrapped in a full HTML document for
local testing (`http://localhost:5173/dist/preview.html`). Rebuild it after changing `src/`, `data/` or `dist/assets/`.

## Deploy

GitHub Pages, repository `github.com/Vanderjohnny/legacy-heights`, branch `main`, root folder. To update: copy the site
files into a clone of that repository (everything except `dist/`, `.claude/`, the `*_orig.jpg` backups and the unused
`*_thumb.jpg` files), commit and push; Pages redeploys in a minute or two. Keep `.nojekyll`. The folder also works as-is
on Netlify, Vercel, Cloudflare Pages or any web host.

## Structure

| Path | What it is |
| --- | --- |
| `index.html`, `styles.css`, `panel.css` | Page shell and UI (panel v2, modals, regional map, night theme) |
| `src/main.js` | three.js scene, instancing, picking, camera flights, panel, filters, sales actions |
| `src/config.js` | House types (areas from the RGA drawings), colour names, image mapping, backend config, UI texts EN/PT |
| `src/api.js` | Client of the sales backend (read-only fallback to `data/status.json`) |
| `src/night.js` | Time of day: sky dome, sun/moon, streetlight placement, light pools, lit windows |
| `src/poi.js` | POI dots in the 3D view, driving routes along the streets, info card |
| `src/cars.js` | Road centrelines from the dashed paint, moving cars |
| `src/region.js` | Regional map (canvas over the satellite imagery, POI list) |
| `data/site.json` | Exported from Blender (REV11): houses (pid, lot, model, PDF pattern, colour, transform), lot polygons + areas, trees |
| `data/properties.json` | Property registry (pid -> code, parcel, model, plan) |
| `data/status.json` | Read-only statuses used when no backend is configured |
| `data/poi.json` | Points of interest (OpenStreetMap + OSRM), `tools/fetch_poi.py` |
| `assets/models/ground.glb` | Whole ground (lots, roads, curbs, sidewalks, parks, hedges) merged, Draco compressed |
| `assets/models/house_1..6.glb` | The six house bodies (facade material named `FACADE`, tinted per house) |
| `assets/plans/*.jpg` | Floor plans per model |
| `assets/img/house_N.jpg` | Reference renders (1 Caramel Cloud single, 2 Isle Dreams duplex, 3 Oak Tone single, 4 Marzipan single, 5 In the Blue duplex, 6 Pinkathon duplex) |

## Updating from Blender

1. Save the `.blend`, then run headless (never inside the open file with the vegetation collections enabled — iterating
   the instanced leaves takes 15+ minutes):
   `blender -b "Legacy_Heights_REV11.blend" --python tools/blender_export.py`
   It rewrites `assets/models/ground.glb`, `assets/models/house_1..6.glb` and `data/site.json` (property IDs, lots,
   previous lot, trees) without changing the `.blend`. Ground collections are listed in `GROUND_COLS` in the script.
2. `tools/optimize_models.bat` (Node.js): renames the facade material to `FACADE` and recompresses the houses.
3. `python tools/build_properties.py` refreshes `data/properties.json` and warns about property IDs that disappeared.
4. Bump `ASSET_V` in `src/main.js` and the `?v=` versions in `index.html` / the module imports.

House data comes from the custom properties on each house instance (`property_id`, `lotes`, `lotes_anteriores`,
`modelo`, `padrao_pdf`, `cor_fachada`). PDF pattern -> type: `azul` = Type 3, `verde` = Type 1, `lilas` = Type 2,
`ouro` = Type 4 duplex.

## Official lot numbers (A-20, B-30 …)

The PDF plan has no text layer (the CAD text is outlined), so `tools/pdf_lot_labels.py` reads the "LOT X-NN" labels from the
vector strokes of `2504-02D-OVERALL SUB.pdf`, georeferences them (1:1250 on A1) and matches them to the Blender lot polygons.
Result: `data/lot_labels.json`, merged into `data/site.json` as `lots[id].label`. 631 of the 645 lots on the plan were
matched automatically; `tools/label_overrides.json` holds the hand-checked fixes and merged lots. Known ambiguity: the
plan draws lots F-19 to F-24 twice; the second copies were left unlabelled (they show as `F-0xx?` codes).

## Satellite background, textures, lighting, trees

- `assets/map/sat_near|mid|far|vast.jpg` are Esri World Imagery tiles stitched by `tools/fetch_tiles.py` / `fetch_vast.py`
  around the site (13.0908 N, 59.4990 W); `tools/georef.py` ties the model to the Barbados National Grid (EPSG:21292)
  through the grid reference printed on the plan and writes the image corners into `assets/map/sat_meta.json`.
  The imagery credit must stay visible.
- Ground materials (`assets/tex/`) are Poly Haven CC0 textures mapped in metres with planar UVs; two scales are blended
  through noise so no tiling shows from above. Hedges are shown ~1 m high and completed on every side/back boundary at load.
- Lighting: `assets/env/sky_1k.hdr` (Poly Haven, CC0) is the sky and the image-based light; a 3-cascade shadow map
  follows the sun read from the HDRI. GTAO ambient occlusion is a post-process (button "AO", off on touch devices).
  At night the same cascaded light becomes the moon and the sky is generated procedurally (`src/night.js`).
- Trees are three-card impostors rendered from the scene's own tree assets (`tools/blender_trees.py`).

## Regional map data

`python tools/fetch_poi.py` queries the Overpass API (OpenStreetMap) within 14 km of the site for the categories in
`CATS`, keeps the nearest named places, routes them with the OSRM demo server (road distance and driving time) and
converts them to the model frame, and fetches every driving route geometry. Re-run a single category with `python tools/fetch_poi.py restaurant` (Overpass rate
limits), or only the routing with `--route-only`. POI data © OpenStreetMap contributors (ODbL).

## Publishing on a plain web host (HostGator / cPanel)

`python tools/build_hostgator_zip.py` writes `dist/legacy-heights_<date>.zip`: the site files plus an `.htaccess`
(MIME types for .glb/.hdr/.webp, gzip, cache headers: html/json revalidated, versioned assets cached), `VERSION.txt`
and `LEIA-ME.txt` (the upload steps in Portuguese). In cPanel's File Manager open the target folder (for example
`public_html/legacy-heights`), upload the zip and choose Extract; extracting over an older copy overwrites the files.
The zip has no top-level folder, so it works at the domain root or in any sub-folder (every path is relative). The
sales backend needs no change. Planned home: https://unkviewer.com (UNK's viewer domain, HostGator).

