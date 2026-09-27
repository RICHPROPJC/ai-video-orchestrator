import type { AudioEvent, CallSheet, Character, Shot } from "./types";
import { BLOCKOUT_HEIGHT, BLOCKOUT_WIDTH } from "./blockout";
import { cameraFor } from "./camera-presets";
import { markFor, placeHands } from "./blocking-grid";
import { dialogueSeconds, type Script, type Beat } from "./script-contract";
import type { BoardShot, BoardsScene } from "./boards-contract";

const STILL_MODEL = "SenseNova U1.5-8B-MoT";
const MOTION_MODEL = "MiniMax H3 R2V";
const DURATION_TOLERANCE = 0.1;
const FRAME = { width: BLOCKOUT_WIDTH, height: BLOCKOUT_HEIGHT };

/** DIALOGUE_RULE_PROVENANCE_0927：一句對白嘅「播出鏡」——explicit audioBeats
 *  優先（seat 寫明邊鏡播出，跨場景合法）；成句 beat 冇任何鏡認領先至退落
 *  beatIds 覆蓋（單鏡一句舊形零改動）。傳回 cut order 鏡 index 序。 */
function audioCoverShots(beatId: string, shots: { beatIds: string[]; audioBeats?: string[] }[]): number[] {
  const explicit = shots
    .map((s, i) => (s.audioBeats ?? []).includes(beatId) ? i : -1)
    .filter((i) => i >= 0);
  if (explicit.length > 0) return explicit;
  return shots.map((s, i) => (s.beatIds.includes(beatId) ? i : -1)).filter((i) => i >= 0);
}

/** 聲音事件時間線（成片共同時間線，cut order 累計秒）。窗口＝首尾播出鏡夾
 *  住嘅區間（assertSheetGates 驗連續＋夠講）。 */
export function deriveAudioEvents(script: Script, shots: Shot[]): AudioEvent[] {
  const beatById = new Map<string, Beat>();
  for (const scene of script.scenes) for (const beat of scene.beats) beatById.set(beat.id, beat);
  const carrier = shots.map((s) => ({ beatIds: s.beatIds ?? (s.beatId ? [s.beatId] : []), audioBeats: s.audioBeats }));
  // 時間線：鏡 window
  let t = 0;
  const windowOf = shots.map((s) => {
    const w = { start: t, end: t + s.durationSec };
    t = w.end;
    return w;
  });
  const events: AudioEvent[] = [];
  for (const [beatId, beat] of beatById) {
    const text = beat.dialogue?.trim() ?? "";
    if (!text) continue;
    const cover = audioCoverShots(beatId, carrier);
    if (cover.length === 0) continue; // 未有鏡播——assertSheetGates 報
    const first = windowOf[cover[0]!]!;
    const last = windowOf[cover[cover.length - 1]!]!;
    events.push({ beatId, speaker: beat.speaker ?? "", text, startSec: Number(first.start.toFixed(3)), endSec: Number(last.end.toFixed(3)) });
  }
  events.sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);
  return events;
}

/** 每鏡「播出」嘅對白（derived 顯示欄，餵 prose quote／QC／markdown）：本鏡
 *  覆蓋到嘅事件文本按時間序 join；speaker 淨係得一個事件先寫（多句多聲就
 *  留空，下游 h3-prose 自有 fallback）。同一句跨鏡時兩鏡都會見到成句——
 *  佢係「呢鏡有呢句聲」嘅標記，唔係「呢鏡獨自講晒」。 */
function dialogueOverShot(shot: Shot, events: AudioEvent[], window: { start: number; end: number }): { dialogue: string; speaker?: string } {
  const over = events.filter((e) => e.startSec < window.end - 1e-9 && e.endSec > window.start + 1e-9);
  if (over.length === 0) return { dialogue: "" };
  return {
    dialogue: over.map((e) => e.text).join(" "),
    ...(over.length === 1 && over[0]!.speaker ? { speaker: over[0]!.speaker } : {}),
  };
}

function shotId(n: number): string {
  return `SH${String(n).padStart(2, "0")}`;
}

function marksFor(shot: BoardShot, heightById: Map<string, number>): Shot["marks"] {
  const camera = cameraFor(shot.size, shot.angle, shot.side);
  return shot.cast.map((member) => {
    const mark = markFor({
      characterId: member.characterId,
      slot: member.slot,
      depth: member.depth,
      facing: member.facing,
      gait: member.gait,
      stance: member.stance,
      stanceEnd: member.stanceEnd,
      travelTo: member.travelTo,
    });
    return placeHands(mark, camera, heightById.get(member.characterId) ?? 1, FRAME);
  });
}

/** Shot ids are the desk's, not the seat's: one run of SHxx in cut order across
 *  every scene, assigned once and never renegotiated. */
