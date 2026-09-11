import type { CallSheet, Shot } from "./types";
import type { QcRequire } from "./photo-qc";

/** /edit prompt for one shot keyframe. The grey mannequins in the blockout base
 *  are the named characters — say so explicitly, or /edit keeps them as mannequins.
 *  Nothing scene-specific lives here. */
export function keyframeEditPrompt(sheet: CallSheet, shot: Shot, opts: { first: boolean }): string {
  const ids = [...new Set(shot.marks.map((m) => m.characterId))];
  const chars = ids.map((id) => {
    const hit = sheet.characters.find((c) => c.id === id);
    if (!hit) throw new Error(`${shot.id}: mark references unknown character ${id}`);
    return hit;
  });
  const cast = chars.map((c) => `${c.name}（${c.role}）着${c.wardrobe}`).join("；");
  const identity = opts.first
    ? "角色樣貌以參考圖為準。"
    : "角色樣貌跟基準圖（上一張 keyframe）完全一致。";
  return [
    `Photoreal 實拍質感。${sheet.location}，${sheet.timeOfDay}，${sheet.weather}，${shot.size} 鏡。`,
    `圖中灰色人偶係角色佔位，唔係道具：${cast}。`,
    `保持每個人偶嘅位置、姿勢、構圖同鏡頭完全不變，只將灰色人偶換成上述角色。${identity}`,
    `動作：${shot.action}`,
    "背景同地面照舊；唔好加人，唔好改走位。",
  ].join("\n");
}

/** what photo QC requires of this shot's keyframe: the marks decide people_count */
export function keyframeRequire(shot: Shot): QcRequire {
  return {
    people_count: new Set(shot.marks.map((m) => m.characterId)).size,
    grey_blocks: false,
  };
}
