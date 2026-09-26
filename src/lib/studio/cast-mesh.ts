import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { runCommand } from "./audio";
import { rembgCell } from "./asset-board";
import { assertMeshPlate, sf3dGenerate } from "./mesh-provider";

function meshDirName(castItemDir: string, n: number): string {
  return n === 1 ? path.join(castItemDir, "sf3d") : path.join(castItemDir, `sf3d-${n}`);
}

/** A finished mesh is reused. A directory left by a failed generate is not:
 *  the provider refuses to write into an existing out_dir, so the next
 *  attempt gets the next free sf3d-N. */
export function freshMeshDir(castItemDir: string): string {
  const hasMesh = (dir: string) => fs.existsSync(path.join(dir, "0", "mesh_front.glb"));
  for (let n = 1; ; n += 1) {
    const dir = meshDirName(castItemDir, n);
    if (!fs.existsSync(dir)) return dir;
    if (hasMesh(dir)) return dir;
  }
}

/** Identity miss: do not reuse a mesh that is already there. */
export function unusedMeshDir(castItemDir: string): string {
  for (let n = 1; ; n += 1) {
    const dir = meshDirName(castItemDir, n);
    if (!fs.existsSync(dir)) return dir;
  }
}

export type CastDeform = "rig" | "rigid";

function sha256File(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

type MeshReceipt = {
  status?: string;
  input?: string;
  input_sha256?: string;
  mesh_front?: string;
};

/** Reuse only when the receipt names this source, or a stored plate link does.
 *  A one-time mtime adoption writes plate.source.json when writeLink is set. */
export function reusableCanonical(opts: {
  dirs: string[];
  srcFile: string;
  writeLink?: boolean;
}): { mesh: string; rigged?: string; dir: string } | null {
  if (!fs.existsSync(opts.srcFile)) return null;
  const srcSha = sha256File(opts.srcFile);
  const srcMtime = fs.statSync(opts.srcFile).mtimeMs;
  for (const dir of opts.dirs) {
    const receiptPath = path.join(dir, "sf3d", "mesh-receipt.json");
    if (!fs.existsSync(receiptPath)) continue;
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as MeshReceipt;
    if (receipt.status !== "succeeded" || !receipt.mesh_front || !receipt.input_sha256) continue;
    if (!fs.existsSync(receipt.mesh_front)) continue;
    const linkPath = path.join(dir, "plate.source.json");
    let ok = srcSha === receipt.input_sha256;
    if (!ok && fs.existsSync(linkPath)) {
      const link = JSON.parse(fs.readFileSync(linkPath, "utf8")) as { srcSha256?: string; plateSha256?: string };
      ok = link.srcSha256 === srcSha && link.plateSha256 === receipt.input_sha256;
    }
    if (!ok && opts.writeLink && receipt.input && fs.existsSync(receipt.input)) {
      const plateSha = sha256File(receipt.input);
      if (plateSha === receipt.input_sha256 && srcMtime <= fs.statSync(receipt.input).mtimeMs) {
        fs.writeFileSync(linkPath, `${JSON.stringify({
          src: opts.srcFile,
          srcSha256: srcSha,
          plateSha256: plateSha,
          adopted: "src_mtime_not_after_receipt_input",
        }, null, 2)}\n`);
        ok = true;
      }
    }
    if (!ok) continue;
    const rigged = path.join(dir, "mesh_front_rigged.glb");
    return { mesh: receipt.mesh_front, dir, rigged: fs.existsSync(rigged) ? rigged : undefined };
  }
  return null;
}
export const SKINTOKENS_BIN = process.env.SKINTOKENS_BIN || "/home/c/skintokens_work/build-cuda/bin/skintokens-cli";
export const SKINTOKENS_MODELS =
  process.env.SKINTOKENS_MODELS || "/home/c/skintokens_work/skin-tokens.cpp/models/SkinTokens-GGUF/F16";
/** sf3d-fa2.service pins this card. The rig window uses the same card after systemctl stop. */
const SF3D_UNIT = "sf3d-fa2.service";
const GLM_OCR_UNIT = "glm-ocr.service";
const SF3D_GPU = "2";

export function assertCastConfirmed(count: number): void {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error("cast_unconfirmed: storyboard 未確認角色人數，停");
  }
}

/** The rig window stays shut until every character and prop plate exists.
 *  A location is not a building and is not a mesh plate. */
export function assertStoryPlatesReady(opts: {
  characters: { id: string; pin?: string }[];
  props: { name: string; file?: string }[];
  scenes?: { id: string; file?: string }[];
}): { id: string; file: string }[] {
  const missing: string[] = [];
  const items: { id: string; file: string }[] = [];
  const take = (label: string, id: string, file?: string) => {
    if (!file || !fs.existsSync(file)) missing.push(`${label} ${id}`);
    else items.push({ id, file });
  };
  for (const c of opts.characters) take("角色", c.id, c.pin);
  for (const p of opts.props) take("道具", p.name, p.file);
  if (missing.length > 0) {
    throw new Error(`cast_incomplete: 故事元素未齊，唔開 rig。${missing.join("；")}`);
  }
  return items;
}

