"""Georeference the Blender model (metres, arbitrary origin) to the Barbados National Grid (EPSG:21292) using the
grid reference point printed on the subdivision plan, then express the satellite image corners in Blender coordinates."""
import json, os
from pyproj import Transformer
SP = r"C:\Users\pharo\AppData\Local\Temp\claude\G--Meu-Drive-01---PROJETOS-CLIENTES-UNK-BARBADOS\a37cf696-d793-41b3-a665-23d29cf6164a\scratchpad"
MAP = r"G:\Meu Drive\01 - PROJETOS\CLIENTES\UNK\BARBADOS\LEGACY\SITE\assets\map"
PT_TO_M = 25.4 / 72 / 1000 * 1250; PAGE_H = 2384.0
lab = json.load(open(os.path.join(SP, "lot_labels.json")))
tx, ty = lab['transform']['tx'], lab['transform']['ty']
# grid marker on the plan (PDF points) and its printed coordinates
mpx, mpy = 1490.4, 1585.7
E0, N0 = 36607.39, 65041.85
bx = mpx * PT_TO_M + tx; by = (PAGE_H - mpy) * PT_TO_M + ty
dE = E0 - bx; dN = N0 - by
print(f"marker in Blender: ({bx:.1f}, {by:.1f})  ->  Blender->BNG offset dE={dE:.2f} dN={dN:.2f}")
to_wgs = Transformer.from_crs("EPSG:21292", "EPSG:4326", always_xy=True)
to_bng = Transformer.from_crs("EPSG:4326", "EPSG:21292", always_xy=True)
def blender_to_latlng(x, y):
    lng, lat = to_wgs.transform(x + dE, y + dN); return lat, lng
def latlng_to_blender(lat, lng):
    E, N = to_bng.transform(lng, lat); return E - dE, N - dN
# sanity: maps pin and site centre
pin = (13.091828, -59.499662)
print("maps pin in Blender:", [round(v, 1) for v in latlng_to_blender(*pin)])
site = json.load(open(r"G:\Meu Drive\01 - PROJETOS\CLIENTES\UNK\BARBADOS\LEGACY\SITE\data\site.json", encoding='utf-8'))
b = site['bounds']; cx = (b['min'][0] + b['max'][0]) / 2; cy = (b['min'][1] + b['max'][1]) / 2
print("site centre Blender", (round(cx, 1), round(cy, 1)), "-> lat/lng", [round(v, 6) for v in blender_to_latlng(cx, cy)])
meta = json.load(open(os.path.join(MAP, "sat_meta.json")))
for k, m in meta.items():
    if not isinstance(m, dict) or 'north' not in m: continue
    corners = {"nw": latlng_to_blender(m['north'], m['west']), "ne": latlng_to_blender(m['north'], m['east']),
               "se": latlng_to_blender(m['south'], m['east']), "sw": latlng_to_blender(m['south'], m['west'])}
    m['corners'] = {kk: [round(v, 2) for v in vv] for kk, vv in corners.items()}
    w = corners['ne'][0] - corners['nw'][0]; h = corners['nw'][1] - corners['sw'][1]
    print(k, "zoom", m['zoom'], "size m: %.0f x %.0f" % (w, h), "corners", m['corners'])
meta['georef'] = {"epsg": 21292, "dE": dE, "dN": dN, "marker_blender": [bx, by], "marker_grid": [E0, N0], "site_centre_latlng": blender_to_latlng(cx, cy)}
json.dump(meta, open(os.path.join(MAP, "sat_meta.json"), "w"), indent=1)
print("saved")
