import fs from "node:fs";
import path from "node:path";
import http from "node:http";

// node:http, not global fetch: undici's 300 s headers timeout cannot cover a
// serial /edit (shotdag allows 3600 s)
const POST_TIMEOUT_MS = 3_600_000;

export const MAX_IMAGES = 5; // base+refs cap (fork lane hard limit)
const NUM_STEPS = 8;
const CFG_SCALE = 1.0;
const IMG_CFG_SCALE = 1.0;
const USE_EDIT_PE = true;
export const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** U1.5 patchify wants ÷32 */
export function snap32(n: number): number {
  return Math.floor(n / 32) * 32;
}

export type EditHealth = {
  model?: string;
  multi_image?: boolean;
  defaults?: Record<string, unknown>;
} & Record<string, unknown>;

/** /health gate (fail-closed): non-200 stops; multi-image needs multi_image=true */
export async function checkHealth(server: string, nImages: number): Promise<EditHealth> {
  const res = await fetch(`${server.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    throw new Error(`U1.5 node down: GET ${server}/health -> HTTP ${res.status}`);
  }
  const info = (await res.json()) as EditHealth;
  if (nImages > 1 && !info.multi_image) {
    throw new Error(`${server} multi_image=false — cannot /edit ${nImages} images`);
  }
  return info;
}

export type EditPayload = {
  prompt: string;
  num_steps: number;
  cfg_scale: number;
  img_cfg_scale: number;
  use_edit_pe: boolean;
  width: number;
  height: number;
  seed?: number;
  image_path?: string;
  image_paths?: string[];
};

/** images = node-local paths, first one is the main edit target (fork order) */
export function buildEditPayload(opts: {
  prompt: string;
  images: string[];
  width: number;
  height: number;
  seed?: number;
}): EditPayload {
  if (opts.images.length < 1) throw new Error("nothing to edit: no images given");
  if (opts.images.length > MAX_IMAGES) {
    throw new Error(`${opts.images.length} images (base+refs) exceed the ${MAX_IMAGES}-image cap`);
  }
  const payload: EditPayload = {
    prompt: opts.prompt.trim(),
    num_steps: NUM_STEPS,
    cfg_scale: CFG_SCALE,
    img_cfg_scale: IMG_CFG_SCALE,
    use_edit_pe: USE_EDIT_PE,
    width: snap32(opts.width),
    height: snap32(opts.height),
  };
  if (opts.seed != null) payload.seed = opts.seed;
  if (opts.images.length === 1) payload.image_path = opts.images[0]!;
  else payload.image_paths = opts.images;
  return payload;
}

function postJsonRaw(url: string, payload: unknown, timeoutMs = POST_TIMEOUT_MS): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = Buffer.from(JSON.stringify(payload));
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": data.length },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`POST ${url} timed out after ${timeoutMs}ms`)));
    req.on("error", reject);
    req.end(data);
  });
}

/** /edit replies with raw PNG bytes — anything else is a failure, never saved */
export function assertPng(body: Buffer): void {
  if (!body.subarray(0, 8).equals(PNG_MAGIC)) {
    throw new Error(`/edit returned non-PNG body (${body.length}B, head=${JSON.stringify(body.subarray(0, 120).toString("latin1"))})`);
  }
}

export async function runEdit(server: string, payload: EditPayload): Promise<{ png: Buffer; elapsedMs: number }> {
  const t0 = Date.now();
  const { status, body } = await postJsonRaw(`${server.replace(/\/$/, "")}/edit`, payload);
  if (status !== 200) {
    throw new Error(`/edit HTTP ${status}: ${body.subarray(0, 300).toString("utf8")}`);
  }
  assertPng(body);
  return { png: body, elapsedMs: Date.now() - t0 };
}

export type U15EditRecord = {
  tool: "slatecrew.u15_edit";
  ts: string;
  url: string;
  prompt: string;
  img_cfg: number;
  cfg: number;
  steps: number;
  use_edit_pe: boolean;
  width: number;
  height: number;
  seed?: number;
  first: boolean;
  base: string | null;
  refs: string[];
  node_paths: string[] | null;
  output: string;
  elapsed_ms: number;
  dry_run: boolean;
  model?: string;
  bytes?: number;
};

/** full /edit lane (live): health → (caller scp's node paths) → POST → PNG + record */
export async function u15Edit(opts: {
  server: string;
  payload: EditPayload;
  nodePaths: string[];
  outFile: string;
  recordJson: string;
  record: Omit<U15EditRecord, "tool" | "elapsed_ms" | "dry_run" | "node_paths" | "output" | "url">;
  health: EditHealth;
}): Promise<U15EditRecord> {
  const { png, elapsedMs } = await runEdit(opts.server, opts.payload);
  fs.mkdirSync(path.dirname(opts.outFile), { recursive: true });
  fs.writeFileSync(opts.outFile, png);
  const record: U15EditRecord = {
    ...opts.record,
    tool: "slatecrew.u15_edit",
    url: `${opts.server.replace(/\/$/, "")}/edit`,
    node_paths: opts.nodePaths,
    output: opts.outFile,
    elapsed_ms: elapsedMs,
    dry_run: false,
    model: opts.health.model,
    bytes: png.length,
  };
  fs.mkdirSync(path.dirname(opts.recordJson), { recursive: true });
  fs.writeFileSync(opts.recordJson, JSON.stringify(record, null, 2));
  return record;
}
