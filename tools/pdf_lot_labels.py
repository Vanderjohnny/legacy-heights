"""Lot-label OCR v3: multi-label clusters, looser merging, conflict/duplicate resolution, crops of doubtful cases for visual check."""
import pymupdf, json, math, os, re, collections, sys
from PIL import Image, ImageDraw, ImageFont
SP = r"C:\Users\pharo\AppData\Local\Temp\claude\G--Meu-Drive-01---PROJETOS-CLIENTES-UNK-BARBADOS\a37cf696-d793-41b3-a665-23d29cf6164a\scratchpad"
PDF = r"G:\Meu Drive\01 - PROJETOS\CLIENTES\UNK\BARBADOS\LEGACY\PDF\2504-02D-OVERALL SUB.pdf"
SITE_JSON = r"G:\Meu Drive\01 - PROJETOS\CLIENTES\UNK\BARBADOS\LEGACY\SITE\data\site.json"
PT_TO_M = 25.4 / 72 / 1000 * 1250
OVERRIDES = json.load(open(os.path.join(SP, "label_overrides.json"))) if os.path.exists(os.path.join(SP, "label_overrides.json")) else {}

doc = pymupdf.open(PDF); page = doc[0]; PAGE_H = page.rect.height
strokes = []; strokes_gray = []
for d in page.get_drawings():
    col = d.get('color')
    if col is None: continue
    is_black = max(col) <= 0.05; is_gray = abs(col[0] - 0.596) < 0.02 and abs(col[1] - 0.596) < 0.02
    if not (is_black or is_gray): continue
    segs = []
    for it in d['items']:
        if it[0] == 'l': segs.append(((it[1].x, it[1].y), (it[2].x, it[2].y)))
        elif it[0] == 'c': segs.append(((it[1].x, it[1].y), (it[4].x, it[4].y)))
    if not segs: continue
    r = d['rect']
    if max(r.x1 - r.x0, r.y1 - r.y0) >= (40 if is_black else 6): continue
    (strokes if is_black else strokes_gray).append({"segs": segs, "rect": (r.x0, r.y0, r.x1, r.y1)})

