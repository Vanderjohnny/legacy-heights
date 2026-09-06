"""Headless: realise the hidden curb object ("Meios-fios instanciados", geometry-nodes instances) into one mesh and export curbs.glb.
Also reports road / sidewalk heights. Vegetation + houses are excluded from the view layer first (fast depsgraph)."""
import bpy, os, time, traceback
import numpy as np
SITE = r"G:\Meu Drive\01 - PROJETOS\CLIENTES\UNK\BARBADOS\LEGACY\SITE"
OUT = os.path.join(SITE, "assets", "models", "curbs.glb")
LOG = r"C:\Users\pharo\AppData\Local\Temp\claude\G--Meu-Drive-01---PROJETOS-CLIENTES-UNK-BARBADOS\a37cf696-d793-41b3-a665-23d29cf6164a\scratchpad\curbs_export.log"
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
    for name in ["REV03 - Vegetacao do usuario", "REV03 - Casas instanciadas"]:
        lc = layer_col(bpy.data.collections[name]); lc.exclude = True
    # heights: road vs sidewalk
    for on in ["Ruas 001 - superficie", "Calcadas 001 - faixa plana preservada", "Calcadas 002 - faixa plana preservada"]:
        o = bpy.data.objects.get(on)
        if o and o.type == 'MESH':
            zs = [(o.matrix_world @ v.co).z for v in o.data.vertices]
            L(f"{on}: z min {min(zs):.3f} max {max(zs):.3f} mean {sum(zs)/len(zs):.3f}")
    targets = [o for o in bpy.data.objects if 'meio' in o.name.lower() or 'meios-fio' in o.name.lower()]
    L("curb-like objects:", [(o.name, o.type, o.hide_viewport, o.hide_render, len(o.modifiers), [m.type for m in o.modifiers]) for o in targets])
    ob = bpy.data.objects["Meios-fios instanciados"]
    ob.hide_viewport = False; ob.hide_render = False
    try: ob.hide_set(False)
    except Exception: pass
    for c in ob.users_collection: L("in collection", c.name)
    dg = bpy.context.evaluated_depsgraph_get()
    V = []; LOOPS = []; F_start = []; F_total = []; MIDX = []; mats = []; mat_map = {}; voff = 0; loff = 0; nparts = 0
    for inst in dg.object_instances:
        o = inst.object
        if o.type != 'MESH': continue
        src = inst.parent.original if inst.is_instance else o.original
        if src != ob: continue
        me = o.data
        if me is None or len(me.polygons) == 0: continue
        nv, nl, npf = len(me.vertices), len(me.loops), len(me.polygons)
        co = np.empty(nv * 3, dtype=np.float32); me.vertices.foreach_get('co', co); co = co.reshape(-1, 3)
        M = np.array(inst.matrix_world, dtype=np.float64); cw = co @ M[:3, :3].T + M[:3, 3]
        ls = np.empty(npf, dtype=np.int32); me.polygons.foreach_get('loop_start', ls)
        lt = np.empty(npf, dtype=np.int32); me.polygons.foreach_get('loop_total', lt)
        mi = np.empty(npf, dtype=np.int32); me.polygons.foreach_get('material_index', mi)
        vi = np.empty(nl, dtype=np.int32); me.loops.foreach_get('vertex_index', vi)
        local = list(me.materials) if len(me.materials) else [None]
        remap = np.zeros(max(len(local), 1), dtype=np.int32)
        for j, m in enumerate(local):
            key = m.name if m else "__none"
            if key not in mat_map: mat_map[key] = len(mats); mats.append(m)
            remap[j] = mat_map[key]
        mi = np.clip(mi, 0, len(local) - 1)
        V.append(cw.astype(np.float32)); LOOPS.append(vi + voff); F_start.append(ls + loff); F_total.append(lt); MIDX.append(remap[mi])
        voff += nv; loff += len(vi); nparts += 1
    L("curb parts:", nparts, "verts:", voff, "faces:", sum(len(x) for x in F_total), "materials:", [m.name if m else None for m in mats])
    if nparts == 0: raise RuntimeError("no curb geometry realised")
    Vall = np.concatenate(V); Lall = np.concatenate(LOOPS); Sall = np.concatenate(F_start); Tall = np.concatenate(F_total); Mall = np.concatenate(MIDX)
    L("curb bbox", [round(float(v), 2) for v in Vall.min(axis=0)], [round(float(v), 2) for v in Vall.max(axis=0)])
    mesh = bpy.data.meshes.new("__curbs")
    mesh.vertices.add(len(Vall)); mesh.vertices.foreach_set('co', Vall.ravel())
    mesh.loops.add(len(Lall)); mesh.loops.foreach_set('vertex_index', Lall)
    mesh.polygons.add(len(Sall)); mesh.polygons.foreach_set('loop_start', Sall); mesh.polygons.foreach_set('loop_total', Tall); mesh.polygons.foreach_set('material_index', Mall)
    if not mats or mats == [None]:
        m = bpy.data.materials.new("Meio-fio"); mesh.materials.append(m)
    else:
        for m in mats: mesh.materials.append(m)
    mesh.update(calc_edges=True); mesh.validate(verbose=False)
    import bmesh
    bm = bmesh.new(); bm.from_mesh(mesh)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.002)
    bottoms = [f for f in bm.faces if f.normal.z < -0.5]
    bmesh.ops.delete(bm, geom=bottoms, context='FACES')
    bm.to_mesh(mesh); bm.free(); mesh.update()
    L("curbs after weld/bottom removal:", len(mesh.vertices), "verts", len(mesh.polygons), "faces")
    col = bpy.data.collections.new("__tmp_curbs"); sc.collection.children.link(col)
    cob = bpy.data.objects.new("__curbs", mesh); col.objects.link(cob)
    for o in vl.objects:
        try: o.select_set(False)
        except Exception: pass
    cob.select_set(True); vl.objects.active = cob
    bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', use_selection=True, export_apply=True, export_yup=True,
        export_materials='EXPORT', export_image_format='NONE', export_normals=True, export_texcoords=False,
        export_animations=False, export_skins=False, export_cameras=False, export_lights=False, export_extras=False,
        export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=6, export_draco_position_quantization=16)
    L("exported", OUT, round(os.path.getsize(OUT) / 1024), "KB")
except Exception:
    L("ERROR", traceback.format_exc())
L("done"); logf.close()
