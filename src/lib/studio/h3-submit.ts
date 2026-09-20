import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { loadConfig } from "./config";
import { snapDurationToFrames, wavSeconds } from "./frame-grid";
import { SCRIPT_HEADER, validateProse, type ValidateProseOpts } from "./h3-prose";
import { buildH3Graph, BINDINGS, type H3GraphModels, type H3GraphVariant } from "./h3-r2v-graph";
import { validateProsePositive } from "./h3-prose";
import { scpToHost } from "./scp-upload";
import { queuePrompt, waitHistory, downloadView, uploadComfyFile } from "./comfy";

export type H3SubmitReceipt = {
  dry_run: boolean;
  shot: string | null;
  graph_variant: H3GraphVariant;
  server: string;
  prompt: string;
  seconds: number;
  frames: number;
  steps: number;
  seed: number;
  /** keyframe anchors as wired into H3Keyframes.positions (audit-visible) */
  keyframe_positions: string;
  prompt_id: string | null;
  uploads: {
    wav: string;
    blockout: string;
    kf_start: string;
    kf_end: string | null;
    ref_images: string[];
    /** A-only UI/infographic photo refs (card ③b) */
    ui_photos: string[];
    /** A-only montage timing ref wav (card ③a); null = none */
    audio_timing: string | null;
  };
  output?: { filename: string; subfolder?: string; bytes: number };
  graph: unknown;
};

