/** Step A：Characterization snapshot——SC-0913-WIST baseline
 * 錄低現有pipeline嘅真實行為做重構對照基線。
 * 跑法：npx tsx src/lib/studio/core/baseline/snapshot-wist.ts
 * 產出：baseline-wist.json（events摘要＋artifact SHA清單） */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const JOB = "SC-0913-WIST";
const DIR = path.join("data", "jobs", JOB);

function sha(p: string): string | null {
  try { return createHash("sha256").update(fs.readFileSync(p)).digest("hex"); }
  catch { return null; }
}

// ① Events snapshot
const events = fs.readFileSync(path.join(DIR, "events.jsonl"), "utf-8")
  .trim().split("\n").map(l => JSON.parse(l));

const eventSequence = events.map(e => ({
  ts: e.ts,
  agent: e.agent,
  level: e.level,
  // message 頭60字做fingerprint（全文太長）
  msg: (e.message || "").slice(0, 60),
}));

// ② Artifacts snapshot（每個產物嘅 SHA）
const artifactFiles: Array<{ path: string; sha: string | null; size: number }> = [];

function walk(dir: string, rel: string = "") {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const relPath = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(full, relPath);
    else if (/\.(mp4|png|wav|json|jsonl|md|py|glb)$/.test(e.name)) {
      const stat = fs.statSync(full);
      if (stat.size > 0) {
        artifactFiles.push({ path: relPath, sha: sha(full), size: stat.size });
      }
    }
  }
}

walk(path.join(DIR, "stills"));
walk(path.join(DIR, "blockout"));
walk(path.join(DIR, "motion"));
walk(path.join(DIR, "audio"));
walk(path.join(DIR, "delivery"));
walk(path.join(DIR, "cast"));

// ③ job.json 結構 snapshot
const job = JSON.parse(fs.readFileSync(path.join(DIR, "job.json"), "utf-8"));
const jobShape = {
  status: job.status,
  progress: job.progress,
  outputsKeys: Object.keys(job.outputs || {}),
  hasContinuity: !!job.continuity,
  hasCallsheet: !!job.callsheet,
};

// ④ continuity cut 順序
const continuity = JSON.parse(fs.readFileSync(path.join(DIR, "continuity.json"), "utf-8"));
const cutOrder = continuity.cut || [];

// ⑤ 組合
const snapshot = {
  jobId: JOB,
  snapshotAt: new Date().toISOString(),
  gitHead: (() => {
    try { return require("node:child_process").execSync("git rev-parse HEAD").toString().trim(); }
    catch { return "unknown"; }
  })(),
  events: {
    total: events.length,
    byAgent: events.reduce((acc, e) => {
      acc[e.agent] = (acc[e.agent] || 0) + 1;
      return acc;
    }, {} as Record<string, number>),
    byLevel: events.reduce((acc, e) => {
      acc[e.level] = (acc[e.level] || 0) + 1;
      return acc;
    }, {} as Record<string, number>),
    sequence: eventSequence,
  },
  artifacts: {
    total: artifactFiles.length,
    totalBytes: artifactFiles.reduce((s, a) => s + a.size, 0),
    files: artifactFiles.sort((a, b) => a.path.localeCompare(b.path)),
  },
  jobShape,
  cutOrder,
};

const outPath = path.join("src/lib/studio/core/baseline", "baseline-wist.json");
fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
console.log(`Baseline snapshot written: ${outPath}`);
console.log(`  Events: ${events.length}`);
console.log(`  Artifacts: ${artifactFiles.length} (${(artifactFiles.reduce((s,a)=>s+a.size,0)/1024/1024).toFixed(1)}MB)`);
console.log(`  Cut order: ${cutOrder.join(" → ")}`);
