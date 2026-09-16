import { z } from "zod";
import { omittable } from "./script-contract";
import type { CallSheet, Shot } from "./types";
import type { QcRequire } from "./photo-qc";

/** A prop's noun class decides its prompt template and its QC gate. Classes
 *  are generic vocabulary only — sheet proper names never appear here (the
 *  noun-lint holds that line). Noun-class preservation: a garment is prompted
 *  as clothing, a flat paper document as a document, only a held tool gets
 *  the one-tool farm sentence. A document is not a held farm tool. */
export type PropNounClass = "garment" | "document" | "tool";

const GARMENT_RE = /外套|大衣|衫|衣|coat|jacket|cloak|robe/i;
/** flat paper/board things carried, shown or read — never swung like a tool */
const DOCUMENT_RE =
  /令|詔|旨|敕|書|信|箋|函|卷|軸|圖|紙|契|券|符|帖|牒|表|冊|decree|edict|letter|scroll|document|paper|map|warrant|pardon|deed|pass\b/i;

export function propNounClass(name: string): PropNounClass {
  if (GARMENT_RE.test(name)) return "garment";
  if (DOCUMENT_RE.test(name)) return "document";
  return "tool";
}

/** T32 scene slot. The sheet tail (`sheet.location, timeOfDay, weather`) is the
 * whole slate's weather, not this shot's — an indoor shot stamped with the
 * sheet's night/neon tokens renders as a street (negative-token poisoning).
 * Outdoor markers are tested FIRST: 室外／野外 themselves contain 室／野,
 * which the indoor RE alone would misread as a closed set. Unknown ⇒ outdoor:
 * the sheet tail is the pre-T32 behaviour, so an unrecognised location keeps
 * today's prompt, never a guessed indoor line. Generic set vocabulary only. */
const OUTDOOR_RE = /戶外|室外|野外|露天|街|大道|跑道|廣場|岸|橋|門口|崗/;
const INDOOR_RE = /室|房|廳|宿舍|禮堂|館|公寓|中心|停屍間/;

export function isIndoorLocation(location: string): boolean {
  if (OUTDOOR_RE.test(location)) return false;
  return INDOOR_RE.test(location);
}

/** T32 rev2: photo-qc fail_reasons that mean "wrong place" — the pipeline
 * returns these to 阿圖 to rewrite the scene slot, not to a prompt patch. */
export function isLocationFail(failReasons: string[]): boolean {
  return failReasons.some((r) => /location/i.test(r));
}

/** Chau 17:48 law: negatives are 阿圖-packet data, never a code template —
 * but the de-poison rule survives authorship moving seats: a negative naming
 * the very token that poisoned T29 re-plants it. Returns the offending item. */
const NEG_POISON_RE = /霓虹|neon|night/i;
export function negativePoison(negatives: string[]): string | null {
  return negatives.find((n) => NEG_POISON_RE.test(n)) ?? null;
}

/** Chau 22:24 / T32b C5: require.location is what the CAMERA SEES — a 2–8
 * character room noun (地下室、宿舍、走廊). Institutional full names are the
 * heading's牌, never the scene slot. 泛用機構詞，唔係故事名。 */
const INSTITUTION_RE = /府|宮|殿|軍|校|部|局|署|國|總統|政府/;
export function isRoomNoun(location: string): boolean {
  const loc = location.trim();
  return loc.length >= 2 && loc.length <= 8 && !INSTITUTION_RE.test(loc);
}

/** Fable 00:20 U1.5=A: the /edit brief is 150–300 中文字 — a six-line
 * telegram is refuse-to-emit, not "written clearly". CJK count only. */
export function cjkCount(text: string): number {
  return (text.match(/[一-鿿]/g) ?? []).length;
}
export const EDIT_MIN_CJK = 150;

/** T32b 裁3: 阿圖 answers in BOARDS_CHARTER shape ({sceneId,thinking,shots}),
 * not in this lane's shape — map the first require-bearing shot onto the
 * top-level scene slot instead of judging it junk. */
