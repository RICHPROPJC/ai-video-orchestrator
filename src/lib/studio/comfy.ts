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

function base() {
  return loadConfig().comfyUrl.replace(/\/$/, "");
}

export async function probeComfy(): Promise<ComfyStatus> {
  const url = base();
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

async function queuePrompt(graph: ComfyGraph) {
  const res = await fetch(`${base()}/prompt`, {
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
    throw new Error(json.error?.message || JSON.stringify(json.node_errors || json));
  }
  return json.prompt_id;
}

async function waitHistory(promptId: string, timeoutMs = 8 * 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${base()}/history/${promptId}`);
    const json = (await res.json()) as Record<string, { outputs?: Record<string, unknown>; status?: { status_str?: string } }>;
    const item = json[promptId];
    if (item?.outputs && Object.keys(item.outputs).length) return item.outputs;
    if (item?.status?.status_str === "error") throw new Error("Comfy execution error");
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("Comfy timed out");
}

async function downloadView(file: { filename: string; subfolder?: string; type?: string }, dest: string) {
  const params = new URLSearchParams({
    filename: file.filename,
    subfolder: file.subfolder ?? "",
    type: file.type ?? "output",
  });
  const res = await fetch(`${base()}/view?${params}`);
  if (!res.ok) throw new Error(`view ${res.status}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

export async function uploadComfyImage(filePath: string) {
  const buf = fs.readFileSync(filePath);
  const form = new FormData();
  form.set(
    "image",
    new File([new Uint8Array(buf)], path.basename(filePath), { type: "image/png" }),
  );
  form.set("overwrite", "true");
  const res = await fetch(`${base()}/upload/image`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`upload ${res.status}`);
  const json = (await res.json()) as { name: string; subfolder?: string; type?: string };
  return json.name;
}

function loadGraph(rel: string): ComfyGraph {
  const abs = path.isAbsolute(rel) ? rel : path.join(process.cwd(), rel);
  return JSON.parse(fs.readFileSync(abs, "utf8")) as ComfyGraph;
}

function patchGraph(
  graph: ComfyGraph,
  patch: Record<string, string | number>,
) {
  const next = structuredClone(graph);
  for (const node of Object.values(next)) {
    for (const [key, val] of Object.entries(node.inputs ?? {})) {
      if (typeof val !== "string") continue;
      let out = val;
      for (const [token, repl] of Object.entries(patch)) {
        out = out.replaceAll(token, String(repl));
      }
      node.inputs[key] = out;
    }
    for (const [key, val] of Object.entries(node.inputs ?? {})) {
      if (typeof val === "string" && /^-?\d+(\.\d+)?$/.test(val) && ["width", "height", "duration", "length", "steps"].includes(key)) {
        node.inputs[key] = Number(val);
      }
    }
  }
  return next;
}

function pickOutputs(outputs: Record<string, unknown>) {
  const images: { filename: string; subfolder?: string; type?: string }[] = [];
  const videos: { filename: string; subfolder?: string; type?: string }[] = [];
  for (const node of Object.values(outputs)) {
    const rec = node as {
      images?: { filename: string; subfolder?: string; type?: string }[];
      gifs?: { filename: string; subfolder?: string; type?: string }[];
      videos?: { filename: string; subfolder?: string; type?: string }[];
    };
    images.push(...(rec.images ?? []));
    videos.push(...(rec.gifs ?? []), ...(rec.videos ?? []));
  }
  return { images, videos };
}

export async function comfyStill(opts: {
  prompt: string;
  width: number;
  height: number;
  outFile: string;
}) {
  const cfg = loadConfig();
  const graph = patchGraph(loadGraph(cfg.stills.workflow), {
    __PROMPT__: opts.prompt,
    __CKPT__: cfg.stills.checkpoint,
    __WIDTH__: opts.width,
    __HEIGHT__: opts.height,
  });
  const id = await queuePrompt(graph);
  const outputs = await waitHistory(id);
  const { images } = pickOutputs(outputs);
  if (!images[0]) throw new Error("Comfy stills: no image output");
  await downloadView(images[0], opts.outFile);
  return `comfy:${cfg.stills.checkpoint}`;
}

export async function comfyMotion(opts: {
  prompt: string;
  stillFile: string;
  outFile: string;
  seconds: number;
  width: number;
  height: number;
}) {
  const cfg = loadConfig();
  const imageName = await uploadComfyImage(opts.stillFile);
  const graph = patchGraph(loadGraph(cfg.motion.workflow), {
    __PROMPT__: opts.prompt,
    __CKPT__: cfg.motion.checkpoint,
    __TEXT_ENCODER__: cfg.motion.textEncoder,
    __VIDEO_VAE__: cfg.motion.videoVae,
    __AUDIO_VAE__: cfg.motion.audioVae,
    __IMAGE__: imageName,
    __WIDTH__: opts.width,
    __HEIGHT__: opts.height,
    __DURATION__: opts.seconds,
  });
  const id = await queuePrompt(graph);
  const outputs = await waitHistory(id, 15 * 60_000);
  const { images, videos } = pickOutputs(outputs);
  const file = videos[0] ?? images.at(-1);
  if (!file) throw new Error("Comfy motion: no video output");
  await downloadView(file, opts.outFile);
  return `comfy:${cfg.motion.checkpoint}`;
}
