import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { measureWorkbenchGreyLeak } from "./workbench-grey-leak";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "grey-leak");

test("C7 SH01 grey head is machine FAIL (vision GREEN hole)", async () => {
  const file = path.join(FIX, "SH01_f0048.jpg");
  assert.ok(fs.existsSync(file), file);
  const m = await measureWorkbenchGreyLeak(file);
  assert.equal(m.hit, true, JSON.stringify(m.blobs.slice(0, 3)));
});

test("C7 SH03 two grey people is machine FAIL", async () => {
  const file = path.join(FIX, "SH03_f0048.jpg");
  const m = await measureWorkbenchGreyLeak(file);
  assert.equal(m.hit, true, JSON.stringify(m.blobs.slice(0, 3)));
});

test("high-chroma still is not a workbench silhouette", async () => {
  const file = path.join(os.tmpdir(), `slatecrew-chroma-${process.pid}.png`);
  await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 200, g: 40, b: 30 } },
  })
    .png()
    .toFile(file);
  try {
    const m = await measureWorkbenchGreyLeak(file);
    assert.equal(m.hit, false, JSON.stringify(m.blobs.slice(0, 3)));
  } finally {
    fs.rmSync(file, { force: true });
  }
});
