import type { Vec3 } from "./types";

export const CAMERA_CHECKS = [
  "camera_aimed_at_hero", "camera_occluded", "hero_on_screen",
] as const;

export type CameraCheckId = typeof CAMERA_CHECKS[number];
export type CheckResult = { id: string; ok: boolean; detail: string; required: boolean };

/** Blender-owned measurements, never positions inferred from a planner SceneState. */
export type Observation = {
  protocol: "astra.protocol.v2";
  blender: string;
  frame: number;
  hero: {
    name: string;
    meshes: string[];
    maskId: 2;
    location: Vec3;
    bounds: { min: Vec3; max: Vec3 };
    /** Normalized image coordinates, origin top-left. Null without PIL evidence. */
    screenPos: [number, number] | null;
  } | null;
  camera: {
    name: string;
    location: Vec3;
    forward: Vec3;
    aimAngleDeg: number | null;
    /** True means blocked; null means not measured. */
    occluded: boolean | null;
    blocker: string | null;
    evaluated: boolean;
  } | null;
  pixelEvidence: {
    source: "PIL";
    maskId: 2;
    frame: number;
    camera: string;
    meshes: string[];
    path: string;
    sha256: string;
    width: number;
    height: number;
    pixelCount: number;
    framePath: string;
    frameSha256: string;
  } | null;
  errors: string[];
};

/** Adapt a headless receipt. Geometry-only evidence keeps screenPos=null. */
export function observe(evidence: Observation): Observation {
  return structuredClone(evidence);
}

/** These checks report the receipt; Python remeasures before every animation. */
export function runChecks(
  observation: Observation,
  ids: readonly string[] = CAMERA_CHECKS,
): CheckResult[] {
  const { hero, camera, pixelEvidence: pixels } = observation;
  const geometry = observation.protocol === "astra.protocol.v2"
    && Boolean(hero?.meshes.length) && hero?.maskId === 2 && camera?.evaluated === true;
  const angle = camera?.aimAngleDeg;
  const position = hero?.screenPos;
  const pixelOk = geometry && pixels?.source === "PIL" && pixels.maskId === 2
    && pixels.frame === observation.frame && pixels.camera === camera?.name
    && JSON.stringify(pixels.meshes) === JSON.stringify(hero?.meshes)
    && Number.isInteger(pixels.pixelCount) && pixels.pixelCount >= 16
    && Number.isInteger(pixels.width) && pixels.width > 0
    && Number.isInteger(pixels.height) && pixels.height > 0
    && pixels.pixelCount <= pixels.width * pixels.height
    && /^[a-f0-9]{64}$/.test(pixels.sha256) && Boolean(pixels.path)
    && position?.length === 2
    && position.every((v) => Number.isFinite(v) && v >= 0.25 && v <= 0.75);
  const table: Record<CameraCheckId, { ok: boolean; detail: string }> = {
    camera_aimed_at_hero: {
      ok: geometry && typeof angle === "number" && Number.isFinite(angle) && angle >= 0 && angle <= 15,
      detail: `evaluated hero bbox aim angle=${angle ?? "unmeasured"}; maximum=15 degrees`,
    },
    camera_occluded: {
      ok: geometry && camera?.occluded === false,
      detail: `occluded=${camera?.occluded ?? "unmeasured"}; blocker=${camera?.blocker ?? "none"}`,
    },
    hero_on_screen: {
      ok: Boolean(pixelOk),
      detail: `PIL centroid=${position ?? "unmeasured"}; pixels=${pixels?.pixelCount ?? 0}; centre region=[0.25,0.75]`,
    },
  };
  return ids.map((id) => ({
    id,
    ...(Object.prototype.hasOwnProperty.call(table, id) ? table[id as CameraCheckId] : { ok: false, detail: "unknown check" }),
    required: id === "hero_on_screen",
  }));
}
