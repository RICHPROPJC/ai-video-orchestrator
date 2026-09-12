import fs from "node:fs";
import path from "node:path";

export function dataRoot() {
  return path.join(process.cwd(), "data", "jobs");
}

export function jobDir(id: string) {
  return path.join(dataRoot(), id);
}

export function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

export function jobFile(id: string, ...parts: string[]) {
  const dir = jobDir(id);
  ensureDir(path.join(dir, ...parts.slice(0, -1)));
  return path.join(dir, ...parts);
}

/** Seats live at the repo root: charters in source, playbooks on disk where
 *  Chau can read or veto any line in git. Same cwd contract as configPath. */
export function seatsDir() {
  return path.join(process.cwd(), "seats");
}

export const PLAYBOOK_SEATS = ["writer", "boards", "global"] as const;
export type PlaybookSeat = (typeof PLAYBOOK_SEATS)[number];

export function seatPlaybookPath(seat: PlaybookSeat, dir: string = seatsDir()) {
  return path.join(dir, `${seat}.playbook.md`);
}