def cluster(items, rect_of, tol_of, cell=4.0):
    parent = list(range(len(items)))
    def find(i):
        while parent[i] != i: parent[i] = parent[parent[i]]; i = parent[i]
        return i
    grid = collections.defaultdict(list)
    for i, it in enumerate(items):
        r = rect_of(it)
        for gx in range(int(r[0] // cell), int(r[2] // cell) + 1):
            for gy in range(int(r[1] // cell), int(r[3] // cell) + 1): grid[(gx, gy)].append(i)
    for idxs in grid.values():
        for a in range(len(idxs)):
            for b in range(a + 1, len(idxs)):
                i, j = idxs[a], idxs[b]
                tol = tol_of(items[i], items[j]); ra, rb = rect_of(items[i]), rect_of(items[j])
                if not (ra[2] + tol < rb[0] or rb[2] + tol < ra[0] or ra[3] + tol < rb[1] or rb[3] + tol < ra[1]):
                    pa, pb = find(i), find(j)
                    if pa != pb: parent[pb] = pa
    groups = collections.defaultdict(list)
    for i in range(len(items)): groups[find(i)].append(i)
    return list(groups.values())

def build_glyphs(strk):
    out = []
    for g in cluster(strk, lambda s: s['rect'], lambda a, b: 0.08 * max(a['rect'][3] - a['rect'][1], b['rect'][3] - b['rect'][1], 1.0)):
        segs = [seg for i in g for seg in strk[i]['segs']]
        xs = [p[0] for seg in segs for p in seg]; ys = [p[1] for seg in segs for p in seg]
        x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
        if (y1 - y0) < 0.3 and (x1 - x0) < 0.3: continue
        out.append({"bbox": (x0, y0, x1, y1), "h": y1 - y0, "w": x1 - x0, "segs": segs, "cx": (x0 + x1) / 2, "cy": (y0 + y1) / 2, "size": max(x1 - x0, y1 - y0)})
    return out
glyphs = build_glyphs(strokes)          # black: prototypes + labels
glyphs_gray = build_glyphs(strokes_gray) # grey pen: extra label candidates
print("black glyphs", len(glyphs), "grey glyphs", len(glyphs_gray), "grey sizes:", sorted(collections.Counter(round(g['size'], 1) for g in glyphs_gray).items(), key=lambda t: -t[1])[:8])

def key_of(g):
    x0, y0, x1, y1 = g['bbox']; h = y1 - y0; w = x1 - x0; sc = h if h >= w * 0.35 else w
    return tuple(sorted(tuple(sorted([(round((s[0][0] - x0) / sc, 1), round((s[0][1] - y0) / sc, 1)), (round((s[1][0] - x0) / sc, 1), round((s[1][1] - y0) / sc, 1))])) for s in g['segs']))
uniq = collections.Counter(key_of(g) for g in glyphs)
items = uniq.most_common(160)
LAB = """0:- 1:T 2:L 3:0 4:1 5:4 6:e 7:3 8:5 9:2 10:a 11:6 12:t 13:F 14:E 15:H 16:A 17:7 18:0 19:8 20:r 21:L 22:l 23:l 24:n 25:B 26:9 27:D 28:C 29:O 30:C 31:d
32:0 33:S 34:0 35:G 36:O 37:P 38:0 39:A 40:I 41:P 42:S 43:T 44:u 45:O 46:0 47:y 49:m 50:H 51:R 52:f 53:h 54:v 56:g 57:2 58:A 59:n 60:) 61:b 62:w 63:1
64:B 65:1 66:o 67:r 68:5 69:G 70:H 71:F 72:S 73:2 74:6 75:6 76:a 77:N 79:2 80:0 81:5 82:6 83:9 84:2 85:1 86:N 87:k 88:( 89:) 92:8 93:8 94:7 95:2 96:3 97:0
98:x 99:e 100:O 101:/ 102:C 103:C 104:D 105:u 106:L 107:h 108:e 109:n 110:5 112:I 113:a 115:/ 116:0 117:9 118:7 119:6 120:7 121:9 122:D 123:3 124:0 125:G
126:E 128:4 129:2 130:d 131:Y 132:6 135:J 140:6 141:5 142:B 143:9 144:3 145:0 146:7 147:8 148:G 149:9 150:A 151:/ 153:w 154:T 155:E 156:2 157:r 158:3"""
labels = {int(t.split(':')[0]): t.split(':', 1)[1] for t in LAB.split()}
R = 32
def raster_segs(segs):
    xs = [p[0] for s in segs for p in s]; ys = [p[1] for s in segs for p in s]
    x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys); w = x1 - x0; h = y1 - y0; s = max(w, h, 1e-6)
    ox = (s - w) / 2; oy = (s - h) / 2
    im = Image.new('1', (R, R), 0); dr = ImageDraw.Draw(im)
    for (a, b) in segs:
        dr.line([((a[0] - x0 + ox) / s * (R - 1), (a[1] - y0 + oy) / s * (R - 1)), ((b[0] - x0 + ox) / s * (R - 1), (b[1] - y0 + oy) / s * (R - 1))], fill=1, width=2)
    return im.tobytes(), (w / h if h > 1e-6 else 99)
def region_density(segs, rx0, rx1, ry0, ry1):
    # fraction of ink inside a sub-rectangle of the glyph's own bounding box (0..1 coordinates)
    xs = [p[0] for s in segs for p in s]; ys = [p[1] for s in segs for p in s]
    x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys); w = max(x1 - x0, 1e-6); h = max(y1 - y0, 1e-6)
    G = 40; im = Image.new('1', (G, G), 0); dr = ImageDraw.Draw(im)
    for (a, b) in segs: dr.line([((a[0] - x0) / w * (G - 1), (a[1] - y0) / h * (G - 1)), ((b[0] - x0) / w * (G - 1), (b[1] - y0) / h * (G - 1))], fill=1, width=1)
    px = im.load(); tot = 0; ins = 0
    for y in range(G):
        for x in range(G):
            if px[x, y]:
                tot += 1
                if rx0 * G <= x < rx1 * G and ry0 * G <= y < ry1 * G: ins += 1
    return ins / max(tot, 1)
protos = []
for k, (key, cnt) in enumerate(items):
    if k in labels:
        ex = next(g for g in glyphs if key_of(g) == key); ra, asp = raster_segs(ex['segs']); protos.append((ra, labels[k], asp))
def hamming(a, b): return sum(bin(x ^ y).count('1') for x, y in zip(a, b))
def classify(segs):
    ra, asp = raster_segs(segs)
    if asp > 4: return '-', 0
    best = (10 ** 9, None)
    for p in protos:
        if p[1] == '-': continue
        d = hamming(ra, p[0]) + (12 if abs(math.log((asp + 1e-6) / (p[2] + 1e-6))) > 0.45 else 0)
        if d < best[0]: best = (d, p[1])
    ch = best[1] if best[0] < 130 else '?'
    if ch in ('6', '8', '5', '9', '3'):
        # structural checks on the right side of the glyph: '8' has ink on the upper-right, '6' does not; '9' has ink lower-left? (font specific)
        ur = region_density(segs, 0.62, 1.0, 0.22, 0.5)   # upper-right band
        ul = region_density(segs, 0.0, 0.38, 0.22, 0.5)   # upper-left band
        ll = region_density(segs, 0.0, 0.38, 0.55, 0.85)  # lower-left band
        lr = region_density(segs, 0.62, 1.0, 0.55, 0.85)  # lower-right band
        if ch in ('6', '8'): ch = '8' if ur > 0.112 else '6'
        elif ch in ('3', '5'): ch = '3' if ul < 0.08 else '5'
    return ch, best[0]

small = [g for g in glyphs + glyphs_gray if 1.6 <= g['size'] <= 4.8]
words = cluster(small, lambda g: g['bbox'], lambda a, b: 0.6 * max(a['size'], b['size']), cell=6.0)
def rot(p, c, th):
    s, co = math.sin(th), math.cos(th); dx, dy = p[0] - c[0], p[1] - c[1]
    return (c[0] + dx * co - dy * s, c[1] + dx * s + dy * co)
def axis_of(gs):
    n = len(gs); cx = sum(g['cx'] for g in gs) / n; cy = sum(g['cy'] for g in gs) / n
    if n < 3: return cx, cy, None
    sxx = sum((g['cx'] - cx) ** 2 for g in gs); syy = sum((g['cy'] - cy) ** 2 for g in gs); sxy = sum((g['cx'] - cx) * (g['cy'] - cy) for g in gs)
    return cx, cy, 0.5 * math.atan2(2 * sxy, sxx - syy)
def cluster_info(idx):
    gs = [small[i] for i in idx]; cx, cy, th = axis_of(gs)
    return {"idx": list(idx), "cx": cx, "cy": cy, "h": max(g['size'] for g in gs), "th": th}
cl = [cluster_info(w) for w in words]
merged = True
while merged:
    merged = False; cl.sort(key=lambda c: c['cx'])
    for a in range(len(cl)):
        A = cl[a]
        if A is None: continue
        for b in range(a + 1, len(cl)):
            B = cl[b]
            if B is None: continue
            if B['cx'] - A['cx'] > 45: break
            if abs(B['cy'] - A['cy']) > 45: continue
            th = A['th'] if A['th'] is not None else (B['th'] if B['th'] is not None else 0.0)
            if A['th'] is not None and B['th'] is not None:
                dth = abs((A['th'] - B['th'] + math.pi / 2) % math.pi - math.pi / 2)
                if dth > math.radians(12): continue
            ux, uy = math.cos(th), math.sin(th)
            def span(C):
                pr = [((g['cx'] - A['cx']) * ux + (g['cy'] - A['cy']) * uy, -(g['cx'] - A['cx']) * uy + (g['cy'] - A['cy']) * ux) for g in (small[i] for i in C['idx'])]
                return min(p[0] for p in pr), max(p[0] for p in pr), sum(p[1] for p in pr) / len(pr)
            a0, a1, ay = span(A); b0, b1, by = span(B); h = max(A['h'], B['h']); gap = max(b0 - a1, a0 - b1)
            if abs(by - ay) < 0.6 * h and -0.3 * h < gap < 3.2 * h and abs(A['h'] - B['h']) < 0.35 * h and len(A['idx']) + len(B['idx']) <= 24:
                cl[a] = cluster_info(A['idx'] + B['idx']); cl[b] = None; A = cl[a]; merged = True
    cl = [c for c in cl if c is not None]
words = [c['idx'] for c in cl]

RX = re.compile(r'(?:L|l)?[O0]?T\s*([A-J0-9?])\s*[-\s]?\s*([0-9OlIBS]{1,3})(?![0-9OlIBS?])')
found = []
def read_cluster(gs):
    cx, cy, th = axis_of(gs); th = th or 0.0
    out = []
    for extra in (0.0, math.pi):
        ang = -th + extra; rg = []
        for g in gs:
            segs = [(rot(a, (cx, cy), ang), rot(b, (cx, cy), ang)) for (a, b) in g['segs']]
            xs = [p[0] for s in segs for p in s]; ys = [p[1] for s in segs for p in s]
            rg.append({"segs": segs, "x0": min(xs), "x1": max(xs), "y0": min(ys), "y1": max(ys), "g": g})
        rg.sort(key=lambda r: r['x0'])
        s = ''; idxmap = []; prev = None; score = 0; hh = max(r['y1'] - r['y0'] for r in rg)
        for r in rg:
            if prev is not None and r['x0'] - prev > 0.42 * hh: s += ' '; idxmap.append(None)
            ch, d = classify(r['segs']); s += ch; idxmap.append(r['g']); score += d; prev = r['x1']
        out.append((s, score, th + extra, idxmap))
    out.sort(key=lambda r: r[1])
    return out
for w in words:
    gs = [small[i] for i in w]
    if not (3 <= len(gs) <= 24): continue
    for s, score, th, idxmap in read_cluster(gs):
        t = s.replace('l', '1').replace('I', '1')
        hits = list(RX.finditer(t))
        if not hits: continue
        for m in hits:
            parcel = m.group(1).replace('0', 'O').replace('8', 'B').replace('6', 'G'); num = m.group(2).replace('O', '0').replace('B', '8').replace('S', '5')
            if parcel not in 'ABCDEFGHJ?' or not num.isdigit(): continue
            gl = [g for g in idxmap[m.start():m.end()] if g is not None]
            mx = sum(g['cx'] for g in gl) / len(gl); my = sum(g['cy'] for g in gl) / len(gl)
            found.append({"label": f"{parcel}-{int(num)}", "parcel": parcel, "num": int(num), "px": mx, "py": my, "text": t[m.start():m.end()], "score": score / max(len(gs), 1), "rot": round(math.degrees(th), 1)})
        break
print("labels parsed:", len(found), "unique:", len({f['label'] for f in found}))
print("per parcel (raw):", dict(sorted(collections.Counter(f['parcel'] for f in found).items())))

# ---------------------------------------------------------------- georeference & assign
site = json.load(open(SITE_JSON, encoding='utf-8'))
lots = [l for l in site['lots'].values() if len(l['poly']) >= 3 and not l['hidden']]
for l in lots:
    xs = [p[0] for p in l['poly']]; ys = [p[1] for p in l['poly']]; l['bb'] = (min(xs), min(ys), max(xs), max(ys))
def pip(x, y, poly):
    inside = False
    for i in range(len(poly)):
        xi, yi = poly[i]; xj, yj = poly[i - 1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi: inside = not inside
    return inside
def dist_poly(x, y, poly):
    best = 1e9
    for i in range(len(poly)):
        (x1, y1), (x2, y2) = poly[i - 1], poly[i]
        dx, dy = x2 - x1, y2 - y1; L2 = dx * dx + dy * dy
        t = 0 if L2 == 0 else max(0, min(1, ((x - x1) * dx + (y - y1) * dy) / L2))
        best = min(best, math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)))
    return best
def lot_at(x, y):
    for l in lots:
        b = l['bb']
        if b[0] <= x <= b[2] and b[1] <= y <= b[3] and pip(x, y, l['poly']): return l
    return None
for f in found: f['mx'] = f['px'] * PT_TO_M; f['my'] = (PAGE_H - f['py']) * PT_TO_M
lc = [l['center'] for l in lots if l['area_m2'] < 900]
gx = sum(c[0] for c in lc) / len(lc) - sum(f['mx'] for f in found) / len(found)
gy = sum(c[1] for c in lc) / len(lc) - sum(f['my'] for f in found) / len(found)
def score_t(tx, ty): return sum(1 for f in found if lot_at(f['mx'] + tx, f['my'] + ty))
best = (score_t(gx, gy), gx, gy)
for step, rng in ((6, 60), (2, 8), (0.5, 2)):
    b0 = best; k = int(rng / step)
    for i in range(-k, k + 1):
        for j in range(-k, k + 1):
            s = score_t(b0[1] + i * step, b0[2] + j * step)
            if s > best[0]: best = (s, b0[1] + i * step, b0[2] + j * step)
_, tx, ty = best
for f in found: f['x'] = f['mx'] + tx; f['y'] = f['my'] + ty
print(f"georef: inside {best[0]}/{len(found)} tx={tx:.2f} ty={ty:.2f}")
# refine with a similarity transform (rotation + scale + translation) fitted on labels that sit alone inside a lot
def fit_similarity(pairs):
    n = len(pairs)
    mx = sum(p[0][0] for p in pairs) / n; my = sum(p[0][1] for p in pairs) / n
    bx = sum(p[1][0] for p in pairs) / n; by = sum(p[1][1] for p in pairs) / n
    sxx = sxy = syx = syy = 0.0; var = 0.0
    for (ax, ay), (cx, cy) in pairs:
        ax -= mx; ay -= my; cx -= bx; cy -= by
        sxx += ax * cx; sxy += ax * cy; syx += ay * cx; syy += ay * cy; var += ax * ax + ay * ay
    th = math.atan2(sxy - syx, sxx + syy)
    s = ((sxx + syy) * math.cos(th) + (sxy - syx) * math.sin(th)) / var
    return th, s, (mx, my), (bx, by)
for it in range(3):
    claims = collections.defaultdict(list)
    for f in found:
        l = lot_at(f['x'], f['y'])
        if l: claims[l['id']].append(f)
    pairs = [((fs[0]['mx'], fs[0]['my']), tuple(lot_by_id_tmp['center'])) for lid, fs in claims.items() if len(fs) == 1 for lot_by_id_tmp in [next(l for l in lots if l['id'] == lid)] if lot_by_id_tmp['area_m2'] < 700]
    th, s, (mx0, my0), (bx0, by0) = fit_similarity(pairs)
    for f in found:
        dx, dy = f['mx'] - mx0, f['my'] - my0
        f['x'] = bx0 + s * (dx * math.cos(th) - dy * math.sin(th)); f['y'] = by0 + s * (dx * math.sin(th) + dy * math.cos(th))
    inside = sum(1 for f in found if lot_at(f['x'], f['y']))
    print(f"similarity fit {it}: pairs {len(pairs)} rot {math.degrees(th):.3f} deg scale {s:.5f} -> inside {inside}/{len(found)}")

# debug clusters near given Blender lots (env DEBUG_LOTS="Terrenos 373,Terrenos 614")
dbg = [x.strip() for x in os.environ.get("DEBUG_LOTS", "").split(",") if x.strip()]
if dbg:
    all_words = []
    for w in words:
        gs = [small[i] for i in w]
        if len(gs) < 2: continue
        r = read_cluster(gs); cx, cy, _ = axis_of(gs)
        all_words.append((cx, cy, len(gs), r[0][0], r[1][0]))
    for lid in dbg:
        l = next((x for x in lots if x['id'] == lid), None)
        if not l: print("debug: no lot", lid); continue
        px = (l['center'][0] - tx) / PT_TO_M; py = PAGE_H - (l['center'][1] - ty) / PT_TO_M
        near = sorted(((math.hypot(cx - px, cy - py), n, t1, t2) for cx, cy, n, t1, t2 in all_words if math.hypot(cx - px, cy - py) < 30), key=lambda t: t[0])
        print("debug", lid, "pdf", round(px, 1), round(py, 1), "clusters:", [(round(d, 1), n, t1, t2) for d, n, t1, t2 in near[:12]])
# parcel letter unknown ('?'): take the parcel of the nearest confidently read labels
known = [f for f in found if f['parcel'] != '?']
for f in found:
    if f['parcel'] == '?':
        near = sorted(known, key=lambda k: math.hypot(k['x'] - f['x'], k['y'] - f['y']))[:4]
        if near and math.hypot(near[0]['x'] - f['x'], near[0]['y'] - f['y']) < 40:
            pc = collections.Counter(k['parcel'] for k in near).most_common(1)[0][0]
            f['parcel'] = pc; f['label'] = f"{pc}-{f['num']}"; f['text'] += ' (parcel inferred)'
found = [f for f in found if f['parcel'] != '?']
# duplicates: keep the instance that sits inside a lot and has the best score
by_label = collections.defaultdict(list)
for f in found: by_label[f['label']].append(f)
cands = []; dropped_dups = []
for lab, fs in by_label.items():
    fs.sort(key=lambda f: (0 if lot_at(f['x'], f['y']) else 1, f['score']))
    cands.append(fs[0]); dropped_dups += fs[1:]
# assignment: containment, then conflicts resolved by centroid distance, losers moved to nearest free lot within 5 m
lot_by_id = {l['id']: l for l in lots}
assign = {}; problems = []
for f in cands:
    l = lot_at(f['x'], f['y'])
    f['lot'] = l['id'] if l else None
claims = collections.defaultdict(list)
for f in cands:
    if f['lot']: claims[f['lot']].append(f)
free = lambda lid: lid not in assign
for lid, fs in claims.items():
    l = lot_by_id[lid]
    fs.sort(key=lambda f: math.hypot(f['x'] - l['center'][0], f['y'] - l['center'][1]))
    assign[lid] = fs[0]['label']
    for f in fs[1:]:
        # nearest other lot by boundary distance
        near = sorted(((dist_poly(f['x'], f['y'], o['poly']), o['id']) for o in lots if o['id'] != lid and free(o['id']) and abs(o['center'][0] - f['x']) < 30 and abs(o['center'][1] - f['y']) < 30), key=lambda t: t[0])
        if near and near[0][0] < 5.0: assign[near[0][1]] = f['label']; problems.append(("moved", f['label'], lid, near[0][1], round(near[0][0], 1)))
        else: problems.append(("conflict-unplaced", f['label'], lid))
for f in cands:
    if f['lot'] is None:
        near = sorted(((dist_poly(f['x'], f['y'], o['poly']), o['id']) for o in lots if free(o['id']) and abs(o['center'][0] - f['x']) < 30 and abs(o['center'][1] - f['y']) < 30), key=lambda t: t[0])
        if near and near[0][0] < 5.0: assign[near[0][1]] = f['label']; problems.append(("outside->nearest", f['label'], near[0][1], round(near[0][0], 1)))
        else: problems.append(("outside-unplaced", f['label']))
for lid, lab in OVERRIDES.items():
    if lab: assign[lid] = lab
    else: assign.pop(lid, None)
per = collections.Counter(v.split('-')[0] for v in assign.values())
print("assigned:", len(assign), "per parcel:", dict(sorted(per.items())))
print("problems:", len(problems), problems[:30])
print("dropped duplicates:", [(f['label'], f['text']) for f in dropped_dups])
unl = [l['id'] for l in lots if l['id'] not in assign and l['area_m2'] > 60]
print("unlabelled lots (>60 m2):", len(unl))
for p in "ABCDEFGH":
    nums = sorted(int(v.split('-')[1]) for v in assign.values() if v.startswith(p + '-'))
    print(p, "count", len(nums), "missing:", [n for n in range(1, (max(nums) if nums else 0) + 1) if n not in nums])
json.dump({"labels": assign, "transform": {"tx": tx, "ty": ty, "pt_to_m": PT_TO_M}, "problems": problems,
           "found": [{"label": f['label'], "x": round(f['x'], 2), "y": round(f['y'], 2), "px": f['px'], "py": f['py'], "text": f['text'], "score": round(f['score'], 1)} for f in found]},
          open(os.path.join(SP, "lot_labels.json"), "w"), indent=1)

# ---------------------------------------------------------------- crops of doubtful cases for a visual check
doubt = set(f['label'] for f in dropped_dups) | set(p[1] for p in problems)
doubt_f = [f for f in found if f['label'] in doubt]
doubt_f.sort(key=lambda f: f['label'])
if doubt_f:
    cs = 200; cols = 6; rows = (len(doubt_f) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * cs, rows * (cs + 16)), "white"); dr = ImageDraw.Draw(sheet)
    for k, f in enumerate(doubt_f):
        clip = pymupdf.Rect(f['px'] - 16, f['py'] - 9, f['px'] + 16, f['py'] + 9)
        pix = page.get_pixmap(clip=clip, dpi=340)
        im = Image.frombytes("RGB", (pix.width, pix.height), pix.samples).resize((cs, int(cs * pix.height / pix.width)))
        ox = (k % cols) * cs; oy = (k // cols) * (cs + 16)
        sheet.paste(im, (ox, oy + 16)); dr.text((ox + 2, oy + 2), f"{k}: {f['label']} <{f['text']}> s{f['score']:.0f}", fill="red")
    sheet.save(os.path.join(SP, "doubt_crops.png"))
    print("doubt crops:", len(doubt_f), "->", "doubt_crops.png")
json.dump([{"k": k, "label": f['label'], "x": round(f['x'], 1), "y": round(f['y'], 1), "text": f['text']} for k, f in enumerate(doubt_f)], open(os.path.join(SP, "doubt_list.json"), "w"), indent=0)
