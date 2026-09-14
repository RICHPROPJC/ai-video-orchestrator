"""World / character construction for Blender 4.2–5.12."""

from __future__ import annotations

import math
from typing import Any

import bpy
from mathutils import Vector


def _version_label() -> str:
    v = bpy.app.version
    return f"{v[0]}.{v[1]}.{v[2]}"


def _ensure_eevee():
    scene = bpy.context.scene
    for engine in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "CYCLES"):
        try:
            scene.render.engine = engine
            return
        except TypeError:
            continue


def _look_at(obj, target: tuple[float, float, float]):
    direction = Vector(target) - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def _pass(obj, index: int):
    obj.pass_index = index
    if getattr(obj.data, "materials", None) and obj.data.materials:
        mat = obj.data.materials[0]
        if mat:
            mat.pass_index = index


def world_build(args: dict[str, Any]) -> str:
    from . import executor

    preset = str(args.get("preset") or "truman")
    executor.scene_clear({})
    _ensure_eevee()

    def mesh(primitive: str, name: str, loc, scale, material: str, color: str, pass_index: int = 1):
        result = executor.object_create(
            {
                "primitive": primitive,
                "name": name,
                "location": loc,
                "scale": scale,
                "material": material,
                "color": color,
            }
        )
        obj = bpy.data.objects.get(name)
        if obj:
            _pass(obj, pass_index)
            obj["astra_physics"] = "static"
        return result

    def house(name: str, x: float, y: float, w: float, d: float, h: float, color: str):
        mesh("cube", f"{name}_Body", (x, y, h / 2), (w, d, h), "matte", color, 1)
        mesh("cone", f"{name}_Roof", (x, y, h + 0.55), (w * 0.78, d * 0.78, 1.1), "plastic", "#7a3a32", 1)

    mesh("plane", "TownGround", (0, 0, 0), (42, 42, 1), "foliage", "#6b8f4a", 1)
    mesh("plane", "MainStreet", (0, 1, 0.02), (3.4, 28, 1), "asphalt", "#3a3d44", 1)
    mesh("cylinder", "Plaza", (0, 0, 0.04), (3.6, 3.6, 0.08), "marble", "#e6e0d4", 1)
    house("HouseNE", 6.5, 6.2, 3.2, 2.6, 2.6, "#f3ead8")
    house("HouseNW", -6.5, 6.2, 3.0, 2.8, 2.4, "#f4d6c3")
    house("HouseSE", 6.5, -5.4, 3.4, 2.5, 2.8, "#d7c4a5")
    house("HouseSW", -6.5, -5.4, 2.8, 2.6, 2.3, "#e8e2d6")

    if preset in {"truman", "open_world", "seahaven"}:
        mesh("plane", "Ocean", (0, 18, -0.08), (48, 16, 1), "water", "#1d4f78", 5)
        mesh("ico_sphere", "Dome", (0, 2, 8), (26, 26, 26), "sky", "#7eb6e8", 8)
        dome = bpy.data.objects.get("Dome")
        if dome:
            bpy.ops.object.select_all(action="DESELECT")
            dome.select_set(True)
            bpy.context.view_layer.objects.active = dome
            bpy.ops.object.mode_set(mode="EDIT")
            bpy.ops.mesh.select_all(action="SELECT")
            bpy.ops.mesh.flip_normals()
            bpy.ops.object.mode_set(mode="OBJECT")
        mesh("cube", "DomeDoor", (0, 22, 3.2), (4.4, 0.4, 6.4), "metal", "#c0c7d1", 4)

    character_spawn({"name": "Truman", "location": [0, -1.2, 0], "role": "hero", "shirt": "#f4f1ea"})
    character_spawn({"name": "ExtraA", "location": [-4.2, 2.4, 0], "role": "extra", "shirt": "#3b82f6"})

    for i, loc in enumerate(((6.5, 6.2, 4.2), (-0.4, -8.4, 2.4), (4, 14, 2.8))):
        executor.camera_create(
            {"name": f"Hidden_{i}", "location": loc, "lookAt": [0, 0, 1.2], "fov": 38, "force": True}
        )
        cam = bpy.data.objects.get(f"Hidden_{i}")
        if cam:
            cam["astra_role"] = "hidden_cam"
            _pass(cam, 6)

    executor.light_create({"name": "Sun", "type": "SUN", "location": [10, -8, 16], "energy": 3.4, "color": "#fff4dc"})
    physics_set({"enabled": True})
    camera_mode({"mode": "third_person", "follow": "Truman"})
    return f"Built {preset} world in Blender {_version_label()}"


