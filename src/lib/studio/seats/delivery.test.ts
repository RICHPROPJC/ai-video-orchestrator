import assert from "node:assert/strict";
import * as nodeTest from "node:test";
import { deliverySeat } from "./delivery";
nodeTest.test("delivery seat exists", () => { assert.ok(deliverySeat); assert.equal(deliverySeat.seatId, "delivery"); });
