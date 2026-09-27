import type { JobEvent } from "./types";

/**
 * CAPGAP_0927 — capability gap 層（法源：110 條 #31「renderer 唔支援就回報
 * capability gap，禁止偷偷換動作」）。設計哲學反轉：codebase 唔再「靜靜雞
 * 繼續行」，每個繞過位改成「停＋報」——
 *   impact "blocked"  → 成 job status "blocked"，emit error event，等指示；
 *   impact "degraded" → 照行，但每次 emit warn event 留檔（邊度行咗替代品）。
 *
 * 三個現場閘（pipeline.ts 接線）：
 *   motion     — motion-select 有 needs_human 揀片：從前係死人 flag 照 bake，
 *                而家真閘（blocked）；
 *   storyboard — 可見分鏡板 0 格：從前 warn 唔 block，而家 blocked（逃生門
 *                --allow-no-storyboard / ProduceInput.allowNoStoryboard）；
 *   blockout   — --blockout-dir plug：已知工作模式照行，但每次記一筆 degraded。
 */

export type CapabilityGap = {
  /** "motion" | "storyboard" | "blockout" | ... — 邊個域頂唔順 */
  domain: string;
  /** 缺咗乜／做唔到乜 */
  what: string;
  /** 點解（結構原因一句） */
  why: string;
  /** blocked=成 job 停等指示；degraded=照行但留檔 */
  impact: "blocked" | "degraded";
  shot?: string;
};

/** event／error 共用一行主文：capability_gap[<domain>][ <shot>]：<what>——<why> */
export function gapMessage(gap: CapabilityGap): string {
  const head = gap.shot ? `capability_gap[${gap.domain}] ${gap.shot}` : `capability_gap[${gap.domain}]`;
  return `${head}：${gap.what}——${gap.why}`;
}

/** 一個 emit-able event shape（agent:"system"，blocked=error／degraded=warn）。
 *  結構化 gap 落 data.capability_gap，events.jsonl 可以 grep 「capability_gap[」。 */
export function gapEvent(jobId: string, gap: CapabilityGap): Omit<JobEvent, "ts"> {
  return {
    agent: "system",
    level: gap.impact === "blocked" ? "error" : "warn",
    message: gapMessage(gap),
    data: {
      job: jobId,
      capability_gap: {
        domain: gap.domain,
        impact: gap.impact,
        ...(gap.shot ? { shot: gap.shot } : {}),
        what: gap.what,
        why: gap.why,
      },
    },
  };
}

/** 硬停版：組 Error 丟出去——「停手等指示，唔准靜靜雞用替代品頂」。 */
export function throwGap(gap: CapabilityGap): never {
  throw new Error(`capability_gap[${gap.domain}] ${gap.what}——${gap.why}。停手等指示，唔准靜靜雞用替代品頂。`);
}

// ---------------------------------------------------------------------------
// 三個現場閘的純函數（pipeline 接線只用呢啲，測試測呢啲，唔硬跑 runPipeline）
// ---------------------------------------------------------------------------

/**
 * motion 閘（blocked）：selection 入面任何 needs_human 揀片都係「decider 冇權
 * 代人揀」——從前隻 flag 死人照 bake，而家返回 gap 俾 pipeline block 成個 job。
 * 冇 needs_human → null（照行）。
 */
export function motionNeedsHumanGap(sels: { shot: string; needs_human?: boolean }[]): CapabilityGap | null {
  const pending = sels.filter((s) => s.needs_human);
  if (!pending.length) return null;
  return {
    domain: "motion",
    what: `needs_human 揀片 ${pending.length} 鏡未有人手接：${pending.map((s) => s.shot).join("、")}`,
    why: "tie-break（arm-axis／CMU subject／片長）全平手，decider 冇權靜靜雞代揀",
    impact: "blocked",
  };
}

/**
 * storyboard 閘（blocked）：可見分鏡板 0 格。逃生門＝出真板，或者人手確認
 * --allow-no-storyboard（ProduceInput.allowNoStoryboard，預設 false）。
 */
export function storyboardZeroGap(): CapabilityGap {
  return {
    domain: "storyboard",
    what: "可見分鏡板 0 格",
    why: "出板經 runBoards storyboardBoardPrompt 條路，或者人手確認照行（--allow-no-storyboard）",
    impact: "blocked",
  };
}

/**
 * blockout plug（degraded）：--blockout-dir 插入嘅灰模係已知工作模式，唔阻行，
 * 但每次 emit 一筆——呢條片嘅灰模係 plug 唔係真 render，事後查片有得對。
 */
export function blockoutPlugGap(shotId: string): CapabilityGap {
  return {
    domain: "blockout",
    what: "呢條片嘅灰模係 plug 唔係真 render",
    why: "--blockout-dir plug 係已知工作模式，照行；留檔記錄灰模來源",
    impact: "degraded",
    shot: shotId,
  };
}
