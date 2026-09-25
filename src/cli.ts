#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
import { runPipeline, describeFloor } from "./lib/studio/pipeline";
import { readJob, listJobs, readEvents, readEpEvents, failedRecent, failedRecentLines } from "./lib/studio/store";
import { createSlate, fleetGateOf, resumeSlate as openResume } from "./lib/studio/open-produce";
import { projectsDir } from "./lib/studio/paths";
import { loadConfig, setConfigPath } from "./lib/studio/config";
import { doctor, formatDoctor } from "./lib/studio/doctor";
import { blockersForGate, formatFleet, gateReady, probeFleet, type FleetGate } from "./lib/studio/fleet";
import { runTui } from "./lib/studio/tui";
import type { ProduceInput } from "./lib/studio/types";
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
  frames <job> <shot>        從 motion mp4 抽 QC 帧（首/中/尾 + 每 2s）→ jpg
  events [slate] [--follow]  睇 projects/<ep>/events.jsonl；--follow 點住尾
  doctor                     探兩部機 / SF3D / ffmpeg / Blender / H3 nodes
  fleet                      探每個 config endpoint（/health /v1/models /system_stats）；config ≠ live → RED
  mesh <plate.png>           去背方塊 → sf3d :8018 → mesh_front.glb＋geometry閘（Blender 5.1.2）
  models                     睇而家用緊邊個 checkpoint
  models set <dot.path> <v>  換模型，例：stills.checkpoint foo.safetensors
  status [slate]
  floor                      十二人：名 / 工 / 諗法
  recall <slate> "<q>"       只喺呢份 vault rerank（text|image|video|audio）
  serve                      Web GUI :43127

Flags
  --duration 12  --aspect 16:9|9:16|1:1  --clone ref.wav  --lang yue
  --wav-dir <dir>       每鏡 SHxx.wav（可加 spine.wav 全片聲軌）；缺＝voice 席用 AuK :9882 自動出 VO（要 tts.promptWav／--clone）
  --portraits <dir>     角色肖像 A.png/B.png（首次出場 /edit 參考圖；45°用A_45.png）
  --no-motion-select    跳過motion-select（唔叫decider、唔bake mocap，workbench灰模照舊）
  --blockout-dir <dir>  預渲染 blockout SHxx.mp4（864x480 24fps，frames=wav snap）
  --callsheet <json>    載入現成 callsheet，跳過兩張檯（結構唔齊即刻 fail）
  --cast-roster <json>  可出聲角色名單（有聲音檔嘅名），編劇檯只准用呢批名
  --gap <sec>           鏡與鏡之間靜音（默許 0）
  --dry-run             行到 prompt/receipt 為止，唔 POST 任何機
  --graph-variant a|b|bkf|c  H3 graph（默認 a＝官方路：still 已燒身份＋H3Keyframes 錨）
                        b/bkf＝documented fallback：角色圖 ref 係官方正路（samples #17/#22/#34），
                        但 A 路 still 已釘身份——淨係冇 still 釘身份嘅鏡頭先用；c＝verify 實驗位
  --steps <n>           測試用 H3 steps 覆寫（默認 4）
  --drama <id>          劇目 id → projects/<id>/（例：guojia-lingdaoren）
  --episode EP01        集號（EP01…EP10）
  --until boards|blockout|stills|motion 早停閘：boards＝劇本同分鏡出齊即停（status boarded，唔使 wav）；
                        blockout＝灰塊走位+f0 即停（唔使 pictureQc）；
                        stills＝photo QC GREEN 即停（stills-ready）；motion＝H3 落片即停
  --scene SCxx          淨係燒呢一場嘅 H3（一場一 hop）；唔加＝出齊全部鏡（原有行為）
  --shot SHxx           由呢鏡同後面受影響嘅鏡重做；前面 GREEN 保留
  --resume <slate>      接返舊 slate：callsheet 照舊，過咗閘嘅 blockout／keyframe／片唔重做

Rack（two-host truth）
  U1.5 /edit  <stills.url>        node0 :8097
  H3 R2V      <motion.comfyUrl>   node1 :8188
  pictureQc <pictureQc.endpoint>  photo QC 眼（qwen38 / Qwen 27B :8015）
  Nex         <nex.endpoint>          3D/tool 腦（nex-n2.5 :8017）。DOWN 唔擋開工；pictureQc qwen38 27B 頂住
