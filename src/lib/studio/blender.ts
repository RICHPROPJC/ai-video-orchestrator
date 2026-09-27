import type { CallSheet, Shot } from "./types";

/** Exterior wins ties (野外射擊場 has 場/堂-adjacent noise): a doorway is outside,
 *  and unknown locations default exterior so no shot ever grows walls by accident. */
const EXTERIOR_HINTS = ["野外", "戶外", "室外", "門口", "街", "路", "廣場", "操場", "海", "山", "天台", "庭園", "空地", "岸", "橋"];
const INTERIOR_HINTS = ["室", "宿舍", "禮堂", "公寓", "中心", "廳", "館", "樓", "院", "倉", "庫", "店", "房", "教室", "辦公", "指揮", "走廊", "電梯", "醫院", "酒吧", "餐廳", "廚房"];

export function isInteriorShot(shot: Shot): boolean {
  const loc = shot.location;
  if (EXTERIOR_HINTS.some((h) => loc.includes(h))) return false;
  return INTERIOR_HINTS.some((h) => loc.includes(h));
}

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
      envAnim: s.envAnim ?? [],
      interior: isInteriorShot(s),
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

# T34 interior shell: three walls + ceiling, camera-relative so every lens sees
# them; reads the camera, never moves it. Measured WORKBENCH-FLAT greys: void bg
# ~64, figure 0.40 ~170, floor 0.62 ~207 — walls 0.95 (~248) keep every mark crop
# at span >=78 (brighter than the old floor-only span), ceiling 0.30 (~140) is
# apart from void/floor/wall, so the ceiling line reads as a hard step.
def make_room(cam):
    o = cam.matrix_world.translation
    fwd = cam.matrix_world.to_3x3() @ Vector((0, 0, -1))
    f = Vector((fwd.x, fwd.y, 0))
    if f.length < 1e-6:
        f = Vector((0, 1, 0))
    else:
        f.normalize()
    r3 = cam.matrix_world.to_3x3() @ Vector((1, 0, 0))
    r = Vector((r3.x, r3.y, 0))
    if r.length < 1e-6:
        r = Vector((f.y, -f.x, 0))
    r.normalize()
    back_d = 14.0
    hw = math.tan(cam.data.angle_x / 2.0) * back_d  # frustum half-width at back wall
    side = max(1.2, hw * 0.55)
    wall_h = 3.2
    wall_mat = grey("Wall", 0.95)
    ceil_mat = grey("Ceiling", 0.30)
    mid = o + f * (back_d / 2.0)
    back = o + f * back_d
    # cube(scale) is FULL size per local axis; rot z picks the long axis:
    # yaw_f -> local X runs along forward (depth), yaw_r -> along camera-right.
    yaw_f = math.atan2(f.y, f.x)
    yaw_r = math.atan2(r.y, r.x)
    # back wall + ceiling span hw + 1 so no void sliver shows past their far edges
    cube((back.x, back.y, wall_h / 2.0), (2.0 * (hw + 1.0), 0.2, wall_h), wall_mat, rot=(0, 0, yaw_r))
    for s in (-1.0, 1.0):
        c = mid + r * (s * side)
        cube((c.x, c.y, wall_h / 2.0), (back_d + 2.0, 0.2, wall_h), wall_mat, rot=(0, 0, yaw_f))
    cube((mid.x, mid.y, wall_h), (2.0 * (hw + 1.0), back_d + 2.0, 0.05), ceil_mat, rot=(0, 0, yaw_r))

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

ENV_CACHE = {}

