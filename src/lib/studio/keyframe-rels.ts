export type KeyframeNode = {
  id: string;
  shotId: string;
  at: string;
  rel: string;
  x: number;
  y: number;
};

const COL = 220;
const ROW = 168;

export function keyframeRelPaths(shot: { id: string; keyframePositions?: string }): string[] {
  const marks = (shot.keyframePositions ?? "").split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  if (marks.length >= 2) {
    return marks.map((_, i) => `stills/${shot.id}.kf-${String(i).padStart(2, "0")}.png`);
  }
  return [`stills/${shot.id}.png`];
}

/** One column per location. Inside a shot, keyframes stack in order. */
export function layoutKeyframes(
  shots: { id: string; location?: string; keyframePositions?: string }[],
): KeyframeNode[] {
  const nodes: KeyframeNode[] = [];
  let col = 0;
  let row = 0;
  let prev = "";
  for (const shot of shots) {
    const loc = shot.location ?? "";
    if (prev && loc !== prev) {
      col += 1;
      row = 0;
    }
    prev = loc;
    const marks = (shot.keyframePositions ?? "").split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    const rels = keyframeRelPaths(shot);
    rels.forEach((rel, i) => {
      nodes.push({
        id: `${shot.id}:${i}`,
        shotId: shot.id,
        at: marks[i] ?? "",
        rel,
        x: 48 + col * COL,
        y: 48 + row * ROW,
      });
      row += 1;
    });
  }
  return nodes;
}

export type OwnBoard = { id: string; label: string; rel?: string; x: number; y: number };

/** Character, place, and prop sheets sit beside the keyframe chain. They are not wired into the cut. */
export function layoutOwnBoards(opts: {
  characters: { id: string; name: string }[];
  locations: string[];
  propCount?: number;
  props?: string[];
  buildings?: { era: string; types: string[] }[];
  right: number;
}): OwnBoard[] {
  const x = opts.right + 240;
  const items: { id: string; label: string; rel?: string }[] = [];
  for (const c of opts.characters) {
    items.push({ id: `char:${c.id}`, label: c.name, rel: `portraits/boards/${c.id}.angles.png` });
  }
  for (const loc of [...new Set(opts.locations.filter(Boolean))]) {
    items.push({ id: `scene:${loc}`, label: `場景：${loc}` });
  }
  for (const building of opts.buildings ?? []) {
    items.push({ id: `building:${building.era}`, label: `建築：${building.era}`, rel: `assets/boards/scene-${building.era.trim().replace(/[\s/\\]+/g, "-")}.png` });
  }
  for (const [i, name] of (opts.props ?? []).entries()) {
    items.push({ id: `prop:${name}`, label: `道具：${name}`, rel: `assets/${String(i + 1).padStart(2, "0")}-${name.trim().replace(/[\s/\\]+/g, "-")}.png` });
  }
  if (!opts.props && (opts.propCount ?? 0) > 0) {
    items.push({ id: "props", label: "道具", rel: "assets/boards/props-01.png" });
  }
  return items.map((item, i) => ({ ...item, x, y: 48 + i * 200 }));
}

/** Use only paths owned by this episode; never expose a foreign absolute file. */
export function episodeImageRel(file: string, jobId: string): string | undefined {
  const normalized = file.replace(/\\/g, "/");
  const marker = `/data/jobs/${jobId}/`;
  const rel = normalized.includes(marker) ? normalized.split(marker)[1]! : normalized;
  const root = rel.split("/")[0];
  if (rel.startsWith("/") || rel.split("/").some((part) => part === "..") || !root || !["boards", "stills", "assets", "portraits"].includes(root)) return undefined;
  return rel;
}

export function storyboardItems(cells: { shotId: string; at: string; file: string; board?: string }[], jobId: string) {
  return cells.flatMap((cell, i) => {
    const rel = episodeImageRel(cell.file, jobId);
    return rel ? [{ id: `storyboard:${i}`, shotId: cell.shotId, label: `分鏡 ${cell.shotId} ${cell.at}`, at: cell.at, rel, board: cell.board ? episodeImageRel(cell.board, jobId) : undefined }] : [];
  });
}

/** Chau 0927：H3 refs 收據嘅 UI 讀法——motion/SHxx.h3_plan.json 真源喺 pipeline
 *  側，呢個只係畫布／畫簿呈現層嘅 shape（欄位全部可缺，唔代言 backend）。 */
export type H3PlanSlot = { index?: number; kind?: string; bind?: string; file?: string; role?: string };

export type H3PlanFile = {
  shotId?: string;
  form?: string;
  positions?: string;
  slots?: { audio?: H3PlanSlot[]; photo?: H3PlanSlot[]; video?: H3PlanSlot[] };
  keyframes?: { start?: { at?: string; file?: string }; end?: { at?: string; file?: string } };
};

/** 404／爛 json 一律靜默跳過（收據未落盤唔阻 UI）。 */
export async function fetchH3Plan(jobId: string, shotId: string): Promise<H3PlanFile | null> {
  try {
    const res = await fetch(`/api/media/${jobId}/motion/${shotId}.h3_plan.json`);
    if (!res.ok) return null;
    const plan: unknown = await res.json();
    return plan && typeof plan === "object" ? (plan as H3PlanFile) : null;
  } catch {
    return null;
  }
}

/** Chau 0927（統一原則：每一級生成物都要見到佢食咗咩 refs）：KF 嗰級讀 pipeline
 *  寫嘅 stills/SHxx.u15_edit.json（record.base＋record.refs）。收據未落盤＝null，
 *  UI 靜默跳過顯示「refs 未記錄」。sheet 切格收據（stills/boards/keyframes-*
 *  帶 hash）media route 冇 listing，client 到唔到——以呢個穩定路徑為準。 */
export type KfEditRecord = { base?: string; refs?: string[] };

export async function fetchKfEditRecord(jobId: string, shotId: string): Promise<KfEditRecord | null> {
  try {
    const res = await fetch(`/api/media/${jobId}/stills/${shotId}.u15_edit.json`);
    if (!res.ok) return null;
    const rec: unknown = await res.json();
    return rec && typeof rec === "object" ? (rec as KfEditRecord) : null;
  } catch {
    return null;
  }
}

/** 收據欄位（base/refs）多數係絕對路徑——抽返做本 job rel 先攞到 media URL。
 *  淨係收本 job 產物根；齋 basename／外路徑唔作數（呈現層唔估 resolve）。 */
export function receiptFileToRel(file: string, jobId: string): string | undefined {
  const normalized = file.replace(/\\/g, "/");
  const marker = `/data/jobs/${jobId}/`;
  const rel = normalized.includes(marker) ? normalized.split(marker)[1]! : normalized;
  if (!rel || rel.startsWith("/") || rel.split("/").some((part) => part === "..")) return undefined;
  const root = rel.split("/")[0];
  if (!["stills", "boards", "assets", "portraits", "blockout", "audio", "motion"].includes(root)) return undefined;
  return rel;
}
