import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { measureWorkbenchGreyLeak } from "./workbench-grey-leak";

const HOOK = "/home/c/orca/workspaces/sov-cli-merge-wip/hookaudit/verify";

test("C7 SH01 grey head is machine FAIL (vision GREEN hole)", async () => {
  const file = path.join(HOOK, "c7/frames/SH01_f0048.jpg");
  assert.ok(fs.existsSync(file), file);
  const m = await measureWorkbenchGreyLeak(file);
  assert.equal(m.hit, true, JSON.stringify(m.blobs.slice(0, 3)));
});

test("C7 SH03 two grey people is machine FAIL", async () => {
  const file = path.join(HOOK, "c7/frames/SH03_f0048.jpg");
  const m = await measureWorkbenchGreyLeak(file);
  assert.equal(m.hit, true, JSON.stringify(m.blobs.slice(0, 3)));
});

test("C6 photoreal still is not a workbench silhouette", async () => {
  const file = path.join(HOOK, "c6/SH01.png");
  assert.ok(fs.existsSync(file), file);
  const m = await measureWorkbenchGreyLeak(file);
  assert.equal(m.hit, false, JSON.stringify(m.blobs.slice(0, 3)));
});
