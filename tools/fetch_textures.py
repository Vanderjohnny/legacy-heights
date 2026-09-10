"""Download CC0 PBR textures from Poly Haven into assets/tex (1k JPG, re-encoded at quality 82).
    python tools/fetch_textures.py            -> the sets used by the houses (see SETS)
Each set becomes <name>_diff.jpg, <name>_nor.jpg (OpenGL normal), <name>_rough.jpg."""
import io, os, sys, requests
from PIL import Image
SITE = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
OUT = os.path.join(SITE, "assets", "tex")
# local name -> Poly Haven asset id (candidates in order; the first one that exists is used)
SETS = {
    "plaster": ["painted_plaster_wall", "plastered_wall_04", "plaster_wall_02"],
    "metalroof": ["corrugated_iron", "corrugated_iron_02", "metal_plate"],
    "wood": ["wood_planks_grey", "weathered_planks", "wood_table_001"],
}
MAPS = {"diff": ["Diffuse", "diffuse"], "nor": ["nor_gl"], "rough": ["Rough", "rough"]}
H = {"User-Agent": "legacy-heights-site/1.0 (3d@unk.group)"}

def files_for(asset):
    r = requests.get(f"https://api.polyhaven.com/files/{asset}", timeout=60, headers=H)
    if r.status_code != 200: return None
    return r.json()

def pick(files, keys, res="1k"):
    for k in keys:
        if k in files and res in files[k] and "jpg" in files[k][res]:
            return files[k][res]["jpg"]["url"]
    return None

os.makedirs(OUT, exist_ok=True)
for name, candidates in SETS.items():
    done = False
    for asset in candidates:
        files = files_for(asset)
        if not files: print(f"{name}: {asset} not found"); continue
        urls = {m: pick(files, keys) for m, keys in MAPS.items()}
        if not urls["diff"] or not urls["nor"]: print(f"{name}: {asset} lacks maps {urls}"); continue
        for m, url in urls.items():
            if not url: continue
            r = requests.get(url, timeout=120, headers=H); r.raise_for_status()
            im = Image.open(io.BytesIO(r.content)).convert("RGB")
            if max(im.size) > 1024: im = im.resize((1024, 1024), Image.LANCZOS)
            p = os.path.join(OUT, f"{name}_{m}.jpg")
            im.save(p, "JPEG", quality=82, optimize=True)
            print(f"{name}_{m}.jpg <- {asset} ({os.path.getsize(p) // 1024} KB)")
        done = True; break
    if not done: sys.exit(f"no texture found for {name}")
print("done")
