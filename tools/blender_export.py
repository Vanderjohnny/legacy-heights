"""Legacy Heights - export for the three.js site (v2, for Legacy_Heights_REV11 and later).
Run headless (recommended, ~1 min):
    blender -b Legacy_Heights_REVxx.blend --python tools/blender_export.py
or inside the open file (Text Editor > Run Script). Nothing is saved into the .blend.

Writes:
  SITE/assets/models/ground.glb        every visible ground mesh (lots, roads, sidewalks, curbs, driveways, parks, hedges)
                                       merged into one Draco mesh; faces flipped to point up; stray geometry dropped
  SITE/assets/models/house_1..6.glb    the six house bodies (raw PNG textures: run tools/optimize_models.bat afterwards)
  SITE/data/site.json                  houses (with the stable Blender property_id), lot polygons/areas/labels, trees

Vegetation and house collections are excluded from the view layer while the ground is realised: iterating the depsgraph
instances with the tree assets enabled takes ~15 minutes (millions of leaf instances)."""
import bpy, json, math, os, time, traceback
import numpy as np
from mathutils import Vector

SITE = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")) if "__file__" in globals() else r"G:\Meu Drive\01 - PROJETOS\CLIENTES\UNK\BARBADOS\LEGACY\SITE"
MODELS = os.path.join(SITE, "assets", "models"); DATA = os.path.join(SITE, "data")
os.makedirs(MODELS, exist_ok=True); os.makedirs(DATA, exist_ok=True)
HOUSE_TRIS = 7000                     # decimate a body only if it has more triangles than this
COLORS = ["Oak Tone", "Caramel cloud", "isle dreamns", "in the blue", "Marzipan", "Pinkathon"]
GROUND_COLS = {"01 - Terreno SKP atual", "REV03 - Calcadas corrigidas", "REV03 - Elementos repetidos", "REV05 - Ruas externas e parques",
               "REV08 - Acessos da cena atual", "REV09 - Acessos da cena atual", "REV10 - Correcoes conferidas", "REV11 - Calcadas e divisas"}
HEAVY_COLS = ["REV03 - Vegetacao do usuario", "REV03 - Casas instanciadas"]
BOX = (-400.0, 1000.0, -400.0, 1100.0, -30.0, 60.0)   # faces with a vertex outside this box (stray geometry) are dropped

t0 = time.time()
def L(*a): print(f"[{time.time()-t0:6.1f}s]", *a, flush=True)
sc = bpy.context.scene; vl = bpy.context.view_layer
CASAS = bpy.data.collections["REV03 - Casas instanciadas"]; VEG = bpy.data.collections["REV03 - Vegetacao do usuario"]

def layer_col(col):
    def walk(lc):
        if lc.collection == col: return lc
        for ch in lc.children:
            r = walk(ch)
            if r: return r
    return walk(vl.layer_collection)
def deselect_all():
    for o in vl.objects:
        try: o.select_set(False)
        except Exception: pass
def export_sel(path, textures, quant):
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_apply=True, export_yup=True,
        export_materials='EXPORT', export_image_format=('AUTO' if textures else 'NONE'), export_normals=True, export_texcoords=textures,
        export_animations=False, export_skins=False, export_cameras=False, export_lights=False, export_extras=False,
        export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=6, export_draco_position_quantization=quant)
    L("exported", os.path.basename(path), round(os.path.getsize(path) / 1024), "KB")
def tri_count(ob):
    dg = bpy.context.evaluated_depsgraph_get(); ev = ob.evaluated_get(dg)
    return sum(len(p.vertices) - 2 for p in ev.data.polygons)

