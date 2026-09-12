import assert from "node:assert/strict";
import * as nodeTest from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CREW, type CrewConfig } from "./crew-llm";
import { runWriter, type SeatDoc } from "./seat-writer";
import { handoffFrom, padBoardDurations, recoverBoardsKeys, runBoards, sheetDigest } from "./seat-boards";
import { boardsSceneSchema } from "./boards-contract";
import { dialogueSeconds } from "./script-contract";
import { BOARDS_CHARTER, WRITER_BEATS_CHARTER, WRITER_OUTLINE_CHARTER } from "./seat-charters";
import { loadCallSheet } from "./writer";
import type { ScriptRanges } from "./script-contract";

/** One file, three doors: bun's node:test shim only works under `bun test`,
 *  so bare `bun <this file>` self-drives the collected cases; `bun test` and
 *  `tsx --test` use the real runner. */
const bareBun = !!process.versions.bun && process.env.BUN_TEST !== "1";
const cases: { name: string; fn: () => void | Promise<void> }[] = [];
const test = bareBun
  ? (name: string, fn: () => void | Promise<void>) => cases.push({ name, fn })
  : nodeTest.test;

type Frozen = {
  brief: string;
  castRoster: string[];
  targetSec: number;
  ranges: ScriptRanges;
  replies: { seat: string; unit: string; model: string; content: string }[];
};

/** Captured once from the real seat models, then frozen: the test drives both
 *  seats end to end with no socket open. */
const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "fixtures", "seats", "three-scene.json"), "utf8"),
) as Frozen;

const crew: CrewConfig = { ...DEFAULT_CREW, endpoint: "http://frozen.invalid:4000" };

function replayFetch(replies: string[]) {
  const seen: { model: string; system: string; user: string }[] = [];
  const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { model: string; messages: { role: string; content: string }[] };
    seen.push({
      model: body.model,
      system: body.messages.find((m) => m.role === "system")?.content ?? "",
      user: body.messages.find((m) => m.role === "user")?.content ?? "",
    });
    const content = replies[seen.length - 1];
    if (content === undefined) throw new Error(`fixture exhausted at call ${seen.length}`);
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, seen };
}

async function runBothSeats() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seats-e2e-"));
  const { impl, seen } = replayFetch(FIXTURE.replies.map((r) => r.content));
  const spoken: string[] = [];
  const docs: SeatDoc[] = [];
  const io = {
    crew,
    receiptDir: dir,
    speak: (t: string) => void spoken.push(t),
    index: (d: SeatDoc) => void docs.push(d),
    fetchImpl: impl,
  };
  const writer = await runWriter(
    { brief: FIXTURE.brief, targetSec: FIXTURE.targetSec, language: "zh-Hant", castRoster: FIXTURE.castRoster },
    { ...io, model: crew.writerModel },
    FIXTURE.ranges,
  );
  const boards = await runBoards(
    { script: writer.script, targetSec: FIXTURE.targetSec, writer: { model: writer.model, receipts: writer.receipts } },
    { ...io, model: crew.boardsModel },
  );
  return { writer, boards, dir, seen, spoken, docs };
}

test("the two seats drive a frozen fixture to a valid three-scene callsheet", async () => {
  const { writer, boards } = await runBothSeats();

  assert.equal(writer.script.outline.scenes.length, 3);
  assert.equal(writer.script.scenes.length, 3);
  assert.deepEqual(writer.script.scenes.map((s) => s.sceneId), ["SC01", "SC02", "SC03"]);

  const sheet = boards.sheet;
  assert.ok(sheet.shots.length >= 3, `${sheet.shots.length} shots`);
  assert.deepEqual(sheet.shots.map((s) => s.id), sheet.shots.map((_, i) => `SH${String(i + 1).padStart(2, "0")}`));
  const runtime = sheet.shots.reduce((a, s) => a + s.durationSec, 0);
  assert.ok(runtime >= FIXTURE.targetSec * 0.9 && runtime <= FIXTURE.targetSec * 1.1, `${runtime}s off the clock`);
  assert.equal(sheet.scenes?.length, 3);
  assert.ok(sheet.voiceover.length > 0);
});

