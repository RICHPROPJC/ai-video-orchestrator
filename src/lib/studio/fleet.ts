import { resolveCrewEndpoint } from "./crew-llm";
import type { SlateConfig } from "./config";

const PROBE_MS = 4000;

export type FleetStatus = "UP" | "DOWN" | "MISMATCH" | "UNCONFIG";

export type FleetRow = {
  id: string;
  label: string;
  configKey: string;
  url: string;
  required: boolean;
  unconfigured: boolean;
  up: boolean;
  mismatch: boolean;
  status: FleetStatus;
  configured: string[];
  live: string[];
  vram: string;
  error: string;
};

export type FleetReport = {
  probedAt: string;
  ready: boolean;
  rows: FleetRow[];
  blockers: string[];
  /** Optional layers that are down. Nex DOWN covers with pictureQc 27B — not a blocker. */
  degraded: string[];
};

export type FetchLike = (input: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export function normalizeModel(id: string): string {
  return id.trim().toLowerCase().replace(/\.(safetensors|gguf|bin|pt|ckpt)$/i, "");
}

/** Exact stem match — qwen3.6-35b vs qwen38 is a miss, not a substring hit. */
export function modelMatches(configured: string, live: string[]): boolean {
  const want = normalizeModel(configured);
  if (!want) return true;
  return live.some((id) => {
    const have = normalizeModel(id);
    return have === want || have.endsWith(`/${want}`) || want.endsWith(`/${have}`);
  });
}

function modelsFrom(json: unknown): string[] {
  if (!json || typeof json !== "object") return [];
  const o = json as Record<string, unknown>;
  const out: string[] = [];
  if (typeof o.model === "string" && o.model.trim()) out.push(o.model.trim());
  if (Array.isArray(o.data)) {
    for (const row of o.data) {
      if (row && typeof row === "object" && typeof (row as { id?: unknown }).id === "string") {
        const id = (row as { id: string }).id.trim();
        if (id) out.push(id);
      }
    }
  }
  if (Array.isArray(o.models)) {
    for (const m of o.models) if (typeof m === "string" && m.trim()) out.push(m.trim());
  }
  return [...new Set(out)];
}

function vramFrom(json: unknown): string {
  if (!json || typeof json !== "object") return "";
  const o = json as Record<string, unknown>;
  if (typeof o.vram_gb === "number" && Number.isFinite(o.vram_gb)) return `${o.vram_gb} GB`;
  const devices = o.devices;
  if (!Array.isArray(devices) || !devices[0] || typeof devices[0] !== "object") return "";
  const d = devices[0] as Record<string, unknown>;
  const total = Number(d.vram_total ?? d.torch_vram_total ?? 0);
  const free = Number(d.vram_free ?? d.torch_vram_free ?? 0);
  if (!(total > 0)) return "";
  return `${(free / 1e9).toFixed(1)}/${(total / 1e9).toFixed(1)} GB`;
}

type ProbeHit = { ok: boolean; json: unknown; error: string };

async function getJson(fetchImpl: FetchLike, url: string): Promise<ProbeHit> {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(PROBE_MS) });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      json = null;
    }
    if (!res.ok) return { ok: false, json, error: `HTTP ${res.status}` };
    return { ok: true, json, error: "" };
  } catch (error) {
    return { ok: false, json: null, error: error instanceof Error ? error.message : String(error) };
  }
}

async function probeHost(fetchImpl: FetchLike, url: string): Promise<{
  up: boolean;
  live: string[];
  vram: string;
  error: string;
}> {
  const base = url.replace(/\/$/, "");
  const [health, models, stats] = await Promise.all([
    getJson(fetchImpl, `${base}/health`),
    getJson(fetchImpl, `${base}/v1/models`),
    getJson(fetchImpl, `${base}/system_stats`),
  ]);
  const live = [...modelsFrom(health.json), ...modelsFrom(models.json), ...modelsFrom(stats.json)];
  const vram = vramFrom(health.json) || vramFrom(stats.json) || vramFrom(models.json);
  const up = health.ok || models.ok || stats.ok;
  const error = up ? "" : [health.error, models.error, stats.error].filter(Boolean)[0] ?? "unreachable";
  return { up, live: [...new Set(live)], vram, error };
}

