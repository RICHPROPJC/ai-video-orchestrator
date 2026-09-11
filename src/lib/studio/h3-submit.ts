import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { loadConfig } from "./config";
import { snapDurationToFrames, wavSeconds } from "./frame-grid";
import { SCRIPT_HEADER, validateProse } from "./h3-prose";
import { buildH3Graph, BINDINGS, type H3GraphModels } from "./h3-r2v-graph";
import { scpToHost } from "./scp-upload";
import { queuePrompt, waitHistory, downloadView, uploadComfyFile } from "./comfy";

export type H3SubmitReceipt = {
  dry_run: boolean;
  shot: string | null;
  server: string;
  prompt: string;
  seconds: number;
  frames: number;
  steps: number;
  seed: number;
  prompt_id: string | null;
  uploads: { wav: string; blockout: string; kf_start: string; kf_end: string | null };
  output?: { filename: string; subfolder?: string; bytes: number };
  graph: unknown;
};

function writeReceipt(file: string, record: H3SubmitReceipt): string {
  // a real-render receipt is never clobbered by a dry-run one
  let out = file;
  if (fs.existsSync(file)) {
    try {
      const prev = JSON.parse(fs.readFileSync(file, "utf8")) as { dry_run?: boolean };
      if (prev.dry_run === false) out = file.replace(/\.json$/, "_dryrun.json");
    } catch {
      out = file.replace(/\.json$/, "_dryrun.json"); // unreadable receipt: do not overwrite it either
    }
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(record, null, 2));
  return out;
}

function modelsFromConfig(): H3GraphModels {
  const m = loadConfig().motion;
  return {
    textEncoder: m.textEncoder,
    encoderType: "minimax",
    videoVae: m.videoVae,
    audioVae: m.audioVae,
    ref2va: m.checkpoint,
    fl2va: m.fl2va,
    turboLora: m.turboLora,
  };
}

/** one shot end-to-end to MiniMax H3 on node1: prose gate → wav sets frames →
 *  (live) scp wav + upload blockout/keyframes → POST /prompt → poll /history →
 *  GET /view. Dry run writes the receipt with the full graph and touches no
 *  socket. Every failure throws; nothing retries or degrades. */
export async function submitH3Shot(opts: {
  prose: string;
  wavFile: string;
  blockoutMp4: string;
  kfStart: string;
  kfEnd?: string;
  outMp4: string;
  receiptJson: string;
  dryRun: boolean;
  shot?: string;
  requireQuote?: boolean;
}): Promise<{ receipt: H3SubmitReceipt; receiptFile: string }> {
  const cfg = loadConfig();
  const promptText = `${SCRIPT_HEADER}\n${opts.prose}`;
  validateProse(promptText, { requireQuote: opts.requireQuote !== false });

  const seconds = await wavSeconds(opts.wavFile);
  const frames = snapDurationToFrames(seconds);
  const steps = cfg.motion.steps;
  const seed = cfg.motion.seed;
  const tag = opts.dryRun ? "dryrun" : crypto.randomUUID().replaceAll("-", "").slice(0, 8);

  const wavName = `slatecrew_${tag}_dialogue.wav`;
  const blockoutName = `slatecrew_${tag}_blockout.mp4`;
  const kfStartName = `slatecrew_${tag}_kf_start.png`;
  const kfEndName = opts.kfEnd ? `slatecrew_${tag}_kf_end.png` : null;
  const models = modelsFromConfig();
  const shotTag = `${path.basename(opts.outMp4, ".mp4")}_${tag}`;

  const build = (names: { kfStart: string; kfEnd: string | null; blockout: string; wav: string }) =>
    buildH3Graph({
      script: promptText,
      bindings: BINDINGS,
      frames,
      steps,
      seed,
      filenamePrefix: `video/SLATECREW/${shotTag}`,
      kfStartName: names.kfStart,
      kfEndName: names.kfEnd ?? undefined,
      blockoutName: names.blockout,
      wavName: names.wav,
      models,
    });

  if (opts.dryRun) {
    const graph = build({ kfStart: kfStartName, kfEnd: kfEndName, blockout: blockoutName, wav: wavName });
    const receipt: H3SubmitReceipt = {
      dry_run: true,
      shot: opts.shot ?? null,
      server: cfg.motion.comfyUrl,
      prompt: promptText,
      seconds: Math.round(seconds * 1000) / 1000,
      frames,
      steps,
      seed,
      prompt_id: null,
      uploads: { wav: wavName, blockout: blockoutName, kf_start: kfStartName, kf_end: kfEndName },
      graph,
    };
    return { receipt, receiptFile: writeReceipt(opts.receiptJson, receipt) };
  }

  for (const f of [opts.wavFile, opts.blockoutMp4, opts.kfStart, ...(opts.kfEnd ? [opts.kfEnd] : [])]) {
    if (!fs.existsSync(f)) throw new Error(`missing H3 input: ${f}`);
  }
  const host = new URL(cfg.motion.comfyUrl).hostname;
  await scpToHost(host, cfg.ssh.user, opts.wavFile, cfg.ssh.motionInputDir, wavName);
  const uploadedBlockout = await uploadComfyFile(cfg.motion.comfyUrl, opts.blockoutMp4, blockoutName, "video/mp4");
  const uploadedKfStart = await uploadComfyFile(cfg.motion.comfyUrl, opts.kfStart, kfStartName, "image/png");
  const uploadedKfEnd = opts.kfEnd && kfEndName
    ? await uploadComfyFile(cfg.motion.comfyUrl, opts.kfEnd, kfEndName, "image/png")
    : null;

  const graph = build({ kfStart: uploadedKfStart, kfEnd: uploadedKfEnd, blockout: uploadedBlockout, wav: wavName });
  const promptId = await queuePrompt(cfg.motion.comfyUrl, graph);
  const outputs = await waitHistory(cfg.motion.comfyUrl, promptId, { saveNode: "save" });
  const item = outputs.videos[0] ?? outputs.gifs[0] ?? outputs.images[0];
  if (!item) throw new Error(`render finished but SaveVideo has no output (prompt_id=${promptId})`);
  await downloadView(cfg.motion.comfyUrl, item, opts.outMp4);
  const receipt: H3SubmitReceipt = {
    dry_run: false,
    shot: opts.shot ?? null,
    server: cfg.motion.comfyUrl,
    prompt: promptText,
    seconds: Math.round(seconds * 1000) / 1000,
    frames,
    steps,
    seed,
    prompt_id: promptId,
    uploads: {
      wav: wavName,
      blockout: uploadedBlockout,
      kf_start: uploadedKfStart,
      kf_end: uploadedKfEnd,
    },
    output: { filename: item.filename, subfolder: item.subfolder, bytes: fs.statSync(opts.outMp4).size },
    graph,
  };
  return { receipt, receiptFile: writeReceipt(opts.receiptJson, receipt) };
}
