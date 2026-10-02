import assert from "node:assert/strict";
import * as nodeTest from "node:test";
import { motionSeat } from "./motion";
nodeTest.test("motion seat exists", () => { assert.ok(motionSeat); assert.equal(motionSeat.seatId, "motion"); });
