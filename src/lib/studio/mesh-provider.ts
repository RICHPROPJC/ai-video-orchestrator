import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";

/** SF3D mesh provider — factory-internal line to the resident sf3d_server (:8018).
 *
 *  Chain: 去背方塊 plate → POST /generate → server-side remesh + bake + canonicalize
 *  → out_dir/0/mesh_front.glb + out_dir/0/canonical_receipt.json.
 *  Canonicalize runs inside the server (canonicalize_glb.py v2); this side never
 *  re-canonicalizes — if the server says canonicalized:false the run FAILS. */

export const SF3D_DEFAULT_ENDPOINT = "http://127.0.0.1:8018";

export type Sf3dHealth = {
  ready: boolean;
  gpu_mem_mb: number;
  served: number;
  busy: boolean;
  err: string | null;
};

export type Sf3dGenerateResponse = {
  mesh: string;
  mesh_front: string | null;
  canonicalized: boolean;
  bytes: number;
  peak_mem_mb: number;
  plate_bg_std: number;
  elapsed_s: number;
};

export type MeshPlateFacts = {
  width: number;
  height: number;
  square: boolean;
  hasAlpha: boolean;
  borderAlphaMean: number;
  opaqueCore: boolean;
};

export type MeshReceipt = {
  tool: "slatecrew.mesh.sf3d";
  ts: string;
  endpoint: string;
  input: string;
  out_dir: string;
  dry_run: boolean;
  status: "dry_run" | "refused" | "failed" | "succeeded";
  refused?: string;
  error?: string;
  input_sha256?: string;
  mesh_front?: string;
  mesh_front_sha256?: string;
  mesh_front_bytes?: number;
  canonical_receipt?: string;
  canonical_sha256?: string;
  server?: Sf3dGenerateResponse;
};

/** Border ring width (px) sampled for the 去背 check. */
const BORDER_PX = 24;
const BORDER_ALPHA_MAX = 0.45;
const CORE_ALPHA_MIN = 0.9;

/** A mesh plate is a background-removed square: RGBA, a real subject anywhere,
 *  and a border that is not a backdrop. An off-center cutout still passes.
 *  A full-frame background, a non-square, or a plate with no alpha is refused
 *  before GPU work (the server runs with no_rembg). */
export async function meshPlateFacts(file: string): Promise<MeshPlateFacts> {
  const meta = await sharp(file).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const hasAlpha = Boolean(meta.hasAlpha);
  if (!width || !height) throw new Error(`${file}: cannot read dimensions`);
  const facts: MeshPlateFacts = { width, height, square: width === height, hasAlpha, borderAlphaMean: 1, opaqueCore: false };
  if (!facts.square || !hasAlpha) return facts;
  // read the alpha channel raw: average the border ring + probe the core
  const { data } = await sharp(file).extractChannel("alpha").raw().toBuffer({ resolveWithObject: true });
  let ringSum = 0;
  let ringN = 0;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (x >= BORDER_PX && x < width - BORDER_PX && y >= BORDER_PX && y < height - BORDER_PX) continue;
      ringSum += data[row + x] ?? 0;
      ringN += 1;
    }
  }
  facts.borderAlphaMean = ringN ? ringSum / ringN / 255 : 1;
  let subjectMax = 0;
  for (let i = 0; i < data.length; i += 2) {
    subjectMax = Math.max(subjectMax, (data[i] ?? 0) / 255);
    if (subjectMax >= CORE_ALPHA_MIN) break;
  }
  facts.opaqueCore = subjectMax >= CORE_ALPHA_MIN;
  return facts;
}

export async function assertMeshPlate(file: string): Promise<MeshPlateFacts> {
  const facts = await meshPlateFacts(file);
  if (!facts.square) throw new Error(`mesh plate must be square, got ${facts.width}x${facts.height}: ${file}`);
  if (!facts.hasAlpha) throw new Error(`mesh plate must be RGBA (去背), no alpha channel: ${file}`);
  if (facts.borderAlphaMean > BORDER_ALPHA_MAX) {
    throw new Error(`mesh plate border is not transparent (mean alpha ${facts.borderAlphaMean.toFixed(3)} > ${BORDER_ALPHA_MAX}): ${file}`);
  }
  if (!facts.opaqueCore) throw new Error(`mesh plate has no opaque subject in the core: ${file}`);
  return facts;
}

