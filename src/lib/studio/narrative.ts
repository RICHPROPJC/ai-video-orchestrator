import type { CallSheet } from "./types";
import type { Continuity } from "./continuity";
import { assertSameCanon } from "./continuity";

/** ViMax idea2video DAG, collapsed onto our SH ids. Story = boards = cut. */
export const NARRATIVE_DAG = [
  "brief",
  "characters",
  "script",
  "storyboard",
  "shots",
  "camera",
  "frames",
  "clips",
  "cut",
] as const;

export type NarrativeStage = (typeof NARRATIVE_DAG)[number];

export type NarrativeNode = {
  id: string;
  stage: NarrativeStage;
  shotId?: string;
  text: string;
};

export type NarrativePlan = {
  slate: string;
  workflow: "idea2video" | "script2video";
  dag: NarrativeStage[];
  sameCanon: true;
  cut: string[];
  nodes: NarrativeNode[];
};

export function buildNarrativePlan(opts: {
  slate: string;
  brief: string;
  sheet: CallSheet;
  continuity: Continuity;
}): NarrativePlan {
  const c = assertSameCanon(opts.continuity);
  const nodes: NarrativeNode[] = [
    { id: "brief", stage: "brief", text: opts.brief.trim() },
    {
      id: "characters",
      stage: "characters",
      text: c.story.characters.map((x) => `${x.id} ${x.name}`).join(" · "),
    },
    {
      id: "script",
      stage: "script",
      text: `${c.story.title}\n${c.story.logline}\n${c.story.voiceover}`,
    },
  ];
  for (const shot of c.boards) {
    nodes.push({
      id: `board-${shot.id}`,
      stage: "storyboard",
      shotId: shot.id,
      text: `${shot.id} ${shot.size} ${shot.action}${shot.dialogue ? ` 「${shot.dialogue}」` : ""}`,
    });
    nodes.push({
      id: `shot-${shot.id}`,
      stage: "shots",
      shotId: shot.id,
      text: shot.stillPrompt,
    });
    nodes.push({
      id: `cam-${shot.id}`,
      stage: "camera",
      shotId: shot.id,
      text: `${shot.camera.lensMm}mm look ${JSON.stringify(shot.camera.lookAt)} marks ${shot.marks.map((m) => `${m.characterId}:${m.gait}`).join(",")}`,
    });
  }
  nodes.push({
    id: "cut",
    stage: "cut",
    text: c.cut.join(" → "),
  });
  return {
    slate: opts.slate,
    workflow: /script|screenplay|劇本/i.test(opts.brief) ? "script2video" : "idea2video",
    dag: [...NARRATIVE_DAG],
    sameCanon: true,
    cut: c.cut,
    nodes,
  };
}

export function planMarkdown(plan: NarrativePlan) {
  return `# Narrative plan  ${plan.slate}

workflow: ${plan.workflow}
DAG: ${plan.dag.join(" → ")}
cut = storyboard: ${plan.cut.join(" → ")}

${plan.nodes
  .map((n) => `## ${n.stage}${n.shotId ? ` / ${n.shotId}` : ""}\n${n.text}`)
  .join("\n\n")}
`;
}
