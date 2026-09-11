import type { Shot, Stance } from "./types";
import { projectToFrame, unprojectToPlane, type ShotCamera } from "./camera-presets";

export type Slot = "L" | "C" | "R";
export type Depth = "near" | "mid" | "far";

export type BlockingRequest = {
  characterId: string;
  slot: Slot;
  depth: Depth;
  facing: number;
  gait: Shot["marks"][number]["gait"];
  stance?: Stance;
  stanceEnd?: Stance;
  travelTo?: Slot;
};

/** Percent-of-frame grid. Feet carry the depth (they touch the floor), so every
 *  offset here is symmetric about the slot — blender averages L/R back to it. */
const SLOT_X: Record<Slot, number> = { L: 30, C: 50, R: 70 };
const DEPTH_SPREAD: Record<Depth, number> = { near: 4, mid: 0, far: -4 };
const BODY_Y: Record<Depth, number> = { near: 58, mid: 54, far: 50 };
/** A far figure covers less frame, so its offsets shrink with it — flat offsets
 *  put far hands above the horizon, where no ray can reach the hand plane. */
const DEPTH_SCALE: Record<Depth, number> = { near: 1.2, mid: 1, far: 0.7 };
const FOOT_DROP = 22;
const HAND_RISE = -8;
const CROUCH_HAND_DROP = 12;
const FOOT_SPREAD = 3;
const HAND_SPREAD = 6;

export const SLOTS: Slot[] = ["L", "C", "R"];
export const DEPTHS: Depth[] = ["near", "mid", "far"];
export const STANCES: Stance[] = ["stand", "lean", "crouch"];

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** near pushes a slot away from centre, far pulls it in; C stays on the axis. */
export function slotX(slot: Slot, depth: Depth): number {
  if (slot === "C") return SLOT_X.C;
  const away = slot === "R" ? 1 : -1;
  return SLOT_X[slot] + away * DEPTH_SPREAD[depth];
}

export function markFor(req: BlockingRequest): Shot["marks"][number] {
  const x = slotX(req.slot, req.depth);
  const bodyY = BODY_Y[req.depth];
  const scale = DEPTH_SCALE[req.depth];
  const footY = round1(bodyY + FOOT_DROP * scale);
  const stance = req.stance ?? "stand";
  const handY = round1(bodyY + (stance === "crouch" ? CROUCH_HAND_DROP : HAND_RISE) * scale);
  const endX = req.travelTo ? slotX(req.travelTo, req.depth) : x;
  return {
    characterId: req.characterId,
    start: { x, y: bodyY },
    end: { x: endX, y: bodyY },
    facing: req.facing,
    handL: { x: x - HAND_SPREAD, y: handY },
    handR: { x: x + HAND_SPREAD, y: handY },
    footL: { x: x - FOOT_SPREAD, y: footY },
    footR: { x: x + FOOT_SPREAD, y: footY },
    gait: req.gait,
    ...(req.stance ? { stance: req.stance } : {}),
    ...(req.stanceEnd ? { stanceEnd: req.stanceEnd } : {}),
  };
}

/** blender reads depth off the foot midpoint; the plow proxy off the hand
 *  midpoint. Both are unprojected, so tests check exactly these two. */
export function footMid(mark: Shot["marks"][number]): { u: number; v: number } {
  return { u: (mark.footL.x + mark.footR.x) / 200, v: (mark.footL.y + mark.footR.y) / 200 };
}

export function handMid(mark: Shot["marks"][number]): { u: number; v: number } {
  return { u: (mark.handL.x + mark.handR.x) / 200, v: (mark.handL.y + mark.handR.y) / 200 };
}

/** blender puts the hands on the 0.85·h plane, so the mark must be that point
 *  seen through this camera — a flat frame offset can land above the horizon,
 *  where the plow proxy's ray never reaches the plane. */
export const HAND_PLANE_OF_HEIGHT = 0.85;

export function placeHands(
  mark: Shot["marks"][number],
  cam: ShotCamera,
  heightM: number,
  size: { width: number; height: number },
): Shot["marks"][number] {
  const feet = footMid(mark);
  const ground = unprojectToPlane(cam, feet.u, feet.v, 0, size).point;
  const plane = HAND_PLANE_OF_HEIGHT * heightM;
  const seen = projectToFrame(cam, { x: ground.x, y: ground.y, z: plane }, size);
  // hundredths, not tenths: near the horizon a 0.1% rounding is decimetres of floor
  const y = round2(seen.v * 100);
  const x = round2(seen.u * 100);
  return { ...mark, handL: { x: round2(x - HAND_SPREAD), y }, handR: { x: round2(x + HAND_SPREAD), y } };
}
