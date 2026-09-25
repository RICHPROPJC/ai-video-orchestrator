import fs from "node:fs";
import path from "node:path";
import { entityTokens as nounLintTokens } from "./noun-lint";
import {
  PLAYBOOK_SCOPES,
  dramasWithPlaybooks,
  playbookPath,
  projectsDir,
  projectsRootFromSeatsDir,
  seatsDir,
  type PlaybookAddress,
  type PlaybookScope,
} from "./paths";

/** The playbook layer: what a seat learned, in bullets Chau can read and veto
 *  in git. The charter is law and never changes here; this file is the only
 *  writer, and it is code — no model ever rewrites a playbook wholesale.
 *
 *  Call 6 L1 — a file is lifetime × scope:
 *    seats/<scope>.primitive.md      cross-drama, one seat or all seats
 *    projects/<drama>/playbook/<scope>.md   one drama's nouns, seat or all
 *  The noun test: a bullet proposed for a primitive file that names any entity
 *  token is demoted to the drama file, so no drama's lesson can leak into
 *  another drama's prompt. Promotion drama → primitive is never automatic. */

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

/** A Curator op. The curate call names the scope; the noun test decides the
 *  lifetime. (The Reflector's seat-vs-all intent is translated by reflector.ts.) */
export type PlaybookOp =
  | { op: "ADD"; class: string; field: string; saw: string; rule: string }
  | { op: "UPDATE"; id: string; rule?: string; saw?: string }
  | { op: "REMOVE"; id: string };

export const CAP_TOKENS = 1500;

const BULLET_RE =
  /^- \[([a-z]\d+)\] (\S+) field=(\S+) saw=(\S+) rule=(.+?) hits=(\d+) status=(trial|proven) src=(\S+)$/;

/** "all" keeps the g-series: migrated bullets keep their ids, so an UPDATE
 *  from an older grave still finds its bullet after the split. */
const ID_PREFIX: Record<PlaybookScope, string> = { writer: "w", boards: "b", all: "g" };

const SCOPE_LABEL: Record<PlaybookScope, string> = { writer: "writer 檯", boards: "boards 檯", all: "全部檯" };

export function renderBullet(b: PlaybookBullet): string {
  return `- [${b.id}] ${b.class} field=${b.field} saw=${b.saw} rule=${b.rule} hits=${b.hits} status=${b.status} src=${b.src}`;
}