def character_spawn(args: dict[str, Any]) -> str:
    from . import executor

    name = str(args.get("name") or "Actor")
    loc = args.get("location") or [0, 0, 0]
    x, y, z = float(loc[0]), float(loc[1]), float(loc[2])
    shirt = str(args.get("shirt") or "#f4f1ea")
    pants = str(args.get("pants") or "#c4b07a")
    skin = str(args.get("skin") or "#e8c4a8")
    hair = str(args.get("hair") or "#4a3424")
    bpy.ops.object.empty_add(type="PLAIN_AXES", location=(x, y, z))
    root = bpy.context.object
    root.name = name
    root["astra_rig"] = name
    root["astra_bone"] = "root"
    root["astra_height"] = 1.0
    parts = [
        (f"{name}_Torso", "cube", (x, y, 1.16), (0.52, 0.3, 0.68), "plastic", shirt),
        (f"{name}_Head", "uv_sphere", (x, y, 1.72), (0.3, 0.3, 0.3), "skin", skin),
        (f"{name}_Hair", "uv_sphere", (x, y, 1.86), (0.28, 0.26, 0.16), "matte", hair),
        (f"{name}_Hip", "cube", (x, y, 0.72), (0.48, 0.26, 0.22), "plastic", pants),
        (f"{name}_LegL", "cylinder", (x - 0.13, y, 0.34), (0.11, 0.11, 0.66), "plastic", pants),
        (f"{name}_LegR", "cylinder", (x + 0.13, y, 0.34), (0.11, 0.11, 0.66), "plastic", pants),
        (f"{name}_ArmL", "cylinder", (x - 0.4, y, 1.18), (0.08, 0.08, 0.58), "skin", skin),
        (f"{name}_ArmR", "cylinder", (x + 0.4, y, 1.18), (0.08, 0.08, 0.58), "skin", skin),
    ]
    for pname, prim, ploc, scale, mat, color in parts:
        executor.object_create({"primitive": prim, "name": pname, "location": ploc, "scale": scale, "material": mat, "color": color})
        obj = bpy.data.objects.get(pname)
        if obj:
            obj.parent = root
            obj.matrix_parent_inverse = root.matrix_world.inverted()
            obj["astra_bone"] = pname.rsplit("_", 1)[-1].lower()
            _pass(obj, 2 if args.get("role") != "extra" else 3)
    return f"Spawned {name}"


# C5 (rot_x_degrees, hip_height_factor, torso_z_scale, leg_z_scale).
# Preserve the pivot-tilt rule: lie rotates the whole figure, not just its torso.
STANCE = {
    "stand": (0.0, 0.0, 1.0, 1.0),
    "lean": (-25.0, 0.0, 1.0, 1.0),
    "crouch": (0.0, -0.28, 0.75, 0.5),
    "sit": (18.0, 0.70, 0.55, 0.38),
    "kneel": (6.0, -0.22, 1.0, 0.18),
    "lie": (90.0, 0.22, 1.0, 0.40),
    "turn_away": (0.0, 0.0, 1.0, 1.0),
}
CHARACTER_ACTIONS = {"idle", "walk", "wave", "sit", "look", "lie", "kneel", "crouch", "lean", "turn_away"}


def _apply_stance(root, stance: str):
    parts = {}
    for obj in root.children_recursive:
        if obj.type == "MESH":
            bone = str(obj.get("astra_bone") or obj.name.rsplit("_", 1)[-1]).lower()
            parts[bone] = obj
    required = {"torso", "head", "legl", "legr"}
    if not required.issubset(parts):
        raise ValueError(f"character_parts_missing: {sorted(required - parts.keys())}")
    rotation, hip, torso_z, leg_z = STANCE[stance]
    height = float(root.get("astra_height", 1.0))
    # Subtract the last pose offsets before applying new ones: repeated calls do
    # not accumulate translation/rotation, and character.move remains the base.
    base_location = root.location.copy() - Vector(root.get("astra_stance_offset", (0, 0, 0)))
    base_rotation = Vector(root.rotation_euler) - Vector(root.get("astra_stance_rotation", (0, 0, 0)))
    offset = Vector((0, 0, hip * height))
    delta_rotation = Vector((math.radians(rotation) if abs(rotation) >= 45 else 0,
                             0, math.pi if stance == "turn_away" else 0))
    # An action replaces the previous action on these authored rig channels.
    # Datablocks are retained; a previous walk must not overwrite the new pose.
    root.animation_data_clear()
    root.location = base_location + offset
    root.rotation_euler = base_rotation + delta_rotation
    root["astra_stance_offset"] = list(offset)
    root["astra_stance_rotation"] = list(delta_rotation)
    for obj in parts.values():
        if "astra_rest_scale" not in obj:
            obj["astra_rest_scale"] = list(obj.scale)
            obj["astra_rest_rotation"] = list(obj.rotation_euler)
        obj.animation_data_clear()
        obj.scale = obj["astra_rest_scale"]
        obj.rotation_euler = obj["astra_rest_rotation"]
    part_rotation = 0 if abs(rotation) >= 45 else math.radians(rotation)
    for bone in ("torso", "head"):
        parts[bone].rotation_euler.x += part_rotation
    parts["torso"].scale.z *= torso_z
    for bone in ("legl", "legr"):
        parts[bone].scale.z *= leg_z