export function sceneRetryNormalize(raw: unknown, note: (line: string) => void): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.shots)) return raw;
  const hit = (obj.shots as Record<string, unknown>[]).find((s) => s && typeof s === "object" && s.require && typeof s.require === "object");
  if (!hit) return raw;
  const req = hit.require as Record<string, unknown>;
  note("repair: charter 形 {shots[].require} map 落頂層 scene slot");
  return {
    thinking: typeof obj.thinking === "string" ? obj.thinking : "charter-shaped reply",
    location: req.location,
    ...(req.angle !== undefined ? { angle: req.angle } : {}),
    ...(Array.isArray(req.negatives) ? { negatives: req.negatives } : {}),
  };
}

/** T32 rev2 scene slot: the boards packet's require.location writes the scene
 * sentence (阿圖 authorial slot, sealed+zod upstream). The sheet 公版尾
 * (`location, timeOfDay, weather`) is ONLY the fallback when the packet has no
 * location — a packet never carries the sheet tail. Light angle from the packet:
 * high ⇒ 頂光, low ⇒ 低位光, else eye ⇒ 均勻光.
 * Chau 17:48: negatives are packet data too (require.negatives, authored per
 * 道具/場景類別) — this function ONLY assembles, never authors a ban list. */
export function sceneLine(sheet: CallSheet, shot: Shot): string {
  const loc = shot.require?.location?.trim();
  if (!loc) return `${sheet.location}，${sheet.timeOfDay}，${sheet.weather}。唔好加人。`;
  const negs = shot.require?.negatives ?? [];
  const ban = negs.length ? `；禁止${negs.join("、")}` : "";
  if (isIndoorLocation(loc)) {
    const light = shot.require?.angle === "low" ? "低位室內光" : shot.require?.angle === "eye" ? "均勻室內光" : "頂光";
    return `${loc}：室內、冇窗、${light}${ban}；夜只由室內燈表達。唔好加人。`;
  }
  return `${loc}${ban}。唔好加人。`;
}

/** T32b 裁1: the scene-retry request carries its own schema so 阿圖 doesn't
 *  guess against the charter default — plus the Image-1 grey-model note and
 *  the current location verbatim (with the room-noun rewrite rule). */
export function sceneRetryUser(shot: Shot, failReasons: string[]): string {
  const current = shot.require?.location ?? shot.location;
  return JSON.stringify({
    task: "只重寫呢一鏡嘅場景 slot",
    shot: shot.id,
    action: shot.action,
    failReasons,
    currentLocation: current,
    note: "Image-1 係 Blender 灰模概念圖，唔係實景參考。",
    rule: `location 寫返 2–8 字場所名詞（例：地下室、宿舍、走廊）。而家嗰句（${current}）如果係機構／劇名，唔好照抄 — 寫畫面真正見到嘅房。`,
    output_schema: {
      thinking: "string，最多三句",
      location: "string，2–8 字場所名詞，例：地下室",
      angle: "eye|high|low，可省",
      negatives: "string[]，每項 2–12 字禁令，可省；唔可以有霓虹/neon/night",
    },
  });
}

/** T32b C1/C5: the scene-retry reply schema — 阿圖-shape replies are mapped in
 *  by sceneRetryNormalize first; location must be a room noun; negatives stay
 *  behind the T29 poison gate. Shared by the pipeline call and the tests. */
export const sceneRetrySchema = z.object({
  thinking: z.string().min(1).max(400),
  location: z.string().min(2).max(8),
  angle: omittable(z.enum(["eye", "high", "low"])),
  negatives: omittable(z.array(z.string().min(1).max(12)).min(1).max(6)),
}).refine((r) => isRoomNoun(r.location), {
  message: "location 要係 2–8 字場所名詞（地下室、宿舍、走廊），唔係機構全名",
  path: ["location"],
}).refine((r) => !negativePoison(r.negatives ?? []), {
  message: "negatives 唔可以有霓虹/neon/night — 負面詞毒畫面（T29 法）",
  path: ["negatives"],
});

