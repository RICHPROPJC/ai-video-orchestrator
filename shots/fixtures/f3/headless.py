"""Live F3 regression fixture; CPU Workbench, no production pipeline."""
from pathlib import Path
import builtins
import hashlib
import json
import math
import sys

OUT = Path(__file__).resolve().parent
ROOT = OUT.parents[2]
sys.path.insert(0, str(OUT / ".deps"))
sys.path.insert(0, str(ROOT / "blender_addon"))
import bpy
from mathutils import Vector
from astra.executor import run_call
from astra.observe import observe, run_checks, hero_bounds

RESULTS = {}
SETTINGS = dict(width=320, height=180, fps=6, frameStart=1, frameEnd=5)


def call(tool, **args):
    result = run_call({"tool": tool, "args": args})
    assert result["ok"], result
    return result


def setup():
    call("scene.clear")
    scene = bpy.context.scene
    scene.frame_set(1)
    bpy.ops.object.empty_add(location=(38, 0, 0))
    rig = bpy.context.object
    rig.name = "HeroRig"
    rig["astra_rig"] = rig.name
    call("object.create", name="HeroMesh", primitive="cube", location=[0, 0, 1], scale=[1, 1, 2], color="#e04020")
    hero = bpy.data.objects["HeroMesh"]
    bpy.context.view_layer.update()
    hero.parent = rig
    hero.matrix_parent_inverse = rig.matrix_world.inverted()
    call("mask.set", name=hero.name, id=2)
    bpy.ops.object.empty_add(location=(38, 0, 1))
    target = bpy.context.object
    target.name = "CamTarget"
    scene["astra_follow"] = rig.name
    call("camera.create", location=[0, -8, 2], lookAt=[0, 0, 1], fov=40)
    return scene, hero, rig, target


def render_case(name, expected, **extra):
    path = OUT / name / "blockout.mp4"
    source = bpy.context.scene
    before = (source.frame_current, source.camera, source.render.engine,
              [(obj, obj.data) for obj in source.objects if obj.type == "MESH"])
    result = run_call({"tool": "render.animation", "args": {**SETTINGS, "path": str(path), **extra}})
    assert result["ok"] is expected, (name, result)
    assert path.exists() is expected, (name, "output presence")
    assert (source.frame_current, source.camera, source.render.engine,
            [(obj, obj.data) for obj in source.objects if obj.type == "MESH"]) == before
    result["expected"] = expected
    RESULTS[name] = result
    return result


def checks(result):
    return {item["id"]: item["ok"] for item in result["checks"]}


scene, hero, rig, target = setup()
call("camera.create", location=[38, -8, 2], lookAt=list(target.location), fov=40)
bad = render_case("shot4_bad", False)
assert checks(bad)["camera_aimed_at_hero"] is False
assert bad["observation"]["hero"]["location"] == [0, 0, 1]
assert bad["observation"]["hero"]["meshes"] == ["HeroMesh"]
framed = call("camera.frame", follow="HeroRig")
assert all(check["ok"] for check in framed["checks"])
fixed = render_case("shot4_fixed", True)
assert all(checks(fixed).values())
# F1 render.matte remains available; frame mask PNG is also exposed for consumers.
for mask in ("hero", "extras"):
    call("render.matte", **SETTINGS, mask=mask, path=str(OUT / "shot4_fixed" / f"{mask}-matte.mp4"))
call("render.frame", path=str(OUT / "shot4_fixed" / "hero-frame.png"), mask="hero", frame=3, width=320, height=180)

scene, hero, rig, target = setup()
call("object.create", name="Decoy", location=[38, 0, 1], scale=[1, 1, 2])
call("mask.set", name="Decoy", id=2)
call("camera.create", location=[38, -8, 2], lookAt=list(target.location), fov=40)
decoy = render_case("wrong_hero_decoy", False)
assert decoy["observation"]["pixelEvidence"]["pixelCount"] == 0

scene, hero, rig, target = setup()
call("object.create", name="Mezzanine", location=[0, -4, 1], scale=[8, 0.5, 8], color="#339944")
blocked = render_case("occluded", False)
assert checks(blocked)["camera_aimed_at_hero"] is True
assert checks(blocked)["camera_occluded"] is False
assert blocked["observation"]["camera"]["blocker"] == "Mezzanine"
bpy.data.objects["Mezzanine"].hide_render = True
clear = render_case("occluded_fixed", True)
assert all(checks(clear).values())