/** Rough token estimate: CJK reads ~1 token/char, the rest ~4 chars/token. */
export function estimateTokens(text: string): number {
  const cjk = text.match(/[　-ヿ㐀-鿿豈-﫿＀-￯]/g)?.length ?? 0;
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

function fileHeader(addr: PlaybookAddress): string {
  return addr.lifetime === "primitive"
    ? `# ${addr.scope} primitive playbook — ${SCOPE_LABEL[addr.scope]}跨劇目教訓（Curator 代碼寫；Chau 刪一行即否決）`
    : `# ${addr.drama} ${addr.scope} playbook — ${SCOPE_LABEL[addr.scope]}喺呢個劇目先啱用（Curator 代碼寫；Chau 刪一行即否決）`;
}

/** Receipt tag: `boards` for the primitive file, `_d1a/boards` for a drama's. */
function addrTag(addr: PlaybookAddress): string {
  return addr.lifetime === "primitive" ? addr.scope : `${addr.drama}/${addr.scope}`;
}

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

export function loadPlaybookLines(addr: PlaybookAddress): PlaybookLine[] {
  const file = playbookPath(addr);
  if (!fs.existsSync(file)) return [];
  return parsePlaybookLines(fs.readFileSync(file, "utf8"));
}

export function bulletsOf(lines: PlaybookLine[]): PlaybookBullet[] {
  return lines.filter((l): l is { kind: "bullet"; bullet: PlaybookBullet } => l.kind === "bullet").map((l) => l.bullet);
}

/** Deterministic write: render from structure only, never from model prose. */
export function writePlaybook(addr: PlaybookAddress, lines: PlaybookLine[]): string {
  const file = playbookPath(addr);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const header = fileHeader(addr);
  const body = lines.some((l) => l.kind === "raw" && l.text === header)
    ? renderPlaybookLines(lines)
    : renderPlaybookLines([{ kind: "raw", text: header }, ...lines]);
  fs.writeFileSync(file, body);
  return file;
}

/** Primitive-file convenience read. Unknown or retired scope names read as
 *  empty — a legacy caller must never crash, and never see the wrong file. */
export function loadPlaybook(scope: PlaybookScope | string, dir?: string): PlaybookBullet[] {
  if (!PLAYBOOK_SCOPES.includes(scope as PlaybookScope)) return [];
  return bulletsOf(loadPlaybookLines({ lifetime: "primitive", scope: scope as PlaybookScope, dir }));
}

function nextId(scope: PlaybookScope, bullets: PlaybookBullet[]): string {
  const prefix = ID_PREFIX[scope];
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
  addr: PlaybookAddress,
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
        receipts.push(`playbook: ${addrTag(addr)} MERGE ${twin.id} ${op.class} field=${op.field} saw=${op.saw} hits=${twin.hits + 1} (${ctx.src})`);
      } else {
        const id = nextId(addr.scope, bullets);
        out = [...out, { kind: "bullet", bullet: { id, class: op.class, field: op.field, saw: op.saw, rule: op.rule, hits: 1, status: "trial", src: ctx.src } }];
        touchedIds.push(id);
        receipts.push(`playbook: ${addrTag(addr)} ADD ${id} ${op.class} field=${op.field} saw=${op.saw} trial (${ctx.src})`);
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
      receipts.push(`playbook: ${addrTag(addr)} UPDATE ${b.id} field=${b.field} (${ctx.src})`);
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
      receipts.push(`playbook: ${addrTag(addr)} REMOVE ${b.id} ${b.class} field=${b.field} (${ctx.src})`);
    }
  }
  return { lines: out, receipts, rejected, touchedIds };
}

/** Cap: ~1500 tokens per file. Evict lowest hits first, and among equals the
 *  oldest (earliest line wins tenure). */
export function enforceCap(lines: PlaybookLine[]): { lines: PlaybookLine[]; evicted: string[] } {
  const evicted: string[] = [];
  let out = [...lines];
  for (;;) {
    const bullets = bulletsOf(out);
    const tokens = estimateTokens(renderPlaybookLines(out));
    if (bullets.length === 0 || tokens <= CAP_TOKENS) break;
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

/** Ship gate: a trial bullet that rode the prompt through a PASS of that
 *  stage becomes proven, hits++. `scopes` names the scopes whose files were
 *  in the prompt; each scope's primitive file and drama files are promoted.
 *  Retired scope names (legacy callers still pass one) are skipped. */
export function markPass(scopes: string[], dir?: string, drama?: string): string[] {
  if (!dir) return []; // nothing was wired into a prompt — and a test must never touch the real seats/
  const receipts: string[] = [];
  const proot = projectsRootFromSeatsDir(dir);
  const named = drama?.trim();
  for (const raw of scopes) {
    if (!PLAYBOOK_SCOPES.includes(raw as PlaybookScope)) continue;
    const scope = raw as PlaybookScope;
    const addrs: PlaybookAddress[] = [
      { lifetime: "primitive", scope, dir },
      ...(named ? [{ lifetime: "drama" as const, scope, drama: named, dir: proot }] : []),
    ];
    for (const addr of addrs) {
      const lines = loadPlaybookLines(addr);
      let changed = false;
      const out: PlaybookLine[] = lines.map((l): PlaybookLine => {
        if (l.kind !== "bullet" || l.bullet.status !== "trial") return l;
        changed = true;
        return { kind: "bullet", bullet: { ...l.bullet, status: "proven", hits: l.bullet.hits + 1 } };
      });
      if (changed) {
        writePlaybook(addr, out);
        const promoted = bulletsOf(out).filter((b) => b.status === "proven").map((b) => b.id);
        receipts.push(`playbook: ${addrTag(addr)} PASS promote ${promoted.join(",")}`);
      }
    }
  }
  return receipts;
}

/** Self-eviction: a trial bullet from an earlier produce that sat in the
 *  prompt through another fail of the same class (and no PASS) is removed.
 *  Bullets just touched by this round's ops carry the new evidence instead. */
export function evictFailedTrials(
  addr: PlaybookAddress,
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
      receipts.push(`playbook: ${addrTag(addr)} AUTO-REMOVE ${b.id} ${b.class} field=${b.field} (trial failed again at ${ctx.src})`);
      return false;
    }
    return true;
  });
  return { lines: out, receipts };
}

