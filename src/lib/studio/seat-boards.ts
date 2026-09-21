import crypto from "node:crypto";
import { chatJson, type RepairNote } from "./crew-llm";
import { BOARDS_CHARTER } from "./seat-charters";
import { assemblePlaybook, markPass } from "./playbook";
import { boardsSceneSchema, SHOT_SEC_MAX, SHOT_SEC_MIN, SCENE_BUDGET_TOLERANCE, SLOT_VALUES, DEPTH_VALUES, STANCE_VALUES, type BoardsScene } from "./boards-contract";
import { assertSheetGates, expandBoards } from "./boards-expand";
import { dialogueSeconds, type Script } from "./script-contract";
import type { CallSheet } from "./types";
import type { SeatIo } from "./seat-writer";

export type BoardsResult = { sheet: CallSheet; model: string; receipts: string[] };

type Handoff = Record<string, { slot: string; depth: string; stance: string; props: string[] }>;

const SCENE_ID_RE = /^SC\d{2}$/;
const GAITS = new Set(["plant", "walk", "reach", "turn"]);
const SLOTS = new Set<string>(SLOT_VALUES);
const DEPTHS = new Set<string>(DEPTH_VALUES);
const STANCES = new Set<string>(STANCE_VALUES);

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
        // b5 2Y0V grave: a gait word in stanceEnd enum-fails zod and burned a
        // fail-closed ×3 round; the honest local fix is to drop the end stance
        if (m.stanceEnd !== undefined && !STANCES.has(String(m.stanceEnd))) {
          const why = GAITS.has(String(m.stanceEnd)) ? "gait word, not a stance" : `not one of ${STANCE_VALUES.join("/")}`;
          repair(`repair: shots[${i}].cast[${j}].stanceEnd saw ${JSON.stringify(m.stanceEnd)} became (dropped: ${why})`);
          delete m.stanceEnd;
        }
        // b6 2Y0V grave: a depth word in travelTo enum-fails zod the same way;
        // drop the travel rather than guess a slot the boards never declared
        if (m.travelTo !== undefined && !SLOTS.has(String(m.travelTo))) {
          const why = DEPTHS.has(String(m.travelTo)) ? "depth word, not a slot" : `not one of ${SLOT_VALUES.join("/")}`;
          repair(`repair: shots[${i}].cast[${j}].travelTo saw ${JSON.stringify(m.travelTo)} became (dropped: ${why})`);
          delete m.travelTo;
        }
        return m;
      });
      // b7 BO9W grave: two figures on one slot/depth seat custom-fails zod
      // ("two figures cannot share slot"); nudge the later one to the first
      // free seat — same depth first — before zod burns a repair round
      const seated = cast as unknown[];
      if (seated.every((m) => m && typeof m === "object" && !Array.isArray(m))) {
        const taken = new Set<string>();
        for (const [j, member] of (seated as Record<string, unknown>[]).entries()) {
          const m = member as { slot?: unknown; depth?: unknown };
          if (typeof m.slot !== "string" || typeof m.depth !== "string") continue; // zod reports these
          if (!SLOTS.has(m.slot) || !DEPTHS.has(m.depth)) continue; // zod reports these
          const seat = `${m.slot}/${m.depth}`;
          if (!taken.has(seat)) {
            taken.add(seat);
            continue;
          }
          const free =
            SLOT_VALUES.map((s) => (taken.has(`${s}/${m.depth}`) ? null : { slot: s, depth: m.depth as string })).find(Boolean)
            ?? DEPTH_VALUES.map((d) => (taken.has(`${m.slot}/${d}`) ? null : { slot: m.slot as string, depth: d })).find(Boolean)
            ?? DEPTH_VALUES.flatMap((d) => SLOT_VALUES.map((s) => (taken.has(`${s}/${d}`) ? null : { slot: s, depth: d }))).find(Boolean);
          if (free) {
            if (free.slot !== m.slot) {
              repair(`repair: shots[${i}].cast[${j}].slot saw ${JSON.stringify(m.slot)} became ${JSON.stringify(free.slot)} (seat ${seat} already taken in this shot)`);
              m.slot = free.slot;
            }
            if (free.depth !== m.depth) {
              repair(`repair: shots[${i}].cast[${j}].depth saw ${JSON.stringify(m.depth)} became ${JSON.stringify(free.depth)} (seat ${seat} already taken in this shot)`);
              m.depth = free.depth;
            }
            taken.add(`${m.slot}/${m.depth}`);
          }
          // no free seat at all: leave it — zod's shared-seat issue is the report
        }
      }
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
      // the 07JZ SC06 grave: cutting exactly sum - hi let tenth() round the
      // cut shot back up (7 − 0.05 → 7), so the sum stayed 49.1 against a true
      // hi of 49.05 (45 × 1.09) and zod's `runtime > hi` killed the scene.
      // The lift leaves 0.05 under lo; the cut leaves the same 0.05 over hi
      // and keeps cutting while the live sum still overshoots.
      const liveSum = () => shots.reduce((a, s) => a + (s.durationSec as number), 0);
      while (liveSum() > hi) {
        const sumBefore = liveSum();
        let extra = sumBefore - hi + 0.05;
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
        if (liveSum() >= sumBefore) break; // nothing cuttable moved; zod reports the miss
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
      onAttempt: io.warn && ((r: { attempt: number; valid: boolean; errors: string[] }) => {
        if (!r.valid) void io.warn?.(`boards ${scene.id} attempt ${r.attempt} ✗ ${r.errors[0] ?? ""}`);
      }),
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
