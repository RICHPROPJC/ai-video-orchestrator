/** PR-1 §1：Orchestrator——席次調度器
 * 淨做調度：排席順序、--until 停止位、gap 修復迴圈。
 * 唔含任何席位業務邏輯。 */

import type { AgentId, ProduceInput, JobRecord } from "../types";
import { acquireJob, takeoverJob, readJob, emit, ownerIsStale, ownerHeartbeatMs, type JobOwner } from "../store";
import { seat } from "../crew";
import { transition, type SeatStatus } from "../shared/state-machine";
import type { ArtifactRef } from "../shared/artifact-ref";
import type { ReceiptRef } from "../shared/receipt";

// 席位模組統一介面
export interface SeatModule {
  seatId: AgentId;
  run(ctx: SeatContext): Promise<SeatResult>;
}

export interface SeatContext {
  jobId: string;
  input: ProduceInput;
  job: JobRecord;
  speak(agent: AgentId, message: string, level?: "info" | "warn" | "pass" | "fail"): void;
  think(agent: AgentId): void;
  // 上游產物（accumulated across seats）
  artifacts: Map<string, ArtifactRef>;
  receipts: ReceiptRef[];
  // 修復迴圈狀態
  repairRound: number;
  maxRepairs: number;
}

export interface SeatResult {
  status: SeatStatus;
  stopped: boolean;
  artifacts: ArtifactRef[];
  receipts: ReceiptRef[];
  gaps: Array<{ kind: string; message: string; repairSeat?: AgentId }>;
  violations: Array<{ step: string; constraint: string; severity: "hard" | "soft"; saw: unknown; expected: unknown }>;
}

// 席次順序（照 ALIGN-LOCK 十二席 pipeline 排序）
export const SEAT_ORDER: AgentId[] = [
  "writer",     // authorStage：阿文（編劇）
  "boards",     // authorStage：阿圖（分鏡）
  "art",        // worldStage：美術（cast/mesh/場景板）
  "layout",     // worldStage：阿標（走位/blockout/motion-select）
  "stills",     // stillsStage：阿靜（生圖/keyframe）
  "motion",     // motion：阿動（H3 生片）
  "pictureQc",  // pictureQc：阿察（畫檢）
  "voice",      // voice：阿聲（配音）
  "soundQc",    // soundQc：阿耳（聲檢）
  "editor",     // editor：阿剪（剪接）
  "delivery",   // delivery：交付
];

// --until 對應嘅停止席
export const UNTIL_SEAT: Record<string, AgentId> = {
  boards: "boards",
  blockout: "layout",
  stills: "stills",
  motion: "motion",
};

export async function runPipelineV2(
  jobId: string,
  input: ProduceInput,
  seatModules: Map<AgentId, SeatModule>,
): Promise<void> {
  // 1. Owner 管理（照 store.ts 現有邏輯）
  const taken = acquireJob(jobId);
  let owner: JobOwner;
  if (taken.ok) {
    owner = taken.owner;
  } else if (!taken.holder || taken.holder.releasedAt || ownerIsStale(jobId)) {
    owner = takeoverJob(jobId, taken.holder?.releasedAt ? "released" : "STALE");
  } else {
    throw new Error(`owner_conflict: ${jobId}`);
  }

  const job = readJob(jobId);
  if (!job) throw new Error(`missing job: ${jobId}`);

  // 2. 初始化 ctx
  const ctx: SeatContext = {
    jobId, input, job,
    speak: (agent, message, level = "info") => {
      const who = seat(agent);
      emit(jobId, {
        agent, level,
        message: `${who.name}／${who.job} · ${message}`,
        data: { name: who.name, job: who.job, thinking: who.thinking },
      });
    },
    think: (agent) => {
      const who = seat(agent);
      emit(jobId, { agent, level: "info", message: `想：${who.thinking}`, data: { name: who.name, thinking: who.thinking } });
    },
    artifacts: new Map(),
    receipts: [],
    repairRound: 0,
    maxRepairs: 3,
  };

  // 3. 席次調度
  const stopAtSeat = input.until ? UNTIL_SEAT[input.until] : undefined;

  for (const seatId of SEAT_ORDER) {
    const module = seatModules.get(seatId);
    if (!module) continue; // 席位未實裝（遷移期間）

    ctx.think(seatId);

    let result = await module.run(ctx);

    // Gap 修復迴圈（有界）
    while (result.gaps.length > 0 && ctx.repairRound < ctx.maxRepairs) {
      ctx.repairRound++;
      ctx.speak("producer", `修復第 ${ctx.repairRound} 輪：${result.gaps.length} 個 gap`, "warn");

      // 搵邊個席要修
      const repairSeats = new Set(
        result.gaps.map(g => g.repairSeat ?? "writer").filter(Boolean),
      );

      // 由最早需要修嘅席重跑
      for (const repairSeat of repairSeats) {
        const repairModule = seatModules.get(repairSeat as AgentId);
        if (repairModule) {
          const repairResult = await repairModule.run(ctx);
          // 合併修復產物
          repairResult.artifacts.forEach(a => ctx.artifacts.set(a.artifactId, a));
          ctx.receipts.push(...repairResult.receipts);
        }
      }

      // 重跑當前席
      result = await module.run(ctx);
    }

    // 收集產物
    result.artifacts.forEach(a => ctx.artifacts.set(a.artifactId, a));
    ctx.receipts.push(...result.receipts);

    // --until 停止
    if (stopAtSeat === seatId) {
      ctx.speak("producer", `--until ${input.until}：停在 ${seat(seatId).name}`, "info");
      return;
    }

    // 席位失敗——終態就停
    if (result.status === "FAILED_TERMINAL" || result.status === "BLOCKED") {
      ctx.speak("producer", `${seat(seatId).name} ${result.status}，pipeline 停`, "fail");
      return;
    }
  }
}