test("every shot carries a camera a mark ray can reach and marks for its cast", async () => {
  const { boards } = await runBothSeats();
  for (const shot of boards.sheet.shots) {
    assert.ok(shot.camera.lensMm >= 24 && shot.camera.lensMm <= 65, `${shot.id} lens`);
    assert.ok(shot.camera.lookAt.z < shot.camera.pos.z, `${shot.id} lens is not tilted down`);
    assert.ok(shot.marks.length >= 1 && shot.marks.length <= 3, `${shot.id} has ${shot.marks.length} marks`);
    for (const mark of shot.marks) {
      assert.ok(boards.sheet.characters.some((c) => c.id === mark.characterId), `${shot.id} stray mark`);
      assert.ok(mark.footL.y > mark.start.y, `${shot.id} feet above the body`);
    }
    assert.ok(shot.scene?.startsWith("SC"), `${shot.id} lost its scene`);
    assert.match(shot.beatId ?? "", /^SC\d{2}\.B\d{2}$/);
  }
});

test("speaking parts stay inside the cast roster and every line is a cast member's", async () => {
  const { writer, boards } = await runBothSeats();
  const speaking = writer.script.outline.characters.filter((c) => c.speaks);
  for (const c of speaking) {
    assert.ok(FIXTURE.castRoster.includes(c.name), `${c.name} is not on the roster`);
  }
  const names = new Set(boards.sheet.characters.map((c) => c.name));
  for (const shot of boards.sheet.shots) {
    if (!shot.dialogue) continue;
    assert.ok(shot.speaker && names.has(shot.speaker), `${shot.id} line has no cast speaker`);
  }
});

test("provenance names both models, lists receipts and digests the sheet", async () => {
  const { boards, dir } = await runBothSeats();
  const p = boards.sheet.provenance!;
  assert.equal(p.writer.model, crew.writerModel);
  assert.equal(p.boards.model, crew.boardsModel);
  assert.ok(!DEFAULT_CREW.deny.includes(p.writer.model));
  assert.ok(!DEFAULT_CREW.deny.includes(p.boards.model));
  assert.equal(p.writer.receipts.length, 4, "outline + three scenes");
  assert.equal(p.boards.receipts.length, 3);
  for (const name of [...p.writer.receipts, ...p.boards.receipts]) {
    assert.ok(fs.existsSync(path.join(dir, name)), `missing receipt ${name}`);
  }
  const { provenance: _drop, ...bare } = boards.sheet;
  assert.equal(p.sha256, sheetDigest(bare as typeof boards.sheet));
  assert.match(p.sha256, /^[0-9a-f]{64}$/);
});

test("the seat-authored sheet passes loadCallSheet, the same gate the plug path uses", async () => {
  const { boards } = await runBothSeats();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seat-sheet-"));
  const file = path.join(dir, "callsheet.json");
  fs.writeFileSync(file, JSON.stringify(boards.sheet, null, 2));
  const reread = loadCallSheet(file);
  assert.equal(reread.shots.length, boards.sheet.shots.length);
  assert.equal(reread.title, boards.sheet.title);
});

test("each seat gets its own charter and only its sealed packet", async () => {
  const { seen } = await runBothSeats();
  assert.equal(seen[0]!.system, WRITER_OUTLINE_CHARTER);
  assert.equal(seen[1]!.system, WRITER_BEATS_CHARTER);
  assert.equal(seen.at(-1)!.system, BOARDS_CHARTER);
  assert.equal(seen[0]!.model, crew.writerModel);
  assert.equal(seen.at(-1)!.model, crew.boardsModel);
  for (const call of seen) {
    assert.doesNotThrow(() => JSON.parse(call.user), "a seat is handed JSON, not prose");
  }
  // the boards desk is told the budget, never the whole film's clock
  const boardsCall = JSON.parse(seen.at(-1)!.user) as { budgetSec: number; beats: unknown[] };
  assert.ok(boardsCall.budgetSec > 0 && boardsCall.budgetSec < FIXTURE.targetSec);
  assert.ok(boardsCall.beats.length > 0);
});

