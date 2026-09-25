import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseBullet } from "../playbook";
import { PLAYBOOK_SCOPES, projectsDir, seatsDir } from "../paths";
import { SKINTOKENS_BIN } from "../cast-mesh";

/** wb/gates.ts — 開場閘（whitebox gates 哲學：fail-loud，帶收據句）。
 *
 *  兩閘：
 *  (a) playbook 檔 schema 驗——一行以「- 」開頭而過唔到 BULLET_RE（playbook.ts
 *      parseBullet）就係爛 bullet：佢會被 parsePlaybookLines 當 raw 靜靜帶入
 *      prompt，seat 收到一段形狀爛嘅教訓。開工前大聲死，唔俾爛行上 prompt。
 *      實證：DTQH/BEQ5/OLHR 三單 fallback 連敗收場，死鏈在 playbook 學訓層。
 *  (b) rig/backend probe——skintokens backend 係咪 GPU：bin 喺唔喺、同目錄有
 *      冇 libggml-cuda.so（GPU build）、free VRAM 過唔過 floor。
 *      實證：SC-0923-1KU5 rig A 喺 375 MiB free 嘅卡上面 cudaMalloc 72.5 MiB
 *      都分配唔到，OOM 死。開工前量卡，唔到 floor 即死。
 *
 *  兩閘都行齊先 throw（一次 preflight 睇晒所有問題）；任何一閘唔過都唔開
 *  工——fail-loud，唔靜靜降級。 */

export const BROKEN_BULLET_EVIDENCE = "DTQH/BEQ5/OLHR fallback 爛 bullet 實證";
export const GPU_OOM_EVIDENCE = "SC-0923-1KU5 rig A CUDA OOM 實證（375MiB free 分配 72.5MiB 唔到）";

/** free VRAM floor（MiB）。1KU5 嗰喎：375 MiB free 連 72.5 MiB 都分配唔到；
 *  1536 留足 mesh encoder＋KV buffer 位。 */
export const DEFAULT_MIN_FREE_MIB = 1536;

export function playbookFiles(opts?: { seatsDir?: string; projectsDir?: string; drama?: string }): string[] {
  const seats = opts?.seatsDir ?? seatsDir();
  const proot = opts?.projectsDir ?? projectsDir();
  const files: string[] = PLAYBOOK_SCOPES.map((s) => path.join(seats, `${s}.primitive.md`));
  if (opts?.drama?.trim()) {
    files.push(...PLAYBOOK_SCOPES.map((s) => path.join(proot, opts.drama!.trim(), "playbook", `${s}.md`)));
  }
  return files.filter((f) => fs.existsSync(f));
}

/** 一個檔入面所有爛 bullet：行以「- 」開頭而 parseBullet 返 null。 */
export function brokenBulletsIn(file: string): { line: number; text: string }[] {
  if (!fs.existsSync(file)) return [];
  const out: { line: number; text: string }[] = [];
  const lines = fs.readFileSync(file, "utf8").split("\n");
  for (const [i, line] of lines.entries()) {
    const t = line.trim();
    if (!t.startsWith("- ")) continue;
    if (!parseBullet(t)) out.push({ line: i + 1, text: t });
  }
  return out;
}

export type PreflightConfig = {
  seatsDir?: string;
  projectsDir?: string;
  drama?: string;
  skintokensBin?: string;
  minFreeMiB?: number;
  /** 測試注入：free VRAM 量法。Default nvidia-smi 全卡取最大 free。 */
  gpuFreeMiB?: () => number | null;
  /** 測試注入：當真。跳過 rig probe（純 playbook 驗證用）。 */
  skipRigProbe?: boolean;
};

/** nvidia-smi 全卡 free VRAM（MiB），取最大——job 會 CUDA_VISIBLE_DEVICES 釘
 *  其中一張，開工前 honest 嘅問法係「有冇一張卡有位」。量唔到返 null。 */
