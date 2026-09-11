import type { CallSheet, Shot } from "./types";
import type { QcRequire } from "./photo-qc";

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
  if (prop) {
    lines.push(
      `人偶手中／兩人之間嘅長條係${prop.name}：木製長犁樑弧形斜落，前端鐵犁鏵插入壟土；唔係${prop.forbid.join("、")}。`,
    );
  }
  lines.push(
    opts.first
      ? "Image-2…Image-N 係上述角色嘅正面肖像，只借樣貌。"
      : "Image-2 係上一鏡嘅定格：兩人樣貌、衣服、犁、光線同色調全部跟 Image-2，唯獨姿勢跟 Image-1。",
  );
  lines.push(`${sheet.location}，${sheet.timeOfDay}，${sheet.weather}。唔好加人。`);
  return lines.join("\n");
}

/** what photo QC requires of this shot's keyframe: the marks decide people_count;
 *  a prop (when the sheet carries one) adds the proven tool gate from data */
export function keyframeRequire(shot: Shot): QcRequire {
  const prop = shot.props?.[0];
  return {
    people_count: new Set(shot.marks.map((m) => m.characterId)).size,
    grey_blocks: false,
    ...(prop ? { tool: prop.name, tool_shape: prop.shape, tool_forbid: prop.forbid } : {}),
  };
}
