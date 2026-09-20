import fs from "node:fs";
import type { CallSheet } from "./types";

/** Load a plugged callsheet JSON. It drives every later stage (marks, cameras,
 *  prose, QC people counts), so the shape is gated hard before use. */
export function loadCallSheet(jsonPath: string): CallSheet {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  } catch (err) {
    throw new Error(`callsheet ${jsonPath} unreadable: ${err instanceof Error ? err.message : String(err)}`);
  }
  const sheet = raw as Partial<CallSheet>;
  const topFields = [
    "title", "logline", "language", "location", "timeOfDay", "weather", "mood",
    "durationSec", "aspect", "characters", "styleBible", "shots", "voiceover",
  ] as const;
  const missing = topFields.filter((k) => sheet[k] === undefined || sheet[k] === null);
  if (missing.length) {
    throw new Error(`callsheet ${jsonPath} missing fields: ${missing.join(", ")}`);
  }
  if (!sheet.characters!.length) throw new Error(`callsheet ${jsonPath} has no characters`);
  const STANCES = ["stand", "lean", "crouch"] as const;
  for (const c of sheet.characters!) {
    const need = (["id", "name", "role", "wardrobe", "palette", "voice"] as const).filter(
      (k) => c[k] === undefined || c[k] === null,
    );
    if (need.length) throw new Error(`callsheet ${jsonPath} character ${c.id ?? "?"} missing: ${need.join(", ")}`);
    if (c.heightM !== undefined && (typeof c.heightM !== "number" || c.heightM < 0.5 || c.heightM > 2.5)) {
      throw new Error(`callsheet ${jsonPath} character ${c.id} heightM must be 0.5–2.5 m, got ${String(c.heightM)}`);
    }
  }
  if (!sheet.shots!.length) throw new Error(`callsheet ${jsonPath} has no shots`);
  for (const s of sheet.shots!) {
    const need = (
      ["id", "index", "heading", "size", "location", "action", "dialogue", "durationSec", "camera", "marks", "stillPrompt", "motionPrompt"] as const
    ).filter((k) => s[k] === undefined || s[k] === null);
    if (need.length) throw new Error(`callsheet ${jsonPath} shot ${s.id ?? "?"} missing: ${need.join(", ")}`);
    if (!/^SH\d{2,}$/.test(s.id)) {
      throw new Error(`callsheet ${jsonPath} shot id '${s.id}' must match SHxx — the wav plug keys off \${id}.wav`);
    }
    // card C3: the angle column is optional (absent = front). 90° is a prompt
    // ban, never a stored value, so the gate only knows front|45.
    if (s.refAngle !== undefined && s.refAngle !== "front" && s.refAngle !== "45") {
      throw new Error(`callsheet ${jsonPath} shot ${s.id} refAngle '${String(s.refAngle)}' is not front|45`);
    }
    for (const m of s.marks!) {
      if (!sheet.characters!.some((c) => c.id === m.characterId)) {
        throw new Error(`callsheet ${jsonPath} shot ${s.id} mark references unknown character ${m.characterId}`);
      }
      for (const key of ["stance", "stanceEnd"] as const) {
        const v = m[key];
        if (v !== undefined && !STANCES.includes(v)) {
          throw new Error(`callsheet ${jsonPath} shot ${s.id} mark ${m.characterId} ${key} '${String(v)}' is not ${STANCES.join("|")}`);
        }
      }
    }
    for (const p of s.props ?? []) {
      const need = (["name", "shape", "forbid"] as const).filter(
        (k) => p[k] === undefined || p[k] === null,
      );
      if (need.length) throw new Error(`callsheet ${jsonPath} shot ${s.id ?? "?"} prop missing: ${need.join(", ")}`);
      if (p.heldBy !== undefined && !s.marks!.some((m) => m.characterId === p.heldBy)) {
        throw new Error(`callsheet ${jsonPath} shot ${s.id} prop heldBy '${p.heldBy}' is not a character in this shot's marks`);
      }
    }
  }
  return sheet as CallSheet;
}
