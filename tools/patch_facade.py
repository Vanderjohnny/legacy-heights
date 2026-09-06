import json, struct, os, sys
src, dst = sys.argv[1], sys.argv[2]
b = open(src, 'rb').read()
ln = struct.unpack_from('<I', b, 12)[0]; js = json.loads(b[20:20+ln]); rest = b[20+ln:]
n = 0
for m in js['materials']:
    name = m.get('name', '')
    if any(c in name for c in ['Oak Tone','Caramel cloud','isle dreamns','in the blue','Marzipan','Pinkathon']) or name.upper().startswith('FACADE'):
        m['name'] = 'FACADE'; pbr = m.setdefault('pbrMetallicRoughness', {}); pbr['baseColorFactor'] = [1, 1, 1, 1]; pbr.pop('baseColorTexture', None); n += 1
jb = json.dumps(js, separators=(',', ':')).encode('utf-8'); jb += b' ' * ((4 - len(jb) % 4) % 4)
out = b'glTF' + struct.pack('<II', 2, 12 + 8 + len(jb) + len(rest)) + struct.pack('<I', len(jb)) + b'JSON' + jb + rest
open(dst, 'wb').write(out); print(os.path.basename(dst), 'facade mats patched:', n)
