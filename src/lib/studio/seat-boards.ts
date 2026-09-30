import crypto from "node:crypto";
import path from "node:path";
import type { BoardLane } from "./asset-board";
import { renderBoards, type BoardsVisualOptions } from "./boards-visual";
import { loadConfig } from "./config";
import { chatJsonSeat, type RepairNote } from "./crew-llm";
import { BOARDS_CHARTER } from "./seat-charters";
import { markPass } from "./playbook";
import { boardsSceneSchema, TEXT_SHOT_SEC_MIN, SCENE_BUDGET_TOLERANCE, SLOT_VALUES, DEPTH_VALUES, STANCE_VALUES, type BoardsScene } from "./boards-contract";
import { assertSheetGates, expandBoards } from "./boards-expand";
import { type Script } from "./script-contract";
import type { CallSheet } from "./types";
import type { SeatIo } from "./seat-writer";

/** §23 watch-場窗：本場相關 placements 計一次，packet 與 validator 同用（純
 *  helper；idx 仍為全片來源 idx 保跨場聲橋；±1s 政策不變——最終 cut-clock
 *  對齊留既定驗收）。 */
function sceneRelevantPlacements(
  all: { word: string; startSec?: number; endSec?: number }[] | undefined,
  outline: { id: string; targetSec: number }[],
  sceneId: string,
): { word: string; idx: number; startSec?: number; endSec?: number }[] {
  const i = outline.findIndex((sc) => sc.id === sceneId);
  if (i < 0) return [];
  const start = outline.slice(0, i).reduce((a, sc) => a + sc.targetSec, 0);
  const end = start + (outline[i]?.targetSec ?? 0);
  // 統籌裁決 0930（y8kh-r7-empty-motion-ruling）：相關＝placement 區間同
  // 該場 outline 區間**真重疊**——去掉 ±1 秒墊（墊把鄰居場拉入「相關」，
  // 鄰居寫「唔喺我場」→adoptionIssues→world.ts block 全鏡→stills 剔空→
  // motion 零鏡）。碰邊唔算下一場。
  return (all ?? [])
    .map((p, idx) => ({ word: p.word, idx, startSec: p.startSec, endSec: p.endSec }))
    .filter((p) => (p.endSec ?? 0) > start && (p.startSec ?? 0) < end);
}


/** §25 A：sheetRepairUsed＝本 run 實際用咗幾輪修訂（caller 併入持久 episode） */
export type BoardsResult = { sheet: CallSheet; model: string; receipts: string[]; sheetRepairUsed?: number };

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
/** ROOT 0b7a60a 收口裁定：callsheet 時長差集 typed gap——兩 throw 位（耗盡
 *  scene-overflow／無單場爆 film-allocation）同源結構化，authorStage 消費
 *  寫 durationGaps 行真正創作修訂輪（唔以類別字串冒充分類決策）。 */
