import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "./audio";
import { changePoints, pick, writeAnchors } from "./dhash-anchors";

async function ffmpeg(args: string[]) {
  const r = await runCommand("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args]);
  if (r.code !== 0) throw new Error(r.stderr || "ffmpeg failed");
}

test("minGap 124 drops a peak at frame 35", () => {
  const deltas = new Array(200).fill(0);
  deltas[35] = 20;
  deltas[150] = 30;
  const cands = changePoints(deltas);
  assert.deepEqual(cands, [35, 150]);
  assert.deepEqual(pick(cands, deltas, 5, 124), [0, 150]);
});

test("lavfi flat 150f + ramp 150f anchors [0, ~150]", async () => {
  // dHash compares adjacent pixels, so two *uniform* colors both hash to 0 —
  // the second half is a decreasing luminance ramp (all 64 bits set) so the
  // flat→ramp cut is a real change point, like a camera move in a blockout.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-dh-"));
  const flat = path.join(dir, "flat.mp4");
  const ramp = path.join(dir, "ramp.mp4");
  const both = path.join(dir, "both.mp4");
  await ffmpeg(["-f", "lavfi", "-i", "color=c=0x808080:s=320x180:r=24", "-frames:v", "150", "-c:v", "libx264", "-pix_fmt", "yuv420p", flat]);
  await ffmpeg([
    "-f", "lavfi", "-i", "color=c=black:s=320x180:r=24",
    "-vf", "geq=lum=255-255*X/W",
    "-frames:v", "150", "-c:v", "libx264", "-pix_fmt", "yuv420p", ramp,
  ]);
  await ffmpeg(["-i", flat, "-i", ramp, "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]", both]);
  const record = await writeAnchors(both, path.join(dir, "anchors.json"));
  assert.equal(record.frame_count, 300);
  const frames = record.anchors.map((a) => a.frame);
  assert.equal(frames[0], 0);
  assert.ok(Math.abs(frames[1]! - 150) <= 2, `second anchor ~150, got ${frames[1]}`);
});
