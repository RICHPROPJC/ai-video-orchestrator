import assert from "node:assert/strict";
import * as nodeTest from "node:test";
import { editorSeat } from "./editor";
nodeTest.test("editor seat exists", () => { assert.ok(editorSeat); assert.equal(editorSeat.seatId, "editor"); });
