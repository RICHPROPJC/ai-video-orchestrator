#!/usr/bin/env tsx
import path from "node:path";
import { runPipeline, describeFloor } from "./lib/studio/pipeline";
import { newSlateId, writeJob, readJob, listJobs, readEvents, runningBlocker } from "./lib/studio/store";
import { loadConfig, setConfigPath } from "./lib/studio/config";
import { doctor, formatDoctor } from "./lib/studio/doctor";
import { runTui } from "./lib/studio/tui";
import type { JobRecord, ProduceInput } from "./lib/studio/types";

const UNTIL_GATES: NonNullable<ProduceInput["until"]>[] = ["boards", "stills", "motion"];

function arg(name: string, fallback?: string) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

function help() {
  console.log(`SlateCrew — TUI + CLI + Web，兩部機真源（node0 出圖 / node1 出片）

Commands
  tui "<brief>"              全螢幕 TUI 開工（Montaj 式 CLIP）
  produce "<brief>"          行 log 開工
  doctor                     探兩部機 / MARS / ffmpeg / Blender
  models                     睇而家用緊邊個 checkpoint
  models set <dot.path> <v>  換模型，例：stills.checkpoint foo.safetensors
  status [slate]
  floor                      十二人：名 / 工 / 諗法
  recall <slate> "<q>"       只喺呢份 vault rerank（text|image|video|audio）
  serve                      Web GUI :43127

Flags
  --duration 12  --aspect 16:9|9:16|1:1  --clone ref.wav  --lang yue
  --wav-dir <dir>       每鏡 SHxx.wav（可加 spine.wav 全片聲軌）；除 --until boards 外必需
  --portraits <dir>     角色肖像 A.png/B.png（首次出場 /edit 參考圖）
  --blockout-dir <dir>  預渲染 blockout SHxx.mp4（864x480 24fps，frames=wav snap）
  --callsheet <json>    載入現成 callsheet，跳過兩張檯（結構唔齊即刻 fail）
  --cast-roster <json>  可出聲角色名單（有聲音檔嘅名），編劇檯只准用呢批名
  --gap <sec>           鏡與鏡之間靜音（默許 0）
  --dry-run             行到 prompt/receipt 為止，唔 POST 任何機
  --until boards|stills|motion 早停閘：boards＝劇本同分鏡出齊即停（status boarded，唔使 wav）；
                        stills＝photo QC GREEN 即停（stills-ready）；motion＝H3 落片即停
  --resume <slate>      接返舊 slate：callsheet 照舊，過咗閘嘅 blockout／keyframe／片唔重做

Rack（two-host truth）
  U1.5 /edit  <stills.url>        node0 :8097
  H3 R2V      <motion.comfyUrl>   node1 :8188
  MARS        <pictureQc.endpoint>  photo QC 眼
`);
}

async function makeJob(brief: string) {
  const id = newSlateId();
  const input: ProduceInput = {
    brief,
    durationSec: Number(arg("--duration", "12")),
    aspect: (arg("--aspect", "16:9") as ProduceInput["aspect"]) || "16:9",
    language: (arg("--language", arg("--lang", "auto")) as ProduceInput["language"]) || "auto",
    voiceClonePath: arg("--clone"),
    wavDir: arg("--wav-dir") ?? "",
    portraitsDir: arg("--portraits"),
    blockoutDir: arg("--blockout-dir"),
    gapSec: Number(arg("--gap", "0")),
    dryRun: process.argv.includes("--dry-run"),
    until: arg("--until") as ProduceInput["until"],
    callSheetPath: arg("--callsheet"),
    castRosterPath: arg("--cast-roster"),
  };
  if (input.until && !UNTIL_GATES.includes(input.until)) {
    console.error(`--until 只接受 ${UNTIL_GATES.join(" / ")}`);
    process.exit(1);
  }
  const job: JobRecord = {
    id,
    slate: id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "queued",
    input,
    progress: 0,
    retries: { stills: 0, voice: 0, motion: 0 },
    outputs: { stills: [], shots: [], blockout: [], receipts: [] },
  };
  writeJob(job);
  return { id, input };
}

/** Resume keeps the slate's own brief and clock — only the plug paths and the
 *  stop gate come from this command line. */
function resumeJob(slate: string) {
  const job = readJob(slate);
  if (!job) {
    console.error(`--resume ${slate}：搵唔到呢份 slate`);
    process.exit(1);
  }
  const input: ProduceInput = {
    ...job.input,
    resume: true,
    wavDir: arg("--wav-dir") ?? job.input.wavDir,
    portraitsDir: arg("--portraits") ?? job.input.portraitsDir,
    blockoutDir: arg("--blockout-dir") ?? job.input.blockoutDir,
    gapSec: process.argv.includes("--gap") ? Number(arg("--gap", "0")) : job.input.gapSec,
    dryRun: process.argv.includes("--dry-run"),
    until: (arg("--until") as ProduceInput["until"]) ?? undefined,
  };
  if (input.until && !UNTIL_GATES.includes(input.until)) {
    console.error(`--until 只接受 ${UNTIL_GATES.join(" / ")}`);
    process.exit(1);
  }
  writeJob({ ...job, input, status: "queued", error: undefined, updatedAt: new Date().toISOString() });
  return { id: job.id, input };
}

