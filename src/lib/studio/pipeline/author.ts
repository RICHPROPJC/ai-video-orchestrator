import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { emit, readJob } from "../store";
import { loadCallSheet } from "../writer";
import { runWriter } from "../seat-writer";
import { runDirector, writeCreativeArtifacts, runPlaywright, briefSha, readCreativeManifest, updateCreativeManifest, unplacedDialogueOf, declaredDialogueOf, dialogueSignalsOf, planDivergence } from "../creative";
import type { DirectorSkeleton } from "../seat-boards";
import { runBoards } from "../seat-boards";
import { jobDir, jobFile, seatsDir } from "../paths";
import { rangesFor } from "../script-contract";
import { indexPlanTexts, upsertDoc, vaultStats } from "../vault";
import { assertSameCanon, continuityMarkdown, lockContinuity } from "../continuity";
import { applyCombatPass } from "../combat-adapter";
import { buildNarrativePlan, planMarkdown } from "../narrative";
import { open, packetLine, seal } from "../dispatch";
import { gapEvent, gapMessage, storyboardZeroGap } from "../capability-gap";
import type { AgentId, CallSheet, ProduceInput } from "../types";
import type { SlateConfig } from "../config";
import { GAP_BUDGET, patch, type Ctx } from "./shared";

/** Speaking parts must be castable, so the roster is read from a data file the
 *  operator points at — never from a list living in src. */
function readCastRoster(file?: string): string[] {
  if (!file) return [];
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { cast?: { name?: string }[] };
  const names = (raw.cast ?? []).map((c) => c.name).filter((n): n is string => Boolean(n));
  if (!names.length) throw new Error(`--cast-roster ${file} lists no names`);
  return names;
}

type SeatVoice = {
  speak: (agent: AgentId, message: string, level?: "info" | "warn" | "pass" | "fail") => Promise<void>;
  think: (agent: AgentId) => Promise<void>;
};

/** Where the callsheet comes from: a resumed slate, the plug (factory tests
 *  only), or — by default now — 阿文 and 阿圖 actually writing it. */
