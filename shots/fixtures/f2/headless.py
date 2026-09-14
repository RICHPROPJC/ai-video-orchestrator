"""F2: C5 math parity on the C5 mannequin, plus live Astra stance renders."""
from pathlib import Path
import copy
import hashlib
import json
import sys

OUT = Path(__file__).resolve().parent
ROOT = OUT.parents[2]
sys.path[:0] = [str(OUT), str(ROOT / "blender_addon"), str(ROOT / "shots/fixtures/f3/.deps")]
import bpy
import legacy_fixture as legacy
from astra.executor import run_call
from astra.observe import observe, run_checks
from astra.world import STANCE

ACTIONS = ("lie", "kneel", "crouch", "lean", "turn_away")
RESULTS = {}
ORIGINAL_MANNEQUIN = legacy.mannequin


def tagged_mannequin(name, height, material):
    root, torso, head, legs = ORIGINAL_MANNEQUIN(name, height, material)
    root["astra_height"] = height
    for obj, bone in [(torso, "torso"), (head, "head"), (legs[0], "legl"), (legs[1], "legr")]:
        obj["astra_bone"] = bone
    for i, obj in enumerate(o for o in root.children if o not in [torso, head, *legs]):
        obj["astra_bone"] = f"arm{i}"
    return root, torso, head, legs


legacy.mannequin = tagged_mannequin


def call(tool, **args):
    result = run_call({"tool": tool, "args": args})
    assert result["ok"], result
    return result


def render_c5(action, ported):
    legacy.clear()
    scene = bpy.context.scene
    scene.frame_set(1)
    # C5 unprojects before setting output size; preserve its factory camera aspect.
    scene.render.resolution_x, scene.render.resolution_y = 1920, 1080
    if "astra_follow" in scene:
        del scene["astra_follow"]
    shot = copy.deepcopy(legacy.SHOTS[0])
    shot["id"] = "SH_" + action
    for mark in shot["marks"]:
        mark["stance"] = "stand" if ported else action
    legacy.dress_set(shot.get("set") or ["room"])
    bpy.ops.object.light_add(type="AREA", location=(2, -2, 4))
    bpy.context.object.data.energy = 250
    bpy.context.object.data.size = 3
    legacy.build_shot(shot, 1, 1)
    scene.camera = bpy.data.objects[shot["id"] + "_Camera"]
    scene.frame_set(1)
    bpy.context.view_layer.update()
    roots = [obj for obj in scene.objects if "astra_height" in obj]
    if ported:
        for root in roots:
            call("character.action", name=root.name, action=action)
    for i, root in enumerate(sorted(roots, key=lambda root: root.name)):
        for obj in root.children:
            obj.pass_index = 2 if i == 0 else 3
    folder = OUT / ("ported-c5" if ported else "regenerated-c5")
    folder.mkdir(exist_ok=True)
    scene.frame_start, scene.frame_end = 1, 1
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.view_settings.view_transform = "Standard"
    scene.display.shading.light = "FLAT"
    scene.display.shading.color_type = "MATERIAL"
    scene.render.resolution_x, scene.render.resolution_y = 864, 480
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = str(folder / (action + ".png"))
    bpy.ops.render.render(write_still=True)
    return {root.name: {"location": list(root.location), "rotation": list(root.rotation_euler),
                        "parts": {str(obj.get("astra_bone")): {"rotation": list(obj.rotation_euler), "scale": list(obj.scale)} for obj in root.children}} for root in roots}


for action in ACTIONS:
    assert STANCE[action] == legacy.STANCE[action]
    baseline = render_c5(action, False)
    ported = render_c5(action, True)
    for name in baseline:
        for key in ("location", "rotation"):
            assert all(abs(a-b) < 1e-6 for a, b in zip(baseline[name][key], ported[name][key])), (action, name, key, baseline[name][key], ported[name][key])
        for bone in baseline[name]["parts"]:
            for key in ("rotation", "scale"):
                assert all(abs(a-b) < 1e-6 for a,b in zip(baseline[name]["parts"][bone][key], ported[name]["parts"][bone][key])), (action, name, bone, key)
    RESULTS[action] = {"c5_transform_parity": True, "poses": ported}

for action in ACTIONS:
    call("scene.clear")
    bpy.context.scene.frame_set(1)
    call("character.spawn", name="Hero", role="hero")
    call("character.action", name="Hero", action=action)
    root = bpy.data.objects["Hero"]
    original = (list(root.location), list(root.rotation_euler), list(bpy.data.objects["Hero_Torso"].scale))
    call("character.action", name="Hero", action=action)
    assert original == (list(root.location), list(root.rotation_euler), list(bpy.data.objects["Hero_Torso"].scale)), action
    call("camera.frame", follow="Hero")
    result = call("render.animation", path=str(OUT / action / "blockout.mp4"), width=320, height=180, fps=6, frameStart=1, frameEnd=3)
    assert all(check["ok"] for check in result["checks"]), result
    RESULTS[action]["runtime"] = result
    RESULTS[action]["idempotent"] = True

# Transition/move regression: a stance must not accumulate or be overwritten by old walk keys.
call("character.action", name="Hero", action="walk")
assert bpy.data.objects["Hero"].animation_data is not None
call("character.action", name="Hero", action="lie")
assert bpy.data.objects["Hero"].animation_data is None
call("character.move", name="Hero", location=[2, 3, 4], yaw=25)
call("character.action", name="Hero", action="kneel")
root = bpy.data.objects["Hero"]
assert all(abs(a-b) < 1e-5 for a,b in zip(root.location, [2, 3, 3.78]))
call("character.action", name="Hero", action="idle")
assert all(abs(a-b) < 1e-5 for a,b in zip(root.location, [2, 3, 4]))
assert abs(root.rotation_euler.x) < 1e-5
assert all(abs(a-b) < 1e-5 for a,b in zip(bpy.data.objects["Hero_Torso"].scale, [.52, .3, .68]))
try:
    call("character.action", name="Hero", action="invented")
    raise AssertionError("unknown action accepted")
except ValueError:
    pass

(OUT / "results.json").write_text(json.dumps({"blender": bpy.app.version_string, "actions": RESULTS,
    "transition_checks": "PASS", "receipt_kind": "live_headless_fixture", "event_id": None, "trace_id": None}, indent=2) + "\n")
print("F2 headless PASS: five C5 transform matches, five live Astra gated blockouts, idempotence and transitions")