/** /edit prompt for one shot keyframe, Fable 00:20 U1.5=A form: 150–300 中文，
 *  ordered Image-1 錨 → require.location 原句 → 衫著 → 道具／防農具 → negatives
 *  （後兩者隨場景句）。PE 只潤色 — 呢度交出去嘅已經係完整 brief。薄 packet
 *  組唔夠 150 中文字就拒出（prompt_too_thin），唔交六行電報。 */
export function keyframeEditPrompt(sheet: CallSheet, shot: Shot, opts: { first: boolean }): string {
  const ordered = [...shot.marks].sort((a, b) => a.start.x - b.start.x);
  const chars = ordered.map((m) => {
    const hit = sheet.characters.find((c) => c.id === m.characterId);
    if (!hit) throw new Error(`${shot.id}: mark references unknown character ${m.characterId}`);
    return hit;
  });
  const prop = shot.props?.[0];
  const cls = prop ? propNounClass(prop.name) : null;
  const carried = prop ? prop.name : "犁";
  const people = chars
    .map((c, i) => `左起第${i + 1}個人偶＝Image-${i + 2} 嘅臉（${c.name}），衫著：${c.wardrobe}。`)
    .join("");
  let props = "";
  if (prop && cls === "garment") {
    props = `【道具】${prop.name}係一件衣物：披上膊頭或者着住喺身嘅衣服，有領有袖，布料隨姿勢自然垂落。衣擺同身體、地面要有接觸同遮擋。`;
  } else if (prop && cls === "document") {
    props = `【道具】${prop.name}係一張紙本文書：薄而平，可以喺手中展開、遞出或者攤開睇，上面有字有印；佢係文具唔係工具，畫面冇任何農具或者長柄器具。`;
  } else if (prop) {
    props = `【道具】人偶手中／兩人之間嘅長條係${prop.name}：一件完整木犁，弧形犁樑自後把手斜落前方，前端只有一塊三角形鐵犁鏵、單一刃口向下插入壟土；成張畫面只有呢一件農具；唔係${prop.forbid.join("、")}。`;
  }
  const keep = opts.first
    ? "【保留】Image-2…Image-N 係上述角色嘅正面肖像，只借五官同髮際。唔好加第三人。"
    : `【保留】Image-2 係上一鏡嘅定格：樣貌、衣服、${carried}、光線同色調跟 Image-2，唯獨姿勢跟 Image-1。`;
  const text = [
    "將 Image-1 灰模概念圖轉成 photoreal 實拍；人偶係角色佔位，唔係道具。人偶位置、姿勢、比例、鏡位、地平線、背景結構、牆面、室內外完全照 Image-1。",
    `【場景】${sceneLine(sheet, shot)}牆面、地面、影子畫清楚。`,
    `【人物】${people}距離、身高照 Image-1。`,
    props,
    "【光影材質】布料、紙、金屬、水泥各有材質；手指、衣擺、道具同地面要有接觸遮擋。",
    keep,
  ].filter((s) => s.length > 0).join("\n\n");
  const n = cjkCount(text);
  if (n < EDIT_MIN_CJK) {
    throw new Error(`prompt_too_thin: ${shot.id} /edit 只組到 ${n} 中文字（最少 ${EDIT_MIN_CJK}）— packet 太薄，生成器拒出（Fable 00:20 U1.5=A）`);
  }
  return text;
}

/** what photo QC requires of this shot's keyframe: the marks decide people_count;
 *  only a held tool (noun class "tool") adds the proven tool gate from data.
 *  Garments and documents are wardrobe/paper, not tools — no tool gate: blind QC
 *  can only describe shape words, never the sheet's proper name, so the name
 *  gate never turns GREEN. */
export function keyframeRequire(shot: Shot): QcRequire {
  const prop = shot.props?.[0];
  const heldTool = prop && propNounClass(prop.name) === "tool" ? prop : undefined;
  return {
    people_count: new Set(shot.marks.map((m) => m.characterId)).size,
    grey_blocks: false,
    ...(shot.location ? { location: shot.location } : {}),
    ...(shot.action ? { action: shot.action } : {}),
    ...(shot.size ? { size: shot.size } : {}),
    ...(heldTool ? { tool: heldTool.name, tool_shape: heldTool.shape, tool_forbid: heldTool.forbid } : {}),
  };
}