export function expandBoards(opts: {
  script: Script;
  boards: BoardsScene[];
  targetSec: number;
  aspect?: CallSheet["aspect"];
}): CallSheet {
  const { outline } = opts.script;
  const heightById = new Map(outline.characters.map((c) => [c.id, c.heightM]));
  const sceneById = new Map(outline.scenes.map((s) => [s.id, s]));
  const ordered = outline.scenes
    .map((s) => opts.boards.find((b) => b.sceneId === s.id))
    .filter((b): b is BoardsScene => Boolean(b));
  if (ordered.length !== outline.scenes.length) {
    const missing = outline.scenes.filter((s) => !opts.boards.some((b) => b.sceneId === s.id)).map((s) => s.id);
    throw new Error(`boards missing for ${missing.join(", ")}`);
  }

  const shots: Shot[] = [];
  for (const board of ordered) {
    const scene = sceneById.get(board.sceneId)!;
    for (const shot of board.shots) {
      const index = shots.length + 1;
      const camera = cameraFor(shot.size, shot.angle, shot.side);
      shots.push({
        id: shotId(index),
        index,
        heading: `${shot.size.toUpperCase()} / ${scene.heading}`,
        size: shot.size,
        location: scene.location,
        action: shot.action,
        // DIALOGUE_RULE_PROVENANCE_0927：對白唔再由 seat 逐字抄入鏡——
        // 聲音事件（beat）係真源，下面 deriveAudioEvents＋dialogueOverShot
        // 按時間區間衍生每鏡顯示對白。durationSec 亦唔再被對白時鐘硬抬
        // （字數估時只係估算；一句跨鏡時夾埋窗口夠講就得）。
        dialogue: "",
        durationSec: shot.durationSec,
        camera,
        marks: marksFor(shot, heightById),
        ...(shot.props?.length ? { props: shot.props } : {}),
        ...(shot.require
          ? {
              require: {
                ...shot.require,
                // T32: the packet's own light angle wins, else the shot's camera angle
                ...(shot.require.angle === undefined && shot.angle !== undefined ? { angle: shot.angle } : {}),
              },
            }
          : {}),
        stillPrompt: shot.action,
        motionPrompt: shot.action,
        scene: scene.id,
        beatId: shot.beatId,
        ...(shot.beatIds?.length ? { beatIds: shot.beatIds } : {}),
        ...(shot.audioBeats?.length ? { audioBeats: shot.audioBeats } : {}),
        ...(shot.envAnim?.length ? { envAnim: shot.envAnim } : {}),
      });
    }
  }
  // 聲音／畫面分離（DIALOGUE_RULE_PROVENANCE_0927）：事件時間線＋每鏡衍生
  // 對白欄（舊消費者：h3-prose quote、QC expected、markdown 照讀不誤）。
  const audioEvents = deriveAudioEvents(opts.script, shots);
  {
    let t = 0;
    for (const shot of shots) {
      const window = { start: t, end: t + shot.durationSec };
      t = window.end;
      const derived = dialogueOverShot(shot, audioEvents, window);
      shot.dialogue = derived.dialogue;
      if (derived.speaker) shot.speaker = derived.speaker;
      else delete shot.speaker;
    }
  }

  const characters: Character[] = outline.characters.map((c) => ({
    id: c.id,
    name: c.name,
    role: c.role,
    wardrobe: c.wardrobe,
    palette: c.palette,
    voice: c.voice,
    heightM: c.heightM,
  }));

  return {
    title: outline.title,
    logline: outline.logline,
    language: outline.language,
    location: outline.world.location,
    timeOfDay: outline.world.timeOfDay,
    weather: outline.world.weather,
    mood: outline.mood,
    durationSec: Number(shots.reduce((a, s) => a + s.durationSec, 0).toFixed(2)),
    aspect: opts.aspect ?? "16:9",
    characters,
    styleBible: {
      grade: outline.world.grade,
      refs: outline.world.refs,
      stillModel: STILL_MODEL,
      motionModel: MOTION_MODEL,
    },
    shots,
    ...(audioEvents.length ? { audioEvents } : {}),
    // §13.4：聲音契約——新編譯 sheet 明示 events 模式＋必要事件身份（loader
    // 載入完整性對呢個 gate；零對白一樣寫，空集都係明示契約）。
    soundContract: { mode: "events", expectedDialogueBeats: audioEvents.map((e) => e.beatId) },
    // §12 優先2＋§13.3.2：boards 席採用收據收齊落 sheet——shotIds 係 beatId 指認
    // （阿圖 packet 有 beats，最終 SH 編號呢度映射）：查 beat 涵蓋鏡（beatIds/
    // audioBeats）；指認唔到→自動 adoptionIssue 回責任席，唔靜靜丟失。
    ...((() => {
      const shIdsOfBeat = (beat: string) => shots
        .filter((sh) => (sh.beatIds ?? [sh.beatId]).includes(beat) || (sh.audioBeats ?? []).includes(beat))
        .map((sh) => sh.id);
      const rows = opts.boards.flatMap((b) => b.onImageAdoptions ?? []);
      if (!rows.length) return {};
      const mapped = rows.map((a) => {
        const shotIds = [...new Set(a.shotIds.flatMap((id) => shIdsOfBeat(id)))];
        return { row: { ...a, shotIds }, unmapped: shotIds.length === 0 ? a.shotIds : [] as string[] };
      });
      const extraIssues = mapped
        .filter((m) => m.unmapped.length)
        .map((m) => `onImageAdoption 指認嘅 beat（${m.unmapped.join("、")}）喺 callsheet 搵唔到對應鏡——回 boards 席重新指認`);
      return {
        onImageAdoptions: mapped.map((m) => m.row),
        ...(extraIssues.length ? { adoptionIssues: [...(opts.boards.flatMap((b) => b.adoptionIssues ?? [])), ...extraIssues] } : opts.boards.some((b) => b.adoptionIssues?.length) ? { adoptionIssues: opts.boards.flatMap((b) => b.adoptionIssues ?? []) } : {}),
      };
    })()),
    voiceover: audioEvents.map((e) => e.text).join(" ") || shots.map((s) => s.dialogue).filter(Boolean).join(" "),
    scenes: outline.scenes.map((s) => ({ id: s.id, heading: s.heading, summary: s.summary, targetSec: s.targetSec })),
  };
}

