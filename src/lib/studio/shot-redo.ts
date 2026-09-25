import type { Shot } from "./types";

export const SHOT_ID_RE = /^SH\d{2,}$/;

/** Index of the named shot. -1 means no --shot, so resume keep stays as it is. */
export function redoFromIndex(ids: string[], shot?: string): number {
  if (!shot) return -1;
  const i = ids.indexOf(shot);
  if (i < 0) {
    throw new Error(`--shot ${shot}：呢段冇呢鏡 — 唔靜靜哋燒成個 slate`);
  }
  return i;
}

/** Named shot and every later shot in this list must be redone. Earlier ids stay. */
export function forcesRedo(ids: string[], id: string, shot?: string): boolean {
  const from = redoFromIndex(ids, shot);
  if (from < 0) return false;
  const at = ids.indexOf(id);
  return at >= from;
}

/** Boards owns the shot line. A rewrite updates the shot and its require together. */
export function applyBoardsDecision(
  shot: Shot,
  decision: { location?: string; action?: string; angle?: "eye" | "high" | "low"; negatives?: string[] },
): Shot {
  const require = { ...(shot.require ?? {}) };
  const next: Shot = { ...shot, require };
  if (decision.location) {
    next.location = decision.location;
    require.location = decision.location;
  }
  if (decision.action) {
    next.action = decision.action;
    require.action = decision.action;
  }
  if (decision.angle) require.angle = decision.angle;
  if (decision.negatives?.length) require.negatives = decision.negatives;
  return next;
}
