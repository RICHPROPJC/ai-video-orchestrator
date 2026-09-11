import path from "node:path";
import { jobDir } from "./paths";

/** Every artifact lives under data/jobs/<slate>/. Sibling slates are invisible. */
export function jobRoot(slate: string) {
  if (!slate || /[\\/]|\.\./.test(slate)) {
    throw new Error("isolate: bad slate id");
  }
  return path.resolve(jobDir(slate));
}

export function resolveInJob(slate: string, rel: string) {
  const root = jobRoot(slate);
  const abs = path.resolve(root, rel);
  const extra = path.relative(root, abs);
  if (extra.startsWith("..") || path.isAbsolute(extra)) {
    throw new Error(`isolate: ${rel} outside slate ${slate}`);
  }
  return abs;
}

export function assertInJob(slate: string, absPath: string) {
  const root = jobRoot(slate);
  const extra = path.relative(root, path.resolve(absPath));
  if (extra.startsWith("..") || path.isAbsolute(extra)) {
    throw new Error(`isolate: path not in slate ${slate}`);
  }
  return path.resolve(absPath);
}

export function relInJob(slate: string, absPath: string) {
  const abs = assertInJob(slate, absPath);
  return path.relative(jobRoot(slate), abs).split(path.sep).join("/");
}
