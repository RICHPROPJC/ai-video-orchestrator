import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { planStoryWorld } from "./world-assemble";
import type { WorldPiece } from "./world-scale";

const JOB = "/mnt/ssd/ai-video-orchestrator-crew/data/jobs/SC-0923-1KU5";

function realPieces(): { pieces: WorldPiece[]; shots: { id: string; lensMm: number; size: string; location?: string; heldPropId?: string }[] } {
  const sheet = JSON.parse(fs.readFileSync(path.join(JOB, "callsheet.json"), "utf8")) as {
    characters: { id: string; heightM?: number }[];
    shots: { id: string; location?: string; size: string; camera: { lensMm: number }; props?: { name: string; heldBy?: string; sizeM?: number; sizeSource?: string }[] }[];
  };
  const rig = (id: string) => path.join(JOB, "cast", id, "mesh_front_rigged.glb");
  const sceneNames = new Set(sheet.shots.map((s) => s.location).filter(Boolean));
  const pieces: WorldPiece[] = [];
  for (const person of sheet.characters) {
    pieces.push({ id: person.id, role: "character", glb: rig(person.id), heightM: person.heightM });
  }
  for (const id of ["木檯", "玻璃檸檬汽水樽"]) {
    const named = sheet.shots.flatMap((s) => s.props ?? []).find((p) => p.name === id);
    pieces.push({
      id,
      role: sceneNames.has(id) ? "scene" : "prop",
      glb: rig(id),
      sizeM: named?.sizeM,
      sizeSource: named?.sizeSource,
      heldBy: named?.heldBy,
    });
  }
  return {
    pieces,
    shots: sheet.shots.map((s) => ({
      id: s.id,
      lensMm: s.camera.lensMm,
      size: s.size,
      location: s.location,
      heldPropId: s.props?.find((p) => p.heldBy)?.name,
    })),
  };
}

test("real job SC-0923-1KU5: 冇寫尺寸就跟阿檸 heightM", () => {
  const { pieces, shots } = realPieces();
  for (const piece of pieces) assert.equal(fs.existsSync(piece.glb), true, piece.glb);
  const plan = planStoryWorld(pieces, shots);
  assert.equal(plan.pieces.find((p) => p.id === "木檯")!.meters, 1);
  assert.equal(plan.pieces.find((p) => p.id === "玻璃檸檬汽水樽")!.meters, 0.25);
});

test("real job: 自動比例唔寫入 job 嘅 sizes.json", async () => {
  const { pieces, shots } = realPieces();
  const plan = planStoryWorld(pieces, shots);
  assert.equal(plan.pieces.length, 3);
  assert.equal(fs.existsSync(path.join(JOB, "world", "sizes.json")), false);
});
