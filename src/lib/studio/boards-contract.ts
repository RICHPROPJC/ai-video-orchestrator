import { z } from "zod";
import { BEAT_ID_RE, CHARACTER_ID_RE, SCENE_ID_RE, dialogueSeconds, omittable, type Beat } from "./script-contract";
import { isRoomNoun, isSystemDisplayProp, isSystemDisplayScreenForbid, negativePoison } from "./keyframe-prompt";
import { shotSecMax, shotSecMin } from "./frame-grid";

/** Story shot length. H3's shortest legal generate stays shotSecMin(); it does not rewrite the shot. */
export const TEXT_SHOT_SEC_MIN = 1;
/** Shot length bounds come from the H3 grid setting, not a second copy of 5.2/15. */
export const SHOT_SEC_MIN = shotSecMin();
export const SHOT_SEC_MAX = shotSecMax();
const CAST_PER_SHOT_MAX = 3; // 基建：Blender slot L/C/R 三位

/** Each scene is held to its own share of the slate's clock; the shares are
 *  normalised before they get here, so holding every scene holds the film. */
export const SCENE_BUDGET_TOLERANCE = 9; // 0927：budget band 唔再束縛（時鐘係真源），值放到唔約束

/** The b5/b6 narrow-slot vocabularies, exported so the boards desk's pre-send
 *  self-check (padBoardDurations) repairs against the same enums zod gates. */
export const SLOT_VALUES = ["L", "C", "R"] as const;
export const DEPTH_VALUES = ["near", "mid", "far"] as const;
export const STANCE_VALUES = ["stand", "lean", "crouch", "sit"] as const;
// SC-CREATIVE-OS-0927 §2C：sit＝臀部有支撐嘅坐（舊版用 crouch 頂住令坐姿失真）。
// 能力誠實：blockout／pose 語言層對 sit 嘅骨架支持喺 P2 對齊——未支援嘅
// renderer 要明報 capability gap，唔准靜靜降級返 crouch。

const castSchema = z.object({
  characterId: z.string().regex(CHARACTER_ID_RE),
  slot: z.enum(SLOT_VALUES),
  depth: z.enum(DEPTH_VALUES),
  facing: z.union([z.literal(1), z.literal(-1)]),
  gait: z.enum(["plant", "walk", "reach", "turn"]),
  stance: z.enum(STANCE_VALUES),
  stanceEnd: omittable(z.enum(STANCE_VALUES)),
  travelTo: omittable(z.enum(SLOT_VALUES)),
});

const propSchema = z.object({
  name: z.string().min(1).max(20),
  heldBy: omittable(z.string().regex(CHARACTER_ID_RE)),
  shape: z.array(z.string().min(1).max(12)).min(1).max(5),
  forbid: z.array(z.string().min(1).max(12)).max(8),
  publicName: omittable(z.string().min(1).max(24)),
  sizeM: omittable(z.number().positive().max(30)),
  sizeSource: omittable(z.string().min(1)),
  proportion: omittable(z.object({
    of: z.string().regex(CHARACTER_ID_RE),
    at: z.enum(["knee", "waist", "chest", "shoulder"]),
    source: z.string().min(1),
  })),
}).refine((p) => p.sizeM == null || Boolean(p.sizeSource?.trim()), {
  message: "sizeM 要連 sizeSource 一齊寫，唔准估",
  path: ["sizeSource"],
}).refine((p) => !isSystemDisplayProp(p.name) || !p.forbid.some(isSystemDisplayScreenForbid), {
  // §0c law46（#27 boards 端豁免）：光框本身就係螢幕——screen/螢幕 入 system
  // prop 嘅 forbid＝禁詞殺自己人（WR1Q SH02）；非 system 禁 screen 照舊合法。
  message: "光框／全息／infograph 嘅 forbid 唔可以有 screen／螢幕 — 光框本身就係螢幕（FLOW_LAW §0c）",
  path: ["forbid"],
});

/** Card D 0919: an on-screen fact row. Packet-authored — 阿圖 may pre-author,
 *  the search-first PE step writes wigolo evidence here; code only assembles. */
const factSchema = z.object({
  claim: z.string().min(1),
  source: z.string().min(1),
  fetched_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "fetched_at 要 YYYY-MM-DD"),
});

