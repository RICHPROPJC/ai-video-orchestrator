import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Callsheet prop name is the asset id. Filename stems are not a fuzzy search. */
export function propAssetId(name: string): string {
  return name.trim().replace(/[\s/\\]+/g, "-");
}

/** `01-玻璃樽檸檬汽水.png` → `玻璃樽檸檬汽水`. Cut pngs are not plates. */
export function plateStem(file: string): string {
  const base = path.basename(file).replace(/\.png$/i, "");
  return base.replace(/^\d+-/, "");
}

export function cutQcPath(plateFile: string): string {
  return plateFile.replace(/\.png$/i, ".cut.photo_qc.json");
}

export type PlateQc = {
  status?: string;
  blind?: string;
  sha256?: string;
  image?: string;
};

export type PropAssetRecord = {
  assetId: string;
  file: string;
  sha256: string;
  qcFile: string;
  qcStatus: "GREEN";
  aliasFrom?: string;
  identityEvidence: string;
};

export type PropPinManifest = {
  files: string[];
  assets: PropAssetRecord[];
};

type Alias =
  | { ok: true; evidence: string }
  | { ok: false; reason: string };

/** Exact id reuses a GREEN plate. A different stem aliases only when the
 *  GREEN blind names this id and this id is the longest requested match. */
export function aliasDecision(opts: {
  stem: string;
  assetId: string;
  requestedIds: string[];
  qc: PlateQc | null;
}): Alias {
  if (opts.qc?.status !== "GREEN") return { ok: false, reason: "qc_not_green" };
  if (opts.stem === opts.assetId) return { ok: true, evidence: "exact_id_green" };
  const blind = opts.qc.blind ?? "";
  if (!blind.includes(opts.assetId)) return { ok: false, reason: "qc_identity_miss" };
  if (!opts.stem.includes(opts.assetId)) return { ok: false, reason: "stem_not_parent" };
  const hits = opts.requestedIds.filter((id) => opts.stem.includes(id) && blind.includes(id));
  const longest = hits.reduce((a, b) => (b.length > a.length ? b : a), "");
  if (longest !== opts.assetId) return { ok: false, reason: "ambiguous_or_shorter" };
  return { ok: true, evidence: `alias ${opts.stem} -> ${opts.assetId} via GREEN blind` };
}

export function sha256File(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function readQc(plateFile: string): PlateQc | null {
  const qcFile = cutQcPath(plateFile);
  if (!fs.existsSync(qcFile)) return null;
  const doc = JSON.parse(fs.readFileSync(qcFile, "utf8")) as PlateQc;
  const cut = plateFile.replace(/\.png$/i, ".cut.png");
  if (doc.image && path.basename(doc.image) !== path.basename(cut)) {
    return { ...doc, status: "IMAGE_MISMATCH" };
  }
  // An unverifiable receipt is not a GREEN one: no sha or no cut file to hash
  // means the identity evidence is gone, so the plate is not reusable as-is.
  if (!doc.sha256) return { ...doc, status: "QC_SHA_MISSING" };
  if (!fs.existsSync(cut)) return { ...doc, status: "CUT_MISSING" };
  if (sha256File(cut) !== doc.sha256) return { ...doc, status: "STALE_SHA" };
  return doc;
}

function plateFiles(assetsDir: string, manifestFiles: string[]): string[] {
  const onDisk = fs.existsSync(assetsDir)
    ? fs.readdirSync(assetsDir)
        .filter((name) => name.endsWith(".png") && !name.endsWith(".cut.png"))
        .map((name) => path.join(assetsDir, name))
    : [];
  return [...new Set([...manifestFiles, ...onDisk])].filter((file) => fs.existsSync(file) && !file.endsWith(".cut.png"));
}

export function readPropPinManifest(file: string): { files: string[] } {
  if (!fs.existsSync(file)) return { files: [] };
  const doc = JSON.parse(fs.readFileSync(file, "utf8")) as { files?: unknown };
  const files = Array.isArray(doc.files) ? doc.files.filter((f): f is string => typeof f === "string") : [];
  return { files };
}

export function diffPropPlates(assetsDir: string, manifestPath: string, propNames: string[]): {
  resolved: PropAssetRecord[];
  missingIds: string[];
  manifest: PropPinManifest;
} {
  const requestedIds = propNames.map(propAssetId);
  const candidates = plateFiles(assetsDir, readPropPinManifest(manifestPath).files);
  const resolved: PropAssetRecord[] = [];
  const missingIds: string[] = [];
  for (const name of propNames) {
    const assetId = propAssetId(name);
    const exact = candidates.filter((file) => plateStem(file) === assetId);
    const pool = exact.length > 0 ? exact : candidates.filter((file) => plateStem(file) !== assetId);
    let hit: PropAssetRecord | undefined;
    for (const file of pool) {
      const qc = readQc(file);
      const decision = aliasDecision({ stem: plateStem(file), assetId, requestedIds, qc });
      if (!decision.ok) continue;
      const stem = plateStem(file);
      hit = {
        assetId,
        file,
        sha256: sha256File(file),
        qcFile: cutQcPath(file),
        qcStatus: "GREEN",
        aliasFrom: stem === assetId ? undefined : stem,
        identityEvidence: decision.evidence,
      };
      break;
    }
    if (hit) resolved.push(hit);
    else missingIds.push(assetId);
  }
  const files = [...new Set(resolved.map((row) => row.file))];
  return { resolved, missingIds, manifest: { files, assets: resolved } };
}

export function writePropPinManifest(file: string, manifest: PropPinManifest): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.part`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
  fs.renameSync(tmp, file);
}

/** Next `props-NN.png` seq so a cap refill does not overwrite the bottle sheet. */
export function nextPropBoardSeq(assetsDir: string): number {
  const dir = path.join(assetsDir, "boards");
  if (!fs.existsSync(dir)) return 1;
  let max = 0;
  for (const name of fs.readdirSync(dir)) {
    const m = /^props-(\d+)\.png$/.exec(name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}