/** A keyframe still has a scene. Mesh only accepts a plate that has no background. */
export function refuseKeyframePlate(file: string): void {
  const base = path.basename(file);
  const norm = file.replace(/\\/g, "/");
  if (/\/blockout\//.test(norm)) {
    throw new Error(`keyframe_not_plate: ${file} 係 Blender 圖，唔可以落 mesh`);
  }
  if (/\/stills\//.test(norm) || /\.kf-\d+\.png$/i.test(base) || /^SH\d+(?:\.kf-\d+)?\.png$/i.test(base)) {
    throw new Error(`keyframe_not_plate: ${file} 係成個 keyframe，唔可以落 mesh`);
  }
  if (/\/boards\//.test(norm) || /\.angles\.png$/i.test(base)) {
    throw new Error(`sheet_not_plate: ${file} 係未切成張，mesh 只收去背切格`);
  }
}

async function squarePlate(input: string, output: string, run: typeof runCommand): Promise<void> {
  const r = await run("ffmpeg", [
    "-y", "-i", input,
    "-vf", "scale='max(iw,ih)':'max(iw,ih)':force_original_aspect_ratio=decrease,pad=max(iw\\,ih):max(iw\\,ih):(ow-iw)/2:(oh-ih)/2:color=black@0",
    "-frames:v", "1", output,
  ]);
  if (r.code !== 0) throw new Error(`square plate failed: ${r.stderr.slice(0, 300)}`);
}

