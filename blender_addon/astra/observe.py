"""Camera evidence from evaluated geometry and a freshly rendered hero mask."""

from __future__ import annotations

import hashlib
import json
import math
import re
from pathlib import Path

import bpy
from mathutils import Vector


CAMERA_CHECKS = ("camera_aimed_at_hero", "camera_occluded", "hero_on_screen")
CENTER_REGION = (0.25, 0.75)
MIN_PIXELS = 16
AIM_TOLERANCE_DEG = 15.0


def hero_geometry(follow: str | None = None):
    """Only pass-index 2 meshes count; an empty/armature is never the target."""
    scene = bpy.context.scene
    follow = follow if follow is not None else scene.get("astra_follow")
    meshes = [obj for obj in scene.objects if obj.type == "MESH" and obj.pass_index == 2]
    root = scene.objects.get(follow) if follow else None
    if follow and root is None:
        raise ValueError(f"hero_missing: follow object {follow!r} does not exist")
    if root:
        def belongs(obj):
            while obj:
                if obj == root:
                    return True
                obj = obj.parent
            return False
        meshes = [obj for obj in meshes if belongs(obj)]
    if not meshes:
        raise ValueError("hero_missing: no pass_index=2 mesh under the selected rig")
    if root is None:
        roots = set()
        for obj in meshes:
            while obj.parent:
                obj = obj.parent
            roots.add(obj)
        if len(roots) != 1:
            raise ValueError("hero_ambiguous: select one rig with camera.mode follow")
        root = roots.pop()
    return root, meshes


def hero_bounds(follow: str | None = None):
    root, meshes = hero_geometry(follow)
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    corners = []
    for obj in meshes:
        evaluated = obj.evaluated_get(depsgraph)
        if len(evaluated.data.vertices):
            corners.extend(evaluated.matrix_world @ Vector(c) for c in evaluated.bound_box)
    if not corners:
        raise ValueError("hero_missing: evaluated meshes have no geometry")
    low = Vector(tuple(min(c[i] for c in corners) for i in range(3)))
    high = Vector(tuple(max(c[i] for c in corners) for i in range(3)))
    return root, meshes, (low + high) * 0.5, low, high, depsgraph


def _occlusion(scene, depsgraph, origin, center, meshes):
    delta = center - origin
    distance = delta.length
    if distance < 1e-6:
        return None, None
    direction = delta.normalized()
    # A render-hidden mesh cannot block pixels. Walk past its intersections.
    point = origin.copy()
    for _ in range(128):
        remaining = (center - point).dot(direction)
        if remaining <= 1e-5:
            return False, None
        hit, position, _normal, _index, obj, _matrix = scene.ray_cast(
            depsgraph, point, direction, distance=remaining,
        )
        if not hit:
            return False, None
        original = obj.original
        if original in meshes:
            return False, None
        if not original.hide_render:
            return True, original.name
        point = position + direction * 1e-4
    return None, "ray_limit"


def observe(follow: str | None = None) -> dict:
    """Geometry alone never manufactures a hero_on_screen pass."""
    scene = bpy.context.scene
    result = {
        "protocol": "astra.protocol.v2", "blender": bpy.app.version_string,
        "frame": scene.frame_current, "hero": None, "camera": None,
        "pixelEvidence": None, "errors": [],
    }
    try:
        root, meshes, center, low, high, depsgraph = hero_bounds(follow)
        result["hero"] = {
            "name": root.name, "meshes": sorted(obj.name for obj in meshes),
            "maskId": 2, "location": list(center),
            "bounds": {"min": list(low), "max": list(high)}, "screenPos": None,
        }
    except ValueError as error:
        result["errors"].append(str(error))
        return result
    cam = scene.camera
    if cam is None:
        result["errors"].append("camera_missing")
        return result
    matrix = cam.evaluated_get(depsgraph).matrix_world
    origin = matrix.translation
    forward = (matrix.to_quaternion() @ Vector((0, 0, -1))).normalized()
    delta = center - origin
    angle = math.degrees(forward.angle(delta)) if delta.length > 1e-6 else None
    occluded, blocker = _occlusion(scene, depsgraph, origin, center, meshes)
    result["camera"] = {
        "name": cam.name, "location": list(origin), "forward": list(forward),
        "aimAngleDeg": angle, "occluded": occluded, "blocker": blocker,
        "evaluated": True,
    }
    return result


