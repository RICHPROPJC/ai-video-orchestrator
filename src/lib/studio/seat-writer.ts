import { chatJsonSeat, type CrewConfig, type RepairNote } from "./crew-llm";
import { WRITER_BEATS_CHARTER, WRITER_OUTLINE_CHARTER } from "./seat-charters";
import { assemblePlaybook, markPass } from "./playbook";
import {
  assertBeatTotal,
  outlineSchema,
  rangesFor,
  sceneBeatsSchema,
  sceneClampBounds,
  type Outline,
  type Script,
  type ScriptRanges,
} from "./script-contract";

export type WriterPacket = {
  brief: string;
  targetSec: number;
  language?: "auto" | "zh-Hant" | "zh-Hans" | "yue" | "en";
  castRoster: string[];
  constraints?: string[];
};

export type SeatDoc = { id: string; text: string; shotId?: string };

export type WriterResult = { script: Script; model: string; receipts: string[] };

function clampSceneSec(n: number, slateSec?: number): number {
  // ECOM1A: band-aware bounds — ad slates (≤30s) clamp 15–30, episode/feature stay 24–120
  const { min, max } = sceneClampBounds(slateSec ?? Infinity);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function coerceLang(raw: unknown): "zh-Hant" | "yue" | "en" {
  const s = String(raw ?? "").toLowerCase();
  if (/yue|canton|粤|粵/.test(s)) return "yue";
  if (/^(en|eng|english)\b/.test(s) || s === "en") return "en";
  return "zh-Hant";
}

/** Nearest enum by first mention: transition prose like 「夜→晨→日」 maps to
 *  the state the film opens in (night), not whichever synonym matches first. */
function coerceTimeOfDay(raw: unknown, onChange?: (saw: unknown, became: string) => void): "dawn" | "day" | "dusk" | "night" {
  const s = String(raw ?? "");
  const hits: { at: number; became: "dawn" | "dusk" | "night" }[] = [];
  const dusk = s.search(/dusk|黃昏|黄昏|傍晚/);
  const dawn = s.search(/dawn|破曉|清晨|晨/);
  const night = s.search(/night|夜|晚/);
  if (dusk >= 0) hits.push({ at: dusk, became: "dusk" });
  if (dawn >= 0) hits.push({ at: dawn, became: "dawn" });
  if (night >= 0) hits.push({ at: night, became: "night" });
  hits.sort((a, b) => a.at - b.at);
  const became = hits[0]?.became ?? "day";
  if (became !== raw) onChange?.(raw, became);
  return became;
}

function coerceWeather(raw: unknown, onChange?: (saw: unknown, became: string) => void): "clear" | "rain" | "wind" | "neon" {
  const s = String(raw ?? "");
  const became = /neon|霓/.test(s)
    ? "neon"
    : /rain|雨/.test(s)
      ? "rain"
      : /wind|風|风/.test(s)
        ? "wind"
        : "clear";
  if (became !== raw) onChange?.(raw, became);
  return became;
}

/** Map kimi's prose enums / oversize scene clocks onto the outline schema
 *  before zod. Does not invent scenes — a 5-scene reply stays 5 scenes and
 *  the scene-band fail goes to the repair-prompt. Every coercion leaves a
 *  `repair:` line on the attempt receipt. */
export function coerceOutline(raw: unknown, slateSec?: number, note?: RepairNote): unknown {
  const repair = note ?? (() => {});
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const o = { ...(raw as Record<string, unknown>) };
  if ("language" in o) {
    const mapped = coerceLang(o.language);
    if (mapped !== o.language) {
      repair(`repair: language saw ${JSON.stringify(o.language) ?? String(o.language)} became ${JSON.stringify(mapped)}`);
    }
    o.language = mapped;
  }
  if (o.world && typeof o.world === "object" && !Array.isArray(o.world)) {
    const w = { ...(o.world as Record<string, unknown>) };
    if ("timeOfDay" in w) w.timeOfDay = coerceTimeOfDay(w.timeOfDay, (saw, became) => repair(`repair: world.timeOfDay saw ${JSON.stringify(saw)} became ${JSON.stringify(became)}`));
    if ("weather" in w) w.weather = coerceWeather(w.weather, (saw, became) => repair(`repair: world.weather saw ${JSON.stringify(saw)} became ${JSON.stringify(became)}`));
    o.world = w;
  }
  if (Array.isArray(o.scenes)) {
    o.scenes = o.scenes.map((scene, i) => {
      if (!scene || typeof scene !== "object" || Array.isArray(scene)) return scene;
      const s = { ...(scene as Record<string, unknown>) };
      if ("timeOfDay" in s) s.timeOfDay = coerceTimeOfDay(s.timeOfDay, (saw, became) => repair(`repair: scenes[${i}].timeOfDay saw ${JSON.stringify(saw)} became ${JSON.stringify(became)}`));
      if ("weather" in s) s.weather = coerceWeather(s.weather, (saw, became) => repair(`repair: scenes[${i}].weather saw ${JSON.stringify(saw)} became ${JSON.stringify(became)}`));
      if ("targetSec" in s) {
        const clamped = clampSceneSec(Number(s.targetSec), slateSec);
        if (clamped !== s.targetSec) {
          const { min, max } = sceneClampBounds(slateSec ?? Infinity);
          repair(`repair: scenes[${i}].targetSec saw ${JSON.stringify(s.targetSec)} became ${clamped} (clamp ${min}–${max})`);
        }
        s.targetSec = clamped;
      }
      return s;
    }) as Record<string, unknown>[];
    const scenes = o.scenes as Record<string, unknown>[];
    if (typeof slateSec === "number" && slateSec > 0 && scenes.length) {
      // Story seconds stay as written. Do not scale scenes up to fill the slate.
    }
  }
  return o;
}

export type SeatIo = {
  crew: CrewConfig;
  model: string;
  receiptDir: string;
  speak?: (thinking: string) => void | Promise<void>;
  index?: (doc: SeatDoc) => void;
  fetchImpl?: typeof fetch;
  /** seats/ dir: set it and every writer system prompt carries the global +
   *  writer playbooks (charter untouched), and a PASS promotes their trials. */
  playbookDir?: string;
  /** Named project. Unset = public playbooks only. Never guess the only drama on disk. */
  drama?: string;
  /** INSIDE_VISIBLE 卡A attempt燈: the pipeline wires this to a warn event —
   *  a failed attempt is visible the moment it happens, not only in receipts. */
  warn?: (message: string) => void | Promise<void>;
};

/** 阿文 works twice: the shape of the film, then the beats of one scene at a
 *  time — a whole 10-minute script in one reply is where models start drifting. */
export async function runWriter(packet: WriterPacket, io: SeatIo, ranges?: ScriptRanges): Promise<WriterResult> {
  // the slate's own seconds decide the band: 300s episodes are not squeezed features
  ranges ??= rangesFor(packet.targetSec);
  const receipts: string[] = [];
  // system = charter (law) + global playbook + own playbook; charter never shrinks
  const book = assemblePlaybook("writer", io.playbookDir, io.drama);
  const attemptLamp = (unit: string) =>
    io.warn &&
    ((r: { attempt: number; valid: boolean; errors: string[] }) => {
      if (!r.valid) void io.warn?.(`writer ${unit} attempt ${r.attempt} ✗ ${r.errors[0] ?? ""}`);
    });

  const outlinePass = await chatJsonSeat<Outline>({
    seat: "writer",
    unit: "outline",
    fallbackModel: io.crew.secondFallback,
    onAttempt: attemptLamp("outline"),
    model: io.model,
    crew: io.crew,
    system: WRITER_OUTLINE_CHARTER + book.text,
    user: JSON.stringify({
      brief: packet.brief,
      targetSec: packet.targetSec,
      language: packet.language ?? "auto",
      castRoster: packet.castRoster,
      constraints: packet.constraints ?? [],
    }),
    schema: outlineSchema({ targetSec: packet.targetSec, castRoster: packet.castRoster, ranges }),
    normalize: (raw, note) => coerceOutline(raw, packet.targetSec, note),
    receiptDir: io.receiptDir,
    fetchImpl: io.fetchImpl,
  });
  receipts.push(...outlinePass.receipts);
  const outline = outlinePass.value;
  await io.speak?.(outline.thinking);
  io.index?.({ id: "script:outline", text: `${outline.title} ${outline.logline} ${outline.mood}` });
  for (const scene of outline.scenes) {
    io.index?.({ id: `script:${scene.id}`, text: `${scene.heading} ${scene.summary}` });
  }

  const speakingNames = outline.characters.filter((c) => c.speaks).map((c) => c.name);
  const scenes: Script["scenes"] = [];
  for (const [i, scene] of outline.scenes.entries()) {
    if (i > 0 && !io.fetchImpl) await new Promise((r) => setTimeout(r, 5000));
    const pass = await chatJsonSeat({
      seat: "writer",
      unit: scene.id,
      fallbackModel: io.crew.secondFallback,
      onAttempt: attemptLamp(scene.id),
      model: io.model,
      crew: io.crew,
      system: WRITER_BEATS_CHARTER + book.text,
      user: JSON.stringify({
        scene,
        title: outline.title,
        logline: outline.logline,
        mood: outline.mood,
        language: outline.language,
        world: outline.world,
        characters: outline.characters.map((c) => ({ id: c.id, name: c.name, role: c.role, speaks: c.speaks })),
        previousScene: scenes.at(-1)
          ? { id: scenes.at(-1)!.sceneId, lastBeat: scenes.at(-1)!.beats.at(-1) }
          : null,
      }),
      schema: sceneBeatsSchema({ sceneId: scene.id, speakingNames, targetSec: scene.targetSec }),
      receiptDir: io.receiptDir,
      fetchImpl: io.fetchImpl,
    });
    receipts.push(...pass.receipts);
    scenes.push(pass.value);
    await io.speak?.(pass.value.thinking);
    for (const beat of pass.value.beats) {
      io.index?.({ id: `beat:${beat.id}`, text: `${beat.action} ${beat.dialogue ?? ""}`.trim() });
    }
  }

  const script: Script = { outline, scenes };
  assertBeatTotal(script, ranges);
  // the writer's whole stage passed with these bullets in the prompt: ship gate
  receipts.push(...markPass(["writer", "global"], io.playbookDir, io.drama));
  return { script, model: outlinePass.model, receipts };
}