export class CallsheetRuntimeGap extends Error {
  constructor(
    message: string,
    public readonly gap: {
      kind: "scene-overflow" | "film-allocation";
      targetSec: number; declared: number; actual: number;
      scenes: { sceneId: string; actual: number; budget: number; delta: number }[];
      quota: { used: number; max: number };
    },
  ) {
    super(message);
    this.name = "CallsheetRuntimeGap";
  }
}

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
    // DIALOGUE_RULE_PROVENANCE_0927：對白時鐘唔再抬單鏡——一句可跨鏡播，
    // 夠唔夠講係「播佢嗰排鏡」夾埋嘅事（assertSheetGates 窗口閘）。
    // ROOT 0929 接續令差1（supersede 舊 floor 抬升）：H3 最短生成長度係
    // 生成契約（h3-submit pad 生成窗，cut_plan 照 callsheet 剪返），唔由
    // 呢度反向抬故事時鐘——亞秒鏡照模型原值過 schema，低於舊 floor 淨記 note。
    if (durationSec < TEXT_SHOT_SEC_MIN) {
      repair(`repair: shots[${i}].durationSec saw ${durationSec} (< H3 生成floor ${TEXT_SHOT_SEC_MIN}——生成窗 pad 喺 submit 契約，故事時鐘照原值)`);
    }
    return { ...shot, cast, props, durationSec };
  });
  if (typeof budgetSec === "number" && budgetSec > 0) {
    const hi = budgetSec * (1 + SCENE_BUDGET_TOLERANCE);
    const sum = shots.reduce((a, s) => a + (s.durationSec as number), 0);
    // §25 B（0928）：撤「為貼 band 從尾鏡 while 機械扣秒」——程式只做不改語義
    // 的格式處理，改時間＝改故事節奏，返責任席（場閘超 band 拒收→gap-retry
    // 教學）。呢度淨留超額警報收據，唔郁任何 durationSec。
    if (sum > hi) {
      repair(`repair: scene sum ${sum.toFixed(1)}s 超 band 上限 ${hi.toFixed(1)}s（budget ${budgetSec.toFixed(1)}s）——唔機械扣秒，交場閘拒收觸發修訂`);
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
/** SC-CREATIVE-OS-0927：導演方案時間軸（rhythmMap 節奏句＋shots 時間/目的/
 *  對白落點＋手物狀態）——boards 開鏡跟導演節奏，唔再只收 writer 動詞。
 *  skeleton 係參考契約（鏡數/秒數由 boards 按本場實際 beats 落），唔係硬表。 */
export type DirectorSkeleton = {
  vision?: string;
  beats?: { beatId: string; label?: string; job?: string; rhythm?: string; deletionLoss?: string }[];
  shots?: { shotId: string; startSec?: number; endSec?: number; purpose?: string; audienceEye?: string; cutReason?: string; dialogue?: string; frame?: string }[];
  dialoguePlacements?: { word: string; startSec?: number; endSec?: number; onImage?: string }[];
};

/** §25 A（0928）：sheet 時長責任修訂額度——attempts 由 caller（author）讀 job
 *  持久 episode 傳入；onAttempt 每輪回報令 caller 即刻 patch job（resume／換
 *  模型唔各自刷新額度）。max 上限由 caller 定（裁決：首輪候選後最多兩輪）。 */
type BoardsOptions = { script: Script; targetSec: number; aspect?: CallSheet["aspect"]; writer: { model: string; receipts: string[] }; draftOnly?: boolean; directorSkeleton?: DirectorSkeleton; sheetRepair?: { attempts: number; max: number; onAttempt?: (attempts: number) => void }; utterances?: { utteranceId: string; rawText: string; speakerId?: string; unresolvedSpeaker?: string }[] };
type BoardsIo = SeatIo & { boardLane?: BoardLane; boardsDir?: string };
export function runBoards(opts: { render: BoardsVisualOptions }): ReturnType<typeof renderBoards>;
export function runBoards(opts: BoardsOptions, io: BoardsIo): Promise<BoardsResult>;

export async function runBoards(
  opts: BoardsOptions | { render: BoardsVisualOptions },
  io?: BoardsIo,
): Promise<BoardsResult | Awaited<ReturnType<typeof renderBoards>>> {
  if ("render" in opts) return renderBoards(opts.render);
  if (!io) throw new Error("boards: seat IO required");
  const { script } = opts;
  const characters = script.outline.characters.map((c) => ({ id: c.id, name: c.name }));
  const receipts: string[] = [];
  // 知識已內嵌 BOARDS_CHARTER（照官方 ViMax：agent prompt 一段）。
  receipts.push("playbook: 停止拼入 system（0927）");
  const boards: BoardsScene[] = [];
  let carried: Handoff = {};
  // Locked scene seconds are the clock. The form number is not applied again.
  const declared = script.outline.scenes.reduce((a, s) => a + s.targetSec, 0) || 1;
  const budget = (sec: number) => sec;

  // §25 A（0928）：逐場生成抽可重入 helper——sheet 時長修訂迴路對爆場帶具名
  // gap 重入（同一 chatJsonSeat 接線，hint 唔同）；handoff 鏈重行由 caller 段負責。
  const runScene = async (
    scene: Script["outline"]["scenes"][number],
    handoff: Handoff,
    hint?: string,
  ): Promise<{ value: BoardsScene; receipts: string[] }> => {
    const beats = script.scenes.find((s) => s.sceneId === scene.id)?.beats ?? [];
    const budgetSec = budget(scene.targetSec);
    const pass = await chatJsonSeat({
      seat: "boards",
      unit: scene.id,
      fallbackModel: io.crew.secondFallback,
      onAttempt: io.warn && ((r: { attempt: number; valid: boolean; errors: string[] }) => {
        if (!r.valid) void io.warn?.(`boards ${scene.id} attempt ${r.attempt} ✗ ${r.errors[0] ?? ""}`);
      }),
      model: io.model,
      crew: io.crew,
      system: BOARDS_CHARTER,
      user: JSON.stringify({
        scene: { ...scene, targetSec: Number(budgetSec.toFixed(1)) },
        budgetSec: Number(budgetSec.toFixed(1)),
        beats,
        // 導演節奏契約：呢場對應嘅導演拍（按時間重疊揀）＋鏡目的＋逐字對白落點。
        // 開鏡跟呢個節奏（幾多鏡、每鏡做咩、點剪）；鏡數唔係硬表，係節奏參考。
        ...(opts.directorSkeleton ? { directorSkeleton: {
            vision: opts.directorSkeleton.vision,
            beats: opts.directorSkeleton.beats ?? [],
            shots: (opts.directorSkeleton.shots ?? []).filter((sh) =>
              sh.startSec !== undefined && sh.endSec !== undefined),
            dialoguePlacements: sceneRelevantPlacements(opts.directorSkeleton.dialoguePlacements, script.outline.scenes, scene.id),
          } } : {}),
        characters: script.outline.characters.map((c) => ({
          id: c.id,
          name: c.name,
          role: c.role,
          heightM: c.heightM,
          speaks: c.speaks,
        })),
        previousSceneHandoff: handoff,
        ...(hint ? { 修訂要求: hint } : {}),
      }),
      schema: boardsSceneSchema({ sceneId: scene.id, beats, characters, budgetSec, scriptBeatIds: script.scenes.flatMap((sc) => sc.beats.map((b) => b.id)), dialoguePlacements: sceneRelevantPlacements(opts.directorSkeleton?.dialoguePlacements, script.outline.scenes, scene.id) }),
      normalize: (raw, note) => padBoardDurations(raw, budgetSec, note),
      receiptDir: io.receiptDir,
      fetchImpl: io.fetchImpl,
    });
    return { value: pass.value, receipts: pass.receipts };
  };

  // ROOT 0929 接續令差3：每場入場前 carried 快照——repair 重跑要用「該場採納
  // predecessor」狀態（最終 carried 係後場狀態，做前場先情＝連戲穿越）。
  const carriedBefore = new Map<string, Handoff>();
  for (const [i, scene] of script.outline.scenes.entries()) {
    // qwen on litellm sometimes returns an empty JSON object if the prior scene
    // call finished milliseconds ago; a short gap avoids that race.
    if (i > 0 && !io.fetchImpl) await new Promise((r) => setTimeout(r, 5000));
    carriedBefore.set(scene.id, carried);
    const pass = await runScene(scene, carried);
    receipts.push(...pass.receipts);
    boards.push(pass.value);
    carried = handoffFrom(pass.value, carried);
    await io.speak?.(pass.value.thinking);
    io.index?.({ id: `boards:${scene.id}`, text: pass.value.shots.map((s) => s.action).join(" ") });
  }

  // §25 A＋B（0928）：callsheet 閘基準＝brief 硬時長（opts.targetSec 用戶目標）；
  // ROOT 0b7a60a 收口裁定：時長差集 typed gap（class 喺檔尾 export）。
  // outline 分配合計（declared）具名分開傳入——唔靜靜用聲明合計替換用戶目標
  //（BOUP 實證：brief 26s vs outline 26.33s 兩個數冇人分開報）。
  // 時長爆／不足唔係淨 throw：同一 evaluator 計爆場差額→帶具名 gap 返 boards
  // 修訂（有界，episode 由 caller 持久化）；耗盡先具名 throw 阻下游。
  const buildSheet = () => {
    const expanded = expandBoards({ script, boards, targetSec: opts.targetSec, aspect: opts.aspect, ...(opts.utterances?.length ? { utterances: opts.utterances } : {}) });
    assertSheetGates(expanded, { script, targetSec: opts.targetSec, declaredOutlineSec: declared });
    return expanded;
  };
  let sheetRepairUsed = 0;
  let expanded: ReturnType<typeof expandBoards>;
  for (;;) {
    try {
      expanded = buildSheet();
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.startsWith("callsheet runs")) throw error;
      const repair = opts.sheetRepair;
      const already = repair ? repair.attempts + sheetRepairUsed : 0;
      if (!repair || already >= repair.max) {
        // 耗盡：保存候選（receipts／boards 落盤照舊）＋typed gap 阻下游——
        // ROOT 0b7a60a：結構化（actual/target、各場差額、quota）交 authorStage
        // 真 consumer（durationGaps→導演修訂輪），唔以字串冒充。
        const overflows = sceneOverflows();
        throw new CallsheetRuntimeGap(
          `callsheet_runtime_unclosed: ${message}；爆場＝${overflows.map((o) => `${o.sceneId} ${o.actual.toFixed(1)}s/budget ${o.budget.toFixed(1)}s`).join("、")}——修訂額度已用 ${already} 輪（候選已存 receipts）`,
          {
            kind: "scene-overflow",
            targetSec: opts.targetSec ?? 0,
            declared,
            actual: boards.reduce((a, b) => a + b.shots.reduce((x, s) => x + s.durationSec, 0), 0),
            scenes: overflows.map((o) => ({ sceneId: o.sceneId, actual: o.actual, budget: o.budget, delta: o.actual - o.budget })),
            quota: { used: already, max: repair?.max ?? 0 },
          },
        );
      }
      const overflows = sceneOverflows();
      // ROOT 0b7a60a：冇單場超 band 都爆 sheet＝全片分配問題（不足/分配不一
      // 致）——同源 typed gap（film-allocation），唔裸 throw。
      if (!overflows.length) {
        throw new CallsheetRuntimeGap(
          `callsheet_runtime_unclosed: ${message}（冇單場爆 band——全片分配/可演性問題，返導演重分場秒數）`,
          {
            kind: "film-allocation",
            targetSec: opts.targetSec ?? 0,
            declared,
            actual: boards.reduce((a, b) => a + b.shots.reduce((x, s) => x + s.durationSec, 0), 0),
            scenes: [],
            quota: { used: repair ? repair.attempts + sheetRepairUsed : 0, max: repair?.max ?? 0 },
          },
        );
      }
      sheetRepairUsed += 1;
      repair.onAttempt?.(repair.attempts + sheetRepairUsed);
      for (const o of overflows) {
        const scene = script.outline.scenes.find((s) => s.id === o.sceneId);
        if (!scene) continue;
        // ROOT 0929 接續令差3：repair 用該場採納 predecessor（carriedBefore 快照）
        // ——最終 carried 係掃完全場後嘅後場狀態，攞佢返修前場＝先情穿越。
        const before = carriedBefore.get(o.sceneId) ?? carried;
        const pass = await runScene(scene, before, `【時長修訂】本場鏡合計 ${o.actual.toFixed(1)}s 對場 budget ${o.budget.toFixed(1)}s 超 ${(o.actual - o.budget).toFixed(1)}s（全片 callsheet 同時超 brief 硬時長）——合鏡／多 beat 同鏡／壓縮內容返 band 內；唔准刪台詞／接觸事件／用戶硬要求；若 budget 唔夠實現採納內容，喺 adoptionIssues 具名講明要返導演重分場，唔可以靜靜剪剩。`);
        receipts.push(...pass.receipts);
        const at = boards.findIndex((b) => b.sceneId === o.sceneId);
        if (at >= 0) boards[at] = pass.value;
        await io.speak?.(pass.value.thinking);
        io.index?.({ id: `boards:${o.sceneId}`, text: pass.value.shots.map((s) => s.action).join(" ") });
        // 連戲重算（差3後半）：修訂場 handoff 變動先重跑下游依賴場——用重算
        // predecessor 鏈式對齊；依賴冇變（handoff 等價）即止，唔無差別重生成。
        let chainCarried = handoffFrom(pass.value, before);
        for (let d = at + 1; d < boards.length; d += 1) {
          const dSceneId = boards[d]!.sceneId;
          const dScene = script.outline.scenes.find((s) => s.id === dSceneId);
          const dBefore = carriedBefore.get(dSceneId);
          if (!dScene || !dBefore) break;
          const unchanged = JSON.stringify(dBefore) === JSON.stringify(chainCarried);
          carriedBefore.set(dSceneId, chainCarried);
          if (unchanged) break;
          const dPass = await runScene(dScene, chainCarried, `【連戲重算】前場 ${o.sceneId} 時長修訂令 handoff 狀態變動——本場按新 predecessor 狀態重行（企位/持有接續要對得返）。`);
          receipts.push(...dPass.receipts);
          boards[d] = dPass.value;
          await io.speak?.(dPass.value.thinking);
          io.index?.({ id: `boards:${dSceneId}`, text: dPass.value.shots.map((s) => s.action).join(" ") });
          chainCarried = handoffFrom(dPass.value, chainCarried);
        }
      }
    }
  }
  function sceneOverflows(): { sceneId: string; actual: number; budget: number }[] {
    return boards.map((b) => ({
      sceneId: b.sceneId,
      actual: b.shots.reduce((a, s) => a + s.durationSec, 0),
      budget: script.outline.scenes.find((sc) => sc.id === b.sceneId)?.targetSec ?? 0,
    })).filter((o) => o.actual > o.budget * (1 + SCENE_BUDGET_TOLERANCE) + 1e-6);
  }
  if (!opts.draftOnly) {
    receipts.push(...markPass(["boards", "global"], io.playbookDir, io.drama));
  }
  const sheet: CallSheet = {
    ...expanded,
    provenance: {
      writer: { model: opts.writer.model, receipts: opts.writer.receipts },
      boards: { model: io.model, receipts },
      sha256: sheetDigest(expanded),
    },
  };
  return { sheet, model: io.model, receipts, ...(sheetRepairUsed ? { sheetRepairUsed } : {}) };
}
