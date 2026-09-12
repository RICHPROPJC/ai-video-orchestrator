import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as nodeTest from "node:test";
import {
  CAP_BULLETS,
  applyOps,
  assemblePlaybook,
  curatePlaybook,
  enforceCap,
  estimateTokens,
  evictFailedTrials,
  loadPlaybook,
  markPass,
  parseBullet,
  renderBullet,
  loadPlaybookLines,
  type PlaybookBullet,
  type PlaybookLine,
} from "./playbook";

/** One file, three doors: bun's node:test shim only works under `bun test`,
 *  so bare `bun <this file>` self-drives the collected cases; `bun test` and
 *  `tsx --test` use the real runner. */
const bareBun = !!process.versions.bun && process.env.BUN_TEST !== "1";
const cases: { name: string; fn: () => void | Promise<void> }[] = [];
const test = bareBun
  ? (name: string, fn: () => void | Promise<void>) => cases.push({ name, fn })
  : nodeTest.test;

function tmpSeats() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "playbook-"));
}

function bullet(partial: Partial<PlaybookBullet>): PlaybookBullet {
  return {
    id: "b1",
    class: "schema.enum",
    field: "cast.stanceEnd",
    saw: "plant",
    rule: "stanceEnd 只可以 stand|lean|crouch",
    hits: 1,
    status: "trial",
    src: "SC-0912-2Y0V",
    ...partial,
  };
}

test("parse/render roundtrip keeps the law bullet shape", () => {
  const line = "- [w3] schema.enum field=language saw=zh rule=language 淨係 zh-Hant|yue|en hits=2 status=trial src=SC-0913-L6WJ";
  const b = parseBullet(line);
  assert.ok(b, "parses");
  assert.equal(renderBullet(b!), line);
  assert.equal(parseBullet("- [w3] schema.enum advice: be careful with enums"), null);
  assert.equal(parseBullet("no field name here"), null);
});

test("Curator rejects generic advice: no field name or no observed value, no bullet", () => {
  const dir = tmpSeats();
  const out = curatePlaybook("boards", [
    { op: "ADD", to: "seat", class: "vibes", field: "", saw: "", rule: "交之前小心啲檢查格式" },
    { op: "ADD", to: "seat", class: "schema.enum", field: "cast.stanceEnd", saw: "", rule: "唔好寫 gait 字" },
    { op: "ADD", to: "seat", class: "schema enum", field: "cast.stance", saw: "plant", rule: "ok" },
    { op: "ADD", to: "seat", class: "schema.enum", field: "cast.stanceEnd", saw: "plant", rule: "只可以 stand|lean|crouch" },
  ], { src: "SC-0912-2Y0V", dir });

  const onDisk = loadPlaybook("boards", dir);
  assert.equal(onDisk.length, 1, "only the bullet with field + saw survived");
  assert.equal(onDisk[0]!.field, "cast.stanceEnd");
  assert.equal(onDisk[0]!.saw, "plant");
  assert.equal(onDisk[0]!.status, "trial");
  assert.equal(onDisk[0]!.hits, 1);
  assert.equal(out.rejected.length, 3, "three rejects");
  assert.ok(out.receipts.some((r) => r.includes("ADD b1")), out.receipts.join(" | "));
});

test("two ops merge: ADD then UPDATE tightens the rule in place", () => {
  const dir = tmpSeats();
  const first = curatePlaybook("boards", [
    { op: "ADD", to: "seat", class: "arithmetic.sum", field: "shots.durationSec", saw: "84.9s", rule: "加埋要落喺 budget ±10%" },
  ], { src: "SC-0912-YGTS", dir });
  assert.ok(first.receipts.some((r) => /ADD b1/.test(r)));

  const second = curatePlaybook("boards", [
    { op: "UPDATE", to: "seat", id: "b1", rule: "先 n 後 base=budget÷n，逐鏈由 base 加減 ≤2s，交前自己加總一次" },
  ], { src: "SC-0912-C7IQ", dir });

  const onDisk = loadPlaybook("boards", dir);
  assert.equal(onDisk.length, 1, "UPDATE merged, no twin");
  assert.equal(onDisk[0]!.id, "b1");
  assert.match(onDisk[0]!.rule, /base=budget÷n/);
  assert.equal(onDisk[0]!.saw, "84.9s");
  assert.equal(onDisk[0]!.src, "SC-0912-YGTS", "birth src survives an update");
  assert.ok(second.receipts.some((r) => /UPDATE b1/.test(r)), second.receipts.join(" | "));
});

test("ADD dedupe on (class, field) merges evidence instead of stacking twins", () => {
  const dir = tmpSeats();
  curatePlaybook("boards", [
    { op: "ADD", to: "seat", class: "schema.missing", field: "sceneId", saw: "undefined", rule: "個 object 用咗「.」做 key，照寫 sceneId" },
  ], { src: "SC-0912-2Y0V", dir });
  curatePlaybook("boards", [
    { op: "ADD", to: "seat", class: "schema.missing", field: "sceneId", saw: "undefined", rule: "個 object 用咗「.」做 key，照寫 sceneId" },
  ], { src: "SC-0912-78N8", dir });

  const onDisk = loadPlaybook("boards", dir);
  assert.equal(onDisk.length, 1, "same class+field is one bullet");
  assert.equal(onDisk[0]!.hits, 2, "second sighting increments hits");
});

