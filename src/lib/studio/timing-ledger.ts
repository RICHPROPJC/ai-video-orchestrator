// PHASE 0.4: canonical timing ledger.
// Source of truth = continuity.durationSec (story clock).
// H3 generation frames are snapped onto the official 17k+5 grid.

import fs from "node:fs";
import path from "node:path";
import { jobDir, jobFile, ensureDir } from "./paths";
import { FPS, snapDurationToFrames } from "./frame-grid";

export type TimingLedgerShot = {
  id: string;
  storySec: number;
  frames: number;
  genSec: number;
};

export type TimingLedger = {
  version: 1;
  fps: number;
  createdAt: string;
  shots: TimingLedgerShot[];
  totalStorySec: number;
  totalFrames: number;
  totalGenSec: number;
};

export function writeTimingLedger(
  jobId: string,
  shots: { id: string; durationSec: number }[],
): TimingLedger {
  ensureDir(jobDir(jobId));
  const ledgerShots = shots.map(({ id, durationSec }) => {
    const frames = snapDurationToFrames(durationSec);
    return { id, storySec: durationSec, frames, genSec: frames / FPS };
  });
  const ledger: TimingLedger = {
    version: 1,
    fps: FPS,
    createdAt: new Date().toISOString(),
    shots: ledgerShots,
    totalStorySec: Number(ledgerShots.reduce((a, x) => a + x.storySec, 0).toFixed(3)),
    totalFrames: ledgerShots.reduce((a, x) => a + x.frames, 0),
    totalGenSec: Number(ledgerShots.reduce((a, x) => a + x.genSec, 0).toFixed(3)),
  };
  fs.writeFileSync(jobFile(jobId, "timing.json"), JSON.stringify(ledger, null, 2));
  return ledger;
}

export function readTimingLedger(jobId: string): TimingLedger | null {
  const file = path.join(jobDir(jobId), "timing.json");
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")) as TimingLedger;
}
