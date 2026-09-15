import type { ShotSize, Vec3 } from "./types";

export type CameraAngle = "eye" | "high" | "low";
export type CameraSide = "frontal" | "leftQuarter" | "rightQuarter";
export type ShotCamera = { pos: Vec3; lookAt: Vec3; lensMm: number };

/** Geometry constants, not film content: boards picks the grammar, the desk does
 *  the arithmetic so every camera is one a mark ray can actually reach. */
const DOLLY_Y: Record<ShotSize, number> = { wide: -9, full: -6.5, medium: -5, closeup: -3.2, insert: -2.6 };
const LENS_MM: Record<ShotSize, number> = { wide: 24, full: 28, medium: 35, closeup: 50, insert: 65 };
const EYE_Z: Record<CameraAngle, number> = { eye: 1.7, high: 2.6, low: 1.1 };
const SIDE_X: Record<CameraSide, number> = { frontal: 0, leftQuarter: -1.4, rightQuarter: 1.4 };
const LOOK_AT: Vec3 = { x: 0.2, y: 0.4, z: 1.1 };
const CLOSEUP_LOOK_Z = 1.4;

/** Every camera keeps a downward tilt: a level lens makes the upper half of the
 *  frame ascend, and a hand mark above centre then has no floor to land on. */
const MIN_TILT_DOWN = 0.35;

export const SHOT_SIZES: ShotSize[] = ["wide", "full", "medium", "closeup", "insert"];
export const CAMERA_ANGLES: CameraAngle[] = ["eye", "high", "low"];
export const CAMERA_SIDES: CameraSide[] = ["frontal", "leftQuarter", "rightQuarter"];

export function cameraFor(size: ShotSize, angle: CameraAngle, side: CameraSide): ShotCamera {
  const posZ = EYE_Z[angle];
  const lookZ = size === "closeup" ? CLOSEUP_LOOK_Z : LOOK_AT.z;
  return {
    pos: { x: SIDE_X[side], y: DOLLY_Y[size], z: posZ },
    lookAt: { x: LOOK_AT.x, y: LOOK_AT.y, z: Math.min(lookZ, posZ - MIN_TILT_DOWN) },
    lensMm: LENS_MM[size],
  };
}

// --- the unprojection blender.ts does, ported so tests can prove a mark is reachable ---

const SENSOR_MM = 36; // bpy.data.cameras.new() default, sensor_fit AUTO

function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function scale(a: Vec3, k: number): Vec3 {
  return { x: a.x * k, y: a.y * k, z: a.z * k };
}

function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function norm(a: Vec3): Vec3 {
  const n = Math.hypot(a.x, a.y, a.z) || 1;
  return scale(a, 1 / n);
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return add(a, scale(sub(b, a), t));
}

/** direction.to_track_quat('-Z','Y'): local −Z looks along the aim, local +Y
 *  stays as close to world up as it can. Returned as the three world axes. */
export function cameraBasis(pos: Vec3, lookAt: Vec3): { x: Vec3; y: Vec3; z: Vec3 } {
  const forward = norm(sub(lookAt, pos));
  const z = scale(forward, -1);
  const worldUp: Vec3 = { x: 0, y: 0, z: 1 };
  const dot = worldUp.z * z.z;
  const y = norm(sub(worldUp, scale(z, dot)));
  return { x: cross(y, z), y, z };
}

/** cam.data.view_frame(scene) in world space, Blender's order:
 *  [right-top, right-bottom, left-bottom, left-top]. */
export function viewFrame(cam: ShotCamera, width: number, height: number): Vec3[] {
  const basis = cameraBasis(cam.pos, cam.lookAt);
  const halfX = SENSOR_MM / 2 / cam.lensMm; // AUTO fit: the long side takes the sensor
  const halfY = halfX * (height / width);
  const corner = (sx: number, sy: number) =>
    add(cam.pos, add(add(scale(basis.x, sx * halfX), scale(basis.y, sy * halfY)), scale(basis.z, -1)));
  return [corner(1, 1), corner(1, -1), corner(-1, -1), corner(-1, 1)];
}

export type FloorHit = { point: Vec3; t: number };

/** u,v in [0,1], v measured from the TOP of frame (painter convention: y% down).
 *  Throws exactly where blender.ts raises SystemExit, so a bad mark fails here
 *  in a unit test instead of mid-render. */
export function unprojectToPlane(
  cam: ShotCamera,
  u: number,
  v: number,
  zPlane: number,
  size: { width: number; height: number },
): FloorHit {
  const fr = viewFrame(cam, size.width, size.height);
  const top = lerp(fr[3]!, fr[0]!, u);
  const bot = lerp(fr[2]!, fr[1]!, u);
  const pt = lerp(top, bot, v);
  const o = cam.pos;
  const d = sub(pt, o);
  if (d.z >= -1e-6) {
    throw new Error(`mark ray does not hit the plane: u=${u} v=${v} (ray is level or rising)`);
  }
  const t = (zPlane - o.z) / d.z;
  if (t <= 0) throw new Error(`mark ray hits the plane behind the lens: u=${u} v=${v} t=${t}`);
  return { point: add(o, scale(d, t)), t };
}

/** Inverse of unprojectToPlane: a world point back to frame percent. Marks that
 *  are projected from a known world position can always be unprojected again. */
export function projectToFrame(
  cam: ShotCamera,
  world: Vec3,
  size: { width: number; height: number },
): { u: number; v: number } {
  const basis = cameraBasis(cam.pos, cam.lookAt);
  const rel = sub(world, cam.pos);
  const lx = rel.x * basis.x.x + rel.y * basis.x.y + rel.z * basis.x.z;
  const ly = rel.x * basis.y.x + rel.y * basis.y.y + rel.z * basis.y.z;
  const lz = rel.x * basis.z.x + rel.y * basis.z.y + rel.z * basis.z.z;
  const depth = -lz;
  if (depth <= 1e-6) throw new Error("point is behind the lens");
  const halfX = SENSOR_MM / 2 / cam.lensMm;
  const halfY = halfX * (size.height / size.width);
  return { u: (lx / (halfX * depth) + 1) / 2, v: (1 - ly / (halfY * depth)) / 2 };
}