async function fetchJson(url: string, init?: RequestInit, timeoutMs = 5000): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const body = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) {
      const err = body && typeof body === "object" && "err" in body ? String((body as { err: unknown }).err) : `HTTP ${res.status}`;
      throw new Error(`${url} -> ${err}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export async function sf3dHealth(endpoint = SF3D_DEFAULT_ENDPOINT): Promise<Sf3dHealth> {
  const h = (await fetchJson(`${endpoint}/health`)) as Partial<Sf3dHealth>;
  if (typeof h.ready !== "boolean") throw new Error(`${endpoint}/health: malformed response`);
  return {
    ready: h.ready,
    gpu_mem_mb: h.gpu_mem_mb ?? 0,
    served: h.served ?? 0,
    busy: Boolean(h.busy),
    err: h.err ?? null,
  };
}

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** GLB container check: magic, version 2, declared length == file size. */
export function assertGlbFile(file: string): { bytes: number } {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size < 20) throw new Error(`${file}: not a nonempty regular GLB`);
  const fd = fs.openSync(file, "r");
  const header = Buffer.alloc(12);
  try {
    fs.readSync(fd, header, 0, 12, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (header.toString("ascii", 0, 4) !== "glTF" || header.readUInt32LE(4) !== 2 || header.readUInt32LE(8) !== stat.size) {
    throw new Error(`${file}: invalid GLB header/length`);
  }
  return { bytes: stat.size };
}

/** Every attempt owns a fresh output directory — EEXIST refuses stale outputs
 *  and concurrent reuse (same law as the Tripo provider). */
function createRunDirectory(dir: string): void {
  const abs = path.resolve(dir);
  if (fs.existsSync(abs)) throw new Error(`sf3d out_dir already exists (no reuse): ${abs}`);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.mkdirSync(abs);
}

/** Plate → sf3d_server /generate. Server canonicalizes; we only take receipt. */
export async function sf3dGenerate(opts: {
  plate: string;
  outDir: string;
  endpoint?: string;
  frontRef?: string;
  textureResolution?: number;
  timeoutMs?: number;
}): Promise<MeshReceipt> {
  const endpoint = opts.endpoint ?? SF3D_DEFAULT_ENDPOINT;
  const plate = path.resolve(opts.plate);
  const outDir = path.resolve(opts.outDir);
  const receipt: MeshReceipt = {
    tool: "slatecrew.mesh.sf3d",
    ts: new Date().toISOString(),
    endpoint,
    input: plate,
    out_dir: outDir,
    dry_run: false,
    status: "refused",
  };
  let posted = false;
  try {
    const facts = await assertMeshPlate(plate);
    void facts;
    receipt.input_sha256 = sha256(plate);
    const health = await sf3dHealth(endpoint);
    if (!health.ready) throw new Error(`sf3d_server not ready (err=${health.err ?? "none"})`);
    createRunDirectory(outDir);
    const body = {
      image: plate,
      out_dir: outDir,
      texture_resolution: opts.textureResolution ?? 512,
      // plate is pre-去背 (D1: byte-identical, -35s, u2net removed from the chain)
      no_rembg: true,
      canonicalize: true,
      ...(opts.frontRef ? { front_ref: path.resolve(opts.frontRef) } : {}),
    };
    posted = true;
    const resp = (await fetchJson(`${endpoint}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, opts.timeoutMs ?? 300_000)) as Partial<Sf3dGenerateResponse>;
    if (!resp.canonicalized) throw new Error("sf3d_server did not canonicalize — factory never re-canonicalizes");
    const meshFront = resp.mesh_front ?? path.join(outDir, "0", "mesh_front.glb");
    const canonReceipt = path.join(outDir, "0", "canonical_receipt.json");
    const glb = assertGlbFile(meshFront);
    const canonRaw = fs.readFileSync(canonReceipt, "utf8");
    JSON.parse(canonRaw); // must parse — malformed canonical receipt fails the run
    receipt.mesh_front = meshFront;
    receipt.mesh_front_bytes = glb.bytes;
    receipt.mesh_front_sha256 = sha256(meshFront);
    receipt.canonical_receipt = canonReceipt;
    receipt.canonical_sha256 = createHash("sha256").update(canonRaw).digest("hex");
    receipt.server = {
      mesh: String(resp.mesh ?? ""),
      mesh_front: meshFront,
      canonicalized: true,
      bytes: resp.bytes ?? 0,
      peak_mem_mb: resp.peak_mem_mb ?? 0,
      plate_bg_std: resp.plate_bg_std ?? 0,
      elapsed_s: resp.elapsed_s ?? 0,
    };
    receipt.status = "succeeded";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (posted) {
      receipt.status = "failed";
      receipt.error = message;
    } else {
      receipt.status = "refused";
      receipt.refused = message;
    }
  }
  // refused runs also leave a receipt; every attempt still needs a fresh out_dir.
  // a pre-existing out_dir (misuse) cannot take an in-dir receipt — side-file it.
  const receiptFile = path.join(outDir, "mesh-receipt.json");
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
  } catch {
    fs.writeFileSync(`${outDir}/mesh-receipt.${Date.now()}.json`, JSON.stringify(receipt, null, 2) + "\n");
  }
  return receipt;
}

/** The Blender-入庫 call, same shape as the SETTLE_SF3D_BLENDER_U15_0918 receipt
 *  (object.import_mesh, zUp, heightCalibrated). */
export function importMeshCall(opts: { path: string; name: string; targetHeightM?: number }) {
  if (opts.targetHeightM !== undefined && (!Number.isFinite(opts.targetHeightM) || opts.targetHeightM <= 0)) {
    throw new Error("targetHeightM must be a positive finite number of metres");
  }
  return {
    tool: "object.import_mesh" as const,
    args: {
      path: opts.path,
      name: opts.name,
      zUp: true as const,
      ...(opts.targetHeightM === undefined ? {} : { targetHeightM: opts.targetHeightM }),
    },
  };
}
