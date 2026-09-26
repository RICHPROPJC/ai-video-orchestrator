import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { aliasDecision, diffPropPlates, nextPropBoardSeq, sha256File } from "./prop-plate-index";

function qc(dir: string, plateName: string, blind: string, status = "GREEN"): void {
  const plate = path.join(dir, plateName);
  fs.writeFileSync(plate, `plate:${plateName}`);
  const cut = plate.replace(/\.png$/, ".cut.png");
  fs.writeFileSync(cut, `cut:${plateName}`);
  const doc = {
    status,
    blind,
    image: path.basename(cut),
    sha256: sha256File(cut),
  };
  fs.writeFileSync(plate.replace(/\.png$/, ".cut.photo_qc.json"), JSON.stringify(doc));
}

test("filename includes is not a match; GREEN blind aliases the bottle and refuses the cap", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prop-plate-"));
  qc(dir, "01-玻璃樽檸檬汽水.png", "呢張圖係一個透明嘅玻璃樽，裝住檸檬汽水。");
  fs.writeFileSync(path.join(dir, "props.pinned.json"), JSON.stringify({
    files: [path.join(dir, "01-玻璃樽檸檬汽水.png")],
  }));
  const diff = diffPropPlates(dir, path.join(dir, "props.pinned.json"), ["玻璃樽", "樽蓋"]);
  assert.deepEqual(diff.missingIds, ["樽蓋"]);
  assert.equal(diff.resolved.length, 1);
  assert.equal(diff.resolved[0]!.assetId, "玻璃樽");
  assert.equal(diff.resolved[0]!.aliasFrom, "玻璃樽檸檬汽水");
  assert.match(diff.resolved[0]!.identityEvidence, /GREEN blind/);
  assert.equal(diff.manifest.files.length, 1);
});

test("a stem that merely contains the id does not alias without the QC naming it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prop-plate-"));
  qc(dir, "01-玻璃樽檸檬汽水.png", "一個木箱。");
  const diff = diffPropPlates(dir, path.join(dir, "missing.json"), ["玻璃樽"]);
  assert.deepEqual(diff.missingIds, ["玻璃樽"]);
  assert.equal(aliasDecision({
    stem: "玻璃樽檸檬汽水",
    assetId: "樽蓋",
    requestedIds: ["玻璃樽", "樽蓋"],
    qc: { status: "GREEN", blind: "透明嘅玻璃樽" },
  }).ok, false);
});

test("stale cut sha and the shorter id lose", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prop-plate-"));
  qc(dir, "01-玻璃樽.png", "玻璃樽");
  const qcFile = path.join(dir, "01-玻璃樽.cut.photo_qc.json");
  const doc = JSON.parse(fs.readFileSync(qcFile, "utf8")) as { sha256: string };
  doc.sha256 = "0".repeat(64);
  fs.writeFileSync(qcFile, JSON.stringify(doc));
  assert.deepEqual(diffPropPlates(dir, path.join(dir, "nope.json"), ["玻璃樽"]).missingIds, ["玻璃樽"]);

  const both = aliasDecision({
    stem: "玻璃樽蓋",
    assetId: "樽蓋",
    requestedIds: ["玻璃樽", "樽蓋"],
    qc: { status: "GREEN", blind: "玻璃樽同樽蓋" },
  });
  assert.equal(both.ok, false);
  const bottle = aliasDecision({
    stem: "玻璃樽蓋",
    assetId: "玻璃樽",
    requestedIds: ["玻璃樽", "樽蓋"],
    qc: { status: "GREEN", blind: "玻璃樽同樽蓋" },
  });
  assert.equal(bottle.ok, true);
});

test("exact id GREEN does not need the blind to repeat the filename", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prop-plate-"));
  qc(dir, "02-樽蓋.png", "金屬圓蓋");
  const diff = diffPropPlates(dir, path.join(dir, "nope.json"), ["樽蓋"]);
  assert.deepEqual(diff.missingIds, []);
  assert.equal(diff.resolved[0]!.aliasFrom, undefined);
  assert.equal(diff.resolved[0]!.identityEvidence, "exact_id_green");
});

test("next prop board seq skips an existing props-01 sheet", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prop-seq-"));
  fs.mkdirSync(path.join(dir, "boards"));
  fs.writeFileSync(path.join(dir, "boards", "props-01.png"), "x");
  assert.equal(nextPropBoardSeq(dir), 2);
  assert.equal(nextPropBoardSeq(fs.mkdtempSync(path.join(os.tmpdir(), "prop-seq-empty-"))), 1);
});

test("BP5S bottle plate aliases to 玻璃樽 and 樽蓋 stays missing", () => {
  const dir = "/mnt/ssd/ai-video-orchestrator-crew/data/jobs/SC-0924-BP5S/assets";
  if (!fs.existsSync(path.join(dir, "01-玻璃樽檸檬汽水.cut.photo_qc.json"))) return;
  const diff = diffPropPlates(dir, path.join(dir, "props.pinned.json"), ["玻璃樽", "樽蓋"]);
  assert.deepEqual(diff.missingIds, ["樽蓋"]);
  assert.equal(diff.resolved[0]!.assetId, "玻璃樽");
  assert.equal(diff.resolved[0]!.qcStatus, "GREEN");
  assert.equal(diff.resolved[0]!.aliasFrom, "玻璃樽檸檬汽水");
});