def character_action(args: dict[str, Any]) -> str:
    name = str(args.get("name") or "Truman")
    action = str(args.get("action") or "walk")
    if action not in CHARACTER_ACTIONS:
        raise ValueError(f"character_action_invalid: {action}")
    root = bpy.data.objects.get(name)
    if not root:
        return f"No rig {name}"
    _apply_stance(root, action if action in STANCE else "stand")
    root["astra_action"] = action
    if action == "walk":
        scene = bpy.context.scene
        scene.frame_start = 1
        scene.frame_end = 40
        root.location.y += 0.0
        root.keyframe_insert(data_path="location", frame=1)
        root.location.y += 3.0
        root.keyframe_insert(data_path="location", frame=40)
    return f"{name} → {action}"


def character_move(args: dict[str, Any]) -> str:
    name = str(args.get("name") or "Truman")
    root = bpy.data.objects.get(name)
    if not root:
        return f"No rig {name}"
    loc = args.get("location")
    if isinstance(loc, (list, tuple)) and len(loc) >= 3:
        root.location = Vector((float(loc[0]), float(loc[1]), float(loc[2]))) + Vector(root.get("astra_stance_offset", (0, 0, 0)))
    if args.get("yaw") is not None:
        root.rotation_euler[2] = math.radians(float(args["yaw"])) + root.get("astra_stance_rotation", (0, 0, 0))[2]
    return f"Moved {name}"


def character_appear(args: dict[str, Any]) -> str:
    from . import executor

    name = str(args.get("name") or "Truman")
    if args.get("shirt"):
        torso = bpy.data.objects.get(f"{name}_Torso")
        if torso:
            executor.object_set_material({"name": torso.name, "material": "plastic", "color": args["shirt"]})
    return f"Appearance on {name}"


def camera_mode(args: dict[str, Any]) -> str:
    from .observe import hero_bounds

    mode = str(args.get("mode") or "director")
    follow = str(args.get("follow") or "Truman")
    root, _meshes, center, _low, _high, _depsgraph = hero_bounds(follow)
    cam = bpy.context.scene.camera
    if cam is None:
        bpy.ops.object.camera_add()
        cam = bpy.context.object
        bpy.context.scene.camera = cam
    head = bpy.data.objects.get(f"{follow}_Head") or bpy.data.objects.get(follow)
    if mode == "first_person" and head:
        cam.parent = head
        cam.location = (0, -0.15, 0.05)
        cam.rotation_euler = Vector((0, 1, 0)).to_track_quat("-Z", "Y").to_euler()
    elif mode == "third_person" and head:
        cam.parent = None
        cam.location = center + Vector((0, -4.6, 1.6))
        _look_at(cam, tuple(center))
    elif mode == "hidden":
        hidden = next((o for o in bpy.data.objects if o.get("astra_role") == "hidden_cam"), None)
        if hidden:
            bpy.context.scene.camera = hidden
    bpy.context.scene["astra_camera_mode"] = mode
    bpy.context.scene["astra_follow"] = root.name
    return f"Camera {mode}"


def physics_set(args: dict[str, Any]) -> str:
    enabled = bool(args.get("enabled", True))
    scene = bpy.context.scene
    if enabled:
        if scene.rigidbody_world is None:
            bpy.ops.rigidbody.world_add()
        for obj in bpy.data.objects:
            if obj.type != "MESH":
                continue
            kind = obj.get("astra_physics") or ("static" if obj.pass_index == 1 else "")
            if not kind:
                continue
            try:
                bpy.ops.object.select_all(action="DESELECT")
                obj.select_set(True)
                bpy.context.view_layer.objects.active = obj
                bpy.ops.rigidbody.object_add(type="PASSIVE" if kind == "static" else "ACTIVE")
            except Exception:
                continue
    return f"Physics {'on' if enabled else 'off'}"


def mask_set(args: dict[str, Any]) -> str:
    name = args.get("name")
    obj = bpy.data.objects.get(str(name)) if name else bpy.context.view_layer.objects.active
    if not obj:
        return "No object for mask"
    obj.pass_index = int(args.get("id") or 1)
    if args.get("holdout"):
        obj.is_holdout = True
    return f"Mask {obj.pass_index} on {obj.name}"
