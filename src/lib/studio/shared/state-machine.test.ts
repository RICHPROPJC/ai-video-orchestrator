import assert from "node:assert/strict";
import * as nodeTest from "node:test";
import { transition, canTransition, TRANSITIONS, type SeatStatus } from "./state-machine";

nodeTest.test("合法轉移：PENDING → dependencies_ready → READY", () => {
  const r = transition("PENDING", "dependencies_ready");
  assert.equal(r.next, "READY");
  assert.equal(r.sameAttempt, true);
});

nodeTest.test("合法轉移：RUNNING → lease_expired → READY（同 attempt）", () => {
  const r = transition("RUNNING", "lease_expired");
  assert.equal(r.next, "READY");
  assert.equal(r.sameAttempt, true);
});

nodeTest.test("合法轉移：PASSED → repair_requested → SUPERSEDED（新 attempt）", () => {
  const r = transition("PASSED", "repair_requested");
  assert.equal(r.next, "SUPERSEDED");
  assert.equal(r.sameAttempt, false);
});

nodeTest.test("非法轉移：PENDING → completed 直接跳", () => {
  assert.throws(() => transition("PENDING", "completed"), /state_transition_invalid/);
});

nodeTest.test("非法轉移：SUPERSEDED 任何事件", () => {
  assert.throws(() => transition("SUPERSEDED", "dependencies_ready"), /state_transition_invalid/);
});

nodeTest.test("SKIPPED 可以 reactivated", () => {
  assert.ok(canTransition("SKIPPED", "reactivated"));
});

nodeTest.test("FAILED_TERMINAL 只可以 replacement", () => {
  assert.ok(canTransition("FAILED_TERMINAL", "replacement_authorized"));
  assert.ok(!canTransition("FAILED_TERMINAL", "retry_authorized"));
});

nodeTest.test("轉移表完整性：每個 from-status 至少有一個合法轉移（SUPERSEDED 除外）", () => {
  const statuses: SeatStatus[] = [
    "PENDING","READY","RUNNING","PASSED","PARTIAL","BLOCKED",
    "FAILED_RETRYABLE","FAILED_TERMINAL","SKIPPED",
  ];
  for (const s of statuses) {
    assert.ok(TRANSITIONS.some(t => t.from === s), `${s} 冇任何合法轉移`);
  }
});