async function authorCallSheet(
  jobId: string,
  input: ProduceInput,
  cfg: SlateConfig,
  io: SeatVoice,
): Promise<CallSheet> {
  const existing = path.join(jobDir(jobId), "callsheet.json");
  // §7②（0928）：回修路徑——placementGaps 有積留＝唔照食 callsheet，帶差距
  //  返導演席 revise（creative 冪等同時跳過，runDirector 以 revise 輪行）。
  //  修訂後新 callsheet 落盤，world 段重算 gaps 清返——emit 之外嘅真回修。
  const placementGaps: { utterance: string; text: string; ts: string; attempts?: number }[] = readJob(jobId)?.placementGaps ?? [];
  // §13.2：額度真源＝job 持久 soundRepairEpisode（author 攔截遞增；行內 loop／
  // resume 共用；row attempts 淺 mirror）。唔用文字身份——改台詞唔重置。
  const diskJob = readJob(jobId);
  const epAttempts = diskJob?.soundRepairEpisode?.attempts ?? 0;
  if (placementGaps.length && epAttempts < GAP_BUDGET) {
    const nextAttempts = epAttempts + 1;
    const episode = diskJob?.soundRepairEpisode
      ? { ...diskJob.soundRepairEpisode, attempts: nextAttempts }
      : { id: `sr-${Date.now().toString(36)}`, openedAt: new Date().toISOString(), source: placementGaps[0]!.text, attempts: nextAttempts };
    if (diskJob) patch(diskJob, { placementGaps: placementGaps.map((g) => ({ ...g, attempts: nextAttempts })), soundRepairEpisode: episode });
  } else if (placementGaps.length && epAttempts >= GAP_BUDGET) {
    await io.speak("producer", `修訂額度耗盡（episode 已消耗 ${epAttempts}/${GAP_BUDGET} 輪，${placementGaps.length} 條 gap 未解）——唔再攔截 callsheet，gaps 留底收尾 blocked 判斷。`, "warn");
  }
  // §9④：唔再要求 input.resume——行內回修（pipeline world 後返嚟）一樣要攔
  if (fs.existsSync(existing) && placementGaps.length) {
    await io.speak(
      "producer",
      `回修：${placementGaps.length} 句聲畫對位缺口積留（${placementGaps.map((g) => g.text.slice(0, 24)).join("、").slice(0, 200)}）——唔照食 callsheet，帶差距返導演席修訂落點。`,
      "warn",
    );
    emit(jobId, { agent: "producer", level: "warn",
      message: `placement-gap revise：${placementGaps.length} 句回導演席`,
      data: { stage: "revise", gaps: placementGaps.map((g) => g.text.slice(0, 60)) } });
  } else if (input.resume && fs.existsSync(existing)) {
    // SCOPE §6：creative revision 同 callsheet 同步失效——manifest 話 briefSha
    // 唔夾，callsheet 係由過期 creative 鏈生出嚟嘅，唔准照食（重行創作鏈）。
    // 舊 job 冇 creative/manifest（null）＝無 revision 資訊，照舊相容。
    const man = readCreativeManifest(path.join(jobDir(jobId), "creative"));
    if (man && man.briefSha !== briefSha(input.brief)) {
      await io.speak(
        "producer",
        `resume 拒絕：briefSha 唔夾（creative 鏈 ${man.briefSha} vs 今次 ${briefSha(input.brief)}）——callsheet 同 creative/ 一齊過期，重行創作鏈。`,
        "warn",
      );
    } else {
      // V2c（PLAN-v2 0928）§8：manifest entry sha 逐件對返磁碟——手改過
      // director-plan.json／script.md／creative-intent.json（sha 唔夾）＝callsheet
      // 係由唔同內容生出嚟嘅，唔准照食。唔係重燒：跌落重行創作鏈由現有
      // 內容重建（對齊狀態）。
      const creativeRoot = path.join(jobDir(jobId), "creative");
      const drifted = (man?.entries ?? []).filter((e) => {
        const f = path.join(creativeRoot, e.file);
        try {
          const now = createHash("sha256").update(fs.readFileSync(f)).digest("hex");
          return now !== e.sha256;
        } catch {
          return true; // entry 話有但檔唔見＝drift
        }
      });
      if (drifted.length) {
        await io.speak(
          "producer",
          `resume 拒絕：creative 手上有檔同 manifest sha 唔夾（${drifted.map((d) => d.file).join("、")}）——內容被改過，callsheet 唔准照食，重行創作鏈對齊。`,
          "warn",
        );
      } else {
        const sheet = loadCallSheet(existing);
        await io.speak("producer", `resume：照返 callsheet.json（${sheet.shots.length} 鏡），唔重開檯。`);
        return sheet;
      }
    }
  }
  if (input.callSheetPath) {
    const sheet = loadCallSheet(input.callSheetPath);
    await io.speak("producer", `callsheet plug 載入：${sheet.shots.length} 鏡。`);
    return sheet;
  }
  const targetSec = input.durationSec ?? 600;
  const receiptDir = path.join(jobDir(jobId), "seats");
  // SC-CREATIVE-OS-0927 §3 創作主路徑第一段：短 brief → 導演席（treatment＋
  // 節奏骨架）。新 slate 先行；已有 creative/ 就照舊（resume 冪等）。fail-loud：
  // 導演席塌咗唔靜靜降級返裸 brief 路（嗰條係碎切/補秒病溫床）。
  const creativeDir = path.join(jobDir(jobId), "creative");
  let treatment: string | undefined;
  let directorSkeleton: DirectorSkeleton | undefined;
  // 裁決 0928 A：編劇對白＋導演聲畫落點抽出分支（runWriter beats packet 食）
  let scriptDialogueLines: string[] | undefined;
  let directorPlacements: { word: string; startSec?: number; endSec?: number; onImage?: string }[] | undefined;
  const skeletonOf = (plan: {
    vision?: unknown; rhythmMap?: { beatId: string; label?: string; job?: string; rhythm?: string; deletionLoss?: string }[];
    shots?: { shotId: string; startSec?: number; endSec?: number; purpose?: string; audienceEye?: string; cutReason?: string; dialogue?: string; frame?: string }[];
    dialogueClock?: { placements?: { word: string; startSec?: number; endSec?: number; onImage?: string }[] };
  }): DirectorSkeleton => ({
    ...(typeof plan.vision === "string" ? { vision: plan.vision } : {}),
    ...(plan.rhythmMap ? { beats: plan.rhythmMap.map((b) => ({ beatId: b.beatId, ...(b.label ? { label: b.label } : {}), ...(b.job ? { job: b.job } : {}), ...(b.rhythm ? { rhythm: b.rhythm } : {}), ...(b.deletionLoss ? { deletionLoss: b.deletionLoss } : {}) })) } : {}),
    ...(plan.shots ? { shots: plan.shots.map((sh) => ({ shotId: sh.shotId, ...(sh.startSec !== undefined ? { startSec: sh.startSec } : {}), ...(sh.endSec !== undefined ? { endSec: sh.endSec } : {}), ...(sh.purpose ? { purpose: sh.purpose } : {}), ...(sh.audienceEye ? { audienceEye: sh.audienceEye } : {}), ...(sh.cutReason ? { cutReason: sh.cutReason } : {}), ...(sh.dialogue ? { dialogue: sh.dialogue } : {}), ...(sh.frame ? { frame: sh.frame } : {}) })) } : {}),
    ...(plan.dialogueClock?.placements ? { dialoguePlacements: plan.dialogueClock.placements } : {}),
  });
  const planOnDiskFile = path.join(creativeDir, "director-plan.json");
  const manHere = readCreativeManifest(creativeDir);
  // §7②：placementGaps 積留＝creative 唔算 fresh（強制行 revise 輪帶差距
  //  返導演席）；修訂後新 plan 落盤，下游 callsheet/world 重算。
  const creativeFresh = fs.existsSync(planOnDiskFile) && (!manHere || manHere.briefSha === briefSha(input.brief)) && !placementGaps.length;
  if (!creativeFresh) {
    // §7②：gaps 情況＝revise 輪（帶磁碟上嘅 plan＋script＋差距 hint 返導演席）
    const reviseForGaps = placementGaps.length && fs.existsSync(planOnDiskFile)
      ? {
          previousPlan: JSON.parse(fs.readFileSync(planOnDiskFile, "utf8")) as unknown,
          scriptMd: fs.existsSync(path.join(creativeDir, "script.md"))
            ? fs.readFileSync(path.join(creativeDir, "script.md"), "utf8")
            : "",
          // §13.3.4：類型化回差——缺句同採用矛盾分開講，原文唔截（決策必要
          // 內容）；附 boards 現行採用明細（安排＋理由）俾導演對住改。
          hint: (() => {
            const missing = placementGaps.filter((g) => !g.utterance.startsWith("adoption:"));
            const adoptions = placementGaps.filter((g) => g.utterance.startsWith("adoption:"));
            // 現行 callsheet 嘅採用明細（existing＝callsheet.json 路徑，同函作用域）
            const sheetNow = fs.existsSync(existing)
              ? JSON.parse(fs.readFileSync(existing, "utf8")) as { onImageAdoptions?: { placement: string; shotIds: string[]; plan: string; reason: string }[] }
              : {};
            const notes = (sheetNow.onImageAdoptions ?? []).map((a) => `${a.placement}→${a.shotIds.join("/")}：${a.plan}（理由：${a.reason}）`);
            return [
              missing.length ? `聲畫對位缺口（world audioTimeline 對照）：${missing.map((g) => g.text).join("；")}——補返呢啲句子嘅 dialogueClock 落點` : "",
              adoptions.length ? `boards 席聲畫採用矛盾（placement/onImage 落地打交）：${adoptions.map((g) => g.text).join("；")}——重新協調 placement 同鏡面安排，唔可以靠加一句 placement 字串消掉語義矛盾` : "",
              adoptions.length && notes.length ? `boards 現行採用明細：${notes.join("；")}` : "",
            ].filter(Boolean).join("\n") || undefined;
          })(),
        }
      : undefined;
    let plan = await runDirector(
      { brief: input.brief, targetSec, ...(input.aspect ? { aspect: input.aspect } : {}), ...(input.language ? { language: input.language } : {}) },
      {
        crew: cfg.crew,
        model: cfg.crew.directorModel ?? (() => { throw new Error("director_model_missing: 導演席要明示 directorModel——創作整合唔借 writer 嘅平腦（SC-CREATIVE-OS-0927 分開明示）"); })(),
        receiptDir,
        fallbackModel: cfg.crew.secondFallback,
      },
      reviseForGaps,
    );
    const written = writeCreativeArtifacts(jobId, creativeDir, input.brief, plan, { targetSec, ...(input.aspect ? { aspect: input.aspect } : {}), ...(input.language ? { language: input.language } : {}) });
    const planSha = written.planSha;
    await io.speak(
      "producer",
      `導演席：${plan.shots.length} 鏡節奏骨架落 creative/（assumptions ${plan.assumptions?.length ?? 0}、capability_gaps ${plan.capabilityGaps.length} 條明報）。writer 跟 treatment 寫，唔再由裸 brief 發明。`,
    );
    treatment = plan.treatment;
    directorSkeleton = skeletonOf(plan);
    // 裁決 0928 A：編劇劇本要傳得出分支（runWriter packet 食佢嘅對白）

    // BRIEF_TO_SCRIPT：故事流（flow 提劇本/故事/敘事）→ 編劇席正式 callsite
    // （非故事流——MV/教學/素材剪輯——唔行呢段，flow 淨係導演宣告，執行器
    // 未有對應流程，詳見 IMPLEMENTATION_MAP 誠實位）。
    const flowText = typeof plan.flow === "string" ? plan.flow : JSON.stringify(plan.flow ?? "");
    if (/劇本|故事|敘事|narrative|script/i.test(flowText)) {
      const script = await runPlaywright(
        { brief: input.brief, treatment: plan.treatment, assets: [
            ...(plan.spec?.product ? [`產品：${plan.spec.product}`] : []),
            "人物／場景事實以 brief 逐字為準；資產身份以後續 cast/portraits 收據為準",
          ], targetSec,
          // 裁決 0928 B：講者綁定——roster 隨 packet 入編劇席（speaker 欄對應）
          castRoster: readCastRoster(input.castRosterPath) },
        { crew: cfg.crew, model: cfg.crew.directorModel ?? "", receiptDir, fallbackModel: cfg.crew.secondFallback },
      );
      scriptDialogueLines = dialogueSignalsOf(script).map((d) => d.line);
      fs.writeFileSync(path.join(creativeDir, "script.md"), script.script_md);
      fs.writeFileSync(path.join(creativeDir, "script.json"), JSON.stringify(script, null, 2));
      // §6：script dependsOn plan（上游 sha），同 plan 同鏈
      updateCreativeManifest(creativeDir, input.brief, { file: "script.md", dependsOn: planSha });
      updateCreativeManifest(creativeDir, input.brief, { file: "script.json", dependsOn: planSha });
      await io.speak("producer", `編劇席：${script.segments.length} 段可演劇本落 creative/（指定台詞保留 ${script.dialogue_verbatim_kept.length} 句；新增 ${script.newElements.length} 項全部標明）。`);
      // 編劇→導演修訂迴路：編劇版引號台詞有導演 dialogueClock 冇落點嘅（或
      // 明報新增元素）＝鏡表過期——回導演出一輪修訂版（一輪收口，唔遞迴）。
      // 修訂版三件套重寫＝manifest revision 遞增（SCOPE §6）。
      {
        // 對白事件對齊（唔用字數閾值）：來源渠道＝dialogueAdded／verbatimKept／
        // md 引號（全長）；歸一化子串雙向比對＋事件計數（同字多次講要逐個落點）
        const unplaced = unplacedDialogueOf(script, plan);
        // 聲明欄提示（明報新/指定台詞→要有落點；唔入消耗池——v2 雙計事故修正）
        const declared = declaredDialogueOf(script).filter(
          (d) => !unplacedDialogueOf({ script_md: script.script_md }, { dialogueClock: plan.dialogueClock })
            .some((u) => u.line.replace(/[。]/g, "") === d.replace(/[。]/g, "")),
        );
        // 非對白渠道（C 統籌 0927：敲檯類動作／接觸／時間改動都令鏡表失效）：
        // 時間覆蓋空洞＋動作動詞差集（VISIBLE_ACTION_VERBS 語義詞表）＋產品接觸缺席
        const div = planDivergence(script, plan);
        if (unplaced.length > 0 || script.newElements.length > 0 || declared.length > 0
          || div.timeGaps.length > 0 || div.actionNews.length > 0 || div.contactNews.length > 0) {
          await io.speak(
            "producer",
            `修訂迴路：編劇版有 ${unplaced.length} 句台詞冇導演落點${div.actionNews.length ? `＋新動作 ${div.actionNews.length} 項` : ""}${div.contactNews.length ? `＋新接觸 ${div.contactNews.length} 項` : ""}${div.timeGaps.length ? `＋時間冇對應鏡 ${div.timeGaps.length} 段` : ""}${script.newElements.length ? `＋新增元素 ${script.newElements.length} 項` : ""}——回導演修訂鏡表一輪。`,
          );
          const revised = await runDirector(
            { brief: input.brief, targetSec, ...(input.aspect ? { aspect: input.aspect } : {}), ...(input.language ? { language: input.language } : {}) },
            {
              crew: cfg.crew,
              model: cfg.crew.directorModel ?? (() => { throw new Error("director_model_missing: 導演席要明示 directorModel"); })(),
              receiptDir,
              fallbackModel: cfg.crew.secondFallback,
            },
            {
              scriptMd: script.script_md,
              previousPlan: plan,
              // V2b（PLAN-v2 0928）§7.2：revise.hint——實際缺口清單帶返同一
              // 責任席（之前簽名有 hint 但 caller 冇傳，修訂輪盲修）
              hint: [
                ...(unplaced.length ? [`冇落點台詞 ${unplaced.length} 句：${unplaced.map((u) => u.line).join("／").slice(0, 400)}`] : []),
                ...(declared.length ? [`聲明欄台詞要有落點：${declared.join("／").slice(0, 200)}`] : []),
                ...(div.timeGaps.length ? [`時間冇對應鏡 ${div.timeGaps.length} 段：${div.timeGaps.join("；").slice(0, 400)}`] : []),
                ...(div.actionNews.length ? [`新動作差集 ${div.actionNews.length} 項：${div.actionNews.join("；").slice(0, 300)}`] : []),
                ...(div.contactNews.length ? [`新產品接觸 ${div.contactNews.length} 項：${div.contactNews.join("；").slice(0, 300)}`] : []),
                ...(script.newElements.length ? [`編劇明報新增元素 ${script.newElements.length} 項要有鏡`] : []),
              ].join("；"),
            },
          );
          const rewritten = writeCreativeArtifacts(jobId, creativeDir, input.brief, revised, { targetSec, ...(input.aspect ? { aspect: input.aspect } : {}), ...(input.language ? { language: input.language } : {}) });
          updateCreativeManifest(creativeDir, input.brief, { file: "script.md", dependsOn: rewritten.planSha });
          updateCreativeManifest(creativeDir, input.brief, { file: "script.json", dependsOn: rewritten.planSha });
          plan = revised;
          directorSkeleton = skeletonOf(revised);
          // 裁決 0928 C（SEAT-AUDIT-DECISION §3）：revise 後驗真收口——第二次
          // unplaced 對照（之前 revise 完冇人驗）。重有 unplaced＝差距列明回
          // 責任席線（導演 revise 咗一輪都收唔到）——fail loud 保存已試修法，
          // 唔遞迴唔硬收。
          const unplacedAfter = unplacedDialogueOf(script, revised);
          if (unplacedAfter.length) {
            emit(jobId, {
              agent: "producer", level: "warn",
              message: `revise 後仍有 ${unplacedAfter.length} 句冇落點：${unplacedAfter.map((u) => u.line).join("／").slice(0, 300)}`,
              data: { stage: "revise-verify", unplaced: unplacedAfter.map((u) => u.line) },
            });
            throw new Error(`revise_unclosed: ${unplacedAfter.length} 句對白 revise 一輪後仍冇導演落點（${unplacedAfter.map((u) => u.line).join("；").slice(0, 300)}）——差距已列明，回導演席帶同片 history 修訂`);
          }
        }
      }
      directorPlacements = (plan.dialogueClock?.placements ?? []).map((pl) => ({
        word: pl.word, startSec: pl.startSec, endSec: pl.endSec, ...(pl.onImage ? { onImage: pl.onImage } : {}),
      }));
      treatment = `${script.script_md}

【導演 treatment 原稿】
${plan.treatment}`;
    }
  } else {
    const planOnDisk = JSON.parse(fs.readFileSync(path.join(creativeDir, "director-plan.json"), "utf8")) as Parameters<typeof skeletonOf>[0] & { treatment?: string; dialogueClock?: { placements?: { word: string; startSec?: number; endSec?: number; onImage?: string }[] } };
    treatment = planOnDisk.treatment;
    directorSkeleton = skeletonOf(planOnDisk);
    directorPlacements = (planOnDisk.dialogueClock?.placements ?? []).map((pl) => ({
      word: pl.word, startSec: pl.startSec, endSec: pl.endSec, ...(pl.onImage ? { onImage: pl.onImage } : {}),
    }));
  }
  const index = (doc: { id: string; text: string; shotId?: string }) => {
    upsertDoc({ id: doc.id, slate: jobId, modality: "text", shotId: doc.shotId, text: doc.text });
  };

  await io.think("writer");
  await io.speak("writer", `寫故事同對白。${cfg.crew.writerModel} · 目標 ${targetSec}s。`);
  const writer = await runWriter(
    {
      brief: input.brief,
      ...(treatment ? { treatment } : {}),
      // 裁決 0928 A：beats 席齊料——編劇對白＋導演聲畫落點隨 packet 落
      // 場（runWriter 內部按本場窗口揀相關 placements）。
      ...(scriptDialogueLines?.length
        ? { scriptDialogue: scriptDialogueLines.map((line) => ({ line })) }
        : {}),
      ...(directorPlacements?.length ? { directorPlacements } : {}),
      targetSec,
      language: input.language,
      castRoster: readCastRoster(input.castRosterPath),
    },
    {
      crew: cfg.crew,
      model: cfg.crew.writerModel,
      receiptDir,
      speak: (thinking) => io.speak("writer", thinking),
      warn: (message) => io.speak("writer", message, "warn"),
      index,
      playbookDir: seatsDir(),
      drama: input.drama,
    },
    rangesFor(targetSec),
  );

  await io.think("boards");
  await io.speak("boards", `拆鏡。${cfg.crew.boardsModel} · ${writer.script.outline.scenes.length} 場。`);
  const boards = await runBoards(
    {
      script: writer.script,
      draftOnly: input.dryRun,
      targetSec,
      aspect: input.aspect,
      writer: { model: writer.model, receipts: writer.receipts },
      ...(directorSkeleton ? { directorSkeleton } : {}),
    },
    {
      crew: cfg.crew,
      model: cfg.crew.boardsModel,
      receiptDir,
      boardsDir: path.join(jobDir(jobId), "boards"),
      speak: (thinking) => io.speak("boards", thinking),
      warn: (message) => io.speak("boards", message, "warn"),
      index,
      playbookDir: seatsDir(),
      drama: input.drama,
    },
  );
  // 裁決 0928 D：導演聲畫落點隨 callsheet 落 world 段（audioTimeline 對照）
  return { ...boards.sheet, ...(directorPlacements?.length ? { directorPlacements } : {}) };
}

