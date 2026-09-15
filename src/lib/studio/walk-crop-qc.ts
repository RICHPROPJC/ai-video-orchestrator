export const WALK_CROP_RULE = "walk-crop.v1";

export type MaskBox = { top: number; bottom: number; left: number; right: number };

export type WalkSample = {
  t: number;
  rootX: number;
  footL: { x: number; y: number };
  footR: { x: number; y: number };
};

export type WalkCropIntent = {
  size: "full" | "wide" | "medium" | "closeup";
  gait?: "walk" | "plant";
  cameraOrder?: string[];
};

export type WalkCropEvidence = {
  intent: WalkCropIntent;
  boxes?: MaskBox[];
  walk?: WalkSample[];
  cameras?: string[];
};

export type WalkCropVerdict = {
  status: "GREEN" | "FAIL";
  rule: typeof WALK_CROP_RULE;
  fail_reasons: string[];
};

const HEAD_CUT = 0.12;
const LOCK = 0.02;

/** Flash Lite fail modes: cropped head, sliding root, camera order. Missing evidence ≠ PASS. */
export function judgeWalkCrop(evidence: WalkCropEvidence): WalkCropVerdict {
  const fail_reasons: string[] = [];
  const { intent, boxes, walk, cameras } = evidence;
  const full = intent.size === "full" || intent.size === "wide";

  if (full) {
    if (!boxes?.length) fail_reasons.push("cropped_head: missing_crop_evidence");
    else {
      for (const [i, box] of boxes.entries()) {
        if (box.top > HEAD_CUT) fail_reasons.push(`cropped_head: f${i} top=${box.top}`);
      }
    }
  }

  if (intent.gait === "walk") {
    if (!walk || walk.length < 3) fail_reasons.push("sliding_root: missing_walk_evidence");
    else {
      const span = Math.abs(walk[walk.length - 1]!.rootX - walk[0]!.rootX);
      let lockstep = 0;
      let plants = 0;
      for (let i = 1; i < walk.length; i += 1) {
        const dRoot = walk[i]!.rootX - walk[i - 1]!.rootX;
        const dL = walk[i]!.footL.x - walk[i - 1]!.footL.x;
        const dR = walk[i]!.footR.x - walk[i - 1]!.footR.x;
        if (Math.abs(dL - dRoot) < LOCK && Math.abs(dR - dRoot) < LOCK) lockstep += 1;
        if (Math.abs(dRoot) > LOCK && (Math.abs(dL) < LOCK * 2 || Math.abs(dR) < LOCK * 2)) plants += 1;
      }
      if (span > 0.08 && lockstep === walk.length - 1 && plants === 0) {
        fail_reasons.push("sliding_root: feet lockstep with root, no plant");
      }
    }
  }

  if (intent.cameraOrder?.length) {
    if (!cameras?.length) fail_reasons.push("camera_order: missing_camera_evidence");
    else if (cameras.join(">") !== intent.cameraOrder.join(">")) {
      fail_reasons.push(`camera_order: expected ${intent.cameraOrder.join(">")} actual ${cameras.join(">")}`);
    }
  }

  return {
    status: fail_reasons.length === 0 ? "GREEN" : "FAIL",
    rule: WALK_CROP_RULE,
    fail_reasons,
  };
}
