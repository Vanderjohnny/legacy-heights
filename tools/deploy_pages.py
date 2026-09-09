"""Publish the site to GitHub Pages: copy the site folder into a clone of github.com/Vanderjohnny/legacy-heights,
commit and push.   python tools/deploy_pages.py <clone folder> ["commit message"]
Skips dist/, .claude/, __pycache__, *_orig.jpg backups and unused *_thumb.jpg files; keeps .nojekyll."""
import os, shutil, subprocess, sys, time
SITE = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
dest = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("LH_DEPLOY_DIR")
msg = sys.argv[2] if len(sys.argv) > 2 else f"Site update {time.strftime('%Y-%m-%d %H:%M')}"
if not dest or not os.path.isdir(os.path.join(dest, ".git")): sys.exit("usage: deploy_pages.py <git clone of Vanderjohnny/legacy-heights> [message]")

SKIP_DIRS = {"dist", ".claude", "__pycache__", ".git", "node_modules"}
def skip(name): return name.endswith("_orig.jpg") or name.endswith("_thumb.jpg") or name.endswith(".pyc")
copied = 0
for root, dirs, files in os.walk(SITE):
    dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
    rel = os.path.relpath(root, SITE)
    for f in files:
        if skip(f): continue
        src = os.path.join(root, f); dst = os.path.join(dest, rel, f) if rel != "." else os.path.join(dest, f)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if not os.path.exists(dst) or os.path.getmtime(src) > os.path.getmtime(dst) or os.path.getsize(src) != os.path.getsize(dst):
            shutil.copy2(src, dst); copied += 1
# remove files that no longer exist in the site (assets renamed / deleted)
removed = 0
for root, dirs, files in os.walk(dest):
    dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
    rel = os.path.relpath(root, dest)
    for f in files:
        if f == ".nojekyll" or f == "CNAME": continue
        srcp = os.path.join(SITE, rel, f) if rel != "." else os.path.join(SITE, f)
        if not os.path.exists(srcp) or skip(f):
            os.remove(os.path.join(root, f)); removed += 1
open(os.path.join(dest, ".nojekyll"), "a").close()
print(f"copied {copied} files, removed {removed}")
run = lambda *a: subprocess.run(a, cwd=dest, check=True)
run("git", "add", "-A")
st = subprocess.run(["git", "status", "--porcelain"], cwd=dest, capture_output=True, text=True).stdout
if not st.strip(): sys.exit("nothing to commit")
run("git", "commit", "-q", "-m", msg + "\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>")
run("git", "push", "-q", "origin", "main")
print("pushed:", subprocess.run(["git", "log", "--oneline", "-1"], cwd=dest, capture_output=True, text=True).stdout.strip())
