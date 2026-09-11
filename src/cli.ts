#!/usr/bin/env tsx
import path from "node:path";
import { runPipeline } from "./lib/studio/pipeline";
import { newSlateId, writeJob, readJob, listJobs, readEvents } from "./lib/studio/store";
import { describeFloor } from "./lib/studio/pipeline";
import type { JobRecord, ProduceInput } from "./lib/studio/types";

function arg(name: string, fallback?: string) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

function help() {
  console.log(`SlateCrew 開麥拉組 — 交付級影片 agent team CLI

Commands
  produce "<brief>"     Run the floor and lock a picture
  status [slate]        Show job or latest
  floor                 Print desks
  serve                 Hint for the web GUI

Flags
  --duration 12
  --aspect 16:9|9:16|1:1
  --clone path/to/ref.wav
  --lang auto|yue|zh-Hant|en

Env
  U15_ENDPOINT H3_ENDPOINT MARS_ENDPOINT SENSEVOICE_ENDPOINT TTS_ENDPOINT
  STUDIO_API_KEY BLENDER_BIN
`);
}

async function produce(brief: string) {
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
  console.log(`\n  SLATE  ${id}`);
  console.log(`  BRIEF  ${brief}\n`);
  const { subscribe } = await import("./lib/studio/store");
  subscribe(id, (e) => {
    const tag = e.level === "pass" ? "PASS" : e.level === "fail" ? "FAIL" : e.level.toUpperCase();
    console.log(`  [${tag.padEnd(5)}] ${e.agent.padEnd(10)} ${e.message}`);
  });
  await runPipeline(id, input);
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
    for (const d of describeFloor()) {
      console.log(`${d.id.padEnd(10)} ${d.label}  ${d.en}  — ${d.desk}`);
    }
    return;
  }
  if (cmd === "serve") {
    console.log("npm run dev   →  http://127.0.0.1:43127");
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
    console.log("\n--- log ---");
    for (const e of readEvents(id)) console.log(e.ts, e.agent, e.message);
    return;
  }
  if (cmd === "produce") {
    const brief = process.argv[3] || "";
    if (!brief) {
      console.error("produce needs a brief");
      process.exitCode = 1;
      return;
    }
    await produce(brief);
    return;
  }
  help();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
