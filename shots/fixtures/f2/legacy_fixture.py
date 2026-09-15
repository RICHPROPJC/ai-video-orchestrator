# SlateCrew blockout render — grey WORKBENCH, one shot, one camera.
# blender -b --threads 8 -P blockout.py -- --frames 48 --out DIR --width 864 --height 480 --fps 24
import json, math, sys
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

def make_ground(v=0.62):
    bpy.ops.mesh.primitive_plane_add(size=16, location=(0, 0, 0))
    ground = bpy.context.active_object
    ground.name = "Floor"
    ground.data.materials.append(grey("Floor", v))

def cube(loc, scl, mat, rot=None):
    kw = {"size": 1, "location": loc, "scale": scl}
    if rot is not None:
        kw["rotation"] = rot
    bpy.ops.mesh.primitive_cube_add(**kw)
    o = bpy.context.active_object
    o.data.materials.append(mat)
    return o

def cyl(loc, radius, depth, mat, rot=None):
    bpy.ops.mesh.primitive_cylinder_add(radius=radius, depth=depth, location=loc)
    o = bpy.context.active_object
    if rot is not None:
        o.rotation_euler = rot
    o.data.materials.append(mat)
    return o

def ball(loc, radius, mat):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=radius, location=loc)
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
    torso = cyl((0, 0, 0.72 * h), 0.16 * h, 0.72 * h, mat)
    head = ball((0, 0, 1.22 * h), 0.13 * h, mat)
    legs = [cyl((sx * h, 0, 0.22 * h), 0.07 * h, 0.44 * h, mat) for sx in (-0.12, 0.12)]
    arms = [cyl((sx * h, 0, 0.85 * h), 0.05 * h, 0.40 * h, mat) for sx in (-0.28, 0.28)]
    pivot = bpy.data.objects.new(name + "_pivot", None)
    bpy.context.collection.objects.link(pivot)
    for p in [torso, head] + legs + arms:
        p.parent = pivot
    return pivot, torso, head, legs

# (rot_x_deg, hip_z_factor, torso_z, legs_z)
STANCE = {
    "stand": (0.0, 0.0, 1.0, 1.0),
    "lean": (-25.0, 0.0, 1.0, 1.0),
    "crouch": (0.0, -0.28, 0.75, 0.5),
    "sit": (18.0, 0.70, 0.55, 0.38),
    "kneel": (6.0, -0.22, 1.0, 0.18),
    "lie": (90.0, 0.22, 1.0, 0.40),
    "turn_away": (0.0, 0.0, 1.0, 1.0),
}

def dress_set(kinds):
    # figure (0.10 -> ~89 luma) must be the only outlier: every set pair
    # (wall 0.78~228 / iron+ink 0.55~196 / rain floor 0.45~179 / dry floor
    # 0.62~206) spans <=49 luma, so the 70-span figure gate stays discriminating.
    wall = grey("Wall", 0.78)
    iron = grey("SetIron", 0.55)
    ink = grey("SetInk", 0.55)
    make_ground(0.45 if "rain" in kinds else 0.62)
    cube((0, 5.2, 1.6), (8.0, 0.18, 3.2), wall)
    cube((-4.0, 0.5, 1.6), (0.18, 9.0, 3.2), wall)
    cube((4.0, 0.5, 1.6), (0.18, 9.0, 3.2), wall)
    if "door" in kinds:
        cube((-3.95, -1.2, 1.1), (0.08, 0.7, 2.1), ink)
    if "slab" in kinds:
        cube((0.0, 0.8, 0.22), (2.1, 0.85, 0.22), iron)
    if "screens" in kinds:
        for i in range(-2, 3):
            cube((i * 0.7, 5.0, 1.7), (0.28, 0.06, 0.36), ink)

def cam_forward(cam):
    mw = cam.matrix_world
    return Vector((mw[0][2], mw[1][2], mw[2][2])) * -1

