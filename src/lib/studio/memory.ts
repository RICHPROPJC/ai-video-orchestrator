import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "./config";
import { ensureDir, projectsDir } from "./paths";
import type { VideoQcRecord } from "./video-qc";

/** 1-cosine. Above this, SH_n is not the same person as SH_n-1. */
export const DRIFT_MAX = 0.45;
/** 1-cosine. Below this, the clip is a copy of the grey blockout frame. */
export const COPY_MIN = 0.12;

export type MemoryKind = "still" | "clip" | "frame";

export type MemoryHit = {
  shot: string;
  kind: MemoryKind;
  character: string;
  scene: string;
  rel: string;
  cosine: number;
};

export type MemoryDistance = {
  distance: number;
  fail: boolean;
  reason: string;
};

export type EmbedFn = (file: string) => Promise<number[]>;

export function memoryDir(ep: string): string {
  const dir = path.join(projectsDir(), ep, "memory");
  ensureDir(dir);
  return dir;
}

export function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

export function distance(a: number[], b: number[]): number {
  return 1 - cosine(a, b);
}

export function characterDrift(prev: number[], curr: number[]): MemoryDistance {
  const d = distance(prev, curr);
  return { distance: d, fail: d > DRIFT_MAX, reason: d > DRIFT_MAX ? `character_drift ${d.toFixed(3)}>${DRIFT_MAX}` : "" };
}

export function blockoutCopy(clip: number[], grey: number[]): MemoryDistance {
  const d = distance(clip, grey);
  return { distance: d, fail: d < COPY_MIN, reason: d < COPY_MIN ? `blockout_copy ${d.toFixed(3)}<${COPY_MIN}` : "" };
}

function pack(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer);
}

function unpack(blob: Uint8Array): number[] {
  const buf = blob.byteOffset === 0 && blob.byteLength === blob.buffer.byteLength
    ? blob
    : new Uint8Array(blob);
  return [...new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4))];
}

function withDb<T>(ep: string, fn: (db: DatabaseSync) => T): T {
  const file = path.join(memoryDir(ep), "memory.sqlite");
  const db = new DatabaseSync(file);
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shot TEXT NOT NULL,
      kind TEXT NOT NULL,
      character TEXT NOT NULL DEFAULT '',
      scene TEXT NOT NULL DEFAULT '',
      rel TEXT NOT NULL,
      dim INTEGER NOT NULL,
      vector BLOB NOT NULL,
      ts TEXT NOT NULL
    )`);
    return fn(db);
  } finally {
    db.close();
  }
}

export const EMBED_DIM = 2048;

export function parseEmbed(json: unknown): number[] {
  if (!json || typeof json !== "object") throw new Error("embed: empty reply");
  const o = json as Record<string, unknown>;
  if (Array.isArray(o.data) && o.data[0] && typeof o.data[0] === "object") {
    const emb = (o.data[0] as { embedding?: unknown }).embedding;
    if (Array.isArray(emb) && typeof emb[0] === "number") return acceptEmbed(emb as number[]);
  }
  const embeddings = o.embeddings;
  if (Array.isArray(embeddings) && Array.isArray(embeddings[0]) && typeof embeddings[0][0] === "number") {
    return acceptEmbed(embeddings[0] as number[]);
  }
  if (embeddings && typeof embeddings === "object") {
    const pack = embeddings as { float?: unknown };
    if (Array.isArray(pack.float) && Array.isArray(pack.float[0]) && typeof pack.float[0][0] === "number") {
      return acceptEmbed(pack.float[0] as number[]);
    }
    if (Array.isArray(pack.float) && typeof pack.float[0] === "number") return acceptEmbed(pack.float as number[]);
  }
  throw new Error("embed: no vector in reply");
}

function acceptEmbed(vec: number[]): number[] {
  if (vec.length !== EMBED_DIM || vec.some((n) => typeof n !== "number")) {
    throw new Error(`embed_dim: got ${vec.length}, want ${EMBED_DIM}`);
  }
  return vec;
}

export async function embedImage(file: string, fetchImpl: typeof fetch = fetch): Promise<number[]> {
  const cfg = loadConfig();
  const url = cfg.embed.endpoint.trim().replace(/\/$/, "");
  if (!url) throw new Error("embed.endpoint unconfigured");
  if (!fs.existsSync(file)) throw new Error(`embed: missing file ${file}`);
  const b64 = fs.readFileSync(file).toString("base64");
  const mime = file.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
  const res = await fetchImpl(`${url}/v2/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: cfg.embed.model || undefined,
      images: [`data:${mime};base64,${b64}`],
    }),
    signal: AbortSignal.timeout(20_000),
  } as RequestInit);
  if (!res.ok) throw new Error(`embed HTTP ${res.status}`);
  return parseEmbed(await res.json());
}

/** T44 §5 (card R5): retrieval ranks candidates by REAL cosine between the
 *  query's own embedding (WeMM) and each stored vector — the score is
 *  computed, never assumed. Rows whose vector can't be scored against the
 *  query (dimension mismatch, another embed model's run) never surface. */
