@echo off
rem Post-process the raw house GLBs exported by blender_export.py:
rem   1) rename the facade colour material to FACADE (white) so the site can tint each house
rem   2) recompress textures to WebP (max 512 px) and geometry with Draco (gltf-transform, needs Node.js)
setlocal
set HERE=%~dp0
set MODELS=%HERE%..\assets\models
set PY=C:\Users\pharo\AppData\Local\Python\pythoncore-3.14-64\python.exe
for %%i in (1 2 3 4 5 6) do (
  "%PY%" "%HERE%patch_facade.py" "%MODELS%\house_%%i.glb" "%MODELS%\house_%%i.patched.glb"
  call npx -y @gltf-transform/cli@4.5.0 optimize "%MODELS%\house_%%i.patched.glb" "%MODELS%\house_%%i.glb" --compress draco --texture-compress webp --texture-size 512 --simplify false --palette false --instance false --join false --flatten false
  del "%MODELS%\house_%%i.patched.glb"
)
echo done