def run_checks(observation: dict, ids=CAMERA_CHECKS) -> list[dict]:
    hero = observation.get("hero") or {}
    camera = observation.get("camera") or {}
    pixels = observation.get("pixelEvidence") or {}
    position = hero.get("screenPos")
    angle = camera.get("aimAngleDeg")
    geometry = (observation.get("protocol") == "astra.protocol.v2" and bool(hero.get("meshes"))
                and hero.get("maskId") == 2 and camera.get("evaluated") is True)
    pixel_ok = (
        geometry and pixels.get("source") == "PIL" and pixels.get("maskId") == 2
        and pixels.get("frame") == observation.get("frame")
        and pixels.get("camera") == camera.get("name")
        and pixels.get("meshes") == hero.get("meshes")
        and type(pixels.get("pixelCount")) is int and pixels["pixelCount"] >= MIN_PIXELS
        and type(pixels.get("width")) is int and pixels["width"] > 0
        and type(pixels.get("height")) is int and pixels["height"] > 0
        and pixels["pixelCount"] <= pixels["width"] * pixels["height"]
        and bool(re.fullmatch(r"[a-f0-9]{64}", pixels.get("sha256", ""))) and bool(pixels.get("path"))
        and position is not None and len(position) == 2
        and all(isinstance(v, (int, float)) and math.isfinite(v)
                and CENTER_REGION[0] <= v <= CENTER_REGION[1] for v in position)
    )
    table = {
        "camera_aimed_at_hero": (geometry and isinstance(angle, (int, float))
                                  and math.isfinite(angle) and 0 <= angle <= AIM_TOLERANCE_DEG,
                                  f"evaluated hero bbox aim angle={angle}; maximum={AIM_TOLERANCE_DEG} degrees"),
        # The check name describes the question; ok=True means the path is clear.
        "camera_occluded": (geometry and camera.get("occluded") is False,
                              f"occluded={camera.get('occluded')}; blocker={camera.get('blocker')}"),
        "hero_on_screen": (bool(pixel_ok),
                            f"PIL centroid={position}; pixels={pixels.get('pixelCount', 0)}; centre region={CENTER_REGION}"),
    }
    return [
        {"id": id_, "ok": bool(table.get(id_, (False, "unknown check"))[0]),
         "detail": table.get(id_, (False, "unknown check"))[1],
         "required": id_ == "hero_on_screen"}
        for id_ in ids
    ]


def camera_gate(args: dict) -> dict:
    """Fresh midpoint evidence for this exact render; no cached/caller verdicts."""
    from .executor import _render, render_frame, _render_settings

    scene = bpy.context.scene
    settings = _render_settings(args, animation=True)
    output = Path(args["path"]).resolve()
    proof = output.parent / (output.stem + ".camera")
    proof.mkdir(parents=True, exist_ok=True)
    frame = (settings["start"] + settings["end"]) // 2
    before = scene.frame_current
    try:
        scene.frame_set(frame)
        observation = observe()
        options = {"frame": frame, "width": settings["width"], "height": settings["height"]}
        if observation["hero"] and observation["camera"]:
            frame_path = proof / "frame.png"
            mask_path = proof / "hero-mask.png"
            render_frame({**options, "path": str(frame_path)})
            _render({**options, "path": str(mask_path), "mask": "hero"}, animation=False,
                    matte=True, target_names=set(observation["hero"]["meshes"]))
            try:
                from PIL import Image
                with Image.open(mask_path) as image:
                    image = image.convert("L")
                    width, height = image.size
                    count = x_sum = y_sum = 0
                    for index, value in enumerate(image.getdata()):
                        if value >= 128:
                            count += 1
                            x_sum += index % width
                            y_sum += index // width
                position = [(x_sum / count + 0.5) / width, (y_sum / count + 0.5) / height] if count else None
                observation["hero"]["screenPos"] = position
                observation["pixelEvidence"] = {
                    "source": "PIL", "maskId": 2, "frame": frame,
                    "camera": observation["camera"]["name"], "meshes": observation["hero"]["meshes"],
                    "path": str(mask_path), "sha256": hashlib.sha256(mask_path.read_bytes()).hexdigest(),
                    "width": width, "height": height, "pixelCount": count,
                    "framePath": str(frame_path), "frameSha256": hashlib.sha256(frame_path.read_bytes()).hexdigest(),
                }
            except ImportError:
                observation["errors"].append("pillow_unconfigured")
        checks = run_checks(observation)
        result = {"observation": observation, "checks": checks,
                  "ok": all(check["ok"] for check in checks if check["required"])}
        (proof / "observation.json").write_text(json.dumps(result, indent=2) + "\n")
        return result
    finally:
        scene.frame_set(before)
