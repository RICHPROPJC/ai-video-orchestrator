import fs from "node:fs";
import path from "node:path";

/**
 * MOTION_SELECT_0921 — motion-select skill: callsheet in → per-shot motion
 * picks out (one Jev-style decider call), feeding the §5b C-form Video 1
 * supply: pick → bake params → blockout lands at `blockout/{shot}.mp4` →
 * CFORM routing takes it from there (bake itself stays repo-external:
 * motion_library/scripts/bake_combat.py).
 *
 * Trial evidence (SlateLead/scratch/motsel-0921): one 10.2s call on qwen38
 * @ :8015 → 5/5 shots, verb gate 5/5, temp-0 stable across three runs, stress
 * shot 跪低執嘢 hit 02_06 — the same clip jev-pilot hand-picked. Lessons from
 * that trial are load-bearing here:
 *  ① candidate lines MUST carry the CMU category (111_19 is subject "Pregnant
 *     Woman" — the decider never saw that metadata and still picked it for a
 *     combat shot; harmless for grey blockouts, but the router deserves the
 *     field), and
 *  ② sibling clips with the SAME subject AND same desc dedupe to one entry
 *     (07_01/02_03 all read "walk" → conf 0.15 was a false-low signal).
 */

export const MOTION_LIB_ROOT = "/mnt/ssd/tripo_assets/motion_library";
export const CMU_INDEX_REL = "cmu-mocap/cmu-mocap-index-text.txt";
export const COMBAT_RANK_REL = "out/combat_sweep_ranking.txt";

export const DECIDER_DEFAULTS = {
  endpoint: "http://127.0.0.1:8015/v1/chat/completions",
  model: "qwen38",
  maxTokens: 700,
  temperature: 0,
  topLogprobs: 20,
  /** one retry when the parse comes back short; >2 calls is a card violation */
  maxCalls: 2,
} as const;

// ---------------------------------------------------------------------------
// L0 — deterministic index (zero LLM)
// ---------------------------------------------------------------------------

export type CmuIndexEntry = {
  id: string;
  bvh: string;
  subject: number | null;
  category: string | null;
  desc: string;
  frames: number | null;
};

export type CmuIndex = {
  source: string;
  bvhOnDisk: number;
  indexCovered: number;
  clips: CmuIndexEntry[];
};

const NO_DESC = "(no CMU index description)";

/** parse the CMU index-text (Subject header lines + `NN_MM\tdesc` clip lines) */
export function parseCmuIndexText(text: string): Map<string, { subject: number; category: string; desc: string }> {
  const entries = new Map<string, { subject: number; category: string; desc: string }>();
  let subject: number | null = null;
  let category: string | null = null;
  const subjRe = /^Subject #(\d+) \((.*)\)\s*$/;
  const clipRe = /^(\d+)_(\d+)\t(.*)$/;
  for (const line of text.split(/\r?\n/)) {
    const s = subjRe.exec(line);
    if (s) {
      subject = Number(s[1]);
      category = s[2].trim();
      continue;
    }
    const c = clipRe.exec(line);
    if (c && subject !== null && category !== null) {
      entries.set(`${String(Number(c[1])).padStart(2, "0")}_${String(Number(c[2])).padStart(2, "0")}`, {
        subject,
        category,
        desc: c[3].trim(),
      });
    }
  }
  return entries;
}

export type CombatRank = { rank: number; frames: number; meanDeg: number; minDeg: number };

/** parse out/combat_sweep_ranking.txt (73 combat clips, lower mean = cleaner
 *  arms for the SkinTokens rig; evidence source for the martial seed) */
export function parseCombatSweepRanking(text: string): Map<string, CombatRank> {
  const rank = new Map<string, CombatRank>();
  const rowRe = /^(\d+)\s+\S+\/(\d+)_(\d+)\.bvh\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s/;
  for (const line of text.split(/\r?\n/)) {
    const m = rowRe.exec(line);
    if (m) {
      rank.set(`${String(Number(m[2])).padStart(2, "0")}_${String(Number(m[3])).padStart(2, "0")}`, {
        rank: Number(m[1]),
        frames: Number(m[4]),
        meanDeg: Number(m[5]),
        minDeg: Number(m[6]),
      });
    }
  }
  return rank;
}

