import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { loadConfig } from "./config";
import { snapDurationToFrames, wavSeconds } from "./frame-grid";
import { SCRIPT_HEADER, validateProse, type ValidateProseOpts } from "./h3-prose";
import { buildH3Graph, h3SizeForAspect, BINDINGS, BINDINGS_CFORM, type H3GraphModels, type H3GraphVariant } from "./h3-r2v-graph";
import { validateProsePositive } from "./h3-prose";
import { scpToHost } from "./scp-upload";
import { queuePrompt, waitHistory, downloadView, uploadComfyFile } from "./comfy";

export type H3SubmitReceipt = {
  dry_run: boolean;
  shot: string | null;
  graph_variant: H3GraphVariant;
  /** §5b form of a variant-a submit: "c" = Video 1 present (zero keyframes,
   *  ref_image_0 = angle portrait); "a" = still-to-video keyframes lane;
   *  "ms" = standalone multishot (MULTISHOT_WIRE_0921). null on the b/bkf/c
   *  alternates (no production form). */
  motion_form: "a" | "c" | "ms" | null;
  server: string;
  prompt: string;
  seconds: number;
  frames: number;
  steps: number;
  seed: number;
  /** keyframe anchors as wired into H3Keyframes.positions (audit-visible);
   *  "" on the C-form — zero keyframe nodes in the graph. */
  keyframe_positions: string;
  /** MULTISHOT_WIRE: the cross-shot chain riding a C-form first shot
   *  (true-endframe start via H3LastFrame, seed_per_shot, flatten gain);
   *  null = single-shot render. */
  chain: {
    shot_count: number;
    shots: string[];
    frames_per_shot: number;
    seed_per_shot: boolean;
    chain_gain_control: string;
    start_image: string;
    reference_image: string;
    voice_ref: string | null;
  } | null;
  /** MULTISHOT_WIRE: standalone multishot call (簡單接駁, MS-A shape). */
  multishot: {
    shot_count: number;
    shots: string[];
    frames_per_shot: number;
    seed_per_shot: boolean;
    chain_gain_control: string;
    start_image: string | null;
    reference_image: string;
  } | null;
  prompt_id: string | null;
  uploads: {
    wav: string;
    /** null on the A-form (no Video 1) and on b/bkf/c alternates */
    blockout: string | null;
    /** null on the C-form — zero keyframe nodes, nothing to upload.
     *  Set when the shot wrote keyframePositions: those stills ride with Video 1. */
    kf_start: string | null;
    kf_end: string | null;
    /** Further keyframe uploads after start and end. Absent when the shot wrote no positions string. */
    kf_extra?: string[];
    ref_images: string[];
    /** A-only UI/infographic photo refs (card ③b) */
    ui_photos: string[];
    /** A-only montage timing ref wav (card ③a); null = none */
    audio_timing: string | null;
    /** MULTISHOT_WIRE chain uploads (portrait/voice for the chained shots) */
    ms_reference: string | null;
    ms_voice: string | null;
    ms_start: string | null;
  };
  output?: { filename: string; subfolder?: string; bytes: number; sha256?: string };
  /** Local files this receipt was built from. Absent on older receipts. */
  sources?: { role: string; path: string; sha256: string }[];
  graph: unknown;
};

