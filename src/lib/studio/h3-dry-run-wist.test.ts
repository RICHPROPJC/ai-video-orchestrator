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

function proseFor(variant: H3GraphVariant, sheet: ReturnType<typeof loadCallSheet>, shot: Shot) {
  if (variant === "a") return buildProse(sheet, shot);
  const ids = [...new Set(shot.marks.map((m) => m.characterId))];
  const portraits = ids
    .map((id) => sheet.characters.find((c) => c.id === id))
    .filter(Boolean)
    .map((c) => ({ id: c!.id, name: c!.name }));
  return buildProsePositive(sheet, shot, { motionOnly: variant === "c", portraits });
}

test("WIST verify/ab/dry receipts for A/B/BKF/C on SH01 and SH04", async (t) => {
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
        blockoutMp4: path.join(ROOT, "blockout", `${shotId}.mp4`),
        kfStart: path.join(ROOT, "stills", `${shotId}.png`),
        kfEnd: variant === "a" ? path.join(ROOT, "stills", `${shotId}.png`) : undefined,
        refImageFiles: variant === "b" || variant === "bkf" ? refImagesFor(shot) : undefined,
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
      assert.equal(receipt.steps, 4);

      const graph = receipt.graph as Record<string, { inputs: Record<string, unknown> }>;
      const r2v = graph.r2v.inputs;
      const hasVideo = "blender_vid" in graph && "ref_videos.ref_video_0" in r2v;
      const refImgKeys = Object.keys(r2v).filter((k) => k.startsWith("ref_images."));
      const hasKf = "kfinject" in graph;

      if (variant === "a") {
        assert.ok(hasVideo);
        assert.equal(refImgKeys.length, 0);
        assert.ok(hasKf);
        assert.match(String(graph.split.inputs.bindings), /Video 1/);
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
