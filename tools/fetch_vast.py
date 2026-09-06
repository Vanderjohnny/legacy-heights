import json, os, sys, importlib.util
SP = os.path.dirname(os.path.abspath(__file__))
src = open(os.path.join(SP, "fetch_tiles.py"), encoding="utf-8").read()
# reuse the helpers of fetch_tiles.py without running its main part
head = src.split("metas = ")[0]
ns = {}; exec(head, ns)
OUT = ns["OUT"]
meta = json.load(open(os.path.join(OUT, "sat_meta.json")))
meta["vast"] = ns["build"](13, 2048, "sat_vast", 80)
json.dump(meta, open(os.path.join(OUT, "sat_meta.json"), "w"), indent=1)
print("vast added")