def assert_look_ray(cam, look, shot_id):
    # Camera looks down local -Z. euler (88,0,0) is +Y into the north wall — matrix_world is ground truth.
    bpy.context.view_layer.update()
    o = cam.matrix_world.translation
    fwd = cam_forward(cam)
    if fwd.length < 1e-8:
        raise SystemExit("%s camera forward is zero" % shot_id)
    fwd.normalize()
    target = Vector((float(look["x"]), float(look["y"]), float(look["z"])))
    to = target - o
    ahead = to.dot(fwd)
    if ahead <= 0.05:
        raise SystemExit("%s lookAt not in front of camera (dot=%.3f); do not trust euler" % (shot_id, ahead))
    miss = (to - fwd * ahead).length
    if miss > 0.5:
        raise SystemExit("%s look ray misses lookAt by %.2fm (matrix_world, not euler)" % (shot_id, miss))

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
    assert_look_ray(cam, look, shot["id"])
    fps = 24
    frames = int(frames if frames is not None else shot["duration"] * fps)
    right = cam.matrix_world.to_3x3() @ Vector((1, 0, 0))
    right = Vector((right.x, right.y, 0))
    right.normalize()
    body = grey(shot["id"] + "_body", 0.10)
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
        yaw = math.atan2(-f.x, f.y)
        if (mark.get("stance") == "turn_away") or (mark.get("stanceEnd") == "turn_away"):
            yaw += math.pi
        pivot.rotation_euler = (0, 0, yaw)
        s0 = STANCE.get(mark.get("stance") or "stand", STANCE["stand"])
        s1 = STANCE.get(mark.get("stanceEnd"), s0) if mark.get("stanceEnd") else s0
        hold = max(1, int(0.4 * frames))
        for f_i in range(frames + 1):
            t = f_i / max(1, frames)
            k = min(1.0, f_i / hold)
            rot = s0[0] + (s1[0] - s0[0]) * k
            dz = (s0[1] + (s1[1] - s0[1]) * k) * h
            tz = s0[2] + (s1[2] - s0[2]) * k
            lz = s0[3] + (s1[3] - s0[3]) * k
            loc = p_feet + delta * t
            # |rot|>=45: tilt the whole figure (lie). Torso-only x-rot left a floating log.
            if abs(rot) >= 45.0:
                pivot.rotation_euler = (math.radians(rot), 0, yaw)
                t_rot = 0.0
            else:
                pivot.rotation_euler = (0, 0, yaw)
                t_rot = rot
            pivot.location = (loc.x, loc.y, dz)
            pivot.keyframe_insert("location", frame=frame0 + f_i)
            pivot.keyframe_insert("rotation_euler", frame=frame0 + f_i)
            for part in (torso, head):
                part.rotation_euler = (math.radians(t_rot), 0, 0)
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
        S = (pts[0] + pts[1]) / 2.0 if len(pts) > 1 else pts[0]
        o = cam.matrix_world.translation
        toward = Vector((o.x - S.x, o.y - S.y, 0))
        toward.normalize()
        S = S + toward * 0.4
        B = Vector((S.x, S.y, 0.0))
        iron = grey(shot["id"] + "_plow", 0.55)
        dx, dy, dz = B.x - A.x, B.y - A.y, B.z - A.z
        L = math.sqrt(dx * dx + dy * dy + dz * dz)
        mid = ((A.x + B.x) / 2, (A.y + B.y) / 2, (A.z + B.z) / 2)
        cube(mid, (0.06, L, 0.12), iron,
             rot=(math.atan2(dz, math.hypot(dx, dy)), 0, math.atan2(dx, dy)))
        cube((B.x + 0.03, B.y + 0.02, 0.06), (0.26, 0.34, 0.05), iron,
             rot=(0, 0, math.radians(20)))
    return frame0 + frames

