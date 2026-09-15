"""Authored skills — the same recipes the web compiler uses."""

from __future__ import annotations

from typing import Any


def _light(name: str, type_: str, location: list[float], energy: float, color: str) -> dict:
    return {
        "tool": "light.create",
        "args": {"name": name, "type": type_, "location": location, "energy": energy, "color": color},
    }


SKILLS = {
    "three_point_lighting": [
        _light("Key", "AREA", [4.2, -3.4, 5.6], 420, "#fff3dd"),
        _light("Fill", "AREA", [-3.8, -2.2, 3.4], 140, "#d7e7ff"),
        _light("Rim", "AREA", [0.2, 4.6, 4.8], 220, "#fff7f0"),
    ],
    "studio_soft": [
        {"tool": "scene.set_world", "args": {"mood": "studio", "color": "#0c0d12", "strength": 0.18}},
        _light("SoftKey", "AREA", [3.6, -4.2, 6.2], 380, "#fff7ea"),
        _light("SoftFill", "AREA", [-4.4, -1.4, 3.8], 110, "#e8f0ff"),
        _light("Top", "AREA", [0, 0, 7.5], 90, "#ffffff"),
    ],
    "overcast": [
        {"tool": "scene.set_world", "args": {"mood": "overcast", "color": "#9eb0c6", "strength": 0.55}},
        _light("Sky", "SUN", [2, -4, 8], 2.2, "#e9f1ff"),
    ],
    "night_neon": [
        {"tool": "scene.set_world", "args": {"mood": "night", "color": "#05060c", "strength": 0.08}},
        _light("Cyan", "AREA", [-3.2, -2, 2.4], 260, "#3ec6e0"),
        _light("Magenta", "AREA", [3.4, 1.6, 2.2], 240, "#d946ef"),
        _light("Moon", "SUN", [-6, 3, 9], 1.1, "#9bb7ff"),
    ],
    "sunset_rim": [
        {"tool": "scene.set_world", "args": {"mood": "sunset", "color": "#24160e", "strength": 0.22}},
        _light("SunKey", "SUN", [6, -2, 4], 4.2, "#ffb067"),
        _light("CoolFill", "AREA", [-4, -3, 2.4], 80, "#8fb4ff"),
        _light("Rim", "AREA", [1, 5, 3.2], 180, "#ffd0a0"),
    ],
    "cinematic_camera": [
        {"tool": "camera.create", "args": {"location": [6.4, -7.8, 2.6], "lookAt": [0, 0, 0.9], "fov": 35}},
    ],
    "product_camera": [
        {"tool": "camera.create", "args": {"location": [5.6, -5.8, 4.2], "lookAt": [0, 0, 0.7], "fov": 40}},
        {"tool": "camera.frame", "args": {}},
    ],
    "turntable": [{"tool": "animation.turntable", "args": {"mode": "turntable"}}],
    "clay_preview": [{"tool": "object.set_material", "args": {"material": "clay", "color": "#d5c4ae"}}],
    "studio_ground": [
        {
            "tool": "object.create",
            "args": {
                "primitive": "plane",
                "name": "StudioGround",
                "location": [0, 0, 0],
                "scale": [14, 14, 1],
                "material": "matte",
                "color": "#1a1c22",
            },
        }
    ],
    "marble_plinth": [
        {
            "tool": "object.create",
            "args": {
                "primitive": "cylinder",
                "name": "Plinth",
                "location": [0, 0, 0.28],
                "scale": [1.1, 1.1, 0.56],
                "material": "marble",
            },
        }
    ],
    "truman_world": [{"tool": "world.build", "args": {"preset": "truman"}}],
    "town_plaza": [{"tool": "world.build", "args": {"preset": "plaza"}}],
    "interior_room": [{"tool": "world.build", "args": {"preset": "interior"}}],
    "first_person": [{"tool": "camera.mode", "args": {"mode": "first_person"}}],
    "third_person": [{"tool": "camera.mode", "args": {"mode": "third_person"}}],
    "hidden_cameras": [{"tool": "camera.mode", "args": {"mode": "hidden"}}],
    "walk_cycle": [{"tool": "character.action", "args": {"action": "walk"}}],
    "wave_action": [{"tool": "character.action", "args": {"action": "wave"}}],
}


def expand_skill(skill_id: str, _params: dict[str, Any] | None = None) -> list[dict]:
    return list(SKILLS.get(skill_id, []))


def list_skills() -> list[dict]:
    return [{"id": key, "steps": len(steps)} for key, steps in SKILLS.items()]
