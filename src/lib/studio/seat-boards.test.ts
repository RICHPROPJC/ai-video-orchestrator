import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CREW, type CrewConfig } from "./crew-llm";
import { runWriter, type SeatDoc } from "./seat-writer";
import { handoffFrom, padBoardDurations, runBoards, sheetDigest } from "./seat-boards";
import { boardsSceneSchema } from "./boards-contract";
import { dialogueSeconds } from "./script-contract";
import { BOARDS_CHARTER, WRITER_BEATS_CHARTER, WRITER_OUTLINE_CHARTER } from "./seat-charters";
import { loadCallSheet } from "./writer";
import type { ScriptRanges } from "./script-contract";

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
