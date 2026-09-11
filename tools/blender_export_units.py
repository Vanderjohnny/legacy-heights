"""Export a VERTICAL project (building / tower / condominium) from Blender to the site, headless:

    blender -b BLENDER/<file>.blend --python tools/blender_export_units.py -- --out "<SITE folder>" [--prefix TA_] [--draco]

Conventions in the .blend (references/02 of the masterplan-3d-site skill):
  * collections FLOOR_00, FLOOR_01, ... (PAV_NN / ANDAR_NN also accepted): everything of that floor (slab, walls,
    glass, balconies). Each floor becomes one glTF node "floor_NN" so the site can ghost / hide / explode the floors
    above the selected one.
  * collection GROUND (or a name containing TERRENO): ground meshes -> assets/models/ground.glb; materials are matched
    by name on the site (grama/terreno, rua/asfalto, calcada/concreto/acesso, meio-fio/curb, cerca/hedge, pintura,
    caminho) exactly like the horizontal projects.
  * any other collection (ROOF, CONTEXT, ...): static geometry exported with the building.
  * one marker object per sellable unit: an Empty (display CUBE) or a mesh named UNIT_<code>, with custom properties
    unit_id (stable id; generated from tower + code when missing), code, floor (else the FLOOR collection it is in),
    tower (default T1), type (integer key of TYPES in src/config.js), area_m2, beds, baths (all optional but code).
    The marker's box (location, rotation Z, size) is the picking box of the unit on the site.
Writes assets/models/building.glb, assets/models/ground.glb (when GROUND exists) and data/site.json
(typology "building"). The .blend is never saved; the scene is only rearranged in memory for the export."""
import json, math, os, re, sys, uuid
import bpy
from mathutils import Vector

FLOOR_RE = re.compile(r'^(?:FLOOR|PAV|PAVIMENTO|ANDAR)[ _-]?(-?\d+)', re.I)
ROOF_RE = re.compile(r'^(?:ROOF|COBERTURA|TELHADO)', re.I)   # exported as the floor above the top one, so it follows the reveal


def parse_args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    out, prefix, draco, i = None, None, False, 0
    while i < len(argv):
        a = argv[i]
        if a == '--out' and i + 1 < len(argv): out = argv[i + 1]; i += 2
        elif a == '--prefix' and i + 1 < len(argv): prefix = argv[i + 1]; i += 2
        elif a == '--draco': draco = True; i += 1
        else: i += 1
    if not out: raise SystemExit('usage: blender -b file.blend --python blender_export_units.py -- --out <SITE folder> [--prefix XX_] [--draco]')
    return out, prefix, draco


def is_unit(o):
    return o.name.upper().startswith('UNIT_') or 'unit_id' in o.keys() or 'code' in o.keys()


def local_bbox(o):
    if o.type == 'MESH' and o.data and len(o.data.vertices):
        xs = [v[0] for v in o.bound_box]; ys = [v[1] for v in o.bound_box]; zs = [v[2] for v in o.bound_box]
        return Vector((min(xs), min(ys), min(zs))), Vector((max(xs), max(ys), max(zs)))
    s = getattr(o, 'empty_display_size', 1.0)
    return Vector((-s, -s, -s)), Vector((s, s, s))


def unit_box(o):
    """picking box in Blender world coordinates: centre, size (already scaled), rotation around Z (degrees)"""
    lmin, lmax = local_bbox(o)
    lc = (lmin + lmax) / 2
    loc, rot, scale = o.matrix_world.decompose()
    centre = o.matrix_world @ lc
    size = Vector(((lmax.x - lmin.x) * abs(scale.x), (lmax.y - lmin.y) * abs(scale.y), (lmax.z - lmin.z) * abs(scale.z)))
    rz = math.degrees(rot.to_euler('XYZ').z)
    return [round(v, 3) for v in centre], [round(max(v, 0.2), 3) for v in size], round(rz, 2)


def world_bounds(objects):
    xs, ys, zs = [], [], []
    for o in objects:
        if o.type != 'MESH': continue
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c); xs.append(w.x); ys.append(w.y); zs.append(w.z)
    if not xs: return None
    return [min(xs), min(ys), min(zs)], [max(xs), max(ys), max(zs)]


def unexclude_all(layer_col):
    layer_col.exclude = False
    layer_col.hide_viewport = False
    for c in layer_col.children: unexclude_all(c)


def export_glb(path, objects, draco):
    """export exactly `objects` (visible), everything else hidden"""
    keep = set(o.name for o in objects)
    for o in bpy.data.objects:
        try: o.hide_set(o.name not in keep)
        except RuntimeError: pass
        o.hide_viewport = False
    kwargs = dict(filepath=path, export_format='GLB', use_visible=True, use_selection=False, export_apply=True, export_yup=True,
                  export_materials='EXPORT', export_animations=False, export_skins=False, export_morph=False, export_lights=False,
                  export_cameras=False, export_extras=False)
    if draco: kwargs['export_draco_mesh_compression_enable'] = True
    try:
        bpy.ops.export_scene.gltf(**kwargs)
    except TypeError:
        for k in ('export_extras', 'export_morph', 'export_skins'): kwargs.pop(k, None)
        bpy.ops.export_scene.gltf(**kwargs)
    print(f'[export] {path} ({os.path.getsize(path) // 1024} KB, {len(objects)} objects)')


