/** Scale only from evidence. A normalized SF3D box is not a size. */

export const CONFIRMED_PROPORTION = {
  knee: 0.25,
  waist: 0.55,
  chest: 0.72,
  shoulder: 0.82,
} as const;

export type ProportionAt = keyof typeof CONFIRMED_PROPORTION;

export type WorldPiece = {
  id: string;
  role: "character" | "scene" | "prop";
  glb: string;
  heightM?: number;
  sizeM?: number;
  sizeSource?: string;
  proportion?: { of: string; at: ProportionAt; source: string };
  heldBy?: string;
  support?: string;
};

export type ScaleRow = { id: string; meters: number; evidence: string };

/** Named pieces only. Call before the first image. Does not invent a size. */
export function piecesFromCallSheet(
  characters: { id: string; heightM?: number }[],
  shots: { location?: string; props?: { name: string; sizeM?: number; sizeSource?: string; proportion?: WorldPiece["proportion"]; heldBy?: string }[] }[],
): WorldPiece[] {
  const pieces: WorldPiece[] = characters.map((c) => ({ id: c.id, role: "character", glb: "", heightM: c.heightM }));
  const seen = new Set(pieces.map((p) => p.id));
  for (const shot of shots) {
    // shot.location is the frame's place name, not a building mesh. Do not send it to SF3D.
    for (const prop of shot.props ?? []) {
      if (seen.has(prop.name)) continue;
      seen.add(prop.name);
      pieces.push({
        id: prop.name,
        role: "prop",
        glb: "",
        sizeM: prop.sizeM,
        sizeSource: prop.sizeSource,
        proportion: prop.proportion,
        heldBy: prop.heldBy,
      });
    }
  }
  return pieces;
}

export function assertScales(pieces: WorldPiece[]): void {
  const scaled = resolveScales(pieces);
  if ("missing" in scaled) {
    throw new Error(`scale_missing: ${scaled.missing.join("；")}。要一條尺寸或者一句已確認比例，唔好用兩米盒。`);
  }
}

export function resolveScales(pieces: WorldPiece[]): { ok: ScaleRow[] } | { missing: string[] } {
  const byId = new Map(pieces.map((p) => [p.id, p]));
  const missing: string[] = [];
  const ok: ScaleRow[] = [];
  for (const piece of pieces) {
    if (piece.role === "character") {
      if (piece.sizeM && piece.sizeM > 0 && piece.sizeSource?.trim()) {
        ok.push({ id: piece.id, meters: piece.sizeM, evidence: piece.sizeSource.trim() });
      } else {
        missing.push(`${piece.id} 只有人偶比例 heightM，冇有來源嘅實際尺寸`);
      }
      continue;
    }
    if (piece.sizeM && piece.sizeM > 0 && piece.sizeSource?.trim()) {
      ok.push({ id: piece.id, meters: piece.sizeM, evidence: piece.sizeSource.trim() });
      continue;
    }
    if (piece.proportion?.source?.trim()) {
      const host = byId.get(piece.proportion.of);
      if (!host || host.role !== "character" || !host.sizeM || host.sizeM <= 0 || !host.sizeSource?.trim()) {
        missing.push(`${piece.id} 比例指去唔到 ${piece.proportion.of} 嘅有來源尺寸`);
        continue;
      }
      const meters = host.sizeM * CONFIRMED_PROPORTION[piece.proportion.at];
      ok.push({
        id: piece.id,
        meters,
        evidence: `${piece.proportion.source.trim()} (${piece.proportion.at} of ${host.id} ${host.sizeSource.trim()})`,
      });
      continue;
    }
    missing.push(`${piece.id} 冇有來源嘅尺寸`);
  }
  if (missing.length) return { missing };
  return { ok };
}

export type PlacedPiece = ScaleRow & {
  role: WorldPiece["role"];
  glb: string;
  x: number;
  y: number;
  z: number;
  support?: string;
  heldBy?: string;
};

/** One layout for the whole story. Scenes sit on z=0, spaced by their own height so they do not stack. */
export function placeWorld(pieces: WorldPiece[], scales: ScaleRow[]): PlacedPiece[] {
  const meters = new Map(scales.map((s) => [s.id, s]));
  const scenes = pieces.filter((p) => p.role === "scene");
  const out: PlacedPiece[] = [];
  let cursor = 0;
  for (const scene of scenes) {
    const row = meters.get(scene.id);
    if (!row) continue;
    out.push({ ...row, role: "scene", glb: scene.glb, x: cursor, y: 0, z: 0 });
    cursor += row.meters + 0.5;
  }
  const firstScene = out.find((p) => p.role === "scene");
  for (const person of pieces.filter((p) => p.role === "character")) {
    const row = meters.get(person.id);
    if (!row) continue;
    out.push({
      ...row,
      role: "character",
      glb: person.glb,
      x: firstScene ? firstScene.x : 0,
      y: -(row.meters),
      z: 0,
      support: firstScene?.id,
    });
  }
  for (const prop of pieces.filter((p) => p.role === "prop")) {
    const row = meters.get(prop.id);
    if (!row) continue;
    const holder = prop.heldBy ? out.find((p) => p.id === prop.heldBy && p.role === "character") : undefined;
    const support = out.find((p) => p.id === (prop.support ?? firstScene?.id) && p.role === "scene") ?? firstScene;
    if (holder) {
      out.push({
        ...row,
        role: "prop",
        glb: prop.glb,
        x: holder.x,
        y: holder.y + holder.meters * 0.4,
        z: holder.meters * CONFIRMED_PROPORTION.chest,
        heldBy: holder.id,
      });
    } else if (support) {
      out.push({
        ...row,
        role: "prop",
        glb: prop.glb,
        x: support.x,
        y: support.y,
        z: support.meters,
        support: support.id,
      });
    }
  }
  return out;
}

export type ShotAim = {
  id: string;
  lensMm: number;
  size: string;
  lookAtId?: string;
  hold: boolean;
};

/** A shot looks at a piece already in the world. No callsheet xyz. */
export function aimShot(
  shot: { id: string; lensMm: number; size: string; location?: string; heldPropId?: string },
  placed: PlacedPiece[],
): ShotAim {
  const held = shot.heldPropId ? placed.find((p) => p.id === shot.heldPropId) : undefined;
  const scene = shot.location ? placed.find((p) => p.id === shot.location && p.role === "scene") : undefined;
  const look = held ?? scene;
  if (!look) return { id: shot.id, lensMm: shot.lensMm, size: shot.size, hold: true };
  return { id: shot.id, lensMm: shot.lensMm, size: shot.size, lookAtId: look.id, hold: false };
}
