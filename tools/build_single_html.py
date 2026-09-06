"""Build dist/legacy-heights.html: one self-contained page (all assets embedded as base64) for sharing / publishing.
Uses the reduced assets in dist/assets (satellite, photos, quantized models) and the same src/ code as the site.
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
jsons["data/site.json"] = json.load(open(os.path.join(SITE, "data", "site.json"), encoding="utf-8"))

index = open(os.path.join(SITE, "index.html"), encoding="utf-8").read()
title = "Legacy Heights"   # product-style name for the shared page (the browser tab of the local site keeps its longer title)
importmap = re.search(r"<script type=\"importmap\">.*?</script>", index, re.S).group(0)
fonts = "\n".join(re.findall(r"<link[^>]*fonts\.g[^>]*>", index))
body = re.search(r"<body>(.*)</body>", index, re.S).group(1)
body = re.sub(r"<script[^>]*src=[^>]*></script>", "", body).strip()
css = open(os.path.join(SITE, "styles.css"), encoding="utf-8").read()
config = open(os.path.join(SITE, "src", "config.js"), encoding="utf-8").read()
config = re.sub(r"^export (const|function|let)", r"\1", config, flags=re.M)
main = open(os.path.join(SITE, "src", "main.js"), encoding="utf-8").read()
main = re.sub(r"^import \{[^}]*\} from '\./config\.js';\s*$", "", main, flags=re.M)
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
{config}
{main}
</script>
"""
os.makedirs(DIST, exist_ok=True)
open(OUT, "w", encoding="utf-8").write(html)
open(os.path.join(DIST, "preview.html"), "w", encoding="utf-8").write("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><style>body{margin:0}</style></head><body>" + html + "</body></html>")
print("written", OUT, round(os.path.getsize(OUT) / 1048576, 2), "MB;", len(files), "binary assets,", len(jsons), "json")
for k in sorted(files, key=lambda k: -len(files[k]))[:8]: print("  ", k, round(len(files[k]) / 1048576, 2), "MB b64")