async function produce(brief: string, tui: boolean) {
  // boards stops before the wav is the clock, so it is the one gate that runs dry
  if (!arg("--wav-dir") && arg("--until") !== "boards") {
    console.error('produce/tui 需要 --wav-dir <dir>（每鏡 SHxx.wav，可加 spine.wav）；只出分鏡用 --until boards');
    process.exit(1);
  }
  // serial floor: refuse a second concurrent slate before any job is touched
  const resumeSlate = arg("--resume");
  const blocker = runningBlocker(resumeSlate);
  if (blocker) {
    console.error(`一次一份：slate ${blocker.id} 仲行緊（running）。等佢完先開新工，或者 --resume ${blocker.id} 接返呢份。`);
    process.exit(1);
  }
  const { id, input } = resumeSlate ? resumeJob(resumeSlate) : await makeJob(brief);
  const rack = loadConfig();
  if (!tui || !process.stdout.isTTY) {
    console.log(`\n  SLATE  ${id}`);
    console.log(`  U1.5   ${rack.stills.url}`);
    console.log(`  H3     ${rack.motion.comfyUrl}`);
    console.log(`  BRIEF  ${brief}\n`);
    const { subscribe } = await import("./lib/studio/store");
    subscribe(id, (e) => {
      const tag = e.level === "pass" ? "PASS" : e.level === "fail" ? "FAIL" : e.level.toUpperCase();
      console.log(`  [${tag.padEnd(5)}] ${e.agent.padEnd(10)} ${e.message}`);
    });
    await runPipeline(id, input);
  } else {
    const running = runPipeline(id, input);
    await runTui(id, `U1.5 ${rack.stills.url}  H3 ${rack.motion.comfyUrl}`);
    await running;
  }
  const done = readJob(id);
  console.log(`\n  STATUS ${done?.status}  ${done?.progress}%`);
  if (done?.outputs.pictureLock) {
    console.log(`  LOCK   ${path.join(process.cwd(), "data/jobs", id, done.outputs.pictureLock)}`);
  }
  if (done?.status === "boarded") {
    console.log(`  SHEET  ${path.join(process.cwd(), "data/jobs", id, "callsheet.json")}`);
    console.log(`  NEXT   落好 wav 之後：produce "" --resume ${id} --wav-dir <dir>`);
  }
  if (done?.status === "stills-ready") {
    console.log(`  STILLS ${path.join(process.cwd(), "data/jobs", id, "stills")}`);
  }
  if (done?.error) process.exitCode = 1;
}

async function main() {
  const cmd = process.argv[2];
  if (!cmd || cmd === "help" || cmd === "-h") return help();
  if (cmd === "floor") {
    console.log("Dispatch 去專職檯 · packet 只裝呢份 slate · 故事＝分鏡＝剪接\n");
    for (const d of describeFloor()) {
      console.log(`${d.id.padEnd(10)} ${d.name}／${d.job}  (${d.en})`);
      console.log(`${"".padEnd(10)} 想：${d.thinking}\n`);
    }
    return;
  }
  if (cmd === "recall") {
    const slate = process.argv[3];
    const q = process.argv[4] || "";
    if (!slate || !q) {
      console.error('recall <slate> "<query>" [--modality text|image|video|audio]');
      process.exitCode = 1;
      return;
    }
    const { recall } = await import("./lib/studio/vault");
    const modality = arg("--modality") as "text" | "image" | "video" | "audio" | undefined;
    console.log(JSON.stringify(recall(slate, q, { modality, k: 8 }), null, 2));
    return;
  }
  if (cmd === "serve") {
    console.log("npm run dev   →  http://127.0.0.1:43127");
    return;
  }
  if (cmd === "doctor") {
    console.log(formatDoctor(await doctor()));
    return;
  }
  if (cmd === "models") {
    const sub = process.argv[3];
    if (sub === "set") {
      const key = process.argv[4];
      const value = process.argv.slice(5).join(" ");
      if (!key || !value) {
        console.error("models set <dot.path> <value>");
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify(setConfigPath(key, value), null, 2));
      return;
    }
    console.log(JSON.stringify(loadConfig(), null, 2));
    return;
  }
  if (cmd === "status") {
    const id = process.argv[3];
    if (!id) {
      for (const j of listJobs().slice(0, 8)) {
        console.log(`${j.slate}  ${j.status.padEnd(8)}  ${(j.callSheet?.title ?? j.input.brief).slice(0, 40)}`);
      }
      return;
    }
    const job = readJob(id);
    if (!job) {
      console.error("not found");
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(job, null, 2));
    for (const e of readEvents(id)) console.log(e.ts, e.agent, e.message);
    return;
  }
  if (cmd === "tui") {
    const brief = process.argv[3] || "";
    if (!brief && !arg("--resume")) {
      console.error("tui needs a brief（或 --resume <slate>）");
      process.exitCode = 1;
      return;
    }
    await produce(brief, true);
    return;
  }
  if (cmd === "produce") {
    const brief = process.argv[3] || "";
    if (!brief && !arg("--resume")) {
      console.error("produce needs a brief（或 --resume <slate>）");
      process.exitCode = 1;
      return;
    }
    await produce(brief, process.argv.includes("--tui"));
    return;
  }
  help();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
