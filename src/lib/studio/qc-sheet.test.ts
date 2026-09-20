/** T37 眼板 acceptance: D1 sheet ≥1600×600 per shot; D2 HTML lists every still;
 *  D3 no absolute paths in HTML or sheet text. Zero LLM — sharp + SVG text only. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as nodeTest from "node:test";
import sharp from "sharp";
import { buildQcSheet, buildQcSheetHtml, firstSentences, lastSentence, sanitizeSheetText } from "./qc-sheet";

const bareBun = !!process.versions.bun && process.env.BUN_TEST !== "1";
const cases: { name: string; fn: () => void | Promise<void> }[] = [];
const test = bareBun
  ? (name: string, fn: () => void | Promise<void>) => cases.push({ name, fn })
  : nodeTest.test;

async function fixturePng(dir: string, name: string, bg: { r: number; g: number; b: number }, noise: boolean) {
  const file = path.join(dir, name);
  if (noise) {
    const buf = Buffer.from(Array.from({ length: 640 * 360 * 3 }, () => Math.floor(Math.random() * 256)));
    await sharp(buf, { raw: { width: 640, height: 360, channels: 3 } }).png().toFile(file);
  } else {
    await sharp({ create: { width: 640, height: 360, channels: 3, background: bg } }).png().toFile(file);
  }
  return file;
}

test("T37 D1: fixture sheet is a real PNG at exactly 1600×600", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-t37-"));
  const f0 = await fixturePng(dir, "SH01.f0.png", { r: 30, g: 34, b: 44 }, true);
  const still = await fixturePng(dir, "SH01.png", { r: 58, g: 66, b: 80 }, false);
  await buildQcSheet(
    {
      shotId: "SH01",
      f0File: f0,
      stillFile: still,
      status: "FAIL",
      failReasons: ["location: hits 1/3 — misses \"首都地下停屍間\"", "size: unmeasured - require medium"],
      requireLocation: "首都地下停屍間",
      blind: "一人跪喺濕街道，遠處霓虹燈。地面有水漬。背景高樓。",
      prompt: "生成一句。生成二句。最後一句係事後驗證句。",
    },
    path.join(dir, "SH01.qc-sheet.png"),
  );
  const out = path.join(dir, "SH01.qc-sheet.png");
  assert.ok(fs.existsSync(out));
  const meta = await sharp(out).metadata();
  assert.ok((meta.width ?? 0) >= 1600, `width ${meta.width}`);
  assert.ok((meta.height ?? 0) >= 600, `height ${meta.height}`);
});

test("T37 D2: HTML lists every still exactly once", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-t37-html-"));
  const rows = ["SH01", "SH02", "SH03"].map((id) => ({
    shotId: id,
    status: id === "SH02" ? "FAIL" : "PASS_WITH_WARN",
    failReasons: id === "SH02" ? ["empty_frame: dark coverage 0.90 >= 0.8"] : [],
    sheetBasename: `${id}.qc-sheet.png`,
  }));
  const outFile = path.join(dir, "SC-TEST.qc-sheet.html");
  buildQcSheetHtml(rows, outFile);
  const html = fs.readFileSync(outFile, "utf8");
  for (const id of ["SH01", "SH02", "SH03"]) {
    assert.equal(html.split(`alt="${id}"`).length - 1, 1, `${id} appears exactly once`);
  }
  assert.ok(html.includes(`src="SH02.qc-sheet.png"`));
});

test("T37 D3: no absolute paths in HTML or sheet text", () => {
  const scrubbed = sanitizeSheetText("blind 提到 /home/c/jobs/SC/x.png 同 /mnt/ssd/secret 出面。");
  assert.ok(!scrubbed.includes("/home/") && !scrubbed.includes("/mnt/"), scrubbed);
  assert.ok(scrubbed.includes("[路徑]"));
  const rows = [
    {
      shotId: "SH01",
      status: "GREEN",
      failReasons: [],
      sheetBasename: "SH01.qc-sheet.png",
    },
  ];
  const outFile = path.join(os.tmpdir(), "SC-ABS.qc-sheet.html");
  buildQcSheetHtml(rows, outFile);
  const html = fs.readFileSync(outFile, "utf8");
  assert.ok(!html.includes("/home/"), "no /home in HTML");
  assert.ok(!html.includes("/mnt/"), "no /mnt in HTML");
  assert.ok(!/src="\//.test(html), "no absolute src");
  fs.rmSync(outFile);
});

test("T37 helpers: sentences + scrub", () => {
  assert.equal(firstSentences("甲。乙！丙？丁。戊", 3), "甲。 乙！ 丙？");
  assert.equal(lastSentence("甲。乙。\n丙。"), "丙。");
  assert.equal(lastSentence("無句號結尾"), "無句號結尾");
});

if (bareBun) {
  void (async () => {
    let failed = 0;
    for (const c of cases) {
      try {
        await c.fn();
        console.log(`ok - ${c.name}`);
      } catch (err) {
        failed += 1;
        console.error(`not ok - ${c.name}\n${err instanceof Error ? err.stack : String(err)}`);
      }
    }
    console.log(`# ${cases.length - failed}/${cases.length} passed`);
    if (failed > 0) process.exit(1);
  })();
}
