import fs from "node:fs";
import path from "node:path";
import { dramaEntityTokens } from "./playbook";
import { libraryDir, projectsDir } from "./paths";

export type ShelfRole = "characters" | "props" | "scenes";

export type ShelfPiece = {
  id: string;
  role: ShelfRole;
  home: "public" | "drama";
  drama?: string;
  dir: string;
  plate?: string;
  rig?: string;
};

function pieceDir(root: string, role: ShelfRole, id: string) {
  return path.join(root, role, id);
}

function readPiece(dir: string): { plate?: string; rig?: string } {
  if (!fs.existsSync(dir)) return {};
  const rig = path.join(dir, "mesh_front_rigged.glb");
  const names = fs.readdirSync(dir);
  const plate = names.find((n) => n.endsWith(".png") && !n.endsWith(".cut.png"));
  return {
    ...(fs.existsSync(rig) ? { rig } : {}),
    ...(plate ? { plate: path.join(dir, plate) } : {}),
  };
}

/** Noun test, same order as the playbook. A name that hits a drama stays in that drama's shelf. */
export function shelfHome(id: string, projectsRoot = projectsDir()): { home: "public" | "drama"; drama?: string; root: string } {
  for (const { drama, tokens } of dramaEntityTokens(projectsRoot)) {
    if (tokens.some((token) => id.includes(token))) {
      return { home: "drama", drama, root: path.join(projectsRoot, drama, "library") };
    }
  }
  return { home: "public", root: libraryDir() };
}

/** A public name that still contains a drama noun cannot be the shared name. */
export function publicNameOk(name: string, projectsRoot = projectsDir()): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  return shelfHome(trimmed, projectsRoot).home === "public";
}

/** Checkout. A story id that names a drama stays on that drama shelf.
 *  Pass publicName to reuse a renamed public piece. Does not copy a job in. */
export function lookupShelf(
  id: string,
  role: ShelfRole,
  projectsRoot = projectsDir(),
  publicName?: string,
  libRoot = libraryDir(),
): ShelfPiece | undefined {
  const renamed = publicName?.trim();
  if (renamed) {
    if (!publicNameOk(renamed, projectsRoot)) return undefined;
    const dir = pieceDir(libRoot, role, renamed);
    const files = readPiece(dir);
    if (!files.plate && !files.rig) return undefined;
    return { id: renamed, role, home: "public", dir, ...files };
  }
  const home = shelfHome(id, projectsRoot);
  const dir = pieceDir(home.root, role, id);
  const files = readPiece(dir);
  if (!files.plate && !files.rig) return undefined;
  return { id, role, home: home.home, drama: home.drama, dir, ...files };
}
