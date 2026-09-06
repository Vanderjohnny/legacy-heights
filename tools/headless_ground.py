"""Headless ground export v2: vegetation/houses excluded from the view layer (fast), geometry taken as Blender's own
loop triangles (so concave SketchUp faces with seams survive; mesh.validate() used to delete them), stray faces dropped."""
import bpy, os, time, traceback
import numpy as np
SITE = r"G:\Meu Drive\01 - PROJETOS\CLIENTES\UNK\BARBADOS\LEGACY\SITE"
OUT = os.path.join(SITE, "assets", "models", "ground.glb")
LOG = r"C:\Users\pharo\AppData\Local\Temp\claude\G--Meu-Drive-01---PROJETOS-CLIENTES-UNK-BARBADOS\a37cf696-d793-41b3-a665-23d29cf6164a\scratchpad\ground2_export.log"
GROUND_COLS = {"01 - Terreno SKP atual", "REV03 - Calcadas corrigidas", "REV03 - Elementos repetidos", "REV05 - Ruas externas e parques"}
HEAVY = ["REV03 - Vegetacao do usuario", "REV03 - Casas instanciadas"]
BOX = (-400.0, 1000.0, -400.0, 1100.0, -30.0, 60.0)
t0 = time.time(); logf = open(LOG, "w", encoding="utf-8")
def L(*a):
    s = f"[{time.time()-t0:6.1f}s] " + " ".join(str(x) for x in a); logf.write(s + "\n"); logf.flush(); print(s, flush=True)
sc = bpy.context.scene; vl = bpy.context.view_layer
def layer_col(col):
    def walk(lc):
        if lc.collection == col: return lc
        for ch in lc.children:
            r = walk(ch)
            if r: return r
    return walk(vl.layer_collection)
try:
    for name in HEAVY: layer_col(bpy.data.collections[name]).exclude = True
    dg = bpy.context.evaluated_depsgraph_get()
    def visible_orig(o): return not (o.hide_render or o.hide_viewport)
    def in_ground(o): return any(c.name in GROUND_COLS for c in o.users_collection)
    V = []; T = []; MIDX = []; mats = []; mat_map = {}; voff = 0; nparts = 0; dropped = {}; per_mat_tris = {}
    for inst in dg.object_instances:
        ob = inst.object
        if ob.type != 'MESH': continue
        src = inst.parent.original if inst.is_instance else ob.original
        if not in_ground(src) or not visible_orig(src): continue
        me = ob.data
        if me is None or len(me.polygons) == 0: continue
        me.calc_loop_triangles()
        ntri = len(me.loop_triangles)
        if ntri == 0: continue
        nv = len(me.vertices)
        co = np.empty(nv * 3, dtype=np.float32); me.vertices.foreach_get('co', co); co = co.reshape(-1, 3)
        M = np.array(inst.matrix_world, dtype=np.float64); cw = co @ M[:3, :3].T + M[:3, 3]
        tri = np.empty(ntri * 3, dtype=np.int32); me.loop_triangles.foreach_get('vertices', tri); tri = tri.reshape(-1, 3)
        pidx = np.empty(ntri, dtype=np.int32); me.loop_triangles.foreach_get('polygon_index', pidx)
        pm = np.empty(len(me.polygons), dtype=np.int32); me.polygons.foreach_get('material_index', pm)
        mi = pm[pidx]
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
        for k in np.unique(mi): per_mat_tris[mats[k].name if mats[k] else None] = per_mat_tris.get(mats[k].name if mats[k] else None, 0) + int((mi == k).sum())
        V.append(cw.astype(np.float32)); T.append(tri + voff); MIDX.append(mi); voff += nv; nparts += 1
    L("parts", nparts, "verts", voff, "tris", sum(len(t) for t in T), "dropped", dropped)
    L("tris per material", per_mat_tris)
    Vall = np.concatenate(V); Tall = np.concatenate(T); Mall = np.concatenate(MIDX)
    # ground faces must point up: flip triangles whose normal has a negative Z (parks etc. come from SketchUp reversed)
    a = Vall[Tall[:, 0]].astype(np.float64); b = Vall[Tall[:, 1]].astype(np.float64); c = Vall[Tall[:, 2]].astype(np.float64)
    nz = (b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (b[:, 1] - a[:, 1]) * (c[:, 0] - a[:, 0])
    flip = nz < -1e-9
    Tall[flip] = Tall[flip][:, [0, 2, 1]]
    L("flipped downward-facing triangles:", int(flip.sum()))
    mesh = bpy.data.meshes.new("__ground_export")
    mesh.vertices.add(len(Vall)); mesh.vertices.foreach_set('co', Vall.ravel())
    nt = len(Tall)
    mesh.loops.add(nt * 3); mesh.loops.foreach_set('vertex_index', Tall.ravel())
    mesh.polygons.add(nt); mesh.polygons.foreach_set('loop_start', np.arange(0, nt * 3, 3, dtype=np.int32)); mesh.polygons.foreach_set('loop_total', np.full(nt, 3, dtype=np.int32))
    mesh.polygons.foreach_set('material_index', Mall.astype(np.int32))
    for m in mats: mesh.materials.append(m)
    mesh.update(calc_edges=True)
    bad = mesh.validate(verbose=False)
    L("mesh built", len(mesh.vertices), "verts", len(mesh.polygons), "tris; validate changed:", bad)
    # optional planar dissolve (DISSOLVE=1). Off by default: dissolving boundary vertices flattens curved road edges.
    import bmesh, math
    if os.environ.get('DISSOLVE') == '1':
        bm = bmesh.new(); bm.from_mesh(mesh)
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.002)
        bmesh.ops.dissolve_limit(bm, angle_limit=math.radians(4.0), use_dissolve_boundaries=True, verts=bm.verts, edges=bm.edges, delimit={'MATERIAL'})
        bm.to_mesh(mesh); bm.free(); mesh.update()
        L("after planar dissolve:", len(mesh.vertices), "verts", len(mesh.polygons), "faces, ~tris", sum(len(pg.vertices) - 2 for pg in mesh.polygons))
    col = bpy.data.collections.new("__tmp_ground"); sc.collection.children.link(col)
    gob = bpy.data.objects.new("__ground_export", mesh); col.objects.link(gob)
    for o in vl.objects:
        try: o.select_set(False)
        except Exception: pass
    gob.select_set(True); vl.objects.active = gob
    bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', use_selection=True, export_apply=True, export_yup=True,
        export_materials='EXPORT', export_image_format='NONE', export_normals=True, export_texcoords=False,
        export_animations=False, export_skins=False, export_cameras=False, export_lights=False, export_extras=False,
        export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=6, export_draco_position_quantization=16)
    L("exported", OUT, round(os.path.getsize(OUT) / 1024), "KB")
except Exception:
    L("ERROR", traceback.format_exc())
L("done"); logf.close()