function clipIdOf(basename: string): string {
  const m = /^(\d+)_0*(\d+)$/.exec(basename.replace(/\.bvh$/, ""));
  if (!m) return basename.replace(/\.bvh$/, "");
  return `${String(Number(m[1])).padStart(2, "0")}_${String(Number(m[2])).padStart(2, "0")}`;
}

/** BVH header `Frames:` count — read the first KB only, never the whole clip */
export function bvhClipFrames(bvhRelToData: string, root = MOTION_LIB_ROOT): number | null {
  const file = path.join(root, "cmu-mocap", bvhRelToData);
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(1024);
      const n = fs.readSync(fd, buf, 0, 1024, 0);
      const m = /Frames:\s*(\d+)/.exec(buf.subarray(0, n).toString("latin1"));
      return m ? Number(m[1]) : null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** full index: every BVH on disk (2548 at trial time), index lines where they
 *  exist (2435 covered; the 113 without a CMU description say so honestly) */
export function buildCmuIndex(root = MOTION_LIB_ROOT): CmuIndex {
  const dataDir = path.join(root, "cmu-mocap", "data");
  const idxFile = path.join(root, CMU_INDEX_REL);
  const entries = parseCmuIndexText(fs.readFileSync(idxFile, "utf8"));
  const rels: string[] = [];
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".bvh")) rels.push(path.relative(dataDir, full).split(path.sep).join("/"));
    }
  };
  walk(dataDir);
  const clips = rels.map((rel) => {
    const id = clipIdOf(path.basename(rel));
    const e = entries.get(id);
    return {
      id,
      bvh: rel,
      subject: e ? e.subject : null,
      category: e ? e.category : null,
      desc: e ? e.desc : NO_DESC,
      frames: null as number | null,
    };
  });
  return {
    source: idxFile,
    bvhOnDisk: clips.length,
    indexCovered: clips.filter((c) => c.desc !== NO_DESC).length,
    clips,
  };
}

// ---------------------------------------------------------------------------
// L1 — keyword shortlist (deterministic; caps per trial)
// ---------------------------------------------------------------------------

export const MOTION_FAMILIES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["martial", ["martial", "boxing", "punch", "kick", "fight", "karate", "kungfu", "kung fu", "swordplay", "defensive", "attack"]],
  ["walk", ["walk", "stroll", "march"]],
  ["run", ["run", "jog", "sprint", "chase"]],
  ["bend_pick", ["bend", "squat", "kneel", "pick up", "pickup", "scoop", "lift", "crouch", "pick something", "grab"]],
  ["sit", ["sit", "sigh", "seated", "dejected", "sad", "slump", "chair", "sit down"]],
  ["stand_idle", ["stand", "idle", "standing"]],
] as const;

export const FAMILY_CAPS: Record<string, number> = {
  martial: 34,
  walk: 22,
  run: 14,
  bend_pick: 20,
  sit: 18,
  stand_idle: 12,
};

/** shortlist total target — single-token codes C01..C120 */
export const SHORTLIST_CAP = 120;

/** zh action chars / en verbs → extra keywords for a family (adaptive layer:
 *  the callsheet's action text strengthens the fixed families, never replaces
 *  them — a Chinese action enriches nothing (CMU descs are English), an
 *  English action verb widens its family's net) */
