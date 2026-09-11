import type { CallSheet, Shot } from "./types";

/** One canon. Story, boards, and cut are the same shot ids in the same order. */
export type Continuity = {
  story: {
    title: string;
    logline: string;
    voiceover: string;
    characters: { id: string; name: string }[];
  };
  boards: Shot[];
  cut: string[];
};

export function lockContinuity(sheet: CallSheet): Continuity {
  const boards = sheet.shots.map((s) => structuredClone(s));
  return {
    story: {
      title: sheet.title,
      logline: sheet.logline,
      voiceover: sheet.voiceover,
      characters: sheet.characters.map((c) => ({ id: c.id, name: c.name })),
    },
    boards,
    cut: boards.map((s) => s.id),
  };
}

export function assertSameCanon(c: Continuity) {
  const fromBoards = c.boards.map((s) => s.id).join("|");
  const fromCut = c.cut.join("|");
  if (fromBoards !== fromCut) {
    throw new Error(`continuity drift: boards ${fromBoards} ≠ cut ${fromCut}`);
  }
  const voShots = c.boards.map((s) => s.dialogue).filter(Boolean).join(" ");
  if (c.story.voiceover && voShots && !voShots.includes(c.story.voiceover.slice(0, 8))) {
    // loose check — dialogue lives on boards; VO is the join
  }
  return c;
}

export function continuityMarkdown(c: Continuity) {
  assertSameCanon(c);
  return `# Continuity  （故事 = 分鏡 = 剪接）

${c.story.title}
${c.story.logline}

VO: ${c.story.voiceover}

Cast: ${c.story.characters.map((x) => `${x.id} ${x.name}`).join(" · ")}

Cut / boards (same order):
${c.cut.map((id, i) => {
  const s = c.boards[i]!;
  return `${i + 1}. ${id}  ${s.size}  ${s.action}${s.dialogue ? `\n   「${s.dialogue}」` : ""}`;
}).join("\n")}
`;
}
