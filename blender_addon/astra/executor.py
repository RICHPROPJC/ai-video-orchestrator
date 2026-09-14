"""Typed Astra tools, executed on Blender's main thread."""

from __future__ import annotations

import math
from typing import Any

import bpy
from mathutils import Vector


def _vec(value: Any, fallback: tuple[float, float, float]) -> tuple[float, float, float]:
    if isinstance(value, (list, tuple)) and len(value) >= 3:
        return float(value[0]), float(value[1]), float(value[2])
    return fallback


def _find(name: str | None):
    if not name:
        return bpy.context.view_layer.objects.active
    return bpy.data.objects.get(name)


def _ensure_material(obj, preset: str, color: str | None):
    mat_name = f"Astra_{preset}_{obj.name}"
    mat = bpy.data.materials.get(mat_name) or bpy.data.materials.new(mat_name)
    mat.use_nodes = True
    nt = mat.node_tree
    principled = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if principled is None:
        return
    rgb = _hex_rgb(color) if color else _preset_rgb(preset)
    mat.diffuse_color = (*rgb, 1.0)
    principled.inputs["Base Color"].default_value = (*rgb, 1.0)
    principled.inputs["Roughness"].default_value = _preset_roughness(preset)
    principled.inputs["Metallic"].default_value = 1.0 if preset in {"metal", "chrome", "gold", "copper", "silver"} else 0.0
    if "Transmission Weight" in principled.inputs:
        principled.inputs["Transmission Weight"].default_value = 1.0 if preset == "glass" else 0.0
    elif "Transmission" in principled.inputs:
        principled.inputs["Transmission"].default_value = 1.0 if preset == "glass" else 0.0
    if preset == "emissive":
        if "Emission Color" in principled.inputs:
            principled.inputs["Emission Color"].default_value = (*rgb, 1.0)
        if "Emission Strength" in principled.inputs:
            principled.inputs["Emission Strength"].default_value = 4.5
    if obj.data.materials:
        obj.data.materials[0] = mat
    else:
        obj.data.materials.append(mat)


def _hex_rgb(color: str) -> tuple[float, float, float]:
    h = color.lstrip("#")
    if len(h) != 6:
        return (0.7, 0.7, 0.7)
    return tuple(int(h[i : i + 2], 16) / 255.0 for i in (0, 2, 4))  # type: ignore[return-value]


def _preset_rgb(preset: str) -> tuple[float, float, float]:
    table = {
        "chrome": (0.81, 0.84, 0.87),
        "gold": (0.83, 0.69, 0.22),
        "copper": (0.72, 0.45, 0.20),
        "clay": (0.77, 0.70, 0.65),
        "marble": (0.93, 0.91, 0.87),
        "wood": (0.54, 0.35, 0.20),
        "glass": (0.84, 0.95, 1.0),
        "foliage": (0.25, 0.56, 0.29),
        "toon": (0.36, 0.55, 0.94),
        "skin": (0.91, 0.77, 0.66),
        "asphalt": (0.23, 0.24, 0.27),
        "water": (0.11, 0.31, 0.47),
        "sky": (0.49, 0.71, 0.91),
    }
    return table.get(preset, (0.55, 0.58, 0.62))


def _preset_roughness(preset: str) -> float:
    table = {
        "chrome": 0.04,
        "glass": 0.04,
        "gold": 0.22,
        "clay": 0.92,
        "matte": 0.86,
        "metal": 0.28,
        "marble": 0.34,
        "wood": 0.7,
    }
    return table.get(preset, 0.45)


