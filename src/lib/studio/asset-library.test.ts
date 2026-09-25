import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { lookupShelf, publicNameOk } from "./asset-library";

test("a drama noun cannot be the public name; a renamed public piece can", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shelf-"));
  const lib = path.join(root, "public");
  fs.mkdirSync(path.join(root, "ad", "library"), { recursive: true });
  fs.writeFileSync(path.join(root, "ad", "entities.json"), JSON.stringify({ nouns: ["HeroName"] }));
  const piece = path.join(lib, "props", "plain-table");
  fs.mkdirSync(piece, { recursive: true });
  fs.writeFileSync(path.join(piece, "mesh_front_rigged.glb"), "glb");
  assert.equal(publicNameOk("HeroName", root), false);
  assert.equal(publicNameOk("plain-table", root), true);
  assert.equal(lookupShelf("HeroName bottle", "props", root, "HeroName", lib), undefined);
  const hit = lookupShelf("HeroName bottle", "props", root, "plain-table", lib);
  assert.equal(hit?.home, "public");
  assert.equal(hit?.id, "plain-table");
  assert.ok(hit?.rig?.endsWith("mesh_front_rigged.glb"));
});
