import type { HipStats } from "../motion-select";

/**
 * JUDGMENT/motion — 動作側判斷常數嘅集中歸位（Chau 0927「雜嘢應該集嘅
 * 地方集＋基礎設定根本冇分析」）。規矩：新判斷常數唔准再散編——冇入
 * judgment/ 嘅 numeric threshold 唔收。每個值帶 provenance：
 *   ✅實證＝有 probe/收據；📜法源＝Chau 釘咗；❌未分析＝有分析 TODO。
 *
 * 族內中位數量法（CMU0927 probe，2026-09-27）：cmu-mocap-index-text.txt
 * 按描述抽樣每族 ≤40 clip，bvhHipStats 0.05s 採樣（舊 0.1s×≥24 樣本會掃走
 * run 族 35/40——佢哋短過 2.4s）。髖 Y 係 rig 縮放單位（111_19 實測企直
 * ~15.2，唔係 cm），絕對值冇意義，只可以做族內相對比較。
 */
export const FAM_MEDIANS = {
  walk: { oscPerSec: 0.85, n: 40, quartiles: [0.61, 1.11] as const },
  run: { oscPerSec: 2.41, n: 40, quartiles: [1.36, 2.61] as const },
  stand_idle: { stdY: 0.07, n: 1, note: "index 描述配得少，樣本薄" },
  bend_pick: { stdY: 1.18, n: 24, note: "彎係瞬態：meanY med 16.74≈企直，訊號喺方差" },
  sit: { stdY: 3.47, n: 24, note: "族係雙峰：純坐低 vs 坐落過程" },
} as const;

/**
 * tie-break 每族分辨指標（0927 fix ②級）：arm-axis ranking 淨 martial 有，
 * 其他族從前全部 ∞ 個個一樣 → 同一條 bvh 焊晒。原則＝貼族內典型（verb
 * gate 已揀咗族，tie-break 揀族內最典型嗰條）；目標值＝FAM_MEDIANS 實測。
 * 初版 1.8/2.5 係拍腦袋（實測 walk 0.85），已廢——教訓入 JUDGMENT_INVENTORY。
 */
export const FAM_TARGET: Record<string, (h: HipStats) => number> = {
  martial: () => 0, // arm-axis 排先，髖唔參與
  walk: (h) => Math.abs(h.oscPerSec - FAM_MEDIANS.walk.oscPerSec),
  run: (h) => Math.abs(h.oscPerSec - FAM_MEDIANS.run.oscPerSec),
  stand_idle: (h) => h.stdY, // 貼 0.07＝最靜嗰條
  bend_pick: (h) => Math.abs(h.stdY - FAM_MEDIANS.bend_pick.stdY),
  sit: (h) => Math.abs(h.stdY - FAM_MEDIANS.sit.stdY),
};
