import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { loadConfig } from "../src/lib/studio/config.ts";
import { chatJsonWithFallback } from "../src/lib/studio/crew-llm.ts";

const OUT = "/home/c/orca/workspaces/sov-cli-merge-wip/hookaudit/verify/nex-seat-smoke";
const receiptRoot = path.join(OUT, "receipts");
fs.mkdirSync(receiptRoot, { recursive: true });

const cfg = loadConfig();
const sheet = JSON.parse(fs.readFileSync("data/jobs/SC-0915-LD0F/callsheet.json", "utf8")) as {
  shots: Array<Record<string, unknown> & { id: string; marks: { characterId: string }[] }>;
};
const shot = sheet.shots.find((s) => s.id === "SH01");
if (!shot) throw new Error("SH01 missing");

const schema = z.object({
  shotId: z.string(),
  camera: z.object({
    lens_mm: z.number(),
    height_m: z.number(),
    aim: z.string().min(1),
  }),
  figures: z
    .array(
      z.object({
        characterId: z.string(),
        stance: z.enum(["stand", "lean", "crouch"]),
        gait: z.enum(["plant", "walk", "reach", "turn"]),
        slot: z.enum(["L", "C", "R"]),
      }),
    )
    .min(1),
  props: z.array(
    z.object({
      name: z.string(),
      heldBy: z.string().nullable(),
    }),
  ),
  bpy_notes: z.array(z.string()).min(1),
});

const system = `你係 slatecrew Blender 席（阿標）。只回一個 JSON object。
schema 必須啱：stance∈stand|lean|crouch；gait∈plant|walk|reach|turn；slot∈L|C|R；
props.heldBy 必須係本鏡 cast characterId 或 null。唔好散文。`;

const user = JSON.stringify(
  {
    task: "draft blocking pack for Blender grey blockout",
    shot: {
      id: shot.id,
      scene: shot.scene,
      size: shot.size,
      location: shot.location,
      action: shot.action,
      dialogue: shot.dialogue,
      durationSec: shot.durationSec,
      marks: shot.marks,
    },
    castIds: [...new Set(shot.marks.map((m) => m.characterId))],
  },
  null,
  2,
);

async function run(effort: "none" | "medium") {
  const dir = path.join(receiptRoot, `real-blender-SH01-${effort}`);
  fs.mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  const out = await chatJsonWithFallback({
    seat: "blender",
    unit: `real.SH01.${effort}`,
    model: cfg.crew.blenderModel,
    fallbackModel: cfg.crew.blenderFallback,
    crew: cfg.crew,
    system,
    user,
    schema,
    receiptDir: dir,
    reasoningEffort: effort,
    maxAttempts: 2,
  });
  return {
    effort,
    ms: Date.now() - t0,
    model: out.model,
    fellBack: out.fellBack,
    primaryError: out.primaryError ?? null,
    receipts: out.receipts,
    value: out.value,
  };
}

async function main() {
  const rows: Array<Record<string, unknown>> = [];
  for (const effort of ["none", "medium"] as const) {
    try {
      const r = await run(effort);
      rows.push({ ok: true, ...r });
      console.log(`PASS effort=${effort} ms=${r.ms} model=${r.model} fellBack=${r.fellBack}`);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      rows.push({ ok: false, effort, error });
      console.error(`FAIL effort=${effort}`, error);
    }
  }

  const summary = {
    ts: new Date().toISOString(),
    door: "chatJsonWithFallback",
    crewEndpoint: cfg.crew.endpoint,
    blenderModel: cfg.crew.blenderModel,
    blenderFallback: cfg.crew.blenderFallback,
    shot: "SC-0915-LD0F/SH01",
    rows,
  };
  fs.writeFileSync(path.join(OUT, "REAL_CALL.json"), `${JSON.stringify(summary, null, 2)}\n`);

  let md = "# Nex real crew door call\n\n";
  md += `- door: \`chatJsonWithFallback\` → \`${cfg.crew.endpoint}\`\n`;
  md += `- primary: \`${cfg.crew.blenderModel}\` fallback \`${cfg.crew.blenderFallback}\`\n`;
  md += `- shot: SC-0915-LD0F SH01\n\n`;
  for (const r of rows) {
    md += `## effort ${r.effort}\n`;
    if (!r.ok) {
      md += `- **FAIL** ${r.error}\n\n`;
      continue;
    }
    md += `- **${r.ms} ms** model=\`${r.model}\` fellBack=${r.fellBack}\n`;
    md += `- receipts: ${(r.receipts as string[]).join(", ")}\n`;
    md += `\`\`\`json\n${JSON.stringify(r.value, null, 2).slice(0, 2500)}\n\`\`\`\n\n`;
  }
  fs.writeFileSync(path.join(OUT, "REAL_CALL.md"), md);
  console.log(md);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