function statusOf(row: Omit<FleetRow, "status">): FleetStatus {
  if (row.unconfigured) return "UNCONFIG";
  if (!row.up) return "DOWN";
  if (row.mismatch) return "MISMATCH";
  return "UP";
}

function finish(partial: Omit<FleetRow, "status">): FleetRow {
  return { ...partial, status: statusOf(partial) };
}

async function rowFor(
  fetchImpl: FetchLike,
  opts: {
    id: string;
    label: string;
    configKey: string;
    url: string;
    required: boolean;
    configured: string[];
    skipModelCheck?: boolean;
  },
): Promise<FleetRow> {
  const url = opts.url.trim();
  if (!url) {
    return finish({
      id: opts.id,
      label: opts.label,
      configKey: opts.configKey,
      url: "",
      required: opts.required,
      unconfigured: true,
      up: false,
      mismatch: false,
      configured: opts.configured.filter(Boolean),
      live: [],
      vram: "",
      error: "unconfigured",
    });
  }
  const hit = await probeHost(fetchImpl, url);
  const configured = opts.configured.map((s) => s.trim()).filter(Boolean);
  const mismatch = Boolean(
    hit.up && !opts.skipModelCheck && configured.some((name) => !modelMatches(name, hit.live)),
  );
  return finish({
    id: opts.id,
    label: opts.label,
    configKey: opts.configKey,
    url: url.replace(/\/$/, ""),
    required: opts.required,
    unconfigured: false,
    up: hit.up,
    mismatch,
    configured,
    live: hit.live,
    vram: hit.vram,
    error: hit.error,
  });
}

export function nexCoverLine(cfg: SlateConfig, nex: FleetRow | undefined): string {
  if (!nex || nex.unconfigured || (nex.up && !nex.mismatch)) return "";
  const cover = `${cfg.pictureQc.model} ${cfg.pictureQc.endpoint}`;
  return `nex ${nex.status} — covering ${cover}`;
}

export function fleetBlockers(rows: FleetRow[]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    // Optional layers (nex / soundQc / ocr / embed): DOWN → degraded, never freeze READY.
    if (!row.required) continue;
    if (row.unconfigured) out.push(`${row.id} unconfigured`);
    else if (!row.up) out.push(`${row.id} DOWN ${row.error}`.trim());
    else if (row.mismatch) {
      const miss = row.configured.filter((c) => !modelMatches(c, row.live));
      out.push(`${row.id} config ${miss.join(",")} ≠ live ${row.live.join(",") || "(none)"}`);
    }
  }
  return out;
}

/** Which required layers a produce gate needs. boards/blockout＝淨 crew（阿文／阿圖／Blender）；
 *  stills＝+U1.5+pictureQc；motion＝+H3；full＝+tts。 */
export type FleetGate = "boards" | "stills" | "motion" | "full";

export function layersForGate(gate: FleetGate): Set<string> {
  if (gate === "boards") return new Set(["crew"]);
  if (gate === "stills") return new Set(["crew", "stills", "pictureQc"]);
  if (gate === "motion") return new Set(["crew", "stills", "pictureQc", "motion"]);
  return new Set(["crew", "stills", "pictureQc", "motion", "tts"]);
}

export function blockersForGate(rows: FleetRow[], gate: FleetGate): string[] {
  const need = layersForGate(gate);
  // Re-scope required for this gate — boards only fails if crew is down.
  return fleetBlockers(rows.map((r) => ({ ...r, required: need.has(r.id) })));
}

/** Amber lines for optional layers that are configured but not healthy. */
export function fleetDegraded(rows: FleetRow[], cfg: SlateConfig): string[] {
  const out: string[] = [];
  const nex = rows.find((r) => r.id === "nex");
  const cover = nexCoverLine(cfg, nex);
  if (cover) out.push(cover);
  for (const row of rows) {
    if (row.required || row.id === "nex") continue;
    if (row.unconfigured) continue;
    if (!row.up || row.mismatch) {
      out.push(`${row.id} ${row.status} ${row.error || row.configured.filter((c) => !modelMatches(c, row.live)).join(",")}`.trim());
    }
  }
  return out;
}

