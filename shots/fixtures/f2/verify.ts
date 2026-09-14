import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { frameHashes, hamming, probe } from "../../../src/lib/studio/dhash-anchors";

async function main() {
  const out = path.join(process.cwd(), "shots/fixtures/f2");
  const actions = ["lie", "kneel", "crouch", "lean", "turn_away"];
  const rows = [];
  const missing = [];
  for (const action of actions) {
    const ported = (await frameHashes(path.join(out, "ported-c5", action + ".png")))[0];
    const regenerated = (await frameHashes(path.join(out, "regenerated-c5", action + ".png")))[0];
    const regenerationDistance = hamming(ported, regenerated);
    assert.ok(regenerationDistance <= 4, `${action}: C5 math parity dHash=${regenerationDistance}`);
    const historical = path.join(out, "reference", action + ".f0.png");
    let historicalDistance: number | null = null;
    if (existsSync(historical)) {
      historicalDistance = hamming(ported, (await frameHashes(historical))[0]);
      assert.ok(historicalDistance <= 4, `${action}: historical C5 f0 dHash=${historicalDistance}`);
    } else {
      missing.push(action + ".f0.png");
    }
    const facts = await probe(path.join(out, action, "blockout.mp4"));
    assert.deepEqual(facts, { nbFrames: 3, fps: 6 });
    rows.push({ action, regenerationDistance, historicalDistance });
  }
  const manifest = JSON.parse(await readFile(path.join(out, "reference-manifest.json"), "utf8")) as Record<string, string>;
  for (const [name, hash] of Object.entries(manifest)) assert.equal(createHash("sha256").update(await readFile(path.join(out, "reference", name))).digest("hex"), hash);
  const artifacts: Record<string, string> = {};
  for (const entry of await readdir(out, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.(png|mp4|json)$/.test(entry.name) || entry.name === "qc.json") continue;
    const file = path.join(entry.parentPath, entry.name);
    artifacts[path.relative(out, file)] = createHash("sha256").update(await readFile(file)).digest("hex");
  }
  const receipt = { verdict: missing.length ? "BLOCKED_MISSING_HISTORICAL_REFERENCES" : "PASS", threshold: 4,
    availableHistoricalParity: "PASS", regeneratedC5Parity: "PASS", liveAstraBlockouts: "PASS", rows,
    missingHistoricalReferences: missing, artifacts, event_id: null, trace_id: null };
  await writeFile(path.join(out, "qc.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify(receipt, null, 2));
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
