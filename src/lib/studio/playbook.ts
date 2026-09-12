import fs from "node:fs";
import path from "node:path";
import { PLAYBOOK_SEATS, seatPlaybookPath, type PlaybookSeat } from "./paths";

/** The playbook layer: what a seat learned, in bullets Chau can read and veto
 *  in git. The charter is law and never changes here; this file is the only
 *  writer, and it is code — no model ever rewrites a playbook wholesale. */

export type BulletStatus = "trial" | "proven";

export type PlaybookBullet = {
  id: string;
  class: string;
  field: string;
  saw: string;
  rule: string;
  hits: number;
  status: BulletStatus;
  src: string;
};

/** A Reflector op. `to` routes it to the seat's own file or the global one. */
export type PlaybookOp =
  | { op: "ADD"; to: "seat" | "global"; class: string; field: string; saw: string; rule: string }
  | { op: "UPDATE"; to: "seat" | "global"; id: string; rule?: string; saw?: string }
  | { op: "REMOVE"; to: "seat" | "global"; id: string };

export const CAP_BULLETS = 30;
export const CAP_TOKENS = 1500;

const BULLET_RE =
  /^- \[([a-z]\d+)\] (\S+) field=(\S+) saw=(\S+) rule=(.+?) hits=(\d+) status=(trial|proven) src=(\S+)$/;

const ID_PREFIX: Record<PlaybookSeat, string> = { writer: "w", boards: "b", global: "g" };

export function renderBullet(b: PlaybookBullet): string {
  return `- [${b.id}] ${b.class} field=${b.field} saw=${b.saw} rule=${b.rule} hits=${b.hits} status=${b.status} src=${b.src}`;
}

