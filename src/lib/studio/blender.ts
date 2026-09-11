import type { CallSheet } from "./types";

export function blenderBlockingScript(sheet: CallSheet) {
  const chars = JSON.stringify(
    sheet.characters.map((c) => ({ id: c.id, name: c.name, color: c.palette[0] })),
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
    })),
    null,
    2,
  );
  return `# SlateCrew layout agent — Blender 4.x
# Fast blocking: scene marks, camera, humanoid IK (hands + feet).
# blender -b -P blocking.py
import json, math
import bpy
from mathutils import Vector

CHARS = json.loads(${JSON.stringify(chars)})
SHOTS = json.loads(${JSON.stringify(shots)})
TITLE = ${JSON.stringify(sheet.title)}

def clear():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)

def make_ground():
    bpy.ops.mesh.primitive_plane_add(size=16, location=(0, 0, 0))
    ground = bpy.context.active_object
    ground.name = "Floor"
    mat = bpy.data.materials.new("WetFloor")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = (0.07, 0.08, 0.09, 1)
        bsdf.inputs["Roughness"].default_value = 0.18
    ground.data.materials.append(mat)

def hex_color(h):
    h = h.lstrip("#")
    r, g, b = tuple(int(h[i:i+2], 16)/255.0 for i in (0, 2, 4))
    return (r, g, b, 1)

def add_mark(name, x, y, color, z=0.02):
    bpy.ops.mesh.primitive_cylinder_add(radius=0.18, depth=0.04, location=(x * 0.12, y * 0.12, z))
    obj = bpy.context.active_object
    obj.name = name
    mat = bpy.data.materials.new(name + "Mat")
    mat.diffuse_color = hex_color(color)
    obj.data.materials.append(mat)
    return obj

def make_rig(name, color):
    bpy.ops.object.armature_add(enter_editmode=True, location=(0, 0, 1.0))
    arm = bpy.context.active_object
    arm.name = name
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm.data.edit_bones
    root = eb[0]
    root.name = "hips"
    root.head, root.tail = (0, 0, 1.0), (0, 0, 1.15)
    def bone(n, parent, head, tail):
        b = eb.new(n)
        b.head, b.tail = head, tail
        b.parent = parent
        return b
    spine = bone("spine", root, (0,0,1.15), (0,0,1.45))
    chest = bone("chest", spine, (0,0,1.45), (0,0,1.7))
    bone("head", chest, (0,0,1.7), (0,0,1.95))
    for side, sx in (("L", 1), ("R", -1)):
        clav = bone(f"clav_{side}", chest, (0,0,1.68), (0.12*sx,0,1.68))
        ua = bone(f"upper_arm_{side}", clav, (0.12*sx,0,1.68), (0.38*sx,0,1.42))
        fa = bone(f"forearm_{side}", ua, (0.38*sx,0,1.42), (0.55*sx,0,1.18))
        bone(f"hand_{side}", fa, (0.55*sx,0,1.18), (0.68*sx,0,1.12))
        th = bone(f"thigh_{side}", root, (0.08*sx,0,1.0), (0.10*sx,0,0.55))
        sh = bone(f"shin_{side}", th, (0.10*sx,0,0.55), (0.10*sx,0,0.12))
        bone(f"foot_{side}", sh, (0.10*sx,0,0.12), (0.10*sx,0.18,0.04))
    bpy.ops.object.mode_set(mode='POSE')
    for side in ("L", "R"):
        for chain, bone_name, length in (("HAND", f"forearm_{side}", 2), ("FOOT", f"shin_{side}", 2)):
            pb = arm.pose.bones[bone_name]
            ik = pb.constraints.new("IK")
            ik.chain_count = length
            empty = bpy.data.objects.new(f"{name}_{chain}_{side}", None)
            empty.empty_display_size = 0.12
            empty.empty_display_type = "SPHERE"
            bpy.context.collection.objects.link(empty)
            ik.target = empty
    bpy.ops.object.mode_set(mode='OBJECT')
    return arm

def key_empty(obj, frame, loc):
    obj.location = loc
    obj.keyframe_insert("location", frame=frame)

def build_shot(shot, frame0):
    cam_data = bpy.data.cameras.new(shot["id"] + "_cam")
    cam_data.lens = shot["camera"]["lensMm"]
    cam = bpy.data.objects.new(shot["id"] + "_Camera", cam_data)
    bpy.context.collection.objects.link(cam)
    p = shot["camera"]["pos"]
    look = shot["camera"]["lookAt"]
    cam.location = (p["x"], p["y"], p["z"])
    direction = Vector((look["x"]-p["x"], look["y"]-p["y"], look["z"]-p["z"]))
    cam.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
    fps = 24
    frames = int(shot["duration"] * fps)
    for mark in shot["marks"]:
        ch = next((c for c in CHARS if c["id"] == mark["characterId"]), {"name": mark["characterId"], "color": "#e2b15c"})
        add_mark(f"{shot['id']}_{ch['name']}_start", mark["start"]["x"], mark["start"]["y"], ch["color"])
        add_mark(f"{shot['id']}_{ch['name']}_end", mark["end"]["x"], mark["end"]["y"], ch["color"])
        rig = make_rig(f"{shot['id']}_{ch['name']}", ch["color"])
        for side, hand, foot in (("L", mark["handL"], mark["footL"]), ("R", mark["handR"], mark["footR"])):
            hand_empty = bpy.data.objects.get(f"{rig.name}_HAND_{side}")
            foot_empty = bpy.data.objects.get(f"{rig.name}_FOOT_{side}")
            gait = mark["gait"]
            for f in range(frames + 1):
                t = f / max(1, frames)
                sx = mark["start"]["x"] * 0.12
                sy = mark["start"]["y"] * 0.12
                ex = mark["end"]["x"] * 0.12
                ey = mark["end"]["y"] * 0.12
                x = sx + (ex - sx) * t
                y = sy + (ey - sy) * t
                stride = math.sin(t * math.pi * 2) * (0.22 if gait == "walk" else 0.0)
                if foot_empty:
                    key_empty(foot_empty, frame0 + f, Vector((
                        foot["x"] * 0.12 + (x - sx) + (stride if side == "L" else -stride),
                        foot["y"] * 0.12 + (y - sy),
                        0.04 if gait != "walk" or abs(math.sin(t * math.pi * 2)) > 0.15 else 0.12
                    )))
                if hand_empty:
                    reach = t if gait == "reach" else 0.2
                    key_empty(hand_empty, frame0 + f, Vector((
                        hand["x"] * 0.12 * (0.4 + 0.6 * reach) + x,
                        hand["y"] * 0.12 + y,
                        1.12 + (0.15 if gait == "reach" else 0.0)
                    )))
    return frame0 + frames

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
