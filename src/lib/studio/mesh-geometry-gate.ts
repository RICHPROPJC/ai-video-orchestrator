import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import sharp from "sharp";

/** Geometry acceptance gate — the permanent law from the 0919 cu_seqlens blob
 *  case: mechanical gates (exit/size/verts) were all fooled by melt blobs, so
 *  every mesher output must pass BOTH:
 *    1. geometry metric — solidity (volume / convex-hull volume, trimesh
 *       definition) in a class band + thinness (min/max bbox extent)
 *    2. render preview — a real Blender WORKBENCH render of the imported mesh,
 *       mechanically checked for luma span and kept for human audit
 *
 *  Anchors (ASSET_SF3D_V100_0918): hero figure 0.583 (Tripo human class 0.564),
 *  chair 0.298, axe 0.399. Blob-class lumps score high solidity (quasi-convex
 *  melt); spiky latent garbage scores near zero with a huge hull. */

export const BLENDER_51 = "/home/c/applications/blender-5.1.2-linux-x64/blender";
export const BLENDER_51_VERSION = "Blender 5.1.2";

export type MeshClass = "figure" | "prop";

export const SOLIDITY_BANDS: Record<MeshClass, readonly [number, number]> = {
  figure: [0.35, 0.8],
  prop: [0.08, 0.75],
};
export const THINNESS_MIN = 0.04;
export const PREVIEW_LUMA_SPAN_MIN = 40;
export const PREVIEW_PX = 320;

export type GateMetrics = {
  source_sha256: string;
  vertices: number;
  originalDimensions: number[];
  dimensionsM: number[];
  axisCorrectionDegX: number;
  targetHeightM: number;
  heightCalibrated: boolean;
  volumeM3: number;
  hullVolumeM3: number;
  solidity: number;
  thinness: number;
  preview: string;
  blender: string;
};

export type GateCheck = { name: string; pass: boolean; detail: string };

export type GateVerdict = {
  ok: boolean;
  metrics: GateMetrics;
  checks: GateCheck[];
};

/** Blender 5.1.2 headless script. Port of the astra object.import_mesh math
 *  (SETTLE_SF3D_BLENDER_U15_0918): glTF import, Z-up restore, height
 *  calibration to the metre contract, then hull/volume metrics and a front-view
 *  WORKBENCH preview.
 *
 *  mesh_front.glb is canonical (up=+Z, front=-Y by canonicalize_glb.py v2), so
 *  the glTF Y-up import conversion is undone unconditionally with -90°X —
 *  deterministic, not the astra Y-dominates heuristic (which mis-stands flat
 *  canonical props). */
