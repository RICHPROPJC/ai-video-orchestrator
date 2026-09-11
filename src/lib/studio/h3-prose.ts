import type { CallSheet, Shot } from "./types";

export const SCRIPT_HEADER = "# produced_by: slatecrew_h3_submit";

export const VIDEO_SENTENCE =
  "The grey placeholders in <Video 1> carry motion only — follow their positions " +
  "and timing; replace their look entirely.";

export const PIN_SENTENCE =
  "Faces and clothes stay as the start and end keyframe images. Do not add people.";

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
const UNQUOTED_MAX = 140;
const TOTAL_MAX = 200;

function words(text: string): number {
  return (text.match(WORD) ?? []).length;
}

export type ValidateProseOpts = {
  /** quoted-line check applies only when the shot has dialogue (silent shots have none) */
  requireQuote?: boolean;
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
  if (requireQuote && quotes.length === 0) {
    throw new Error("spoken line missing — quote the slice text");
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

/** prose body from shot fields only — sheet supplies the cast, shot supplies the rest.
 *  Caller prepends SCRIPT_HEADER before validateProse. */
export function buildProse(sheet: CallSheet, shot: Shot): string {
  const ids = [...new Set(shot.marks.map((m) => m.characterId))];
  const chars = ids.map((id) => {
    const hit = sheet.characters.find((c) => c.id === id);
    if (!hit) throw new Error(`${shot.id}: mark references unknown character ${id}`);
    return hit;
  });
  const parts = [
    `Photoreal. ${sheet.location}，${sheet.timeOfDay}，${sheet.weather}。${shot.size} shot，${shot.action} ` +
      `${ids.length} people. No one else.`,
  ];
  for (const c of chars) {
    parts.push(`${c.name}（${c.role}）：${c.wardrobe}。`);
  }
  parts.push(VIDEO_SENTENCE);
  parts.push(PIN_SENTENCE);
  const dialogue = shot.dialogue.trim();
  if (dialogue) {
    const speaker = shot.speaker ?? chars[0]?.name;
    if (!speaker) throw new Error(`${shot.id}: dialogue but no speaker and no cast`);
    parts.push(`${speaker}: "${dialogue}"`);
  }
  return parts.join("\n\n");
}