def export(out_dir, prefix=None, draco=False):
    out_dir = os.path.abspath(out_dir)
    models = os.path.join(out_dir, 'assets', 'models'); data_dir = os.path.join(out_dir, 'data')
    os.makedirs(models, exist_ok=True); os.makedirs(data_dir, exist_ok=True)
    prefix = (prefix or 'LH_').upper()
    if not re.match(r'^[A-Z]{2,4}_$', prefix): raise SystemExit('--prefix must be 2-4 capital letters followed by _ (e.g. TA_)')
    scene = bpy.context.scene
    unexclude_all(bpy.context.view_layer.layer_collection)

    floors = {}       # n -> collection
    ground_cols, other_cols = [], []
    roof_cols = []
    for c in bpy.data.collections:
        m = FLOOR_RE.match(c.name)
        if m: floors[int(m.group(1))] = c
        elif ROOF_RE.match(c.name): roof_cols.append(c)
        elif c.name.upper().startswith('GROUND') or 'TERRENO' in c.name.upper(): ground_cols.append(c)
        else: other_cols.append(c)
    for c in roof_cols: floors[(max(floors) + 1) if floors else 0] = c
    if not floors: print('WARNING: no FLOOR_NN collection found; the whole building is exported as static geometry')

    ground_objs = [o for c in ground_cols for o in c.all_objects if o.type == 'MESH']
    ground_names = set(o.name for o in ground_objs)
    unit_objs = [o for o in bpy.data.objects if is_unit(o)]
    unit_names = set(o.name for o in unit_objs)

    # floors: one empty per floor, the floor's top-level objects parented to it (world transforms kept)
    floor_records, building_objs = [], []
    for n in sorted(floors):
        col = floors[n]
        objs = [o for o in col.all_objects if o.type == 'MESH' and o.name not in unit_names and o.name not in ground_names]
        if not objs: continue
        node = bpy.data.objects.new(f'floor_{n:02d}', None)
        scene.collection.objects.link(node)
        for o in objs:
            if o.parent is None:
                o.parent = node; o.matrix_parent_inverse = node.matrix_world.inverted()
        bb = world_bounds(objs)
        floor_records.append({'n': n, 'name': 'Roof' if col in roof_cols else f'{n:02d}', 'node': node.name, 'z0': round(bb[0][2], 2) if bb else None, 'z1': round(bb[1][2], 2) if bb else None})
        building_objs.append(node); building_objs.extend(objs)
    floor_names = set(o.name for o in building_objs)
    static_objs = [o for c in other_cols for o in c.all_objects if o.type == 'MESH' and o.name not in unit_names and o.name not in ground_names and o.name not in floor_names]
    # objects linked straight to the scene collection (no sub-collection)
    static_objs += [o for o in scene.collection.objects if o.type == 'MESH' and o.name not in unit_names and o.name not in ground_names and o.name not in floor_names and o not in static_objs]
    building_objs += static_objs

    # units
    def floor_of(o):
        if 'floor' in o.keys():
            try: return int(o['floor'])
            except (TypeError, ValueError): pass
        for c in o.users_collection:
            m = FLOOR_RE.match(c.name)
            if m: return int(m.group(1))
        cz = (o.matrix_world @ Vector((0, 0, 0))).z
        for f in floor_records:
            if f['z0'] is not None and f['z0'] - 0.3 <= cz <= (f['z1'] or 1e9): return f['n']
        return 0
    units, towers = [], set()
    for o in unit_objs:
        code = str(o.get('code') or re.sub(r'^UNIT[_ -]?', '', o.name, flags=re.I)).strip()
        tower = str(o.get('tower') or 'T1').strip()
        pid = str(o.get('unit_id') or '').strip()
        if not re.match(r'^[A-Z]{2,4}_[0-9a-f]{32}$', pid):
            pid = prefix + uuid.uuid5(uuid.NAMESPACE_URL, f'{prefix}{tower}/{code}').hex
            print(f'[units] {o.name}: unit_id generated from tower+code ({pid}); tag it in Blender to make it explicit')
        centre, size, rz = unit_box(o)
        rec = {'pid': pid, 'code': code, 'floor': floor_of(o), 'tower': tower, 'type': int(o.get('type', 1)),
               'box': {'center': centre, 'size': size, 'rot': rz}, 'pos': centre}
        for k in ('area_m2', 'beds', 'baths', 'plan', 'label'):
            if k in o.keys(): rec[k] = o[k] if not isinstance(o[k], float) else round(o[k], 2)
        units.append(rec); towers.add(tower)
    units.sort(key=lambda u: (u['tower'], u['floor'], u['code']))

    # bounds (site XY) from everything exported
    bb_all = world_bounds(building_objs + ground_objs) or ([0, 0, 0], [50, 50, 20])
    bounds = {'min': [round(bb_all[0][0], 2), round(bb_all[0][1], 2)], 'max': [round(bb_all[1][0], 2), round(bb_all[1][1], 2)]}

    export_glb(os.path.join(models, 'building.glb'), building_objs, draco)
    if ground_objs: export_glb(os.path.join(models, 'ground.glb'), ground_objs, draco)
    data = {'typology': 'building', 'bounds': bounds, 'colors': {}, 'models': {}, 'houses': [], 'lots': {}, 'species': [], 'trees': [],
            'usedLots': [], 'floors': floor_records, 'towers': sorted(towers), 'units': units, 'pidPrefix': prefix}
    with open(os.path.join(data_dir, 'site.json'), 'w', encoding='utf-8') as f: json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
    print(f'[export] site.json: {len(units)} units, {len(floor_records)} floors, towers {sorted(towers)}, bounds {bounds}')
    return data


if __name__ == '__main__':
    out, prefix, draco = parse_args()
    export(out, prefix, draco)