const boardShotShape = z.object({
  /** §14.4d：場內自編鏡鍵（唯一，短）——onImageAdoptions.shotIds 用佢指認
   *  精確一鏡（beatId 指認＝組覆蓋會放大意圖）；同一句前半講者後半聽者
   *  =兩條 adoption 各指唔同 localKey。 */
  localKey: z.string().min(1).max(12).optional(),
  beatId: z.string().regex(BEAT_ID_RE),
  /** SC-CREATIVE-OS-0927 P1：一鏡可覆蓋多個 beat（多對多）。beatId 保留做
   *  primary（舊消費者照讀）；覆蓋閘同對白歸屬改食 beatIds ?? [beatId]。
   *  呢個係「一動詞一鏡」碎切結構嘅 schema 鬆綁，唔係新模板。 */
  beatIds: omittable(z.array(z.string().regex(BEAT_ID_RE)).min(1).max(6)),
  size: z.enum(["wide", "full", "medium", "closeup", "insert"]),
  angle: z.enum(["eye", "high", "low"]),
  side: z.enum(["frontal", "leftQuarter", "rightQuarter"]),
  durationSec: z.number().min(TEXT_SHOT_SEC_MIN).max(SHOT_SEC_MAX),
  // §19：撤 200 字硬拒（非空保留；總輸出資源由 aggregate token 層承接）
  action: z.string().min(1),
  dialogue: z.string().nullish().transform((v) => v ?? ""),
  speaker: omittable(z.string().min(1).max(12)),
  // SC-CREATIVE-OS-0927 §2C：產品／環境鏡合法（空 cast）。下游 blockout
  // figure gate 對空 marks 轉驗主體剪影（blockout.ts 同步），唔准偷塞人。
  cast: z.array(castSchema).min(0).max(CAST_PER_SHOT_MAX),
  props: omittable(z.array(propSchema).max(3)),
  /** DIALOGUE_RULE_PROVENANCE_0927：本鏡「播出」嘅對白 beat id（可跨場景
   *  聲橋）。聲音關聯，唔係畫面包含：speaker 唔使喺 cast；一句可由多鏡分段
   *  播（先拍講者再拍聽者）；一鏡可多句或零句。跨場景引用對全 script beat 集
   *  驗（ctx.scriptBeatIds）；覆蓋總閘（每句對白至少一鏡播、事件窗口夠講）
   *  喺 boards-expand assertSheetGates——嗰度先睇得到全場。 */
  audioBeats: omittable(z.array(z.string().regex(BEAT_ID_RE)).min(1).max(6)),
  /** 環境動畫通道（世界暫停前後動作）：時鐘指針／窗光影條／盒疊——幾何
   *  keyframe，blockout 灰模照 render（FLAT 下光源變化唔可見，所以淨收
   *  幾何通道）。keys 相對本鏡開頭 frame。有需要先寫。 */
  envAnim: omittable(z.array(z.object({
    object: z.enum(["clock_hand", "window_bar", "stack_box"]),
    channel: z.enum(["rotate_z", "pos_z", "scale_z"]),
    keys: z.array(z.tuple([z.number().min(0), z.number()])).min(2).max(48),
    interp: omittable(z.enum(["step", "linear"])),
    note: omittable(z.string().max(80)),
  })).max(4)),
  /** T32 rev2: per-shot scene slot the boards seat authors — location (and
   *  optionally its own light angle) the stills prompt must follow. Chau 17:48:
   *  negatives 阿圖按道具/場景類別填；毒詞（霓虹/neon/night）連 negative 都落閘。
   *  T32b C5（Chau 22:24）：location 要係 2–8 字場所名詞，機構全名歸 heading。
   *  Card D（MERGE_THREE union）：facts 同 factsRequired 同呢個 slot 一齊載
   *  （文字圖冇 facts 唔准出）；location 讀填——facts-only require 係合法形。 */
  require: omittable(
    z.object({
      location: omittable(z.string().min(1).max(60)), // 0927：場所名長短由內容定
      angle: omittable(z.enum(["eye", "high", "low"])),
      negatives: omittable(z.array(z.string().min(1).max(12)).min(1).max(6)),
      facts: omittable(z.array(factSchema).min(1).max(8)),
      factsRequired: omittable(z.boolean()),
    })
      .refine((req) => req.location === undefined || isRoomNoun(req.location), {
        message: "location 要係鏡頭所見場所（1–60 短標籤）；宮殿/學校/政府場景合法——機構牌名歸 heading，空間關係交 action/scene",
        path: ["location"],
      })
      .refine((req) => !negativePoison(req.negatives ?? []), {
        message: "negatives 唔可以有霓虹/neon/night — 負面詞毒畫面（T29 法）",
        path: ["negatives"],
      }),
  ),
});

