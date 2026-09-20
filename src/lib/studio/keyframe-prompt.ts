import fs from "node:fs";
import path from "node:path";
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
  /令|詔|旨|敕|書|信|箋|函|卷|軸|圖|紙|契|券|符|帖|牒|表|冊|文件|檔案|文書|decree|edict|letter|scroll|document|paper|map|warrant|pardon|deed|pass\b/i;

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
const INDOOR_RE = /室|房|廳|廊|宿舍|禮堂|館|公寓|中心|停屍間/;

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
export const EDIT_MAX_CJK = 300;

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
  // packet require.location first; else the shot's own room (the same field
  // keyframeRequire hands photo-qc — prompt and gate must read one source);
  // the sheet tail only when the shot has no room at all
  const loc = (shot.require?.location ?? shot.location)?.trim();
  if (!loc) return `${sheet.location}，${sheet.timeOfDay}，${sheet.weather}。`;
  const negs = shot.require?.negatives ?? [];
  const ban = negs.length ? `；禁止${negs.join("、")}` : "";
  if (isIndoorLocation(loc)) {
    const light = shot.require?.angle === "low" ? "低位室內光" : shot.require?.angle === "eye" ? "均勻室內光" : "頂光";
    return `${loc}：室內、冇窗、${light}${ban}。`;
  }
  return `${loc}${ban}。`;
}

/** ONE scene truth source (Fable 1d9bb51): packet require.location first,
 *  else the shot's own room; sheet tail only when the shot carries no room. */
export function sceneLocation(sheet: CallSheet, shot: Shot): string {
  const loc = (shot.require?.location ?? shot.location)?.trim();
  return loc || sheet.location.trim();
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

/** shot.size → framing sentence, same scale words photo-qc measures (size_notes) */
const SIZE_LINE: Record<string, string> = {
  wide: "景別 wide：全身連大片環境，人只佔畫面高度三成以下。",
  full: "景別 full：全身入畫，頭頂到腳底都見到。",
  medium: "景別 medium：腰以上半身入畫。",
  closeup: "景別 closeup：面同肩膊填滿畫面。",
  insert: "景別 insert：只見手同道具嘅局部特寫。",
};

/** L1b base cast: a drama's fixed wardrobe is a base fact on disk
 *  (projects/<drama>/base/cast.json), never a playbook bullet. */
export type BaseCastEntry = { id: string; wardrobe: string };
export type BaseCast = { characters: BaseCastEntry[] };

export function loadBaseCast(projectsRoot: string, drama: string): BaseCast | undefined {
  const file = path.join(projectsRoot, drama, "base", "cast.json");
  if (!fs.existsSync(file)) return undefined;
  let raw: { characters?: BaseCastEntry[] };
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8")) as { characters?: BaseCastEntry[] };
  } catch {
    return undefined;
  }
  const characters = Array.isArray(raw.characters)
    ? raw.characters.filter((c) => c && typeof c.id === "string" && typeof c.wardrobe === "string")
    : [];
  return characters.length > 0 ? { characters } : undefined;
}

/** BUG3 cookbook: Image-N 對號＋着衫 ref／變保對／人數錨。Chau 0917 法1/2/4/5
 *  四句禁句唔准出。150–300 CJK。【動作】同景別跟 Fable 0c636e9（QC 要見原句）。
 *  場景句走 sceneLine（T32 室內唔帶 sheet 天氣），唔抄 Wire 嗰句 sheet 尾拼接。 */
export function keyframeEditPrompt(sheet: CallSheet, shot: Shot, opts: { first: boolean; cast?: BaseCast }): string {
  const ordered = [...shot.marks].sort((a, b) => a.start.x - b.start.x);
  const chars = ordered.map((m) => {
    const hit = sheet.characters.find((c) => c.id === m.characterId);
    if (!hit) throw new Error(`${shot.id}: mark references unknown character ${m.characterId}`);
    return hit;
  });
  const prop = shot.props?.[0];
  const cls = prop ? propNounClass(prop.name) : null;
  const people = chars
    .map((c, i) => {
      const wardrobe = opts.cast?.characters.find((e) => e.id === c.id)?.wardrobe ?? c.wardrobe;
      return `左起第${i + 1}個人偶＝Image-${i + 2} 嘅角色${c.name}：面容、髮型同成套衫著照 Image-${i + 2}——${wardrobe}；朝向同動作跟 Image-1 人偶。`;
    })
    .join("");
  let props = "";
  if (prop && cls === "garment") {
    props = `【道具】${prop.name}係一件衣物：披上膊頭或者着住喺身嘅衣服，有領有袖，布料隨姿勢自然垂落，屬於角色造型一部分。`;
  } else if (prop && cls === "document") {
    props = `【道具】${prop.name}係薄而平嘅紙本文書，喺手中展開或者攤開，上面有字有印；佢係文具唔係工具，畫面冇農具或長柄器具。`;
  } else if (prop) {
    props = `【道具】人偶手中／兩人之間嘅長條係${prop.name}：一件完整木犁，弧形犁樑自後把手斜落前方，前端只有一塊三角形鐵犁鏵、單一刃口向下插入壟土；成張畫面只有呢一件農具；唔係${prop.forbid.join("、")}。`;
  }
  const keep = opts.first
    ? `畫面人數照 Image-1 人偶：淨係得呢${chars.length}個角色，每個嘅面容同衫著照自己嗰張 Image。`
    : `Image-2 係上一鏡嘅定格：樣貌、衣服${prop ? `、${prop.name}` : ""}、光線同色調照 Image-2；姿勢同企位跟 Image-1。`;
  // 【動作】／景別 are packet facts (Fable 0c636e9: photo-qc gates on them).
  // They ride AFTER the 150–300 band like Card D facts — long drama beats
  // must not blow Chau 法11's brief ceiling.
  const extras = [
    shot.action ? `【動作】${shot.action}` : "",
    SIZE_LINE[shot.size] ?? "",
  ].filter((s) => s.length > 0).join("\n\n");
  const brief = [
    "【底圖】Image-1 係 Blender 灰模概念圖，人偶係角色佔位。轉 photoreal——變嘅係質感、材質同光線；人偶嘅位置、姿勢、佔位保持照 Image-1。",
    `【人物】${people}`,
    `【場景】${sceneLine(sheet, shot)}`,
    props,
    "【光影材質】布料、紙、金屬各有質感；手、衣擺、道具同地面有接觸遮擋。",
    keep,
  ].filter((s) => s.length > 0).join("\n\n");
  const nBrief = cjkCount(brief);
  if (nBrief > EDIT_MAX_CJK) {
    throw new Error(`prompt_too_thick: ${shot.id} /edit 組到 ${nBrief} 中文字（上限 ${EDIT_MAX_CJK}）— packet 太肥，prompt 只解釋底圖唔補償（Chau 0917 法11）；收細 packet 再出`);
  }
  const text = extras ? `${brief}\n\n${extras}` : brief;
  if (cjkCount(text) < EDIT_MIN_CJK) {
    throw new Error(`prompt_too_thin: ${shot.id} /edit 只組到 ${cjkCount(text)} 中文字（最少 ${EDIT_MIN_CJK}）— packet 太薄，生成器拒出（Fable 00:20 U1.5=A）`);
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