async function centerSubject(input: string, output: string): Promise<void> {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const a = data[(y * width + x) * channels + channels - 1] ?? 0;
      if (a <= 32) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) throw new Error(`plate has no subject: ${input}`);
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  const canvas = Math.ceil(Math.max(bw, bh) / 0.7);
  const left = Math.floor((canvas - bw) / 2);
  const top = Math.floor((canvas - bh) / 2);
  const tmp = `${output}.center.png`;
  await sharp(input)
    .extract({ left: minX, top: minY, width: bw, height: bh })
    .extend({
      top,
      bottom: canvas - bh - top,
      left,
      right: canvas - bw - left,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toFile(tmp);
  fs.renameSync(tmp, output);
}

async function transparentPlate(src: string, dir: string, run: typeof runCommand): Promise<string> {
  refuseKeyframePlate(src);
  const plate = path.join(dir, "plate.png");
  const linkPath = path.join(dir, "plate.source.json");
  if (fs.existsSync(plate) && fs.existsSync(linkPath)) {
    const link = JSON.parse(fs.readFileSync(linkPath, "utf8")) as { srcSha256?: string; plateSha256?: string };
    const same = link.srcSha256 === sha256File(src) && link.plateSha256 === sha256File(plate);
    if (!same) {
      fs.rmSync(plate, { force: true });
    }
  } else if (fs.existsSync(plate)) {
    fs.rmSync(plate, { force: true });
  }
  if (fs.existsSync(plate)) {
    try {
      await assertMeshPlate(plate);
      return plate;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const offCenter = message.includes("border is not transparent") || message.includes("no opaque subject");
      if (!offCenter) throw error;
      const rgba = path.join(dir, "plate.rgba.png");
      await centerSubject(fs.existsSync(rgba) ? rgba : plate, plate);
      await assertMeshPlate(plate);
      return plate;
    }
  }
  try {
    await assertMeshPlate(src);
    return src;
  } catch {
    // a flat cut can still wear a white field; rembg is the step that removes it
  }
  fs.mkdirSync(dir, { recursive: true });
  const cut = path.join(dir, "plate.rgba.png");
  await rembgCell(src, cut);
  await squarePlate(cut, plate, run);
  await assertMeshPlate(plate);
  return plate;
}

async function systemctlUser(run: typeof runCommand, verb: "stop" | "start", unit: string): Promise<void> {
  const r = await run("systemctl", ["--user", verb, unit], undefined, {
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || "/run/user/1000",
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || "unix:path=/run/user/1000/bus",
  });
  if (r.code !== 0) {
    throw new Error(`systemctl --user ${verb} ${unit}: ${(r.stderr || r.stdout).slice(-300)}`);
  }
}

/** 停完 SF3D 同 GLM-OCR 之後，GPU 2 上佢哋嘅顯存可能仲未放。未到 6GB 唔開 SkinTokens。 */
async function waitGpu2ForRig(run: typeof runCommand): Promise<void> {
  const deadline = Date.now() + 90_000;
  let last = "";
  while (Date.now() < deadline) {
    const apps = await run("nvidia-smi", [
      "--id=2", "--query-compute-apps=process_name", "--format=csv,noheader",
    ]);
    const free = await run("nvidia-smi", [
      "--id=2", "--query-gpu=memory.free", "--format=csv,noheader,nounits",
    ]);
    const names = apps.stdout;
    const freeMiB = Number(free.stdout.trim().split(/\s+/)[0]);
    const held = /sf3d|llama-server/i.test(names);
    last = `free=${free.stdout.trim() || "?"} held=${held}`;
    if (!held && freeMiB >= 6144) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`gpu2 未讓出 6GB，唔開 SkinTokens：${last}`);
}

/**
 * Storyboard has confirmed the set. Every item is a no-background plate
 * (character pin, prop, scene, terrain). Meshes are made while SF3D is up.
 * One systemctl stop, every pending rig, then systemctl start. No keyframe. No CPU.
 */
export async function ensureCastOnce(opts: {
  characters: { id: string }[];
  items: { id: string; file: string; rig?: string; deform?: CastDeform; meshAliasId?: string }[];
  meshRoot: string;
  endpoint: string;
  /** SkinTokens stops SF3D. Production leaves this off until a resource owner opens the window. */
  allowGpuHandoff?: boolean;
  runCmd?: typeof runCommand;
}): Promise<Record<string, string>> {
  assertCastConfirmed(opts.characters.length);
  const run = opts.runCmd ?? runCommand;
  const rigs: Record<string, string> = {};
  const pending: { id: string; mesh: string; rigged: string }[] = [];
  for (const item of opts.items) {
    const dir = path.join(opts.meshRoot, item.id);
    const deform = item.deform ?? "rig";
    const dirs = [dir];
    if (item.meshAliasId) dirs.push(path.join(opts.meshRoot, item.meshAliasId));
    const hit = item.file ? reusableCanonical({ dirs, srcFile: item.file, writeLink: true }) : null;
    if (hit && deform === "rigid") {
      rigs[item.id] = hit.mesh;
      continue;
    }
    if (hit?.rigged && deform === "rig") {
      rigs[item.id] = hit.rigged;
      continue;
    }
    if (deform === "rig" && item.rig && fs.existsSync(item.rig)) {
      rigs[item.id] = item.rig;
      continue;
    }
    if (!item.file || !fs.existsSync(item.file)) {
      throw new Error(`cast_plate_missing: ${item.id} 冇去背板`);
    }
    fs.mkdirSync(dir, { recursive: true });
    const plate = hit ? item.file : await transparentPlate(item.file, dir, run);
    let mesh = hit?.mesh;
    if (!mesh) {
      const meshDir = unusedMeshDir(dir);
      const receipt = await sf3dGenerate({ plate, outDir: meshDir, endpoint: opts.endpoint });
      if (receipt.status !== "succeeded" || !receipt.mesh_front) {
        throw new Error(`sf3d ${item.id}: ${receipt.error ?? receipt.refused ?? receipt.status}`);
      }
      mesh = receipt.mesh_front;
    }
    if (deform === "rigid") {
      rigs[item.id] = mesh;
      continue;
    }
    pending.push({ id: item.id, mesh, rigged: path.join(dir, "mesh_front_rigged.glb") });
  }
  if (pending.length === 0) return rigs;
  if (!opts.allowGpuHandoff) {
    throw new Error(`gpu_handoff_required: ${pending.map((item) => item.id).join("、")} 要 SkinTokens，未有資源窗口，唔停 SF3D`);
  }
  if (!fs.existsSync(SKINTOKENS_BIN)) throw new Error(`skintokens-cli missing: ${SKINTOKENS_BIN}`);
  if (!fs.existsSync(SKINTOKENS_MODELS)) throw new Error(`skintokens models missing: ${SKINTOKENS_MODELS}`);
  await systemctlUser(run, "stop", SF3D_UNIT);
  await systemctlUser(run, "stop", GLM_OCR_UNIT);
  let rigErr: Error | undefined;
  try {
    await waitGpu2ForRig(run);
    for (const item of pending) {
      const riggedTmp = `${item.rigged}.part`;
      const r = await run("/usr/bin/env", [
        "CUDA_DEVICE_ORDER=PCI_BUS_ID",
        `CUDA_VISIBLE_DEVICES=${SF3D_GPU}`,
        SKINTOKENS_BIN,
        "rig", SKINTOKENS_MODELS, item.mesh, riggedTmp, "--device", "auto", "--postprocess",
      ], undefined, {
        CUDA_DEVICE_ORDER: "PCI_BUS_ID",
        CUDA_VISIBLE_DEVICES: SF3D_GPU,
      });
      if (r.code !== 0 || !fs.existsSync(riggedTmp)) {
        const raw = `${r.stderr}\n${r.stdout}`;
        const lines = raw.split("\n").filter((l) => /device|CUDA|found|MiB|GPU/i.test(l));
        throw new Error(`rig ${item.id} failed on CUDA_VISIBLE_DEVICES=${SF3D_GPU}:\n${lines.join("\n") || raw.slice(-800)}`);
      }
      fs.renameSync(riggedTmp, item.rigged);
      rigs[item.id] = item.rigged;
    }
  } catch (error) {
    rigErr = error instanceof Error ? error : new Error(String(error));
  }
  try {
    await systemctlUser(run, "start", SF3D_UNIT);
    await systemctlUser(run, "start", GLM_OCR_UNIT);
  } catch (error) {
    const startErr = error instanceof Error ? error.message : String(error);
    throw new Error(rigErr ? `${rigErr.message}；SF3D 未拉返起：${startErr}` : startErr);
  }
  if (rigErr) throw rigErr;
  return rigs;
}
