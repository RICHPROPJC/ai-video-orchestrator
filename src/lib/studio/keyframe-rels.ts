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