function fileSha(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function sourceOf(role: string, file?: string | null): { role: string; path: string; sha256: string } | null {
  if (!file || !fs.existsSync(file)) return null;
  return { role, path: file, sha256: fileSha(file) };
}

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
 *  (live) scp wav + upload blockout/refs/keyframes → POST /prompt → poll
 *  /history → GET /view. Dry run writes the receipt with the full graph and
 *  touches no socket. Every failure throws; nothing retries or degrades.
 *
 *  §5b form (variant a only, routed by the Video 1 asset): blockoutMp4 given
 *  → C-form (zero keyframes, refImageFiles = angle portraits ride
 *  ref_images, BINDINGS_CFORM); blockoutMp4 absent → A-form still-to-video
 *  (kfStart anchors 0%, kfEnd optional 100%). */
function rejectChainedMultishot(chain: unknown): void {
  if (chain) throw new Error("multishot_identity_only: split C-form and identity-only multishot into separate renders");
}

export async function submitH3Shot(opts: {
  prose: string;
  wavFile: string;
  /** Locked shot seconds. When set, frames come from this, not from the wav length. */
  durationSec?: number;
  /** §5b routing field: present → C-form; absent → A-form (kfStart required). */
  blockoutMp4?: string;
  /** A-form only: the U1.5 still at H3Keyframes 0%. Together with a Video 1
   *  it throws (§5b coexist ban) — the still stays a QC artifact, never a
   *  graph input, on the C-form. */
  kfStart?: string;
  kfEnd?: string;
  /** Further keyframe files after start and end. Count is the shot's, not a fixed 4 or 8. */
  kfExtraFiles?: string[];
  /** Shot-written percentages. Video 1 coexistence is unresolved in ALIGN-LOCK. */
  keyframePositions?: string;
  /** C-form: angle portrait files (per refAngle) riding ref_images; B/BKF
   *  (documented fallback): still then portrait files on disk. Dry-run uses
   *  names only. */
  refImageFiles?: string[];
  /** A only (card ③b): UI/infographic shot photo refs — mapping prose goes with them */
  uiPhotoFiles?: string[];
  /** A only (card ③a): montage beat-cut timing wav (sample #31) */
  audioTimingFile?: string;
  /** MULTISHOT_WIRE: cross-shot chain riding this C-form first shot — the
   *  shots after it render via H3MultishotSampler inside the same graph. */
  chain?: {
    script: string;
    shots: string[];
    framesPerShot: number;
    /** exactly one identity portrait, carried into every chained shot */
    referenceImageFile: string;
    voiceRefFile?: string;
  };
  /** MULTISHOT_WIRE: standalone multishot call (簡單接駁) — the whole segment
   *  renders inside H3MultishotSampler; prose rides the --- script. */
  multishot?: {
    script: string;
    shots: string[];
    framesPerShot: number;
    referenceImageFile: string;
    startImageFile?: string;
    voiceRefFile?: string;
  };
  outMp4: string;
  receiptJson: string;
  dryRun: boolean;
  shot?: string;
  requireQuote?: boolean;
  wardrobe?: ValidateProseOpts["wardrobe"];
  graphVariant?: H3GraphVariant;
  /** ECOM1A: callsheet aspect — resolved to the graph canvas (h3SizeForAspect);
 *    undefined keeps the v6-parity 864×480. Unknown strings refuse to emit. */
  aspect?: string;
  /** test-only steps override; default remains config.motion.steps (8, turbo 8-step v1.0) */
  stepsOverride?: number;
}): Promise<{ receipt: H3SubmitReceipt; receiptFile: string }> {
  opts = {
    ...opts,
    ...(opts.chain ? { chain: { ...opts.chain, framesPerShot: snapDurationToFrames(opts.chain.framesPerShot / 24) } } : {}),
    ...(opts.multishot ? { multishot: { ...opts.multishot, framesPerShot: snapDurationToFrames(opts.multishot.framesPerShot / 24) } } : {}),
  };
  const cfg = loadConfig();
  const variant = opts.graphVariant ?? "a";
  const cform = variant === "a" && Boolean(opts.blockoutMp4);
  const isMultishot = Boolean(opts.multishot);
  if (variant !== "a" && opts.blockoutMp4) {
    throw new Error("only the A production path may carry a Video 1; B/BKF/C stay frozen for receipt comparability");
  }
  if (opts.chain && opts.multishot) {
    throw new Error("chain and multishot are exclusive: chain rides a C-form first shot, multishot is standalone");
  }
  if (opts.chain && !cform) {
    throw new Error("chain_requires_cform: the chained topology's shot 1 IS the C-form render (blockoutMp4 required)");
  }
  if (isMultishot && (opts.blockoutMp4 || opts.kfStart || opts.kfEnd || opts.kfExtraFiles?.length || opts.keyframePositions?.trim() || opts.multishot?.startImageFile || (opts.refImageFiles?.length ?? 0) > 0)) {
    throw new Error("multishot is standalone: no Video 1, no keyframes, no r2v ref_images — its inputs are the script/portrait/voice only");
  }
  rejectChainedMultishot(opts.chain);
  if (opts.multishot && !/\/boards\/[^/]+\.angles\.png$/i.test(opts.multishot.referenceImageFile.replace(/\\/g, "/"))) {
    throw new Error("multishot_identity_only: reference must be an uncut boards/<character>.angles.png identity sheet");
  }
  if (isMultishot && variant !== "a") {
    throw new Error("multishot runs on the production path only (variant a)");
  }
  // 有 positions 就可以同走位片一齊出。冇寫 positions 先唔好同時塞鍵格檔。
  const freePositions = opts.keyframePositions?.trim() ?? "";
  if (!freePositions && cform && (opts.kfStart || opts.kfEnd || opts.kfExtraFiles?.length)) {
    throw new Error(
      `keyframes_video1_coexist: 冇寫 positions 就同時有走位片 (${opts.blockoutMp4}) 同鍵格檔 ` +
        `(${opts.kfStart ?? ""}${opts.kfEnd ? " + kfEnd" : ""})`,
    );
  }
  if ((opts.uiPhotoFiles?.length ?? 0) > 0 && variant !== "a") {
    throw new Error("ui photos are the A-path law-d channel; B/BKF/C stay frozen for receipt comparability");
  }
  if (opts.audioTimingFile && variant !== "a") {
    throw new Error("audio timing ref is the A-path montage channel; B/BKF/C stay frozen for receipt comparability");
  }
  const promptText = `${SCRIPT_HEADER}\n${opts.prose}`;
  if (isMultishot) {
    // the multishot script is "---"-separated packet prose built upstream —
    // the single-shot prose gates do not apply to this shape
  } else if (variant === "a") {
    validateProse(promptText, { requireQuote: opts.requireQuote !== false, wardrobe: opts.wardrobe });
  } else {
    validateProsePositive(promptText, {
      requireQuote: opts.requireQuote !== false,
      wardrobe: opts.wardrobe,
      motionOnly: variant === "c",
    });
  }

  const seconds = opts.durationSec ?? (await wavSeconds(opts.wavFile));
  const frames = snapDurationToFrames(seconds);
  const steps = opts.stepsOverride ?? cfg.motion.steps;
  const seed = cfg.motion.seed;
  const tag = opts.dryRun ? "dryrun" : crypto.randomUUID().replaceAll("-", "").slice(0, 8);

  const wavName = `slatecrew_${tag}_dialogue.wav`;
  const blockoutName = cform ? `slatecrew_${tag}_blockout.mp4` : null;
  // keyframes lane names: A-form plus the BKF/C alternates (their H3Keyframes
  // node needs the upload name); b keeps the name for receipt parity — the
  // C-form is the only shape with zero keyframes and zero kf uploads.
  const rideKf = Boolean(freePositions) || !cform;
  const kfStartName = rideKf && opts.kfStart ? `slatecrew_${tag}_kf_start.png` : null;
  const kfEndName = variant === "a" && rideKf && opts.kfEnd ? `slatecrew_${tag}_kf_end.png` : null;
  const kfExtraNames = freePositions
    ? (opts.kfExtraFiles ?? []).map((_, i) => `slatecrew_${tag}_kf_extra_${i}.png`)
    : [];
  const refImageNames =
    cform || variant === "b" || variant === "bkf"
      ? (opts.refImageFiles ?? []).map((_, i) => `slatecrew_${tag}_ref_img_${i}.png`)
      : [];
  const uiPhotoNames = variant === "a" ? (opts.uiPhotoFiles ?? []).map((_, i) => `slatecrew_${tag}_ui_${i}.png`) : [];
  const audioTimingName = variant === "a" && opts.audioTimingFile ? `slatecrew_${tag}_timing.wav` : null;
  // MULTISHOT_WIRE upload names (chain + standalone share the naming)
  const msRefName = opts.chain || opts.multishot ? `slatecrew_${tag}_ms_ref.png` : null;
  const msVoiceName = (opts.chain?.voiceRefFile || opts.multishot?.voiceRefFile) ? `slatecrew_${tag}_ms_voice.wav` : null;
  const msStartName = opts.multishot?.startImageFile ? `slatecrew_${tag}_ms_start.png` : null;
  const models = modelsFromConfig();
  const shotTag = `${path.basename(opts.outMp4, ".mp4")}_${tag}`;
  const bindings = cform ? BINDINGS_CFORM : variant === "a" ? BINDINGS : "";
  const keyframePositions = freePositions
    ? freePositions
    : cform || opts.chain || isMultishot
      ? ""
      : kfEndName
        ? "0%, 100%"
        : "0%";

  const build = (names: {
    kfStart: string | null;
    kfEnd: string | null;
    blockout: string | null;
    wav: string;
    refImages: string[];
    uiPhotos: string[];
    audioTiming: string | null;
    msRef: string | null;
    msVoice: string | null;
    msStart: string | null;
    kfExtra: string[];
  }) =>
    buildH3Graph({
      script: promptText,
      bindings,
      frames,
      steps,
      seed,
      filenamePrefix: `video/SLATECREW/${shotTag}`,
      kfStartName: names.kfStart ?? undefined,
      kfEndName: names.kfEnd ?? undefined,
      blockoutName: names.blockout ?? undefined,
      wavName: names.wav,
      models,
      variant,
      ...h3SizeForAspect(opts.aspect),
      refImageNames: names.refImages,
      uiPhotoNames: names.uiPhotos,
      audioTimingRefName: names.audioTiming ?? undefined,
      kfExtraNames: names.kfExtra.length ? names.kfExtra : undefined,
      keyframePositions: freePositions || undefined,
      ...(opts.chain
        ? {
            chain: {
              script: opts.chain.script,
              shotCount: opts.chain.shots.length,
              framesPerShot: opts.chain.framesPerShot,
              referenceImageName: names.msRef!,
              ...(opts.chain.voiceRefFile ? { voiceRefName: names.msVoice! } : {}),
            },
          }
        : {}),
      ...(opts.multishot
        ? {
            multishot: {
              script: opts.multishot.script,
              shotCount: opts.multishot.shots.length,
              framesPerShot: opts.multishot.framesPerShot,
              referenceImageName: names.msRef!,
              ...(opts.multishot.startImageFile ? { startImageName: names.msStart! } : {}),
              ...(opts.multishot.voiceRefFile ? { voiceRefName: names.msVoice! } : {}),
            },
          }
        : {}),
    });

  const chainReceipt =
    opts.chain && cform
      ? {
          shot_count: opts.chain.shots.length,
          shots: opts.chain.shots,
          frames_per_shot: opts.chain.framesPerShot,
          seed_per_shot: true,
          chain_gain_control: "flatten",
          start_image: "h3_last_frame(this render)",
          reference_image: msRefName!,
          voice_ref: msVoiceName,
        }
      : null;
  const multishotReceipt =
    opts.multishot
      ? {
          shot_count: opts.multishot.shots.length,
          shots: opts.multishot.shots,
          frames_per_shot: opts.multishot.framesPerShot,
          seed_per_shot: true,
          chain_gain_control: "flatten",
          start_image: msStartName,
          reference_image: msRefName!,
        }
      : null;
  const motionForm: H3SubmitReceipt["motion_form"] = isMultishot
    ? "ms"
    : variant === "a"
      ? cform ? "c" : "a"
      : null;

  if (opts.dryRun) {
    const graph = build({
      kfStart: kfStartName,
      kfEnd: kfEndName,
      blockout: blockoutName,
      wav: wavName,
      refImages: refImageNames,
      uiPhotos: uiPhotoNames,
      audioTiming: audioTimingName,
      msRef: msRefName,
      msVoice: msVoiceName,
      msStart: msStartName,
      kfExtra: kfExtraNames,
    });
    const receipt: H3SubmitReceipt = {
      dry_run: true,
      shot: opts.shot ?? null,
      graph_variant: variant,
      motion_form: motionForm,
      server: cfg.motion.comfyUrl,
      prompt: promptText,
      seconds: Math.round(seconds * 1000) / 1000,
      frames,
      steps,
      seed,
      keyframe_positions: keyframePositions,
      chain: chainReceipt,
      multishot: multishotReceipt,
      prompt_id: null,
      uploads: {
        wav: wavName,
        blockout: blockoutName,
        kf_start: kfStartName,
        kf_end: kfEndName,
        ...(kfExtraNames.length ? { kf_extra: kfExtraNames } : {}),
        ref_images: refImageNames,
        ui_photos: uiPhotoNames,
        audio_timing: audioTimingName,
        ms_reference: msRefName,
        ms_voice: msVoiceName,
        ms_start: msStartName,
      },
      graph,
    };
    return { receipt, receiptFile: writeReceipt(opts.receiptJson, receipt) };
  }

  const needKf = !cform || Boolean(freePositions);
  for (const f of [
    opts.wavFile,
    ...(cform ? [opts.blockoutMp4!] : []),
    ...(needKf && opts.kfStart ? [opts.kfStart] : []),
    ...(needKf && variant === "a" && opts.kfEnd ? [opts.kfEnd] : []),
    ...(freePositions ? (opts.kfExtraFiles ?? []) : []),
    ...(cform || variant === "b" || variant === "bkf" ? (opts.refImageFiles ?? []) : []),
    ...(variant === "a" ? (opts.uiPhotoFiles ?? []) : []),
    ...(variant === "a" && opts.audioTimingFile ? [opts.audioTimingFile] : []),
    ...(opts.chain ? [opts.chain.referenceImageFile, ...(opts.chain.voiceRefFile ? [opts.chain.voiceRefFile] : [])] : []),
    ...(opts.multishot
      ? [
          opts.multishot.referenceImageFile,
          ...(opts.multishot.startImageFile ? [opts.multishot.startImageFile] : []),
          ...(opts.multishot.voiceRefFile ? [opts.multishot.voiceRefFile] : []),
        ]
      : []),
  ]) {
    if (!fs.existsSync(f)) throw new Error(`missing H3 input: ${f}`);
  }
  const host = new URL(cfg.motion.comfyUrl).hostname;
  await scpToHost(host, cfg.ssh.user, opts.wavFile, cfg.ssh.motionInputDir, wavName);
  const uploadedBlockout = cform
    ? await uploadComfyFile(cfg.motion.comfyUrl, opts.blockoutMp4!, blockoutName!, "video/mp4")
    : null;
  const uploadedKfStart = needKf && opts.kfStart
    ? await uploadComfyFile(cfg.motion.comfyUrl, opts.kfStart, kfStartName!, "image/png")
    : null;
  const uploadedKfEnd = needKf && variant === "a" && opts.kfEnd && kfEndName
    ? await uploadComfyFile(cfg.motion.comfyUrl, opts.kfEnd, kfEndName, "image/png")
    : null;
  const uploadedKfExtra: string[] = [];
  if (freePositions) {
    for (const [i, file] of (opts.kfExtraFiles ?? []).entries()) {
      const name = kfExtraNames[i]!;
      uploadedKfExtra.push(await uploadComfyFile(cfg.motion.comfyUrl, file, name, "image/png"));
    }
  }
  const uploadedRefImages: string[] = [];
  if (cform || variant === "b" || variant === "bkf") {
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
  // MULTISHOT_WIRE uploads: portrait/start ride /upload/image, the ms voice
  // wav rides the scp lane (LoadAudio reads the input dir)
  const uploadedMsRef = msRefName
    ? await uploadComfyFile(
        cfg.motion.comfyUrl,
        (opts.chain ?? opts.multishot)!.referenceImageFile,
        msRefName,
        "image/png",
      )
    : null;
  const uploadedMsStart = msStartName
    ? await uploadComfyFile(cfg.motion.comfyUrl, opts.multishot!.startImageFile!, msStartName, "image/png")
    : null;
  const uploadedMsVoice = msVoiceName
    ? (await scpToHost(
        host,
        cfg.ssh.user,
        (opts.chain?.voiceRefFile ?? opts.multishot?.voiceRefFile)!,
        cfg.ssh.motionInputDir,
        msVoiceName,
      ), msVoiceName)
    : null;

  const graph = build({
    kfStart: uploadedKfStart,
    kfEnd: uploadedKfEnd,
    blockout: uploadedBlockout,
    wav: wavName,
    refImages: uploadedRefImages,
    uiPhotos: uploadedUiPhotos,
    audioTiming: uploadedTiming,
    msRef: uploadedMsRef,
    msVoice: uploadedMsVoice,
    msStart: uploadedMsStart,
    kfExtra: uploadedKfExtra,
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
    motion_form: motionForm,
    server: cfg.motion.comfyUrl,
    prompt: promptText,
    seconds: Math.round(seconds * 1000) / 1000,
    frames,
    steps,
    seed,
    keyframe_positions: keyframePositions,
    chain: chainReceipt,
    multishot: multishotReceipt,
    prompt_id: promptId,
    uploads: {
      wav: wavName,
      blockout: uploadedBlockout,
      kf_start: uploadedKfStart,
      kf_end: uploadedKfEnd,
      ...(uploadedKfExtra.length ? { kf_extra: uploadedKfExtra } : {}),
      ref_images: uploadedRefImages,
      ui_photos: uploadedUiPhotos,
      audio_timing: uploadedTiming,
      ms_reference: uploadedMsRef,
      ms_voice: uploadedMsVoice,
      ms_start: uploadedMsStart,
    },
    output: { filename: item.filename, subfolder: item.subfolder, bytes: fs.statSync(opts.outMp4).size, sha256: fileSha(opts.outMp4) },
    sources: [
      sourceOf("wav", opts.wavFile),
      sourceOf("blockout", opts.blockoutMp4),
      sourceOf("kf_start", opts.kfStart),
      sourceOf("kf_end", opts.kfEnd),
      ...(opts.kfExtraFiles ?? []).map((file, i) => sourceOf(`kf_extra_${i}`, file)),
      ...(opts.refImageFiles ?? []).map((file, i) => sourceOf(`ref_image_${i}`, file)),
      sourceOf("audio_timing", opts.audioTimingFile),
    ].filter((row): row is { role: string; path: string; sha256: string } => Boolean(row)),
    graph,
  };
  return { receipt, receiptFile: writeReceipt(opts.receiptJson, receipt) };
}