export async function queryRefs(
  ep: string,
  opts: {
    queryFile?: string;
    characters?: string[];
    scene?: string;
    k?: number;
    embed?: EmbedFn;
  },
): Promise<MemoryHit[]> {
  const wantChars = new Set((opts.characters ?? []).filter(Boolean));
  const scene = (opts.scene ?? "").trim();
  const k = opts.k ?? 3;
  const embed = opts.embed ?? embedImage;
  if (!opts.queryFile || !fs.existsSync(opts.queryFile)) return [];
  const query = await embed(opts.queryFile);
  return withDb(ep, (db) => {
    const rows = db.prepare("SELECT shot, kind, character, scene, rel, vector FROM items WHERE kind = 'still'").all() as Array<{
      shot: string;
      kind: string;
      character: string;
      scene: string;
      rel: string;
      vector: Uint8Array;
    }>;
    const hits: MemoryHit[] = [];
    for (const row of rows) {
      const byChar = wantChars.size > 0 && wantChars.has(row.character);
      const byScene = Boolean(scene) && row.scene === scene;
      if (!byChar && !byScene) continue;
      const vec = unpack(row.vector);
      if (vec.length !== query.length) continue;
      hits.push({
        shot: row.shot,
        kind: row.kind as MemoryKind,
        character: row.character,
        scene: row.scene,
        rel: row.rel,
        cosine: cosine(query, vec),
      });
    }
    return hits.sort((a, b) => b.cosine - a.cosine).slice(0, k);
  });
}

export function ingestVector(opts: {
  ep: string;
  shot: string;
  kind: MemoryKind;
  character: string;
  scene: string;
  rel: string;
  vector: number[];
}): void {
  withDb(opts.ep, (db) => {
    db.prepare(
      "INSERT INTO items (shot, kind, character, scene, rel, dim, vector, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      opts.shot,
      opts.kind,
      opts.character,
      opts.scene,
      opts.rel,
      opts.vector.length,
      pack(opts.vector),
      new Date().toISOString(),
    );
  });
}

export async function ingestStill(opts: {
  ep: string;
  shot: string;
  character: string;
  scene: string;
  file: string;
  rel: string;
  embed?: EmbedFn;
}): Promise<void> {
  const vector = await (opts.embed ?? embedImage)(opts.file);
  ingestVector({ ...opts, kind: "still", vector });
}

export function loadLatestStillVector(ep: string, character: string, beforeShot: string): number[] | null {
  return withDb(ep, (db) => {
    const rows = db.prepare(
      "SELECT shot, vector FROM items WHERE kind = 'still' AND character = ? ORDER BY id DESC",
    ).all(character) as Array<{ shot: string; vector: Uint8Array }>;
    const hit = rows.find((r) => r.shot !== beforeShot);
    return hit ? unpack(hit.vector) : null;
  });
}

export function applyMemoryDistances(
  record: VideoQcRecord,
  opts: { drift?: MemoryDistance | null; copy?: MemoryDistance | null },
): VideoQcRecord {
  const extra: string[] = [];
  if (opts.drift?.fail) extra.push(opts.drift.reason);
  if (opts.copy?.fail) extra.push(opts.copy.reason);
  const fail_reasons = [...(record.checks.fail_reasons ?? []), ...extra];
  const status: VideoQcRecord["status"] = extra.length || record.status === "FAIL" ? "FAIL" : record.status;
  return {
    ...record,
    memory: {
      character_drift: opts.drift ? { distance: opts.drift.distance, fail: opts.drift.fail } : undefined,
      blockout_copy: opts.copy ? { distance: opts.copy.distance, fail: opts.copy.fail } : undefined,
    },
    status,
    checks: { ...record.checks, status, fail_reasons },
  };
}

export async function attachMemoryDistances(
  record: VideoQcRecord,
  opts: {
    ep: string;
    shot: string;
    outJson?: string;
    character?: string;
    prevStill?: string;
    blockoutF0?: string;
    midFrame?: string;
    embed?: EmbedFn;
  },
): Promise<VideoQcRecord> {
  const cfg = loadConfig();
  if (!opts.embed && !cfg.embed.endpoint.trim()) return record;
  const embed = opts.embed ?? embedImage;
  let drift: MemoryDistance | null = null;
  let copy: MemoryDistance | null = null;
  const mid = opts.midFrame;
  if (opts.character && opts.prevStill && fs.existsSync(opts.prevStill) && mid && fs.existsSync(mid)) {
    const [prev, curr] = await Promise.all([embed(opts.prevStill), embed(mid)]);
    drift = characterDrift(prev, curr);
    ingestVector({
      ep: opts.ep,
      shot: opts.shot,
      kind: "clip",
      character: opts.character,
      scene: "",
      rel: path.basename(mid),
      vector: curr,
    });
  }
  if (opts.blockoutF0 && fs.existsSync(opts.blockoutF0) && mid && fs.existsSync(mid)) {
    const [grey, clip] = await Promise.all([embed(opts.blockoutF0), embed(mid)]);
    copy = blockoutCopy(clip, grey);
  }
  const next = applyMemoryDistances(record, { drift, copy });
  if (opts.outJson) fs.writeFileSync(opts.outJson, JSON.stringify(next, null, 2));
  return next;
}