def _select(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


PRIM_OPS = {
    "cube": lambda: bpy.ops.mesh.primitive_cube_add(size=1),
    "uv_sphere": lambda: bpy.ops.mesh.primitive_uv_sphere_add(radius=0.5, segments=32, ring_count=16),
    "ico_sphere": lambda: bpy.ops.mesh.primitive_ico_sphere_add(radius=0.5, subdivisions=2),
    "cylinder": lambda: bpy.ops.mesh.primitive_cylinder_add(radius=0.5, depth=1),
    "cone": lambda: bpy.ops.mesh.primitive_cone_add(radius1=0.5, depth=1),
    "torus": lambda: bpy.ops.mesh.primitive_torus_add(major_radius=0.45, minor_radius=0.18),
    "plane": lambda: bpy.ops.mesh.primitive_plane_add(size=1),
    "monkey": lambda: bpy.ops.mesh.primitive_monkey_add(size=1),
}


def scene_clear(_args: dict) -> str:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    if "astra_follow" in bpy.context.scene:
        del bpy.context.scene["astra_follow"]
    bpy.ops.object.camera_add(location=(7.4, -6.8, 4.8))
    cam = bpy.context.object
    cam.name = "Camera"
    bpy.context.scene.camera = cam
    return "Scene cleared"


def scene_set_world(args: dict) -> str:
    world = bpy.context.scene.world or bpy.data.worlds.new("AstraWorld")
    bpy.context.scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg:
        color = args.get("color")
        if isinstance(color, str):
            bg.inputs[0].default_value = (*_hex_rgb(color), 1.0)
        bg.inputs[1].default_value = float(args.get("strength", 0.25))
    return f"World mood {args.get('mood', 'studio')}"


def object_create(args: dict) -> str:
    primitive = args.get("primitive", "cube")
    op = PRIM_OPS.get(primitive, PRIM_OPS["cube"])
    loc = _vec(args.get("location"), (0, 0, 0.5))
    op()
    obj = bpy.context.object
    obj.name = str(args.get("name") or primitive.title())
    obj.location = loc
    if args.get("rotation"):
        rx, ry, rz = _vec(args.get("rotation"), (0, 0, 0))
        obj.rotation_euler = (math.radians(rx), math.radians(ry), math.radians(rz))
    if args.get("scale"):
        obj.scale = _vec(args.get("scale"), (1, 1, 1))
    _ensure_material(obj, str(args.get("material") or "plastic"), args.get("color"))
    return f"Created {obj.name}"


def object_transform(args: dict) -> str:
    obj = _find(args.get("name") or args.get("id"))
    if not obj:
        return "No object to transform"
    if args.get("location"):
        obj.location = _vec(args.get("location"), tuple(obj.location))
    if args.get("rotation"):
        rx, ry, rz = _vec(args.get("rotation"), (0, 0, 0))
        obj.rotation_euler = (math.radians(rx), math.radians(ry), math.radians(rz))
    if args.get("scale"):
        obj.scale = _vec(args.get("scale"), tuple(obj.scale))
    return f"Transformed {obj.name}"


def object_delete(args: dict) -> str:
    obj = _find(args.get("name") or args.get("id"))
    if not obj:
        return "Object not found"
    name = obj.name
    bpy.data.objects.remove(obj, do_unlink=True)
    return f"Deleted {name}"


def object_duplicate(args: dict) -> str:
    obj = _find(args.get("name"))
    if not obj:
        return "Nothing to duplicate"
    _select(obj)
    bpy.ops.object.duplicate()
    copy = bpy.context.object
    copy.location.x += 1.4
    copy.name = f"{obj.name}_copy"
    return f"Duplicated {obj.name}"


def object_rename(args: dict) -> str:
    obj = _find(args.get("name") or args.get("id"))
    if not obj:
        return "Object not found"
    obj.name = str(args.get("newName") or obj.name)
    return f"Renamed to {obj.name}"


def object_set_material(args: dict) -> str:
    obj = _find(args.get("name")) or bpy.context.view_layer.objects.active
    if not obj or obj.type != "MESH":
        return "No mesh for material"
    _ensure_material(obj, str(args.get("material") or "plastic"), args.get("color"))
    return f"Material {args.get('material')} on {obj.name}"


def light_create(args: dict) -> str:
    light_type = str(args.get("type") or "AREA")
    loc = _vec(args.get("location"), (4, -3, 6))
    bpy.ops.object.light_add(type=light_type, location=loc)
    obj = bpy.context.object
    obj.name = str(args.get("name") or "Light")
    data = obj.data
    data.energy = float(args.get("energy") or (3 if light_type == "SUN" else 250))
    if args.get("color"):
        data.color = _hex_rgb(str(args["color"]))
    if hasattr(data, "size"):
        data.size = float(args.get("size") or 1.2)
    return f"Light {obj.name}"


def camera_create(args: dict) -> str:
    loc = _vec(args.get("location"), (7.4, -6.8, 4.8))
    force = bool(args.get("force"))
    cam = None if force else bpy.context.scene.camera
    if cam is None:
        bpy.ops.object.camera_add(location=loc)
        cam = bpy.context.object
        if not force:
            bpy.context.scene.camera = cam
    else:
        cam.location = loc
    look = _vec(args.get("lookAt"), (0, 0, 0.6))
    direction = Vector(look) - cam.location
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    if args.get("fov") and cam.data:
        cam.data.lens_unit = "FOV"
        cam.data.angle = math.radians(float(args["fov"]))
    cam.name = str(args.get("name") or "Camera")
    return f"Camera {cam.name}"


def camera_frame(args: dict) -> dict:
    from .observe import hero_bounds, observe, run_checks

    follow = args.get("follow")
    try:
        root, _meshes, center, low, high, _depsgraph = hero_bounds(follow)
    except ValueError as error:
        return {"ok": False, "message": str(error)}
    scene = bpy.context.scene
    scene["astra_follow"] = root.name
    cam = scene.camera
    if cam is None:
        bpy.ops.object.camera_add()
        cam = bpy.context.object
        scene.camera = cam
    distance = max((high - low).length * 1.35, 4.0)
    cam.parent = None
    cam.location = center + Vector((distance * 0.72, -distance, distance * 0.48))
    cam.rotation_euler = (center - cam.location).to_track_quat("-Z", "Y").to_euler()
    evidence = observe(root.name)
    checks = run_checks(evidence, ("camera_aimed_at_hero", "camera_occluded"))
    return {"ok": all(check["ok"] for check in checks),
            "message": "Camera framed to evaluated hero meshes", "observation": evidence, "checks": checks}


def animation_turntable(args: dict) -> str:
    cam = bpy.context.scene.camera
    if cam is None:
        return "No camera"
    scene = bpy.context.scene
    scene.frame_start = 1
    scene.frame_end = 120
    cam.rotation_mode = "XYZ"
    cam.keyframe_insert(data_path="rotation_euler", frame=1)
    cam.rotation_euler[2] += math.radians(360)
    cam.keyframe_insert(data_path="rotation_euler", frame=120)
    if cam.animation_data and cam.animation_data.action:
        for fcurve in cam.animation_data.action.fcurves:
            for kp in fcurve.keyframe_points:
                kp.interpolation = "LINEAR"
    return f"Turntable {args.get('mode', 'turntable')}"


MASK_IDS = {"set": 1, "hero": 2, "extras": 3, "door": 4, "ocean": 5, "cams": 6, "sky": 8}


def _render_settings(args: dict, *, animation: bool) -> dict:
    from pathlib import Path

    path = Path(str(args.get("path", "")))
    suffix = ".mp4" if animation else ".png"
    if path.suffix.lower() != suffix:
        raise ValueError(f"path must end in {suffix}")
    source = bpy.context.scene
    if source.camera is None:
        raise ValueError("render requires an active camera")
    def integer(key, default, low=1):
        value = args.get(key, default)
        if isinstance(value, bool) or not isinstance(value, int) or value < low:
            raise ValueError(f"{key} must be an integer >= {low}")
        return value
    width = integer("width", source.render.resolution_x)
    height = integer("height", source.render.resolution_y)
    start = integer("frameStart", source.frame_start, -1048574)
    end = integer("frameEnd", source.frame_end, -1048574)
    frame = integer("frame", source.frame_current, -1048574)
    fps = integer("fps", source.render.fps)
    if animation and (end < start or width % 2 or height % 2):
        raise ValueError("animation requires frameEnd >= frameStart and even dimensions")
    return dict(path=path, width=width, height=height, start=start, end=end, frame=frame, fps=fps)


def _render(args: dict, *, animation: bool, matte: bool = False, target_names: set[str] | None = None) -> str:
    """Render locally; Workbench has no IndexOB pass, so use index-selected materials.

    Non-target geometry stays black and still occludes the white target. A copied
    scene and temporary geometry keep the author's materials/settings intact.
    PNG sequences + CPU ffmpeg also work on Blender 5 (no built-in FFmpeg output).
    """
    from pathlib import Path
    import subprocess
    import tempfile

    settings = _render_settings(args, animation=animation)
    path, width, height = settings["path"], settings["width"], settings["height"]
    start, end, frame, fps = (settings[key] for key in ("start", "end", "frame", "fps"))
    mask = args.get("mask")
    if matte and mask not in MASK_IDS:
        raise ValueError(f"mask must be one of {', '.join(MASK_IDS)}")
    source = bpy.context.scene
    path = path.resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    scene = source.copy()
    window = bpy.context.window
    original_window_scene = window.scene if window else None
    original_frame = source.frame_current
    geometry = []
    materials = []
    try:
        if window:
            window.scene = scene
        scene.render.engine = "BLENDER_WORKBENCH"
        scene.display.shading.light = "FLAT"
        scene.display.shading.color_type = "MATERIAL"
        scene.display.shading.show_shadows = False
        scene.display.shading.show_cavity = False
        scene.display.shading.show_specular_highlight = False
        scene.display.shading.show_object_outline = False
        scene.display.shading.background_type = "WORLD"
        scene.world = source.world.copy() if source.world else bpy.data.worlds.new("RenderWorld")
        scene.world.color = (0, 0, 0)
        scene.render.film_transparent = False
        scene.render.resolution_x, scene.render.resolution_y = width, height
        scene.render.resolution_percentage = 100
        scene.render.image_settings.file_format = "PNG"
        scene.render.image_settings.color_mode = "RGB"
        scene.render.use_file_extension = True
        scene.render.use_compositing = False
        scene.render.use_sequencer = False
        scene.render.fps, scene.render.fps_base = fps, 1.0
        scene.view_settings.view_transform = "Standard"
        scene.view_settings.look = "None"
        scene.view_settings.exposure, scene.view_settings.gamma = 0, 1
        if matte:
            for name, color in (("MaskBlack", 0), ("MaskWhite", 1)):
                mat = bpy.data.materials.new(name)
                mat.diffuse_color = (color, color, color, 1)
                materials.append(mat)
            for obj in scene.objects:
                if obj.type not in {"MESH", "CURVE", "SURFACE", "META", "FONT"}:
                    continue
                data = obj.data
                copied = data.copy()
                slots = [(slot.link, slot.material) for slot in obj.material_slots]
                geometry.append((obj, data, copied, slots))
                obj.data = copied
                material = materials[int(obj.pass_index == MASK_IDS[mask]
                                         and (target_names is None or obj.name in target_names))]
                if not copied.materials:
                    copied.materials.append(material)
                for slot in obj.material_slots:
                    slot.link = "DATA"
                    slot.material = material
        def still(at, output):
            scene.frame_set(at)
            scene.render.filepath = str(output)
            bpy.ops.render.render(write_still=True, scene=scene.name)
        if not animation:
            still(frame, path)
        else:
            with tempfile.TemporaryDirectory(prefix="astra-render-") as temp:
                for i, at in enumerate(range(start, end + 1)):
                    still(at, Path(temp) / f"{i:06d}.png")
                encoded = Path(temp) / "encoded.mp4"
                subprocess.run([
                    "ffmpeg", "-v", "error", "-y", "-framerate", str(fps),
                    "-i", str(Path(temp) / "%06d.png"), "-an", "-c:v", "libx264",
                    "-threads", "1", "-crf", "0" if matte else "18", "-pix_fmt", "yuv420p",
                    "-movflags", "+faststart", str(encoded),
                ], check=True)
                import shutil
                shutil.copyfile(encoded, path)
        return str(path)
    finally:
        for obj, data, copied, slots in reversed(geometry):
            obj.data = data
            for slot, (link, material) in zip(obj.material_slots, slots):
                slot.link, slot.material = link, material
            bpy.data.batch_remove(ids=(copied,))
        world = scene.world
        if window:
            window.scene = original_window_scene
        bpy.data.scenes.remove(scene)
        if world and world != source.world:
            bpy.data.worlds.remove(world)
        for mat in materials:
            bpy.data.materials.remove(mat)
        source.frame_set(original_frame)


def render_frame(args: dict) -> str:
    return _render(args, animation=False, matte="mask" in args)


def render_animation(args: dict) -> dict:
    from .observe import camera_gate

    result = camera_gate(args)
    if not result["ok"]:
        return {**result, "message": "hero_on_screen failed: animation blocked"}
    path = _render(args, animation=True)
    return {**result, "message": path}


def render_matte(args: dict) -> str:
    return _render(args, animation=True, matte=True)


HANDLERS = {
    "render.frame": render_frame,
    "render.animation": render_animation,
    "render.matte": render_matte,
    "scene.clear": scene_clear,
    "scene.set_world": scene_set_world,
    "object.create": object_create,
    "object.transform": object_transform,
    "object.delete": object_delete,
    "object.duplicate": object_duplicate,
    "object.rename": object_rename,
    "object.set_material": object_set_material,
    "light.create": light_create,
    "camera.create": camera_create,
    "camera.frame": camera_frame,
    "animation.turntable": animation_turntable,
    "world.build": None,
    "character.spawn": None,
    "character.appear": None,
    "character.action": None,
    "character.move": None,
    "camera.mode": None,
    "physics.set": None,
    "mask.set": None,
}


def run_call(call: dict) -> dict:
    tool = call.get("tool")
    args = call.get("args") or {}
    if tool == "skill.run":
        from .skills import expand_skill

        steps = expand_skill(str(args.get("skill") or ""), args)
        messages = [run_call(step)["message"] for step in steps]
        return {"ok": True, "tool": tool, "message": "; ".join(messages)}
    from . import world as astra_world

    extra = {
        "world.build": astra_world.world_build,
        "character.spawn": astra_world.character_spawn,
        "character.appear": astra_world.character_appear,
        "character.action": astra_world.character_action,
        "character.move": astra_world.character_move,
        "camera.mode": astra_world.camera_mode,
        "physics.set": astra_world.physics_set,
        "mask.set": astra_world.mask_set,
    }
    handler = HANDLERS.get(tool) or extra.get(tool)
    if handler is None:
        return {"ok": False, "tool": tool, "message": f"Unknown tool {tool}"}
    message = handler(args)
    if isinstance(message, dict):
        return {**message, "tool": tool}
    return {"ok": True, "tool": tool, "message": message}


def scene_graph() -> dict:
    objects = []
    for obj in bpy.data.objects:
        item = {
            "name": obj.name,
            "kind": {"MESH": "mesh", "LIGHT": "light", "CAMERA": "camera"}.get(obj.type, "empty"),
            "location": list(obj.location),
            "rotation": [math.degrees(a) for a in obj.rotation_euler],
            "scale": list(obj.scale),
            "visible": obj.visible_get(),
        }
        objects.append(item)
    return {"objects": objects, "camera": bpy.context.scene.camera.name if bpy.context.scene.camera else None}


def register():
    return None


def unregister():
    return None