export function gpuFreeMiBNvidiaSmi(): number | null {
  try {
    const out = execFileSync(
      "nvidia-smi",
      ["--query-gpu=memory.free", "--format=csv,noheader,nounits"],
      { timeout: 10_000, encoding: "utf8" },
    );
    const nums = out
      .split("\n")
      .map((l) => Number(l.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    return nums.length ? Math.max(...nums) : null;
  } catch {
    return null;
  }
}

export type PreflightOk = {
  playbook: string[]; // 收據行：驗咗邊啲檔、幾多 bullet
  rig: string[];
};

/** 開場閘。任何檢查唔過＝throw（一次帶齊所有死因收據句）。 */
export function preflightGate(cfg: PreflightConfig = {}): PreflightOk {
  const failures: string[] = [];
  const playbookReceipts: string[] = [];
  const rigReceipts: string[] = [];

  // (a) playbook 檔 schema 驗
  const files = playbookFiles(cfg);
  if (!files.length) {
    playbookReceipts.push("playbook: 冇檔可驗（seats/ projects/ 都未有任何 playbook 檔）");
  }
  let bulletCount = 0;
  for (const file of files) {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    let okBullets = 0;
    for (const [i, raw] of lines.entries()) {
      const t = raw.trim();
      if (!t.startsWith("- ")) continue;
      if (parseBullet(t)) {
        okBullets += 1;
      } else {
        failures.push(
          `preflight playbook: 爛 bullet ${file}:${i + 1}「${t.slice(0, 80)}」— ${BROKEN_BULLET_EVIDENCE}`,
        );
      }
    }
    bulletCount += okBullets;
    playbookReceipts.push(`playbook: ${file} ${failures.length ? "見爛行" : "過驗"}（${okBullets} bullet）`);
  }
  if (bulletCount === 0 && files.length) {
    playbookReceipts.push("playbook: 所有檔零 bullet（全 raw 行——合法但留意係咪剛清倉）");
  }

  // (b) rig/backend probe — skintokens 係咪 GPU
  if (!cfg.skipRigProbe) {
    const bin = cfg.skintokensBin ?? process.env.SKINTOKENS_BIN ?? SKINTOKENS_BIN;
    if (!fs.existsSync(bin)) {
      failures.push(`preflight rig: skintokens bin 唔存在：${bin}`);
    } else {
      rigReceipts.push(`rig: skintokens bin 喺位：${bin}`);
      const cudaLib = path.join(path.dirname(bin), "libggml-cuda.so");
      const hasCuda = fs.existsSync(cudaLib);
      if (!hasCuda) {
        failures.push(
          `preflight rig: ${path.dirname(bin)} 冇 libggml-cuda.so——skintokens 唔係 GPU build，唔開工 — ${GPU_OOM_EVIDENCE}`,
        );
      } else {
        rigReceipts.push(`rig: GPU build 確認（${cudaLib}）`);
      }
      const freeMiB = (cfg.gpuFreeMiB ?? gpuFreeMiBNvidiaSmi)();
      const floor = cfg.minFreeMiB ?? DEFAULT_MIN_FREE_MIB;
      if (freeMiB === null) {
        failures.push(`preflight rig: 量唔到 free VRAM（nvidia-smi 唔得／冇卡）— ${GPU_OOM_EVIDENCE}`);
      } else if (freeMiB < floor) {
        failures.push(
          `preflight rig: free VRAM ${freeMiB}MiB < floor ${floor}MiB，唔開工 — ${GPU_OOM_EVIDENCE}`,
        );
      } else {
        rigReceipts.push(`rig: free VRAM ${freeMiB}MiB ≥ floor ${floor}MiB`);
      }
    }
  }

  if (failures.length) {
    throw new Error(
      `preflight fail（${failures.length} 項，唔開工）：\n${failures.map((f) => `  - ${f}`).join("\n")}`,
    );
  }
  return { playbook: playbookReceipts, rig: rigReceipts };
}
