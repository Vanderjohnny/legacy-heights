"""Stitch ESRI World Imagery tiles around a lat/lng into one JPG; writes a JSON with the WGS84 bounds of the image."""
import math, os, sys, json, urllib.request, concurrent.futures, io
from PIL import Image
OUT = r"G:\Meu Drive\01 - PROJETOS\CLIENTES\UNK\BARBADOS\LEGACY\SITE\assets\map"
os.makedirs(OUT, exist_ok=True)
lat, lng = 13.091828, -59.499662
URL = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"

def tile_xy(lat, lng, z):
    n = 2 ** z
    x = (lng + 180) / 360 * n
    y = (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n
    return x, y
def tile_to_latlng(x, y, z):
    n = 2 ** z
    lng = x / n * 360 - 180
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    return lat, lng
def fetch(z, x, y):
    req = urllib.request.Request(URL.format(z=z, x=x, y=y), headers={"User-Agent": "Mozilla/5.0 (LegacyHeightsSite)"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as r: return Image.open(io.BytesIO(r.read())).convert("RGB")
        except Exception as e:
            err = e
    print("tile failed", z, x, y, err); return Image.new("RGB", (256, 256), (60, 70, 50))
def build(z, size_px, name, quality=86):
    nt = size_px // 256
    cx, cy = tile_xy(lat, lng, z)
    x0 = int(cx) - nt // 2; y0 = int(cy) - nt // 2
    img = Image.new("RGB", (nt * 256, nt * 256))
    jobs = [(x0 + i, y0 + j) for j in range(nt) for i in range(nt)]
    with concurrent.futures.ThreadPoolExecutor(8) as ex:
        for (x, y), tile in zip(jobs, ex.map(lambda t: fetch(z, t[0], t[1]), jobs)):
            img.paste(tile, ((x - x0) * 256, (y - y0) * 256))
    img.save(os.path.join(OUT, f"{name}.jpg"), quality=quality, optimize=True, progressive=True)
    n_lat, w_lng = tile_to_latlng(x0, y0, z); s_lat, e_lng = tile_to_latlng(x0 + nt, y0 + nt, z)
    meta = {"zoom": z, "px": nt * 256, "tile_x0": x0, "tile_y0": y0, "tiles": nt, "north": n_lat, "south": s_lat, "west": w_lng, "east": e_lng}
    print(name, meta, os.path.getsize(os.path.join(OUT, f"{name}.jpg")) // 1024, "KB")
    return meta
metas = {"near": build(19, 4096, "sat_near"), "mid": build(17, 2048, "sat_mid"), "far": build(15, 2048, "sat_far", 82)}
json.dump(metas, open(os.path.join(OUT, "sat_meta.json"), "w"), indent=1)
print("done")
