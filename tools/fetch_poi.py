"""Points of interest around Legacy Heights -> data/poi.json
Sources: OpenStreetMap via the Overpass API (names, categories, coordinates) and the public OSRM demo router
(road distance + driving time from the site entrance). Coordinates are also converted to the Blender/site frame
(EPSG:21292 minus the georef offsets in assets/map/sat_meta.json) so the regional map can draw them over the
satellite imagery.  Run:  python tools/fetch_poi.py
"""
import json, math, os, sys, time
import requests
from pyproj import Transformer

SITE = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
META = json.load(open(os.path.join(SITE, "assets", "map", "sat_meta.json"), encoding="utf-8"))
LAT, LNG = META["georef"]["site_centre_latlng"]
dE, dN = META["georef"]["dE"], META["georef"]["dN"]
TO_GRID = Transformer.from_crs("EPSG:4326", f"EPSG:{META['georef']['epsg']}", always_xy=True)
RADIUS = 14000   # metres

# category -> (overpass selector list, label en, label pt, cap on how many nearest to keep)
CATS = {
    "airport":     (['nwr["aeroway"="aerodrome"]'], 'Airport', 'Aeroporto', 2),
    "supermarket": (['nwr["shop"="supermarket"]', 'nwr["shop"="mall"]'], 'Supermarket', 'Supermercado', 8),
    "restaurant":  (['nwr["amenity"="restaurant"]'], 'Restaurant', 'Restaurante', 10),
    "hospital":    (['nwr["amenity"="hospital"]', 'nwr["amenity"="clinic"]', 'nwr["healthcare"="hospital"]'], 'Hospital / clinic', 'Hospital / clínica', 6),
    "school":      (['nwr["amenity"="school"]', 'nwr["amenity"="college"]', 'nwr["amenity"="university"]'], 'School', 'Escola', 8),
    "pharmacy":    (['nwr["amenity"="pharmacy"]'], 'Pharmacy', 'Farmácia', 6),
    "park":        (['nwr["leisure"="park"]', 'nwr["leisure"="nature_reserve"]', 'nwr["leisure"="golf_course"]'], 'Park', 'Parque', 6),
    "beach":       (['nwr["natural"="beach"]'], 'Beach', 'Praia', 8),
}

def overpass(cat, selectors):
    body = "[out:json][timeout:60];(" + "".join(f'{s}(around:{RADIUS},{LAT},{LNG});' for s in selectors) + ");out center tags;"
    for url in ("https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"):
        try:
            r = requests.post(url, data={"data": body}, timeout=120, headers={"User-Agent": "legacy-heights-site/1.0 (3d@unk.group)"})
            r.raise_for_status()
            return r.json()["elements"]
        except Exception as e:
            print(f"  overpass {url} failed for {cat}: {e}", file=sys.stderr)
            time.sleep(15)
    return []

def haversine(lat1, lon1, lat2, lon2):
    R = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))

OUT = os.path.join(SITE, "data", "poi.json")
ONLY = set(sys.argv[1:])          # categories to (re)fetch; "--route-only" keeps every POI and only re-runs the routing
ROUTE_ONLY = "--route-only" in ONLY
pois = []
if ONLY and os.path.exists(OUT):
    pois = [p for p in json.load(open(OUT, encoding="utf-8"))["pois"] if p["cat"] not in ONLY]
for cat, (sel, en, pt, cap) in CATS.items():
    if ROUTE_ONLY or (ONLY and cat not in ONLY): continue
    els = overpass(cat, sel)
    items = []
    for e in els:
        tags = e.get("tags", {})
        name = tags.get("name") or tags.get("name:en")
        if not name: continue
        lat = e.get("lat") or e.get("center", {}).get("lat"); lng = e.get("lon") or e.get("center", {}).get("lon")
        if lat is None: continue
        items.append({"id": f'{e["type"][0]}{e["id"]}', "name": name, "cat": cat, "lat": round(lat, 6), "lng": round(lng, 6),
                      "dist_km": round(haversine(LAT, LNG, lat, lng), 2), "tags": {k: tags[k] for k in ("amenity", "shop", "leisure", "natural", "aeroway", "iata", "opening_hours", "website", "phone", "addr:street") if k in tags}})
    # dedupe by name (an OSM node and a building way often both carry the name), keep the nearest
    seen = {}
    for it in sorted(items, key=lambda i: i["dist_km"]):
        k = it["name"].strip().lower()
        if k not in seen: seen[k] = it
    kept = list(seen.values())[:cap]
    print(f"{cat:12s} {len(els):4d} elements -> {len(kept)} kept")
    pois.extend(kept)
    time.sleep(8)

# road distance / drive time (OSRM public demo server; table service: one source -> many destinations)
def osrm_table(dests):
    out = {}
    for i in range(0, len(dests), 90):
        chunk = dests[i:i + 90]
        coords = ";".join([f"{LNG},{LAT}"] + [f'{d["lng"]},{d["lat"]}' for d in chunk])
        url = f"https://router.project-osrm.org/table/v1/driving/{coords}?sources=0&annotations=duration,distance"
        try:
            r = requests.get(url, timeout=60, headers={"User-Agent": "legacy-heights-site/1.0"})
            r.raise_for_status(); j = r.json()
            for k, d in enumerate(chunk):
                dur, dist = j["durations"][0][k + 1], j["distances"][0][k + 1]
                if dur is not None: out[d["id"]] = (dist / 1000.0, dur / 60.0)
        except Exception as e:
            print("  osrm failed:", e, file=sys.stderr)
    return out

routes = osrm_table(pois)   # OSRM is cheap: always re-route everything
for p in pois:
    if p["id"] in routes:
        p["road_km"], p["drive_min"] = round(routes[p["id"]][0], 1), round(routes[p["id"]][1] + 1.5)   # +1.5 min: leaving the site
        p.pop("estimated", None)
    elif "drive_min" not in p or p.get("estimated"):   # fallback estimate: 1.35 x straight line at 38 km/h
        p["road_km"], p["drive_min"] = round(p["dist_km"] * 1.35, 1), round(p["dist_km"] * 1.35 / 38 * 60 + 2)
        p["estimated"] = True
    E, N = TO_GRID.transform(p["lng"], p["lat"])
    p["x"], p["y"] = round(E - dE, 1), round(N - dN, 1)   # Blender frame (metres)
    p.pop("tags", None) if not p.get("tags") else None

pois.sort(key=lambda p: (list(CATS).index(p["cat"]), p["drive_min"]))
doc = {"generated": time.strftime("%Y-%m-%d"), "site": {"lat": LAT, "lng": LNG, "name": "Legacy Heights"},
       "attribution": "POI data © OpenStreetMap contributors (ODbL); routing: OSRM demo server",
       "categories": {k: {"en": v[1], "pt": v[2]} for k, v in CATS.items()}, "pois": pois}
json.dump(doc, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("written", len(pois), "POIs ->", OUT)
