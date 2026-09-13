import type { CallSheet, Shot } from "./types";
import type { QcRequire } from "./photo-qc";

/** garments are clothes on the body — they never take the held-tool/plow gate.
 *  forbid lists are not echoed for garments (sheet forbids name the plow). */
const GARMENT_RE = /外套|大衣|衫|衣|coat|jacket|cloak|robe/i;

function isGarment(name: string): boolean {
  return GARMENT_RE.test(name);
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
  const garment = prop ? isGarment(prop.name) : false;
  if (prop) {
    if (garment) {
      // clothing on the body, never farm vocabulary — a coat drawn as a plow blade is the SH07 regression
      lines.push(
        `${prop.name}係一件衣物：披上膊頭或者着住喺身嘅衣服，有領有袖，布料隨姿勢自然垂落，屬於角色造型一部分。`,
      );
    } else {
      // "one blade, one tool" — U1.5's default farm tool is a multi-tine rake
      lines.push(
        `人偶手中／兩人之間嘅長條係${prop.name}：一件完整木犁，弧形犁樑自後把手斜落前方，前端只有一塊三角形鐵犁鏵、單一刃口向下插入壟土；成張畫面只有呢一件農具，背景冇任何其他工具；唔係${prop.forbid.join("、")}。`,
      );
    }
  }
  lines.push(
    opts.first
      ? "Image-2…Image-N 係上述角色嘅正面肖像，只借樣貌。"
      : `Image-2 係上一鏡嘅定格：兩人樣貌、衣服、${garment && prop ? prop.name : "犁"}、光線同色調全部跟 Image-2，唯獨姿勢跟 Image-1。`,
  );
  lines.push(`${sheet.location}，${sheet.timeOfDay}，${sheet.weather}。唔好加人。`);
  return lines.join("\n");
}

/** what photo QC requires of this shot's keyframe: the marks decide people_count;
 *  a held tool (when the sheet carries one) adds the proven tool gate from data.
 *  A garment is wardrobe, not a tool — no tool gate: blind QC can only describe
 *  shape words, never the sheet's proper name, so the name gate never turns GREEN. */
export function keyframeRequire(shot: Shot): QcRequire {
  const prop = shot.props?.[0];
  return {
    people_count: new Set(shot.marks.map((m) => m.characterId)).size,
    grey_blocks: false,
    ...(prop && !isGarment(prop.name) ? { tool: prop.name, tool_shape: prop.shape, tool_forbid: prop.forbid } : {}),
  };
}
