import assert from "node:assert/strict";
import test from "node:test";
import { getCapabilityCatalog, isWired, pickCapability } from "./capability-catalog";
import { getSpec, selectPlaybook } from "./spec";
import skills from "./skills.json";
import playbooks from "./playbooks.json";

test("one catalog: every F4 playbook and skill has id version cast props preconditions doneState license receipt", () => {
  const catalog = getCapabilityCatalog();
  const ids = new Set(catalog.map((entry) => entry.id));
  for (const book of playbooks as Array<{ id: string }>) assert.ok(ids.has(book.id), book.id);
  for (const skill of Object.keys(skills)) assert.ok(ids.has(skill), skill);
  for (const entry of catalog) {
    assert.equal(typeof entry.id, "string");
    assert.ok(entry.version.length > 0, entry.id);
    assert.ok(entry.kind === "skill" || entry.kind === "playbook", entry.id);
    assert.ok(Array.isArray(entry.cast), entry.id);
    assert.ok(Array.isArray(entry.props), entry.id);
    assert.ok(Array.isArray(entry.preconditions), entry.id);
    assert.equal(typeof entry.doneState, "string", entry.id);
    assert.equal(entry.license, "repo", entry.id);
    assert.ok(entry.receipt && entry.receipt.startsWith("shots/fixtures/"), `${entry.id} must be receipted in the F4 pin`);
  }
});

test("model may pick only wired+receipted ids; unknown is no_playbook", () => {
  assert.equal(pickCapability("nope"), null);
  assert.equal(isWired("invented_skill"), false);
  assert.equal(pickCapability("pb.plaza.v2")?.receipt, "shots/fixtures/f4");
  assert.equal(pickCapability("walk_cycle")?.receipt, "shots/fixtures/f2");
  assert.equal(selectPlaybook("plaza")?.id, "pb.plaza.v2");
  assert.equal(selectPlaybook("invent a dragon plaza"), null);
});

test("getSpec exposes the same catalog — no parallel enum", () => {
  const spec = getSpec();
  assert.deepEqual(spec.capabilities.map((c) => c.id), getCapabilityCatalog().map((c) => c.id));
  assert.equal(spec.rules.pick, "Only catalog entries with a receipt; else no_playbook");
});
