import { SCENE_ID_RE } from "./script-contract";
import { SHOT_ID_RE } from "./shot-redo";
import { newSlateId, readJob, runningBlocker, writeJob } from "./store";
import type { JobRecord, ProduceInput } from "./types";
import type { FleetGate } from "./fleet";

export const UNTIL_GATES: NonNullable<ProduceInput["until"]>[] = ["boards", "blockout", "stills", "motion"];
export const GRAPH_VARIANTS: NonNullable<ProduceInput["graphVariant"]>[] = ["a", "b", "bkf", "c"];

export function fleetGateOf(until: ProduceInput["until"]): FleetGate {
  if (until === "boards" || until === "blockout") return "boards";
  if (until === "stills") return "stills";
  if (until === "motion") return "motion";
  return "full";
}

/** Same refusals the CLI prints before a slate is touched. */
export function refuseProduce(input: ProduceInput): string | null {
  if (input.graphVariant && !GRAPH_VARIANTS.includes(input.graphVariant)) {
    return `--graph-variant 只接受 ${GRAPH_VARIANTS.join(" / ")}`;
  }
  if (input.until && !UNTIL_GATES.includes(input.until)) {
    return `--until 只接受 ${UNTIL_GATES.join(" / ")}`;
  }
  if (input.scene && !SCENE_ID_RE.test(input.scene)) {
    return "--scene 只接受 SCxx（例：--scene SC01）";
  }
  if (input.shot && !SHOT_ID_RE.test(input.shot)) {
    return "--shot 只接受 SHxx（例：--shot SH04）";
  }
  if (input.drama && input.until === "stills") {
    return `劇目 ${input.drama}：唔准 --until stills（stills-ready skip）`;
  }
  if (input.drama === "guojia-lingdaoren" && !input.until && !input.scene && !input.dryRun) {
    return "guojia-lingdaoren：唔准一次 H3 全 slate。用 --scene SC01（一場一 hop）";
  }
  if (input.drama === "guojia-lingdaoren" && input.until === "stills") {
    return "guojia-lingdaoren：唔准 --until stills（stills-ready skip）";
  }
  return null;
}

function blankJob(id: string, input: ProduceInput): JobRecord {
  return {
    id,
    slate: id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "queued",
    input,
    ...(input.drama ? { drama: input.drama } : {}),
    ...(input.episode ? { episode: input.episode } : {}),
    progress: 0,
    retries: { stills: 0, voice: 0, motion: 0 },
    outputs: { stills: [], shots: [], blockout: [], receipts: [] },
  };
}

export type OpenedSlate = { id: string; input: ProduceInput };

/** New slate. Refuses a second running job. Does not probe the fleet. */
export function createSlate(input: ProduceInput): OpenedSlate | { error: string } {
  const refused = refuseProduce(input);
  if (refused) return { error: refused };
  if (!input.brief?.trim()) return { error: "brief required" };
  const blocker = runningBlocker();
  if (blocker) {
    return { error: `一次一份：slate ${blocker.id} 仲行緊（running）。等佢完先開新工，或者 --resume ${blocker.id} 接返呢份。` };
  }
  const id = newSlateId();
  writeJob(blankJob(id, input));
  return { id, input };
}

export type ResumePatch = {
  wavDir?: string;
  portraitsDir?: string;
  blockoutDir?: string;
  gapSec?: number;
  noMotionSelect?: boolean;
  dryRun?: boolean;
  until?: ProduceInput["until"];
  scene?: string;
  shot?: string;
  graphVariant?: ProduceInput["graphVariant"];
  steps?: number;
  voiceClonePath?: string;
};

/** Resume keeps the slate's brief and clock. Plug paths and the stop gate come from the patch. */
export function resumeSlate(slate: string, patch: ResumePatch): OpenedSlate | { error: string } {
  const job = readJob(slate);
  if (!job) return { error: `--resume ${slate}：搵唔到呢份 slate` };
  const input: ProduceInput = {
    ...job.input,
    resume: true,
    wavDir: patch.wavDir ?? job.input.wavDir,
    portraitsDir: patch.portraitsDir ?? job.input.portraitsDir,
    blockoutDir: patch.blockoutDir ?? job.input.blockoutDir,
    gapSec: patch.gapSec ?? job.input.gapSec,
    noMotionSelect: patch.noMotionSelect || job.input.noMotionSelect,
    dryRun: patch.dryRun,
    until: patch.until,
    scene: patch.scene,
    shot: patch.shot,
    graphVariant: patch.graphVariant ?? job.input.graphVariant,
    steps: patch.steps ?? job.input.steps,
    ...(patch.voiceClonePath ? { voiceClonePath: patch.voiceClonePath } : {}),
  };
  const refused = refuseProduce(input);
  if (refused) return { error: refused };
  const blocker = runningBlocker(slate);
  if (blocker) {
    return { error: `一次一份：slate ${blocker.id} 仲行緊（running）。等佢完先開新工，或者 --resume ${blocker.id} 接返呢份。` };
  }
  writeJob({ ...job, input, status: "queued", error: undefined, updatedAt: new Date().toISOString() });
  return { id: job.id, input };
}
