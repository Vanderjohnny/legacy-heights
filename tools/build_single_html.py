"""Build dist/legacy-heights.html: one self-contained page (all assets embedded as base64) for sharing / publishing.
Uses the reduced assets in dist/assets (satellite, photos, quantized models) and the same src/ code as the site.
The ES modules of src/ are inlined into one module script: the helper modules become IIFEs (their module-level
names stay private), the three.js imports are hoisted and de-duplicated, internal imports/exports are removed.
Run: python tools/build_single_html.py   (from any folder)"""
import base64, json, os, re, mimetypes
SITE = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
DIST = os.path.join(SITE, "dist"); DA = os.path.join(DIST, "assets")
OUT = os.path.join(DIST, "legacy-heights.html")
mimetypes.add_type("image/webp", ".webp"); mimetypes.add_type("model/gltf-binary", ".glb"); mimetypes.add_type("image/vnd.radiance", ".hdr")

files = {}; mime = {}; jsons = {}
for root, _, names in os.walk(DA):
    for n in names:
        p = os.path.join(root, n); rel = os.path.relpath(p, DIST).replace("\\", "/")
        if n.endswith("_orig.jpg") or n.endswith(".txt"): continue
        if n.endswith(".json"):
            jsons[rel] = json.load(open(p, encoding="utf-8")); continue
        files[rel] = base64.b64encode(open(p, "rb").read()).decode("ascii")
        mime[rel] = mimetypes.guess_type(p)[0] or "application/octet-stream"
# data files: always the live ones from the site
for n in ("site.json", "properties.json", "status.json", "poi.json", "airport.json"):
    p = os.path.join(SITE, "data", n)
    if os.path.exists(p): jsons["data/" + n] = json.load(open(p, encoding="utf-8"))
# floor plans + house photos come from the site's assets when dist/assets has no reduced copy
for sub in ("plans", "img"):
    d = os.path.join(SITE, "assets", sub)
    if not os.path.isdir(d): continue
    for n in os.listdir(d):
        rel = f"assets/{sub}/{n}"
        if rel in files or n.endswith("_thumb.jpg"): continue
        files[rel] = base64.b64encode(open(os.path.join(d, n), "rb").read()).decode("ascii")
        mime[rel] = mimetypes.guess_type(n)[0] or "application/octet-stream"

index = open(os.path.join(SITE, "index.html"), encoding="utf-8").read()
title = "Legacy Heights"   # product-style name for the shared page (the browser tab of the local site keeps its longer title)
importmap = re.search(r"<script type=\"importmap\">.*?</script>", index, re.S).group(0)
fonts = "\n".join(re.findall(r"<link[^>]*fonts\.g[^>]*>", index))
body = re.search(r"<body>(.*)</body>", index, re.S).group(1)
body = re.sub(r"<script[^>]*src=[^>]*></script>", "", body).strip()
css = open(os.path.join(SITE, "styles.css"), encoding="utf-8").read() + "\n" + open(os.path.join(SITE, "panel.css"), encoding="utf-8").read()

IMPORT_RE = re.compile(r"^import [^;]*? from '([^']+)';\s*$", re.M)
def load_module(name):
    src = open(os.path.join(SITE, "src", name), encoding="utf-8").read().replace("\r\n", "\n")
    ext = [m.group(0).strip() for m in IMPORT_RE.finditer(src) if not m.group(1).startswith("./")]
    # internal imports: names are shared through the enclosing module scope; keep the "as" aliases as const declarations
    aliases = []
    for m in IMPORT_RE.finditer(src):
        if not m.group(1).startswith("./"): continue
        spec = re.search(r"import (.*?) from", m.group(0)).group(1).strip().strip("{}")
        for item in spec.split(","):
            item = item.strip()
            if " as " in item:
                a, b = [x.strip() for x in item.split(" as ")]
                aliases.append(f"const {b} = {a};")
    src = IMPORT_RE.sub("", src)                       # drop every import (three.js ones are hoisted below)
    if aliases: src = "\n".join(aliases) + "\n" + src
    exports = re.findall(r"^export (?:const|let|function|async function) ([A-Za-z_$][\w$]*)", src, re.M)
    src = re.sub(r"^export (const|let|function|async function)", r"\1", src, flags=re.M)
    return src, ext, exports

three_imports, parts = [], []
for name in ("config.js", "api.js", "night.js", "cars.js", "planes.js", "poi.js", "region.js"):
    src, ext, exports = load_module(name)
    for line in ext:
        if line not in three_imports: three_imports.append(line)
    parts.append(f"// ---- {name}\nconst {{ {', '.join(exports)} }} = (() => {{\n{src}\nreturn {{ {', '.join(exports)} }};\n}})();")
main, ext, _ = load_module("main.js")
for line in ext:
    if line not in three_imports: three_imports.append(line)

embed = json.dumps({"files": files, "mime": mime, "json": jsons}, separators=(",", ":"))
embed = embed.replace("</", "<\\/")   # never close the script tag from inside the JSON

html = f"""<title>{title}</title>
{fonts}
<style>
{css}
</style>
{importmap}
{body}
<script>window.LH_EMBED = {embed};</script>
<script type="module">
{chr(10).join(three_imports)}
{chr(10).join(parts)}
// ---- main.js
{main}
</script>
"""
os.makedirs(DIST, exist_ok=True)
open(OUT, "w", encoding="utf-8").write(html)
open(os.path.join(DIST, "preview.html"), "w", encoding="utf-8").write("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><style>body{margin:0}</style></head><body>" + html + "</body></html>")
print("written", OUT, round(os.path.getsize(OUT) / 1048576, 2), "MB;", len(files), "binary assets,", len(jsons), "json")
for k in sorted(files, key=lambda k: -len(files[k]))[:8]: print("  ", k, round(len(files[k]) / 1048576, 2), "MB b64")