tmpcol = bpy.data.collections.new("__tmp_export"); sc.collection.children.link(tmpcol)
made_objs = []; made_meshes = []; made_mats = []; excluded = []
try:
    # ------------------------------------------------------------ ground: one merged triangle mesh
    for name in HEAVY_COLS:
        col = bpy.data.collections.get(name); lc = layer_col(col) if col else None
        if lc and not lc.exclude: lc.exclude = True; excluded.append(lc)
    dg = bpy.context.evaluated_depsgraph_get()
    def visible_orig(o): return not (o.hide_render or o.hide_viewport)
    def in_ground(o): return any(c.name in GROUND_COLS for c in o.users_collection)
    V = []; T = []; MIDX = []; mats = []; mat_map = {}; voff = 0; nparts = 0; dropped = {}; per_mat = {}
    for inst in dg.object_instances:
        ob = inst.object
        if ob.type != 'MESH': continue
        src = inst.parent.original if inst.is_instance else ob.original
        if not in_ground(src) or not visible_orig(src): continue
        me = ob.data
        if me is None or len(me.polygons) == 0: continue
        me.calc_loop_triangles(); ntri = len(me.loop_triangles)
        if ntri == 0: continue
        nv = len(me.vertices)
        co = np.empty(nv * 3, dtype=np.float32); me.vertices.foreach_get('co', co); co = co.reshape(-1, 3)
        M = np.array(inst.matrix_world, dtype=np.float64); cw = co @ M[:3, :3].T + M[:3, 3]
        tri = np.empty(ntri * 3, dtype=np.int32); me.loop_triangles.foreach_get('vertices', tri); tri = tri.reshape(-1, 3)
        pidx = np.empty(ntri, dtype=np.int32); me.loop_triangles.foreach_get('polygon_index', pidx)
        pm = np.empty(len(me.polygons), dtype=np.int32); me.polygons.foreach_get('material_index', pm); mi = pm[pidx]
        ok_v = (cw[:, 0] > BOX[0]) & (cw[:, 0] < BOX[1]) & (cw[:, 1] > BOX[2]) & (cw[:, 1] < BOX[3]) & (cw[:, 2] > BOX[4]) & (cw[:, 2] < BOX[5])
        keep = ok_v[tri].all(axis=1)
        if not keep.all():
            dropped[src.name] = int((~keep).sum()); tri = tri[keep]; mi = mi[keep]
            if len(tri) == 0: continue
        local = list(me.materials) if len(me.materials) else [None]
        remap = np.zeros(max(len(local), 1), dtype=np.int32)
        for j, m in enumerate(local):
            key = m.name if m else "__none"
            if key not in mat_map: mat_map[key] = len(mats); mats.append(m)
            remap[j] = mat_map[key]
        mi = remap[np.clip(mi, 0, len(local) - 1)]
        for k in np.unique(mi):
            nm = mats[k].name if mats[k] else None; per_mat[nm] = per_mat.get(nm, 0) + int((mi == k).sum())
        V.append(cw.astype(np.float32)); T.append(tri + voff); MIDX.append(mi); voff += nv; nparts += 1
    L("ground parts", nparts, "verts", voff, "tris", sum(len(t) for t in T), "dropped", dropped)
    L("tris per material", per_mat)
    Vall = np.concatenate(V); Tall = np.concatenate(T); Mall = np.concatenate(MIDX)
    a = Vall[Tall[:, 0]].astype(np.float64); b = Vall[Tall[:, 1]].astype(np.float64); c = Vall[Tall[:, 2]].astype(np.float64)
    nz = (b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (b[:, 1] - a[:, 1]) * (c[:, 0] - a[:, 0])
    flip = nz < -1e-9; Tall[flip] = Tall[flip][:, [0, 2, 1]]
    L("flipped downward-facing triangles:", int(flip.sum()))
    mesh = bpy.data.meshes.new("__ground_export"); made_meshes.append(mesh)
    mesh.vertices.add(len(Vall)); mesh.vertices.foreach_set('co', Vall.ravel())
    nt = len(Tall)
    mesh.loops.add(nt * 3); mesh.loops.foreach_set('vertex_index', Tall.ravel())
    mesh.polygons.add(nt); mesh.polygons.foreach_set('loop_start', np.arange(0, nt * 3, 3, dtype=np.int32)); mesh.polygons.foreach_set('loop_total', np.full(nt, 3, dtype=np.int32))
    mesh.polygons.foreach_set('material_index', Mall.astype(np.int32))
    for m in mats: mesh.materials.append(m)
    mesh.update(calc_edges=True); mesh.validate(verbose=False)
    gob = bpy.data.objects.new("__ground_export", mesh); tmpcol.objects.link(gob); made_objs.append(gob)
    deselect_all(); gob.select_set(True); vl.objects.active = gob
    export_sel(os.path.join(MODELS, "ground.glb"), textures=False, quant=16)
    bnd_min = [float(v) for v in Vall.min(axis=0)]; bnd_max = [float(v) for v in Vall.max(axis=0)]
    for lc in excluded: lc.exclude = False
    excluded = []

    # ------------------------------------------------------------ houses (6 bodies)
    house_models = {}
    for i in range(1, 7):
        col = bpy.data.collections[f"REV04 - Casa {i} cor Oak Tone"]
        src = [o for o in col.all_objects if o.type == 'MESH'][0]
        me = src.data.copy(); made_meshes.append(me)
        ob = src.copy(); ob.data = me; ob.name = f"house_{i}"; ob.parent = None; ob.matrix_world = src.matrix_world.copy()
        tmpcol.objects.link(ob); made_objs.append(ob)
        try:
            import bmesh
            bm = bmesh.new(); bm.from_mesh(me); bmesh.ops.recalc_face_normals(bm, faces=bm.faces); bm.to_mesh(me); bm.free()
        except Exception as e: L("normals", e)
        fac = bpy.data.materials.new("FACADE"); made_mats.append(fac); fac.use_nodes = True
        bsdf = next(n for n in fac.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
        bsdf.inputs['Base Color'].default_value = (1, 1, 1, 1); bsdf.inputs['Roughness'].default_value = 0.9
        nfac = 0
        for slot in ob.material_slots:
            if slot.material and any(cn in slot.material.name for cn in COLORS): slot.material = fac; nfac += 1
        t1 = tri_count(ob)
        if t1 > HOUSE_TRIS:
            m = ob.modifiers.new("planar", "DECIMATE"); m.decimate_type = 'DISSOLVE'; m.angle_limit = math.radians(3); m.delimit = {'MATERIAL', 'UV', 'SEAM'}
            t1b = tri_count(ob)
            if t1b > HOUSE_TRIS:
                m2 = ob.modifiers.new("collapse", "DECIMATE"); m2.decimate_type = 'COLLAPSE'; m2.ratio = HOUSE_TRIS / t1b; m2.use_collapse_triangulate = True
        t2 = tri_count(ob)
        bb = [ob.matrix_world @ Vector(cc) for cc in ob.bound_box]
        house_models[i] = {"tris": t2, "bbox_min": [round(min(v[k] for v in bb), 2) for k in range(3)], "bbox_max": [round(max(v[k] for v in bb), 2) for k in range(3)]}
        L(f"house {i}: facade slots {nfac}, tris {t1} -> {t2}")
        deselect_all(); ob.select_set(True); vl.objects.active = ob
        export_sel(os.path.join(MODELS, f"house_{i}.glb"), textures=True, quant=14)
        bpy.data.materials.remove(fac); made_mats.remove(fac)

    # ------------------------------------------------------------ data
    def lot_outline(mesh_obj):
        me = mesh_obj.data; mw = mesh_obj.matrix_world; edge_faces = {}
        for p in me.polygons:
            for ek in p.edge_keys: edge_faces[ek] = edge_faces.get(ek, 0) + 1
        adj = {}
        for (a_, b_), cnt in edge_faces.items():
            if cnt == 1: adj.setdefault(a_, []).append(b_); adj.setdefault(b_, []).append(a_)
        loops = []; used = set()
        for start in adj:
            if start in used: continue
            loop = [start]; used.add(start); prev = None; cur = start
            while True:
                nxts = [n for n in adj[cur] if n != prev and n not in used]
                if not nxts: break
                nxt = nxts[0]; loop.append(nxt); used.add(nxt); prev, cur = cur, nxt
            loops.append(loop)
        if not loops: return []
        loops.sort(key=len, reverse=True)
        pts = [mw @ me.vertices[i].co for i in loops[0]]; out = []; n = len(pts)
        for k in range(n):
            a_, b_, c_ = pts[k - 1], pts[k], pts[(k + 1) % n]; v1 = (b_ - a_).xy; v2 = (c_ - b_).xy
            if v1.length < 0.02: continue
            if v1.length > 1e-9 and v2.length > 1e-9 and abs(v1.x * v2.y - v1.y * v2.x) / (v1.length * v2.length) < 0.0175 and v1.dot(v2) > 0: continue
            out.append([round(b_.x, 2), round(b_.y, 2)])
        return out
    def poly_centroid(poly):
        A = cx = cy = 0; n = len(poly)
        for k in range(n):
            x0, y0 = poly[k]; x1, y1 = poly[(k + 1) % n]; cr = x0 * y1 - x1 * y0; A += cr; cx += (x0 + x1) * cr; cy += (y0 + y1) * cr
        if abs(A) < 1e-9: return [round(sum(p[0] for p in poly) / n, 2), round(sum(p[1] for p in poly) / n, 2)]
        return [round(cx / (3 * A), 2), round(cy / (3 * A), 2)]
    old = {}
    try: old = json.load(open(os.path.join(DATA, "site.json"), encoding="utf-8")).get("lots", {})
    except Exception: pass
    lots = {}
    for e in bpy.data.objects['Terrenos'].children:
        m = next((ch for ch in e.children if ch.type == 'MESH'), None)
        if not m: continue
        poly = lot_outline(m)
        lots[e.name] = {"id": e.name, "area_m2": round(sum(p.area for p in m.data.polygons), 1), "poly": poly,
                        "center": poly_centroid(poly) if len(poly) >= 3 else [round(m.matrix_world.translation.x, 2), round(m.matrix_world.translation.y, 2)],
                        "hidden": bool(m.hide_render or m.hide_viewport)}
        if e.name in old and old[e.name].get("label"): lots[e.name]["label"] = old[e.name]["label"]
    houses = []
    for o in sorted(CASAS.objects, key=lambda x: x.name):
        mw = o.matrix_world; eul = mw.to_euler(); scl = mw.to_scale()
        houses.append({"id": o.name.split('|')[0].strip(), "obj": o.name, "pid": o.get('property_id'), "lot": o.get('lotes'), "prevLot": o.get('lotes_anteriores'),
                       "model": int(o.get('modelo', 0)), "pdf": o.get('padrao_pdf'), "color": o.get('cor_fachada'),
                       "pos": [round(v, 3) for v in mw.translation], "rot": [round(math.degrees(v), 2) for v in eul], "scale": [round(v, 3) for v in scl]})
    species = {}; species_info = []; trees = []
    for o in VEG.objects:
        c = o.instance_collection
        if not c: continue
        if c.name not in species:
            mn = Vector((1e9,) * 3); mx = Vector((-1e9,) * 3)
            for x in c.all_objects:
                if x.type == 'MESH':
                    for cc in x.bound_box:
                        w = x.matrix_world @ Vector(cc); mn = Vector(map(min, mn, w)); mx = Vector(map(max, mx, w))
            species[c.name] = len(species_info)
            species_info.append({"name": c.name, "size": [round(v, 2) for v in (mx - mn)], "zmin": round(mn.z, 2), "offset": [round(v, 3) for v in c.instance_offset]})
        mw = o.matrix_world; loc = mw.translation; scl = mw.to_scale()
        trees.append({"s": species[c.name], "p": [round(loc.x, 2), round(loc.y, 2), round(loc.z, 2)], "r": round(math.degrees(mw.to_euler().z), 1), "sc": round((scl.x + scl.y) / 2, 3), "sz": round(scl.z, 3)})
    colors = {}
    for name in COLORS:
        mat = bpy.data.materials.get("02 - Biblioteca de casas | " + name)
        bsdf = next((n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None) if mat else None
        colors[name] = [round(v, 4) for v in bsdf.inputs['Base Color'].default_value[:3]] if bsdf else [0.8, 0.8, 0.8]
    data = {"source": os.path.basename(bpy.data.filepath), "exported": time.strftime("%Y-%m-%d %H:%M"),
            "bounds": {"min": [round(v, 2) for v in bnd_min], "max": [round(v, 2) for v in bnd_max]}, "colors": colors, "models": house_models,
            "houses": houses, "lots": lots, "species": species_info, "trees": trees, "usedLots": sorted({h["lot"] for h in houses if h["lot"]})}
    with open(os.path.join(DATA, "site.json"), "w", encoding="utf-8") as f: json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
    L("site.json: houses", len(houses), "lots", len(lots), "trees", len(trees), "labels kept", sum(1 for l in lots.values() if l.get("label")))
except Exception:
    L("ERROR", traceback.format_exc())
finally:
    for lc in excluded: lc.exclude = False
    for o in made_objs:
        try: bpy.data.objects.remove(o, do_unlink=True)
        except Exception: pass
    for me in made_meshes:
        try:
            if me.users == 0: bpy.data.meshes.remove(me)
        except Exception: pass
    for m in made_mats:
        try: bpy.data.materials.remove(m)
        except Exception: pass
    try: sc.collection.children.unlink(tmpcol); bpy.data.collections.remove(tmpcol)
    except Exception: pass
    L("done")