def ensure_env():
    # 環境動畫件（世界暫停前後動作嘅幾何載體）：冪等建立，全片共用——
    # 時鐘指針掛後牆（pivot empty 繞鐘面中心轉）、窗光條、盒疊。
    # WORKBENCH FLAT render 睇唔到光源變化，所以全部係幾何件。
    if ENV_CACHE:
        return ENV_CACHE
    # 時鐘：後牆圓面＋指針（empty pivot 喺鐘面中心，mesh 半長偏移）
    face = grey("env_clock_face", 0.92)
    bpy.ops.mesh.primitive_cylinder_add(radius=0.22, depth=0.02,
        location=(-2.2, -3.55, 2.05), rotation=(math.radians(90), 0, 0))
    clock_face = bpy.context.active_object
    clock_face.data.materials.append(face)
    pivot = bpy.data.objects.new("env_clock_hand", None)
    pivot.location = (-2.2, -3.53, 2.05)
    bpy.context.collection.objects.link(pivot)
    hand = grey("env_clock_hand", 0.05)
    bpy.ops.mesh.primitive_cube_add(location=(-2.2, -3.53, 2.05 + 0.085))
    hand_mesh = bpy.context.active_object
    hand_mesh.scale = (0.014, 0.012, 0.085)
    hand_mesh.data.materials.append(hand)
    hand_mesh.parent = pivot
    ENV_CACHE["clock_hand"] = pivot
    # 窗光條：後牆高處薄條（pos_z 掃＝日光移動）
    bar = grey("env_window_bar", 0.99)
    bpy.ops.mesh.primitive_cube_add(location=(-0.6, -3.55, 2.4))
    bar_obj = bpy.context.active_object
    bar_obj.scale = (0.9, 0.02, 0.16)
    bar_obj.data.materials.append(bar)
    ENV_CACHE["window_bar"] = bar_obj
    # 盒疊：檯角一疊（scale_z／pos_z 增長＝嘢越疊越高）
    box = grey("env_stack_box", 0.30)
    bpy.ops.mesh.primitive_cube_add(location=(1.6, -3.2, 0.14))
    box_obj = bpy.context.active_object
    box_obj.scale = (0.16, 0.16, 0.14)
    box_obj.data.materials.append(box)
    ENV_CACHE["stack_box"] = box_obj
    return ENV_CACHE

def fcurves_of(obj):
    # Blender 4.x legacy（action.fcurves）＋5.x slotted actions（layers/strips/
    # channelbags）兩條路都行——headless 5.1 實證 legacy attribute 已空。
    ad = obj.animation_data
    if not ad or not ad.action:
        return []
    a = ad.action
    legacy = getattr(a, "fcurves", None)
    if legacy is not None and len(legacy) > 0:
        return list(legacy)
    out = []
    try:
        for layer in a.layers:
            for strip in layer.strips:
                for bag in strip.channelbags:
                    out.extend(bag.fcurves)
    except Exception:
        pass
    return out

def apply_env_anim(shot, frame0):
    # keys 相對本鏡 f0；跨鏡同一 object 連續 keyframe（時鐘全片一路走）
    for tr in (shot.get("envAnim") or []):
        env = ensure_env()
        obj = env.get(tr["object"])
        if obj is None:
            raise SystemExit("unknown envAnim object: " + str(tr.get("object")))
        for pair in tr.get("keys") or []:
            fr, val = pair[0], pair[1]
            f = frame0 + int(fr)
            ch = tr.get("channel")
            if ch == "rotate_z":
                obj.rotation_euler = (obj.rotation_euler.x, obj.rotation_euler.y, math.radians(val))
                obj.keyframe_insert("rotation_euler", frame=f)
            elif ch == "pos_z":
                obj.location = (obj.location.x, obj.location.y, val)
                obj.keyframe_insert("location", frame=f)
            elif ch == "scale_z":
                obj.scale = (obj.scale.x, obj.scale.y, val)
                obj.keyframe_insert("scale", frame=f)
            else:
                raise SystemExit("unknown envAnim channel: " + str(ch))
        if tr.get("interp") == "step":
            for fc in fcurves_of(obj):
                for kp in fc.keyframe_points:
                    kp.interpolation = 'CONSTANT'

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
    apply_env_anim(shot, frame0)
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
    # （犁道具特設幾何已拆——0927 Chau 令：項目道具唔寫死喺 layout script，
    #  道具幾何由 props 資料/SF3D mesh 行，呢度淨做走位人偶。）
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
    cam = bpy.data.objects[shot["id"] + "_Camera"]
    bpy.context.scene.camera = cam
    if shot.get("interior"):
        bpy.context.view_layer.update()
        make_room(cam)

    scene = bpy.context.scene
    scene.frame_start = 1
    scene.frame_end = frames
    scene.render.engine = "BLENDER_WORKBENCH"
    # FLAT: STUDIO lighting flattens figure-vs-floor contrast to ~9 luma, which
    # cannot pass the YMAX-YMIN>=40 figure gate; FLAT renders pure material greys
    scene.display.shading.light = "FLAT"
    scene.display.shading.color_type = "MATERIAL"
    # Blender 4/5 default view transform (AgX) compresses the material greys
    # (wall 0.95 -> ~194, figure -> ~159) and breaks every luma gate calibrated on
    # 3.0's Standard; pin Standard so the measured greys above hold on 5.1.2.
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
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
