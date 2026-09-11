import fs from "node:fs";
import type { CallSheet, Character, ProduceInput, Shot, ShotSize } from "./types";

function hasCjk(s: string) {
  return /[\u3400-\u9fff]/.test(s);
}

function pick<T>(re: RegExp, text: string, fallback: T): T | string {
  const m = text.match(re);
  return (m?.[1]?.trim() as T) ?? fallback;
}

const LOC_RULES: { re: RegExp; loc: string; weather: CallSheet["weather"]; time: CallSheet["timeOfDay"] }[] = [
  { re: /茶餐|冰室|diner|cafe/, loc: "雨夜茶餐廳", weather: "rain", time: "night" },
  { re: /天台|rooftop/, loc: "市區天台", weather: "wind", time: "night" },
  { re: /街|lane|street|巷/, loc: "濕漉漉後巷", weather: "rain", time: "night" },
  { re: /海|pier|harbour|harbor/, loc: "碼頭", weather: "wind", time: "dusk" },
  { re: /辦公|office|studio/, loc: "夜間工作室", weather: "clear", time: "night" },
  { re: /晨|dawn|sunrise/, loc: "空曠廣場", weather: "clear", time: "dawn" },
];

function namesFrom(brief: string): string[] {
  const found = [
    ...brief.matchAll(/「([^」]{1,6})」/g),
    ...brief.matchAll(/([\p{Script=Han}]{2,4})(?=同|和|與|跟)/gu),
  ].map((m) => m[1] ?? "");
  const uniq = [...new Set(found.filter(Boolean))];
  if (uniq.length >= 2) return uniq.slice(0, 2);
  if (hasCjk(brief)) return ["阿月", "阿衡"];
  return ["Yue", "Heng"];
}

function dialogueFrom(brief: string, language: CallSheet["language"]) {
  const quoted = brief.match(/[「"]([^」"]{4,40})[」"]/);
  if (quoted?.[1]) return quoted[1];
  if (language === "en") return "You still remember the light above that door?";
  return "你仲記得個門口個燈？";
}

export function draftCallSheet(input: ProduceInput): CallSheet {
  const brief = input.brief.trim();
  const language: CallSheet["language"] = input.language === "en" || (!hasCjk(brief) && input.language !== "yue")
    ? "en"
    : /粤|粵|廣東|广东|yue|canton/i.test(brief) || input.language === "yue"
      ? "yue"
      : "zh-Hant";
  const rule = LOC_RULES.find((r) => r.re.test(brief)) ?? LOC_RULES[0]!;
  const names = namesFrom(brief);
  const durationSec = Math.min(24, Math.max(8, input.durationSec ?? 12));
  const aspect = input.aspect ?? "16:9";
  const title =
    language === "en"
      ? pick(/title[:：]\s*(.+)/i, brief, "The Door Light")
      : pick(/片名[:：]\s*(.+)/, brief, "門口個燈");
  const characters: Character[] = [
    {
      id: "A",
      name: names[0] ?? "A",
      role: language === "en" ? "waiting" : "擋門的人",
      wardrobe: language === "en" ? "wool coat, wet shoulders" : "深色大衣，膊頭有雨",
      palette: ["#6b2a2a", "#e8c4a8", "#1b1210"],
      voice: { pitchHz: 196, gender: "f" },
    },
    {
      id: "B",
      name: names[1] ?? "B",
      role: language === "en" ? "returning" : "行近的人",
      wardrobe: language === "en" ? "shirt, rolled sleeves" : "白裇衫，袖口反起",
      palette: ["#24344a", "#d7c2a4", "#10141c"],
      voice: { pitchHz: 118, gender: "m" },
    },
  ];
  const line = dialogueFrom(brief, language);
  const loc = rule.loc;
  const sizes: ShotSize[] = ["wide", "full", "medium", "closeup"];
  const gaits: Shot["marks"][number]["gait"][] = ["plant", "walk", "reach", "turn"];
  const per = durationSec / 4;
  const shots: Shot[] = sizes.map((size, i) => {
    const gait = gaits[i] ?? "plant";
    const action =
      i === 0
        ? language === "en"
          ? "Establishing: rain hits the glass, a figure waits at the door."
          : "定場：雨打玻璃，有人喺門口等。"
        : i === 1
          ? language === "en"
            ? "B walks in. Feet plant on the wet tile; no slide."
            : "B 行入。腳踏濕磚，唔好滑步。"
          : i === 2
            ? language === "en"
              ? "A reaches for the door. Hands stay in frame, fingers clear."
              : "A 伸手擋門。手要入畫，手指清楚。"
            : language === "en"
              ? "Two-shot. The line lands. Eye-line matches."
              : "雙人中近。對白落地。視線要對上。";
    return {
      id: `SH${String(i + 1).padStart(2, "0")}`,
      index: i + 1,
      heading: `${size.toUpperCase()} / ${loc}`,
      size,
      location: loc,
      action,
      dialogue: i === 3 ? line : i === 2 ? (language === "en" ? "Stay." : "企喺度。") : "",
      speaker: i >= 2 ? characters[0]?.name : undefined,
      durationSec: per,
      camera: {
        pos: { x: i === 0 ? 6 : 3.2, y: -4.4 + i * 0.3, z: i === 3 ? 1.5 : 1.7 },
        lookAt: { x: 0.2, y: 0.4, z: 1.2 },
        lensMm: size === "wide" ? 24 : size === "closeup" ? 65 : 35,
      },
      marks: [
        {
          characterId: "A",
          start: { x: 38, y: 58 },
          end: { x: 42, y: 56 },
          facing: 1,
          handL: { x: 34, y: 50 },
          handR: { x: 54, y: 44 },
          footL: { x: 36, y: 78 },
          footR: { x: 44, y: 78 },
          gait: i === 2 ? "reach" : "plant",
        },
        {
          characterId: "B",
          start: { x: 18, y: 62 },
          end: { x: 62, y: 60 },
          facing: 1,
          handL: { x: 58, y: 52 },
          handR: { x: 70, y: 50 },
          footL: { x: 58, y: 80 },
          footR: { x: 68, y: 80 },
          gait,
        },
      ],
      stillPrompt: `Cinematic still, ${size} shot, ${loc}, ${rule.time} ${rule.weather}, ${characters.map((c) => `${c.name} wearing ${c.wardrobe}`).join("; ")}, ${action}, photoreal, 4K, practical lights, no extra fingers, planted feet.`,
      motionPrompt: `MiniMax H3 shot: ${action} ${gait} motion, ${per.toFixed(1)}s, native stereo room tone, keep identity, hands and feet anatomically correct.`,
    };
  });
  const voiceover = shots
    .map((s) => s.dialogue)
    .filter(Boolean)
    .join(" ");
  return {
    title: String(title),
    logline: brief.slice(0, 180) || (language === "en" ? "Two classmates meet again at a rainy cafe door." : "兩個舊同學喺雨夜茶餐廳門口重逢。"),
    language,
    location: loc,
    timeOfDay: rule.time,
    weather: rule.weather,
    mood: language === "en" ? "tender, wet, withheld" : "克制、潮濕、未講完",
    durationSec,
    aspect,
    characters,
    styleBible: {
      grade: "tungsten practicals, teal rain highlights, crushed blacks",
      refs: ["Wong Kar-wai doorways", "wet tile reflections", "handheld stillness"],
      stillModel: "SenseNova U1.5-8B-MoT",
      motionModel: "MiniMax H3 FL2VA / Ref2VA",
    },
    shots,
    voiceover: voiceover || line,
  };
}

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
