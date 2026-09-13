import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as nodeTest from "node:test";
import { entityTokens, lintRepo, lintTree } from "./noun-lint";

/** One file, three doors: bun's node:test shim only works under `bun test`,
 *  so bare `bun <this file>` self-drives the collected cases; `bun test` and
 *  `tsx --test` use the real runner. (store.test.ts idiom.)
 *  Expected tokens are read from disk, never written here as literals —
 *  this file is src/ too, so the lint must hold over it. */
const bareBun = !!process.versions.bun && process.env.BUN_TEST !== "1";
const cases: { name: string; fn: () => void | Promise<void> }[] = [];
const test = bareBun
  ? (name: string, fn: () => void | Promise<void>) => cases.push({ name, fn })
  : nodeTest.test;

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

/** a synthetic story noun, not one from any sheet */
const SYNTHETIC = "獨有道具名甲乙";

function tmpRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sc-noun-"));
}

test("entityTokens reads every projects/<drama>/entities.json stub", () => {
  const dir = tmpRepo();
  fs.mkdirSync(path.join(dir, "projects", "d1"), { recursive: true });
  fs.mkdirSync(path.join(dir, "projects", "d2"), { recursive: true });
  fs.mkdirSync(path.join(dir, "projects", "d3"), { recursive: true });
  fs.writeFileSync(path.join(dir, "projects", "d1", "entities.json"), JSON.stringify({ nouns: [SYNTHETIC] }));
  fs.writeFileSync(path.join(dir, "projects", "d2", "entities.json"), JSON.stringify({ nouns: ["另一個專有名詞"] }));
  fs.writeFileSync(path.join(dir, "projects", "d3", "notEntities.txt"), "ignored");
  const tokens = entityTokens(path.join(dir, "projects")).sort();
  assert.deepEqual(tokens, [SYNTHETIC, "另一個專有名詞"].sort());
  assert.deepEqual(entityTokens(path.join(dir, "nowhere")), [], "missing projects dir is empty, not an error");
});

test("lintTree fails on a story noun in src/ or seats/ code", () => {
  const dir = tmpRepo();
  fs.mkdirSync(path.join(dir, "src", "lib"), { recursive: true });
  fs.mkdirSync(path.join(dir, "seats"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "lib", "a.ts"), `const x = "前設${SYNTHETIC}後設";\n`);
  fs.writeFileSync(path.join(dir, "seats", "writer.playbook.md"), `見到${SYNTHETIC}就要寫落簿。\n`);
  const hits = lintTree(dir, [SYNTHETIC]);
  assert.equal(hits.length, 2, "one hit per offending file");
  assert.deepEqual(
    hits.map((h) => h.file).sort(),
    ["seats/writer.playbook.md", "src/lib/a.ts"].sort(),
  );
  const ts = hits.find((h) => h.file === "src/lib/a.ts")!;
  assert.equal(ts.line, 1);
  assert.equal(ts.token, SYNTHETIC);
});

test("lintTree skips fixture dirs (frozen excerpts may quote the sheet)", () => {
  const dir = tmpRepo();
  fs.mkdirSync(path.join(dir, "src", "lib", "studio", "trace-fixtures"), { recursive: true });
  fs.mkdirSync(path.join(dir, "src", "lib", "studio", "fixtures"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "lib", "studio", "trace-fixtures", "fx.json"), `{"n":"${SYNTHETIC}"}`);
  fs.writeFileSync(path.join(dir, "src", "lib", "studio", "fixtures", "seat.json"), `{"n":"${SYNTHETIC}"}`);
  fs.writeFileSync(path.join(dir, "src", "lib", "studio", "clean.ts"), "export const ok = 1;\n");
  assert.deepEqual(lintTree(dir, [SYNTHETIC]), [], "fixtures are exempt, code is clean");
});

test("the repo tree passes the lint — noun classes, no story nouns in src/ or seats/", () => {
  const { ok, tokens, hits } = lintRepo(REPO_ROOT);
  const stub = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "projects", "_d1a", "entities.json"), "utf8"),
  ) as { nouns: string[] };
  for (const noun of stub.nouns) {
    assert.ok(tokens.includes(noun), `stub noun is linted (read from disk: ${noun.length} chars)`);
  }
  if (!ok) {
    for (const h of hits) console.error(`HIT ${h.token} ${h.file}:${h.line}`);
  }
  assert.equal(ok, true, "4b922c1 passes the noun-lint after the noun-class generalization");
});

if (bareBun) {
  // IIFE, not top-level await: tsx transpiles this file as CJS
  void (async () => {
    let failed = 0;
    for (const c of cases) {
      try {
        await c.fn();
        console.log(`ok - ${c.name}`);
      } catch (err) {
        failed += 1;
        console.error(`not ok - ${c.name}\n${err instanceof Error ? err.stack : String(err)}`);
      }
    }
    console.log(`# ${cases.length - failed}/${cases.length} passed`);
    if (failed > 0) process.exit(1);
  })();
}
