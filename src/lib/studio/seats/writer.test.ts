/** Writer席unit test */
import assert from "node:assert/strict";
import * as nodeTest from "node:test";
import { maxBeatsForSec, dialogueSeconds, totalSceneSec } from "./writer";

nodeTest.test("1.5秒=1 beat", () => {
  assert.equal(maxBeatsForSec(1.5), 1);
});
nodeTest.test("2.33秒=2 beats", () => {
  assert.equal(maxBeatsForSec(2.33), 2);
});
nodeTest.test("3秒=2 beats", () => {
  assert.equal(maxBeatsForSec(3.0), 2);
});
nodeTest.test("對白時鐘：3個字≈1.25秒", () => {
  const s = dialogueSeconds("凍甜而家");
  assert.ok(s > 1.0 && s < 1.5, `3字應≈1.25s，得${s}`);
});
nodeTest.test("場次加總", () => {
  assert.equal(totalSceneSec([{targetSec:5},{targetSec:3},{targetSec:4}]), 12);
});
