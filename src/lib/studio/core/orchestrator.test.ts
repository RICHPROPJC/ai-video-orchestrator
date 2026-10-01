import assert from "node:assert/strict";
import * as nodeTest from "node:test";
import { SEAT_ORDER, UNTIL_SEAT } from "./orchestrator";

nodeTest.test("席次順序照 ALIGN-LOCK", () => {
  assert.equal(SEAT_ORDER.length, 11); // 12席 - producer（調度者）= 11 個執行席
  assert.equal(SEAT_ORDER[0], "writer");
  assert.equal(SEAT_ORDER[SEAT_ORDER.length - 1], "delivery");
});

nodeTest.test("--until 停止位對應正確嘅席", () => {
  assert.equal(UNTIL_SEAT["boards"], "boards");
  assert.equal(UNTIL_SEAT["blockout"], "layout");
  assert.equal(UNTIL_SEAT["stills"], "stills");
  assert.equal(UNTIL_SEAT["motion"], "motion");
});

nodeTest.test("art → layout → stills 順序正確", () => {
  const art = SEAT_ORDER.indexOf("art" as never);
  const layout = SEAT_ORDER.indexOf("layout" as never);
  const stills = SEAT_ORDER.indexOf("stills" as never);
  assert.ok(art < layout, "art 喺 layout 之前");
  assert.ok(layout < stills, "layout 喺 stills 之前");
});