`);
}

function die(opened: { error: string }): never {
  console.error(opened.error);
  process.exit(1);
}

function makeJob(brief: string) {
  const opened = createSlate({
    brief,
    durationSec: Number(arg("--duration", "12")),
    aspect: (arg("--aspect", "16:9") as ProduceInput["aspect"]) || "16:9",
    language: (arg("--language", arg("--lang", "auto")) as ProduceInput["language"]) || "auto",
    voiceClonePath: arg("--clone"),
    wavDir: arg("--wav-dir") ?? "",
    portraitsDir: arg("--portraits"),
    blockoutDir: arg("--blockout-dir"),
    gapSec: Number(arg("--gap", "0")),
    noMotionSelect: process.argv.includes("--no-motion-select"),
    dryRun: process.argv.includes("--dry-run"),
    until: arg("--until") as ProduceInput["until"],
    scene: arg("--scene"),
    shot: arg("--shot"),
    callSheetPath: arg("--callsheet"),
    castRosterPath: arg("--cast-roster"),
    graphVariant: (arg("--graph-variant", "a") as ProduceInput["graphVariant"]) || "a",
    steps: process.argv.includes("--steps") ? Number(arg("--steps", "4")) : undefined,
    drama: arg("--drama"),
    episode: arg("--episode"),
  });
  if ("error" in opened) die(opened);
  return opened;
}

function resumeJob(slate: string) {
  const opened = openResume(slate, {
    wavDir: arg("--wav-dir"),
    portraitsDir: arg("--portraits"),
    blockoutDir: arg("--blockout-dir"),
    gapSec: process.argv.includes("--gap") ? Number(arg("--gap", "0")) : undefined,
    noMotionSelect: process.argv.includes("--no-motion-select"),
    dryRun: process.argv.includes("--dry-run"),
    until: arg("--until") as ProduceInput["until"],
    scene: arg("--scene"),
    shot: arg("--shot"),
    graphVariant: arg("--graph-variant") ? (arg("--graph-variant") as ProduceInput["graphVariant"]) : undefined,
    steps: process.argv.includes("--steps") ? Number(arg("--steps", "4")) : undefined,
    voiceClonePath: arg("--clone"),
  });
  if ("error" in opened) die(opened);
  return opened;
}

async function produce(brief: string, tui: boolean) {
  // boards stops before the wav is the clock; without --wav-dir the voice seat
  // speaks the VO through AuK (pipeline fails loud when tts is not armed)
  if (!arg("--wav-dir") && arg("--until") !== "boards" && !arg("--clone")) {
    console.error("提示：無 --wav-dir，voice 席會用 AuK :9882 自動出 VO（要 tts.promptWav 或 --clone ref.wav）");
  }
  const fleet = await probeFleet(loadConfig());
  const gate: FleetGate = fleetGateOf(arg("--until") as ProduceInput["until"]);
  if (!gateReady(fleet, gate)) {
    console.error(formatFleet({ ...fleet, ready: false, blockers: blockersForGate(fleet.rows, gate) }));
    process.exit(1);
  }
  const resumeId = arg("--resume");
  for (const line of failedRecentLines(failedRecent())) console.error(line);
  const { id, input } = resumeId ? resumeJob(resumeId) : makeJob(brief);
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
  if (cmd === "frames") {
    const job = process.argv[3];
    const shot = process.argv[4];
    if (!job || !shot) {
      console.error("frames <job> <shot>");
      process.exitCode = 1;
      return;
    }
    const { dataRoot } = await import("./lib/studio/paths");
    const { extractMotionFrames } = await import("./lib/studio/motion-frames");
    const mp4 = path.join(dataRoot(), job, "motion", `${shot}.mp4`);
    const outDir = path.join(dataRoot(), job, "motion", `${shot}.frames`);
    const frames = await extractMotionFrames(mp4, outDir, shot);
    console.log(JSON.stringify({ job, shot, mp4, outDir, frames }, null, 2));
    return;
  }
  if (cmd === "doctor") {
    console.log(formatDoctor(await doctor()));
    return;
  }
  if (cmd === "fleet") {
    const fleet = await probeFleet(loadConfig());
    if (process.argv.includes("--json")) console.log(JSON.stringify(fleet, null, 2));
    else console.log(formatFleet(fleet));
    if (!fleet.ready) process.exitCode = 1;
  }

  if (cmd === "mesh") {
    const plate = process.argv[3];
    const meshClass = arg("--class", "figure");
    const usage = "mesh <plate.png> [--out dir] [--front-ref png] [--class figure|prop] [--target-height 1.7] [--dry-run]";
    if (!plate || (meshClass !== "figure" && meshClass !== "prop")) {
      console.error(usage);
      process.exitCode = 1;
      return;
    }
    const cfg = loadConfig();
    const { assertMeshPlate, importMeshCall, sf3dGenerate, sf3dHealth } = await import("./lib/studio/mesh-provider");
    const outDir = path.resolve(arg("--out") ?? path.join(process.cwd(), "data", "mesh", `${path.basename(plate).replace(/\.png$/i, "")}_${Date.now()}`));
    if (process.argv.includes("--dry-run")) {
      const facts = await assertMeshPlate(plate).catch((e: Error) => ({ refused: e.message }));
      const health = await sf3dHealth(cfg.mesher.endpoint).catch((e: Error) => ({ error: e.message }));
      console.log(JSON.stringify({ dry_run: true, plate, facts, health, outDir }, null, 2));
      return;
    }
    const receipt = await sf3dGenerate({
      plate,
      outDir,
      endpoint: cfg.mesher.endpoint,
      frontRef: arg("--front-ref"),
      textureResolution: cfg.mesher.textureResolution,
    });
    if (receipt.status !== "succeeded" || !receipt.mesh_front) {
      console.error(JSON.stringify(receipt, null, 2));
      process.exitCode = 1;
      return;
    }
    const targetHeightM = Number(arg("--target-height", String(cfg.mesher.targetHeightM)));
    const { runMeshGeometryGate } = await import("./lib/studio/mesh-geometry-gate");
    const verdict = await runMeshGeometryGate({
      glb: receipt.mesh_front,
      outDir: path.join(outDir, "gate"),
      blenderBin: cfg.mesher.blender,
      targetHeightM,
      meshClass,
    });
    console.log(JSON.stringify({
      receipt,
      importCall: importMeshCall({
        path: receipt.mesh_front,
        name: "Sf3d" + path.basename(outDir).replace(/[^A-Za-z0-9]/g, ""),
        targetHeightM,
      }),
      gate: {
        ok: verdict.ok,
        checks: verdict.checks,
        metrics: {
          solidity: verdict.metrics.solidity,
          thinness: verdict.metrics.thinness,
          vertices: verdict.metrics.vertices,
          dimensionsM: verdict.metrics.dimensionsM,
          preview: verdict.metrics.preview,
        },
      },
    }, null, 2));
    process.exitCode = verdict.ok ? 0 : 1;
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
  if (cmd === "events") {
    // A4: the ep events file is the one source Chau/Grok/Vera read — not a PTY
    const positional = process.argv.slice(3).filter((a) => !a.startsWith("--"));
    const slate = positional[0] ?? listJobs()[0]?.slate ?? listJobs()[0]?.id;
    if (!slate) {
      console.error("冇 slate：events [slate] 或先開一個 produce");
      process.exitCode = 1;
      return;
    }
    const file = path.join(projectsDir(), slate, "events.jsonl");
    const printEvent = (e: import("./lib/studio/types").JobEvent) => {
      const d = e.data as Record<string, unknown> | undefined;
      const stage = d?.shot !== undefined
        ? `  [${d.shot} ${d.stage ?? "?"} ${d.eye ?? e.agent} ${d.verdict ?? e.level}${d.proof ? ` proof=${d.proof}` : ""}${d.ms !== undefined ? ` ${d.ms}ms` : ""}]`
        : "";
      console.log(e.ts, e.agent, e.message + stage);
    };
    let history = readEpEvents(slate);
    if (!history.length) {
      // jobs older than the alias fall back to their per-job log
      const job = readJob(slate);
      if (job) history = readEvents(job.id);
    }
    for (const e of history) printEvent(e);
    if (!process.argv.includes("--follow")) return;
    console.log(`-- follow ${file}（Ctrl-C 離開）`);
    let offset = fs.existsSync(file) ? fs.statSync(file).size : 0;
    for (;;) {
      await new Promise((r) => setTimeout(r, 500));
      const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
      if (size <= offset) continue;
      const buf = Buffer.alloc(size - offset);
      const fh = fs.openSync(file, "r");
      try {
        fs.readSync(fh, buf, 0, buf.length, offset);
      } finally {
        fs.closeSync(fh);
      }
      offset = size;
      for (const line of buf.toString("utf8").split("\n").filter(Boolean)) {
        printEvent(JSON.parse(line) as import("./lib/studio/types").JobEvent);
      }
    }
  }
  if (cmd === "status") {
    const id = process.argv[3];
    if (!id) {
      for (const line of failedRecentLines(failedRecent())) console.log(line);
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