export function blenderGateScript(): string {
  return `# SlateCrew SF3D geometry gate — Blender 5.1.2 headless.
# blender -b -P gate.py -- --glb mesh_front.glb --out DIR --height 1.7 --px 320
import bpy, bmesh, json, math, sys, hashlib
from mathutils import Matrix, Vector
from pathlib import Path

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
def arg(name, default):
    return argv[argv.index(name) + 1] if name in argv else default
GLB = Path(arg("--glb", "")).resolve()
OUT = Path(arg("--out", "")).resolve()
TARGET_H = float(arg("--height", "1.7"))
PX = int(arg("--px", "${PREVIEW_PX}"))

def bounds(objects):
    points = [obj.matrix_world @ v.co for obj in objects for v in obj.data.vertices]
    if not points or any(not math.isfinite(n) for p in points for n in p):
        raise SystemExit("empty or nonfinite geometry")
    lo = Vector(tuple(min(p[i] for p in points) for i in range(3)))
    hi = Vector(tuple(max(p[i] for p in points) for i in range(3)))
    return lo, hi

bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete()
if abs(bpy.context.scene.unit_settings.scale_length - 1.0) > 1e-6:
    raise SystemExit("unit scale_length != 1")

before = set(bpy.data.objects)
bpy.ops.import_scene.gltf(filepath=str(GLB))
imported = set(bpy.data.objects) - before
meshes = sorted((o for o in imported if o.type == "MESH"), key=lambda o: o.name)
if not meshes:
    raise SystemExit("no meshes imported")
if any(o.type == "ARMATURE" for o in imported) or any(o.modifiers for o in meshes):
    raise SystemExit("rigged/modifier asset — the gate takes static shells")
bpy.context.view_layer.update()
lo, hi = bounds(meshes)
original_dimensions = list(hi - lo)
correction_degrees = -90  # canonical mesh_front.glb: undo glTF Y-up conversion
rotation = Matrix.Rotation(math.radians(correction_degrees), 4, "X")
matrices = {o: rotation @ o.matrix_world.copy() for o in meshes}
for o in meshes:
    o.parent = None
    o.matrix_world = matrices[o]
bpy.context.view_layer.update()
lo, hi = bounds(meshes)
height = hi.z - lo.z
if height <= 1e-8:
    raise SystemExit("zero Z height")
factor = TARGET_H / height
offset = Vector((-(lo.x + hi.x) / 2, -(lo.y + hi.y) / 2, -lo.z))
normalize = Matrix.Scale(factor, 4) @ Matrix.Translation(offset)
for o in meshes:
    o.matrix_world = normalize @ o.matrix_world
bpy.context.view_layer.update()
bpy.ops.object.select_all(action="DESELECT")
for o in meshes:
    o.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
if len(meshes) > 1:
    bpy.ops.object.join()
obj = bpy.context.view_layer.objects.active
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
obj.name = "Sf3dGate"
lo, hi = bounds([obj])
dimensions = list(hi - lo)
if abs(dimensions[2] - TARGET_H) > max(1e-5, TARGET_H * 1e-5):
    raise SystemExit("metre contract failed: %s vs %s" % (dimensions[2], TARGET_H))

me = obj.data
bm = bmesh.new()
bm.from_mesh(me)
volume = abs(bm.calc_volume(signed=True))
verts = len(bm.verts)
bm.free()

hb = bmesh.new()
for v in me.vertices:
    hb.verts.new(v.co)
hb.verts.ensure_lookup_table()
bmesh.ops.convex_hull(hb, input=hb.verts[:], use_existing_faces=False)
hull_volume = abs(hb.calc_volume(signed=True))
hull_faces = len(hb.faces)
hb.free()

solidity = volume / hull_volume if hull_volume > 1e-12 else 0.0
thinness = min(dimensions) / max(dimensions) if max(dimensions) > 1e-9 else 0.0

receipt = {
  "source_sha256": hashlib.sha256(GLB.read_bytes()).hexdigest(),
  "vertices": verts,
  "originalDimensions": original_dimensions,
  "dimensionsM": dimensions,
  "axisCorrectionDegX": correction_degrees,
  "targetHeightM": TARGET_H,
  "heightCalibrated": True,
  "volumeM3": volume,
  "hullVolumeM3": hull_volume,
  "hullFaces": hull_faces,
  "solidity": solidity,
  "thinness": thinness,
  "preview": str(OUT / "preview.png"),
  "blender": bpy.app.version_string,
}
# metrics land on disk BEFORE the render — a render crash still leaves evidence
(OUT / "gate_receipt.json").write_text(json.dumps(receipt, indent=2))

center = (lo + hi) / 2
radius = max(dimensions) / 2
scene = bpy.context.scene
cam_data = bpy.data.cameras.new("GateCam")
cam_data.lens = 50
cam = bpy.data.objects.new("GateCam", cam_data)
bpy.context.collection.objects.link(cam)
dist = (radius / math.tan(math.radians(19.8))) * 1.25 + 0.1
cam.location = (center.x, center.y - dist, center.z)  # front view: -Y toward +Y
cam.rotation_euler = Vector((0, 1, 0)).to_track_quat("-Z", "Y").to_euler()
scene.camera = cam
# CYCLES CPU: WORKBENCH needs the GPU rasterizer, which SIGSEGVs on this box
# while GPU2 is near-full (same class as the settle DIAG#2 EEVEE crash). The
# gate must never depend on GPU state, never mind grab one.
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = 16
world = bpy.data.worlds.new("GateWorld")
world.use_nodes = False
world.color = (0.35, 0.35, 0.35)
scene.world = world
scene.render.resolution_x = PX
scene.render.resolution_y = PX
scene.render.image_settings.file_format = "PNG"
scene.render.filepath = str(OUT / "preview.png")
bpy.ops.render.render(write_still=True)
print("SF3D_GATE_OK", json.dumps(receipt))
`;
}

