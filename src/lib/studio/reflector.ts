import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { chatJson, type CrewConfig, type CrewReceipt } from "./crew-llm";
import { BOARDS_CHARTER, WRITER_BEATS_CHARTER, WRITER_OUTLINE_CHARTER } from "./seat-charters";
import { curatePlaybook, type PlaybookOp } from "./playbook";
import { jobDir, seatsDir } from "./paths";

/** The Reflector: the only place a failure becomes a lesson. It is 27B
 *  (`crew.boardsModel`, qwen3.6-35b) and it runs strictly off the hot path —
 *  after the job is already marked failed, never inside a live stage. It may
 *  only propose ops; `curatePlaybook` (code) decides what lands on disk. */

const REFLECTOR_SYSTEM = `你係 Reflector（27B，場外）。一個 produce 標咗 failed 之後你先至行；你永遠唔會喺一個 live stage 入面行。
你收：衰咗嗰個 seat 嘅 charter、每個失敗 attempt 嘅 zod error paths、desk 嘅 repair 線、模型最後輸出嘅節錄、同而家本 playbook。
你交：一個 JSON object，最多 3 個 ops，教下一個 produce 唔好再跌落同一個坑。

規矩：
- 每條 ADD 一定要指住一個真 schema field（field=路徑，例如 cast.stanceEnd、shots.durationSec、language），同一個你喺 error 定輸出節錄入面真係見過嘅值（saw=）。泛泛之談（「小心啲」「檢查格式」）會被 Curator 拒收。
- saw 係一個 token，冇空格，而且一定要係下面證據入面出現過嘅原文——照抄（例如 plant、84.9s、undefined、"null"、zh）。你自己作嘅總結詞（多變、混亂）會被 Curator 拒收。
- rule 係寫俾個 seat 聽嘅一句話：下次見到 saw 呢款值就做咩。
- class 係短嘅失敗類別，一個 token：schema.enum、schema.missing、arithmetic.sum、arithmetic.clock、schema.roster、machine.429 咁。
- 機器級教訓（429 節流、空 JSON、tag 漏出）to:"global"；seat 行為教訓 to:"seat"。
- playbook 已有同 class 同 field 嘅 bullet 就用 UPDATE（帶佢個 id），唔好重複 ADD；完全唔啱用就 REMOVE。
- 冇嘢好學就交 ops:[]。寧願空，都唔好作。
- thinking 寫你點樣由 error path 推到個 class，最多五句。

JSON keys: { thinking, ops:[{ op:"ADD", to:"seat"|"global", class, field, saw, rule } | { op:"UPDATE", to, id, rule?, saw? } | { op:"REMOVE", to, id }] }`;

const opShape = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("ADD"),
    to: z.enum(["seat", "global"]),
    class: z.string().min(1).max(32).regex(/^\S+$/, "class 一定要一個 token，冇空格"),
    field: z.string().min(1).max(64).regex(/^\S+$/, "field 一定要一個 token，冇空格"),
    saw: z.string().min(1).max(48).regex(/^\S+$/, "saw 一定要一個 token，冇空格"),
    rule: z.string().min(1).max(120),
  }),
  z.object({
    op: z.literal("UPDATE"),
    to: z.enum(["seat", "global"]),
    id: z.string().min(1).max(8),
    rule: z.string().min(1).max(120).optional(),
    saw: z.string().min(1).max(48).regex(/^\S+$/, "saw 一定要一個 token，冇空格").optional(),
  }),
  z.object({
    op: z.literal("REMOVE"),
    to: z.enum(["seat", "global"]),
    id: z.string().min(1).max(8),
  }),
]);

export const reflectorOpsSchema = z.object({
  thinking: z.string().min(1).max(600),
  ops: z.array(opShape).max(3),
});

export type ReflectorOps = z.infer<typeof reflectorOpsSchema>;

