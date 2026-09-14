"""F1 receipt: blender -b --python-exit-code 1 -P shots/fixtures/f1/headless.py."""
from pathlib import Path
import hashlib
import json
import sys

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "blender_addon"))
import bpy
from astra.executor import run_call, scene_graph

OUT = Path(__file__).resolve().parent

def call(tool, **args):
    result = run_call({"tool": tool, "args": args})
    assert result["ok"], result
    return result

call("scene.clear")
call("object.create", name="Hero", primitive="cube", location=[-1, 0, 1], color="#ef401c")
call("mask.set", name="Hero", id=2)
call("object.create", name="Extras", primitive="uv_sphere", location=[1, 0, 1], color="#186dee")
call("mask.set", name="Extras", id=3)
# A foreground set object cuts the hero silhouette: mattes must preserve occlusion.
call("object.create", name="Occluder", primitive="cube", location=[-1.3, -1, 1], scale=[0.4, 0.3, 1.5], color="#38aa40")
call("mask.set", name="Occluder", id=1)
call("camera.create", location=[0, -8, 2.5], lookAt=[0, 0, 1], fov=40)
hero = bpy.data.objects["Hero"]
hero.keyframe_insert(data_path="location", frame=1)
hero.location.x += 0.5
hero.keyframe_insert(data_path="location", frame=6)
bpy.context.scene.frame_set(1)
original = (bpy.context.scene.render.engine, hero.data, hero.data.materials[0], bpy.context.scene.frame_current)
settings = dict(width=320, height=180, fps=6, frameStart=1, frameEnd=6)
results = [call("render.frame", path=str(OUT / "frame.png"), frame=3, **settings)]
results.append(call("render.animation", path=str(OUT / "blockout.mp4"), **settings))
for mask in ("hero", "extras"):
    results.append(call("render.matte", path=str(OUT / f"{mask}-matte.mp4"), mask=mask, **settings))
checks = [
    {"id": "source_restored", "ok": original == (bpy.context.scene.render.engine, hero.data, hero.data.materials[0], bpy.context.scene.frame_current)},
    {"id": "mask_indices", "ok": hero.pass_index == 2 and bpy.data.objects["Extras"].pass_index == 3},
]
for args in ({"path": str(OUT / "invalid.mp4"), "mask": "unknown"}, {"path": str(OUT / "invalid.mp4"), "mask": "hero", "width": 319}):
    try:
        call("render.matte", **args)
        raise AssertionError("invalid render accepted")
    except ValueError:
        pass
checks.append({"id": "invalid_arguments_rejected", "ok": True})
assert all(c["ok"] for c in checks), checks
receipt = {
    "protocol": "astra.protocol.v2", "blender": bpy.app.version_string,
    "render": {"engine": "BLENDER_WORKBENCH", "light": "FLAT", "color_type": "MATERIAL"},
    "observation": scene_graph(), "checks": checks, "results": results,
    "artifacts": {name: hashlib.sha256((OUT / name).read_bytes()).hexdigest() for name in ("frame.png", "blockout.mp4", "hero-matte.mp4", "extras-matte.mp4")},
    "receipt_kind": "live_headless_fixture", "event_id": None, "trace_id": None,
}
(OUT / "observation.json").write_text(json.dumps(receipt, indent=2) + "\n")
