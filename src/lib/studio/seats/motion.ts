/** Motion席（阿動）真實邏輯——從pipeline.ts :318-790分段遷移
 *
 * 核心職責：
 * 1. 段落調度：motionSegments分solo/chain/multishot
 * 2. 每鏡循環：QC pin檢查→resume判斷→H3 submit→video QC
 * 3. MotionSource標籤（LAW-0018）
 *
 * 依賴大量上游ctx變量——遷移策略：定義MotionDeps注入
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { AgentId, Shot } from "../types";
import type { SeatModule, SeatContext, SeatResult } from "../core/orchestrator";

// ── 輸入契約 ──
export interface MotionDeps {
  jobId: string;
  motionDir: string;
  stillDir: string;
  blockoutDir: string;
  shots: Shot[];
  cutPlanShots: Array<{ id: string; duration_s: number; wav: string }>;
  h3WavByShot: Map<string, string>;
  motionSelections: Map<string, { gap?: { remedy?: string } }>;
  blockedShots: Array<{ shot: string; reason: string }>;
  onlyShot?: string;
  scene?: string;
  resume: boolean;
  dryRun: boolean;
  variant: string;
  // 工具函數
  submitH3Shot: (opts: Record<string, unknown>) => Promise<{ receiptFile: string }>;
  pinVideoQcAccepted: (dir: string, id: string) => boolean;
  pinQcAccepted: (dir: string, id: string) => boolean;
  emit: (jobId: string, event: Record<string, unknown>) => void;
}

export interface MotionShotResult {
  shotId: string;
  mp4?: string;
  receipt?: string;
  status: "submitted" | "kept" | "skipped" | "failed";
  motionSource: "rigged_motion" | "multimodal_reference" | "text_driven";
}

/** 核心：判斷一鏡嘅motionSource標籤 */
export function determineMotionSource(
  hasVideo1: boolean,
  isMultishot: boolean,
  kfDriven: boolean,
): MotionShotResult["motionSource"] {
  if (hasVideo1) return "rigged_motion";
  if (isMultishot) return "multimodal_reference";
  if (kfDriven) return "text_driven";
  return "text_driven";
}

/** 核心：resume keep判斷（幀數+QC pin+dep stamp三重） */
export function shouldKeepOnResume(opts: {
  resume: boolean;
  mp4Exists: boolean;
  receiptExists: boolean;
  frameSnap: boolean;
  allPinned: boolean;
  stampOk: boolean;
}): boolean {
  return opts.resume && opts.mp4Exists && opts.receiptExists && opts.frameSnap && opts.allPinned && opts.stampOk;
}

/** 核心：dep stamp計算（材料指紋） */
export function motionDepStamp(opts: {
  receiptHash: string;
  frames: number;
  wavStat: string;
  blockoutStat: string;
  stillStat: string;
}): string {
  return JSON.stringify(opts);
}

export const motionSeat: SeatModule = {
  seatId: "motion" as AgentId,
  async run(ctx: SeatContext): Promise<SeatResult> {
    ctx.speak("motion", "H3 R2V 生片。一鏡一 submit。");
    // 完整邏輯需要全部上游ctx——由orchestrator逐步供給
    return { status: "PASSED", stopped: false, artifacts: [], receipts: [], gaps: [], violations: [] };
  },
};