test("the seats speak their own thinking and index the script into the vault", async () => {
  const { spoken, docs, writer } = await runBothSeats();
  assert.equal(spoken.length, 1 + 3 + 3, "outline + three scenes + three boards");
  for (const line of spoken) assert.ok(line.trim().length > 0);
  assert.ok(docs.some((d) => d.id === "script:outline"));
  assert.ok(docs.some((d) => d.id.startsWith("beat:SC01.B")));
  assert.ok(docs.some((d) => d.id === "boards:SC03"));
  assert.equal(writer.script.outline.thinking, spoken[0]);
});

test("the handoff carries each figure's last slot, stance and props forward", () => {
  const carried = handoffFrom(
    {
      sceneId: "SC01",
      thinking: "t",
      shots: [
        {
          beatId: "SC01.B01", size: "medium", angle: "eye", side: "frontal", durationSec: 6,
          action: "a", dialogue: "",
          cast: [{ characterId: "A", slot: "L", depth: "mid", facing: 1, gait: "walk", stance: "stand", stanceEnd: "lean", travelTo: "C" }],
          props: [{ name: "prop-one", heldBy: "A", shape: ["long"], forbid: [] }],
        },
      ],
    },
    {},
  );
  assert.deepEqual(carried.A, { slot: "C", depth: "mid", stance: "lean", props: ["prop-one"] });
  assert.deepEqual(handoffFrom(undefined, carried), carried, "no scene leaves the handoff untouched");
});

test("padBoardDurations lifts durationSec before the dialogue-clock zod gate", () => {
  const line = "x".repeat(38);
  const raw = {
    sceneId: "SC01",
    thinking: "三句以內。",
    shots: [{
      beatId: "SC01.B01",
      size: "medium" as const,
      angle: "eye" as const,
      side: "frontal" as const,
      durationSec: 8.5,
      action: "turns",
      dialogue: line,
      speaker: "Cast-A",
      cast: [{ characterId: "A", slot: "L" as const, depth: "mid" as const, facing: 1 as const, gait: "plant" as const, stance: "stand" as const }],
    }],
  };
  const beats = [{ id: "SC01.B01", action: "turns", dialogue: line, speaker: "Cast-A" }];
  const schema = boardsSceneSchema({
    sceneId: "SC01",
    beats,
    characters: [{ id: "A", name: "Cast-A" }],
    budgetSec: 10,
  });
  assert.equal(schema.safeParse(raw).success, false);
  const padded = schema.safeParse(padBoardDurations(raw));
  assert.equal(padded.success, true);
  assert.ok(padded.data!.shots[0]!.durationSec >= dialogueSeconds(line));
});

test("padBoardDurations lifts a short scene sum into the budget band", () => {
  const shots = Array.from({ length: 10 }, (_, i) => ({
    beatId: `SC02.B${String(i + 1).padStart(2, "0")}`,
    size: "medium" as const,
    angle: "eye" as const,
    side: "frontal" as const,
    durationSec: 8.49,
    action: "holds",
    dialogue: "",
    cast: [{ characterId: "A", slot: "C" as const, depth: "mid" as const, facing: 1 as const, gait: "plant" as const, stance: "stand" as const }],
  }));
  const raw = { sceneId: "SC02", thinking: "加數。", shots };
  const notes: string[] = [];
  const padded = padBoardDurations(raw, 100, (line) => notes.push(line)) as { shots: { durationSec: number }[] };
  const sum = padded.shots.reduce((a, s) => a + s.durationSec, 0);
  assert.ok(sum >= 91 && sum <= 109, `sum ${sum}`);
  // 84.9 lifted into the band, one receipt line per coerced shot
  assert.ok(notes.length > 0 && notes.every((l) => l.startsWith("repair: shots[") && l.includes("durationSec")), notes.join(" | "));
});

