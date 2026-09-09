"""Build data/properties.json: the stable property registry keyed by the Blender property_id (LH_<uuid>).
Commercial data (status, reservations) lives elsewhere (backend / data/status.json) keyed by the same id, so a
re-export from Blender never touches it. Also copies the floor-plan images into assets/plans (downscaled)."""
import json, os, math, collections, re, sys
from PIL import Image
SITE = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
PLANS_SRC = r"G:\Meu Drive\CODEX\SKETCHUP LEGACY\florrplans houses"
PLANS_DST = os.path.join(SITE, "assets", "plans")
site = json.load(open(os.path.join(SITE, "data", "site.json"), encoding="utf-8"))
old_path = os.path.join(SITE, "data", "properties.json")
old = json.load(open(old_path, encoding="utf-8")) if os.path.exists(old_path) else {"properties": {}}

PDF_TYPE = {"azul": 3, "verde": 1, "lilas": 2, "ouro": 4}
KIND = {1: "single", 2: "single", 3: "single", 4: "duplex", 5: "duplex", 6: "duplex"}
# explicit floor-plan mapping (see README: plans checked visually against the PDF house-type key)
PLANS = {
    1: {"name": "Altura", "option": 2, "file": "ALTURA - OPTION 2 - 2 Bedrooms + 2 Bathrooms - 05 - REV.png", "out": "altura.jpg"},
    2: {"name": "Horizon", "option": 3, "file": "HORIZON - OPTION 3 - 3 Bedrooms + 1 Bathroom - 05 - REV.png", "out": "horizon.jpg"},
    3: {"name": "Pinnacle", "option": 4, "file": "PINNACLE - OPTION 4 - 3 Bedrooms + 2 Bathrooms - 05 - REV.png", "out": "pinnacle.jpg"},
    4: {"name": "Vista", "option": 6, "file": "VISTA - OPTION 6 - 2 Bedrooms + 1 Bathroom - 03 - REV.png", "out": "vista.jpg"},
}
EXTRA_PLANS = {"ascent": {"name": "Ascent", "option": 5, "file": "ASCENT - OPTION 5 - 2 Bedrooms + 2 Bathrooms - 03.png", "out": "ascent.jpg"}}
os.makedirs(PLANS_DST, exist_ok=True)
for p in list(PLANS.values()) + list(EXTRA_PLANS.values()):
    src = os.path.join(PLANS_SRC, p["file"]); dst = os.path.join(PLANS_DST, p["out"])
    if os.path.exists(src) and (not os.path.exists(dst) or os.path.getmtime(src) > os.path.getmtime(dst)):
        im = Image.open(src)
        if im.mode in ("RGBA", "LA", "P"):   # transparent background -> white
            im = im.convert("RGBA"); bg = Image.new("RGB", im.size, (255, 255, 255)); bg.paste(im, mask=im.split()[3]); im = bg
        else: im = im.convert("RGB")
        w = 1400 if im.width > 1400 else im.width
        im = im.resize((w, int(im.height * w / im.width)), Image.LANCZOS)
        im.save(dst, quality=82, optimize=True, progressive=True)
        print("plan", p["out"], im.size, os.path.getsize(dst) // 1024, "KB")

lots = site["lots"]
def lot_ids(h): return [s.strip() for s in str(h.get("lot") or "").split(",") if s.strip()]
houses = site["houses"]
# parcel of each house from its lot labels; unlabelled lots inherit the majority parcel of the nearest labelled houses
labelled = []
for h in houses:
    labs = [lots.get(i, {}).get("label") for i in lot_ids(h)]
    labs = [l for l in labs if l]
    h["_labels"] = labs
    letters = {l.split("-")[0][0] for l in labs if re.match(r"^[A-J]-", l)}
    h["_parcel"] = sorted(letters)[0] if letters else None
    if h["_parcel"]: labelled.append(h)
for h in houses:
    if h["_parcel"]: continue
    near = sorted(labelled, key=lambda o: (o["pos"][0] - h["pos"][0]) ** 2 + (o["pos"][1] - h["pos"][1]) ** 2)[:5]
    votes = collections.Counter(o["_parcel"] for o in near)
    h["_parcel"] = votes.most_common(1)[0][0]; h["_parcel_inferred"] = True

props = {}
codes = collections.Counter()
for h in houses:
    ty = PDF_TYPE.get(h["pdf"], 4)
    labs = h["_labels"]
    code = "/".join(labs) if labs else f"{h['_parcel']}-{h['id'].split()[-1]}?"
    codes[code] += 1
    if codes[code] > 1: code += f" ({codes[code]})"
    prev = old["properties"].get(h["pid"], {})
    props[h["pid"]] = {
        "pid": h["pid"], "code": code, "parcel": h["_parcel"], "parcelInferred": bool(h.get("_parcel_inferred")),
        "house": h["id"], "blenderObject": h.get("obj"), "lots": lot_ids(h), "lotLabels": labs,
        "model": h["model"], "type": ty, "kind": KIND.get(h["model"], "single"), "color": h["color"],
        "plan": PLANS[ty]["out"], "planName": PLANS[ty]["name"],
        "createdAt": prev.get("createdAt") or site.get("exported"),
    }
out = {"schema": 1, "source": site.get("source"), "exported": site.get("exported"), "count": len(props),
       "plans": {str(k): {"name": v["name"], "option": v["option"], "file": v["out"], "source": v["file"]} for k, v in PLANS.items()},
       "extraPlans": {k: {"name": v["name"], "option": v["option"], "file": v["out"], "source": v["file"]} for k, v in EXTRA_PLANS.items()},
       "properties": props}
json.dump(out, open(old_path, "w", encoding="utf-8"), ensure_ascii=False, indent=0)
per = collections.Counter(p["parcel"] for p in props.values())
print("properties", len(props), "per parcel", dict(sorted(per.items())), "inferred parcels", sum(1 for p in props.values() if p["parcelInferred"]))
print("codes with '?':", [p["code"] for p in props.values() if "?" in p["code"]][:25])
# stale ids from a previous registry (houses removed in Blender) are kept in a separate list for the sales team
gone = [pid for pid in old["properties"] if pid not in props]
if gone: print("WARNING property ids no longer in Blender:", gone)
