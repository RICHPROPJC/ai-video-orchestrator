import fs from "node:fs";
import path from "node:path";
import { jobFile } from "./paths";
import { assertInJob, relInJob, resolveInJob } from "./isolate";

export type Modality = "text" | "image" | "video" | "audio";

export type VaultDoc = {
  id: string;
  slate: string;
  modality: Modality;
  shotId?: string;
  rel?: string;
  text: string;
  vector: number[];
};

export type VaultHit = {
  id: string;
  slate: string;
  modality: Modality;
  shotId?: string;
  rel?: string;
  text: string;
  score: number;
  cosine: number;
  lexical: number;
};

export type VaultFile = {
  slate: string;
  isolated: true;
  dim: number;
  docs: VaultDoc[];
};

const DIM = 48;

function vaultPath(slate: string) {
  return jobFile(slate, "vault.json");
}

function load(slate: string): VaultFile {
  const file = vaultPath(slate);
  if (!fs.existsSync(file)) {
    return { slate, isolated: true, dim: DIM, docs: [] };
  }
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as VaultFile;
  if (data.slate !== slate) {
    throw new Error(`vault slate drift: file ${data.slate} ≠ ${slate}`);
  }
  return data;
}

function save(file: VaultFile) {
  fs.writeFileSync(vaultPath(file.slate), JSON.stringify(file, null, 2));
}

function tokenize(s: string) {
  return s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1);
}

/** Local text/vision/video embed. Swap with CLIP/VLM HTTP later; still must pass slate. */
export function embedText(text: string): number[] {
  const vec = new Array(DIM).fill(0);
  const toks = tokenize(text);
  for (const tok of toks) {
    let h = 2166136261;
    for (let i = 0; i < tok.length; i += 1) {
      h ^= tok.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    vec[(h >>> 0) % DIM] += 1;
    if (tok.length >= 2) {
      const bigram = tok.slice(0, 2);
      let g = 0;
      for (let i = 0; i < bigram.length; i += 1) g = (g * 31 + bigram.charCodeAt(i)) >>> 0;
      vec[g % DIM] += 0.5;
    }
  }
  return l2(vec);
}

export function embedFile(slate: string, absPath: string): number[] {
  const abs = assertInJob(slate, absPath);
  const buf = fs.readFileSync(abs);
  const vec = new Array(DIM).fill(0);
  vec[0] = Math.log2(buf.length + 1) / 32;
  const step = Math.max(1, Math.floor(buf.length / 512));
  for (let i = 0; i < buf.length; i += step) {
    vec[1 + (buf[i]! % (DIM - 2))] += 1;
  }
  const ext = path.extname(abs).toLowerCase();
  if (ext === ".png" && buf.length > 24) vec[DIM - 1] += 0.4;
  if (ext === ".mp4") vec[DIM - 2] += 0.4;
  if (ext === ".wav") vec[DIM - 3] += 0.4;
  return l2(vec);
}

function l2(vec: number[]) {
  const n = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1;
  return vec.map((x) => x / n);
}

function cosine(a: number[], b: number[]) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}

function lexical(query: string, doc: string) {
  const q = new Set(tokenize(query));
  if (q.size === 0) return 0;
  const d = new Set(tokenize(doc));
  let hit = 0;
  for (const t of q) if (d.has(t)) hit += 1;
  return hit / q.size;
}

export function upsertDoc(doc: Omit<VaultDoc, "vector"> & { vector?: number[]; absPath?: string }) {
  if (doc.absPath) assertInJob(doc.slate, doc.absPath);
  const file = load(doc.slate);
  const vector =
    doc.vector ??
    (doc.absPath ? mix(embedText(doc.text), embedFile(doc.slate, doc.absPath)) : embedText(doc.text));
  const next: VaultDoc = {
    id: doc.id,
    slate: doc.slate,
    modality: doc.modality,
    shotId: doc.shotId,
    rel: doc.rel ?? (doc.absPath ? relInJob(doc.slate, doc.absPath) : undefined),
    text: doc.text,
    vector,
  };
  file.docs = file.docs.filter((d) => d.id !== next.id);
  file.docs.push(next);
  save(file);
  return next;
}

function mix(a: number[], b: number[]) {
  return l2(a.map((x, i) => x * 0.45 + (b[i] ?? 0) * 0.55));
}

export function recall(
  slate: string,
  query: string,
  opts?: { modality?: Modality; shotId?: string; k?: number },
): VaultHit[] {
  resolveInJob(slate, "vault.json");
  const file = load(slate);
  const qv = embedText(query);
  const ranked: VaultHit[] = [];
  for (const doc of file.docs) {
    if (doc.slate !== slate) throw new Error("vault leaked a foreign slate");
    if (opts?.modality && doc.modality !== opts.modality) continue;
    const cos = cosine(qv, doc.vector);
    const lex = lexical(query, doc.text);
    const sameShot = opts?.shotId && doc.shotId === opts.shotId ? 1 : 0;
    const score = cos * 0.55 + lex * 0.25 + sameShot * 0.2;
    ranked.push({
      id: doc.id,
      slate: doc.slate,
      modality: doc.modality,
      shotId: doc.shotId,
      rel: doc.rel,
      text: doc.text.slice(0, 180),
      score,
      cosine: cos,
      lexical: lex,
    });
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, opts?.k ?? 5);
}

export function vaultStats(slate: string) {
  const file = load(slate);
  const modalities: Record<string, number> = {};
  for (const d of file.docs) modalities[d.modality] = (modalities[d.modality] ?? 0) + 1;
  return { slate, isolated: true as const, docs: file.docs.length, modalities };
}

export function indexPlanTexts(slate: string, nodes: { id: string; text: string; shotId?: string }[]) {
  for (const n of nodes) {
    upsertDoc({
      id: `text:${n.id}`,
      slate,
      modality: "text",
      shotId: n.shotId,
      text: n.text,
    });
  }
}