scene, hero, rig, target = setup()
scene.camera.data.shift_x = 0.8
shifted = render_case("offscreen_with_good_vector", False)
assert checks(shifted)["camera_aimed_at_hero"] is True
assert checks(shifted)["camera_occluded"] is True

scene, hero, rig, target = setup()
cam = scene.camera
cam.rotation_euler = (0, 0, math.pi)
track = cam.constraints.new("TRACK_TO")
track.target, track.track_axis, track.up_axis = hero, "TRACK_NEGATIVE_Z", "UP_Y"
raw_angle = math.degrees((cam.rotation_euler.to_quaternion() @ Vector((0, 0, -1))).angle(Vector((0, 0, 1)) - cam.location))
assert raw_angle > 30
constrained = render_case("constrained_camera", True)
assert constrained["observation"]["camera"]["aimAngleDeg"] < 0.1
RESULTS["constrained_camera"]["rawAngleDeg"] = raw_angle
# A previous pass and caller-supplied verdict cannot authorize a changed scene.
hero.hide_render = True
mutated = render_case("changed_after_pass", False, hero_on_screen=True, checks=[{"id": "hero_on_screen", "ok": True}])
assert mutated["observation"]["pixelEvidence"]["pixelCount"] == 0

scene, hero, rig, target = setup()
hero.keyframe_insert(data_path="location", frame=1)
hero.location.x = 38
hero.keyframe_insert(data_path="location", frame=3)
hero.location.x = 0
hero.keyframe_insert(data_path="location", frame=5)
scene.frame_set(1)
midpoint = render_case("midpoint_not_current_frame", False)
assert midpoint["observation"]["frame"] == 3
assert midpoint["observation"]["hero"]["location"][0] == 38
assert scene.frame_current == 1

scene, hero, rig, target = setup()
# Evaluated mesh position differs from raw mesh/root transforms.
bpy.ops.object.empty_add(location=(6, 0, 1))
driver = bpy.context.object
constraint = hero.constraints.new("COPY_LOCATION")
constraint.target = driver
call("camera.mode", mode="third_person", follow="HeroRig")
followed = render_case("evaluated_follow", True)
assert followed["observation"]["hero"]["location"] == [6, 0, 1]
assert all(checks(followed).values())
# camera.frame must report an intervening mesh, not just perform placement.
call("camera.frame", follow="HeroRig")
center = Vector(observe()["hero"]["location"])
wall_center = (scene.camera.location + center) * 0.5
call("object.create", name="FrameBlocker", location=list(wall_center), scale=[1, 1, 1])
frame_result = run_call({"tool": "camera.frame", "args": {"follow": "HeroRig"}})
assert frame_result["ok"] is False
assert next(c for c in frame_result["checks"] if c["id"] == "camera_occluded")["ok"] is False
RESULTS["camera_frame_occluded"] = frame_result

scene, hero, rig, target = setup()
hero.pass_index = 3
missing = render_case("missing_hero_mask", False)
assert missing["observation"]["hero"] is None

scene, hero, rig, target = setup()
original_import = builtins.__import__
def without_pillow(name, *args, **kwargs):
    if name == "PIL":
        raise ImportError("fixture: Pillow unavailable")
    return original_import(name, *args, **kwargs)
builtins.__import__ = without_pillow
try:
    no_pillow = render_case("pillow_unconfigured", False)
    assert "pillow_unconfigured" in no_pillow["observation"]["errors"]
finally:
    builtins.__import__ = original_import
assert next(check for check in run_checks(observe()) if check["id"] == "hero_on_screen")["ok"] is False

(OUT / "results.json").write_text(json.dumps(RESULTS, indent=2) + "\n")
files = sorted(path for path in OUT.rglob("*") if path.suffix in {".png", ".mp4", ".json"} and ".deps" not in path.parts and path.name != "qc.json")
qc = {"verdict": "PASS", "blender": bpy.app.version_string, "receipt_kind": "live_headless_fixture",
      "cases": {name: result["ok"] for name, result in RESULTS.items()},
      "artifacts": {str(path.relative_to(OUT)): hashlib.sha256(path.read_bytes()).hexdigest() for path in files},
      "event_id": None, "trace_id": None}
(OUT / "qc.json").write_text(json.dumps(qc, indent=2) + "\n")
print("F3 PASS: Shot4 bad rejected, fixed accepted; all camera regressions passed")