export function formatFleet(report: FleetReport): string {
  const head = [
    "LAYER".padEnd(12),
    "STATUS".padEnd(10),
    "URL".padEnd(36),
    "CONFIG".padEnd(28),
    "LIVE".padEnd(28),
    "VRAM",
  ].join(" ");
  const lines = [head];
  for (const row of report.rows) {
    const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));
    lines.push(
      [
        clip(row.id, 12),
        clip(row.status, 10),
        clip(row.url || "—", 36),
        clip(row.configured.join(",") || "—", 28),
        clip(row.live.join(",") || "—", 28),
        row.vram || "—",
      ].join(" "),
    );
  }
  lines.push(`READY ${report.ready ? "yes" : "no"}`);
  for (const d of report.degraded ?? []) lines.push(`AMBER ${d}`);
  for (const b of report.blockers) lines.push(`RED   ${b}`);
  return lines.join("\n");
}

export async function probeFleet(cfg: SlateConfig, fetchImpl: FetchLike = fetch): Promise<FleetReport> {
  const crewUrl = resolveCrewEndpoint(cfg.crew);
  const rows = await Promise.all([
    rowFor(fetchImpl, {
      id: "crew",
      label: "crew LLM",
      configKey: "crew.endpoint",
      url: crewUrl,
      required: true,
      configured: [cfg.crew.writerModel, cfg.crew.boardsModel, cfg.crew.blenderModel],
    }),
    rowFor(fetchImpl, {
      id: "stills",
      label: "U1.5 /edit",
      configKey: "stills.url",
      url: cfg.stills.url,
      required: true,
      configured: [cfg.stills.checkpoint],
    }),
    rowFor(fetchImpl, {
      id: "motion",
      label: "H3 R2V",
      configKey: "motion.comfyUrl",
      url: cfg.motion.comfyUrl,
      required: true,
      configured: [cfg.motion.checkpoint],
      skipModelCheck: true,
    }),
    rowFor(fetchImpl, {
      id: "tts",
      label: "AuK TTS",
      configKey: "tts.endpoint",
      url: cfg.tts.endpoint,
      required: true,
      configured: [cfg.tts.model],
    }),
    rowFor(fetchImpl, {
      id: "pictureQc",
      label: "picture QC",
      configKey: "pictureQc.endpoint",
      url: cfg.pictureQc.endpoint,
      required: true,
      configured: [cfg.pictureQc.model],
    }),
    rowFor(fetchImpl, {
      id: "nex",
      label: "Nex 3D/tool",
      configKey: "nex.endpoint",
      url: cfg.nex.endpoint,
      required: false,
      configured: [cfg.nex.model],
    }),
    rowFor(fetchImpl, {
      id: "soundQc",
      label: "SenseVoice",
      configKey: "soundQc.endpoint",
      url: cfg.soundQc.endpoint,
      required: false,
      configured: [cfg.soundQc.model],
    }),
    rowFor(fetchImpl, {
      id: "ocr",
      label: "OCR",
      configKey: "ocr.endpoint",
      url: cfg.ocr.endpoint,
      required: false,
      configured: [cfg.ocr.model],
    }),
    rowFor(fetchImpl, {
      id: "embed",
      label: "WeMM embed",
      configKey: "embed.endpoint",
      url: cfg.embed.endpoint,
      required: false,
      configured: [cfg.embed.model],
    }),
  ]);
  const blockers = fleetBlockers(rows);
  const degraded = fleetDegraded(rows, cfg);
  return {
    probedAt: new Date().toISOString(),
    ready: blockers.length === 0,
    rows,
    blockers,
    degraded,
  };
}

export function assertFleetReady(report: FleetReport, gate: FleetGate = "full"): void {
  const blockers = blockersForGate(report.rows, gate);
  if (blockers.length === 0) return;
  const gated: FleetReport = { ...report, ready: false, blockers };
  throw new Error(`fleet not ready for ${gate}\n${formatFleet(gated)}`);
}

export function gateReady(report: FleetReport, gate: FleetGate): boolean {
  return blockersForGate(report.rows, gate).length === 0;
}
