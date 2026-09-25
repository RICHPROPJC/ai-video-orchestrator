import fs from "node:fs";
import path from "node:path";
import { runCommand } from "./audio";
import {
  aimShot,
  placeWorld,
  resolveScales,
  type PlacedPiece,
  type ShotAim,
  type WorldPiece,
} from "./world-scale";

export type WorldPlan = {
  pieces: PlacedPiece[];
  shots: ShotAim[];
};

export function planStoryWorld(
  pieces: WorldPiece[],
  shots: { id: string; lensMm: number; size: string; location?: string; heldPropId?: string }[],
): WorldPlan {
  const scaled = resolveScales(pieces);
  if ("missing" in scaled) {
    throw new Error(`scale_missing: ${scaled.missing.join("；")}。要一條尺寸或者一句已確認比例，唔好用兩米盒。`);
  }
  const placed = placeWorld(pieces, scaled.ok);
  return { pieces: placed, shots: shots.map((shot) => aimShot(shot, placed)) };
}

export function worldScript(plan: WorldPlan, blendOut: string): string {
  const payload = JSON.stringify(plan).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return `import bpy, json, os
from mathutils import Vector
PLAN = json.loads('${payload}')
bpy.ops.wm.read_factory_settings(use_empty=True)

def world_pts(objs):
    pts = []
    for o in objs:
        if o.type != 'MESH':
            continue
        for c in o.bound_box:
            pts.append(o.matrix_world @ Vector(c))
    return pts

def fit(objs, meters):
    bpy.context.view_layer.update()
    pts = world_pts([o for o in objs if o.type == 'MESH'])
    if not pts or meters <= 0:
        raise SystemExit('SCALE_MISSING')
    span = max(p.z for p in pts) - min(p.z for p in pts)
    if span < 1e-4:
        raise SystemExit('SCALE_MISSING')
    factor = meters / span
    for o in objs:
        o.scale = (o.scale.x * factor, o.scale.y * factor, o.scale.z * factor)
    bpy.context.view_layer.update()

def park(objs, x, y, z, top=False):
    bpy.context.view_layer.update()
    meshes = [o for o in objs if o.type == 'MESH']
    pts = world_pts(meshes)
    if not pts:
        return
    cx = (min(p.x for p in pts) + max(p.x for p in pts)) / 2.0
    cy = (min(p.y for p in pts) + max(p.y for p in pts)) / 2.0
    anchor = max(p.z for p in pts) if top else min(p.z for p in pts)
    for o in objs:
        o.location.x += x - cx
        o.location.y += y - cy
        o.location.z += z - anchor
    bpy.context.view_layer.update()

for piece in PLAN['pieces']:
    before = set(o.name for o in bpy.context.scene.objects)
    bpy.ops.import_scene.gltf(filepath=piece['glb'])
    news = [o for o in bpy.context.scene.objects if o.name not in before]
    for o in news:
        o['world_id'] = piece['id']
    fit(news, piece['meters'])
    park(news, piece['x'], piece['y'], piece['z'], top=False)
os.makedirs(os.path.dirname(${JSON.stringify(blendOut)}), exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(blendOut)})
print('WORLD_SAVED')
`;
}

export async function writeStoryWorld(opts: {
  dir: string;
  pieces: WorldPiece[];
  shots: { id: string; lensMm: number; size: string; location?: string; heldPropId?: string }[];
  blenderBin?: string;
  runCmd?: typeof runCommand;
}): Promise<WorldPlan> {
  const plan = planStoryWorld(opts.pieces, opts.shots);
  fs.mkdirSync(opts.dir, { recursive: true });
  const jsonPath = path.join(opts.dir, "assemble.json");
  const blendPath = path.join(opts.dir, "story.blend");
  fs.writeFileSync(jsonPath, JSON.stringify(plan, null, 2) + "\n");
  const script = worldScript(plan, blendPath);
  const scriptPath = path.join(opts.dir, "assemble.blender.py");
  fs.writeFileSync(scriptPath, script);
  const run = opts.runCmd ?? runCommand;
  const blender = opts.blenderBin || process.env.BLENDER_BIN || "blender";
  const result = await run(blender, ["-b", "--factory-startup", "-P", scriptPath], opts.dir, {
    DISPLAY: undefined,
    WAYLAND_DISPLAY: undefined,
  });
  if (result.code !== 0 || !/WORLD_SAVED/.test(result.stdout)) {
    throw new Error(`world assemble failed: ${(result.stderr || result.stdout).slice(-400)}`);
  }
  return plan;
}
