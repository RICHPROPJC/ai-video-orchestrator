import fs from "node:fs";
import path from "node:path";
import { snapDurationToFrames } from "./frame-grid";

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
// JUDGMENT0927：判斷常數集中歸位（judgment/ folder），motion-select 淨係消費
import { FAM_TARGET } from "./judgment/motion";
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

/** BVH header `Frames:` count — read forward in chunks (the MOTION block sits
 *  ~4KB in on CMU files), never the whole clip */
export function bvhClipFrames(bvhRelToData: string, root = MOTION_LIB_ROOT): number | null {
  // R19 裁決①（0929）路徑修復：bvh 欄係 data/-relative（:712 註釋明文，
  // bake_combat.py 自己加 data/）。兩種形態歸一——CMU index 唔帶 data/ 前綴
  // （舊 code 漏 data/ 令全庫評分讀唔到檔返 null，tie-break 兩維從未觀測）；
  // trial fixture 帶 data/ 前綴（直 join 會 double-data）。
  const rel = bvhRelToData.replace(/^data\//, "");
  const file = path.join(root, "cmu-mocap", "data", rel);
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(8192);
      let tail = "";
      for (let off = 0; off < 65536; off += buf.length) {
        const n = fs.readSync(fd, buf, 0, buf.length, off);
        if (n <= 0) break;
        const m = /Frames:\s*(\d+)/.exec(tail + buf.subarray(0, n).toString("latin1"));
        if (m) return Number(m[1]);
        tail = buf.subarray(0, n).toString("latin1").slice(-16);
      }
      return null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

export type HipStats = { meanY: number; stdY: number; oscPerSec: number };

/** 髖部 Y 通道統計（採樣 MOTION 段）——decider tie-break 嘅每族分辨指標。
 *  CMU root＝hip，每幀首三 token＝Xposition Yposition Zposition（cm）。
 *  淨喺 tie-break rivals（≤幾條）讀，有 cache；讀唔到 → null，指標退 ∞。 */
export function bvhHipStats(bvhRelToData: string, root = MOTION_LIB_ROOT): HipStats | null {
  if (hipCache.has(bvhRelToData)) return hipCache.get(bvhRelToData) ?? null;
  let out: HipStats | null = null;
  try {
    // R19 裁決①（0929）路徑修復：同 bvhClipFrames——兩種 bvh 欄形態歸一。
    const rel = bvhRelToData.replace(/^data\//, "");
    const file = path.join(root, "cmu-mocap", "data", rel);
    const text = fs.readFileSync(file, "latin1");
    const motionAt = text.indexOf("MOTION");
    if (motionAt < 0) throw new Error("no MOTION block");
    const lines = text.slice(motionAt).split(/\r?\n/);
    const ys: number[] = [];
    const STEP = 6; // 0.05s @ 120fps（CMU0927 實測：run 族 35/40 短過 2.4s，
    // 舊 0.1s×≥24 樣本下限會掃走成族——收細步距＋下限 0.6s 先量得勻六族）
    const CAP = 960; // 48s 採樣上限
    let seen = 0;
    for (const line of lines.slice(2)) {
      const tok = line.trim().split(/\s+/);
      if (tok.length < 3) continue;
      const y = Number(tok[1]);
      if (!Number.isFinite(y)) continue;
      seen += 1;
      if (seen % STEP === 0) ys.push(y);
      if (ys.length >= CAP) break;
    }
    if (ys.length >= 12) { // ≥0.6s；短 clip osc 由採樣時長歸一
      const mean = ys.reduce((a, b) => a + b, 0) / ys.length;
      const std = Math.sqrt(ys.reduce((a, b) => a + (b - mean) ** 2, 0) / ys.length);
      let cross = 0;
      for (let i = 1; i < ys.length; i += 1) {
        if ((ys[i - 1]! - mean) * (ys[i]! - mean) < 0) cross += 1;
      }
      out = { meanY: mean, stdY: std, oscPerSec: cross / 2 / ((ys.length * STEP) / 120) };
    }
  } catch {
    out = null;
  }
  hipCache.set(bvhRelToData, out);
  return out;
}

const hipCache = new Map<string, HipStats | null>();


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
  // R20 裁決②（0929）：action-direct 通道排最前——keywords 空（picks 由
  // actionDirectKeywords 直搜直接 set）；前置係因為尾段 pre.slice(0,120)
  // 按 family 順序截——排尾會被 family cap 總和（120）食滿斬走（probe
  // 實證兩度丟失：未註冊時 picks 被丟；註冊排尾時被 slice 斬）。
  // action-specific 候選優先過泛 family（walk/idle 呢啲萬金油）。
  ["actionDirect", []],
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
  // R20 裁決②（0929）：action-direct 直搜通道 cap（action 詞典 hit index 描述）
  actionDirect: 40,
};


/** shortlist total target — single-token codes C01..C120 */
export const SHORTLIST_CAP = 120;

/** zh action chars / en verbs → extra keywords for a family (adaptive layer:
 *  the callsheet's action text strengthens the fixed families, never replaces
 *  them — a Chinese action enriches nothing (CMU descs are English), an
 *  English action verb widens its family's net) */
const ACTION_VERB_TO_FAMILY: ReadonlyArray<readonly [string, string]> = [
  // 打/踢/擊 are ACTION verbs; bare 拳 is a noun (收拳 = withdrawing fists,
  // the MS-A simple join shot) and must NOT flag a shot motion-heavy
  ["打", "martial"], ["踢", "martial"], ["擊", "martial"], ["擋", "martial"],
  ["punch", "martial"], ["kick", "martial"], ["box", "martial"], ["fight", "martial"], ["spar", "martial"],
  ["行走", "walk"], ["走到", "walk"], ["走去", "walk"], ["走過", "walk"], ["走開", "walk"], ["走出", "walk"], ["走入", "walk"],
  ["行去", "walk"], ["行到", "walk"], ["行過", "walk"], ["行出", "walk"], ["行入", "walk"], ["行路", "walk"], ["步行", "walk"], ["漫步", "walk"],
  ["行前", "walk"], ["行兩", "walk"], ["走前", "walk"], ["走兩", "walk"],
  ["walk", "walk"], ["stroll", "walk"], ["step", "walk"],
  ["跑", "run"], ["追", "run"], ["衝", "run"], ["run", "run"], ["jog", "run"], ["sprint", "run"], ["chase", "run"],
  ["蹲", "bend_pick"], ["跪", "bend_pick"], ["執", "bend_pick"], ["執拾", "bend_pick"], ["彎", "bend_pick"], ["拎", "bend_pick"],
  ["bend", "bend_pick"], ["squat", "bend_pick"], ["kneel", "bend_pick"], ["pick", "bend_pick"], ["grab", "bend_pick"], ["lift", "bend_pick"],
  ["坐", "sit"], ["嘆", "sit"], ["sit", "sit"], ["sigh", "sit"], ["slump", "sit"],
  ["企", "stand_idle"], ["站", "stand_idle"], ["stand", "stand_idle"], ["idle", "stand_idle"],
];

/** families the action text points at (adaptive verb → family map) */
export function familiesForAction(action: string): string[] {
  const low = action.toLowerCase();
  return [...new Set(ACTION_VERB_TO_FAMILY.filter(([verb]) => low.includes(verb.toLowerCase())).map(([, fam]) => fam))];
}

/** 手部核心動詞——CMU 六族（martial/walk/run/bend_pick/sit/stand_idle）冇覆蓋
 *  嘅廣告手部動作。命中＝動作核心喺手唔喺腳，mocap 庫根本冇呢樣嘢：照 bake
 *  一條近族 clip 就係「假 Video1」（片唔郁／手唔郁根因）。報 motion gap 行
 *  KF 驅動，唔好用 mocap 扮。舉/提/拎唔入表——bend_pick 有全身提取動作。 */
export const HAND_ACTION_VERBS = [
  "擰", "扭", "開蓋", "飲", "喝", "斟", "抹", "拭", "擦", "搖", "噴", "撳",
  "twist", "unscrew", "drink", "sip", "pour", "wipe", "dab", "spray", "squeeze", "press",
] as const;

/** hand verbs the action names that the six CMU families cannot supply */
export function handActionGap(action: string): string[] {
  const low = action.toLowerCase();
  return HAND_ACTION_VERBS.filter((v) => low.includes(v.toLowerCase()));
}

/** 坐低係由企到坐。gait／stance 寫住另一樣就係矛盾，唔好靜靜雞揀一邊。 */
export function postureConflict(shot: MotionShotLine): string | null {
  if (!/坐低|坐下/.test(shot.action)) return null;
  if (shot.gait && shot.gait !== "plant") return `${shot.id}: 坐低同 gait ${shot.gait} 矛盾`;
  if (shot.stance === "stand") return `${shot.id}: 坐低但 stance 係 stand`;
  return null;
}

/** Clips the picker may see. Gate off → the whole table. A family with no hit → empty, stop before GPU. */
export function legalCandidates(shortlist: Shortlist, action: string): ShortlistEntry[] {
  const need = verbsForGate(action);
  if (need.needAny.length === 0) return shortlist.candidates;
  return shortlist.candidates.filter((c) => verbGate({ desc: c.desc, category: c.category }, need).pass);
}

/** R20 裁決②（0929）：通用動作詞典（中文 action 詞 → index 英文描述詞）。
 *  係「任何影片嘅動作詞都查到」嘅對照表，唔係某片嘅 clip 清單——shortlist
 *  由 family 表（combat/walk/…）之外加一條 action-direct 直搜通道，action
 *  詞直接 hit index 描述（unscrew/drink 呢類 family 表冇覆蓋嘅動作由此入）。 */
const ACTION_VERB_DICT: [RegExp, string[]][] = [
  [/扭|擰|開蓋|開樽/, ["unscrew", "screw", "twist", "bottlecap", "bottle cap", "jar lid"]],
  [/飲|喝|啜|對嘴/, ["drink", "sipping", "soda", "beverage"]],
  [/倒|斟|注/, ["pour", "fill", "pouring"]],
  [/抹|擦|拭/, ["wipe", "wiping", "rub", "rubbing"]],
  [/拎|提|舉|拿起|執起|握/, ["lift", "lifting", "pick up", "picking up", "carry", "carrying", "raise", "raising", "hold", "grab"]],
  [/放低|放下|擺|掂檯/, ["put down", "placing", "place", "lay down", "lower", "lowering", "set down"]],
  [/行|走|行埋|埋去|接近/, ["walk", "walking", "step", "approach"]],
  [/坐|坐低/, ["sit", "sitting", "sit down", "seat"]],
  [/跑|奔/, ["run", "running", "jog"]],
  [/跳/, ["jump", "jumping", "leap"]],
  [/望|看|望向|望鏡/, ["look", "looking", "gaze", "stare"]],
  [/講|說|開口|講嘢/, ["talk", "talking", "speak", "speaking", "say"]],
  [/笑/, ["laugh", "laughing"]],
  [/揮手|招手/, ["wave", "waving", "beckon"]],
  [/轉身|轉/, ["turn", "turning", "spin"]],
];

/** action 文本 → 直搜英文詞集（family 詞之外嘅補充通道）。 */
export function actionDirectKeywords(actions: string[]): string[] {
  const kws = new Set<string>();
  for (const a of actions) {
    for (const [re, en] of ACTION_VERB_DICT) {
      if (re.test(a)) for (const k of en) kws.add(k);
    }
  }
  return [...kws];
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

  // R20 裁決②（0929）：action-direct 直搜通道先行——action 詞典詞直接 hit
  // index 描述（unscrew/drink 呢類 family 表冇覆蓋嘅動作由此入 shortlist；
  // 通用詞典通道，支援任何影片嘅 action 詞，唔係某片 clip 清單）。兩輪制：
  // specific 詞先行（泛詞 walk/hold/lift 會被 index 大量 clip 食滿 cap，
  // soda 類 specific clip 反而入唔到——probe 實證），泛詞後補。
  const directKws = actionDirectKeywords(actions);
  const GENERIC_DIRECT = new Set(["walk", "walking", "step", "approach", "lift", "lifting", "pick up", "picking up", "carry", "carrying", "raise", "raising", "hold", "grab", "put down", "placing", "place", "lay down", "lower", "lowering", "set down", "run", "running", "jog", "jump", "jumping", "leap", "turn", "turning", "spin"]);
  const specificKws = directKws.filter((k) => !GENERIC_DIRECT.has(k));
  const runDirect = (kws: string[], cap: number) => {
    if (!kws.length) return;
    for (const clip of index.clips) {
      if (count("actionDirect") >= cap) break;
      if (picks.has(clip.id)) continue;
      const hay = `${clip.desc} ${clip.category ?? ""}`.toLowerCase();
      if (!kws.some((k) => hay.includes(k))) continue;
      const sib = `${clip.subject}|${clip.desc}`;
      if (seenSibling.has(sib)) continue;
      picks.set(clip.id, "actionDirect");
      seenSibling.add(sib);
    }
  };
  runDirect(specificKws, 20); // specific 先行（unscrew/drink/wipe…）
  runDirect(directKws, FAMILY_CAPS.actionDirect!); // 泛詞後補至 cap

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
  for (const [fam] of MOTION_FAMILIES.slice(2)) { // [0]=actionDirect（獨立段）、[1]=martial（ranking 先行段）——都唔行呢度 keyword filter
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

/** V3.2（PLAN-v2 0928）§9.2：frozen motion spec——呢鏡動作嘅 typed 規格，
 *  由 callsheet 現有欄衍生（marks stance/stanceEnd＋combat incoming/outgoing
 *  ＋envAnim＋props 持有）。selection prompt、selection.json、H3 prose 三處
 *  食同一份：bake 線同 prose 線唔再各說各話（〈Video 1〉契約由磁碟痕跡升級
 *  typed）。py 側（相機 intent/接觸 bake）＝bake_combat.py owner 釐清後另輪。 */
export type MotionSpec = {
  startStance?: string;
  endStance?: string;
  contact?: string;
  incoming?: string;
  outgoing?: string;
  envChange?: string;
  durationSec: number;
};

export type MotionShotLine = {
  id: string;
  heading: string;
  action: string;
  durationSec: number;
  gait?: string;
  stance?: string;
  spec?: MotionSpec;
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
  const shotLines = shots.map((s) => {
    const legal = legalCandidates(shortlist, s.action);
    const gated = verbsForGate(s.action).needAny.length > 0;
    const only = gated ? `\nonly these codes: ${legal.map((c) => c.code).join(" ")}` : "";
    const specBits = s.spec
      ? [
          ...(s.spec.startStance ? [`from ${s.spec.startStance}`] : []),
          ...(s.spec.endStance ? [`to ${s.spec.endStance}`] : []),
          ...(s.spec.contact ? [`contact ${s.spec.contact}`] : []),
          ...(s.spec.outgoing ? [`ends ${String(s.spec.outgoing).slice(0, 120)}`] : []),
        ].join(", ")
      : "";
    return `[${s.id}] ${s.heading}\naction: ${s.action} (${s.durationSec}s${s.gait ? `, gait ${s.gait}` : ""}${s.stance ? `, stance ${s.stance}` : ""}${specBits ? `, ${specBits}` : ""})${only}`;
  });
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
    // complete = every wanted shot answered (a replayed stream may carry extra
    // lines; a live decider answers exactly what was asked)
    if ([...wantShots].every((id) => got.has(id))) break;
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

/** R20 裁決②（0929）：clip 活動段偵測（通用，任何 BVH）——每幀全 channel
 *  delta 絕對和做活動量；企定基線＝中位數；超基線×3 連續 ≥18 幀（0.15s）
 *  算活動段，取累計活動量最大嘅主段。bake start 由主段起，唔再硬編 1
 *  （「選整條 clip 然後 bake start=1 假設動作即刻開始」對症——CMU soda
 *  clip 企定開場會食晒鏡長）。工程估計級：分唔到 unscrew vs 飲（細分要
 *  FK 語義分析，Mo 0929 八 clip 幀級表係人手版）；偵測唔到＝照舊 start 1
 *  且 segment 收據留空，唔作假。 */
export function bvhActivityWindow(bvhRelToData: string, root = MOTION_LIB_ROOT): { startF: number; endF: number; startSec: number; endSec: number; method: string } | null {
  try {
    const rel = bvhRelToData.replace(/^data\//, "");
    const file = path.join(root, "cmu-mocap", "data", rel);
    const text = fs.readFileSync(file, "latin1");
    const motionAt = text.indexOf("MOTION");
    if (motionAt < 0) return null;
    const lines = text.slice(motionAt).split(/\r?\n/);
    const frames: number[][] = [];
    for (const line of lines.slice(2)) {
      const tok = line.trim().split(/\s+/).map(Number);
      if (tok.length > 3 && tok.every(Number.isFinite)) frames.push(tok);
    }
    if (frames.length < 60) return null;
    const acts: number[] = [0];
    for (let i = 1; i < frames.length; i += 1) {
      let s = 0;
      const a = frames[i]!, b = frames[i - 1]!;
      for (let c = 0; c < a.length; c += 1) s += Math.abs((a[c] ?? 0) - (b[c] ?? 0));
      acts.push(s);
    }
    const sorted = [...acts].sort((x, y) => x - y);
    const base = sorted[Math.floor(sorted.length / 2)]!;
    if (!(base > 0)) return null;
    // 閾值：median×3 對 120Hz 逐幀 delta 太緊（企定旋轉噪聲已近 median），
    // 實測全 null。改 P85 同 median×1.5 取大——活動幀 ~15% 起捕（Mo 人手
    // 表 14_05 unscrew 佔 ~11% + 飲用段 ≥15% 對得上）。
    const thresh = Math.max(sorted[Math.floor(sorted.length * 0.85)]!, base * 1.5);
    const runs: { s: number; e: number; sum: number }[] = [];
    let s = -1, sum = 0;
    for (let i = 0; i < acts.length; i += 1) {
      if (acts[i]! >= thresh) {
        if (s < 0) { s = i; sum = 0; }
        sum += acts[i]!;
      } else if (s >= 0) {
        if (i - s >= 18) runs.push({ s, e: i - 1, sum });
        s = -1;
      }
    }
    if (s >= 0 && acts.length - s >= 18) runs.push({ s, e: acts.length - 1, sum });
    if (!runs.length) return null;
    const main = runs.reduce((x, y) => (y.sum > x.sum ? y : x))!;
    return { startF: main.s + 1, endF: main.e + 1, startSec: Number(((main.s) / 120).toFixed(2)), endSec: Number(((main.e) / 120).toFixed(2)), method: "activity-detect-v1(median×3,run≥18f)" };
  } catch {
    return null;
  }
}

export type MotionSelection = {
  shot: string;
  /** path RELATIVE to cmu-mocap/data/ — the double-data docstring path is the
   *  proven FileNotFoundError trap (bake_combat.py prepends data/ itself) */
  bvh: string;
  conf: number | null;
  auto: boolean;
  bake: { start: number; len: number; step: number; auto_anchor: boolean };
  /** V3.2：frozen spec 隨選用落 selection.json（機讀收據；resume setKey 已食） */
  spec?: MotionSpec;
  runners: string[];
  reason: string;
  needs_human?: boolean;
  tie_break?: string | null;
  flags: string[];
  /** R19 裁決②（0929）：席位決策來源——tie-break 唔再交人手，記邊個位憑咩
   *  決：seat-tiebreak:stable-id-order（觀測等價→穩定次序）／
   *  seat-pick:unobserved-tie（維度未觀測→照 decider 本鏡需求 pick）／
   *  human-override（--motion-pick 人手接）。唔假造 conf。 */
  decisionSource?: string;
  /** 平手時嘅候選證據：每個 rival 各維度觀測狀態＋verbGate 結果（收據）。 */
  candidateEvidence?: { id: string; bvh: string; arm_ranked: boolean; hip_stats: boolean; frames_read: boolean; verb_pass: boolean }[];
  /** R20 裁決②（0929）：採納活動段收據——bake start 由呢度起（幀/秒/方法），
   *  KF at 0/mid/end 對應實際 clip 區段有得對帳。偵測唔到＝欄位缺席唔作假。 */
  segment?: { startF: number; endF: number; startSec: number; endSec: number; method: string };
  /** CMU 覆蓋唔到嘅動作（手部動詞）——pipeline 讀到 gap.remedy==="kf_driven"
   *  就行鍵格驅動路，唔好假 Video1 motion。 */
  gap?: MotionGap;
};

export type MotionGap = {
  domain: "motion";
  what: string;
  why: string;
  impact: "blocked" | "degraded";
  remedy: "kf_driven";
};

/** conf ≥0.7 auto; below → tie-break over pick+runners (arm-axis mean low →
 *  CMU high subject → clip length nearest the shot). R19 裁決②（0929）：still
 *  tied → 席位決策（觀測等價→穩定 id 序；維度未觀測→照 decider pick），
 *  留 decisionSource＋candidateEvidence；needs_human 唔再由呢條路生。 */
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

  const need = verbsForGate(shot.action);
  let chosen = pickId;
  // CMU 覆蓋唔到手部動作（擰蓋/飲/抹…）：報 gap 行 KF 驅動，唔好假 Video1。
  // 有 family 動詞（行前兩步擰蓋）＝degraded（腳啱手假）；冇 family＝blocked。
  const handVerbs = handActionGap(shot.action);
  let gap: MotionGap | undefined;
  if (handVerbs.length) {
    gap = {
      domain: "motion",
      what: `${shot.id}: 手部動作（${handVerbs.join("/")}）CMU 六族冇覆蓋`,
      why: "mocap 庫冇廣告手部動作；照 bake 近族 clip＝假 Video1 motion（片唔郁根因）",
      impact: need.needAny.length > 0 ? "degraded" : "blocked",
      remedy: "kf_driven",
    };
    flags.push(`motion-gap: ${handVerbs.join("/")} → KF 驅動，唔好假 Video1`);
  }
  // 閘只喺動作認到人物 family 先開。水珠、樽、靜物冇 family，唔閘。
  if (need.needAny.length === 0) {
    flags.push("verb-gate off: action names no character motion");
  } else {
    const gate = verbGate({ desc: pickDesc, category: pickRow?.category }, need);
    if (!gate.pass && row.runner.length) {
      for (const rc of row.runner) {
        const cand = shortlist.candidates.find((c) => c.code === rc);
        if (!cand) continue;
        const rg = verbGate({ desc: cand.desc, category: cand.category }, need);
        if (rg.pass) {
          chosen = cand.id;
          flags.push(`verb-miss swap: ${pickId} → ${cand.id}`);
          break;
        }
      }
      if (chosen === pickId) {
        throw new Error(
          `verb gate fail: ${shot.id} pick ${pickId} ("${pickDesc}") misses ${JSON.stringify(need.needAny)} and no runner-up passes`,
        );
      }
    } else if (gate.partial) {
      flags.push(`verb-partial: only ${JSON.stringify(gate.hitAll)} of the all-of verbs`);
    }
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
  const needsHuman = false; // R19 裁決②：席位決策路徑唔再生 needs_human；將來真 creative lock 類先設
  // R19 裁決②（0929）：「conf<0.7＋平手→needs_human」係 source 新增 policy，
  // 唔係用戶法——未指定創作選擇由系統合理處理係既有要求。席位（decider）
  // 有權揀，留 decisionSource＋候選證據。分兩種平手：
  //   觀測等價（arm/hip/duration 有實數而相同）→穩定 id 字典序 tie-break；
  //   維度未觀測（評分資料缺）→照 decider pick（本鏡需求）行。
  // 唔假造 conf（照 logprobs 觀測原值）；needs_human 唔再由呢條路生。
  let decisionSource: string | undefined;
  let candidateEvidence: MotionSelection["candidateEvidence"];
  if (!auto) {
    const rivalsAll = [row.pick, ...row.runner]
      .map((code) => shortlist.candidates.find((c) => c.code === code) ?? null)
      .filter((c): c is ShortlistEntry => Boolean(c));
    // R19 裁決②（0929）：評分排名只喺任務相容（verbGate 過）嘅候選之間行——
    // 舊版評分排序會蓋過前面 verb-miss swap 揀出嘅相容候選。
    const rivals = rivalsAll.filter(
      (c) => need.needAny.length === 0 || verbGate({ desc: c.desc, category: c.category }, need).pass,
    );
    if (rivals.length === 0) rivals.push(...rivalsAll); // 全唔過＝前面 verb gate 已 throw，呢度唔會到；防禦性 fallback
    const scoreOf = (c: ShortlistEntry): [number, number, number, number] => {
      const arm = ranking.get(c.id);
      const fr = clipFramesFor(c.bvh);
      const hip = bvhHipStats(c.bvh);
      return [
        arm ? arm.meanDeg : Number.POSITIVE_INFINITY, // arm evidence first, lower better
        hip ? FAM_TARGET[c.family]?.(hip) ?? Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY, // 每族髖指標
        -(c.id ? Number((c.id.split("_")[0] ?? "0")) : 0), // high CMU subject next
        fr !== null ? Math.abs(fr / 120 - shot.durationSec) : Number.POSITIVE_INFINITY, // then duration near
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
    // R19 裁決①：tied 判定改 typed 逐維比較——舊版 JSON.stringify 把
    // Infinity/NaN 轉 null，「兩個都冇資料」睇落完全一樣＝假平手。
    const tied = rivals.filter((r) => {
      const sa = scoreOf(r);
      const sw = scoreOf(winner);
      return sa.every((v, i) => v === sw[i]);
    });
    if (tied.length > 1) {
      // 評分維度觀測狀態：未觀測唔係合格（R19 裁決①）——資料缺要明示
      const armObserved = ranking.has(winner.id);
      const hipObserved = bvhHipStats(winner.bvh) !== null;
      const framesObserved = clipFramesFor(winner.bvh) !== null;
      candidateEvidence = rivals.map((c) => ({
        id: c.id,
        bvh: c.bvh,
        arm_ranked: ranking.has(c.id),
        hip_stats: bvhHipStats(c.bvh) !== null,
        frames_read: clipFramesFor(c.bvh) !== null,
        verb_pass: need.needAny.length === 0 ? true : verbGate({ desc: c.desc, category: c.category }, need).pass,
      }));
      if (armObserved && hipObserved && framesObserved) {
        // 觀測等價：穩定 tie-break（id 字典序，deterministic 可重現）
        const stable = [...tied].sort((a, b) => a.id.localeCompare(b.id))[0]!;
        chosen = stable.id;
        tieBreak = `observed-equal after arm-axis/family-hip/subject/duration; stable id-order among (${tied.map((t) => t.id).join(",")})`;
        decisionSource = "seat-tiebreak:stable-id-order";
      } else {
        // 維度未觀測＝資料缺，唔當等價：保持任務相容 chosen（verb-miss swap
        // 後嘅 decider 需求修正優先——R19 裁決②）
        chosen = chosen ?? winner.id;
        const miss = [!armObserved && "arm", !hipObserved && "hip", !framesObserved && "duration"].filter(Boolean).join("/");
        tieBreak = `tie on unobserved dims (${miss}); seat keeps task-compatible pick per shot need`;
        decisionSource = "seat-pick:unobserved-tie";
      }
      flags.push(`tie seat-decided (${decisionSource})`);
      auto = false;
    } else {
      chosen = winner.id;
      tieBreak = `${winner.id} wins arm-axis/family-hip/subject/duration over ${rivals.filter((r) => r.id !== winner.id).map((r) => r.id).join(",")}`;
      flags.push("low-conf tie-break");
    }
  }
  const finalRow = byId.get(chosen!) ?? chosenRow;
  // R20 裁決②（0929）：bake start 對實際活動段（通用偵測）——唔硬編 1；
  // 段窗口落 selection.segment 收據。偵測唔到＝照舊 start 1＋欄位缺席。
  const activityWin = finalRow ? bvhActivityWindow(finalRow.bvh) : null;
  const bake = activityWin ? { ...bakeFor(shot.durationSec), start: activityWin.startF } : bakeFor(shot.durationSec);
  // runners list every alternative the decider offered plus a demoted pick
  const runnerIds = [...new Set([pickId, ...row.runner.map((code) => shortlist.candidates.find((c) => c.code === code)?.id ?? code)])]
    .filter((id): id is string => Boolean(id) && id !== chosen);
  return {
    shot: shot.id,
    ...(shot.spec ? { spec: shot.spec } : {}),
    bvh: finalRow ? finalRow.bvh : "",
    conf,
    auto,
    bake,
    ...(activityWin ? { segment: activityWin } : {}),
    runners: runnerIds,
    reason: row.reason,
    ...(needsHuman ? { needs_human: true } : {}),
    ...(tieBreak ? { tie_break: tieBreak } : {}),
    ...(decisionSource ? { decisionSource } : {}),
    ...(candidateEvidence ? { candidateEvidence } : {}),
    ...(gap ? { gap } : {}),
    flags,
  };
}

// clipFrames cache (BVH header reads; dry-run touches each file once)
const frameCache = new Map<string, number | null>();
function clipFramesFor(bvh: string): number | null {
  if (!frameCache.has(bvh)) frameCache.set(bvh, bvhClipFrames(bvh));
  return frameCache.get(bvh) ?? null;
}

/** write the machine-readable per-job motion selection.
 *  R19 裁決④（0929）：新 attempt 唔可覆寫最後 adopted selection——decider
 *  結果寫 selection.attempt.json；selection.json 係 adopted 真源，經
 *  adoptSelections()（席位決策閘過後採納）先寫，寫前自動 snapshot 舊版。 */
export function writeSelections(jobMotionDir: string, selections: MotionSelection[], meta: Record<string, unknown>): string {
  fs.mkdirSync(jobMotionDir, { recursive: true });
  const file = path.join(jobMotionDir, "selection.attempt.json");
  fs.writeFileSync(file, JSON.stringify({ ...meta, attempt: true, shots: selections }, null, 2) + "\n");
  return file;
}

/** 採納：attempt 升格做 selection.json（adopted 真源）；舊 adopted 自動
 *  snapshot 做 selection.adopted.<mtime>.json——provenance 鏈零丟失
 *  （R19 裁決④：0927 版 selection 被 0928 R19c 覆寫失去就係呢個位缺）。 */
export function adoptSelections(jobMotionDir: string): string {
  const attempt = path.join(jobMotionDir, "selection.attempt.json");
  const adoptedFile = path.join(jobMotionDir, "selection.json");
  if (!fs.existsSync(attempt)) throw new Error(`adoptSelections: attempt 唔在盤（${attempt}）`);
  const raw = JSON.parse(fs.readFileSync(attempt, "utf8")) as Record<string, unknown> & { shots: MotionSelection[] };
  if (fs.existsSync(adoptedFile)) {
    const stamp = fs.statSync(adoptedFile).mtime.toISOString().replace(/[:.]/g, "-");
    fs.copyFileSync(adoptedFile, path.join(jobMotionDir, `selection.adopted.${stamp}.json`));
  }
  const { attempt: _drop, ...meta } = raw;
  fs.writeFileSync(adoptedFile, JSON.stringify({ ...meta, adoptedAt: new Date().toISOString(), shots: raw.shots }, null, 2) + "\n");
  return adoptedFile;
}

/** resume 重用讀 adopted selection（selection.json）。 */
export function readAdoptedSelections(jobMotionDir: string): MotionSelection[] | null {
  const adoptedFile = path.join(jobMotionDir, "selection.json");
  if (!fs.existsSync(adoptedFile)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(adoptedFile, "utf8")) as { shots?: MotionSelection[] };
    return Array.isArray(raw.shots) && raw.shots.length ? raw.shots : null;
  } catch {
    return null;
  }
}

/** blockout landing path convention — the §5b C-form router's Video 1 field:
 *  selection → (repo-external bake) → blockout/{shot}.mp4 on disk */
export function blockoutPathFor(jobBlockoutDir: string, shotId: string): string {
  return path.join(jobBlockoutDir, `${shotId}.mp4`);
}

// ---------------------------------------------------------------------------
// MULTISHOT_WIRE_0921 — cross-shot scheduling + the bake executor
// ---------------------------------------------------------------------------

export type MotionSegment =
  /** a motion-heavy shot anchors its own C-form render (Video 1 motion +
 *  portrait identity); chain stays empty under ALIGN-LOCK */
  | { kind: "cform"; anchor: string; chain: string[] }
  /** a LEADING run of simple shots: one standalone multishot call (no first
 *  C-form shot, MS-A shape — motion rides the script, no Video 1 exists on
 *  the node) */
  | { kind: "multishot"; shots: string[] };

/** Every shot is its own C-form. The Blender mp4 goes in ref_videos.
 *  H3MultishotSampler has no video socket, so it is not the render. */
export function motionSegments(shots: { id: string; action: string }[]): MotionSegment[] {
  return shots.map((shot) => ({ kind: "cform", anchor: shot.id, chain: [] }));
}

/** All submissions use the same upward 17k+5 clock as the concat gate. */
export function snapFramesPerShot(durationSec: number): number {
  return snapDurationToFrames(durationSec);
}

/** bake one selection's clip to a grey blockout: repo-external
 *  motion_library/scripts/bake_combat.py under headless blender (cwd MUST be
 *  the lib root, script path absolute — the relative-path compound trap; the
 *  --bvh path is data/-RELATIVE, never data/data/). Renders PNG frames to
 *  <outMp4>.frames/ and returns them — the caller owns the ffmpeg assembly. */
export async function bakeSelectionFrames(
  sel: MotionSelection,
  outMp4: string,
  opts?: {
    blenderBin?: string;
    libRoot?: string;
    glb?: string;
    set?: string[];
    scenes?: string[];
    props?: string[];
    camera?: { lensMm: number; size?: string };
    worldJson?: string;
    lookTarget?: string;
    runCmd?: typeof import("./audio").runCommand;
  },
): Promise<{ framesDir: string; frames: number; log: string }> {
  const run = opts?.runCmd ?? (await import("./audio")).runCommand;
  const blender = opts?.blenderBin || process.env.BLENDER_BIN || "blender";
  const libRoot = opts?.libRoot ?? MOTION_LIB_ROOT;
  const script = path.join(libRoot, "scripts", "bake_combat.py");
  if (!fs.existsSync(script)) throw new Error(`bake script missing: ${script}`);
  const name = path.basename(outMp4, ".mp4");
  const framesDir = outMp4.replace(/\.mp4$/, ".frames");
  fs.mkdirSync(framesDir, { recursive: true });
  const bvh = sel.bvh.replace(/^data\//, ""); // bake prepends data/ itself
  const r = await run(
    blender,
    [
      "-b", "-noaudio", "--factory-startup",
      "-P", script, "--",
      "--solo", "--bvh", bvh,
      "--start", String(sel.bake.start),
      "--len", String(sel.bake.len),
      "--step", String(sel.bake.step),
      "--auto-anchor",
      "--name", name,
      ...(opts?.glb ? ["--glb", opts.glb] : []),
      ...(opts?.set ?? []).flatMap((file) => ["--set", file]),
      ...(opts?.scenes ?? []).flatMap((file) => ["--scene", file]),
      ...(opts?.props ?? []).flatMap((file) => ["--prop", file]),
      ...(opts?.camera ? ["--lens", String(opts.camera.lensMm), "--shot-size", opts.camera.size ?? ""] : []),
      ...(opts?.worldJson ? ["--world-json", opts.worldJson] : []),
      ...(opts?.lookTarget ? ["--look-target", opts.lookTarget] : []),
      // frames land in /tmp/{name}_frames — move them under the job so the
      // assembly is self-contained: the script has no --out flag (repo-external)
    ],
    libRoot,
    { DISPLAY: undefined, WAYLAND_DISPLAY: undefined, LIBGL_ALWAYS_SOFTWARE: "1" },
  );
  const done = /FULL_DONE dir=(\S+) frames=(\d+)/.exec(r.stdout);
  if (r.code !== 0 || !done) {
    throw new Error(`bake failed for ${sel.shot} (${sel.bvh}, exit ${r.code}): ${(r.stderr || r.stdout).slice(-400)}`);
  }
  const src = done[1]!;
  const want = Math.floor(sel.bake.len / sel.bake.step);
  const got = Number(done[2]!);
  if (got !== want) throw new Error(`bake frames ${got} != window ${sel.bake.len}/${sel.bake.step} = ${want}`);
  // /tmp and the job dir live on different devices — copy, never rename (EXDEV)
  for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(framesDir, f));
  fs.rmSync(src, { recursive: true, force: true });
  return { framesDir, frames: got, log: r.stdout };
}

/** frames a multishot shot actually DELIVERS: H3's 17k+5 grid up-snap (a 119
 *  request lands as 124 — run5 live, ffprobe 248 = 124+124 on a 124+119 ask) */
export function msGridFrames(n: number): number {
  return Math.max(5, Math.ceil((n - 5) / 17) * 17 + 5);
}

/** One multishot call uses one length for every shot. The node then lands on
 *  the 17k+5 grid, so the request is already on that grid and the file is
 *  count times that length. */
export function segmentFrameBudget(durations: number[]): { perShot: number; total: number } {
  const longest = durations.reduce((m, d) => Math.max(m, snapFramesPerShot(d)), 0);
  const perShot = msGridFrames(longest);
  return { perShot, total: durations.length * perShot };
}