/** Pure band verdict — unit-testable without Blender. */
export function meshGeometryVerdict(
  metrics: { solidity: number; thinness: number; previewLumaSpan: number; previewStdev: number },
  meshClass: MeshClass,
): GateCheck[] {
  const [lo, hi] = SOLIDITY_BANDS[meshClass];
  const spanOk = metrics.previewLumaSpan >= PREVIEW_LUMA_SPAN_MIN && metrics.previewStdev >= 3;
  return [
    {
      name: "solidity",
      pass: metrics.solidity >= lo && metrics.solidity <= hi,
      detail: `${metrics.solidity.toFixed(3)} in [${lo}, ${hi}] (${meshClass}; anchors hero 0.583 / chair 0.298)`,
    },
    {
      name: "thinness",
      pass: metrics.thinness >= THINNESS_MIN,
      detail: `${metrics.thinness.toFixed(3)} >= ${THINNESS_MIN} (min/max extent; pancake fails)`,
    },
    {
      name: "preview",
      pass: spanOk,
      detail: `luma span ${metrics.previewLumaSpan.toFixed(0)} (>= ${PREVIEW_LUMA_SPAN_MIN}), stdev ${metrics.previewStdev.toFixed(1)}`,
    },
  ];
}

async function previewLuma(png: string): Promise<{ span: number; stdev: number }> {
  const stats = await sharp(png).greyscale().stats();
  const ch = stats.channels[0];
  if (!ch) throw new Error(`${png}: no channel stats`);
  return { span: ch.max - ch.min, stdev: ch.stdev };
}

function exec(bin: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => { stdout += String(d); });
    child.stderr.on("data", (d) => { stderr += String(d); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
  });
}

/** Runs Blender 5.1.2 (only 5.1.2 — the card law) headless on the canonical
 *  mesh, then applies the two-gate verdict. Never grabs GPU: the render is
 *  CPU WORKBENCH with CUDA_VISIBLE_DEVICES cleared. */
export async function runMeshGeometryGate(opts: {
  glb: string;
  outDir: string;
  blenderBin?: string;
  targetHeightM?: number;
  meshClass?: MeshClass;
  timeoutMs?: number;
}): Promise<GateVerdict> {
  const blender = opts.blenderBin ?? BLENDER_51;
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const version = await exec(blender, ["-b", "--version"], process.env, 20_000);
  if (version.code !== 0 || !version.stdout.includes(BLENDER_51_VERSION)) {
    throw new Error(`${blender} is not Blender 5.1.2 (law: Blender只准5.1.2) — got: ${(version.stdout || version.stderr).split("\n")[0] ?? ""}`);
  }
  const glb = path.resolve(opts.glb);
  const outDir = path.resolve(opts.outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const script = path.join(outDir, "gate.py");
  fs.writeFileSync(script, blenderGateScript());
  const render = await exec(blender, [
    "-b", "--threads", "4", "-P", script, "--",
    "--glb", glb,
    "--out", outDir,
    "--height", String(opts.targetHeightM ?? 1.7),
    "--px", String(PREVIEW_PX),
  ], { ...process.env, CUDA_VISIBLE_DEVICES: "" }, timeoutMs);
  const receiptFile = path.join(outDir, "gate_receipt.json");
  if (render.code !== 0 || !fs.existsSync(receiptFile)) {
    throw new Error(`geometry gate blender run failed (exit ${render.code}): ${render.stderr?.slice(-2000) ?? render.stdout?.slice(-2000) ?? "no output"}`);
  }
  const metrics = JSON.parse(fs.readFileSync(receiptFile, "utf8")) as GateMetrics;
  let luma: { span: number; stdev: number };
  try {
    luma = await previewLuma(metrics.preview);
  } catch {
    // metrics survived (written pre-render) but the render crashed / preview absent
    luma = { span: 0, stdev: 0 };
  }
  const checks = meshGeometryVerdict(
    { solidity: metrics.solidity, thinness: metrics.thinness, previewLumaSpan: luma.span, previewStdev: luma.stdev },
    opts.meshClass ?? "figure",
  );
  const verdict: GateVerdict = { ok: checks.every((c) => c.pass), metrics, checks };
  fs.writeFileSync(
    path.join(outDir, "gate-verdict.json"),
    JSON.stringify({ ...verdict, previewLuma: luma, ts: new Date().toISOString() }, null, 2) + "\n",
  );
  return verdict;
}