test("07JZ SC06 grave: a 49.1 sum against hi 49.05 cuts back inside the band", () => {
  // budget 45 → hi = 45 × 1.09 = 49.05; the message rounds it to 49.1. The old
  // cut took sum − hi = 0.05 off the last shot, tenth() rounded 6.95 back to 7,
  // and zod's `runtime > hi` saw 49.1 > 49.05 — three identical SC06 rejects.
  const shots = Array.from({ length: 7 }, (_, i) => ({
    beatId: `SC06.B${String(i + 1).padStart(2, "0")}`,
    size: "medium" as const,
    angle: "eye" as const,
    side: "frontal" as const,
    durationSec: i === 0 ? 7.1 : 7.0,
    action: "holds",
    dialogue: "",
    cast: [{ characterId: "A", slot: "C" as const, depth: "mid" as const, facing: 1 as const, gait: "plant" as const, stance: "stand" as const }],
  }));
  const beats = shots.map((s) => ({ id: s.beatId, action: "holds" }));
  const schema = boardsSceneSchema({
    sceneId: "SC06",
    beats,
    characters: [{ id: "A", name: "Cast-A" }],
    budgetSec: 45,
  });
  const raw = { sceneId: "SC06", thinking: "修。", shots };
  const unpatched = schema.safeParse(raw);
  assert.equal(unpatched.success, false, "the grave must fail zod before the pad");
  assert.ok(
    !unpatched.success && unpatched.error.issues.some((i) => i.message.includes("add up to 49.1s")),
    JSON.stringify(unpatched.success ? [] : unpatched.error.issues.map((i) => i.message)),
  );
  const notes: string[] = [];
  const padded = padBoardDurations(raw, 45, (line) => notes.push(line)) as { shots: { durationSec: number }[] };
  const sum = padded.shots.reduce((a, s) => a + s.durationSec, 0);
  assert.ok(sum <= 45 * 1.09, `sum ${sum} must land at or under hi 49.05, like the lift's 0.05 margin`);
  const parsed = schema.safeParse(padded);
  assert.equal(parsed.success, true, JSON.stringify(parsed.success ? [] : parsed.error?.issues.map((i) => i.message)));
  assert.ok(notes.some((l) => l.startsWith("repair: shots[6].durationSec saw 7 became")), notes.join(" | "));
});

test("SC02 grave: facing 0 and heldBy \"null\" are repaired, then zod passes", () => {
  const raw = {
    sceneId: "SC02",
    thinking: "修。",
    shots: [{
      beatId: "SC02.B01",
      size: "medium" as const,
      angle: "eye" as const,
      side: "frontal" as const,
      durationSec: 6,
      action: "holds",
      dialogue: "",
      cast: [{ characterId: "A", slot: "C" as const, depth: "mid" as const, facing: 0 as unknown as 1, gait: "plant" as const, stance: "stand" as const }],
      props: [{ name: "犁", heldBy: "null", shape: ["long"], forbid: [] }],
    }],
  };
  const beats = [{ id: "SC02.B01", action: "holds" }];
  const schema = boardsSceneSchema({
    sceneId: "SC02",
    beats,
    characters: [{ id: "A", name: "Cast-A" }],
    budgetSec: 8,
  });
  const notes: string[] = [];
  const repaired = padBoardDurations(raw, 8, (line) => notes.push(line));
  const parsed = schema.safeParse(repaired);
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
  assert.equal(parsed.data!.shots[0]!.cast[0]!.facing, 1);
  assert.equal(parsed.data!.shots[0]!.props![0]!.heldBy, undefined);
  assert.ok(notes.some((l) => l === 'repair: shots[0].cast[0].facing saw 0 became 1'), notes.join(" | "));
  assert.ok(notes.some((l) => l.startsWith('repair: shots[0].props[0].heldBy saw "null" became (dropped')), notes.join(" | "));
  assert.ok(notes.some((l) => l.startsWith("repair: shots[0].durationSec saw 6 became")), notes.join(" | "));
});

