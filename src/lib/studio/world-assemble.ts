import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { runCommand } from "./audio";
import { chatJsonSeat, type CrewConfig } from "./crew-llm";
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
  /** 刀4（0929 world-direct compiler）：採納創作層揀嘅 World Studio project
   *  （prj_*）——per-job worldBinding 嘅唯一來源（唔經全局 config 人手填）。
   *  冇＝named missing，全片行本地鏈。 */
  worldProjectId?: string;
};

export function planStoryWorld(
  pieces: WorldPiece[],
  shots: { id: string; lensMm: number; size: string; location?: string; heldPropId?: string; castId?: string; envAnim?: import("./types").EnvAnimTrack[] }[],
): WorldPlan {
  const scaled = resolveScales(pieces);
  // A world that lost every piece to a missing size is not a success. Fail
  // with the exact missing items instead of writing an empty story.blend.
  if ("missing" in scaled) {
    throw new Error(`world_scale_missing: ${scaled.missing.join("；")}。要一條有來源嘅尺寸（metric 實測或 art_direction 場景單位比例）先入世界。`);
  }
  const ok = scaled.ok;
  const sizedIds = new Set(ok.map((row) => row.id));
  const kept = pieces.filter((piece) => sizedIds.has(piece.id));
  const placed = placeWorld(kept, ok);
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
  shots: { id: string; lensMm: number; size: string; location?: string; heldPropId?: string; castId?: string; envAnim?: import("./types").EnvAnimTrack[] }[];
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

// 世界米數（g41）：fatal 閘 world_scale_missing 嘅合法載體係 world/sizes.json。
// boards seat 唔做呢件事（charter：brief 冇寫尺寸唔准估）——估唔係佢職責，
// art_direction 決定先係。所以缺席時由 art seat（阿釉）出：每件 named piece
// 一條 sizeM＋source 口徑。已有檔（手補／上輪 resume）＝原封唔掂，尊重上游。
const SIZES_CHARTER = `你是美術指導（阿釉）。世界米數＝art_direction 決定，唔係估：每件 named piece 定一條 sizeM（米，正實數）同 source（口徑一句，講得出口：產品規格／行業標準／角色設定）。
- 角色：寫真人身高。heightM 只係 blockout 人偶比例，唔係身高——只供體型參考（0.95 前後＝普通身形）。
- 道具：寫實物尺寸（例：一支 500ml 蒸餾水高約 0.22m）。
- 場景件（桌面等）：寫標準規格。
- id 一字唔改照抄輸入清單嘅名（中文件名照抄中文）——下游 by-id 對數，改咗名＝對唔上。
- 冇口徑嘅條目唔准出；sizeM 唔可以係 0 或負；每件恰好一條；唔好發明清單以外嘅件。
只輸出 JSON。`;

const sizesSchema = z.object({
  sizes: z
    .array(
      z.object({
        id: z.string().min(1),
        sizeM: z.number().positive().max(30),
        source: z.string().min(4),
      }),
    )
    .min(1),
});

export async function ensureWorldSizes(opts: {
  dir: string;
  brief: string;
  characters: { id: string; name: string; heightM?: number }[];
  props: { name: string; heldBy?: string }[];
  locations: string[];
  io: { crew: CrewConfig; model: string; receiptDir: string; fallbackModel?: string };
}): Promise<{ wrote: boolean; count: number }> {
  const file = path.join(opts.dir, "sizes.json");
  if (fs.existsSync(file)) {
    const existing = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    return { wrote: false, count: Object.keys(existing).length };
  }
  fs.mkdirSync(opts.dir, { recursive: true });
  // id 閉集：LLM 好興自作聰明改件名（prop_bottle）——下游 by-id 對數，
  // 改咗名＝條目廢。schema refine 擋 + charter 明示照抄。
  const validIds = new Set([
    ...opts.characters.map((c) => c.id),
    ...opts.props.map((p) => p.name),
    ...opts.locations,
  ]);
  const schema = sizesSchema.refine((v) => v.sizes.every((r) => validIds.has(r.id)), {
    message: `id 必須一字唔改出自清單：${[...validIds].join("、")}`,
  });
  const pass = await chatJsonSeat({
    seat: "art",
    unit: "world-sizes",
    model: opts.io.model,
    crew: opts.io.crew,
    receiptDir: opts.io.receiptDir,
    ...(opts.io.fallbackModel ? { fallbackModel: opts.io.fallbackModel } : {}),
    system: SIZES_CHARTER,
    user: JSON.stringify({
      brief: opts.brief,
      characters: opts.characters,
      props: opts.props,
      locations: opts.locations,
      id規則: `sizes[].id 只可以係呢啲：${[...validIds].join("、")}`,
    }),
    schema,
  });
  const record: Record<string, { sizeM: number; source: string }> = {};
  for (const row of pass.value.sizes) record[row.id] = { sizeM: row.sizeM, source: row.source };
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
  return { wrote: true, count: Object.keys(record).length };
}
