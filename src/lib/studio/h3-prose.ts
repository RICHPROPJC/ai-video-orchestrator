import type { CallSheet, Shot } from "./types";

export const SCRIPT_HEADER = "# produced_by: slatecrew_h3_submit";

// the 40-sample skeleton: one motion sentence naming <Video 1>, nothing else
// competes with the motion copy
export const VIDEO_SENTENCE = `Have the {{N}} people act following the movements of the grey placeholders in <Video 1> — they carry motion only; replace their look entirely.`;

export const PIN_SENTENCE = `Faces, clothes, the {{PROP}} and the field continue exactly from the start keyframe image. Do not add people.`;

const BANNED_LABELS = [
  "subject_definitions:",
  "summary:",
  "retention_analysis:",
  "detailed_description:",
  "overall_soundscape:",
  "non_diegetic_music:",
];

/** any line whose first word ends with a colon is a section label (F2: rg
 *  "^[A-Za-z一-龥]+[:：]" over produced prose must return 0 hits) */
const LABEL_LINE = /^[一-鿿A-Za-z]+[:：]/m;

const WORD = /[A-Za-z][A-Za-z'-]*/g;
const CJK = /[㐀-鿿豈-﫿]/g;
const SENT = /[^.]+/g;
const QUOTED = /["「]([^"」]+)["」]/g;

// T42 (FABLE_RULING_PROMPT_ALIGN_0917 H3＝A): two modes, decided by the
// packet, never by a person. The single 70-word cap is abolished.
//  - action-short: visible verb in require.action, no dialogue, ≤1 character → ≤70 詞
//  - identity-long: dialogue / ≥2 characters / heavy scene → 150–300 詞 prose, zero labels
export const ACTION_SHORT_MAX = 70;
export const IDENTITY_LONG_MIN = 150;
export const IDENTITY_LONG_MAX = 300;

export type ProseMode = "action-short" | "identity-long";

/** 詞 count: ASCII words + CJK characters (1 char ≈ 1 詞), quotes included */
export function countWords(text: string): number {
  return (text.match(WORD) ?? []).length + (text.match(CJK) ?? []).length;
}

const VERB_CHARS = new Set(
  "跳舞轉跑走踢翻舉揮蹲躺跪倚滑拍擲推拉撲爬握撥掃剪寫畫飲食烹洗灑澆犁播種收割扛抬搬鋤劈砍削刨鋸鑿敲擦抹抱牽扶攙背馱趕追逐逃躲閃迎送開旋搖擺指望看聽喊叫唱呼吼奔漫步衝撲跌撞搖晃跌坐站臥趴仰俯側靠",
);
const EN_VERB_STEMS =
  "dance turn run walk kick jump leap spin slide wave lift carry push pull climb crawl throw catch hold reach step hop crouch kneel lie lean stumble stagger dash sprint drift float sway sit stand rise fall point stare gaze smile laugh cry shout speak listen".split(
    " ",
  );

/** regular inflections of each stem (spins/spinning/danced…). Irregular past
 *  tenses are deliberately not listed — this is a presence heuristic for
 *  require.action, not a parser. */
function enVerbPattern(): string {
  const formsOf = (stem: string): string[] => {
    const out = [stem, `${stem}s`, `${stem}es`, `${stem}ed`, `${stem}ing`];
    if (stem.endsWith("e")) out.push(`${stem.slice(0, -1)}ing`, `${stem.slice(0, -1)}d`);
    if (/[bcdfgklmnprstvz]$/.test(stem) && !/[aeiou][aeiou]$/.test(stem) && stem.length > 2) {
      out.push(`${stem}${stem.at(-1)}ing`, `${stem}${stem.at(-1)}ed`);
    }
    return out;
  };
  return `\\b(${EN_VERB_STEMS.flatMap(formsOf).join("|")})\\b`;
}
const EN_VERBS = new RegExp(enVerbPattern(), "i");

/** require.action carries a visible verb (single CJK verb char or EN verb) */
export function hasVisibleVerb(action: string): boolean {
  if (EN_VERBS.test(action)) return true;
  return [...action].some((ch) => VERB_CHARS.has(ch));
}

/** 場景重: props present, or a location long enough to need describing */
function sceneHeavy(sheet: CallSheet, shot: Shot): boolean {
  if ((shot.props?.length ?? 0) > 0) return true;
  if (countWords(sheet.location) > 10) return true;
  return countWords(`${sheet.weather} ${sheet.mood}`) > 6;
}

/** Two modes, decided by the packet — dialogue / ≥2 characters / heavy scene
 *  force identity-long; only a solo, silent, light scene with a visible verb
 *  in require.action may run action-short. */
export function pickProseMode(sheet: CallSheet, shot: Shot): ProseMode {
  if (shot.dialogue.trim().length > 0) return "identity-long";
  if (new Set(shot.marks.map((m) => m.characterId)).size > 1) return "identity-long";
  if (sceneHeavy(sheet, shot)) return "identity-long";
  if (!hasVisibleVerb(shot.action)) return "identity-long";
  return "action-short";
}

function words(text: string): number {
  return (text.match(WORD) ?? []).length;
}

/** wardrobe clauses long enough to be distinctive — used as banned strings */
export function wardrobeClauses(sheet: CallSheet): string[] {
  return sheet.characters
    .flatMap((c) => c.wardrobe.split(/[,，、]/))
    .map((s) => s.trim())
    .filter((s) => s.length >= 3);
}

export type ValidateProseOpts = {
  /** quoted-line + Audio 1 checks apply only when the shot has dialogue */
  requireQuote?: boolean;
  /** wardrobe belongs to the /edit pin, never to the prose */
  wardrobe?: string[];
  /** explicit mode; omitted = bucket check (must land in either mode's range) */
  mode?: ProseMode;
};

function budgetCheck(body: string, mode: ProseMode | undefined): void {
  const total = countWords(body);
  if (mode === "action-short") {
    if (total > ACTION_SHORT_MAX) {
      throw new Error(`action-short over budget: ${total} 詞 (max ${ACTION_SHORT_MAX})`);
    }
    return;
  }
  if (mode === "identity-long") {
    if (total < IDENTITY_LONG_MIN || total > IDENTITY_LONG_MAX) {
      throw new Error(
        `identity-long out of range: ${total} 詞 (need ${IDENTITY_LONG_MIN}–${IDENTITY_LONG_MAX})`,
      );
    }
    return;
  }
  // no explicit mode: the official distribution has no 71–149 詞 middle
  if (total > ACTION_SHORT_MAX && total < IDENTITY_LONG_MIN) {
    throw new Error(
      `${total} 詞 falls between modes — action-short ≤${ACTION_SHORT_MAX} or identity-long ${IDENTITY_LONG_MIN}–${IDENTITY_LONG_MAX}`,
    );
  }
  if (total > IDENTITY_LONG_MAX) {
    throw new Error(`${total} 詞 over identity-long max ${IDENTITY_LONG_MAX}`);
  }
}

export function validateProse(script: string, opts: ValidateProseOpts = {}): void {
  const requireQuote = opts.requireQuote !== false;
  const head = script.split("\n").map((l) => l.trim()).find((l) => l.length) ?? "";
  if (head !== SCRIPT_HEADER) {
    throw new Error(`script header must be '${SCRIPT_HEADER}' (got '${head.slice(0, 60)}')`);
  }
  const body = script.slice(script.indexOf(SCRIPT_HEADER) + SCRIPT_HEADER.length).replace(/^\n+/, "");
  const low = body.toLowerCase();
  const sentences = body.match(SENT) ?? [];

  for (const lab of BANNED_LABELS) {
    if (low.includes(lab)) throw new Error(`section label '${lab}' is banned`);
  }
  if (LABEL_LINE.test(body)) {
    const line = body.split("\n").find((l) => LABEL_LINE.test(l)) ?? "";
    throw new Error(`label line banned in prose: '${line.trim().slice(0, 60)}'`);
  }
  const motionSentence = sentences.some((s) => {
    const sl = s.toLowerCase();
    return sl.includes("<video 1>") && sl.includes("motion only") &&
      (sl.includes("grey") || sl.includes("gray") || sl.includes("placeholder"));
  });
  if (!motionSentence) throw new Error("no <Video 1> motion-only sentence");
  if (!low.includes("photoreal")) throw new Error("'Photoreal' is required");
  const quotes = [...body.matchAll(QUOTED)].map((m) => m[1] ?? "");
  if (requireQuote) {
    if (quotes.length === 0) {
      throw new Error("spoken line missing — quote the slice text");
    }
    if (!sentences.some((s) => s.includes("Audio 1"))) {
      throw new Error("dialogue must be introduced as the Audio 1 line");
    }
  }
  for (const clause of opts.wardrobe ?? []) {
    if (body.includes(clause)) {
      throw new Error(`wardrobe belongs to the pin, not the prose: '${clause.slice(0, 30)}'`);
    }
  }
  budgetCheck(body, opts.mode);
}

function speakerSide(shot: Shot, speakerMarkX: number): "left" | "right" {
  const xs = shot.marks.map((m) => m.start.x).filter((x) => x !== speakerMarkX);
  const other = xs.length ? Math.min(...xs) : speakerMarkX;
  return speakerMarkX <= other ? "left" : "right";
}

/** prose body from shot fields only — exactly the 40-sample skeleton:
 *  setting / motion / pin / (dialogue). Caller prepends SCRIPT_HEADER. */
const BANNED_NEGATIVES = /\b(ignore|do not|don't|never|grey|gray|placeholder|mannequin)\b/i;

export type BuildProsePositiveOpts = {
  /** C: motion beats only — no Picture assignment lines */
  motionOnly?: boolean;
  portraits?: { id: string; name: string }[];
};

/** B/BKF/C: timed beats, positive tags inline, no Video 1 / grey-model contract. */
export function buildProsePositive(sheet: CallSheet, shot: Shot, opts: BuildProsePositiveOpts = {}): string {
  const location = sheet.location.split(/[,，]/)[0]!.trim();
  const duration = Math.round(shot.durationSec * 10) / 10;
  const mid = Math.round((duration * 0.5) * 10) / 10;
  const ids = [...new Set(shot.marks.map((m) => m.characterId))];
  const chars = ids.map((id) => {
    const hit = sheet.characters.find((c) => c.id === id);
    if (!hit) throw new Error(`${shot.id}: mark references unknown character ${id}`);
    return hit;
  });
  const portraits = opts.portraits ?? chars.map((c) => ({ id: c.id, name: c.name }));
  const lines: string[] = [`Photoreal. ${location}, ${sheet.timeOfDay}.`];
  if (!opts.motionOnly) {
    lines.push("<Picture 1> = scene still.");
    portraits.forEach((p, i) => lines.push(`<Picture ${i + 2}> = ${p.name}.`));
  }
  const castTags = opts.motionOnly
    ? chars.map((c) => c.name).join(", ")
    : chars.map((c, i) => `${c.name} <Picture ${i + 2}>`).join(", ");
  const anchor = opts.motionOnly ? "the start keyframe" : "<Picture 1>";
  lines.push(
    `[0-${mid}s — photorealistic] ${location}, ${sheet.weather}. ${shot.action} ${castTags} anchored by ${anchor}. Audio: ambience.`,
  );
  lines.push(
    `[${mid}-${duration}s — photorealistic] Motion continues through the beat. ${sheet.mood}. Audio: ${sheet.weather} ambience.`,
  );
  const dialogue = shot.dialogue.trim();
  if (dialogue) {
    const speakerName = shot.speaker ?? chars[0]?.name;
    if (!speakerName) throw new Error(`${shot.id}: dialogue but no speaker and no cast`);
    const speakerChar = chars.find((c) => c.name === speakerName);
    const speakerMark = speakerChar ? shot.marks.find((m) => m.characterId === speakerChar.id) : undefined;
    const side = speakerMark ? speakerSide(shot, speakerMark.start.x) : "left";
    const others = chars.filter((c) => c.name !== speakerName).map((c) => c.name);
    const listeners = others.length ? ` ${others.join("、")} ${others.length === 1 ? "listens" : "listen"}.` : "";
    lines.push(`${speakerName} (${side}) speaks the line in Audio 1: "${dialogue}".${listeners}`);
  }
  return lines.join("\n\n");
}

export function validateProsePositive(script: string, opts: ValidateProseOpts & { motionOnly?: boolean } = {}): void {
  const requireQuote = opts.requireQuote !== false;
  const head = script.split("\n").map((l) => l.trim()).find((l) => l.length) ?? "";
  if (head !== SCRIPT_HEADER) {
    throw new Error(`script header must be '${SCRIPT_HEADER}' (got '${head.slice(0, 60)}')`);
  }
  const body = script.slice(script.indexOf(SCRIPT_HEADER) + SCRIPT_HEADER.length).replace(/^\n+/, "");
  const low = body.toLowerCase();
  if (!low.includes("photoreal")) throw new Error("'Photoreal' is required");
  if (BANNED_NEGATIVES.test(body)) throw new Error("positive prose must not use ignore/do-not/grey negatives");
  if (low.includes("<video 1>")) throw new Error("positive prose must not reference <Video 1>");
  if (!opts.motionOnly && !body.includes("<Picture 1>")) {
    throw new Error("positive prose must assign <Picture 1>");
  }
  for (const lab of BANNED_LABELS) {
    if (low.includes(lab)) throw new Error(`section label '${lab}' is banned`);
  }
  if (LABEL_LINE.test(body)) {
    const line = body.split("\n").find((l) => LABEL_LINE.test(l)) ?? "";
    throw new Error(`label line banned in prose: '${line.trim().slice(0, 60)}'`);
  }
  const quotes = [...body.matchAll(QUOTED)].map((m) => m[1] ?? "");
  if (requireQuote) {
    if (quotes.length === 0) throw new Error("spoken line missing — quote the slice text");
    if (!body.includes("Audio 1")) throw new Error("dialogue must be introduced as the Audio 1 line");
  }
  for (const clause of opts.wardrobe ?? []) {
    if (body.includes(clause)) {
      throw new Error(`wardrobe belongs to the pin, not the prose: '${clause.slice(0, 30)}'`);
    }
  }
  // single 70-word cap abolished (T42); B/C stay receipt alternates — only a
  // hard ceiling applies, the mode minimum is enforced on the submitting A path
  const total = countWords(body);
  if (total > IDENTITY_LONG_MAX) {
    throw new Error(`${total} 詞 over identity-long max ${IDENTITY_LONG_MAX}`);
  }
}

const SIZE_PHRASE: Record<Shot["size"], string> = {
  wide: "played wide, the whole place readable around the figures",
  full: "framed full-body so every shift of weight stays in picture",
  medium: "held at medium distance where faces and hands both read",
  closeup: "close on the face, small turns of the head carrying the beat",
  insert: "a tight insert where the detail itself is the action",
};

const GAIT_PHRASE: Record<Shot["marks"][number]["gait"], string> = {
  plant: "feet planted",
  walk: "crossing through the frame",
  reach: "reaching across the space",
  turn: "turning on the spot",
};

/** assemble identity-long prose from packet fields only — every clause traces
 *  to a field (location/timeOfDay/weather/mood/size/action/marks/props/
 *  dialogue/camera/duration). No invented content; a packet too thin to reach
 *  the 150 詞 floor fails loud instead of padding. */
function buildProseLong(sheet: CallSheet, shot: Shot, chars: ReturnType<typeof shotCast>): string {
  const location = sheet.location.split(/[,，]/)[0]!.trim();
  const prop = shot.props?.[0]?.name ?? "props";
  const duration = Math.round(shot.durationSec * 10) / 10;
  const speakerName = shot.speaker ?? chars[0]?.name;
  const speakerChar = chars.find((c) => c.name === speakerName);
  const speakerMark = speakerChar ? shot.marks.find((m) => m.characterId === speakerChar.id) : undefined;
  const side = speakerMark ? speakerSide(shot, speakerMark.start.x) : "left";
  const cast = chars.map((c) => `${c.name} (${c.role})`).join("、");

  const blocking = shot.marks
    .map((m) => {
      const who = chars.find((c) => c.id === m.characterId);
      if (!who) return "";
      const frameSide = m.start.x <= 50 ? "frame-left" : "frame-right";
      const gait = GAIT_PHRASE[m.gait];
      const stance = m.stance && m.stance !== "stand" ? `, ${m.stance}ing` : "";
      return `${who.name} ${gait}${stance} ${frameSide}`;
    })
    .filter(Boolean)
    .join("; ");

  const cameraHeight = shot.camera.pos.y >= 1.4 ? "the camera at eye height" : "the camera held low";
  const paras = [
    // setting — 場景重 gets described, not labelled
    `Photoreal. ${location}, ${sheet.timeOfDay}, ${sheet.weather}; ${sheet.mood}. ` +
      `The shot ${SIZE_PHRASE[shot.size]}, ${duration} seconds end to end, on a ${shot.camera.lensMm}mm lens ` +
      `with ${cameraHeight}, framed ${sheet.aspect}.`,
    // who + motion contract
    `${cast}. ${shot.action} ${blocking}. ` +
      VIDEO_SENTENCE.replace("{{N}}", String(chars.length)),
    // pin
    PIN_SENTENCE.replace("{{PROP}}", prop),
  ];
  const dialogue = shot.dialogue.trim();
  if (dialogue) {
    if (!speakerName) throw new Error(`${shot.id}: dialogue but no speaker and no cast`);
    const others = chars.filter((c) => c.name !== speakerName).map((c) => c.name);
    const listeners = others.length ? ` ${others.join("、")} ${others.length === 1 ? "listens" : "listen"}.` : "";
    paras.push(`${speakerName} (${side}) speaks the line in Audio 1: "${dialogue}".${listeners}`);
  }
  const body = paras.join("\n\n");
  const total = countWords(body);
  if (total < IDENTITY_LONG_MIN) {
    throw new Error(
      `prompt_too_thin: packet fields weave only ${total} 詞 — identity-long needs ${IDENTITY_LONG_MIN}–${IDENTITY_LONG_MAX}; enrich the packet, never pad`,
    );
  }
  return body;
}

function shotCast(sheet: CallSheet, shot: Shot) {
  const ids = [...new Set(shot.marks.map((m) => m.characterId))];
  return ids.map((id) => {
    const hit = sheet.characters.find((c) => c.id === id);
    if (!hit) throw new Error(`${shot.id}: mark references unknown character ${id}`);
    return hit;
  });
}

/** H3＝A prose, mode decided by the packet (T42):
 *  action-short keeps the 40-sample skeleton (≤70 詞);
 *  identity-long weaves 150–300 詞 label-free prose from packet fields. */
export function buildProse(sheet: CallSheet, shot: Shot): string {
  const mode = pickProseMode(sheet, shot);
  if (mode === "identity-long") {
    return buildProseLong(sheet, shot, shotCast(sheet, shot));
  }
  const chars = shotCast(sheet, shot);
  const location = sheet.location.split(/[,，]/)[0]!.trim();
  const prop = shot.props?.[0]?.name ?? "props";
  const parts = [
    `Photoreal. ${location}, ${sheet.timeOfDay}.`,
    VIDEO_SENTENCE.replace("{{N}}", String(chars.length)),
    PIN_SENTENCE.replace("{{PROP}}", prop),
  ];
  const dialogue = shot.dialogue.trim();
  if (dialogue) {
    // unreachable: pickProseMode routes dialogue to identity-long
    throw new Error(`${shot.id}: action-short cannot carry dialogue`);
  }
  return parts.join("\n\n");
}

export { words };