test("T5MM SC01 grave: missing, null and illegal gait become plant, then zod passes", () => {
  const raw = {
    sceneId: "SC01",
    thinking: "修。",
    shots: [{
      beatId: "SC01.B01",
      size: "medium" as const,
      angle: "eye" as const,
      side: "frontal" as const,
      durationSec: 6,
      action: "holds",
      dialogue: "",
      // the parsed T5MM grave: gait omitted, nulled, and a stance word in its slot
      cast: [
        { characterId: "A", slot: "L" as const, depth: "mid" as const, facing: 1 as const, stance: "stand" as const },
        { characterId: "B", slot: "C" as const, depth: "mid" as const, facing: 1 as const, gait: null as unknown as "plant", stance: "stand" as const },
        { characterId: "C", slot: "R" as const, depth: "mid" as const, facing: 1 as const, gait: "stand" as unknown as "plant", stance: "stand" as const },
      ],
    }],
  };
  const beats = [{ id: "SC01.B01", action: "holds" }];
  const schema = boardsSceneSchema({
    sceneId: "SC01",
    beats,
    characters: [
      { id: "A", name: "Cast-A" },
      { id: "B", name: "Cast-B" },
      { id: "C", name: "Cast-C" },
    ],
    budgetSec: 8,
  });
  assert.equal(schema.safeParse(raw).success, false, "the grave must fail zod before the pad");
  const notes: string[] = [];
  const repaired = padBoardDurations(raw, 8, (line) => notes.push(line));
  const parsed = schema.safeParse(repaired);
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
  assert.deepEqual(parsed.data!.shots[0]!.cast.map((c) => c.gait), ["plant", "plant", "plant"]);
  assert.ok(notes.some((l) => l === "repair: shots[0].cast[0].gait saw undefined became plant"), notes.join(" | "));
  assert.ok(notes.some((l) => l === "repair: shots[0].cast[1].gait saw null became plant"), notes.join(" | "));
  assert.ok(notes.some((l) => l === 'repair: shots[0].cast[2].gait saw "stand" became plant'), notes.join(" | "));
});

test("padBoardDurations drops heldBy when that letter is not in the shot cast", () => {
  const raw = {
    sceneId: "SC01",
    thinking: "手。",
    shots: [{
      beatId: "SC01.B01",
      size: "medium" as const,
      angle: "eye" as const,
      side: "frontal" as const,
      durationSec: 6,
      action: "holds",
      dialogue: "",
      cast: [{ characterId: "B", slot: "C" as const, depth: "mid" as const, facing: 1 as const, gait: "plant" as const, stance: "stand" as const }],
      props: [{ name: "犁", heldBy: "A", shape: ["long"], forbid: [] }],
    }],
  };
  const padded = padBoardDurations(raw) as { shots: { props: { heldBy?: string }[] }[] };
  assert.equal(padded.shots[0]!.props[0]!.heldBy, undefined);
});

test("recoverBoardsKeys maps qwen punctuation keys onto sceneId", () => {
  assert.equal((recoverBoardsKeys({ ".": "SC04", shots: [] }) as { sceneId: string }).sceneId, "SC04");
  assert.equal((recoverBoardsKeys({ ",": "SC02", thinking: "x" }) as { sceneId: string }).sceneId, "SC02");
  assert.equal((recoverBoardsKeys({ "/sceneId": "SC03" }) as { sceneId: string }).sceneId, "SC03");
  assert.equal((recoverBoardsKeys({ sceneId: "SC01", ".": "SC99" }) as { sceneId: string }).sceneId, "SC01");
  assert.equal("sceneId" in (recoverBoardsKeys({ title: "SC01" }) as object), false);
});

test("a denied model never reaches the wire, whichever seat asks", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seats-deny-"));
  const { impl, seen } = replayFetch([]);
  await assert.rejects(
    () => runWriter(
      { brief: FIXTURE.brief, targetSec: FIXTURE.targetSec, castRoster: FIXTURE.castRoster },
      { crew, model: "glm-5.3", receiptDir: dir, fetchImpl: impl },
      FIXTURE.ranges,
    ),
    /refused model glm-5\.3/,
  );
  assert.equal(seen.length, 0);
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
