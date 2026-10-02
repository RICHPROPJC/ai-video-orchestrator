/** Art席unit test */
import assert from "node:assert/strict";
import * as nodeTest from "node:test";
import { needsRig, isIsolatedRef } from "./art";

nodeTest.test("角色有動作→需要rig", () => {
  assert.ok(needsRig("character", true));
});
nodeTest.test("角色冇動作→唔需要rig", () => {
  assert.ok(!needsRig("character", false));
});
nodeTest.test("道具→永遠唔需要rig", () => {
  assert.ok(!needsRig("prop", true));
});
nodeTest.test("portrait/product係isolated", () => {
  assert.ok(isIsolatedRef("portrait"));
  assert.ok(isIsolatedRef("product"));
  assert.ok(!isIsolatedRef("scene"));
});
