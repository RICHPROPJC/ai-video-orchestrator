import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FORBID = [new RegExp("hook" + "audit"), new RegExp("vimax" + "_repo"), /\/home\/c\//];

function walk(dir: string, acc: string[]) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "fixtures" || ent.name === "node_modules") continue;
      walk(p, acc);
    } else if (/\.(ts|tsx)$/.test(ent.name) && ent.name !== "src-paths.test.ts") acc.push(p);
  }
}

test("src ts has no Chau-home / farm proof paths", () => {
  const files: string[] = [];
  walk(SRC, files);
  const hits: string[] = [];
  for (const file of files) {
    if (path.basename(file) === "src-paths.test.ts") continue;
    const text = fs.readFileSync(file, "utf8");
    for (const re of FORBID) {
      if (re.test(text)) hits.push(`${path.relative(SRC, file)} ${re}`);
    }
  }
  assert.deepEqual(hits, []);
});