/** Rough token estimate: CJK reads ~1 token/char, the rest ~4 chars/token. */
export function estimateTokens(text: string): number {
  const cjk = text.match(/[　-ヿ㐀-鿿豈-﫿＀-￯]/g)?.length ?? 0;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

/** Strict shape, law of call 3: no field name + observed value, no bullet. */
export function parseBullet(line: string): PlaybookBullet | null {
  const m = BULLET_RE.exec(line.trim());
  if (!m) return null;
  return {
    id: m[1]!,
    class: m[2]!,
    field: m[3]!,
    saw: m[4]!,
    rule: m[5]!.trim(),
    hits: Number(m[6]),
    status: m[7] as BulletStatus,
    src: m[8]!,
  };
}

/** A file is an ordered list of lines. Valid bullets are curated; anything
 *  else (Chau's header notes, hand edits) is carried verbatim so a human line
 *  never silently disappears under a rewrite. */
export type PlaybookLine = { kind: "bullet"; bullet: PlaybookBullet } | { kind: "raw"; text: string };

const FILE_HEADER: Record<PlaybookSeat, string> = {
  writer: "# writer playbook — 阿文學過嘅教訓（Curator 代碼寫；Chau 刪一行即否決）",
  boards: "# boards playbook — 阿圖學過嘅教訓（Curator 代碼寫；Chau 刪一行即否決）",
  global: "# global playbook — 機器級教訓，全部 seat 共用（Curator 代碼寫；Chau 刪一行即否決）",
};

export function parsePlaybookLines(text: string): PlaybookLine[] {
  return text
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .map((l) => {
      const bullet = l.trim().startsWith("- ") ? parseBullet(l) : null;
      return bullet ? { kind: "bullet", bullet } : { kind: "raw", text: l };
    });
}

export function renderPlaybookLines(lines: PlaybookLine[]): string {
  return `${lines.map((l) => (l.kind === "bullet" ? renderBullet(l.bullet) : l.text)).join("\n")}\n`;
}

export function loadPlaybookLines(seat: PlaybookSeat, dir?: string): PlaybookLine[] {
  const file = seatPlaybookPath(seat, dir);
  if (!fs.existsSync(file)) return [];
  return parsePlaybookLines(fs.readFileSync(file, "utf8"));
}

export function bulletsOf(lines: PlaybookLine[]): PlaybookBullet[] {
  return lines.filter((l): l is { kind: "bullet"; bullet: PlaybookBullet } => l.kind === "bullet").map((l) => l.bullet);
}

/** Deterministic write: render from structure only, never from model prose. */
export function writePlaybook(seat: PlaybookSeat, lines: PlaybookLine[], dir?: string): string {
  const file = seatPlaybookPath(seat, dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = lines.some((l) => l.kind === "raw" && l.text === FILE_HEADER[seat])
    ? renderPlaybookLines(lines)
    : renderPlaybookLines([{ kind: "raw", text: FILE_HEADER[seat] }, ...lines]);
  fs.writeFileSync(file, body);
  return file;
}

export function loadPlaybook(seat: PlaybookSeat, dir?: string): PlaybookBullet[] {
  return bulletsOf(loadPlaybookLines(seat, dir));
}

function nextId(seat: PlaybookSeat, bullets: PlaybookBullet[]): string {
  const prefix = ID_PREFIX[seat];
  const max = bullets.reduce((a, b) => {
    const m = /^([a-z])(\d+)$/.exec(b.id);
    return m && m[1] === prefix ? Math.max(a, Number(m[2])) : a;
  }, 0);
  return `${prefix}${max + 1}`;
}

const fits = (s: string, n: number) => s.length <= n;

/** Validate one ADD. Generic advice (no field, no observed value) is rejected
 *  here — the ACE brevity-bias guard is code, not the model's conscience. */
function validateAdd(op: Extract<PlaybookOp, { op: "ADD" }>): string | null {
  if (!op.class?.trim() || /\s/.test(op.class)) return "class missing or has spaces";
  if (!op.field?.trim() || /\s/.test(op.field)) return "field missing or has spaces";
  if (!op.saw?.trim() || /\s/.test(op.saw)) return "saw missing or has spaces";
  if (!op.rule?.trim()) return "rule missing";
  if (!fits(op.field, 64)) return "field too long";
  if (!fits(op.saw, 48)) return "saw too long";
  if (op.rule.length > 120) return "rule too long";
  return null;
}

export type ApplyResult = {
  lines: PlaybookLine[];
  receipts: string[];
  rejected: string[];
  touchedIds: string[];
};

/** Apply ops to one file's lines. ADD dedupes on (class, field) by merging
 *  into the existing bullet (hits+1, evidence recorded) instead of stacking
 *  twins. UPDATE/REMOVE target ids; unknown ids are rejected, never guessed.
 *  With `evidence` set, an ADD whose saw never appears in what the Reflector
 *  was shown is rejected — an observed value has to have been observed. */
export function applyOps(
  seat: PlaybookSeat,
  lines: PlaybookLine[],
  ops: PlaybookOp[],
  ctx: { src: string; evidence?: string },
): ApplyResult {
  const receipts: string[] = [];
  const rejected: string[] = [];
  const touchedIds: string[] = [];
  let out = [...lines];

  for (const op of ops) {
    if (op.op === "ADD") {
      const bad = validateAdd(op) ?? (ctx.evidence && !ctx.evidence.includes(op.saw)
        ? `saw=${op.saw} never appears in this grave's receipts — not an observed value`
        : null);
      if (bad) {
        rejected.push(`ADD ${op.field || "(no field)"}: ${bad}`);
        continue;
      }
      const bullets = bulletsOf(out);
      const twin = bullets.find((b) => b.class === op.class && b.field === op.field);
      if (twin) {
        out = out.map((l) =>
          l.kind === "bullet" && l.bullet.id === twin.id
            ? { kind: "bullet", bullet: { ...l.bullet, saw: op.saw, rule: op.rule, hits: l.bullet.hits + 1 } }
            : l,
        );
        touchedIds.push(twin.id);
        receipts.push(`playbook: ${seat} MERGE ${twin.id} ${op.class} field=${op.field} saw=${op.saw} hits=${twin.hits + 1} (${ctx.src})`);
      } else {
        const id = nextId(seat, bullets);
        out = [...out, { kind: "bullet", bullet: { id, class: op.class, field: op.field, saw: op.saw, rule: op.rule, hits: 1, status: "trial", src: ctx.src } }];
        touchedIds.push(id);
        receipts.push(`playbook: ${seat} ADD ${id} ${op.class} field=${op.field} saw=${op.saw} trial (${ctx.src})`);
      }
      continue;
    }
    if (op.op === "UPDATE") {
      const idx = out.findIndex((l) => l.kind === "bullet" && l.bullet.id === op.id);
      if (idx < 0) {
        rejected.push(`UPDATE ${op.id}: no such bullet`);
        continue;
      }
      const b = (out[idx] as { kind: "bullet"; bullet: PlaybookBullet }).bullet;
      let saw = b.saw;
      if (op.saw) {
        if (/\s/.test(op.saw)) rejected.push(`UPDATE ${op.id}: saw has spaces, kept ${b.saw}`);
        else if (ctx.evidence && !ctx.evidence.includes(op.saw)) {
          rejected.push(`UPDATE ${op.id}: saw=${op.saw} never appears in this grave's receipts — kept ${b.saw}`);
        } else saw = op.saw;
      }
      const rule = op.rule?.trim() || b.rule;
      out[idx] = { kind: "bullet", bullet: { ...b, saw, rule } };
      touchedIds.push(b.id);
      receipts.push(`playbook: ${seat} UPDATE ${b.id} field=${b.field} (${ctx.src})`);
      continue;
    }
    if (op.op === "REMOVE") {
      const idx = out.findIndex((l) => l.kind === "bullet" && l.bullet.id === op.id);
      if (idx < 0) {
        rejected.push(`REMOVE ${op.id}: no such bullet`);
        continue;
      }
      const b = (out[idx] as { kind: "bullet"; bullet: PlaybookBullet }).bullet;
      out.splice(idx, 1);
      receipts.push(`playbook: ${seat} REMOVE ${b.id} ${b.class} field=${b.field} (${ctx.src})`);
    }
  }
  return { lines: out, receipts, rejected, touchedIds };
}

/** Cap: 30 bullets or ~1500 tokens per file. Evict lowest hits first, and
 *  among equals the oldest (earliest line wins tenure). */
export function enforceCap(seat: PlaybookSeat, lines: PlaybookLine[]): { lines: PlaybookLine[]; evicted: string[] } {
  const evicted: string[] = [];
  let out = [...lines];
  for (;;) {
    const bullets = bulletsOf(out);
    const tokens = estimateTokens(renderPlaybookLines(out));
    if (bullets.length <= CAP_BULLETS && tokens <= CAP_TOKENS) break;
    let victim = -1;
    let victimScore = "";
    for (const [i, l] of out.entries()) {
      if (l.kind !== "bullet") continue;
      // lowest hits, then oldest: a stable key makes ties resolve by line order
      const score = `${String(l.bullet.hits).padStart(6, "0")}:${String(i).padStart(6, "0")}`;
      if (victim < 0 || score < victimScore) {
        victim = i;
        victimScore = score;
      }
    }
    if (victim < 0) break;
    const b = (out[victim] as { kind: "bullet"; bullet: PlaybookBullet }).bullet;
    evicted.push(`${b.id} ${b.class} field=${b.field} hits=${b.hits}`);
    out.splice(victim, 1);
  }
  return { lines: out, evicted };
}

/** Ship gate: a bullet in the prompt during a PASS of that stage becomes
 *  proven, hits++. Called with the seat's own file plus global. */
export function markPass(seats: PlaybookSeat[], dir?: string): string[] {
  const receipts: string[] = [];
  for (const seat of seats) {
    const lines = loadPlaybookLines(seat, dir);
    let changed = false;
    const out: PlaybookLine[] = lines.map((l): PlaybookLine => {
      if (l.kind !== "bullet" || l.bullet.status !== "trial") return l;
      changed = true;
      return { kind: "bullet", bullet: { ...l.bullet, status: "proven", hits: l.bullet.hits + 1 } };
    });
    if (changed) {
      writePlaybook(seat, out, dir);
      const promoted = bulletsOf(out).filter((b) => b.status === "proven").map((b) => b.id);
      receipts.push(`playbook: ${seat} PASS promote ${promoted.join(",")}`);
    }
  }
  return receipts;
}

/** Self-eviction: a trial bullet from an earlier produce that sat in the
 *  prompt through another fail of the same class (and no PASS) is removed.
 *  Bullets just touched by this round's ops carry the new evidence instead. */
export function evictFailedTrials(
  seat: PlaybookSeat,
  lines: PlaybookLine[],
  ctx: { classes: string[]; src: string; keepIds: string[] },
): { lines: PlaybookLine[]; receipts: string[] } {
  const classes = new Set(ctx.classes);
  const keep = new Set(ctx.keepIds);
  const receipts: string[] = [];
  const out = lines.filter((l) => {
    if (l.kind !== "bullet") return true;
    const b = l.bullet;
    if (b.status === "trial" && classes.has(b.class) && b.src !== ctx.src && !keep.has(b.id)) {
      receipts.push(`playbook: ${seat} AUTO-REMOVE ${b.id} ${b.class} field=${b.field} (trial failed again at ${ctx.src})`);
      return false;
    }
    return true;
  });
  return { lines: out, receipts };
}

/** The Curator entry point: ops in, deterministic file out, receipts for
 *  every change. Never rewrites a line a model produced. */
export function curatePlaybook(
  seat: PlaybookSeat,
  ops: PlaybookOp[],
  ctx: { src: string; dir?: string; evidence?: string },
): { receipts: string[]; rejected: string[] } {
  if (!PLAYBOOK_SEATS.includes(seat)) {
    return { receipts: [], rejected: [`unknown seat ${seat}`] };
  }
  if (!ops.length) return { receipts: [], rejected: [] };
  const before = loadPlaybookLines(seat, ctx.dir);
  const applied = applyOps(seat, before, ops, ctx);
  const evicted = evictFailedTrials(seat, applied.lines, {
    classes: ops.flatMap((op) => (op.op === "ADD" ? [op.class] : [])),
    src: ctx.src,
    keepIds: applied.touchedIds,
  });
  const capped = enforceCap(seat, evicted.lines);
  const receipts = [
    ...applied.receipts,
    ...evicted.receipts,
    ...capped.evicted.map((e) => `playbook: ${seat} CAP-EVICT ${e}`),
  ];
  if (receipts.length) writePlaybook(seat, capped.lines, ctx.dir);
  return { receipts: [...receipts, ...applied.rejected.map((r) => `playbook: ${seat} REJECT ${r}`)], rejected: applied.rejected };
}

/** Prompt assembly: every seat's system = charter + global playbook + own
 *  playbook. Returns the exact bullets included, for the PASS gate. */
export function assemblePlaybook(
  seat: "writer" | "boards",
  dir?: string,
): { text: string; bullets: PlaybookBullet[] } {
  if (!dir) return { text: "", bullets: [] };
  const global = loadPlaybook("global", dir);
  const own = loadPlaybook(seat, dir);
  const bullets = [...global, ...own];
  if (!bullets.length) return { text: "", bullets: [] };
  const text = [
    "",
    "## Playbook（以前衰過先學返嚟；交之前逐條照做，唔准再犯）",
    ...(global.length ? ["### 機器級（全部檯通用）", ...global.map(renderBullet)] : []),
    ...(own.length ? [`### ${seat} 檯`, ...own.map(renderBullet)] : []),
    "### 學過嘅教訓到此，跟住落嚟係你嘅 charter 規矩。",
  ].join("\n");
  return { text, bullets };
}
