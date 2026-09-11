#!/usr/bin/env tsx
import path from "node:path";
import { runPipeline, describeFloor } from "./lib/studio/pipeline";
import { newSlateId, writeJob, readJob, listJobs, readEvents } from "./lib/studio/store";
import { loadConfig, setConfigPath } from "./lib/studio/config";
import { doctor, formatDoctor } from "./lib/studio/doctor";
import { runTui } from "./lib/studio/tui";
import type { JobRecord, ProduceInput } from "./lib/studio/types";

function arg(name: string, fallback?: string) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

function help() {
  console.log(`SlateCrew — TUI + CLI + Web，默許 ComfyUI :8188

Commands
  tui "<brief>"              全螢幕 TUI 開工（Montaj 式 CLIP）
  produce "<brief>"          行 log 開工
  doctor                     探 Comfy / ffmpeg / Blender / 模型
  models                     睇而家用緊邊個 checkpoint
  models set <dot.path> <v>  換模型，例：stills.checkpoint foo.safetensors
  status [slate]
  floor
  serve                      Web GUI :43127

Flags
  --duration 12  --aspect 16:9|9:16|1:1  --clone ref.wav  --lang yue

Default rack（唔使新 endpoint）
  Comfy  http://127.0.0.1:8188
  U1.5   workflows/u15-t2i.api.json
  H3     workflows/h3-i2v.api.json  (MiniMaxH3ImageToVideo + first_frame)
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
  };
  const job: JobRecord = {
    id,
    slate: id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "queued",
    input,
    progress: 0,
    retries: { stills: 0, voice: 0, motion: 0 },
    outputs: { stills: [], shots: [] },
  };
  writeJob(job);
  return { id, input };
}

async function produce(brief: string, tui: boolean) {
  const { id, input } = await makeJob(brief);
  const rack = loadConfig();
  if (!tui || !process.stdout.isTTY) {
    console.log(`\n  SLATE  ${id}`);
    console.log(`  COMFY  ${rack.comfyUrl}`);
    console.log(`  BRIEF  ${brief}\n`);
    const { subscribe } = await import("./lib/studio/store");
    subscribe(id, (e) => {
      const tag = e.level === "pass" ? "PASS" : e.level === "fail" ? "FAIL" : e.level.toUpperCase();
      console.log(`  [${tag.padEnd(5)}] ${e.agent.padEnd(10)} ${e.message}`);
    });
    await runPipeline(id, input);
  } else {
    const running = runPipeline(id, input);
    await runTui(id, `Comfy ${rack.comfyUrl}  stills ${rack.stills.checkpoint}`);
    await running;
  }
  const done = readJob(id);
  console.log(`\n  STATUS ${done?.status}  ${done?.progress}%`);
  if (done?.outputs.pictureLock) {
    console.log(`  LOCK   ${path.join(process.cwd(), "data/jobs", id, done.outputs.pictureLock)}`);
  }
  if (done?.error) process.exitCode = 1;
}

async function main() {
  const cmd = process.argv[2];
  if (!cmd || cmd === "help" || cmd === "-h") return help();
  if (cmd === "floor") {
    for (const d of describeFloor()) console.log(`${d.id.padEnd(10)} ${d.label}  ${d.en}  — ${d.desk}`);
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
    if (!brief) {
      console.error("tui needs a brief");
      process.exitCode = 1;
      return;
    }
    await produce(brief, true);
    return;
  }
  if (cmd === "produce") {
    const brief = process.argv[3] || "";
    if (!brief) {
      console.error("produce needs a brief");
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
