import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadCallSheet } from "./writer";
import { buildProse, buildProsePositive } from "./h3-prose";
import { submitH3Shot } from "./h3-submit";
import type { H3GraphVariant } from "./h3-r2v-graph";
import type { Shot } from "./types";

const JOB = "SC-0913-WIST";
const ROOT = path.resolve(process.cwd(), "data/jobs", JOB);
const DRY = path.join(ROOT, "verify/ab/dry");
const VARIANTS: H3GraphVariant[] = ["a", "b", "bkf", "c"];
const SHOTS = ["SH01", "SH04"];

function wavFor(shot: string) {
  const h3 = path.join(ROOT, "audio", `${shot}.h3.wav`);
  return fs.existsSync(h3) ? h3 : path.join(ROOT, "wav", `${shot}.wav`);
}

function refImagesFor(shot: Shot) {
  const still = path.join(ROOT, "stills", `${shot.id}.png`);
  const ids = [...new Set(shot.marks.map((m) => m.characterId))];
  return [still, ...ids.map((id) => path.join(ROOT, "portraits", `${id}.png`)).filter((p) => fs.existsSync(p))];
}

/** §5b C-form identity refs on WIST: front portraits (the sheet carries no
 *  refAngle column — absent reads front). */
function anglePortraitsFor(shot: Shot) {
  const ordered = [...new Set([...shot.marks].sort((a, b) => a.start.x - b.start.x).map((m) => m.characterId))];
  const files = ordered.map((id) => path.join(ROOT, "portraits", `${id}.png`)).filter((p) => fs.existsSync(p));
  if (files.length !== ordered.length) {
    throw new Error(`${shot.id}: WIST portraits missing for ${ordered.join(",")}`);
  }
  return files;
}

function proseFor(variant: H3GraphVariant, sheet: ReturnType<typeof loadCallSheet>, shot: Shot) {
  if (variant === "a") return buildProse(sheet, shot, { form: "c" });
  const ids = [...new Set(shot.marks.map((m) => m.characterId))];
  const portraits = ids
    .map((id) => sheet.characters.find((c) => c.id === id))
    .filter(Boolean)
    .map((c) => ({ id: c!.id, name: c!.name }));
  return buildProsePositive(sheet, shot, { motionOnly: variant === "c", portraits });
}

test("WIST verify/ab/dry receipts: A=C-form (§5b), B/BKF/C alternates — SH01/SH04", async (t) => {
  if (!fs.existsSync(ROOT)) {
    t.skip(`missing job dir ${ROOT}`);
    return;
  }
  const sheet = loadCallSheet(path.join(ROOT, "callsheet.json"));
  fs.mkdirSync(DRY, { recursive: true });

  for (const shotId of SHOTS) {
    const shot = sheet.shots.find((s) => s.id === shotId);
    assert.ok(shot, shotId);
    for (const variant of VARIANTS) {
      const tag = variant.toUpperCase();
      const receiptJson = path.join(DRY, `${shotId}.${tag}.json`);
      const { receipt, receiptFile } = await submitH3Shot({
        prose: proseFor(variant, sheet, shot),
        wavFile: wavFor(shotId),
        // §5b: only the A production path carries the Video 1 (C-form)
        blockoutMp4: variant === "a" ? path.join(ROOT, "blockout", `${shotId}.mp4`) : undefined,
        refImageFiles:
          variant === "a"
            ? anglePortraitsFor(shot)
            : variant === "b" || variant === "bkf"
              ? refImagesFor(shot)
              : undefined,
        kfStart: variant === "a" ? undefined : path.join(ROOT, "stills", `${shotId}.png`),
        outMp4: path.join(ROOT, "motion", `${shotId}.mp4`),
        receiptJson,
        dryRun: true,
        shot: shotId,
        requireQuote: Boolean(shot.dialogue.trim()),
        graphVariant: variant,
      });
      assert.equal(receiptFile, receiptJson);
      assert.equal(receipt.graph_variant, variant);
      assert.equal(receipt.dry_run, true);
      assert.equal(receipt.steps, 8); // turbo 8-step v1.0（Chau 0921裁；test鎖語義：receipt照config.steps）

      const graph = receipt.graph as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
      const r2v = graph.r2v.inputs;
      const hasVideo = "blender_vid" in graph && "ref_videos.ref_video_0" in r2v;
      const refImgKeys = Object.keys(r2v).filter((k) => k.startsWith("ref_images."));
      const hasKf = "keyframes" in graph && graph.keyframes.class_type === "H3Keyframes";
      // §5b: the 8-step road never wires the accel patch
      const fbcNodes = Object.values(graph).filter((n) =>
        n.class_type === "H3FirstBlockCache" || n.class_type === "SolAttnMiniMaxH3Patcher",
      );
      assert.equal(fbcNodes.length, 0, `${shotId}.${tag}: steps=8 must carry zero FBC/SolAttn nodes`);

      if (variant === "a") {
        // C-form: Video 1 in, zero keyframes, portrait identity, C8 bindings
        assert.equal(receipt.motion_form, "c");
        assert.equal(receipt.keyframe_positions, "");
        assert.equal(receipt.uploads.kf_start, null);
        assert.ok(hasVideo);
        assert.ok(refImgKeys.length >= 1, "identity portrait must ride ref_image_0");
        assert.equal(hasKf, false);
        assert.match(String(graph.split.inputs.bindings), /<Picture 1> is the sole appearance and identity reference/);
        assert.match(String(graph.split.inputs.bindings), /<Video 1> is motion only/);
        assert.match(receipt.prompt, /<Picture 1>/);
      }
      if (variant === "b") {
        assert.equal(hasVideo, false);
        assert.ok(refImgKeys.length >= 1);
        assert.equal(hasKf, false);
        assert.equal(graph.split.inputs.bindings, "");
        assert.match(receipt.prompt, /<Picture 1>/);
      }
      if (variant === "bkf") {
        assert.equal(hasVideo, false);
        assert.ok(refImgKeys.length >= 1);
        assert.ok(hasKf);
        assert.equal(graph.split.inputs.bindings, "");
      }
      if (variant === "c") {
        assert.equal(hasVideo, false);
        assert.equal(refImgKeys.length, 0);
        assert.ok(hasKf);
        assert.equal(graph.split.inputs.bindings, "");
        assert.doesNotMatch(receipt.prompt, /<Picture 1>/);
      }
    }
  }
});

test("§5b prohibition on WIST: A-path submit with blockout + kf refuses to emit", async (t) => {
  if (!fs.existsSync(ROOT)) {
    t.skip(`missing job dir ${ROOT}`);
    return;
  }
  const sheet = loadCallSheet(path.join(ROOT, "callsheet.json"));
  const shot = sheet.shots.find((s) => s.id === "SH01")!;
  await assert.rejects(
    () =>
      submitH3Shot({
        prose: buildProse(sheet, shot, { form: "c" }),
        wavFile: wavFor("SH01"),
        blockoutMp4: path.join(ROOT, "blockout", "SH01.mp4"),
        kfStart: path.join(ROOT, "stills", "SH01.png"),
        refImageFiles: anglePortraitsFor(shot),
        outMp4: path.join(ROOT, "motion", "SH01.mp4"),
        receiptJson: path.join(DRY, "SH01.A.refused.json"),
        dryRun: true,
        shot: "SH01",
        requireQuote: Boolean(shot.dialogue.trim()),
      }),
    /keyframes_video1_coexist/,
  );
});