const ACTION_VERB_TO_FAMILY: ReadonlyArray<readonly [string, string]> = [
  ["打", "martial"], ["拳", "martial"], ["踢", "martial"], ["擊", "martial"], ["擋", "martial"],
  ["punch", "martial"], ["kick", "martial"], ["box", "martial"], ["fight", "martial"], ["spar", "martial"],
  ["行", "walk"], ["走", "walk"], ["漫步", "walk"], ["walk", "walk"], ["stroll", "walk"], ["step", "walk"],
  ["跑", "run"], ["追", "run"], ["衝", "run"], ["run", "run"], ["jog", "run"], ["sprint", "run"], ["chase", "run"],
  ["蹲", "bend_pick"], ["跪", "bend_pick"], ["執", "bend_pick"], ["執拾", "bend_pick"], ["彎", "bend_pick"], ["拎", "bend_pick"],
  ["bend", "bend_pick"], ["squat", "bend_pick"], ["kneel", "bend_pick"], ["pick", "bend_pick"], ["grab", "bend_pick"], ["lift", "bend_pick"],
  ["坐", "sit"], ["嘆", "sit"], ["sit", "sit"], ["sigh", "sit"], ["slump", "sit"],
  ["企", "stand_idle"], ["站", "stand_idle"], ["stand", "stand_idle"], ["idle", "stand_idle"],
];

/** families the action text points at (adaptive verb → family map) */
export function familiesForAction(action: string): string[] {
  const low = action.toLowerCase();
  return [...new Set(ACTION_VERB_TO_FAMILY.filter(([verb]) => low.includes(verb)).map(([, fam]) => fam))];
}

export type ShortlistEntry = {
  family: string;
  id: string;
  bvh: string;
  category: string | null;
  desc: string;
  /** arm-axis evidence tail from the combat sweep (martial family only) */
  arm: string;
  code: string;
};

export type Shortlist = {
  strategy: string;
  caps: Record<string, number>;
  nCandidates: number;
  candidates: ShortlistEntry[];
};

function familyHit(desc: string, category: string | null, keywords: readonly string[]): boolean {
  const t = `${desc} ${category ?? ""}`.toLowerCase();
  return keywords.some((k) => t.includes(k));
}

/** keyword families over the full index → ≤120 coded candidates.
 *  martial: combat-sweep ranking order first (low arm-axis mean = clean),
 *  then keyword fill. Trial lesson ②: same subject AND same desc dedupes to
 *  the first (best-ranked) sibling. */
export function buildShortlist(
  index: CmuIndex,
  ranking: Map<string, CombatRank>,
  actions: string[] = [],
): Shortlist {
  const extra = new Map<string, string[]>();
  for (const action of actions) {
    for (const fam of familiesForAction(action)) {
      const famKeywords = MOTION_FAMILIES.find(([name]) => name === fam)?.[1] ?? [];
      extra.set(fam, [...(extra.get(fam) ?? []), ...famKeywords]);
    }
  }
  const keywordsOf = (fam: string): readonly string[] => {
    const base = MOTION_FAMILIES.find(([name]) => name === fam)?.[1] ?? [];
    return [...new Set([...base, ...(extra.get(fam) ?? [])])];
  };

  const picks = new Map<string, string>(); // cid -> family (first family wins)
  const seenSibling = new Set<string>(); // `${subject}|${desc}` dedupe key
  const count = (fam: string) => [...picks.values()].filter((f) => f === fam).length;

  // martial: ranking order (evidence first), then keyword fill to cap
  for (const cid of ranking.keys()) {
    if (count("martial") >= FAMILY_CAPS.martial) break;
    const clip = index.clips.find((c) => c.id === cid);
    if (!clip || picks.has(cid)) continue;
    const sib = `${clip.subject}|${clip.desc}`;
    if (seenSibling.has(sib)) continue;
    picks.set(cid, "martial");
    seenSibling.add(sib);
  }
  for (const clip of index.clips) {
    if (count("martial") >= FAMILY_CAPS.martial) break;
    if (picks.has(clip.id)) continue;
    if (!familyHit(clip.desc, clip.category, keywordsOf("martial"))) continue;
    const sib = `${clip.subject}|${clip.desc}`;
    if (seenSibling.has(sib)) continue;
    picks.set(clip.id, "martial");
    seenSibling.add(sib);
  }
  for (const [fam] of MOTION_FAMILIES.slice(1)) {
    for (const clip of index.clips) {
      if (count(fam) >= FAMILY_CAPS[fam]!) break;
      if (picks.has(clip.id)) continue;
      if (!familyHit(clip.desc, clip.category, keywordsOf(fam))) continue;
      const sib = `${clip.subject}|${clip.desc}`;
      if (seenSibling.has(sib)) continue;
      picks.set(clip.id, fam);
      seenSibling.add(sib);
    }
  }

  const byId = new Map(index.clips.map((c) => [c.id, c]));
  const pre: Omit<ShortlistEntry, "code">[] = [];
  for (const [fam] of MOTION_FAMILIES) {
    for (const [cid, f] of picks) {
      if (f !== fam) continue;
      const clip = byId.get(cid)!;
      const r = ranking.get(cid);
      pre.push({
        family: fam,
        id: cid,
        bvh: clip.bvh,
        category: clip.category,
        desc: clip.desc,
        arm: r ? ` [arm-axis mean ${r.meanDeg.toFixed(0)}deg, min ${r.minDeg.toFixed(0)}deg, ${r.frames}f]` : "",
      });
    }
  }
  const capped: ShortlistEntry[] = pre
    .slice(0, SHORTLIST_CAP)
    .map((c, i) => ({ ...c, code: `C${String(i + 1).padStart(2, "0")}` }));
  const codes = new Set(capped.map((c) => c.code));
  if (codes.size !== capped.length) throw new Error("shortlist codes must be unique");
  return {
    strategy:
      "deterministic keyword/category layer over full CMU index -> single-token codes -> ONE decider call for all shots; martial family seeded by arm-axis ranking evidence; siblings (same subject+desc) dedupe to one",
    caps: { ...FAMILY_CAPS },
    nCandidates: capped.length,
    candidates: capped,
  };
}

