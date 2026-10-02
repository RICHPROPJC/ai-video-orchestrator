/** Boards席unit test */
import assert from "node:assert/strict";
import * as nodeTest from "node:test";
import { isSizeJump, boardCellCheck } from "./boards";

nodeTest.test("相鄰景別唔係跳", () => {
  assert.ok(!isSizeJump("medium", "closeup"));
  assert.ok(!isSizeJump("wide", "full"));
});
nodeTest.test("隔一級係跳", () => {
  assert.ok(isSizeJump("wide", "medium"));
  assert.ok(isSizeJump("insert", "full"));
});
nodeTest.test("同級唔係跳", () => {
  assert.ok(!isSizeJump("medium", "medium"));
});
nodeTest.test("未知景別唔判跳", () => {
  assert.ok(!isSizeJump("unknown", "medium"));
});
nodeTest.test("boardCellCheck：灰模fail", () => {
  const r = boardCellCheck({ expectedPeople: 1, greyBlocks: true });
  assert.ok(!r.pass);
  assert.ok(r.reasons[0].includes("grey_blocks"));
});
nodeTest.test("boardCellCheck：乾淨pass", () => {
  const r = boardCellCheck({ expectedPeople: 1, greyBlocks: false });
  assert.ok(r.pass);
});
