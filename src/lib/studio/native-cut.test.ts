import test from "node:test";
import assert from "node:assert/strict";
import { assertNativeFfmpeg, assertNoOuterGap, concatCopyArgs } from "./native-cut";

test("concat -c copy is the only picture-lock join", () => {
  const args = concatCopyArgs("/tmp/mux-list.txt", "/tmp/picture-lock.mp4");
  assert.deepEqual(args, ["-f", "concat", "-safe", "0", "-i", "/tmp/mux-list.txt", "-c", "copy", "/tmp/picture-lock.mp4"]);
});

test("xfade and setpts fail loud", () => {
  assert.throws(() => assertNativeFfmpeg(["-filter_complex", "xfade=transition=fade:duration=0.5"]), /xfade/);
  assert.throws(() => assertNativeFfmpeg(["-vf", "setpts=PTS-STARTPTS"]), /setpts/);
});

test("gapSec > 0 is an outer cut", () => {
  assert.doesNotThrow(() => assertNoOuterGap(0));
  assert.throws(() => assertNoOuterGap(0.25), /gapSec=0.25/);
});
