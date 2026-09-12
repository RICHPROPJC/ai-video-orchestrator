import crypto from "node:crypto";
import { chatJson, type RepairNote } from "./crew-llm";
import { BOARDS_CHARTER } from "./seat-charters";
import { assemblePlaybook, markPass } from "./playbook";
import { boardsSceneSchema, SHOT_SEC_MAX, SHOT_SEC_MIN, SCENE_BUDGET_TOLERANCE, type BoardsScene } from "./boards-contract";
import { assertSheetGates, expandBoards } from "./boards-expand";
import { dialogueSeconds, type Script } from "./script-contract";
import type { CallSheet } from "./types";
import type { SeatIo } from "./seat-writer";

export type BoardsResult = { sheet: CallSheet; model: string; receipts: string[] };

type Handoff = Record<string, { slot: string; depth: string; stance: string; props: string[] }>;

const SCENE_ID_RE = /^SC\d{2}$/;
const GAITS = new Set(["plant", "walk", "reach", "turn"]);

/** qwen JSON-mode sometimes stores sceneId under "." / "," / "/sceneId". */
export function recoverBoardsKeys(raw: unknown, note?: RepairNote): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const obj = { ...(raw as Record<string, unknown>) };
  if (typeof obj.sceneId === "string" && SCENE_ID_RE.test(obj.sceneId)) return obj;
  for (const [key, value] of Object.entries(obj)) {
    if (key === "sceneId") continue;
    if (typeof value === "string" && SCENE_ID_RE.test(value) && /sceneId|^[.,/]+$/i.test(key)) {
      note?.(`repair: sceneId saw ${JSON.stringify(key)}:${JSON.stringify(value)} became sceneId=${JSON.stringify(value)}`);
      obj.sceneId = value;
      return obj;
    }
  }
  return obj;
}