CHARS = json.loads("[\n  {\n    \"id\": \"A\",\n    \"name\": \"阿月\",\n    \"heightM\": 1.05\n  },\n  {\n    \"id\": \"B\",\n    \"name\": \"阿衡\",\n    \"heightM\": 0.92\n  }\n]")
SHOTS = json.loads("[\n  {\n    \"id\": \"SH_lie\",\n    \"size\": \"medium\",\n    \"duration\": 2,\n    \"camera\": {\n      \"pos\": {\n        \"x\": 0,\n        \"y\": -3.2,\n        \"z\": 1.5\n      },\n      \"lookAt\": {\n        \"x\": 0.2,\n        \"y\": 0.4,\n        \"z\": 1\n      },\n      \"lensMm\": 50\n    },\n    \"marks\": [\n      {\n        \"start\": {\n          \"x\": 46,\n          \"y\": 68\n        },\n        \"end\": {\n          \"x\": 46,\n          \"y\": 68\n        },\n        \"facing\": 0,\n        \"handL\": {\n          \"x\": 52,\n          \"y\": 60\n        },\n        \"handR\": {\n          \"x\": 58,\n          \"y\": 60\n        },\n        \"footL\": {\n          \"x\": 43,\n          \"y\": 78\n        },\n        \"footR\": {\n          \"x\": 50,\n          \"y\": 78\n        },\n        \"gait\": \"plant\",\n        \"characterId\": \"A\",\n        \"stance\": \"lie\"\n      },\n      {\n        \"start\": {\n          \"x\": 69,\n          \"y\": 68\n        },\n        \"end\": {\n          \"x\": 69,\n          \"y\": 68\n        },\n        \"facing\": 0,\n        \"handL\": {\n          \"x\": 65,\n          \"y\": 60\n        },\n        \"handR\": {\n          \"x\": 73,\n          \"y\": 60\n        },\n        \"footL\": {\n          \"x\": 67,\n          \"y\": 78\n        },\n        \"footR\": {\n          \"x\": 73,\n          \"y\": 78\n        },\n        \"gait\": \"plant\",\n        \"characterId\": \"B\",\n        \"stance\": \"lie\"\n      }\n    ],\n    \"props\": [\n      {\n        \"name\": \"曲轅犁\",\n        \"heldBy\": \"A\",\n        \"shape\": [\n          \"弯\",\n          \"木\",\n          \"插入\"\n        ],\n        \"forbid\": [\n          \"锹\",\n          \"铲\",\n          \"锄\"\n        ]\n      }\n    ],\n    \"set\": [\n      \"room\",\n      \"slab\",\n      \"rain\"\n    ]\n  }\n]")
SHOT_ID = "SH_lie"

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
    dress_set(shot.get("set") or ["room"])
    bpy.ops.object.light_add(type='AREA', location=(2, -2, 4))
    bpy.context.active_object.data.energy = 250
    bpy.context.active_object.data.size = 3

    build_shot(shot, 1, frames)
    bpy.context.scene.camera = bpy.data.objects[shot["id"] + "_Camera"]

    scene = bpy.context.scene
    scene.frame_start = 1
    scene.frame_end = frames
    scene.render.engine = "BLENDER_WORKBENCH"
    # 5.x defaults the view transform to AgX, which compresses the material
    # greys (figure-vs-floor span ~30 luma) below the figure gate's calibrated
    # 70; Standard renders the authored greys deterministically across hosts.
    scene.view_settings.view_transform = "Standard"
    # FLAT: STUDIO lighting flattens figure-vs-floor contrast to ~9 luma, which
    # cannot pass the YMAX-YMIN>=40 figure gate; FLAT renders pure material greys
    scene.display.shading.light = "FLAT"
    scene.display.shading.color_type = "MATERIAL"
    scene.render.fps = fps
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = out_dir + "/frame_"
    # sequential frame_0001… — do not set frame_step (skip numbers break ffmpeg %04d)
    bpy.ops.render.render(animation=True)
    print("SlateCrew blockout rendered:", SHOT_ID, frames, "frames ->", out_dir)


# Fixture import only: main is deliberately not invoked.