test("cap evicts lowest hits first, then the oldest line", () => {
  const lines: PlaybookLine[] = Array.from({ length: CAP_BULLETS + 2 }, (_, i) => ({
    kind: "bullet" as const,
    bullet: bullet({ id: `b${i + 1}`, hits: 10, rule: `r${i + 1}` }),
  }));
  // two weakest: the oldest line and the newest line both at hits 1
  (lines[0] as { kind: "bullet"; bullet: PlaybookBullet }).bullet.hits = 1;
  (lines[lines.length - 1] as { kind: "bullet"; bullet: PlaybookBullet }).bullet.hits = 1;

  const { lines: kept, evicted } = enforceCap("boards", lines);
  assert.equal(kept.filter((l) => l.kind === "bullet").length, CAP_BULLETS);
  assert.deepEqual(evicted, ["b1 schema.enum field=cast.stanceEnd hits=1", "b32 schema.enum field=cast.stanceEnd hits=1"],
    "lowest hits go, and between the two ties the older line b1 is named first in eviction order");
  const ids = kept.filter((l) => l.kind === "bullet").map((l) => (l as { bullet: PlaybookBullet }).bullet.id);
  assert.ok(!ids.includes("b1"), "the oldest low-hit bullet is gone");
  assert.ok(ids.includes("b2"), "tenured bullets stay");
});

test("token cap evicts even under the bullet cap", () => {
  const long = (i: number) => ({
    kind: "bullet",
    bullet: bullet({ id: `b${i}`, rule: "規".repeat(60), hits: 5 }),
  }) as PlaybookLine;
  // 10 bullets × ~60 CJK chars ≈ 600+ tokens each → far over CAP_TOKENS
  const many = Array.from({ length: 10 }, (_, i) => long(i + 1));
  const { lines: kept } = enforceCap("boards", many);
  const rendered = kept.map((l) => (l.kind === "bullet" ? renderBullet(l.bullet) : l.text)).join("\n");
  assert.ok(estimateTokens(rendered) <= 1500, `tokens ${estimateTokens(rendered)}`);
});

test("proven increment: a bullet in the prompt during a PASS becomes proven, hits++", () => {
  const dir = tmpSeats();
  curatePlaybook("writer", [
    { op: "ADD", to: "seat", class: "schema.enum", field: "language", saw: "zh", rule: "language 淨係 zh-Hant|yue|en" },
  ], { src: "SC-0913-L6WJ", dir });
  curatePlaybook("global", [
    { op: "ADD", to: "global", class: "machine.429", field: "writerModel", saw: "kimi-k3", rule: "kimi TPM 窄，stage 之間唞 5s" },
  ], { src: "SC-0912-G841", dir });

  const receipts = markPass(["writer", "global"], dir);
  assert.ok(receipts.some((r) => r.includes("PASS promote w1")), receipts.join(" | "));

  const writer = loadPlaybook("writer", dir);
  assert.equal(writer[0]!.status, "proven");
  assert.equal(writer[0]!.hits, 2, "PASS increments hits");
  const global = loadPlaybook("global", dir);
  assert.equal(global[0]!.status, "proven", "global bullets were in the prompt too");

  const again = markPass(["writer", "global"], dir);
  assert.deepEqual(again, [], "already proven: no second promotion");
});

test("self-eviction: a trial bullet from an earlier produce that fails the same class again is removed", () => {
  const dir = tmpSeats();
  curatePlaybook("boards", [
    { op: "ADD", to: "seat", class: "schema.enum", field: "cast.stanceEnd", saw: "plant", rule: "只可以 stand|lean|crouch" },
  ], { src: "SC-0912-2Y0V", dir });
  // next produce fails the SAME class on a different field → old trial is out
  curatePlaybook("boards", [
    { op: "ADD", to: "seat", class: "schema.enum", field: "side", saw: "front", rule: "side 淨係 frontal|leftQuarter|rightQuarter" },
  ], { src: "SC-0912-BO9W", dir });

  const onDisk = loadPlaybook("boards", dir);
  assert.deepEqual(onDisk.map((b) => b.field), ["side"], "the stale trial was auto-removed, the fresh one stays");
});