function tenth(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Pad each shot's durationSec to fit its dialogue, drop illegal heldBy
 *  ("null"/"undefined" included), face illegal facing right, plant illegal
 *  gait, then nudge the sum into the scene budget band before zod sees it.
 *  Every coercion leaves a `repair:` line on the attempt receipt. */
export function padBoardDurations(raw: unknown, budgetSec?: number, note?: RepairNote): unknown {
  const repair = note ?? (() => {});
  const recovered = recoverBoardsKeys(raw, repair);
  if (!recovered || typeof recovered !== "object" || Array.isArray(recovered)) return recovered;
  const obj = recovered as Record<string, unknown>;
  if (!Array.isArray(obj.shots)) return recovered;
  const shots = (obj.shots as Record<string, unknown>[]).map((shot, i): Record<string, unknown> => {
    const dialogue = typeof shot.dialogue === "string" ? shot.dialogue.trim() : "";
    const durationSec = typeof shot.durationSec === "number" ? shot.durationSec : 0;
    let cast = shot.cast;
    if (Array.isArray(cast)) {
      cast = cast.map((member, j) => {
        if (!member || typeof member !== "object" || Array.isArray(member)) return member;
        const m = { ...(member as Record<string, unknown>) };
        // only 1|-1 are legal; anything else (0, "1", 2 …) faces camera-right
        if (m.facing !== 1 && m.facing !== -1) {
          repair(`repair: shots[${i}].cast[${j}].facing saw ${JSON.stringify(m.facing)} became 1`);
          m.facing = 1;
        }
        // the T5MM SC01 grave: qwen omits gait (or nulls it / borrows a stance
        // word); a figure standing where it stands is the only honest default
        if (typeof m.gait !== "string" || !GAITS.has(m.gait)) {
          repair(`repair: shots[${i}].cast[${j}].gait saw ${JSON.stringify(m.gait)} became plant`);
          m.gait = "plant";
        }
        return m;
      });
    }
    const ids = new Set(
      (Array.isArray(cast) ? cast : [])
        .map((m) => (m && typeof m === "object" ? (m as { characterId?: string }).characterId : undefined))
        .filter((id): id is string => typeof id === "string"),
    );
    let props = shot.props;
    if (Array.isArray(props)) {
      props = props.map((prop, j) => {
        if (!prop || typeof prop !== "object") return prop;
        const heldBy = (prop as { heldBy?: string }).heldBy;
        if (heldBy && !ids.has(heldBy)) {
          repair(`repair: shots[${i}].props[${j}].heldBy saw ${JSON.stringify(heldBy)} became (dropped: not cast in shot)`);
          const { heldBy: _drop, ...rest } = prop as Record<string, unknown>;
          return rest;
        }
        return prop;
      });
    }
    const dialogueClock = dialogueSeconds(dialogue);
    const floor = Math.max(dialogueClock, SHOT_SEC_MIN);
    if (durationSec < floor) {
      const why = dialogue && dialogueClock >= SHOT_SEC_MIN ? "dialogue clock" : `floor ${SHOT_SEC_MIN}`;
      repair(`repair: shots[${i}].durationSec saw ${durationSec} became ${floor.toFixed(1)} (${why})`);
    }
    return { ...shot, cast, props, durationSec: Math.max(durationSec, floor) };
  });
  if (typeof budgetSec === "number" && budgetSec > 0) {
    const lo = budgetSec * (1 - SCENE_BUDGET_TOLERANCE);
    const hi = budgetSec * (1 + SCENE_BUDGET_TOLERANCE);
    const sum = shots.reduce((a, s) => a + (s.durationSec as number), 0);
    if (sum < lo) {
      let need = lo - sum + 0.05;
      for (let i = 0; i < shots.length && need > 0; i += 1) {
        const shot = shots[i]!;
        const room = SHOT_SEC_MAX - (shot.durationSec as number);
        if (room <= 0) continue;
        const add = Math.min(room, need);
        const before = shot.durationSec as number;
        shot.durationSec = tenth(before + add);
        need -= add;
        repair(`repair: shots[${i}].durationSec saw ${before} became ${shot.durationSec} (sum lift toward band ${lo.toFixed(1)}–${hi.toFixed(1)})`);
      }
    } else if (sum > hi) {
      let extra = sum - hi;
      for (let k = shots.length - 1; k >= 0 && extra > 0; k -= 1) {
        const shot = shots[k]!;
        const dialogue = typeof shot.dialogue === "string" ? shot.dialogue.trim() : "";
        const floor = Math.max(SHOT_SEC_MIN, dialogueSeconds(dialogue));
        const room = (shot.durationSec as number) - floor;
        if (room <= 0) continue;
        const cut = Math.min(room, extra);
        const before = shot.durationSec as number;
        shot.durationSec = tenth(before - cut);
        extra -= cut;
        repair(`repair: shots[${k}].durationSec saw ${before} became ${shot.durationSec} (sum cut toward band ${lo.toFixed(1)}–${hi.toFixed(1)})`);
      }
    }
  }
  return { ...obj, shots };
}

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
  // system = charter (law) + global playbook + own playbook; charter never shrinks
  const book = assemblePlaybook("boards", io.playbookDir);
  const boards: BoardsScene[] = [];
  let carried: Handoff = {};
  // the writer's scene targets are within 10% of the slate; rescaling them to
  // land exactly on it keeps the per-scene gate and the sheet gate the same gate
  const declared = script.outline.scenes.reduce((a, s) => a + s.targetSec, 0) || 1;
  const budget = (sec: number) => (sec / declared) * opts.targetSec;

  for (const [i, scene] of script.outline.scenes.entries()) {
    // qwen on litellm sometimes returns an empty JSON object if the prior scene
    // call finished milliseconds ago; a short gap avoids that race.
    if (i > 0 && !io.fetchImpl) await new Promise((r) => setTimeout(r, 5000));
    const beats = script.scenes.find((s) => s.sceneId === scene.id)?.beats ?? [];
    const budgetSec = budget(scene.targetSec);
    const pass = await chatJson({
      seat: "boards",
      unit: scene.id,
      model: io.model,
      crew: io.crew,
      system: BOARDS_CHARTER + book.text,
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
      normalize: (raw, note) => padBoardDurations(raw, budgetSec, note),
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
  // the boards stage passed with these bullets in the prompt: ship gate
  receipts.push(...markPass(["boards", "global"], io.playbookDir));
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
