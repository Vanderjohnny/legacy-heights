"""Live session: render impostor cards (front / side / top, transparent) of the three tree species used in the scene."""
import bpy, os, math, json, time, traceback
from mathutils import Vector
OUT = r"C:\Users\pharo\AppData\Local\Temp\claude\G--Meu-Drive-01---PROJETOS-CLIENTES-UNK-BARBADOS\a37cf696-d793-41b3-a665-23d29cf6164a\scratchpad\trees"
LOG = os.path.join(os.path.dirname(OUT), "trees_render.log")
os.makedirs(OUT, exist_ok=True)
RES = 768
SPECIES = {"acer": "Real Tree Acer Saccharinum Spring3", "palm": "Palm Tree Medium Dense", "pine": "Pine Tree Monterey"}
t0 = time.time(); logf = open(LOG, "w", encoding="utf-8")
def L(*a):
    s = f"[{time.time()-t0:6.1f}s] " + " ".join(str(x) for x in a); logf.write(s + "\n"); logf.flush(); print(s)
orig = bpy.context.window.scene
ts = None; created = []
try:
    ts = bpy.data.scenes.new("__tmp_trees")
    engines = [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items]
    ts.render.engine = 'BLENDER_EEVEE' if 'BLENDER_EEVEE' in engines else ('BLENDER_EEVEE_NEXT' if 'BLENDER_EEVEE_NEXT' in engines else 'BLENDER_WORKBENCH')
    L("engine", ts.render.engine, "available", engines)
    ts.render.film_transparent = True
    ts.render.resolution_x = ts.render.resolution_y = RES; ts.render.resolution_percentage = 100
    ts.render.image_settings.file_format = 'PNG'; ts.render.image_settings.color_mode = 'RGBA'
    try: ts.view_settings.view_transform = 'Standard'
    except Exception: pass
    try: ts.eevee.taa_render_samples = 16
    except Exception: pass
    w = bpy.data.worlds.new("__tmp_world"); w.use_nodes = True
    bg = w.node_tree.nodes.get("Background")
    if bg: bg.inputs[0].default_value = (0.75, 0.78, 0.8, 1); bg.inputs[1].default_value = 1.0
    ts.world = w; created.append(w)
    sun = bpy.data.lights.new("__tmp_sun", 'SUN'); sun.energy = 3.0; sun.angle = math.radians(5)
    sob = bpy.data.objects.new("__tmp_sun", sun); ts.collection.objects.link(sob); sob.rotation_euler = (math.radians(50), 0, math.radians(-30))
    cam = bpy.data.cameras.new("__tmp_cam"); cam.type = 'ORTHO'; cam.clip_end = 500
    cob = bpy.data.objects.new("__tmp_cam", cam); ts.collection.objects.link(cob); ts.camera = cob
    meta = {}
    for key, cname in SPECIES.items():
        col = bpy.data.collections[cname]
        ts.collection.children.link(col)
        mn = Vector((1e9,) * 3); mx = Vector((-1e9,) * 3)
        for x in col.all_objects:
            if x.type == 'MESH':
                for c in x.bound_box:
                    wpt = x.matrix_world @ Vector(c); mn = Vector(map(min, mn, wpt)); mx = Vector(map(max, mx, wpt))
        size = mx - mn; ctr = (mn + mx) / 2
        S = max(size.x, size.y, size.z) * 1.04
        views = {
            "front": (Vector((ctr.x, mn.y - 200, mn.z + S / 2)), (math.radians(90), 0, 0)),
            "side": (Vector((mx.x + 200, ctr.y, mn.z + S / 2)), (math.radians(90), 0, math.radians(90))),
            "top": (Vector((ctr.x, ctr.y, mx.z + 200)), (0, 0, 0)),
        }
        cam.ortho_scale = S
        for vname, (loc, rot) in views.items():
            cob.location = loc; cob.rotation_euler = rot
            ts.render.filepath = os.path.join(OUT, f"{key}_{vname}.png")
            bpy.context.window.scene = ts
            bpy.ops.render.render(write_still=True)
            L("rendered", key, vname)
        meta[key] = {"collection": cname, "size": [round(v, 3) for v in size], "min": [round(v, 3) for v in mn], "max": [round(v, 3) for v in mx], "ortho": round(S, 3), "center": [round(v, 3) for v in ctr]}
        ts.collection.children.unlink(col)
    json.dump(meta, open(os.path.join(OUT, "meta.json"), "w"), indent=1)
    L("meta", meta)
except Exception:
    L("ERROR", traceback.format_exc())
finally:
    try:
        bpy.context.window.scene = orig
        if ts:
            for o in list(ts.collection.objects): bpy.data.objects.remove(o, do_unlink=True)
            bpy.data.scenes.remove(ts)
        for d in created:
            try: bpy.data.worlds.remove(d)
            except Exception: pass
        for nm in ("__tmp_cam", "__tmp_sun"):
            if nm in bpy.data.cameras: bpy.data.cameras.remove(bpy.data.cameras[nm])
            if nm in bpy.data.lights: bpy.data.lights.remove(bpy.data.lights[nm])
    except Exception as e:
        L("cleanup", e)
    L("done"); logf.close()
