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

/** /edit prompt for one shot keyframe, naming images by slot. Under img_cfg 1.0
 *  the image branches only exist via Image-N tokens — the prompt must name them.
 *  Nothing scene-specific lives here; every name/wardrobe/prop comes from the sheet. */
export function keyframeEditPrompt(sheet: CallSheet, shot: Shot, opts: { first: boolean }): string {
  const ordered = [...shot.marks].sort((a, b) => a.start.x - b.start.x);
  const chars = ordered.map((m) => {
    const hit = sheet.characters.find((c) => c.id === m.characterId);
    if (!hit) throw new Error(`${shot.id}: mark references unknown character ${m.characterId}`);
    return hit;
  });
  const lines = [
    "Image-1 係呢一鏡嘅 Blender 灰模概念圖：灰色人偶係角色佔位，唔係道具、唔係石頭。將呢張概念圖轉成 photoreal 實拍一格，",
    "人偶位置、姿勢、比例、鏡位、地平線完全照 Image-1。",
  ];
  chars.forEach((c, i) => {
    lines.push(`左起第${i + 1}個人偶＝${c.name}（${c.role}）：${c.wardrobe}。`);
  });
  const prop = shot.props?.[0];
  const cls = prop ? propNounClass(prop.name) : null;
  if (prop && cls === "garment") {
    // clothing on the body, never farm vocabulary — a coat drawn as a plow blade is the SH07 regression
    lines.push(
      `${prop.name}係一件衣物：披上膊頭或者着住喺身嘅衣服，有領有袖，布料隨姿勢自然垂落，屬於角色造型一部分。`,
    );
  } else if (prop && cls === "document") {
    // flat paper document in the hands — never the plow sentence, never a tool
    lines.push(
      `${prop.name}係一張紙本文書：薄而平，可以喺手中展開、遞出或者攤開睇，上面有字有印；佢係文具唔係工具，畫面冇任何農具或者長柄器具。`,
    );
  } else if (prop) {
    // "one blade, one tool" — U1.5's default farm tool is a multi-tine rake
    lines.push(
      `人偶手中／兩人之間嘅長條係${prop.name}：一件完整木犁，弧形犁樑自後把手斜落前方，前端只有一塊三角形鐵犁鏵、單一刃口向下插入壟土；成張畫面只有呢一件農具，背景冇任何其他工具；唔係${prop.forbid.join("、")}。`,
    );
  }
  lines.push(
    opts.first
      ? "Image-2…Image-N 係上述角色嘅正面肖像，只借樣貌。"
      : `Image-2 係上一鏡嘅定格：兩人樣貌、衣服、${prop ? prop.name : "犁"}、光線同色調全部跟 Image-2，唯獨姿勢跟 Image-1。`,
  );
  // T32: 室內鏡場景句跟鏡。霓虹/neon/night 連「禁止」句都唔寫 — 負面詞毒畫面，禁令寫做「招牌燈箱」。
  lines.push(
    isIndoorLocation(shot.location)
      ? `${shot.location}：室內、冇窗、頂光；禁止街道、路燈、招牌燈箱、濕地反光；夜只由室內燈表達。唔好加人。`
      : `${sheet.location}，${sheet.timeOfDay}，${sheet.weather}。唔好加人。`,
  );
  return lines.join("\n");
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
