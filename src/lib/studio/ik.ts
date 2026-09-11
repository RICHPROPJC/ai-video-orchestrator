import type { Vec2 } from "./types";

export function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

export function lerpVec(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
}

export function twoBoneIK(
  root: Vec2,
  lenA: number,
  lenB: number,
  target: Vec2,
  bendSign: 1 | -1,
): { mid: Vec2; end: Vec2 } {
  const dx = target.x - root.x;
  const dy = target.y - root.y;
  const raw = Math.hypot(dx, dy) || 0.0001;
  const max = lenA + lenB - 0.4;
  const min = Math.abs(lenA - lenB) + 0.4;
  const dist = Math.min(max, Math.max(min, raw));
  const nx = dx / raw;
  const ny = dy / raw;
  const cosA = (lenA * lenA + dist * dist - lenB * lenB) / (2 * lenA * dist);
  const angleA = Math.acos(Math.min(1, Math.max(-1, cosA)));
  const base = Math.atan2(dy, dx);
  const mid: Vec2 = {
    x: root.x + Math.cos(base + bendSign * angleA) * lenA,
    y: root.y + Math.sin(base + bendSign * angleA) * lenA,
  };
  const end: Vec2 = { x: root.x + nx * dist, y: root.y + ny * dist };
  return { mid, end };
}

export type LimbPose = {
  hip: Vec2;
  shoulder: Vec2;
  kneeL: Vec2;
  kneeR: Vec2;
  footL: Vec2;
  footR: Vec2;
  elbowL: Vec2;
  elbowR: Vec2;
  handL: Vec2;
  handR: Vec2;
  head: Vec2;
};

export function poseCharacter(opts: {
  hip: Vec2;
  facing: number;
  scale: number;
  footL: Vec2;
  footR: Vec2;
  handL: Vec2;
  handR: Vec2;
}): LimbPose {
  const { hip, facing, scale, footL, footR, handL, handR } = opts;
  const dir = facing >= 0 ? 1 : -1;
  const shoulder: Vec2 = { x: hip.x, y: hip.y - 38 * scale };
  const head: Vec2 = { x: hip.x + dir * 2, y: shoulder.y - 22 * scale };
  const thigh = 28 * scale;
  const shin = 26 * scale;
  const upper = 22 * scale;
  const forearm = 20 * scale;
  const leftLeg = twoBoneIK(hip, thigh, shin, footL, 1);
  const rightLeg = twoBoneIK(hip, thigh, shin, footR, -1);
  const leftArm = twoBoneIK(shoulder, upper, forearm, handL, -1);
  const rightArm = twoBoneIK(shoulder, upper, forearm, handR, 1);
  return {
    hip,
    shoulder,
    head,
    kneeL: leftLeg.mid,
    kneeR: rightLeg.mid,
    footL: leftLeg.end,
    footR: rightLeg.end,
    elbowL: leftArm.mid,
    elbowR: rightArm.mid,
    handL: leftArm.end,
    handR: rightArm.end,
  };
}

export function walkTargets(
  start: Vec2,
  end: Vec2,
  t: number,
  stride: number,
): { hip: Vec2; footL: Vec2; footR: Vec2; handL: Vec2; handR: Vec2 } {
  const hip = lerpVec(start, end, t);
  const phase = t * Math.PI * 2;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const ang = Math.atan2(dy, dx);
  const fx = Math.cos(ang);
  const fy = Math.sin(ang);
  const px = -fy;
  const py = fx;
  const step = Math.sin(phase) * stride;
  const opposite = Math.sin(phase + Math.PI) * stride;
  const bounce = Math.abs(Math.sin(phase)) * 3;
  return {
    hip: { x: hip.x, y: hip.y - bounce },
    footL: {
      x: hip.x + fx * step + px * 6,
      y: hip.y + 52 + fy * step + py * 6,
    },
    footR: {
      x: hip.x + fx * opposite - px * 6,
      y: hip.y + 52 + fy * opposite - py * 6,
    },
    handL: {
      x: hip.x + fx * opposite * 0.6 + px * 14,
      y: hip.y - 8 + fy * opposite * 0.4,
    },
    handR: {
      x: hip.x + fx * step * 0.6 - px * 14,
      y: hip.y - 8 + fy * step * 0.4,
    },
  };
}