const boardsSceneShape = z.object({
  sceneId: z.string().regex(SCENE_ID_RE),
  thinking: z.string().min(1).max(400),
  shots: z.array(boardShotShape).min(1),
  /** §12 優先2：聲畫採用判斷（生成前計劃語義）——導演 dialoguePlacements/
   *  onImage 點喺本場畫面落地。每條：placement 指認→落鏡→安排＋理由；
   *  矛盾/未能安排列 adoptionIssues（行同一有界修訂鏈）。講者唔使上鏡、一句
   *  跨鏡、一鏡多句合法；詞命中（onImageCheck）只係診斷唔代替呢度判斷。 */
  onImageAdoptions: z.array(z.object({
    // §19：撤欄位長 cap——完整來源原句唔可截斷或因長拒收（資源由 aggregate token 層承接）
    placement: z.string().min(1),
    /** §15.3：occurrence 身份——dialoguePlacements 嘅索引（顯示 word 可以
     *  撞；同句兩個 placement 各有 idx）。packet 會帶 idx。 */
    placementIdx: z.number().int().min(0),
    shotIds: z.array(z.string()).min(1),
    plan: z.string().min(1),
    reason: z.string().min(1),
  })).optional(),
  adoptionIssues: z.array(z.string().min(1)).optional(),
});

export type BoardShot = z.infer<typeof boardShotShape>;
export type BoardsScene = z.infer<typeof boardsSceneShape>;

