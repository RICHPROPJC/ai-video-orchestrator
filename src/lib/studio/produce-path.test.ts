import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as nodeTest from "node:test";

const bareBun = !!process.versions.bun && process.env.BUN_TEST !== "1";
const cases: { name: string; fn: () => void | Promise<void> }[] = [];
const test = bareBun
  ? (name: string, fn: () => void | Promise<void>) => cases.push({ name, fn })
  : nodeTest.test;

const PRODUCE = ["pipeline.ts", "blockout.ts"].map((f) => path.join(__dirname, f));
const CLI = path.resolve(__dirname, "../../cli.ts");

test("produce path does not import draftBlenderScript or blender-author", () => {
  for (const file of [...PRODUCE, CLI]) {
    const src = fs.readFileSync(file, "utf8");
    assert.equal(src.includes("draftBlenderScript"), false, file);
    assert.equal(src.includes("blender-author"), false, file);
    assert.equal(src.includes("needsFlashLiteBlender"), false, file);
  }
});

if (bareBun) {
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
