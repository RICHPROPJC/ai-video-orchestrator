/** Characterization test：editor→delivery 段行為錄製
 * 用WIST已有產物做輸入，錄低concat gate + edit receipts + delivery outputs行為 */

import fs from "node:fs";
import path from "node:path";

const JOB = "SC-0913-WIST";
const DIR = path.join("data", "jobs", JOB);

async function main() {
  const continuity = JSON.parse(fs.readFileSync(path.join(DIR, "continuity.json"), "utf-8"));
  const cut = continuity.cut || [];

  // 1. Motion mp4 清單
  const motionDir = path.join(DIR, "motion");
  const mp4s = fs.readdirSync(motionDir).filter(f => f.endsWith(".mp4"));
  const missing = cut.filter(id => !mp4s.includes(`${id}.mp4`));

  // 2. Audio wav 清單
  const audioDir = path.join(DIR, "audio");
  const wavs = fs.readdirSync(audioDir).filter(f => f.endsWith(".wav"));

  // 3. Cut plan
  const cutPlan = JSON.parse(fs.readFileSync(path.join(DIR, "cut_plan.json"), "utf-8"));

  // 4. 錄低「editor→delivery 會做嘅嘢」
  const characterization = {
    jobId: JOB,
    stage: "editor→delivery",
    input: {
      totalShots: cut.length,
      motionMp4s: mp4s.sort(),
      missingMp4s: missing,
      audioWavs: wavs.sort(),
      cutOrder: cut,
      cutPlanShots: cutPlan.shots?.map((s: any) => s.id) || [],
      cutPlanGap: cutPlan.gap_s,
    },
    expectedBehavior: {
      concatGateCheck: "所有cut入面嘅mp4必須存在（missing=concat gate FAIL）",
      editReceiptsFields: ["cutDigest", "run", "callsheetDigest", "cutOrder", "delivery.pictureLock", "delivery.pictureLockSha256", "segments"],
      deliveryOutputs: ["delivery/picture-lock.mp4", "delivery/qc.json", "delivery/callsheet.md", "delivery/edit-receipts.json"],
      jobStatusOnSuccess: "locked",
      jobStatusOnPartial: "blocked",
    },
    // WIST實際冇行到呢段（--until motion），呢個係「如果行會點」嘅預測
    note: "WIST停在motion-ready。此characterization記錄editor→delivery嘅輸入契約同預期輸出。",
  };

  const out = path.join("src/lib/studio/core/baseline", "char-delivery.json");
  fs.writeFileSync(out, JSON.stringify(characterization, null, 2));
  console.log(`Delivery characterization written: ${out}`);
  console.log(`  Input: ${cut.length} shots, ${mp4s.length} mp4s, ${wavs.length} wavs`);
  console.log(`  Missing mp4s: ${missing.length === 0 ? "none ✓" : missing.join(", ")}`);
}

main().catch(e => { console.error(e); process.exit(1); });
