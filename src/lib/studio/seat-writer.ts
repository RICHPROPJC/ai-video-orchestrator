import { chatJson, type CrewConfig } from "./crew-llm";
import { WRITER_BEATS_CHARTER, WRITER_OUTLINE_CHARTER } from "./seat-charters";
import {
  FEATURE_RANGES,
  assertBeatTotal,
  outlineSchema,
  sceneBeatsSchema,
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

export type SeatIo = {
  crew: CrewConfig;
  model: string;
  receiptDir: string;
  speak?: (thinking: string) => void | Promise<void>;
  index?: (doc: SeatDoc) => void;
  fetchImpl?: typeof fetch;
};

/** 阿文 works twice: the shape of the film, then the beats of one scene at a
 *  time — a whole 10-minute script in one reply is where models start drifting. */
export async function runWriter(packet: WriterPacket, io: SeatIo, ranges: ScriptRanges = FEATURE_RANGES): Promise<WriterResult> {
  const receipts: string[] = [];
  const outlinePass = await chatJson<Outline>({
    seat: "writer",
    unit: "outline",
    model: io.model,
    crew: io.crew,
    system: WRITER_OUTLINE_CHARTER,
    user: JSON.stringify({
      brief: packet.brief,
      targetSec: packet.targetSec,
      language: packet.language ?? "auto",
      castRoster: packet.castRoster,
      constraints: packet.constraints ?? [],
    }),
    schema: outlineSchema({ targetSec: packet.targetSec, castRoster: packet.castRoster, ranges }),
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
  for (const scene of outline.scenes) {
    const pass = await chatJson({
      seat: "writer",
      unit: scene.id,
      model: io.model,
      crew: io.crew,
      system: WRITER_BEATS_CHARTER,
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
  return { script, model: outlinePass.model, receipts };
}
