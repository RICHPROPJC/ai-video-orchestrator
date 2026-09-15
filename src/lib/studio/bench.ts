import fs from "node:fs";
import path from "node:path";
import { readViolations } from "./trace";

/** bench — 事後聚合，零 GPU 零 LLM 零重燒：掃 data/jobs/* 已落碟嘅機器收據
 *（job.json／stills/*.photo_qc.json／motion/*.h3_submit.json／
 * motion/*.video_qc.json／violations.jsonl），按 graph-variant 同 slate 計
 * 綠率、fail-kind 直方圖、席位層死因。
 *
 * 唔評分、唔判決、唔重生——只 aggregate 機器閘已寫低嘅 verdict。
 * 揀 variant（a/b/bkf/c）從此有數據：邊個 variant 綠率高、grey 率低。
 */

export type ShotAgg = {
  shot: string;
  variant: string;
  steps: number;
  seconds: number;
  vqc: "GREEN" | "FAIL" | null;
  failKinds: string[];
};

export type SlateAgg = {
  slate: string;
  status: string;
  errorClass: string | null;
  stills: { green: number; fail: number };
  shots: ShotAgg[];
  hard: number;
  soft: number;
};

export type VariantAgg = {
  shots: number;
  green: number;
  failKinds: Record<string, number>;
  avgSeconds: number;
};

export type BenchReport = {
  generatedAt: string;
  slates: SlateAgg[];
  variants: Record<string, VariantAgg>;
};

/** job.json error → 席位層死因類別（淨係分層，唔斷言因果） */
export function classifyError(err?: string): string | null {
  if (!err) return null;
  if (/429|RateLimit|tpm\/rpm/i.test(err)) return "llm-429";
  if (/fetch failed|ECONN|connection/i.test(err)) return "network";
  if (/^seat writer/i.test(err)) return "writer";
  if (/^seat boards/i.test(err)) return "boards";
  if (/video_qc 未 GREEN/i.test(err)) return "video-qc-block";
  return "other";
}

/** video_qc fail_reasons（"f48: people_count: …"）→ 每鏡 fail-kind 集合 */
export function failKindsFromReasons(reasons: string[]): string[] {
  const kinds = new Set<string>();
  for (const r of reasons) {
    const m = /^f\d+:\s*([a-z_]+):/.exec(r);
    if (m) kinds.add(m[1]);
  }
  return [...kinds].sort();
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readSlate(jobsDir: string, slate: string): SlateAgg | null {
  const dir = path.join(jobsDir, slate);
  const job = readJson(path.join(dir, "job.json"));
  if (!job) return null;

  const stills = { green: 0, fail: 0 };
  const stillsDir = path.join(dir, "stills");
  if (fs.existsSync(stillsDir)) {
    for (const f of fs.readdirSync(stillsDir)) {
      if (!f.endsWith(".photo_qc.json")) continue;
      const q = readJson(path.join(stillsDir, f));
      if (!q) continue;
      if (q.status === "GREEN") stills.green += 1;
      else stills.fail += 1;
    }
  }

  const shots: ShotAgg[] = [];
  const motionDir = path.join(dir, "motion");
  if (fs.existsSync(motionDir)) {
    const shotIds = new Set<string>();
    for (const f of fs.readdirSync(motionDir)) {
      const m = /^(SH\d+)\.(h3_submit|video_qc)\.json$/.exec(f);
      if (m) shotIds.add(m[1]);
    }
    for (const shot of [...shotIds].sort()) {
      const sub = readJson(path.join(motionDir, `${shot}.h3_submit.json`));
      const vqc = readJson(path.join(motionDir, `${shot}.video_qc.json`));
      if (!sub && !vqc) continue;
      let failKinds: string[] = [];
      let verdict: "GREEN" | "FAIL" | null = null;
      if (vqc) {
        verdict = vqc.status === "GREEN" ? "GREEN" : "FAIL";
        const checks = vqc.checks as { fail_reasons?: string[] } | undefined;
        failKinds = verdict === "FAIL" && checks?.fail_reasons ? failKindsFromReasons(checks.fail_reasons) : [];
      }
      shots.push({
        shot,
        variant: typeof sub?.graph_variant === "string" ? (sub.graph_variant as string) : "—",
        steps: typeof sub?.steps === "number" ? (sub.steps as number) : 0,
        seconds: typeof sub?.seconds === "number" ? (sub.seconds as number) : 0,
        vqc: verdict,
        failKinds,
      });
    }
  }

  const violations = readViolations(dir);
  return {
    slate,
    status: typeof job.status === "string" ? job.status : "?",
    errorClass: classifyError(typeof job.error === "string" ? job.error : undefined),
    stills,
    shots,
    hard: violations.filter((v) => v.severity === "hard").length,
    soft: violations.filter((v) => v.severity === "soft").length,
  };
}

function rollupVariants(slates: SlateAgg[]): Record<string, VariantAgg> {
  const out: Record<string, VariantAgg> = {};
  for (const s of slates) {
    for (const sh of s.shots) {
      const v = (out[sh.variant] ??= { shots: 0, green: 0, failKinds: {}, avgSeconds: 0 });
      v.shots += 1;
      if (sh.vqc === "GREEN") v.green += 1;
      for (const k of sh.failKinds) v.failKinds[k] = (v.failKinds[k] ?? 0) + 1;
      v.avgSeconds += sh.seconds; // 先累計，最後除
    }
  }
  for (const v of Object.values(out)) {
    v.avgSeconds = v.shots ? Math.round((v.avgSeconds / v.shots) * 100) / 100 : 0;
  }
  return out;
}

export function bench(jobsDir: string): BenchReport {
  if (!fs.existsSync(jobsDir)) throw new Error(`bench: jobs dir 唔存在 ${jobsDir}`);
  const slates = fs
    .readdirSync(jobsDir)
    .filter((d) => fs.existsSync(path.join(jobsDir, d, "job.json")))
    .sort()
    .map((d) => readSlate(jobsDir, d))
    .filter((s): s is SlateAgg => s !== null);
  return { generatedAt: new Date().toISOString(), slates, variants: rollupVariants(slates) };
}

export function markdownReport(r: BenchReport): string {
  const lines: string[] = [];
  lines.push(`# bench — ${r.generatedAt}`);
  lines.push("");
  lines.push("## graph variants");
  lines.push("| variant | shots | green | rate | avg s | fail kinds |");
  lines.push("|---|---|---|---|---|---|");
  for (const [name, v] of Object.entries(r.variants)) {
    const rate = v.shots ? Math.round((v.green / v.shots) * 100) : 0;
    const kinds = Object.entries(v.failKinds)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k}×${n}`)
      .join(", ");
    lines.push(`| ${name} | ${v.shots} | ${v.green} | ${rate}% | ${v.avgSeconds} | ${kinds || "—"} |`);
  }
  lines.push("");
  lines.push("## slates");
  lines.push("| slate | status | 死因 | stills G/F | motion G/F | hard/soft |");
  lines.push("|---|---|---|---|---|---|");
  for (const s of r.slates) {
    const g = s.shots.filter((x) => x.vqc === "GREEN").length;
    const f = s.shots.filter((x) => x.vqc === "FAIL").length;
    lines.push(
      `| ${s.slate} | ${s.status} | ${s.errorClass ?? "—"} | ${s.stills.green}/${s.stills.fail} | ${g}/${f} | ${s.hard}/${s.soft} |`,
    );
  }
  return lines.join("\n");
}
