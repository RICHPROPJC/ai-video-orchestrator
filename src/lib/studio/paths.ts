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

/** projects/ is seats/' repo-root sibling: one dir per drama, holding its
 *  entities.json (story nouns) and its playbook/ (drama-lifetime bullets). */
export function projectsDir() {
  return path.join(process.cwd(), "projects");
}

/** Public asset shelf. Sibling of seats/ and projects/. Story nouns do not live here. */
export function libraryDir() {
  return path.join(process.cwd(), "library");
}

/** From a seats dir (tests override it), the projects root is its sibling. */
export function projectsRootFromSeatsDir(seats: string) {
  return path.join(path.dirname(path.resolve(seats)), "projects");
}

/** A4 events law: every slate (ep) owns projects/<ep>/events.jsonl — the one
 *  events file Chau, Grok and Vera read instead of a PTY. emit() appends the
 *  same line here and to the per-job log; never a second log format. */
export function epEventsFile(slate: string) {
  const dir = path.join(projectsDir(), slate);
  ensureDir(dir);
  return path.join(dir, "events.jsonl");
}

/** Scope axis — which seats a playbook file addresses. `all` replaced the
 *  retired `global` name (call 6 L1); no legacy alias is kept. */
export const PLAYBOOK_SCOPES = ["writer", "boards", "all"] as const;
export type PlaybookScope = (typeof PLAYBOOK_SCOPES)[number];

/** Lifetime axis — primitive bullets outlive every drama and sit in seats/;
 *  drama bullets belong to one drama's nouns and sit in its projects dir. */
export type PlaybookLifetime = "primitive" | "drama";

/** A playbook file = lifetime × scope. `dir` pins the tree root for tests:
 *  the seats dir for primitive, the projects root for drama. */
export type PlaybookAddress =
  | { lifetime: "primitive"; scope: PlaybookScope; dir?: string }
  | { lifetime: "drama"; scope: PlaybookScope; drama: string; dir?: string };

export function playbookPath(addr: PlaybookAddress): string {
  if (addr.lifetime === "primitive") {
    return path.join(addr.dir ?? seatsDir(), `${addr.scope}.primitive.md`);
  }
  return path.join(addr.dir ?? projectsDir(), addr.drama, "playbook", `${addr.scope}.md`);
}

/** Dramas that already own a playbook/ dir, sorted — the deterministic order
 *  every drama-routing decision walks. */
export function dramasWithPlaybooks(projectsRoot: string): string[] {
  if (!fs.existsSync(projectsRoot)) return [];
  return fs
    .readdirSync(projectsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((n) => fs.existsSync(path.join(projectsRoot, n, "playbook")))
    .sort();
}
