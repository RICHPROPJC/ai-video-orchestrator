import crypto from "node:crypto";
import { chatJson } from "./crew-llm";
import { BOARDS_CHARTER } from "./seat-charters";
import { boardsSceneSchema, type BoardsScene } from "./boards-contract";
import { assertSheetGates, expandBoards } from "./boards-expand";
import type { Script } from "./script-contract";
import type { CallSheet } from "./types";
import type { SeatIo } from "./seat-writer";

export type BoardsResult = { sheet: CallSheet; model: string; receipts: string[] };

type Handoff = Record<string, { slot: string; depth: string; stance: string; props: string[] }>;

/** What the next scene inherits: where each figure was left standing and what
 *  they were still holding. Derived from this seat's own last shot, never guessed. */
export function handoffFrom(scene: BoardsScene | undefined, carried: Handoff): Handoff {
  if (!scene) return carried;
  const next: Handoff = { ...carried };
  for (const shot of scene.shots) {
    for (const member of shot.cast) {
      next[member.characterId] = {
        slot: member.travelTo ?? member.slot,
        depth: member.depth,
        stance: member.stanceEnd ?? member.stance,
        props: (shot.props ?? []).filter((p) => p.heldBy === member.characterId).map((p) => p.name),
      };
    }
  }
  return next;
}

export function sheetDigest(sheet: CallSheet): string {
  const { provenance: _drop, ...rest } = sheet;
  return crypto.createHash("sha256").update(JSON.stringify(rest)).digest("hex");
}

/** 阿圖 boards one scene per turn so the handoff is real continuity, then the
 *  desk — not the model — assigns SH ids and turns the grammar into geometry. */
export async function runBoards(
  opts: { script: Script; targetSec: number; aspect?: CallSheet["aspect"]; writer: { model: string; receipts: string[] } },
  io: SeatIo,
): Promise<BoardsResult> {
  const { script } = opts;
  const characters = script.outline.characters.map((c) => ({ id: c.id, name: c.name }));
  const receipts: string[] = [];
  const boards: BoardsScene[] = [];
  let carried: Handoff = {};
  // the writer's scene targets are within 10% of the slate; rescaling them to
  // land exactly on it keeps the per-scene gate and the sheet gate the same gate
  const declared = script.outline.scenes.reduce((a, s) => a + s.targetSec, 0) || 1;
  const budget = (sec: number) => (sec / declared) * opts.targetSec;

  for (const scene of script.outline.scenes) {
    const beats = script.scenes.find((s) => s.sceneId === scene.id)?.beats ?? [];
    const budgetSec = budget(scene.targetSec);
    const pass = await chatJson({
      seat: "boards",
      unit: scene.id,
      model: io.model,
      crew: io.crew,
      system: BOARDS_CHARTER,
      user: JSON.stringify({
        scene: { ...scene, targetSec: Number(budgetSec.toFixed(1)) },
        budgetSec: Number(budgetSec.toFixed(1)),
        beats,
        characters: script.outline.characters.map((c) => ({
          id: c.id,
          name: c.name,
          role: c.role,
          heightM: c.heightM,
          speaks: c.speaks,
        })),
        previousSceneHandoff: carried,
      }),
      schema: boardsSceneSchema({ sceneId: scene.id, beats, characters, budgetSec }),
      receiptDir: io.receiptDir,
      fetchImpl: io.fetchImpl,
    });
    receipts.push(...pass.receipts);
    boards.push(pass.value);
    carried = handoffFrom(pass.value, carried);
    await io.speak?.(pass.value.thinking);
    io.index?.({ id: `boards:${scene.id}`, text: pass.value.shots.map((s) => s.action).join(" ") });
  }

  const expanded = expandBoards({ script, boards, targetSec: opts.targetSec, aspect: opts.aspect });
  assertSheetGates(expanded, { script, targetSec: opts.targetSec });
  const sheet: CallSheet = {
    ...expanded,
    provenance: {
      writer: { model: opts.writer.model, receipts: opts.writer.receipts },
      boards: { model: io.model, receipts },
      sha256: sheetDigest(expanded),
    },
  };
  return { sheet, model: io.model, receipts };
}
