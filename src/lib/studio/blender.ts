import type { CallSheet } from "./types";

function sceneJson(sheet: CallSheet) {
  const chars = JSON.stringify(
    sheet.characters.map((c) => ({ id: c.id, name: c.name, heightM: c.heightM ?? 1.0 })),
    null,
    2,
  );
  const shots = JSON.stringify(
    sheet.shots.map((s) => ({
      id: s.id,
      size: s.size,
      duration: s.durationSec,
      camera: s.camera,
      marks: s.marks,
      props: s.props ?? [],
    })),
    null,
    2,
  );
  return { chars, shots };
}

// mannequin python — shared verbatim by the blocking preview and the blockout render.
// WORKBENCH renders meshes, never armatures — v32 proved the cube shape.
const PY_HELPERS = `import json, math, sys
import bpy
from mathutils import Vector

def clear():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)

def grey(name, v):
    m = bpy.data.materials.new(name)
    m.use_nodes = False
    m.diffuse_color = (v, v, v, 1)
    return m

def make_ground():
    bpy.ops.mesh.primitive_plane_add(size=16, location=(0, 0, 0))
    ground = bpy.context.active_object
    ground.name = "Floor"
    ground.data.materials.append(grey("WetFloor", 0.62))

def cube(loc, scl, mat, rot=None):
    kw = {"size": 1, "location": loc, "scale": scl}
    if rot is not None:
        kw["rotation"] = rot
    bpy.ops.mesh.primitive_cube_add(**kw)
    o = bpy.context.active_object
    o.data.materials.append(mat)
    return o

# u,v in [0,1], v measured from the TOP of frame (painter convention: y% down)
def unproject(cam, scene, u, v, z_plane):
    fr = [cam.matrix_world @ p for p in cam.data.view_frame(scene=scene)]
    # Blender view_frame order: [right-top, right-bottom, left-bottom, left-top]
    top = fr[3].lerp(fr[0], u)
    bot = fr[2].lerp(fr[1], u)
    pt = top.lerp(bot, v)
    o = cam.matrix_world.translation
    d = pt - o
    if d.z >= -1e-6:
        raise SystemExit("mark ray does not hit the floor: u=%s v=%s" % (u, v))
    t = (z_plane - o.z) / d.z
    return o + d * t

def mannequin(name, h, mat):
    torso = cube((0, 0, 0.75 * h), (0.55 * h, 0.35, 0.75 * h), mat)
    head = cube((0, 0, 1.65 * h), (0.42 * h, 0.34, 0.42 * h), mat)
    legs = [cube((sx * h, 0, 0.2 * h), (0.16, 0.3, 0.4 * h), mat) for sx in (-0.18, 0.18)]
    pivot = bpy.data.objects.new(name + "_pivot", None)
    bpy.context.collection.objects.link(pivot)
    for p in [torso, head] + legs:
        p.parent = pivot
    return pivot, torso, head, legs

# (rot_x_deg, dz_factor, torso_z, legs_z) — dz_factor is multiplied by h
STANCE = {
    "stand": (0.0, 0.0, 1.0, 1.0),
    "lean": (-25.0, 0.0, 1.0, 1.0),
    "crouch": (0.0, -0.28, 0.75, 0.5),
}

def foot_mid(mark):
    return (mark["footL"]["x"] + mark["footR"]["x"]) / 200.0, (mark["footL"]["y"] + mark["footR"]["y"]) / 200.0

def char_height(ch):
    return float(ch.get("heightM") or 1.0)

def build_shot(shot, frame0, frames=None):
    scene = bpy.context.scene
    cam_data = bpy.data.cameras.new(shot["id"] + "_cam")
    cam_data.lens = shot["camera"]["lensMm"]
    cam = bpy.data.objects.new(shot["id"] + "_Camera", cam_data)
    bpy.context.collection.objects.link(cam)
    p = shot["camera"]["pos"]
    look = shot["camera"]["lookAt"]
    cam.location = (p["x"], p["y"], p["z"])
    direction = Vector((look["x"]-p["x"], look["y"]-p["y"], look["z"]-p["z"]))
    cam.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
    # matrix_world is stale in -b mode until the depsgraph runs — unproject
    # would read an identity matrix and stack every figure at the origin
    bpy.context.view_layer.update()
    fps = 24
    frames = int(frames if frames is not None else shot["duration"] * fps)
    right = cam.matrix_world.to_3x3() @ Vector((1, 0, 0))
    right = Vector((right.x, right.y, 0))
    right.normalize()
    body = grey(shot["id"] + "_body", 0.40)
    for mark in shot["marks"]:
        ch = next((c for c in CHARS if c["id"] == mark["characterId"]), None)
        if ch is None:
            raise SystemExit("mark references unknown character: " + mark["characterId"])
        h = char_height(ch)
        # feet decide depth (they touch the floor); start/end only give the travel vector
        fu, fv = foot_mid(mark)
        p_feet = unproject(cam, scene, fu, fv, 0.0)
        a = unproject(cam, scene, mark["start"]["x"] / 100.0, fv, 0.0)
        b = unproject(cam, scene, mark["end"]["x"] / 100.0, fv, 0.0)
        delta = b - a
        pivot, torso, head, legs = mannequin(shot["id"] + "_" + ch["name"], h, body)
        # +y faces camera-right (facing >= 0) or camera-left
        f = right if mark.get("facing", 0) >= 0 else -right
        pivot.rotation_euler = (0, 0, math.atan2(-f.x, f.y))
        s0 = STANCE[mark.get("stance") or "stand"]
        s1 = STANCE[mark.get("stanceEnd")] if mark.get("stanceEnd") else s0
        hold = max(1, int(0.4 * frames))
        for f_i in range(frames + 1):
            t = f_i / max(1, frames)
            k = min(1.0, f_i / hold)
            rot = s0[0] + (s1[0] - s0[0]) * k
            dz = (s0[1] + (s1[1] - s0[1]) * k) * h
            tz = s0[2] + (s1[2] - s0[2]) * k
            lz = s0[3] + (s1[3] - s0[3]) * k
            loc = p_feet + delta * t
            pivot.location = (loc.x, loc.y, dz)
            pivot.keyframe_insert("location", frame=frame0 + f_i)
            for part in (torso, head):
                part.rotation_euler = (math.radians(rot), 0, 0)
                part.keyframe_insert("rotation_euler", frame=frame0 + f_i)
            # ops scale= bakes into the mesh — keyframe only the stance multiplier
            torso.scale = (1.0, 1.0, tz)
            torso.keyframe_insert("scale", frame=frame0 + f_i)
            for leg in legs:
                leg.scale = (1.0, 1.0, lz)
                leg.keyframe_insert("scale", frame=frame0 + f_i)
    plow = next((pr for pr in (shot.get("props") or []) if "犁" in pr["name"]), None)
    if plow is not None:
        holder = next((m for m in shot["marks"] if m["characterId"] == plow.get("heldBy")), shot["marks"][0])
        hch = next((c for c in CHARS if c["id"] == holder["characterId"]), None)
        hh = char_height(hch) if hch else 1.0
        hu = (holder["handL"]["x"] + holder["handR"]["x"]) / 200.0
        hv = (holder["handL"]["y"] + holder["handR"]["y"]) / 200.0
        A = unproject(cam, scene, hu, hv, 0.85 * hh)
        pts = [unproject(cam, scene, *foot_mid(m), 0.0) for m in shot["marks"][:2]]
        S = (pts[0] + pts[1]) / 2.0
        o = cam.matrix_world.translation
        toward = Vector((o.x - S.x, o.y - S.y, 0))
        toward.normalize()
        S = S + toward * 0.4
        B = Vector((S.x, S.y, 0.0))
        iron = grey(shot["id"] + "_plow", 0.22)
        dx, dy, dz = B.x - A.x, B.y - A.y, B.z - A.z
        L = math.sqrt(dx * dx + dy * dy + dz * dz)
        mid = ((A.x + B.x) / 2, (A.y + B.y) / 2, (A.z + B.z) / 2)
        cube(mid, (0.06, L, 0.12), iron,
             rot=(math.atan2(dz, math.hypot(dx, dy)), 0, math.atan2(dx, dy)))
        cube((B.x + 0.03, B.y + 0.02, 0.06), (0.26, 0.34, 0.05), iron,
             rot=(0, 0, math.radians(20)))
    return frame0 + frames
`;