// ---------------------------------------------------------------------------
// S2 — one-call decider (hard constraint: ONE HTTP call per selectMotions)
// ---------------------------------------------------------------------------

export type MotionShotLine = {
  id: string;
  heading: string;
  action: string;
  durationSec: number;
  gait?: string;
  stance?: string;
};

/** trial-verbatim strict line: `SHOTID Cnn | Cnn Cnn | reason` */
export const DECISION_LINE_RE = /^(\S+)\s+(C\d{2,3})\s*\|\s*(C\d{2,3})(?:\s+(C\d{2,3}))?\s*\|\s*(.+)$/;

export type DecisionRow = {
  shot: string;
  pick: string;
  runner: string[];
  reason: string;
};

export function parseDecisionLines(text: string): DecisionRow[] {
  const rows: DecisionRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = DECISION_LINE_RE.exec(line.trim());
    if (m) {
      rows.push({
        shot: m[1],
        pick: m[2],
        runner: [m[3], ...(m[4] ? [m[4]] : [])],
        reason: m[5].trim(),
      });
    }
  }
  return rows;
}

export function buildDecisionPrompt(shortlist: Shortlist, shots: MotionShotLine[]): { system: string; user: string } {
  const fams: [string, ShortlistEntry[]][] = [];
  for (const c of shortlist.candidates) {
    if (!fams.length || fams[fams.length - 1]![0] !== c.family) fams.push([c.family, []]);
    fams[fams.length - 1]![1].push(c);
  }
  const table = fams
    .map(([fam, cs]) => [`== ${fam} ==`, ...cs.map((c) => `${c.code} ${c.id} | ${c.category ?? "uncategorised"} | ${c.desc}${c.arm}`)])
    .flat()
    .join("\n");
  const shotLines = shots.map(
    (s) => `[${s.id}] ${s.heading}\naction: ${s.action} (${s.durationSec}s${s.gait ? `, gait ${s.gait}` : ""}${s.stance ? `, stance ${s.stance}` : ""})`,
  );
  const system = (
    "You are a mocap casting router for a film pipeline. For EACH shot, " +
    "cast exactly ONE motion clip from the candidate table that best matches " +
    "the shot action. Answer ALL shots in one pass, one line per shot, " +
    "STRICT format (no extra text, no headers):\n" +
    "<SHOTID> <best_code> | <runnerup_code> <runnerup_code> | <one-sentence reason>\n" +
    "TWO different runner-up codes are REQUIRED on every line. Example line:\n" +
    "SH99 C42 | C07 C15 | covers the whole punch-then-kick sequence standing in place\n" +
    "Rules: pick codes that exist in the table; prefer clips whose described " +
    "actions cover the WHOLE shot action (start pose through end pose); " +
    "runner-ups must be different clips that could also work."
  ).trim();
  const user =
    `【候選 motion 表】(code clip-id | category | description [arm-axis evidence])\n${table}\n\n` +
    `【shots】\n${shotLines.join("\n\n")}\n\n為每個shot選一條motion clip，一行一個shot，照指定格式答：`;
  return { system, user };
}

