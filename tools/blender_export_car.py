"""Export the car used by the site (assets/models/car.glb) from the open Blender file.

Run inside Blender (Text Editor > Run Script, or through the MCP bridge) with the car's root empty named in ROOT.
It copies the car's mesh children, bakes a decimation (RATIO per object), consolidates the ~60 original materials
into 9 simple ones (Paint is re-coloured per car by the site), exports them from a temporary scene (no other object
can leak in) WITHOUT Draco (Blender's Draco bridge crashed on this model) and cleans up.  Then compress:

    npx -y @gltf-transform/cli@4.5.0 optimize car_raw.glb car.glb --compress draco --texture-compress webp --simplify false --palette false --instance false --join false --flatten false

Model frame: length along X, front at -X, wheels resting on z = 0 (the site rotates it so the front points to +Z).
"""
import bpy, json, os, time

ROOT = "Audi A7 55 TFSI"
OUT = r"G:\Meu Drive\01 - PROJETOS\CLIENTES\UNK\BARBADOS\LEGACY\SITE\assets\models\car_raw.glb"
RATIO = {"Body_Part_Doors.003": 0.22, "front wheels": 0.38, "rear wheels": 0.045}   # decimate ratios per object

def principled(name, rgb, met=0.0, rough=0.5, alpha=1.0):
    m = bpy.data.materials.get("CAR_" + name) or bpy.data.materials.new("CAR_" + name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (rgb[0], rgb[1], rgb[2], 1.0)
    bsdf.inputs["Metallic"].default_value = met
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Alpha"].default_value = alpha
    if alpha < 1.0: m.blend_method = 'BLEND'
    return m

MATS = {
    "Paint": principled("Paint", (0.55, 0.05, 0.05), 0.6, 0.3),
    "Glass": principled("Glass", (0.05, 0.08, 0.10), 0.2, 0.05, 0.4),
    "Lights": principled("Lights", (0.95, 0.95, 0.95), 0.0, 0.1),
    "TailLight": principled("TailLight", (0.7, 0.03, 0.02), 0.0, 0.3),
    "Chrome": principled("Chrome", (0.85, 0.85, 0.85), 1.0, 0.15),
    "Rim": principled("Rim", (0.62, 0.62, 0.64), 1.0, 0.3),
    "Black": principled("Black", (0.02, 0.02, 0.02), 0.0, 0.6),
    "Grey": principled("Grey", (0.25, 0.25, 0.25), 0.2, 0.5),
    "Tyre": principled("Tyre", (0.012, 0.012, 0.012), 0.0, 0.9),
}
ORDER = list(MATS.keys())

def base_col(m):
    if m and m.use_nodes:
        for n in m.node_tree.nodes:
            if n.type == 'BSDF_PRINCIPLED':
                c = n.inputs['Base Color']; met = n.inputs['Metallic']
                return (None if c.is_linked else tuple(c.default_value[:3])), (None if met.is_linked else met.default_value)
    return None, None

def classify(m):
    """original material -> one of the 9 consolidated ones (by name, then by base colour)"""
    if not m: return 'Black'
    n = m.name.lower()
    if 'paint' in n: return 'Paint'
    if 'glass' in n or 'window' in n: return 'Glass'
    if n.startswith('light'): return 'Lights'
    if 'logo' in n: return 'Chrome'
    if 'rubber' in n: return 'Tyre'
    if 'brushed' in n or 'stainless' in n or 'alumin' in n: return 'Rim'
    if 'brake' in n: return 'Grey'
    if 'radiator' in n: return 'Black'
    col, met = base_col(m)
    if col is None: return 'Black'
    r, g, b = col
    if r > 0.5 and g < 0.1: return 'TailLight'
    lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
    if lum > 0.45: return 'Chrome' if (met or 0) > 0.5 else 'Grey'
    if lum > 0.12: return 'Grey'
    return 'Black'

def run():
    t0 = time.time()
    root = bpy.data.objects[ROOT]
    if os.path.exists(OUT): os.remove(OUT)
    main_scene = bpy.context.scene
    for sc in list(bpy.data.scenes):
        if sc.name.startswith("__car"): bpy.data.scenes.remove(sc)
    tmp_scene = bpy.data.scenes.new("__car_scene")
    holder = bpy.data.objects.new("car_export_root", None); tmp_scene.collection.objects.link(holder)
    copies, report, counts = [], [], {}
    for ch in root.children:
        if ch.type != 'MESH' or len(ch.data.polygons) == 0: continue
        ob = ch.copy(); ob.data = ch.data.copy(); ob.modifiers.clear()
        main_scene.collection.objects.link(ob)            # must be in the evaluated scene for the decimation
        mod = ob.modifiers.new("dec", 'DECIMATE'); mod.ratio = RATIO.get(ch.name, 0.3); mod.use_collapse_triangulate = True
        dg = bpy.context.evaluated_depsgraph_get()
        me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
        ob.modifiers.clear()
        old = ob.data; ob.data = me
        mapping = [ORDER.index(classify(m)) for m in old.materials] if len(old.materials) else [ORDER.index('Black')]
        vals = [0] * len(me.polygons)
        me.polygons.foreach_get("material_index", vals)   # read BEFORE materials.clear(): clearing resets the indices
        new_vals = [mapping[v] if v < len(mapping) else ORDER.index('Black') for v in vals]
        me.materials.clear()
        for k in ORDER: me.materials.append(MATS[k])
        me.polygons.foreach_set("material_index", new_vals)
        me.update()
        for v in new_vals: counts[ORDER[v]] = counts.get(ORDER[v], 0) + 1
        main_scene.collection.objects.unlink(ob)
        tmp_scene.collection.objects.link(ob)
        ob.parent = holder; ob.matrix_parent_inverse.identity()
        ob.location = ch.location; ob.rotation_euler = ch.rotation_euler; ob.scale = ch.scale
        ob.name = "car_" + ch.name.split('.')[0].replace(' ', '_'); me.name = ob.name
        copies.append(ob)
        report.append((ob.name, sum(len(p.vertices) - 2 for p in me.polygons)))
        if old.users == 0: bpy.data.meshes.remove(old)
    win = bpy.context.window
    prev = win.scene
    win.scene = tmp_scene
    try:
        bpy.ops.export_scene.gltf(filepath=OUT, use_selection=False, use_visible=False, use_active_scene=True, export_apply=False, export_format='GLB',
                                  export_draco_mesh_compression_enable=False, export_materials='EXPORT', export_yup=True, export_animations=False, export_skins=False, export_morph=False)
    finally:
        win.scene = prev
    size = os.path.getsize(OUT)
    for ob in copies:
        me = ob.data; bpy.data.objects.remove(ob)
        if me.users == 0: bpy.data.meshes.remove(me)
    bpy.data.objects.remove(holder)
    bpy.data.scenes.remove(tmp_scene)
    print(json.dumps({"report": report, "faces_per_material": counts, "bytes": size, "seconds": round(time.time() - t0, 1)}))

run()