function writeReceipt(file: string, record: H3SubmitReceipt): string {
  // a real-render receipt is never clobbered by a dry-run one: only a file
  // that says "dry_run": true (a previous dry receipt) may be overwritten
  let out = file;
  if (fs.existsSync(file) && !/"dry_run":\s*true/.test(fs.readFileSync(file, "utf8"))) {
    out = file.replace(/\.json$/, "_dryrun.json");
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
  /** B/BKF (documented fallback): still then portrait files on disk (live upload); dry-run uses names only */
  refImageFiles?: string[];
  /** A only (card ③b): UI/infographic shot photo refs — mapping prose goes with them */
  uiPhotoFiles?: string[];
  /** A only (card ③a): montage beat-cut timing wav (sample #31) */
  audioTimingFile?: string;
  outMp4: string;
  receiptJson: string;
  dryRun: boolean;
  shot?: string;
  requireQuote?: boolean;
  wardrobe?: ValidateProseOpts["wardrobe"];
  graphVariant?: H3GraphVariant;
  /** test-only steps override; default remains config.motion.steps (4) */
  stepsOverride?: number;
}): Promise<{ receipt: H3SubmitReceipt; receiptFile: string }> {
  const cfg = loadConfig();
  const variant = opts.graphVariant ?? "a";
  if ((opts.uiPhotoFiles?.length ?? 0) > 0 && variant !== "a") {
    throw new Error("ui photos are the A-path law-d channel; B/BKF/C stay frozen for receipt comparability");
  }
  if (opts.audioTimingFile && variant !== "a") {
    throw new Error("audio timing ref is the A-path montage channel; B/BKF/C stay frozen for receipt comparability");
  }
  const promptText = `${SCRIPT_HEADER}\n${opts.prose}`;
  if (variant === "a") {
    validateProse(promptText, { requireQuote: opts.requireQuote !== false, wardrobe: opts.wardrobe });
  } else {
    validateProsePositive(promptText, {
      requireQuote: opts.requireQuote !== false,
      wardrobe: opts.wardrobe,
      motionOnly: variant === "c",
    });
  }

  const seconds = await wavSeconds(opts.wavFile);
  const frames = snapDurationToFrames(seconds);
  const steps = opts.stepsOverride ?? cfg.motion.steps;
  const seed = cfg.motion.seed;
  const tag = opts.dryRun ? "dryrun" : crypto.randomUUID().replaceAll("-", "").slice(0, 8);

  const wavName = `slatecrew_${tag}_dialogue.wav`;
  const blockoutName = `slatecrew_${tag}_blockout.mp4`;
  const kfStartName = `slatecrew_${tag}_kf_start.png`;
  const kfEndName = variant === "a" && opts.kfEnd ? `slatecrew_${tag}_kf_end.png` : null;
  const refImageNames =
    variant === "b" || variant === "bkf"
      ? (opts.refImageFiles ?? []).map((_, i) => `slatecrew_${tag}_ref_img_${i}.png`)
      : [];
  const uiPhotoNames = variant === "a" ? (opts.uiPhotoFiles ?? []).map((_, i) => `slatecrew_${tag}_ui_${i}.png`) : [];
  const audioTimingName = variant === "a" && opts.audioTimingFile ? `slatecrew_${tag}_timing.wav` : null;
  const models = modelsFromConfig();
  const shotTag = `${path.basename(opts.outMp4, ".mp4")}_${tag}`;
  const bindings = variant === "a" ? BINDINGS : "";
  const keyframePositions =
    kfEndName ? "0%, 100%" : "0%";

  const build = (names: {
    kfStart: string;
    kfEnd: string | null;
    blockout: string;
    wav: string;
    refImages: string[];
    uiPhotos: string[];
    audioTiming: string | null;
  }) =>
    buildH3Graph({
      script: promptText,
      bindings,
      frames,
      steps,
      seed,
      filenamePrefix: `video/SLATECREW/${shotTag}`,
      kfStartName: names.kfStart,
      kfEndName: names.kfEnd ?? undefined,
      blockoutName: names.blockout,
      wavName: names.wav,
      models,
      variant,
      refImageNames: names.refImages,
      uiPhotoNames: names.uiPhotos,
      audioTimingRefName: names.audioTiming ?? undefined,
    });

  if (opts.dryRun) {
    const graph = build({
      kfStart: kfStartName,
      kfEnd: kfEndName,
      blockout: blockoutName,
      wav: wavName,
      refImages: refImageNames,
      uiPhotos: uiPhotoNames,
      audioTiming: audioTimingName,
    });
    const receipt: H3SubmitReceipt = {
      dry_run: true,
      shot: opts.shot ?? null,
      graph_variant: variant,
      server: cfg.motion.comfyUrl,
      prompt: promptText,
      seconds: Math.round(seconds * 1000) / 1000,
      frames,
      steps,
      seed,
      keyframe_positions: keyframePositions,
      prompt_id: null,
      uploads: {
        wav: wavName,
        blockout: blockoutName,
        kf_start: kfStartName,
        kf_end: kfEndName,
        ref_images: refImageNames,
        ui_photos: uiPhotoNames,
        audio_timing: audioTimingName,
      },
      graph,
    };
    return { receipt, receiptFile: writeReceipt(opts.receiptJson, receipt) };
  }

  const needBlockout = variant === "a";
  for (const f of [
    opts.wavFile,
    ...(needBlockout ? [opts.blockoutMp4] : []),
    opts.kfStart,
    ...(variant === "a" && opts.kfEnd ? [opts.kfEnd] : []),
    ...(variant === "b" || variant === "bkf" ? (opts.refImageFiles ?? []) : []),
    ...(variant === "a" ? (opts.uiPhotoFiles ?? []) : []),
    ...(variant === "a" && opts.audioTimingFile ? [opts.audioTimingFile] : []),
  ]) {
    if (!fs.existsSync(f)) throw new Error(`missing H3 input: ${f}`);
  }
  const host = new URL(cfg.motion.comfyUrl).hostname;
  await scpToHost(host, cfg.ssh.user, opts.wavFile, cfg.ssh.motionInputDir, wavName);
  const uploadedBlockout = needBlockout
    ? await uploadComfyFile(cfg.motion.comfyUrl, opts.blockoutMp4, blockoutName, "video/mp4")
    : blockoutName;
  const uploadedKfStart = await uploadComfyFile(cfg.motion.comfyUrl, opts.kfStart, kfStartName, "image/png");
  const uploadedKfEnd = variant === "a" && opts.kfEnd && kfEndName
    ? await uploadComfyFile(cfg.motion.comfyUrl, opts.kfEnd, kfEndName, "image/png")
    : null;
  const uploadedRefImages: string[] = [];
  if (variant === "b" || variant === "bkf") {
    for (const [i, file] of (opts.refImageFiles ?? []).entries()) {
      const name = `slatecrew_${tag}_ref_img_${i}.png`;
      uploadedRefImages.push(await uploadComfyFile(cfg.motion.comfyUrl, file, name, "image/png"));
    }
  }
  const uploadedUiPhotos: string[] = [];
  for (const [i, file] of (opts.uiPhotoFiles ?? []).entries()) {
    const name = `slatecrew_${tag}_ui_${i}.png`;
    uploadedUiPhotos.push(await uploadComfyFile(cfg.motion.comfyUrl, file, name, "image/png"));
  }
  // LoadAudio reads the Comfy input dir, so the timing wav rides the scp lane
  const uploadedTiming = opts.audioTimingFile && audioTimingName
    ? (await scpToHost(host, cfg.ssh.user, opts.audioTimingFile, cfg.ssh.motionInputDir, audioTimingName), audioTimingName)
    : null;

  const graph = build({
    kfStart: uploadedKfStart,
    kfEnd: uploadedKfEnd,
    blockout: uploadedBlockout,
    wav: wavName,
    refImages: uploadedRefImages,
    uiPhotos: uploadedUiPhotos,
    audioTiming: uploadedTiming,
  });
  const promptId = await queuePrompt(cfg.motion.comfyUrl, graph);
  const outputs = await waitHistory(cfg.motion.comfyUrl, promptId, { saveNode: "save" });
  const item = outputs.videos[0] ?? outputs.gifs[0] ?? outputs.images[0];
  if (!item) throw new Error(`render finished but SaveVideo has no output (prompt_id=${promptId})`);
  await downloadView(cfg.motion.comfyUrl, item, opts.outMp4);
  const receipt: H3SubmitReceipt = {
    dry_run: false,
    shot: opts.shot ?? null,
    graph_variant: variant,
    server: cfg.motion.comfyUrl,
    prompt: promptText,
    seconds: Math.round(seconds * 1000) / 1000,
    frames,
    steps,
    seed,
    keyframe_positions: keyframePositions,
    prompt_id: promptId,
    uploads: {
      wav: wavName,
      blockout: uploadedBlockout,
      kf_start: uploadedKfStart,
      kf_end: uploadedKfEnd,
      ref_images: uploadedRefImages,
      ui_photos: uploadedUiPhotos,
      audio_timing: uploadedTiming,
    },
    output: { filename: item.filename, subfolder: item.subfolder, bytes: fs.statSync(opts.outMp4).size },
    graph,
  };
  return { receipt, receiptFile: writeReceipt(opts.receiptJson, receipt) };
}
