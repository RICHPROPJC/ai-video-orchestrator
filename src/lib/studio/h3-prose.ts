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

const WORD = /[A-Za-z][A-Za-z'-]*/g;
const SENT = /[^.]+/g;
const QUOTED = /["「]([^"」]+)["」]/g;
const UNQUOTED_MAX = 70;
const TOTAL_MAX = 200;

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
};

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
  for (const ln of body.split("\n")) {
    if (ln.trim().toLowerCase().startsWith("camera:")) {
      throw new Error(`'Camera:' label lines are banned: '${ln.trim().slice(0, 60)}'`);
    }
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
  const quoteWords = quotes.reduce((a, s) => a + words(s), 0);
  const unquoted = words(body.replace(new RegExp(QUOTED.source, "g"), " "));
  if (unquoted > UNQUOTED_MAX || unquoted + quoteWords > TOTAL_MAX) {
    throw new Error(
      `over budget: ${unquoted} unquoted + ${quoteWords} quoted ` +
        `= ${unquoted + quoteWords} (max ${UNQUOTED_MAX}/${TOTAL_MAX})`,
    );
  }
}

function speakerSide(shot: Shot, speakerMarkX: number): "left" | "right" {
  const xs = shot.marks.map((m) => m.start.x).filter((x) => x !== speakerMarkX);
  const other = xs.length ? Math.min(...xs) : speakerMarkX;
  return speakerMarkX <= other ? "left" : "right";
}

/** prose body from shot fields only — exactly the 40-sample skeleton:
 *  setting / motion / pin / (dialogue). Caller prepends SCRIPT_HEADER. */
export function buildProse(sheet: CallSheet, shot: Shot): string {
  const ids = [...new Set(shot.marks.map((m) => m.characterId))];
  const chars = ids.map((id) => {
    const hit = sheet.characters.find((c) => c.id === id);
    if (!hit) throw new Error(`${shot.id}: mark references unknown character ${id}`);
    return hit;
  });
  const location = sheet.location.split(/[,，]/)[0]!.trim();
  const prop = shot.props?.[0]?.name ?? "props";
  const parts = [
    `Photoreal. ${location}, ${sheet.timeOfDay}.`,
    VIDEO_SENTENCE.replace("{{N}}", String(chars.length)),
    PIN_SENTENCE.replace("{{PROP}}", prop),
  ];
  const dialogue = shot.dialogue.trim();
  if (dialogue) {
    const speakerName = shot.speaker ?? chars[0]?.name;
    if (!speakerName) throw new Error(`${shot.id}: dialogue but no speaker and no cast`);
    const speakerChar = chars.find((c) => c.name === speakerName);
    const speakerMark = speakerChar
      ? shot.marks.find((m) => m.characterId === speakerChar.id)
      : undefined;
    const side = speakerMark ? speakerSide(shot, speakerMark.start.x) : "left";
    const others = chars.filter((c) => c.name !== speakerName).map((c) => c.name);
    const listeners = others.length ? ` ${others.join("、")} ${others.length === 1 ? "listens" : "listen"}.` : "";
    parts.push(`${speakerName} (${side}) speaks the line in Audio 1: "${dialogue}".${listeners}`);
  }
  return parts.join("\n\n");
}
