import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { runBoards } from "./seat-boards";
import { type BoardLane } from "./asset-board";
import { segmentFrameBudget } from "./motion-select";
import { buildH3Graph } from "./h3-r2v-graph";
import { defaultConfig } from "./config";
import { checkGate } from "./concat-gate";
import { writeWav } from "./audio";
import { GET } from "../../app/api/media/[...path]/route";

test("media preview is bounded WebP; opening the image keeps the original PNG", async () => {
  const cwd = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "align-preview-"));
  const imageDir = path.join(dir, "data", "jobs", "fixture", "stills");
  fs.mkdirSync(imageDir, { recursive: true });
  await sharp({ create: { width: 1600, height: 1200, channels: 3, background: "red" } }).png().toFile(path.join(imageDir, "SH01.png"));
  try {
    process.chdir(dir);
    const ctx = { params: Promise.resolve({ path: ["fixture", "stills", "SH01.png"] }) };
    const preview = await GET(new Request("http://localhost/api/media/fixture/stills/SH01.png?preview=1"), ctx);
    assert.equal(preview.headers.get("Content-Type"), "image/webp");
    const small = Buffer.from(await preview.arrayBuffer());
    const meta = await sharp(small).metadata();
    assert.equal(meta.width, 320);
    assert.equal(meta.height, 240);
    const original = await GET(new Request("http://localhost/api/media/fixture/stills/SH01.png"), ctx);
    assert.equal(original.headers.get("Content-Type"), "image/png");
    const full = Buffer.from(await original.arrayBuffer());
    assert.equal((await sharp(full).metadata()).width, 1600);
    assert.ok(small.length < full.length);
  } finally { process.chdir(cwd); }
});

test("boards repairs only rejected cells, keeps shot/position/hash/QC receipts", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "align-boards-"));
  let calls = 0;
  let qcCalls = 0;
  const prompts: string[] = [];
  const lane: BoardLane = {
    edit: async (o) => {
      calls++;
      prompts.push(o.prompt);
      if (calls === 2) {
        assert.equal(o.images.length, 1, "repair feeds back only the rejected composite");
        assert.match(o.images[0]!, /repair-input\.png$/);
        assert.equal((await sharp(o.images[0]!).metadata()).width, 512);
      }
      await sharp({ create: { width: 64, height: 64, channels: 3, background: calls === 1 ? "red" : "blue" } }).png().toFile(o.outFile);
    },
    cut: async (board, cells) => {
      for (const c of cells) await sharp(board).extract({ left: c.x, top: c.y, width: c.w, height: c.h }).png().toFile(c.file);
    },
    qc: async (_file, out) => {
      const status = ++qcCalls === 2 ? "FAIL" : "GREEN";
      const result = { status, checks: { status, fail_reasons: status === "FAIL" ? ["bad cell"] : [] } } as const;
      fs.writeFileSync(out, JSON.stringify(result));
      return result;
    },
    rembg: async () => { throw new Error("storyboards must keep their scene"); },
  };
  const moments = [0, 1, 2].map((i) => ({ shotId: "SH01", at: `${i * 50}%`, text: "抬手", file: path.join(dir, `cell-${i}.png`) }));
  const result = await runBoards({ render: { moments, boardsDir: path.join(dir, "boards"), receiptDir: path.join(dir, "seats"), name: "fixture", images: [], lane } });
  assert.equal(calls, 2);
  assert.equal(qcCalls, 4, "good neighbours are not rejudged on repair");
  assert.ok(prompts.every((p) => p.includes("專業分鏡板")));
  const rgb = async (f: string) => [...(await sharp(f).raw().toBuffer()).subarray(0, 3)];
  assert.deepEqual(await rgb(moments[0]!.file), [255, 0, 0]);
  assert.deepEqual(await rgb(moments[1]!.file), [0, 0, 255]);
  assert.deepEqual(await rgb(moments[2]!.file), [255, 0, 0]);
  const receipt = JSON.parse(fs.readFileSync(result.receipt, "utf8"));
  assert.equal(receipt.owner, "boards");
  assert.equal(receipt.status, "GREEN");
  assert.deepEqual(receipt.attempts[1].cells.map((c: { at: string }) => c.at), ["50%"]);
  for (const attempt of receipt.attempts) for (const cell of attempt.cells) {
    assert.match(cell.sha256, /^[a-f0-9]{64}$/);
    assert.ok(fs.existsSync(cell.qc));
  }
});

const graph = {
  script: "test", bindings: "", frames: 73, steps: 8, seed: 42,
  filenamePrefix: "test", wavName: "audio.wav", kfStartName: "1.png", kfEndName: "2.png",
  models: { textEncoder: defaultConfig.motion.textEncoder, encoderType: "minimax", videoVae: defaultConfig.motion.videoVae, audioVae: defaultConfig.motion.audioVae, ref2va: defaultConfig.motion.checkpoint, fl2va: defaultConfig.motion.fl2va, turboLora: defaultConfig.motion.turboLora },
};

test("H3 anchor seven onwards use the batch in the original order", () => {
  const g = buildH3Graph({ ...graph, keyframePositions: "0%, 10%, 20%, 30%, 40%, 50%, 75%, 100%", kfExtraNames: ["3.png", "4.png", "5.png", "6.png", "7.png", "8.png"] });
  assert.equal(g.keyframes.inputs.image_7, undefined);
  assert.deepEqual(g.keyframes.inputs.image_6, ["kf_img_6", 0]);
  assert.deepEqual(g.keyframes.inputs.images_batch, ["kf_batch_8", 0]);
  assert.deepEqual(g.kf_batch_8.inputs, { image1: ["kf_img_7", 0], image2: ["kf_img_8", 0] });
  assert.equal(g.keyframes.inputs.length, 73);
  assert.throws(() => buildH3Graph({ ...graph, keyframePositions: "0%, 50%, 100%" }), /keyframe_positions_invalid/);
  assert.throws(() => buildH3Graph({ ...graph, keyframePositions: "50%, 10%" }), /keyframe_positions_invalid/);
});

test("eight 68-frame requests budget 73 each; measured 577 cannot override the gate", async () => {
  assert.deepEqual(segmentFrameBudget(Array(8).fill(68 / 24)), { perShot: 73, total: 584 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "align-clock-"));
  const wav = path.join(dir, "silent.wav");
  writeWav(wav, new Float32Array(68000), 24000);
  const ids = Array.from({ length: 8 }, (_, i) => `SH0${i + 1}`);
  fs.writeFileSync(path.join(dir, `${ids.join("-")}.mp4`), "not probed: bad manifest must fail first");
  const result = await checkGate({
    plan: { gap_s: 0, shots: ids.map((id, i) => ({ id, wav, duration_s: 68 / 24, start_s: i * 68 / 24, end_s: (i + 1) * 68 / 24 })) },
    motionDir: dir, segments: [{ shots: ids, kind: "multishot", frames: 577, perShot: 73 }],
  });
  assert.equal(result.ok, false);
  assert.match(result.reason!, /577 != planned grid budget 584/);
});