/** 拆層段（author）：由 runPipeline 原序搬入，行為零變——絕唔重排 call 次序、
 *  絕唔刪／合併任何 emit/speak/patch；early-return 以 ctx.stopped 回報。 */

export async function authorStage(ctx: Ctx): Promise<void> {
  const { jobId, input, cfg } = ctx;
  const { speak, think } = ctx;
  const trace = ctx.trace;
  await think("producer");
  // L1b: the producer is the only writer of the lifetime ids — a job that
  // names its drama runs in that drama's base layer, its episode's surface
  // playbooks, and its base cast wardrobe facts
  if (input.drama || input.episode) {
    ctx.job = patch(ctx.job, {
      ...(input.drama ? { drama: input.drama } : {}),
      ...(input.episode ? { episode: input.episode } : {}),
    });
  }
  await speak(
    "producer",
    `收 brief。開呢份 slate 嘅信封。舊 project 唔入袋。${input.drama ? `劇目 ${input.drama}${input.episode ? `・${input.episode}` : ""}。` : ""}`,
  );
  const sheet = await authorCallSheet(jobId, input, cfg, { speak, think });
  fs.writeFileSync(jobFile(jobId, "callsheet.json"), JSON.stringify(sheet, null, 2));
  ctx.job = patch(ctx.job, {
    callSheet: sheet,
    providers: trace,
    progress: 8,
    outputs: { ...ctx.job.outputs, callSheet: "callsheet.json" },
  });
  await speak(
    "producer",
    `${sheet.title} · ${sheet.durationSec.toFixed(1)}s · ${sheet.shots.length} shots · ${sheet.location}`,
  );

  const toBoards = seal({
    slate: jobId,
    from: "writer",
    to: "boards",
    payload: { brief: input.brief, sheet },
  });
  await speak("producer", packetLine(toBoards));

  const boarded = open(toBoards, { slate: jobId, to: "boards" });
  const continuity = assertSameCanon(lockContinuity(boarded.sheet));
  ctx.continuity = continuity;
  const locked: CallSheet = { ...boarded.sheet, shots: continuity.boards };
  ctx.locked = locked;

  // COMBAT_PORT_0921: boards-stage combat pass — combat-signal gated (≥2
  // marked characters + a combat cause in the action). No signal → no-op,
  // non-combat path byte-identical; with a signal it attaches causal combat
  // state (Beat七欄/state relay) to the fight shots in place, emits
  // ACTION_RISK events and writes the combat/combat-pass.json receipt.
  applyCombatPass(jobId, locked, (event) => emit(jobId, event));
  const plan = buildNarrativePlan({
    slate: jobId,
    brief: boarded.brief,
    sheet: locked,
    continuity,
  });
  fs.writeFileSync(jobFile(jobId, "callsheet.json"), JSON.stringify(locked, null, 2));
  fs.writeFileSync(jobFile(jobId, "continuity.json"), JSON.stringify(continuity, null, 2));
  fs.writeFileSync(jobFile(jobId, "narrative-plan.json"), JSON.stringify(plan, null, 2));
  fs.writeFileSync(jobFile(jobId, "delivery", "continuity.md"), continuityMarkdown(continuity));
  fs.writeFileSync(jobFile(jobId, "delivery", "narrative-plan.md"), planMarkdown(plan));
  indexPlanTexts(jobId, plan.nodes);
  ctx.job = patch(ctx.job, {
    continuity,
    callSheet: locked,
    narrativePlan: plan,
    vault: vaultStats(jobId),
    progress: 14,
    outputs: {
      ...ctx.job.outputs,
      continuity: "delivery/continuity.md",
      narrativePlan: "narrative-plan.json",
      vault: "vault.json",
    },
  });
  const boardCount = locked.storyboard?.length ?? 0;
  // CAPGAP_0927（110 條 #31）：零可見分鏡板從前 warn 唔 block——靜靜雞照行
  // 係繞過位。而家硬反轉：blocked 等指示；逃生門＝人手 opt-in
  // --allow-no-storyboard（ProduceInput.allowNoStoryboard，預設 false）。
  if (boardCount === 0 && !input.allowNoStoryboard) {
    const gap = storyboardZeroGap();
    ctx.job = patch(ctx.job, {
      status: "blocked",
      currentAgent: "boards",
      providers: trace,
      error: gapMessage(gap),
    });
    emit(jobId, gapEvent(jobId, gap));
    ctx.stopped = true;
    return;
  }
  await speak(
    "boards",
    boardCount > 0
      ? `分鏡專職鎖咗 ${continuity.cut.length} 鏡。可見板 ${boardCount} 格。故事＝分鏡＝剪接。Vault 只得 ${jobId}。下一席接走位。`
      : `文字表 ${continuity.cut.length} 鏡。可見分鏡板 0，未逐格 GREEN。未算分鏡完成（--allow-no-storyboard 人手確認照行）。`,
    boardCount > 0 ? "info" : "warn",
  );
}
