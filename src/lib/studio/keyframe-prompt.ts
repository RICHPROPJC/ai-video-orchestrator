import type { CallSheet, Shot, ShotFact } from "./types";
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

/** Chau 0919 search-first PE law: a frame that shows text/data (infographic,
 *  手機畫面, 數據卡, 走勢圖) must be composed from packet facts — numbers
 *  never come from the model's head. Structural vocabulary only, same register
 *  as propNounClass; the seat can also mark the shot with require.factsRequired. */
const TEXT_SCREEN_RE =
  /infograph|信息圖|資訊圖|圖表|數據卡|數字卡|文字圖|走勢圖|柱狀|折線|圓餅|螢幕截圖|屏幕截圖|手機畫面|畫面顯示|chart|dashboard/i;

export function needsShotFacts(shot: Shot): boolean {
  if (shot.require?.factsRequired) return true;
  return TEXT_SCREEN_RE.test(shot.action) || (shot.props ?? []).some((p) => TEXT_SCREEN_RE.test(p.name));
}

/** Assemble packet facts verbatim for the /edit prompt. Code assembles, never
 *  authors — every number on screen must trace to one of these rows. */
export function factsBlock(facts: ShotFact[]): string {
  const lines = ["【上屏事實】以下數字／日期／名逐字照抄上屏，唔准改寫、唔准四捨五入、唔准自己補："];
  facts.forEach((f, i) => lines.push(`${i + 1}. ${f.claim}（來源：${f.source}，${f.fetched_at} 摳返嚟）`));
  return lines.join("\n");
}

/** BUG3 (CARD_BUG3_0920, Chau 0917 法1/2/4/5): the /edit brief band — 150–300
 *  中文字. Under 150 the packet is too thin (six-line telegram refuses to emit,
 *  Fable 00:20 U1.5=A); over 300 it is compensation bloat (Chau 0917 法11:
 *  prompt 只解釋底圖係咩，唔負責補償). CJK only — Image-N tokens and URLs never
 *  count. The facts block rides AFTER the band: packet data, not brief prose. */
export function cjkCount(text: string): number {
  return (text.match(/[一-鿿]/g) ?? []).length;
}
export const EDIT_MIN_CJK = 150;
export const EDIT_MAX_CJK = 300;

/** ONE scene truth source (Fable 1d9bb51 law): packet require.location first,
 *  else the shot's own room; the sheet tail only when the shot carries no room.
 *  Prompt and photo-qc gate on this single field — a second source never opens. */
export function sceneLocation(sheet: CallSheet, shot: Shot): string {
  const loc = (shot.require?.location ?? shot.location)?.trim();
  return loc || sheet.location.trim();
}

/** /edit prompt for one shot keyframe, naming images by slot. Under img_cfg 1.0
 *  the image branches only exist via Image-N tokens — the prompt must name them.
 *  Nothing scene-specific lives here; every name/wardrobe/prop comes from the sheet.
 *  BUG3 cookbook shape: Image-N 對號＋每張作用、變咗＋保持咩唔變、上屏逐字
 *  (factsBlock)、150–300 中文. Chau 0917 laws: Image-1 anchors puppet
 *  位置/姿勢/佔位 ONLY — 場景結構同人體尺度永唔跟灰模（法1/4；四句原文同殘句
 *  清單見 verify/crew/CARD_BUG3_0920.md）；refs are the characters' DRESSED
 *  bodies, 面容＋衫著照 ref, facing follows the blockout (法5/6/9); people
 *  count anchors to the puppets — 冇錨 negative 禁（法5）. */