// ---- chain-rule short-circuit confidence (qwen38 splits C13 → 'C','1','3') --

type LogprobAlt = { token: string; logprob: number };

function normTok(t: string): string {
  return t.trim().replaceAll("Ġ", "").trim();
}

export type ChainConf = {
  conf: number | null;
  detail: { pos: number; digit: string; p: number; floor: boolean }[];
  fail: string | null;
};

/** confidence of a multi-token pick code: at each digit position renormalize
 *  top-20 logprobs over the digits that still lead to a valid candidate and
 *  multiply the emitted digit's probability. Emitted digit outside top-20
 *  floors at best-6.0 (flagged), trial math verbatim. */
export function chainConf(
  topLogprobs: LogprobAlt[][],
  tokens: string[],
  pick: string,
  validCodes: Set<string>,
): ChainConf {
  const n = tokens.length;
  for (let i = 0; i < n; i += 1) {
    if (tokens[i] !== "C") continue;
    let j = i + 1;
    const digits: string[] = [];
    while (j < n && /^\d$/.test(tokens[j]!)) {
      digits.push(tokens[j]!);
      j += 1;
    }
    if (`C${digits.join("")}` !== pick) continue;
    let probs = 1;
    let prefix = "C";
    const detail: ChainConf["detail"] = [];
    for (let k = 0; k < pick.length - 1; k += 1) {
      const d = pick[k + 1]!;
      const pos = i + 1 + k;
      if (pos >= n || tokens[pos] !== d) return { conf: null, detail, fail: `chain_deviate@${pos}` };
      const validD = [...new Set([...validCodes]
        .filter((c) => c.startsWith(prefix) && c.length > prefix.length)
        .map((c) => c[prefix.length]!))].sort();
      if (!validD.length) return { conf: null, detail, fail: `no_valid_digits@${pos}` };
      const alts = new Map<string, number>();
      for (const alt of topLogprobs[pos] ?? []) {
        const t = normTok(alt.token);
        if (validD.includes(t) && !alts.has(t)) alts.set(t, alt.logprob);
      }
      if (!alts.size) return { conf: null, detail, fail: `no_digit_alts@${pos}` };
      let floor = false;
      if (!alts.has(d)) {
        alts.set(d, Math.max(...alts.values()) - 6.0);
        floor = true;
      }
      const mx = Math.max(...alts.values());
      const z = [...alts.values()].reduce((acc, v) => acc + Math.exp(v - mx), 0);
      const p = Math.exp(alts.get(d)! - mx) / z;
      probs *= p;
      detail.push({ pos, digit: d, p: Math.round(p * 1e4) / 1e4, floor });
      prefix += d;
    }
    return { conf: Math.round(probs * 1e4) / 1e4, detail, fail: null };
  }
  return { conf: null, detail: [], fail: "emitted_not_found" };
}

export type DeciderRow = DecisionRow & {
  conf: number | null;
  pickId: string | null;
  pickDesc: string | null;
  pickFamily: string | null;
  pickBvh: string | null;
};