export type SeatFailure = {
  seat: "writer" | "boards" | null;
  jobError: string;
  /** what the receipts actually show: models on the lane, per-seat counts */
  context: string;
  attempts: { unit: string; attempt: number; errors: string[]; repairs: string[]; contentSlice: string }[];
};

const SEAT_RE = /seat (writer|boards)/;

/** Read one job's grave: job.json + every seat receipt under seats/. The
 *  failing seat is named by the job error first (`seat boards could not
 *  produce valid SC05…`) — filename order would always say "writer", since
 *  w > b. Fallback: the most recently written invalid receipt. A 429 kills a
 *  lane without leaving an invalid receipt, so the error text is the source. */
export function collectSeatFailure(dir: string): SeatFailure | null {
  const jobFile = path.join(dir, "job.json");
  if (!fs.existsSync(jobFile)) return null;
  const job = JSON.parse(fs.readFileSync(jobFile, "utf8")) as { status?: string; error?: string };
  if (job.status !== "failed") return null;
  const seatsDir = path.join(dir, "seats");
  const stamped: { receipt: CrewReceipt; mtime: number }[] = fs.existsSync(seatsDir)
    ? fs.readdirSync(seatsDir)
        .filter((f) => f.endsWith(".json") && !f.startsWith("reflector."))
        .flatMap((f) => {
          try {
            const full = path.join(seatsDir, f);
            return [{ receipt: JSON.parse(fs.readFileSync(full, "utf8")) as CrewReceipt, mtime: fs.statSync(full).mtimeMs }];
          } catch {
            return [];
          }
        })
    : [];
  const receipts = stamped.map((s) => s.receipt);
  const errorSeat = (SEAT_RE.exec(job.error ?? "")?.[1] ?? null) as "writer" | "boards" | null;
  const lastInvalid = stamped
    .filter((s) => !s.receipt.valid)
    .sort((a, b) => a.mtime - b.mtime)
    .at(-1);
  const seat = errorSeat ?? (lastInvalid?.receipt.seat as "writer" | "boards" | undefined) ?? null;
  const invalid = receipts.filter((r) => !r.valid && (!seat || r.seat === seat));
  // enum drift lives at the head of the reply (world/language), sums at the
  // tail — show both, or the model invents summary words the desk never saw
  const slice = (c: string) => {
    const flat = c.replace(/\s+/g, " ");
    return flat.length <= 640 ? flat : `${flat.slice(0, 320)} … ${flat.slice(-320)}`;
  };
  const perSeat = new Map<string, { n: number; bad: number; models: Set<string> }>();
  for (const r of receipts) {
    const s = perSeat.get(r.seat) ?? { n: 0, bad: 0, models: new Set<string>() };
    s.n += 1;
    if (!r.valid) s.bad += 1;
    if (r.model) s.models.add(r.model);
    perSeat.set(r.seat, s);
  }
  return {
    seat,
    jobError: job.error ?? "",
    context: [...perSeat.entries()]
      .map(([s, v]) => `${s}×${v.n}（${[...v.models].join("/") || "?"}，invalid ${v.bad}）`)
      .join("、") || "—",
    attempts: invalid.slice(-8).map((r) => ({
      unit: r.unit,
      attempt: r.attempt,
      // pre-R1 graves predate the repairs field — default, never assume
      errors: (r.errors ?? []).slice(0, 8).map((e) => e.slice(0, 200)),
      repairs: (r.repairs ?? []).slice(0, 8),
      contentSlice: slice(r.content ?? ""),
    })),
  };
}

function charterText(seat: "writer" | "boards" | null): string {
  if (seat === "writer") return `# writer outline charter\n${WRITER_OUTLINE_CHARTER}\n\n# writer beats charter\n${WRITER_BEATS_CHARTER}`;
  if (seat === "boards") return `# boards charter\n${BOARDS_CHARTER}`;
  return "(今次冇 seat 收咪——機器級事故，只有 job error。)";
}

