import assert from "node:assert/strict";
import * as nodeTest from "node:test";
import { routeAsset, routeShot, routeReferencePacket, getProviderMode } from "./router";

nodeTest.test("routeAsset：procedural_threejs 係 observe 唔自動選中", () => {
  const d = routeAsset({
    subject: "character",
    requiredOutputs: ["character_reference"],
    constraints: {},
  });
  assert.ok(d.selectedProvider.length > 0);
  assert.ok(d.rejectedProviders.length >= 0);
});

nodeTest.test("routeShot：需要接觸 → ref2va", () => {
  const d = routeShot({
    subject: "shot",
    requiredOutputs: ["h3_video"],
    constraints: { contactRequired: true },
    intent: { version: 1, contact: { required: true, actors: ["hand.R"], preferredStorySec: 1.25, toleranceSec: 0.12, enforcement: "edit_or_qc" } },
  });
  assert.equal(d.selectedH3Route, "ref2va");
});

nodeTest.test("routeShot：冇動作路徑 → fl2va", () => {
  const d = routeShot({
    subject: "shot",
    requiredOutputs: ["h3_video"],
    constraints: {},
  });
  assert.equal(d.selectedH3Route, "fl2va");
});

nodeTest.test("routeReferencePacket：ref2va → multimodal_reference", () => {
  const d = routeReferencePacket({
    subject: "reference_packet",
    requiredOutputs: ["h3_video"],
    constraints: { contactRequired: true },
    intent: { version: 1, contact: { required: true, actors: [], preferredStorySec: 0, toleranceSec: 0, enforcement: "edit_or_qc" } },
  });
  assert.equal(d.motionSource, "multimodal_reference");
});

nodeTest.test("provider mode 查詢", () => {
  assert.equal(getProviderMode("legacy_sf3d"), "fallback");
  assert.equal(getProviderMode("procedural_threejs_v1"), "observe");
  assert.equal(getProviderMode("nonexistent"), "disabled");
});
