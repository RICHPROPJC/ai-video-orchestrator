import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";

export type ComfyNode = {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
};

export type ComfyGraph = Record<string, ComfyNode>;

export type ComfyStatus = {
  up: boolean;
  url: string;
  error?: string;
  checkpoints: string[];
  nodes: string[];
};

const base = (server: string) => server.replace(/\/$/, "");

export async function probeComfy(server: string): Promise<ComfyStatus> {
  const url = base(server);
  try {
    const stats = await fetch(`${url}/system_stats`, { signal: AbortSignal.timeout(2500) });
    if (!stats.ok) throw new Error(`HTTP ${stats.status}`);
    const [models, info] = await Promise.all([
      fetch(`${url}/models/diffusion_models`, { signal: AbortSignal.timeout(4000) }).then((r) =>
        r.ok ? (r.json() as Promise<string[]>) : [],
      ).catch(() => [] as string[]),
      fetch(`${url}/object_info`, { signal: AbortSignal.timeout(8000) })
        .then((r) => (r.ok ? (r.json() as Promise<Record<string, unknown>>) : {}))
        .catch(() => ({}) as Record<string, unknown>),
    ]);
    return {
      up: true,
      url,
      checkpoints: Array.isArray(models) ? models : [],
      nodes: Object.keys(info),
    };
  } catch (error) {
    return {
      up: false,
      url,
      error: error instanceof Error ? error.message : String(error),
      checkpoints: [],
      nodes: [],
    };
  }
}

export async function queuePrompt(server: string, graph: ComfyGraph): Promise<string> {
  const res = await fetch(`${base(server)}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: graph, client_id: "slatecrew" }),
  });
  const json = (await res.json()) as {
    prompt_id?: string;
    error?: { message?: string };
    node_errors?: unknown;
  };
  if (!res.ok || !json.prompt_id) {
    const detail = json.node_errors ? ` ${JSON.stringify(json.node_errors).slice(0, 700)}` : "";
    throw new Error(`${json.error?.message || "comfy prompt rejected"}${detail}`);
  }
  return json.prompt_id;
}

export type ComfyOutputFile = { filename: string; subfolder?: string; type?: string };
export type ComfyOutputs = { images: ComfyOutputFile[]; gifs: ComfyOutputFile[]; videos: ComfyOutputFile[] };

function pickOutputs(outputs: Record<string, unknown>): ComfyOutputs {
  const images: ComfyOutputFile[] = [];
  const videos: ComfyOutputFile[] = [];
  for (const node of Object.values(outputs)) {
    const rec = node as {
      images?: ComfyOutputFile[];
      gifs?: ComfyOutputFile[];
      videos?: ComfyOutputFile[];
    };
    images.push(...(rec.images ?? []));
    videos.push(...(rec.gifs ?? []), ...(rec.videos ?? []));
  }
  return { images, gifs: [], videos };
}

type HistoryItem = {
  outputs?: Record<string, unknown>;
  status?: { status_str?: string; completed?: boolean };
  node_errs?: unknown;
};

/** poll /history until the save node reports output (shotdag wait_and_download
 *  order: sleep first, then look — a queued prompt must not read as finished-empty). */
export async function waitHistory(
  server: string,
  promptId: string,
  opts: { intervalMs?: number; timeoutMs?: number; saveNode?: string } = {},
): Promise<ComfyOutputs> {
  const intervalMs = opts.intervalMs ?? 10_000;
  const timeoutMs = opts.timeoutMs ?? 1_800_000; // 30 min hard cap
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const res = await fetch(`${base(server)}/history/${promptId}`, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`history ${res.status}`);
    const json = (await res.json()) as Record<string, HistoryItem>;
    const item = json[promptId];
    if (!item) continue;
    if (item.status?.status_str === "error") {
      const detail = JSON.stringify(item.node_errs ?? item.status).slice(0, 2000);
      throw new Error(`render error (prompt_id=${promptId}): ${detail}`);
    }
    if (opts.saveNode) {
      const node = item.outputs?.[opts.saveNode];
      if (node && Object.keys(node).length) return pickOutputs({ [opts.saveNode]: node });
      if (item.status?.completed) {
        throw new Error(`render finished but ${opts.saveNode} has no output (prompt_id=${promptId})`);
      }
    } else if (item.outputs && Object.keys(item.outputs).length) {
      return pickOutputs(item.outputs);
    }
  }
  throw new Error(`poll timeout ${timeoutMs / 1000}s (prompt_id=${promptId})`);
}

export async function downloadView(
  server: string,
  file: ComfyOutputFile,
  dest: string,
): Promise<void> {
  const params = new URLSearchParams({
    filename: file.filename,
    subfolder: file.subfolder ?? "",
    type: file.type ?? "output",
  });
  const res = await fetch(`${base(server)}/view?${params}`, { signal: AbortSignal.timeout(600_000) });
  if (!res.ok) throw new Error(`view ${res.status}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

/** POST /upload/image with the real mime (video/mp4 for blockouts, image/png
 *  for keyframes); returns the server-assigned name. */
export async function uploadComfyFile(server: string, filePath: string, name: string, mime: string): Promise<string> {
  const buf = fs.readFileSync(filePath);
  const form = new FormData();
  form.set("image", new File([new Uint8Array(buf)], name, { type: mime }));
  form.set("overwrite", "true");
  const res = await fetch(`${base(server)}/upload/image`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`upload ${res.status}`);
  const json = (await res.json()) as { name: string; subfolder?: string; type?: string };
  return json.name;
}

/** UNWIRED (stills lane is U1.5 /edit on node0). Kept compiling for a future
 *  ComfyUI stills lane over workflows/u15-t2i.api.json. */
export async function comfyStill(server: string, opts: {
  prompt: string;
  width: number;
  height: number;
  outFile: string;
}) {
  const cfg = loadConfig();
  const abs = path.isAbsolute(cfg.stills.workflow) ? cfg.stills.workflow : path.join(process.cwd(), cfg.stills.workflow);
  const graph = JSON.parse(fs.readFileSync(abs, "utf8")) as ComfyGraph;
  const patch: Record<string, string> = {
    __PROMPT__: opts.prompt,
    __CKPT__: cfg.stills.checkpoint,
    __WIDTH__: String(opts.width),
    __HEIGHT__: String(opts.height),
  };
  for (const node of Object.values(graph)) {
    for (const [key, val] of Object.entries(node.inputs ?? {})) {
      if (typeof val !== "string") continue;
      let out = val;
      for (const [token, repl] of Object.entries(patch)) out = out.replaceAll(token, repl);
      node.inputs[key] = out;
    }
    for (const key of ["width", "height"] as const) {
      const val = node.inputs[key];
      if (typeof val === "string" && /^-?\d+(\.\d+)?$/.test(val)) node.inputs[key] = Number(val);
    }
  }
  const id = await queuePrompt(server, graph);
  const outputs = await waitHistory(server, id);
  const file = outputs.images[0];
  if (!file) throw new Error("Comfy stills: no image output");
  await downloadView(server, file, opts.outFile);
  return `comfy:${cfg.stills.checkpoint}`;
}