export function buildReflectorUser(jobId: string, failure: SeatFailure, playbookText: string): string {
  const attempts = failure.attempts.length
    ? failure.attempts
        .map(
          (a) =>
            `- unit=${a.unit} attempt=${a.attempt}\n  errors: ${a.errors.join(" | ") || "—"}\n  repairs: ${a.repairs.join(" | ") || "—"}\n  output-slice: ${a.contentSlice || "—"}`,
        )
        .join("\n")
    : "—（冇 invalid receipt：個 job 死喺 HTTP／endpoint，唔係 schema）";
  return [
    `slate: ${jobId}`,
    `seat: ${failure.seat ?? "—"}`,
    `receipts: ${failure.context}`,
    `job error: ${failure.jobError || "—"}`,
    "",
    "## charter",
    charterText(failure.seat),
    "",
    "## 失敗 attempts（zod error paths + repair 線 + 輸出節錄；saw 只可以抄呢度嘅原文）",
    attempts,
    "",
    "## 而家本 playbook（UPDATE/REMOVE 要用呢度嘅 id）",
    playbookText || "—（空）",
  ].join("\n");
}

/** 27B only, and never the writer grading itself: kimi is the writer's quota,
 *  Flash too weak to name the rule, GLM never on this lane. */
function assertReflectorModel(model: string) {
  if (/kimi|glm|flash/i.test(model)) {
    throw new Error(`Reflector refuses model ${model}: not kimi, not Flash, not glm — crew.boardsModel (27B) only`);
  }
}

export type ReflectorOutcome = { receipts: string[]; ops: ReflectorOps["ops"] };

/** Off-path entry point. Runs only when the job on disk is already failed;
 *  proposes ≤3 ops through 27B and lets the Curator write. Returns the
 *  playbook receipt lines for events. */
export async function runReflector(opts: {
  jobId: string;
  crew: CrewConfig;
  seatsDir?: string;
  jobDir?: string;
  fetchImpl?: typeof fetch;
}): Promise<string[]> {
  const dir = opts.jobDir ?? jobDir(opts.jobId);
  const failure = collectSeatFailure(dir);
  if (!failure) return []; // not a failed job (or nothing there): never reflect a live stage
  assertReflectorModel(opts.crew.boardsModel);
  const booksDir = opts.seatsDir ?? seatsDir();
  const playbookText = (["global", failure.seat ?? "global"] as const)
    .filter((s, i, a) => a.indexOf(s) === i)
    .map((s) => `### ${s}.playbook.md\n${fs.existsSync(path.join(booksDir, `${s}.playbook.md`)) ? fs.readFileSync(path.join(booksDir, `${s}.playbook.md`), "utf8") : "(空)"}`)
    .join("\n\n");

  const userText = buildReflectorUser(opts.jobId, failure, playbookText);
  const pass = await chatJson<ReflectorOps>({
    seat: "reflector",
    unit: opts.jobId,
    model: opts.crew.boardsModel,
    crew: opts.crew,
    system: REFLECTOR_SYSTEM,
    user: userText,
    schema: reflectorOpsSchema,
    receiptDir: path.join(dir, "seats"),
    fetchImpl: opts.fetchImpl,
  });

  const seatOps: PlaybookOp[] = [];
  const globalOps: PlaybookOp[] = [];
  for (const op of pass.value.ops) {
    (op.to === "global" ? globalOps : seatOps).push(op as PlaybookOp);
  }
  const receipts: string[] = [];
  // the user prompt IS the evidence: an ADD whose saw the Reflector never
  // actually saw is rejected by the Curator, not by the model's conscience
  if (failure.seat && seatOps.length) {
    receipts.push(...curatePlaybook(failure.seat, seatOps, { src: opts.jobId, dir: booksDir, evidence: userText }).receipts);
  } else if (seatOps.length) {
    receipts.push(`playbook: REJECT ${seatOps.length} seat op(s): no failing seat this time`);
  }
  if (globalOps.length) {
    receipts.push(...curatePlaybook("global", globalOps, { src: opts.jobId, dir: booksDir, evidence: userText }).receipts);
  }
  return receipts;
}