/** Sheet-level gates the per-scene schema cannot see. Throwing here means the
 *  seats have to go again; it never edits the sheet into range. */
export function assertSheetGates(sheet: CallSheet, opts: { script: Script; targetSec: number }): void {
  const sum = sheet.shots.reduce((a, s) => a + s.durationSec, 0);
  const lo = opts.targetSec * (1 - DURATION_TOLERANCE);
  const hi = opts.targetSec * (1 + DURATION_TOLERANCE);
  if (sum < lo || sum > hi) {
    throw new Error(`callsheet runs ${sum.toFixed(1)}s; the slate wants ${opts.targetSec}s (allowed ${lo.toFixed(0)}–${hi.toFixed(0)}s)`);
  }
  const covered = new Set(sheet.shots.flatMap((s) => s.beatIds ?? [s.beatId])); // P1 多對多覆蓋
  for (const scene of opts.script.scenes) {
    for (const beat of scene.beats) {
      if (!covered.has(beat.id)) throw new Error(`beat ${beat.id} has no shot in the callsheet`);
    }
  }
  // DIALOGUE_RULE_PROVENANCE_0927：對白＝聲音事件。全 sheet 度驗（呢度先
  // 睇得到跨場景 audioBeats）：①每句對白至少一鏡「播」（explicit audioBeats
  // 優先，冇人認領先退落 beatIds 覆蓋）；②播出鏡喺 cut order 連續（原始
  // utterance 一條連續 take 切片播放——中間斷開＝兩次播放，唔准）；③事件
  // 窗口（首尾鏡夾埋）夠講（字數估時係初步估算閘，實際音軌時長由 dialogue-bed
  // 回填）。「一句恰好一鏡」繼承閘撤除——先拍講者再拍聽者／跨場景聲橋／一鏡
  // 多句全部合法。
  const carrier = sheet.shots.map((s) => ({ beatIds: s.beatIds ?? (s.beatId ? [s.beatId] : []), audioBeats: s.audioBeats }));
  for (const scene of opts.script.scenes) {
    for (const beat of scene.beats) {
      const line = beat.dialogue?.trim() ?? "";
      if (!line) continue;
      const idx = audioCoverShots(beat.id, carrier);
      if (idx.length === 0) {
        throw new Error(`dialogue beat ${beat.id} has no shot playing it (audioBeats or beat coverage) — 一句對白冇鏡播出`);
      }
      for (let k = 1; k < idx.length; k += 1) {
        if (idx[k] !== idx[k - 1]! + 1) {
          throw new Error(`dialogue beat ${beat.id}'s playing shots are not contiguous in cut order (SH gaps) — 原始 take 係一條連續音軌，斷開播放＝重播`);
        }
      }
      const windowSec = sheet.shots.slice(idx[0]!, idx[idx.length - 1]! + 1).reduce((a, s) => a + s.durationSec, 0);
      const needed = dialogueSeconds(line);
      if (windowSec + 1e-9 < needed) {
        throw new Error(`dialogue beat ${beat.id} spans ${windowSec.toFixed(1)}s of shots but needs ≈${needed.toFixed(1)}s (字數估時) — 跨鏡夾埋都唔夠講，加鏡或者調 audioBeats`);
      }
    }
  }
  const ids = sheet.shots.map((s) => s.id);
  if (new Set(ids).size !== ids.length) throw new Error("duplicate shot ids in the callsheet");
  for (const [i, shot] of sheet.shots.entries()) {
    if (shot.id !== shotId(i + 1)) throw new Error(`shot ${i + 1} is ${shot.id}, cut order wants ${shotId(i + 1)}`);
  }
}