export function blenderBlockingScript(sheet: CallSheet) {
  const { chars, shots } = sceneJson(sheet);
  return `# SlateCrew layout agent — Blender 4.x
# Fast blocking: scene marks, camera, grey mesh mannequins (WORKBENCH-safe).
# blender -b -P blocking.py
${PY_HELPERS}
CHARS = json.loads(${JSON.stringify(chars)})
SHOTS = json.loads(${JSON.stringify(shots)})
TITLE = ${JSON.stringify(sheet.title)}

def main():
    clear()
    make_ground()
    bpy.ops.object.light_add(type='AREA', location=(2, -2, 4))
    bpy.context.active_object.data.energy = 250
    bpy.context.active_object.data.size = 3
    f = 1
    for shot in SHOTS:
        f = build_shot(shot, f) + 6
    scene = bpy.context.scene
    scene.frame_start = 1
    scene.frame_end = f
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.fps = 24
    scene.render.resolution_x = 1280
    scene.render.resolution_y = 720
    print("SlateCrew blocking ready:", TITLE, "frames", f)

main()
`;
}

/** per-shot grey WORKBENCH blockout: own camera active, frames set by the wav
 *  snap, PNG sequence for ffmpeg. argv after `--`: --frames --out --width --height --fps */
export function blenderBlockoutScript(sheet: CallSheet, shotId: string) {
  const { chars, shots } = sceneJson(sheet);
  return `# SlateCrew blockout render — grey WORKBENCH, one shot, one camera.
# blender -b --threads 8 -P blockout.py -- --frames 48 --out DIR --width 864 --height 480 --fps 24
${PY_HELPERS}
CHARS = json.loads(${JSON.stringify(chars)})
SHOTS = json.loads(${JSON.stringify(shots)})
SHOT_ID = ${JSON.stringify(shotId)}

def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    def arg(name, default):
        return argv[argv.index(name) + 1] if name in argv else default
    frames = int(arg("--frames", "48"))
    out_dir = arg("--out", "/tmp/slatecrew_blockout")
    width = int(arg("--width", "864"))
    height = int(arg("--height", "480"))
    fps = int(arg("--fps", "24"))

    shot = next((s for s in SHOTS if s["id"] == SHOT_ID), None)
    if shot is None:
        raise SystemExit("no such shot: " + SHOT_ID)

    clear()
    make_ground()
    bpy.ops.object.light_add(type='AREA', location=(2, -2, 4))
    bpy.context.active_object.data.energy = 250
    bpy.context.active_object.data.size = 3

    build_shot(shot, 1, frames)
    bpy.context.scene.camera = bpy.data.objects[shot["id"] + "_Camera"]

    scene = bpy.context.scene
    scene.frame_start = 1
    scene.frame_end = frames
    scene.render.engine = "BLENDER_WORKBENCH"
    # FLAT: STUDIO lighting flattens figure-vs-floor contrast to ~9 luma, which
    # cannot pass the YMAX-YMIN>=40 figure gate; FLAT renders pure material greys
    scene.display.shading.light = "FLAT"
    scene.display.shading.color_type = "MATERIAL"
    scene.render.fps = fps
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = out_dir + "/frame_"
    bpy.ops.render.render(animation=True)
    print("SlateCrew blockout rendered:", SHOT_ID, frames, "frames ->", out_dir)

main()
`;
}
