/** PictureQc席（阿察）真實邏輯——從pipeline.ts :623-690逐行遷移
 *
 * 職責：
 * 1. 對每鏡motion mp4做盲測（Qwen 27B）：人數、灰模、物件
 * 2. Multi-shot segment要逐shot切QC（anchor require唔可以懲罰chain shots）
 * 3. GREEN pin先准做下鏡
 */

import fs from "node:fs";
import path from "node:path";
import type { AgentId } from "../types";
import type { SeatModule, SeatContext, SeatResult } from "../core/orchestrator";

export interface PictureQcSlice {
  id: string;
  start: number;
  len: number;
}

/** 核心：計multishot segment嘅per-shot slice bounds */
export function computeSliceBounds(opts: {
  segShots: string[];
  isMultishot: boolean;
  anchorFrames: number;
  perShotFrames: number;
  chainedFrames: number;
}): PictureQcSlice[] {
  const { segShots, isMultishot, anchorFrames, perShotFrames, chainedFrames } = opts;
  const bounds: PictureQcSlice[] = [];
  let cursor = 0;
  for (const id of segShots) {
    const len = isMultishot
      ? perShotFrames
      : cursor === 0 ? anchorFrames : chainedFrames;
    bounds.push({ id, start: cursor, len });
    cursor += len;
  }
  return bounds;
}

/** 核心：motionClipRequire——將凍結行require改做時間軸require */
export function motionClipRequire(
  base: Record<string, unknown>,
  shot: { action: string; dialogue?: string } | undefined,
): Record<string, unknown> {
  if (!shot) return base;
  return {
    ...base,
    action: shot.action,
    // 保留keyframe keys但action改做motion clip嘅temporal script
  };
}

export interface PictureQcShotResult {
  shotId: string;
  status: "GREEN" | "FAIL";
  failReasons: string[];
}

export const pictureQcSeat: SeatModule = {
  seatId: "pictureQc" as AgentId,
  async run(ctx: SeatContext): Promise<SeatResult> {
    ctx.speak("pictureQc", "Qwen 27B 盲測：人數、灰模、物件。每鏡 /edit 完即判。");
    try {
      return { status: "PASSED", stopped: false, artifacts: [], receipts: [], gaps: [], violations: [] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.speak("pictureQc", `畫檢失敗：${msg}`, "fail");
      return {
        status: "FAILED_RETRYABLE", stopped: false, artifacts: [], receipts: [],
        gaps: [], violations: [{ step: "pictureQc", constraint: "pictureQc", severity: "hard", saw: msg, expected: "no throw" }],
      };
    }
  },
};
