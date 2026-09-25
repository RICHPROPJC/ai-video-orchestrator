import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { STILLS_EDIT } from "./u15-edit";
import { H3_KEYFRAME, h3KeyframePath, writeH3KeyframeProxy } from "./still-h3-proxy";

test("h3KeyframePath swaps .png → .h3.png", () => {
  assert.equal(h3KeyframePath("/j/stills/SH01.png"), "/j/stills/SH01.h3.png");
  assert.equal(h3KeyframePath("/j/stills/SH01.h3.png"), "/j/stills/SH01.h3.png");
});

test("writeH3KeyframeProxy downscales 4K → 2K for H3", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "h3-proxy-"));
  const still = path.join(dir, "SH01.png");
  await sharp({
    create: {
      width: STILLS_EDIT.width,
      height: STILLS_EDIT.height,
      channels: 3,
      background: { r: 40, g: 80, b: 120 },
    },
  })
    .png()
    .toFile(still);
  const r = await writeH3KeyframeProxy(still);
  assert.equal(r.output, path.join(dir, "SH01.h3.png"));
  assert.deepEqual(r.output_wh, [H3_KEYFRAME.width, H3_KEYFRAME.height]);
  assert.equal(r.reason, "4k_master_downscale_for_h3");
  const meta = await sharp(r.output).metadata();
  assert.equal(meta.width, 2048);
  assert.equal(meta.height, 1152);
  assert.ok(fs.existsSync(`${r.output}.json`));
});

test("writeH3KeyframeProxy refuses non-4K master", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "h3-proxy-bad-"));
  const still = path.join(dir, "SH01.png");
  await sharp({
    create: { width: 2048, height: 1152, channels: 3, background: { r: 1, g: 2, b: 3 } },
  })
    .png()
    .toFile(still);
  await assert.rejects(() => writeH3KeyframeProxy(still), /expects 4K master/);
});
