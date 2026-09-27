import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { seatsDir } from "./paths";

/** 席位技能＋章程：seats/skills/<name>.md 教點諗一場戲，charter 教機器
 *  欄位——一段 system 送出。技能檔原文逐字讀入，唔經 parseBullet（呢啲係
 *  思考步驟，唔係失敗紀錄）。檔唔存在→空字串淨返章程（fail-open）。 */
export type SeatSkill = "director" | "boards" | "stills";

export function loadSeatSkill(
  skill: SeatSkill,
  dir: string = seatsDir(),
): { text: string; sha256: string } {
  const file = path.join(dir, "skills", `${skill}.md`);
  if (!fs.existsSync(file)) return { text: "", sha256: "" };
  const text = fs.readFileSync(file, "utf8");
  const sha256 = createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
  return { text, sha256 };
}

/** 拼法：技能在前（點諗），章程在後（交咩欄位）。技能缺席淨返章程。 */
export function skillThenCharter(skill: SeatSkill, charter: string, dir?: string): { system: string; receipts: string[] } {
  const { text, sha256 } = loadSeatSkill(skill, dir);
  const receipts = sha256 ? [`skill: ${skill} sha256 ${sha256}`] : [`skill: ${skill} 缺席（seats/skills/${skill}.md 唔存在）——淨章程層`];
  return { system: text ? `${text}\n\n---\n\n${charter}` : charter, receipts };
}
