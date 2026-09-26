import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as nodeTest from "node:test";
import { entityTokens as nounLintTokens } from "./noun-lint";
import { PLAYBOOK_SCOPES, type PlaybookAddress } from "./paths";
import {
  CAP_TOKENS,
  allEntityTokens,
  applyOps,
  assemblePlaybook,
  curatePlaybook,
  dramaEntityTokens,
  enforceCap,
  estimateTokens,
  evictFailedTrials,
  loadPlaybook,
  loadPlaybookLines,
  markPass,
  migrateLegacyPlaybooks,
  parseBullet,
  renderBullet,
  writePlaybook,
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

/** A test world mirrors the repo: seats/ and projects/ are siblings under one
 *  root, so every sibling-derivation path resolves inside this world only. */
function tmpWorld() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-root-"));
  const seats = path.join(root, "seats");
  const proot = path.join(root, "projects");
  fs.mkdirSync(seats);
  fs.mkdirSync(proot);
  return { root, seats, proot };
}

/** Synthetic nouns — never the real sheet's; src/ and seats/ must stay
 *  noun-free, and that law applies to this file too. */
const WIST_NOUNS = ["將軍袍", "赦免狀", "plow"];

function seedEntities(proot: string, drama: string, nouns: string[]) {
  fs.mkdirSync(path.join(proot, drama), { recursive: true });
  fs.writeFileSync(path.join(proot, drama, "entities.json"), JSON.stringify({ drama, nouns }, null, 2));
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

const prim = (scope: "writer" | "boards" | "all", seats: string): PlaybookAddress => ({
  lifetime: "primitive",
  scope,
  dir: seats,
});

test("parse/render roundtrip keeps the law bullet shape", () => {
  const line = "- [w3] schema.enum field=language saw=zh rule=language 淨係 zh-Hant|yue|en hits=2 status=trial src=SC-0913-L6WJ";
  const b = parseBullet(line);
  assert.ok(b, "parses");
  assert.equal(renderBullet(b!), line);
  assert.equal(parseBullet("- [w3] schema.enum advice: be careful with enums"), null);
  assert.equal(parseBullet("no field name here"), null);
});

test("Curator rejects generic advice: no field name or no observed value, no bullet", () => {
  const { seats, proot } = tmpWorld();
  const out = curatePlaybook("boards", [
    { op: "ADD", class: "vibes", field: "", saw: "", rule: "交之前小心啲檢查格式" },
    { op: "ADD", class: "schema.enum", field: "cast.stanceEnd", saw: "", rule: "唔好寫 gait 字" },
    { op: "ADD", class: "schema enum", field: "cast.stance", saw: "plant", rule: "ok" },
    { op: "ADD", class: "schema.enum", field: "cast.stanceEnd", saw: "plant", rule: "只可以 stand|lean|crouch" },
  ], { src: "SC-0912-2Y0V", seatsDir: seats, projectsDir: proot });

  const onDisk = loadPlaybook("boards", seats);
  assert.equal(onDisk.length, 1, "only the bullet with field + saw survived");
  assert.equal(onDisk[0]!.field, "cast.stanceEnd");
  assert.equal(onDisk[0]!.saw, "plant");
  assert.equal(onDisk[0]!.status, "trial");
  assert.equal(onDisk[0]!.hits, 1);
  assert.equal(out.rejected.length, 3, "three rejects");
  assert.ok(out.receipts.some((r) => r.includes("ADD b1")), out.receipts.join(" | "));
});

test("two ops merge: ADD then UPDATE tightens the rule in place", () => {
  const { seats, proot } = tmpWorld();
  const first = curatePlaybook("boards", [
    { op: "ADD", class: "arithmetic.sum", field: "shots.durationSec", saw: "84.9s", rule: "加埋要落喺 budget ±10%" },
  ], { src: "SC-0912-YGTS", seatsDir: seats, projectsDir: proot });
  assert.ok(first.receipts.some((r) => /ADD b1/.test(r)));

  const second = curatePlaybook("boards", [
    { op: "UPDATE", id: "b1", rule: "先 n 後 base=budget÷n，逐鏈由 base 加減 ≤2s，交前自己加總一次" },
  ], { src: "SC-0912-C7IQ", seatsDir: seats, projectsDir: proot });

  const onDisk = loadPlaybook("boards", seats);
  assert.equal(onDisk.length, 1, "UPDATE merged, no twin");
  assert.equal(onDisk[0]!.id, "b1");
  assert.match(onDisk[0]!.rule, /base=budget÷n/);
  assert.equal(onDisk[0]!.saw, "84.9s");
  assert.equal(onDisk[0]!.src, "SC-0912-YGTS", "birth src survives an update");
  assert.ok(second.receipts.some((r) => /UPDATE b1/.test(r)), second.receipts.join(" | "));
});

test("ADD dedupe on (class, field) merges evidence instead of stacking twins", () => {
  const { seats, proot } = tmpWorld();
  curatePlaybook("boards", [
    { op: "ADD", class: "schema.missing", field: "sceneId", saw: "undefined", rule: "個 object 用咗「.」做 key，照寫 sceneId" },
  ], { src: "SC-0912-2Y0V", seatsDir: seats, projectsDir: proot });
  curatePlaybook("boards", [
    { op: "ADD", class: "schema.missing", field: "sceneId", saw: "undefined", rule: "個 object 用咗「.」做 key，照寫 sceneId" },
  ], { src: "SC-0912-78N8", seatsDir: seats, projectsDir: proot });

  const onDisk = loadPlaybook("boards", seats);
  assert.equal(onDisk.length, 1, "same class+field is one bullet");
  assert.equal(onDisk[0]!.hits, 2, "second sighting increments hits");
});

test("token cap evicts lowest hits first, then the oldest line", () => {
  const lines: PlaybookLine[] = Array.from({ length: 30 }, (_, i) => ({
    kind: "bullet" as const,
    bullet: bullet({ id: `b${i + 1}`, hits: 5, rule: "規".repeat(60) }),
  }));
  // two weakest: the oldest line and the newest line both at hits 1
  (lines[0] as { kind: "bullet"; bullet: PlaybookBullet }).bullet.hits = 1;
  (lines[lines.length - 1] as { kind: "bullet"; bullet: PlaybookBullet }).bullet.hits = 1;

  const { lines: kept, evicted } = enforceCap(lines);
  const rendered = kept.map((l) => (l.kind === "bullet" ? renderBullet(l.bullet) : l.text)).join("\n");
  assert.ok(estimateTokens(rendered) <= CAP_TOKENS, `tokens ${estimateTokens(rendered)}`);
  assert.ok(evicted.length >= 2, `evicted ${evicted.length}`);
  assert.match(evicted[0]!, /^b1 schema\.enum field=cast\.stanceEnd hits=1/, "oldest low-hit bullet named first");
  assert.match(evicted[1]!, /^b30 schema\.enum field=cast\.stanceEnd hits=1/, "then the newer low-hit bullet");
  assert.match(evicted[2]!, /^b2 /, "then tenured bullets oldest-first");
  const ids = kept.filter((l) => l.kind === "bullet").map((l) => (l as { bullet: PlaybookBullet }).bullet.id);
  assert.ok(!ids.includes("b1") && !ids.includes("b30"), "the weak twins are gone");
});

test("proven increment: a bullet in the prompt during a PASS becomes proven, hits++", () => {
  const { seats, proot } = tmpWorld();
  curatePlaybook("writer", [
    { op: "ADD", class: "schema.enum", field: "language", saw: "zh", rule: "language 淨係 zh-Hant|yue|en" },
  ], { src: "SC-0913-L6WJ", seatsDir: seats, projectsDir: proot });
  curatePlaybook("all", [
    { op: "ADD", class: "machine.429", field: "writerModel", saw: "kimi-k3", rule: "kimi TPM 窄，stage 之間唞 5s" },
  ], { src: "SC-0912-G841", seatsDir: seats, projectsDir: proot });

  const receipts = markPass(["writer", "all"], seats);
  assert.ok(receipts.some((r) => r.includes("writer PASS promote w1")), receipts.join(" | "));
  assert.ok(receipts.some((r) => r.includes("all PASS promote g1")), receipts.join(" | "));

  const writer = loadPlaybook("writer", seats);
  assert.equal(writer[0]!.status, "proven");
  assert.equal(writer[0]!.hits, 2, "PASS increments hits");
  assert.equal(loadPlaybook("all", seats)[0]!.status, "proven", "all-scope bullets were in the prompt too");

  const again = markPass(["writer", "all"], seats);
  assert.deepEqual(again, [], "already proven: no second promotion");
});

test("markPass skips retired scope names — a legacy caller neither crashes nor writes a stray file", () => {
  const { seats, proot } = tmpWorld();
  curatePlaybook("writer", [
    { op: "ADD", class: "schema.enum", field: "language", saw: "zh", rule: "language 淨係 zh-Hant|yue|en" },
  ], { src: "SC-0913-L6WJ", seatsDir: seats, projectsDir: proot });

  const receipts = markPass(["writer", "global"], seats);
  assert.ok(receipts.some((r) => /writer PASS promote w1/.test(r)), receipts.join(" | "));
  assert.ok(!receipts.some((r) => /global/.test(r)), "the retired name contributed nothing");
  assert.equal(loadPlaybook("writer", seats)[0]!.status, "proven");
});

test("self-eviction: a trial bullet from an earlier produce that fails the same class again is removed", () => {
  const { seats, proot } = tmpWorld();
  curatePlaybook("boards", [
    { op: "ADD", class: "schema.enum", field: "cast.stanceEnd", saw: "plant", rule: "只可以 stand|lean|crouch" },
  ], { src: "SC-0912-2Y0V", seatsDir: seats, projectsDir: proot });
  // next produce fails the SAME class on a different field → old trial is out
  curatePlaybook("boards", [
    { op: "ADD", class: "schema.enum", field: "side", saw: "front", rule: "side 淨係 frontal|leftQuarter|rightQuarter" },
  ], { src: "SC-0912-BO9W", seatsDir: seats, projectsDir: proot });

  const onDisk = loadPlaybook("boards", seats);
  assert.deepEqual(onDisk.map((b) => b.field), ["side"], "the stale trial was auto-removed, the fresh one stays");
});

test("assemblePlaybook reads all + own, primitive before drama; Chau's raw lines survive a rewrite", () => {
  const { seats, proot } = tmpWorld();
  seedEntities(proot, "wist", WIST_NOUNS);
  curatePlaybook("all", [
    { op: "ADD", class: "machine.429", field: "writerModel", saw: "kimi-k3", rule: "kimi TPM 窄，stage 之間唞 5s" },
  ], { src: "SC-0912-G841", seatsDir: seats, projectsDir: proot });
  curatePlaybook("writer", [
    { op: "ADD", class: "schema.enum", field: "language", saw: "zh", rule: "language 淨係 zh-Hant|yue|en" },
  ], { src: "SC-0913-L6WJ", seatsDir: seats, projectsDir: proot });
  // one drama owns a playbook dir → its bullets ride the prompt, after the primitive ones
  writePlaybook({ lifetime: "drama", scope: "writer", drama: "wist", dir: proot }, [
    { kind: "bullet", bullet: bullet({ id: "w7", class: "prop.garment", field: "props.note", saw: "將軍袍", rule: "將軍袍嘅鏡頭唔好落農具提示句" }) },
  ]);

  const unnamed = assemblePlaybook("writer", seats);
  assert.equal(unnamed.bullets.length, 2, "public bullets only — the one project on disk is not guessed");
  assert.doesNotMatch(unnamed.text, /劇目 wist/);
  const book = assemblePlaybook("writer", seats, "wist");
  assert.match(book.text, /全部 seat（跨劇目）/);
  assert.match(book.text, /### writer 檯（跨劇目）/);
  assert.match(book.text, /### writer 檯（劇目 wist）/, "the named project's file rides along");
  assert.equal(book.bullets.length, 3, "all-primitive + writer-primitive + writer-drama");
  assert.ok(book.text.indexOf("machine.429") < book.text.indexOf("schema.enum"), "all-scope first");
  assert.ok(book.text.indexOf("schema.enum") < book.text.indexOf("prop.garment"), "primitive before drama");
  assert.equal(assemblePlaybook("writer").text, "", "no dir → no prompt block, charter untouched");

  // Chau's gate is the file: a hand note must survive Curator rewrites
  fs.appendFileSync(path.join(seats, "writer.primitive.md"), "# Chau: 呢條我留吓睇下\n");
  curatePlaybook("writer", [
    { op: "ADD", class: "schema.band", field: "scenes", saw: "5", rule: "600s 要 6–14 場，唔夠就拆" },
  ], { src: "SC-0913-L6WJ", seatsDir: seats, projectsDir: proot });
  const text = fs.readFileSync(path.join(seats, "writer.primitive.md"), "utf8");
  assert.match(text, /# Chau: 呢條我留吓睇下/);
  assert.equal(loadPlaybookLines(prim("writer", seats)).filter((l) => l.kind === "raw").length, 2, "header + note kept verbatim");
});

test("two dramas owning playbooks is ambiguous: neither rides the prompt", () => {
  const { seats, proot } = tmpWorld();
  seedEntities(proot, "wist", WIST_NOUNS);
  seedEntities(proot, "harbor", ["燈塔"]);
  curatePlaybook("writer", [
    { op: "ADD", class: "schema.enum", field: "language", saw: "zh", rule: "language 淨係 zh-Hant|yue|en" },
  ], { src: "SC-0913-L6WJ", seatsDir: seats, projectsDir: proot });
  for (const drama of ["harbor", "wist"]) {
    writePlaybook({ lifetime: "drama", scope: "writer", drama, dir: proot }, [
      { kind: "bullet", bullet: bullet({ id: "w9", field: "props.note" }) },
    ]);
  }

  const book = assemblePlaybook("writer", seats);
  assert.ok(!book.text.includes("（劇目"), "no drama section when the job's drama is unknown");
  assert.ok(!book.text.includes("wist") && !book.text.includes("harbor"), "neither drama's bullets ride the prompt");
  assert.equal(book.bullets.length, 1, "only the primitive bullet — guessing would cross-pollinate nouns");
});

test("an ADD whose saw never appears in the grave's evidence is rejected", () => {
  const { seats, proot } = tmpWorld();
  const out = curatePlaybook("writer", [
    { op: "ADD", class: "schema.enum", field: "world.timeOfDay", saw: "多變", rule: "時間只可以四個字之一" },
    { op: "ADD", class: "schema.enum", field: "language", saw: "zh", rule: "language 淨係 zh-Hant|yue|en" },
  ], { src: "SC-0913-L6WJ", seatsDir: seats, projectsDir: proot, evidence: 'errors: Invalid option — output-slice: {"language":"zh","world":{"timeOfDay":"夜→晨→日"' });

  const onDisk = loadPlaybook("writer", seats);
  assert.equal(onDisk.length, 1, "only the observed saw survived");
  assert.equal(onDisk[0]!.saw, "zh");
  assert.match(out.rejected[0]!, /never appears in this grave's receipts/);
});

test("an UPDATE cannot smuggle an unobserved saw in either — the old one stays", () => {
  const { seats, proot } = tmpWorld();
  curatePlaybook("all", [
    { op: "ADD", class: "schema.missing", field: "sceneId", saw: "undefined", rule: "key 變咗位，照寫 sceneId" },
  ], { src: "SC-0912-9KM0", seatsDir: seats, projectsDir: proot, evidence: "errors: sceneId: Invalid input: expected string, received undefined" });
  curatePlaybook("all", [
    { op: "UPDATE", id: "g1", saw: "/sceneId", rule: "key 嚴禁斜線" },
  ], { src: "SC-0912-BO9W", seatsDir: seats, projectsDir: proot, evidence: "errors: shots.0: boom" });

  const onDisk = loadPlaybook("all", seats);
  assert.equal(onDisk[0]!.saw, "undefined", "unobserved saw rejected, birth saw kept");
  assert.match(onDisk[0]!.rule, /嚴禁斜線/, "the rule text itself still lands");
});

test("REMOVE op drops the bullet and unknown ids are rejected, never guessed", () => {
  const { seats, proot } = tmpWorld();
  curatePlaybook("boards", [
    { op: "ADD", class: "schema.enum", field: "cast.stanceEnd", saw: "plant", rule: "只可以 stand|lean|crouch" },
  ], { src: "SC-0912-2Y0V", seatsDir: seats, projectsDir: proot });
  const out = curatePlaybook("boards", [
    { op: "REMOVE", id: "b1" },
    { op: "REMOVE", id: "nope" },
  ], { src: "SC-0912-9KM0", seatsDir: seats, projectsDir: proot });
  assert.deepEqual(loadPlaybook("boards", seats), []);
  assert.ok(out.receipts.some((r) => /REMOVE b1/.test(r)));
  assert.deepEqual(out.rejected, ["REMOVE nope: no such bullet"]);
});

test("applyOps reports untouched twin ids so eviction keeps merged evidence", () => {
  const lines: PlaybookLine[] = [{ kind: "bullet", bullet: bullet({ id: "b1", class: "schema.missing", field: "sceneId", saw: "undefined", src: "SC-0912-2Y0V" }) }];
  const out = applyOps(prim("boards", "."), lines, [
    { op: "ADD", class: "schema.missing", field: "sceneId", saw: "undefined", rule: "照寫 sceneId" },
  ], { src: "SC-0912-78N8" });
  assert.deepEqual(out.touchedIds, ["b1"]);
  const evict = evictFailedTrials(prim("boards", "."), out.lines, { classes: ["schema.missing"], src: "SC-0912-78N8", keepIds: out.touchedIds });
  assert.deepEqual(evict.lines.filter((l) => l.kind === "bullet").length, 1, "merged bullet survives, it just took new evidence");
});

test("noun test: an ADD naming an entity token is demoted to the drama file; window/schema bullets stay primitive", () => {
  const { seats, proot } = tmpWorld();
  seedEntities(proot, "wist", WIST_NOUNS);
  const out = curatePlaybook("boards", [
    { op: "ADD", class: "prop.garment", field: "props.name", saw: "將軍袍", rule: "將軍袍係戲服，提示句唔好套用農具嗰套" },
    { op: "ADD", class: "prop.window", field: "props.name", saw: "木窗", rule: "木窗係場景陳設，唔算手持道具" },
    { op: "ADD", class: "schema.enum", field: "cast.stanceEnd", saw: "walk", rule: "stanceEnd 只可以 stand|lean|crouch" },
  ], { src: "SC-0913-W1ST", seatsDir: seats, projectsDir: proot, drama: "wist" });

  const primitiveText = fs.readFileSync(path.join(seats, "boards.primitive.md"), "utf8");
  assert.ok(!primitiveText.includes("將軍袍"), "no story noun in the primitive file");
  const onDisk = loadPlaybook("boards", seats);
  assert.deepEqual(onDisk.map((b) => b.class).sort(), ["prop.window", "schema.enum"], "window/schema bullets stayed primitive");

  const dramaFile = path.join(proot, "wist", "playbook", "boards.md");
  const dramaBullets = loadPlaybookLines({ lifetime: "drama", scope: "boards", drama: "wist", dir: proot });
  assert.ok(fs.existsSync(dramaFile), "the drama file exists");
  assert.equal(dramaBullets.filter((l) => l.kind === "bullet").length, 1, "the coat bullet landed in the drama file");
  assert.match((loadPlaybookLines({ lifetime: "drama", scope: "boards", drama: "wist", dir: proot }).find((l) => l.kind === "bullet") as { bullet: PlaybookBullet }).bullet.rule, /戲服/);
  assert.ok(out.receipts.some((r) => r.includes("DEMOTE → wist/boards")), out.receipts.join(" | "));
  assert.ok(out.receipts.some((r) => /wist\/boards ADD b1/.test(r)), out.receipts.join(" | "));
});

test("no drama in play: an entity-noun ADD is rejected outright — primitive files stay noun-free either way", () => {
  const { seats, proot } = tmpWorld();
  seedEntities(proot, "wist", WIST_NOUNS);
  const out = curatePlaybook("boards", [
    { op: "ADD", class: "prop.garment", field: "props.name", saw: "將軍袍", rule: "將軍袍係戲服，唔好套用農具句式" },
    { op: "ADD", class: "schema.enum", field: "cast.stanceEnd", saw: "walk", rule: "只可以 stand|lean|crouch" },
  ], { src: "SC-0913-W1ST", seatsDir: seats, projectsDir: proot });

  assert.equal(loadPlaybook("boards", seats).length, 1, "only the noun-free bullet landed");
  assert.match(out.rejected[0]!, /names entity noun 將軍袍 but no drama in play/);
  assert.ok(!fs.existsSync(path.join(proot, "wist", "playbook")), "nothing was guessed into a drama file");
});

test("an UPDATE cannot push an entity noun into a primitive bullet — the old rule stays", () => {
  const { seats, proot } = tmpWorld();
  seedEntities(proot, "wist", WIST_NOUNS);
  curatePlaybook("boards", [
    { op: "ADD", class: "prop.paper", field: "props.name", saw: "信箋", rule: "紙品道具唔好落木作提示句" },
  ], { src: "SC-0913-W1ST", seatsDir: seats, projectsDir: proot });
  const out = curatePlaybook("boards", [
    { op: "UPDATE", id: "b1", rule: "將軍袍先至係戲服，信箋照舊" },
  ], { src: "SC-0913-W2ST", seatsDir: seats, projectsDir: proot, drama: "wist" });

  const onDisk = loadPlaybook("boards", seats);
  assert.equal(onDisk[0]!.rule, "紙品道具唔好落木作提示句", "the noun-bearing rule never landed");
  assert.match(out.rejected[0]!, /UPDATE b1: names entity noun/);
  assert.ok(!fs.readFileSync(path.join(seats, "boards.primitive.md"), "utf8").includes("將軍袍"));
});

test("migration: seeded writer/boards/all bullets split by the noun test, exactly one file each, legacy retired", () => {
  const { seats, proot } = tmpWorld();
  seedEntities(proot, "wist", WIST_NOUNS);
  const retired = (title: string) => `${title}（Curator 代碼寫；Chau 刪一行即否決）`;
  fs.writeFileSync(path.join(seats, "writer.playbook.md"),
    `# writer playbook — 阿文學過嘅教訓${retired("")}\n- [w1] schema.band field=scenes saw=5 rule=600秒 slab 最少 6 場 hits=2 status=proven src=SC-0912-56LC\n`);
  fs.writeFileSync(path.join(seats, "boards.playbook.md"),
    `# boards playbook — 阿圖學過嘅教訓${retired("")}\n`
    + "- [b7] schema.roster field=cast.slot saw=C/mid rule=同一鏡頭唔可以有兩人同 slot 同 depth hits=2 status=proven src=SC-0912-BO9W\n"
    + "- [b8] prop.window field=props.name saw=木窗 rule=木窗係陳設，唔算手持道具 hits=1 status=trial src=SC-0913-W1ST\n"
    + "- [b9] prop.garment field=props.name saw=將軍袍 rule=將軍袍係戲服，唔好套用農具句式 hits=2 status=proven src=SC-0913-07JZ\n");
  fs.writeFileSync(path.join(seats, "global.playbook.md"),
    `# global playbook — 機器級教訓，全部 seat 共用${retired("")}\n- [g1] schema.missing field=sceneId saw=undefined rule=頂層 key 前面唔可以加斜線 hits=2 status=proven src=SC-0912-78N8\n`);

  const { receipts } = migrateLegacyPlaybooks({ seatsDir: seats, projectsDir: proot });

  for (const legacy of ["writer.playbook.md", "boards.playbook.md", "global.playbook.md"]) {
    assert.ok(!fs.existsSync(path.join(seats, legacy)), `${legacy} retired`);
  }
  assert.ok(receipts.some((r) => r.includes("retire global.playbook.md")), receipts.join(" | "));
  assert.ok(receipts.some((r) => /DEMOTE b9 → wist\/boards/.test(r)), receipts.join(" | "));

  // WIST b9-class: the coat bullet went to the drama file, window/schema stayed primitive
  assert.deepEqual(loadPlaybook("boards", seats).map((b) => b.id), ["b7", "b8"]);
  assert.deepEqual(loadPlaybook("writer", seats).map((b) => b.id), ["w1"]);
  assert.deepEqual(loadPlaybook("all", seats).map((b) => b.id), ["g1"]);
  const dramaBullets = bulletsOfDrama(proot, "wist", "boards");
  assert.deepEqual(dramaBullets.map((b) => b.id), ["b9"], "ids survive the move, so old UPDATE ids still resolve");

  // every migrated bullet landed in exactly one file
  const allIds = [...loadPlaybook("boards", seats), ...loadPlaybook("writer", seats), ...loadPlaybook("all", seats), ...dramaBullets].map((b) => b.id);
  assert.deepEqual([...allIds].sort(), ["b7", "b8", "b9", "g1", "w1"]);
  for (const scope of ["boards", "writer", "all"]) {
    assert.ok(!fs.readFileSync(path.join(seats, `${scope}.primitive.md`), "utf8").includes("將軍袍"), `${scope} primitive is noun-free`);
  }
  // idempotent: a world with no legacy files is a no-op
  assert.deepEqual(migrateLegacyPlaybooks({ seatsDir: seats, projectsDir: proot }).receipts, []);
});

function bulletsOfDrama(proot: string, drama: string, scope: "writer" | "boards" | "all"): PlaybookBullet[] {
  return loadPlaybookLines({ lifetime: "drama", scope, drama, dir: proot }).filter((l): l is { kind: "bullet"; bullet: PlaybookBullet } => l.kind === "bullet").map((l) => l.bullet);
}

test("dramaEntityTokens walks the same noun test as noun-lint's entityTokens", () => {
  const { proot } = tmpWorld();
  seedEntities(proot, "alpha", ["將軍袍", "傘", "ab"]);
  seedEntities(proot, "beta", ["plow", "赦免狀"]);

  const perDrama = dramaEntityTokens(proot);
  assert.deepEqual(perDrama.find((d) => d.drama === "alpha")!.tokens, ["將軍袍"], "1-char CJK and <4-char ASCII nouns are not lintable");
  assert.deepEqual(perDrama.find((d) => d.drama === "beta")!.tokens, ["plow", "赦免狀"]);
  assert.deepEqual([...allEntityTokens(proot)].sort(), [...nounLintTokens(proot)].sort(), "union parity with noun-lint's walk");
});

test("real repo law: global is retired, all.primitive.md exists, and no primitive file names an entity token", () => {
  const repoRoot = path.resolve(__dirname, "..", "..", "..");
  const seats = path.join(repoRoot, "seats");
  const tokens = nounLintTokens(path.join(repoRoot, "projects"));
  assert.ok(!fs.existsSync(path.join(seats, "global.playbook.md")), "the global name is retired on disk");
  assert.ok(fs.existsSync(path.join(seats, "all.primitive.md")), "the all-scope primitive file exists");
  for (const scope of PLAYBOOK_SCOPES) {
    const file = path.join(seats, `${scope}.primitive.md`);
    if (!fs.existsSync(file)) continue;
    for (const b of loadPlaybookLines(prim(scope, seats)).filter((l): l is { kind: "bullet"; bullet: PlaybookBullet } => l.kind === "bullet").map((l) => l.bullet)) {
      const hit = tokens.find((t) => renderBullet(b).includes(t));
      assert.ok(!hit, `${scope}.primitive.md ${b.id} names ${hit}`);
    }
  }
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