export function boardsSceneSchema(ctx: {
  sceneId: string;
  beats: Beat[];
  characters: { id: string; name: string }[];
  budgetSec: number;
  /** DIALOGUE_RULE_PROVENANCE_0927：全 script 嘅 beat id 集——audioBeats 跨
   *  場景引用（聲橋）對呢個集驗。seat-boards callsite 傳；冇佢而又出現跨
   *  場景 audioBeats 就報驗唔到（fail-loud，唔靜靜放行）。 */
  scriptBeatIds?: string[];
  /** §13.3.1：導演聲畫採用意圖（directorSkeleton.dialoguePlacements）——
   *  有意圖嘅 callsheet，boards 必須交採用結果（onImageAdoptions 或
   *  adoptionIssues 任一）；冇意圖嘅流程合法 N/A 唔強制填表。 */
  dialoguePlacements?: { word: string; idx: number; startSec?: number; endSec?: number }[];
}) {
  const byBeat = new Map(ctx.beats.map((b) => [b.id, b]));
  const cast = new Set(ctx.characters.map((c) => c.id));
  return boardsSceneShape.superRefine((scene, report) => {
    // §13.3.1＋§14.4a＋§15.3：採用 coverage 逐 occurrence——身份＝placementIdx
    // （word 淨顯示）；每條本場相關 occurrence 要有對應 placementIdx 嘅採用，
    // 或 issue 具名 `word#idx`；已交集合以外嘅未知 idx 引用拒收。
    if ((ctx.dialoguePlacements?.length ?? 0) > 0) {
      // §16.2：成對身份 (placementIdx, word)——單欄啱唔當採用成功；issue 指認
      // 用精確 token（word#idx 後面唔可以再係數字——#1 唔可以俾 #10 誤認）。
      const needOf = new Map(ctx.dialoguePlacements!.map((p) => [p.idx, p.word]));
      const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      for (const a of scene.onImageAdoptions ?? []) {
        const want = needOf.get(a.placementIdx);
        if (want === undefined) {
          report.addIssue({ code: "custom", path: ["onImageAdoptions"], message: `placementIdx=${a.placementIdx} 唔喺本場相關 placement 集（packet 清單以外）——未知引用拒收` });
        } else if (want !== a.placement) {
          report.addIssue({ code: "custom", path: ["onImageAdoptions"], message: `placementIdx=${a.placementIdx} 對應 placement 係「${want}」，但條目寫「${a.placement}」——成對身份（idx＋word）唔夾，拒收` });
        }
      }
      const adoptedPair = new Set((scene.onImageAdoptions ?? []).filter((a) => needOf.get(a.placementIdx) === a.placement).map((a) => `${a.placement}#${a.placementIdx}`));
      for (const need of ctx.dialoguePlacements!) {
        // §17.2：issue 指認＝來源 word escaped 嘅確切 token（word#idx 後面唔係
        // 數字）——含空格全句 word 用 regex 全句 match（「I feel cold#2」淨擷
        // 「cold#2」嘅 substring 近視收咗）。
        const token = new RegExp(`${esc(need.word)}#${need.idx}(?!\\d)`);
        const named = (scene.adoptionIssues ?? []).some((i) => token.test(i));
        if (!adoptedPair.has(`${need.word}#${need.idx}`) && !named) {
          report.addIssue({ code: "custom", path: ["onImageAdoptions"], message: `placement「${need.word}#${need.idx}」冇採用結果——onImageAdoptions 要有一條 placementIdx=${need.idx}＋placement 逐字「${need.word}」，或 adoptionIssues 具名 token「${need.word}#${need.idx}」未解` });
        }
      }
    }
    // §14.4d：localKey 場內唯一（重複＝指認含糊，拒收）
    {
      const seen = new Map<string, number>();
      for (const sh of scene.shots) if (sh.localKey) seen.set(sh.localKey, (seen.get(sh.localKey) ?? 0) + 1);
      for (const [k, n] of seen) if (n > 1) {
        report.addIssue({ code: "custom", path: ["shots"], message: `localKey「${k}」場內重複出現 ${n} 次——鏡鍵要唯一先可以俾採用記錄精確指認` });
      }
    }
    if (scene.sceneId !== ctx.sceneId) {
      report.addIssue({ code: "custom", path: ["sceneId"], message: `this envelope is scene ${ctx.sceneId}, not ${scene.sceneId}` });
    }
    for (const [i, shot] of scene.shots.entries()) {
      const at = (...path: (string | number)[]) => ["shots", i, ...path];
      const beat = byBeat.get(shot.beatId);
      if (!beat) {
        report.addIssue({ code: "custom", path: at("beatId"), message: `beat ${shot.beatId} is not in scene ${ctx.sceneId}` });
        continue;
      }
      // P1 多對多：beatIds 每個成員都要喺本場（beatId primary 已驗上面）
      for (const [bi, extra] of (shot.beatIds ?? []).entries()) {
        if (!byBeat.has(extra)) {
          report.addIssue({ code: "custom", path: at("beatIds", bi), message: `beat ${extra} is not in scene ${ctx.sceneId}` });
        }
      }
      // DIALOGUE_RULE_PROVENANCE_0927：audioBeats＝聲音關聯，可指其他場嘅
      // beat（跨場景聲橋）。本場嘅直接驗；跨場嘅對 scriptBeatIds 驗。呢度
      // 唔驗「一句一鏡」——對白覆蓋總閘（每句至少一鏡播、事件窗口夠講）喺
      // boards-expand assertSheetGates 全 sheet 度先驗得到。同場對白歸屬
      // （邊鏡播邊句）由組裝層衍生，seat 唔使再逐字抄對白入鏡。
      for (const [ai, ref] of (shot.audioBeats ?? []).entries()) {
        if (byBeat.has(ref)) continue;
        if (ctx.scriptBeatIds) {
          if (!ctx.scriptBeatIds.includes(ref)) {
            report.addIssue({ code: "custom", path: at("audioBeats", ai), message: `audio beat ${ref} is not a beat of this script` });
          }
        } else {
          report.addIssue({ code: "custom", path: at("audioBeats", ai), message: `audio beat ${ref} is outside scene ${ctx.sceneId} and no scriptBeatIds to verify it against` });
        }
      }
      const seats = new Set<string>();
      for (const [j, member] of shot.cast.entries()) {
        if (!cast.has(member.characterId)) {
          report.addIssue({ code: "custom", path: at("cast", j, "characterId"), message: `${member.characterId} is not a character of this script` });
        }
        const seatKey = `${member.slot}/${member.depth}`;
        if (seats.has(seatKey)) {
          report.addIssue({ code: "custom", path: at("cast", j, "slot"), message: `two figures cannot share slot ${seatKey} in one shot` });
        }
        seats.add(seatKey);
      }
      const ids = new Set(shot.cast.map((c) => c.characterId));
      if (ids.size !== shot.cast.length) {
        report.addIssue({ code: "custom", path: at("cast"), message: "the same character is cast twice in one shot" });
      }
      for (const [j, prop] of (shot.props ?? []).entries()) {
        if (prop.heldBy && !ids.has(prop.heldBy)) {
          report.addIssue({ code: "custom", path: at("props", j, "heldBy"), message: `${prop.heldBy} is not cast in this shot, so cannot hold ${prop.name}` });
        }
      }
    }
    const runtime = scene.shots.reduce((a, s) => a + s.durationSec, 0);
    const lo = ctx.budgetSec * (1 - SCENE_BUDGET_TOLERANCE);
    const hi = ctx.budgetSec * (1 + SCENE_BUDGET_TOLERANCE);
    if (runtime > hi) {
      report.addIssue({
        code: "custom",
        path: ["shots"],
        message: `this scene must run ${lo.toFixed(1)}–${hi.toFixed(1)}s (budget ${ctx.budgetSec.toFixed(1)}s); your shots add up to ${runtime.toFixed(1)}s`,
      });
    }
    for (const beat of ctx.beats) {
      if (!scene.shots.some((s) => s.beatId === beat.id || (s.beatIds ?? []).includes(beat.id))) {
        report.addIssue({ code: "custom", path: ["shots"], message: `beat ${beat.id} has no shot covering it` });
      }
      // DIALOGUE_RULE_PROVENANCE_0927 拆閘：對白 beat 只要求「有鏡畫到佢」
      // （上面嗰條）＋「有鏡播佢」（assertSheetGates 全 sheet 度驗，呢度睇
      // 唇到其他場嘅 audioBeats）。「一句恰好一鏡」繼承閘由 root 裁決撤除。
    }
  });
}
