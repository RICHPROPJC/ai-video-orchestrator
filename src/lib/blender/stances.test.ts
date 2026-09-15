import assert from "node:assert/strict";
import test from "node:test";
import { CharacterActionSchema, ToolCallSchema } from "./spec";
import type { CharacterAction } from "./types";

const actions: CharacterAction[] = ["lie", "kneel", "crouch", "lean", "turn_away"];
for (const action of actions) {
  test(`C5 stance vocabulary: ${action}`, () => {
    assert.equal(CharacterActionSchema.parse(action), action);
    assert.deepEqual(ToolCallSchema.parse({ tool: "character.action", args: { name: "Hero", action } }), {
      tool: "character.action", args: { name: "Hero", action },
    });
  });
}
test("new stances do not permit invented actions", () => {
  assert.equal(CharacterActionSchema.safeParse("teleport").success, false);
});