export type SelectMotionsResult = {
  rows: DeciderRow[];
  /** HTTP calls made — the card's one-call assertion reads this (mock counts) */
  calls: number;
};

/** ONE decider call for ALL shots (Jev式一次過). A short parse retries once;
 *  anything past maxCalls (2) or still short fails loud. Nothing per-shot. */
export async function selectMotions(opts: {
  shots: MotionShotLine[];
  shortlist: Shortlist;
  fetchImpl?: typeof fetch;
  endpoint?: string;
  model?: string;
}): Promise<SelectMotionsResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const endpoint = opts.endpoint ?? DECIDER_DEFAULTS.endpoint;
  const model = opts.model ?? DECIDER_DEFAULTS.model;
  const { system, user } = buildDecisionPrompt(opts.shortlist, opts.shots);
  const byCode = new Map(opts.shortlist.candidates.map((c) => [c.code, c]));
  const wantShots = new Set(opts.shots.map((s) => s.id));
  let calls = 0;
  let rows: DecisionRow[] = [];
  let lastRaw = "";
  let lastTokens: string[] = [];
  let lastLps: LogprobAlt[][] = [];
  while (calls < DECIDER_DEFAULTS.maxCalls) {
    calls += 1;
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_tokens: DECIDER_DEFAULTS.maxTokens,
        temperature: DECIDER_DEFAULTS.temperature,
        logprobs: true,
        top_logprobs: DECIDER_DEFAULTS.topLogprobs,
      }),
    });
    if (!res.ok) throw new Error(`decider HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const out = (await res.json()) as {
      choices: { message: { content: string }; logprobs?: { content?: { token: string; top_logprobs: { token: string; logprob: number }[] }[] } }[];
    };
    const ch = out.choices[0]!;
    lastRaw = ch.message.content;
    const content = ch.logprobs?.content ?? [];
    lastLps = content.map((e) => e.top_logprobs.map((t) => ({ token: t.token, logprob: t.logprob })));
    lastTokens = content.map((e) => normTok(e.token));
    rows = parseDecisionLines(lastRaw);
    const got = new Set(rows.map((r) => r.shot));
    const complete = [...wantShots].every((id) => got.has(id)) && rows.length === wantShots.size;
    if (complete) break;
  }
  const got = new Set(rows.map((r) => r.shot));
  const missing = [...wantShots].filter((id) => !got.has(id));
  if (missing.length) {
    throw new Error(
      `decider parse incomplete after ${calls} calls (missing ${missing.join(",")}); raw head: ${lastRaw.slice(0, 200)}`,
    );
  }
  const validCodes = new Set(byCode.keys());
  const decider: DeciderRow[] = rows.map((row) => {
    const c = byCode.get(row.pick) ?? null;
    const conf = chainConf(lastLps, lastTokens, row.pick, validCodes);
    return {
      ...row,
      conf: conf.conf,
      pickId: c ? c.id : null,
      pickDesc: c ? c.desc : null,
      pickFamily: c ? c.family : null,
      pickBvh: c ? c.bvh : null,
    };
  });
  return { rows: decider, calls };
}

// ---------------------------------------------------------------------------
// S3 — acceptance gates + selection schema
// ---------------------------------------------------------------------------

/** gate verbs for a shot action (zh/en verb → English gate terms; any-of list
 *  must hit the pick desc/category, all-of list scores partials) */
export function verbsForGate(action: string): { needAny: string[]; needAll: string[] } {
  const fams = familiesForAction(action);
  const table: Record<string, { any: string[]; all: string[] }> = {
    martial: { any: ["punch", "box", "strike", "fight", "kick"], all: [] },
    walk: { any: ["walk", "stroll", "march"], all: [] },
    run: { any: ["run", "jog", "sprint", "chase"], all: [] },
    bend_pick: { any: ["bend", "squat", "kneel", "crouch"], all: ["rise", "stand up", "scoop", "pick"] },
    sit: { any: ["sit", "seated"], all: [] },
    stand_idle: { any: ["stand", "idle", "standing"], all: [] },
  };
  const hit = fams.map((f) => table[f]!).filter(Boolean);
  return {
    needAny: [...new Set(hit.flatMap((h) => h.any))],
    needAll: [...new Set(hit.flatMap((h) => h.all))],
  };
}

export type VerbGateResult = { pass: boolean; hitAny: string[]; hitAll: string[]; partial: boolean };

/** pick desc (or category) must hit the action's core verbs; all-of misses are
 *  flagged partial but stay green; a full any-of miss fails */
export function verbGate(
  pick: { desc: string; category?: string | null },
  need: { needAny: string[]; needAll: string[] },
): VerbGateResult {
  const t = `${pick.desc} ${pick.category ?? ""}`.toLowerCase();
  const hitAny = need.needAny.filter((k) => t.includes(k));
  const hitAll = need.needAll.filter((k) => t.includes(k));
  const partial = need.needAll.length > 0 && hitAll.length < need.needAll.length;
  return { pass: hitAny.length > 0, hitAny, hitAll, partial };
}

/** bake window for a shot length: source frames at 120fps CMU sampling,
 *  step 2 → 60fps out (trial bake receipt: 4.82s → win 1+578 step 2 → 289f) */
export function bakeFor(durationSec: number): { start: number; len: number; step: number; auto_anchor: boolean } {
  return { start: 1, len: Math.round(durationSec * 120), step: 2, auto_anchor: true };
}

export type MotionSelection = {
  shot: string;
  /** path RELATIVE to cmu-mocap/data/ — the double-data docstring path is the
   *  proven FileNotFoundError trap (bake_combat.py prepends data/ itself) */
  bvh: string;
  conf: number | null;
  auto: boolean;
  bake: { start: number; len: number; step: number; auto_anchor: boolean };
  runners: string[];
  reason: string;
  needs_human?: boolean;
  tie_break?: string | null;
  flags: string[];
};

/** conf ≥0.7 auto; below → tie-break over pick+runners (arm-axis mean low →
 *  CMU high subject → clip length nearest the shot); still tied → needs_human */
export function decideSelection(
  row: DeciderRow,
  shortlist: Shortlist,
  ranking: Map<string, CombatRank>,
  shot: MotionShotLine,
  clipFrames: number | null,
): MotionSelection {
  const byId = new Map(shortlist.candidates.map((c) => [c.id, c]));
  const pickEntry = shortlist.candidates.find((c) => c.code === row.pick) ?? null;
  const flags: string[] = [];
  const pickId = row.pickId ?? pickEntry?.id ?? null;
  const pickRow = pickId ? byId.get(pickId) ?? null : null;
  const pickDesc = row.pickDesc ?? pickRow?.desc ?? "";

  const gate = verbGate({ desc: pickDesc, category: pickRow?.category }, verbsForGate(shot.action));
  let chosen = pickId;
  if (!gate.pass && row.runner.length) {
    // verb miss → walk the runner-ups, re-gate each
    for (const rc of row.runner) {
      const cand = shortlist.candidates.find((c) => c.code === rc);
      if (!cand) continue;
      const rg = verbGate({ desc: cand.desc, category: cand.category }, verbsForGate(shot.action));
      if (rg.pass) {
        chosen = cand.id;
        flags.push(`verb-miss swap: ${pickId} → ${cand.id}`);
        break;
      }
    }
    if (chosen === pickId) {
      throw new Error(
        `verb gate fail: ${shot.id} pick ${pickId} ("${pickDesc}") misses ${JSON.stringify(verbsForGate(shot.action).needAny)} and no runner-up passes`,
      );
    }
  } else if (gate.partial) {
    flags.push(`verb-partial: only ${JSON.stringify(gate.hitAll)} of the all-of verbs`);
  }

  const chosenRow = byId.get(chosen!) ?? null;
  const chosenFrames = chosenRow ? clipFramesFor(chosenRow.bvh) : clipFrames;
  if (chosenFrames !== null && shot.durationSec > 0 && chosenFrames / 120 < shot.durationSec - 0.5) {
    flags.push(`clip_short: ${(chosenFrames / 120).toFixed(2)}s < shot ${shot.durationSec.toFixed(2)}s`);
  }
  if (chosenRow?.category === "Pregnant Woman" || chosenRow?.category === "Post pregnant woman") {
    flags.push(`subject-metadata: ${chosenRow.category}`);
  }

  const conf = row.conf;
  let auto = conf !== null && conf >= 0.7;
  let tieBreak: string | null = null;
  let needsHuman = false;
  if (!auto) {
    const rivals = [row.pick, ...row.runner]
      .map((code) => shortlist.candidates.find((c) => c.code === code) ?? null)
      .filter((c): c is ShortlistEntry => Boolean(c));
    const scoreOf = (c: ShortlistEntry): [number, number, number, number] => {
      const arm = ranking.get(c.id);
      const fr = clipFramesFor(c.bvh);
      return [
        arm ? arm.meanDeg : Number.POSITIVE_INFINITY, // arm evidence first, lower better
        -(c.id ? Number((c.id.split("_")[0] ?? "0")) : 0), // high CMU subject next
        fr !== null ? Math.abs(fr / 120 - shot.durationSec) : Number.POSITIVE_INFINITY, // then duration near
        0,
      ];
    };
    rivals.sort((a, b) => {
      const sa = scoreOf(a);
      const sb = scoreOf(b);
      for (let i = 0; i < sa.length; i += 1) {
        if (sa[i]! !== sb[i]!) return sa[i]! - sb[i]!;
      }
      return 0;
    });
    const winner = rivals[0]!;
    const tied = rivals.filter((r) => JSON.stringify(scoreOf(r)) === JSON.stringify(scoreOf(winner)));
    if (tied.length > 1) {
      needsHuman = true;
      tieBreak = `unresolved after arm-axis/subject/duration (${tied.map((t) => t.id).join(",")})`;
      chosen = winner.id;
      auto = false;
    } else {
      chosen = winner.id;
      tieBreak = `${winner.id} wins arm-axis/subject/duration over ${rivals.filter((r) => r.id !== winner.id).map((r) => r.id).join(",")}`;
      flags.push("low-conf tie-break");
    }
  }
  const finalRow = byId.get(chosen!) ?? chosenRow;
  const runners = row.runner
    .map((code) => shortlist.candidates.find((c) => c.code === code)?.id ?? code)
    .filter((id) => id !== chosen);
  return {
    shot: shot.id,
    bvh: finalRow ? finalRow.bvh : "",
    conf,
    auto,
    bake: bakeFor(shot.durationSec),
    runners,
    reason: row.reason,
    ...(needsHuman ? { needs_human: true } : {}),
    ...(tieBreak ? { tie_break: tieBreak } : {}),
    flags,
  };
}

// clipFrames cache (BVH header reads; dry-run touches each file once)
const frameCache = new Map<string, number | null>();
function clipFramesFor(bvh: string): number | null {
  if (!frameCache.has(bvh)) frameCache.set(bvh, bvhClipFrames(bvh));
  return frameCache.get(bvh) ?? null;
}

/** write the machine-readable per-job selection (motion/selection.json) */
export function writeSelections(jobMotionDir: string, selections: MotionSelection[], meta: Record<string, unknown>): string {
  fs.mkdirSync(jobMotionDir, { recursive: true });
  const file = path.join(jobMotionDir, "selection.json");
  fs.writeFileSync(file, JSON.stringify({ ...meta, shots: selections }, null, 2) + "\n");
  return file;
}

/** blockout landing path convention — the §5b C-form router's Video 1 field:
 *  selection → (repo-external bake) → blockout/{shot}.mp4 on disk */
export function blockoutPathFor(jobBlockoutDir: string, shotId: string): string {
  return path.join(jobBlockoutDir, `${shotId}.mp4`);
}