test("assemblePlaybook reads global + own; Chau's raw lines survive a rewrite", () => {
  const dir = tmpSeats();
  curatePlaybook("global", [
    { op: "ADD", to: "global", class: "machine.429", field: "writerModel", saw: "kimi-k3", rule: "kimi TPM 窄，stage 之間唞 5s" },
  ], { src: "SC-0912-G841", dir });
  curatePlaybook("writer", [
    { op: "ADD", to: "seat", class: "schema.enum", field: "language", saw: "zh", rule: "language 淨係 zh-Hant|yue|en" },
  ], { src: "SC-0913-L6WJ", dir });

  const book = assemblePlaybook("writer", dir);
  assert.match(book.text, /機器級/);
  assert.match(book.text, /### writer 檯/);
  assert.equal(book.bullets.length, 2, "global + own");
  assert.ok(book.text.indexOf("machine.429") < book.text.indexOf("schema.enum"), "global first");
  assert.equal(assemblePlaybook("writer").text, "", "no dir → no prompt block, charter untouched");

  // Chau's gate is the file: a hand note must survive Curator rewrites
  fs.appendFileSync(path.join(dir, "writer.playbook.md"), "# Chau: 呢條我留吓睇下\n");
  curatePlaybook("writer", [
    { op: "ADD", to: "seat", class: "schema.band", field: "scenes", saw: "5", rule: "600s 要 6–14 場，唔夠就拆" },
  ], { src: "SC-0913-L6WJ", dir });
  const text = fs.readFileSync(path.join(dir, "writer.playbook.md"), "utf8");
  assert.match(text, /# Chau: 呢條我留吓睇下/);
  assert.equal(loadPlaybookLines("writer", dir).filter((l) => l.kind === "raw").length, 2, "header + note kept verbatim");
});

test("an ADD whose saw never appears in the grave's evidence is rejected", () => {
  const dir = tmpSeats();
  const out = curatePlaybook("writer", [
    { op: "ADD", to: "seat", class: "schema.enum", field: "world.timeOfDay", saw: "多變", rule: "時間只可以四個字之一" },
    { op: "ADD", to: "seat", class: "schema.enum", field: "language", saw: "zh", rule: "language 淨係 zh-Hant|yue|en" },
  ], { src: "SC-0913-L6WJ", dir, evidence: 'errors: Invalid option — output-slice: {"language":"zh","world":{"timeOfDay":"夜→晨→日"' });

  const onDisk = loadPlaybook("writer", dir);
  assert.equal(onDisk.length, 1, "only the observed saw survived");
  assert.equal(onDisk[0]!.saw, "zh");
  assert.match(out.rejected[0]!, /never appears in this grave's receipts/);
});

test("an UPDATE cannot smuggle an unobserved saw in either — the old one stays", () => {
  const dir = tmpSeats();
  curatePlaybook("global", [
    { op: "ADD", to: "global", class: "schema.missing", field: "sceneId", saw: "undefined", rule: "key 變咗位，照寫 sceneId" },
  ], { src: "SC-0912-9KM0", dir, evidence: "errors: sceneId: Invalid input: expected string, received undefined" });
  curatePlaybook("global", [
    { op: "UPDATE", to: "global", id: "g1", saw: "/sceneId", rule: "key 嚴禁斜線" },
  ], { src: "SC-0912-BO9W", dir, evidence: "errors: shots.0: boom" });

  const onDisk = loadPlaybook("global", dir);
  assert.equal(onDisk[0]!.saw, "undefined", "unobserved saw rejected, birth saw kept");
  assert.match(onDisk[0]!.rule, /嚴禁斜線/, "the rule text itself still lands");
});

test("REMOVE op drops the bullet and unknown ids are rejected, never guessed", () => {
  const dir = tmpSeats();
  curatePlaybook("boards", [
    { op: "ADD", to: "seat", class: "schema.enum", field: "cast.stanceEnd", saw: "plant", rule: "只可以 stand|lean|crouch" },
  ], { src: "SC-0912-2Y0V", dir });
  const out = curatePlaybook("boards", [
    { op: "REMOVE", to: "seat", id: "b1" },
    { op: "REMOVE", to: "seat", id: "nope" },
  ], { src: "SC-0912-9KM0", dir });
  assert.deepEqual(loadPlaybook("boards", dir), []);
  assert.ok(out.receipts.some((r) => /REMOVE b1/.test(r)));
  assert.deepEqual(out.rejected, ["REMOVE nope: no such bullet"]);
});

test("applyOps reports untouched twin ids so eviction keeps merged evidence", () => {
  const lines: PlaybookLine[] = [{ kind: "bullet", bullet: bullet({ id: "b1", class: "schema.missing", field: "sceneId", saw: "undefined", src: "SC-0912-2Y0V" }) }];
  const out = applyOps("boards", lines, [
    { op: "ADD", to: "seat", class: "schema.missing", field: "sceneId", saw: "undefined", rule: "照寫 sceneId" },
  ], { src: "SC-0912-78N8" });
  assert.deepEqual(out.touchedIds, ["b1"]);
  const evict = evictFailedTrials("boards", out.lines, { classes: ["schema.missing"], src: "SC-0912-78N8", keepIds: out.touchedIds });
  assert.deepEqual(evict.lines.filter((l) => l.kind === "bullet").length, 1, "merged bullet survives, it just took new evidence");
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