/** Same lintable thresholds as noun-lint's isLintableToken (CJK ≥2 chars,
 *  ASCII ≥4) — parity is pinned by test against noun-lint's entityTokens. */
function isLintableToken(token: string): boolean {
  const cjk = /[一-鿿]/.test(token);
  return token.trim().length >= (cjk ? 2 : 4);
}

/** Entity tokens per drama, dramas sorted — the deterministic routing order.
 *  Mirrors how noun-lint reads projects/<drama>/entities.json. */
export function dramaEntityTokens(projectsRoot: string): { drama: string; tokens: string[] }[] {
  if (!fs.existsSync(projectsRoot)) return [];
  const out: { drama: string; tokens: string[] }[] = [];
  const dramas = fs
    .readdirSync(projectsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  for (const drama of dramas) {
    const file = path.join(projectsRoot, drama, "entities.json");
    if (!fs.existsSync(file)) continue;
    let data: { nouns?: unknown };
    try {
      data = JSON.parse(fs.readFileSync(file, "utf8")) as { nouns?: unknown };
    } catch {
      continue; // unreadable sheet: that drama contributes no tokens
    }
    if (!Array.isArray(data.nouns)) continue;
    const tokens = [...new Set(data.nouns.filter((t): t is string => typeof t === "string" && isLintableToken(t)))];
    if (tokens.length) out.push({ drama, tokens });
  }
  return out;
}

export function allEntityTokens(projectsRoot: string): string[] {
  return [...new Set(dramaEntityTokens(projectsRoot).flatMap((d) => d.tokens))];
}

/** The noun test: the first drama in sorted order whose sheet the text names. */
function entityDrama(text: string, perDrama: { drama: string; tokens: string[] }[]): { drama: string; token: string } | null {
  for (const { drama, tokens } of perDrama) {
    const token = tokens.find((t) => text.includes(t));
    if (token) return { drama, token };
  }
  return null;
}

export type CurateCtx = {
  src: string;
  /** seats/ root for the primitive files (default: the repo's). */
  seatsDir?: string;
  /** projects/ root for drama files (default: the seats dir's sibling). */
  projectsDir?: string;
  /** the drama this failure belongs to — where entity-noun bullets land. */
  drama?: string;
  evidence?: string;
};

/** The Curator entry point: ops in, deterministic files out, receipts for
 *  every change. Never rewrites a line a model produced. The noun test runs
 *  before anything touches disk — an op naming an entity token never enters
 *  the primitive file: it is demoted to `drama`'s file (or rejected outright
 *  when no drama is in play, because primitive files stay noun-free either way). */
export function curatePlaybook(
  scope: PlaybookScope,
  ops: PlaybookOp[],
  ctx: CurateCtx,
): { receipts: string[]; rejected: string[] } {
  if (!PLAYBOOK_SCOPES.includes(scope)) {
    return { receipts: [], rejected: [`unknown scope ${scope}`] };
  }
  if (!ops.length) return { receipts: [], rejected: [] };

  const seats = ctx.seatsDir ?? seatsDir();
  const proot = ctx.projectsDir ?? projectsRootFromSeatsDir(seats);
  const perDrama = dramaEntityTokens(proot);
  const primitive: PlaybookAddress = { lifetime: "primitive", scope, dir: seats };
  const receipts: string[] = [];
  const rejected: string[] = [];

  const primLines = loadPlaybookLines(primitive);
  const dramaLines = new Map<string, PlaybookLine[]>();
  const dramaAddr = (drama: string): PlaybookAddress => ({ lifetime: "drama", scope, drama, dir: proot });
  const linesOf = (drama: string): PlaybookLine[] => {
    if (!dramaLines.has(drama)) dramaLines.set(drama, loadPlaybookLines(dramaAddr(drama)));
    return dramaLines.get(drama)!;
  };
  /** where does this id live today — primitive first, then dramas in sorted order */
  const locate = (id: string): { addr: PlaybookAddress; lines: PlaybookLine[] } | null => {
    if (bulletsOf(primLines).some((b) => b.id === id)) return { addr: primitive, lines: primLines };
    for (const { drama } of perDrama) {
      if (!dramaLines.has(drama) && !fs.existsSync(playbookPath(dramaAddr(drama)))) continue;
      if (bulletsOf(linesOf(drama)).some((b) => b.id === id)) return { addr: dramaAddr(drama), lines: linesOf(drama) };
    }
    return null;
  };

  const primOps: PlaybookOp[] = [];
  const opsByDrama = new Map<string, PlaybookOp[]>();
  const demote = (drama: string, op: PlaybookOp) => {
    opsByDrama.set(drama, [...(opsByDrama.get(drama) ?? []), op]);
  };

  for (const op of ops) {
    const opText =
      op.op === "ADD" ? `${op.class} ${op.field} ${op.saw} ${op.rule}` : op.op === "UPDATE" ? `${op.rule ?? ""} ${op.saw ?? ""}` : "";
    const hit = entityDrama(opText, perDrama);
    if (op.op === "ADD") {
      if (!hit) primOps.push(op);
      else if (ctx.drama) {
        demote(ctx.drama, op);
        receipts.push(`playbook: DEMOTE → ${ctx.drama}/${scope} (entity noun ${hit.token})`);
      } else {
        rejected.push(`ADD ${op.field}: names entity noun ${hit.token} but no drama in play — a primitive file stays noun-free`);
      }
      continue;
    }
    // UPDATE / REMOVE follow the id, not the text
    const found = locate(op.id);
    if (!found) {
      rejected.push(`${op.op} ${op.id}: no such bullet`);
      continue;
    }
    if (found.addr.lifetime === "drama") {
      demote(found.addr.drama, op);
      continue;
    }
    if (hit) {
      // an UPDATE would push an entity noun into a primitive bullet — the law wins
      rejected.push(`${op.op} ${op.id}: names entity noun ${hit.token} — primitive bullets stay noun-free, kept as-is`);
      continue;
    }
    primOps.push(op);
  }

  const classes = ops.filter((op): op is Extract<PlaybookOp, { op: "ADD" }> => op.op === "ADD").map((op) => op.class);
  const changed: { addr: PlaybookAddress; lines: PlaybookLine[] }[] = [];

  if (primOps.length) {
    const applied = applyOps(primitive, primLines, primOps, ctx);
    const evicted = evictFailedTrials(primitive, applied.lines, { classes, src: ctx.src, keepIds: applied.touchedIds });
    const capped = enforceCap(evicted.lines);
    receipts.push(...applied.receipts, ...evicted.receipts, ...capped.evicted.map((e) => `playbook: ${addrTag(primitive)} CAP-EVICT ${e}`));
    rejected.push(...applied.rejected);
    if (applied.receipts.length || evicted.receipts.length) changed.push({ addr: primitive, lines: capped.lines });
  }

  for (const [drama, dramaOps] of opsByDrama) {
    const addr = dramaAddr(drama);
    const applied = applyOps(addr, linesOf(drama), dramaOps, ctx);
    const evicted = evictFailedTrials(addr, applied.lines, { classes, src: ctx.src, keepIds: applied.touchedIds });
    const capped = enforceCap(evicted.lines);
    receipts.push(...applied.receipts, ...evicted.receipts, ...capped.evicted.map((e) => `playbook: ${addrTag(addr)} CAP-EVICT ${e}`));
    rejected.push(...applied.rejected);
    if (applied.receipts.length || evicted.receipts.length) changed.push({ addr, lines: capped.lines });
  }

  for (const { addr, lines } of changed) writePlaybook(addr, lines);
  return { receipts, rejected };
}

/** Prompt assembly: charter stays outside. Public bullets are seats/*.primitive.md.
 *  A project playbook is included only when `drama` names it. One project on disk
 *  is not a guess — mixing it into a job that did not name it cross-pollinates. */
export function assemblePlaybook(
  seat: "writer" | "boards",
  dir?: string,
  drama?: string,
): { text: string; bullets: PlaybookBullet[] } {
  if (!dir) return { text: "", bullets: [] };
  const proot = projectsRootFromSeatsDir(dir);
  const named = drama?.trim();
  const sections: { label: string; addr: PlaybookAddress }[] = [
    { label: "### 全部 seat（跨劇目）", addr: { lifetime: "primitive", scope: "all", dir } },
    ...(named ? [{ label: `### 全部 seat（劇目 ${named}）`, addr: { lifetime: "drama" as const, scope: "all" as const, drama: named, dir: proot } }] : []),
    { label: `### ${seat} 檯（跨劇目）`, addr: { lifetime: "primitive", scope: seat, dir } },
    ...(named ? [{ label: `### ${seat} 檯（劇目 ${named}）`, addr: { lifetime: "drama" as const, scope: seat, drama: named, dir: proot } }] : []),
  ];
  const loaded = sections
    .map((s) => ({ ...s, bullets: bulletsOf(loadPlaybookLines(s.addr)) }))
    .filter((s) => s.bullets.length);
  const bullets = loaded.flatMap((s) => s.bullets);
  if (!bullets.length) return { text: "", bullets: [] };
  const text = [
    "",
    "## Playbook（以前衰過先學返嚟；交之前逐條照做，唔准再犯）",
    ...loaded.flatMap((s) => [s.label, ...s.bullets.map(renderBullet)]),
    "### 學過嘅教訓到此，跟住落嚟係你嘅 charter 規矩。",
  ].join("\n");
  return { text, bullets };
}

/** Retired file headers, dropped verbatim on migration; anything else a human
 *  wrote rides the same noun test as the bullets. */
const RETIRED_HEADERS = new Set([
  "# writer playbook — 阿文學過嘅教訓（Curator 代碼寫；Chau 刪一行即否決）",
  "# boards playbook — 阿圖學過嘅教訓（Curator 代碼寫；Chau 刪一行即否決）",
  "# global playbook — 機器級教訓，全部 seat 共用（Curator 代碼寫；Chau 刪一行即否決）",
]);

const LEGACY_FILES: { name: string; scope: PlaybookScope }[] = [
  { name: "writer.playbook.md", scope: "writer" },
  { name: "boards.playbook.md", scope: "boards" },
  { name: "global.playbook.md", scope: "all" },
];

/** One-off deterministic migration (call 6 L1): the seeded writer/boards/all
 *  bullets move into the lifetime × scope layout by the same noun test the
 *  Curator uses. A line naming an entity token lands in the first sorted
 *  drama owning that token; everything else lands in the primitive file.
 *  Every migrated line lands in exactly one file, ids are preserved, the
 *  legacy files are removed. Idempotent: no legacy files → no-op. */
export function migrateLegacyPlaybooks(opts?: { seatsDir?: string; projectsDir?: string }): { receipts: string[] } {
  const seats = opts?.seatsDir ?? seatsDir();
  const proot = opts?.projectsDir ?? projectsRootFromSeatsDir(seats);
  const perDrama = dramaEntityTokens(proot);
  const receipts: string[] = [];
  const primBuckets = new Map<PlaybookScope, PlaybookLine[]>();
  const dramaBuckets = new Map<string, { drama: string; scope: PlaybookScope; lines: PlaybookLine[] }>();

  for (const { name, scope } of LEGACY_FILES) {
    const file = path.join(seats, name);
    if (!fs.existsSync(file)) continue;
    let primitiveCount = 0;
    let dramaCount = 0;
    for (const line of parsePlaybookLines(fs.readFileSync(file, "utf8"))) {
      if (line.kind === "raw" && RETIRED_HEADERS.has(line.text)) continue;
      const text = line.kind === "bullet" ? renderBullet(line.bullet) : line.text;
      const hit = entityDrama(text, perDrama);
      if (!hit) {
        primBuckets.set(scope, [...(primBuckets.get(scope) ?? []), line]);
        primitiveCount += 1;
        continue;
      }
      const key = `${hit.drama}/${scope}`;
      const bucket = dramaBuckets.get(key) ?? { drama: hit.drama, scope, lines: [] };
      bucket.lines = [...bucket.lines, line];
      dramaBuckets.set(key, bucket);
      dramaCount += 1;
      receipts.push(`playbook: DEMOTE ${line.kind === "bullet" ? line.bullet.id : "(note)"} → ${key} (entity noun ${hit.token})`);
    }
    receipts.push(`playbook: migrate ${name} → ${scope} split (${primitiveCount} primitive, ${dramaCount} drama)`);
  }

  for (const [scope, lines] of primBuckets) {
    const addr: PlaybookAddress = { lifetime: "primitive", scope, dir: seats };
    writePlaybook(addr, [...loadPlaybookLines(addr), ...lines]);
  }
  for (const { drama, scope, lines } of dramaBuckets.values()) {
    const addr: PlaybookAddress = { lifetime: "drama", scope, drama, dir: proot };
    writePlaybook(addr, [...loadPlaybookLines(addr), ...lines]);
  }
  for (const { name } of LEGACY_FILES) {
    const file = path.join(seats, name);
    if (fs.existsSync(file)) {
      fs.rmSync(file);
      receipts.push(`playbook: retire ${name}`);
    }
  }
  return { receipts };
}

/** CLI: `bun src/lib/studio/playbook.ts` — run the migration on the real
 *  seats/ + projects/, then verify the law holds: no primitive file names an
 *  entity token (checked against noun-lint's own token walk). */
function migrateMain(): number {
  const { receipts } = migrateLegacyPlaybooks();
  for (const r of receipts) console.log(r);
  const tokens = nounLintTokens(projectsDir());
  const bad: string[] = [];
  for (const scope of PLAYBOOK_SCOPES) {
    const file = playbookPath({ lifetime: "primitive", scope });
    if (!fs.existsSync(file)) continue;
    for (const b of bulletsOf(parsePlaybookLines(fs.readFileSync(file, "utf8")))) {
      const hit = tokens.find((t) => renderBullet(b).includes(t));
      if (hit) bad.push(`${scope}.primitive.md ${b.id} names ${hit}`);
    }
  }
  for (const b of bad) console.error(`migrate: PRIMITIVE LEAK ${b}`);
  console.log(
    bad.length
      ? `migrate: FAIL — ${bad.length} primitive leak(s)`
      : `migrate: ok — primitive files carry no entity token (${tokens.length} tokens checked)`,
  );
  return bad.length ? 1 : 0;
}

/* eslint-disable-next-line @typescript-eslint/no-unsafe-member-access */
if (typeof require !== "undefined" && require.main === module) {
  process.exit(migrateMain());
}
