import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeWav } from "./audio";
import { submitH3Shot } from "./h3-submit";

function validProse() {
  return [
    "Photoreal. 茶餐廳門口, night.",
    "Have the 2 people act following the movements of the grey placeholders in <Video 1> — they carry motion only; replace their look entirely.",
    "Faces, clothes, the props and the field continue exactly from the start keyframe image. Do not add people.",
    '阿月 (left) speaks the line in Audio 1: "你仲記得個門口個燈？". 阿衡 listens.',
  ].join("\n\n");
}

function shotDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-h3-"));
  writeWav(path.join(dir, "SH01.wav"), new Float32Array(22050 * 2), 22050); // 2.0 s → 124 f
  fs.writeFileSync(path.join(dir, "SH01.mp4"), Buffer.from("fake-blockout"));
  fs.writeFileSync(path.join(dir, "SH01.png"), Buffer.from("fake-kf"));
  return dir;
}

test("dry run writes a 124-frame receipt and touches no socket", async () => {
  const dir = shotDir();
  const receiptJson = path.join(dir, "motion", "SH01.h3_submit_dryrun.json");
  const { receipt, receiptFile } = await submitH3Shot({
    prose: validProse(),
    wavFile: path.join(dir, "SH01.wav"),
    blockoutMp4: path.join(dir, "SH01.mp4"),
    kfStart: path.join(dir, "SH01.png"),
    outMp4: path.join(dir, "motion", "SH01.mp4"),
    receiptJson,
    dryRun: true,
    shot: "SH01",
  });
  assert.equal(receipt.dry_run, true);
  assert.equal(receipt.frames, 124);
  assert.equal(receipt.prompt_id, null);
  assert.equal(receipt.uploads.kf_end, null);
  assert.ok(receipt.graph && typeof receipt.graph === "object");
  assert.equal(receiptFile, receiptJson);
  const onDisk = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
  assert.equal(onDisk.frames, 124);
  assert.ok(onDisk.prompt.startsWith("# produced_by: slatecrew_h3_submit"));
  // no motion mp4 materialised in dry run
  assert.equal(fs.existsSync(path.join(dir, "motion", "SH01.mp4")), false);
});

test("dry run never clobbers a real receipt", async () => {
  const dir = shotDir();
  const receiptJson = path.join(dir, "motion", "SH01.h3_submit.json");
  fs.mkdirSync(path.dirname(receiptJson), { recursive: true });
  fs.writeFileSync(receiptJson, JSON.stringify({ dry_run: false, prompt_id: "real" }));
  const { receiptFile } = await submitH3Shot({
    prose: validProse(),
    wavFile: path.join(dir, "SH01.wav"),
    blockoutMp4: path.join(dir, "SH01.mp4"),
    kfStart: path.join(dir, "SH01.png"),
    outMp4: path.join(dir, "motion", "SH01.mp4"),
    receiptJson,
    dryRun: true,
  });
  assert.match(receiptFile, /_dryrun\.json$/);
  assert.equal(JSON.parse(fs.readFileSync(receiptJson, "utf8")).prompt_id, "real");
});

test("prose that fails validateProse throws before anything else", async () => {
  const dir = shotDir();
  await assert.rejects(
    () =>
      submitH3Shot({
        prose: "隨便寫，冇 photoreal 冇 <Video 1> 句。",
        wavFile: path.join(dir, "SH01.wav"),
        blockoutMp4: path.join(dir, "SH01.mp4"),
        kfStart: path.join(dir, "SH01.png"),
        outMp4: path.join(dir, "motion", "SH01.mp4"),
        receiptJson: path.join(dir, "motion", "SH01.h3_submit_dryrun.json"),
        dryRun: true,
      }),
    /Photoreal|motion-only/,
  );
});