export function keyframeEditPrompt(sheet: CallSheet, shot: Shot, opts: { first: boolean }): string {
  // refuse-to-emit (Card D 掣2, prompt_too_thin 嘅形): a text/data screen with
  // no packet facts has nothing honest to put on screen — the generator refuses
  // rather than let the model invent numbers
  const facts = shot.require?.facts ?? [];
  if (needsShotFacts(shot) && facts.length === 0) {
    throw new Error(
      `facts_missing: ${shot.id} 文字圖／infographic 類 shot 冇 require.facts — 文字圖要facts，去PE步攞（search-first PE：wigolo 搜證→PE 腦寫入 require.facts 先准出；Card D 掣2）`,
    );
  }
  const ordered = [...shot.marks].sort((a, b) => a.start.x - b.start.x);
  const chars = ordered.map((m) => {
    const hit = sheet.characters.find((c) => c.id === m.characterId);
    if (!hit) throw new Error(`${shot.id}: mark references unknown character ${m.characterId}`);
    return hit;
  });
  const prop = shot.props?.[0];
  const cls = prop ? propNounClass(prop.name) : null;
  // Image-N 對號＋每張作用：puppet i+1 wears character from Image-i+2 — the ref
  // is the DRESSED body (面容＋衫著, Chau 法5/9), facing follows Image-1 (法6)
  const people = chars
    .map(
      (c, i) =>
        `左起第${i + 1}個人偶＝Image-${i + 2} 嘅角色${c.name}（${c.role}）：面容、髮型同成套衫著照 Image-${i + 2}——${c.wardrobe}；朝向同動作跟 Image-1 人偶。`,
    )
    .join("");
  let props = "";
  if (prop && cls === "garment") {
    // clothing on the body, never farm vocabulary — a coat drawn as a plow blade is the SH07 regression
    props = `【道具】${prop.name}係一件衣物：披上膊頭或者着住喺身嘅衣服，有領有袖，布料隨姿勢自然垂落，屬於角色造型一部分。`;
  } else if (prop && cls === "document") {
    // flat paper document in the hands — never the plow sentence, never a tool
    props = `【道具】${prop.name}係一張紙本文書：薄而平，可以喺手中展開、遞出或者攤開睇，上面有字有印；佢係文具唔係工具，畫面冇任何農具或者長柄器具。`;
  } else if (prop) {
    // "one blade, one tool" — U1.5's default farm tool is a multi-tine rake
    props = `【道具】人偶手中／兩人之間嘅長條係${prop.name}：一件完整木犁，弧形犁樑自後把手斜落前方，前端只有一塊三角形鐵犁鏵、單一刃口向下插入壟土；成張畫面只有呢一件農具，背景冇任何其他工具；唔係${prop.forbid.join("、")}。`;
  }
  // 變咗＋保持咩唔變：質感/材質/光線變，人偶位置/姿勢/佔位不變（法1準錨清單）；
  // 人數錨住人偶數（法5：錨定句，唔係冇錨 negative）
  const keep = opts.first
    ? `畫面人數照 Image-1 人偶：淨係得呢${chars.length}個角色，每個嘅面容同衫著照自己嗰張 Image。`
    : `Image-2 係上一鏡嘅定格：樣貌、衣服${prop ? `、${prop.name}` : ""}、光線同色調照 Image-2；姿勢同企位跟 Image-1。`;
  const brief = [
    "【底圖】Image-1 係呢一鏡嘅 Blender 灰模概念圖：灰色人偶係角色佔位，唔係道具、唔係石頭。將佢轉成 photoreal 實拍一格——變嘅係質感、材質同光線；人偶嘅位置、姿勢、佔位保持照 Image-1。",
    `【人物】${people}`,
    `【場景】${sceneLocation(sheet, shot)}，${sheet.timeOfDay}，${sheet.weather}。牆面、地面、影子畫清楚。`,
    props,
    "【光影材質】布料、紙、金屬、水泥各有材質；手指、衣擺、道具同地面要有接觸同遮擋。",
    keep,
  ]
    .filter((s) => s.length > 0)
    .join("\n\n");
  const n = cjkCount(brief);
  if (n < EDIT_MIN_CJK) {
    throw new Error(
      `prompt_too_thin: ${shot.id} /edit 只組到 ${n} 中文字（最少 ${EDIT_MIN_CJK}）— packet 太薄，生成器拒出（Fable 00:20 U1.5=A）`,
    );
  }
  if (n > EDIT_MAX_CJK) {
    throw new Error(
      `prompt_too_thick: ${shot.id} /edit 組到 ${n} 中文字（上限 ${EDIT_MAX_CJK}）— packet 太肥，prompt 只解釋底圖唔補償（Chau 0917 法11）；收細 packet 再出`,
    );
  }
  if (facts.length > 0) return `${brief}\n\n${factsBlock(facts)}`;
  return brief;
}

/** what photo QC requires of this shot's keyframe: the marks decide people_count;
 *  only a held tool (noun class "tool") adds the proven tool gate from data.
 *  Garments and documents are wardrobe/paper, not tools — no tool gate: blind QC
 *  can only describe shape words, never the sheet's proper name, so the name
 *  gate never turns GREEN. */
export function keyframeRequire(shot: Shot): QcRequire {
  const prop = shot.props?.[0];
  const heldTool = prop && propNounClass(prop.name) === "tool" ? prop : undefined;
  const facts = shot.require?.facts ?? [];
  return {
    people_count: new Set(shot.marks.map((m) => m.characterId)).size,
    grey_blocks: false,
    ...(heldTool ? { tool: heldTool.name, tool_shape: heldTool.shape, tool_forbid: heldTool.forbid } : {}),
    ...(facts.length ? { facts } : {}),
  };
}
