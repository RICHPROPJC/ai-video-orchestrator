import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { emit, readJob } from "../store";
import { loadCallSheet } from "../writer";
import { utteranceBeatCoverage } from "../boards-expand";
import { CallsheetRuntimeGap, sheetDigest } from "../seat-boards";
import { runWriter } from "../seat-writer";
import { runDirector, writeCreativeArtifacts, runPlaywright, briefSha, readCreativeManifest, updateCreativeManifest, dialogueSignalsOf, evaluateScriptAgainstPlan, contractGapsOf, generateUtteranceCandidates, resolveUtterancePlacements, type UtterancePlacementMap } from "../creative";

/** G1 批二（0928）：編劇 script.md 候選表 → typed utterance 落位清單
 *  （id＝候選 frozen key U01…＝candidateIdx+1，綁 mdSha——同一 script.md
 *  bytes 永遠同編號）。beats 席 packet 帶呢份；beat.utteranceIds 引用；
 *  deriveAudioEvents 行 per-utterance 事件路。 */
const utteranceListOf = (scriptMd: string): { mdSha: string; list: { utteranceId: string; rawText: string }[] } => {
  const cand = generateUtteranceCandidates(scriptMd);
  return {
    mdSha: cand.mdSha,
    list: cand.candidates.map((c, i) => ({
      utteranceId: `U${String(i + 1).padStart(2, "0")}`,
      rawText: c.rawText,
    })),
  };
};
/** G1 批三：utterancesDigest＝sha256(stableJson(list))——§32 律：digest 用
 *  hash 唔用 JSON 前綴 slice。 */
const utterancesDigestOf = (list: { utteranceId: string; rawText: string }[]): string =>
  createHash("sha256").update(stableJson(list)).digest("hex").slice(0, 16);
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
import { GAP_BUDGET, SHEET_REPAIR_BUDGET, patch, type Ctx, stableJson } from "./shared";
import { reviseTurnTextsOf, completeAdoptedTurns, currentCallsheetDigestState } from "./session";

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
  /** G1 批三：utterance 版本收據回報（authorStage 寫 ctx——world 落盤用） */
  onUtteranceProvenance?: (p: { scriptMdSha: string; planSha: string; utterancesDigest: string; list: { utteranceId: string; rawText: string }[] }) => void,
): Promise<CallSheet> {
  const existing = path.join(jobDir(jobId), "callsheet.json");
  // §7②（0928）：回修路徑——placementGaps 有積留＝唔照食 callsheet，帶差距
  //  返導演席 revise（creative 冪等同時跳過，runDirector 以 revise 輪行）。
  //  修訂後新 callsheet 落盤，world 段重算 gaps 清返——emit 之外嘅真回修。
  const placementGaps: { utterance: string; text: string; ts: string; attempts?: number }[] = readJob(jobId)?.placementGaps ?? [];
  // §13.2：額度真源＝job 持久 soundRepairEpisode（author 攔截遞增；行內 loop／
  // resume 共用；row attempts 淺 mirror）。唔用文字身份——改台詞唔重置。
  const diskJob = readJob(jobId);
  // root R2 修②③＋R3 修③（0928）：frozen batch＋同源 digest——採納快照喺
  // 任何模型 call 之前落一次；digest 兩側共用 currentCallsheetDigest（當下
  // 磁碟 callsheet 全文 sheetDigest——route dependsOn 綁值同一真源，KF 後續
  // 回填兩側一齊計，唔再有 job 欄 vs 重算唔同源）。模型後 complete 用同一
  // 快照——快照後入隊嘅後到 turn 唔會混入本輪 adopt 集合。
  const digestState = currentCallsheetDigestState(jobId);
  const frozenQueue = reviseTurnTextsOf(jobId, digestState);
  const pendingAdopt = frozenQueue.adopt;
  // root R3 修②（0928）：唔行修訂輪嘅路徑一律明確收口（唔靜默失聯）——
  // adopt 全標 blocked（具名原因）＋stale 照回寫；收口後凍結集合清空，
  // 下游（creativeFresh／reviseForGaps／resume fall-through／plan 落盤收口）
  // 見空自然唔再觸發。
  const settleQueue = (reasonForAdopt: (t: { turnId: string; text: string }) => string): void => {
    if (!frozenQueue.adopt.length && !frozenQueue.stale.length) return;
    completeAdoptedTurns(jobId, [], [
      ...frozenQueue.adopt.map((t) => ({ turnId: t.turnId, reason: reasonForAdopt(t) })),
      ...frozenQueue.stale,
    ]);
    frozenQueue.adopt.length = 0;
    frozenQueue.stale.length = 0;
  };
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
  // §9④＋§14.1b：唔再要求 input.resume；額度准入喺實際 revise consumer——
  // 耗盡唔攔截唔進修訂（inline loop guard 保護唔到先行嘅 authorStage/resume），
  // gaps/blocked 留底收尾 verdict。
  const canRevise = placementGaps.length > 0 && epAttempts < GAP_BUDGET;
  // ROOT 0b7a60a 收口裁定：durationGaps（時長差集結構化 gap）同款回修——
  // 額度＝callsheetRepairEpisode（SHEET_REPAIR_BUDGET，同 boards 迴圈一池，
  // 耗盡唔重置）；hint 帶分類＋各場差額＋quota 入導演修訂輪。
  const durationGaps = readJob(jobId)?.durationGaps ?? [];
  const durEp = readJob(jobId)?.callsheetRepairEpisode?.attempts ?? 0;
  const canReviseDuration = durationGaps.length > 0 && durEp < SHEET_REPAIR_BUDGET;
  // root R3 修②：stale-only（adopt 空）唔叫導演——立即回寫 blocked；budget
  // exhausted（gaps＋額度耗盡）＝採納輪唔會行，pending 明確 blocked 具名
  // （唔繞 budget、唔靜默失聯）。
  if (placementGaps.length > 0 && epAttempts >= GAP_BUDGET) {
    settleQueue((t) => `sound_repair_budget_exhausted：修訂額度 ${GAP_BUDGET} 輪耗盡——本輪唔行採納（turn ${t.turnId} 留底，額度重置／人手處理後重交）`);
  } else if (!pendingAdopt.length && frozenQueue.stale.length) {
    completeAdoptedTurns(jobId, [], frozenQueue.stale);
    frozenQueue.stale.length = 0;
  }
  // §15.1b：額度攔實際模型入口——耗盡＋gaps 存在，唔可以令 creativeFresh
  // 路重開創作繞過額度：有既有 callsheet（有效舊採用）照食＋gaps 留底收尾
  // blocked；冇（缺舊產物）＝具名 throw，唔盲生成。合法新外部採用要明示
  // 來源改變（新 episode 由 world 重算開，唔喺呢度）。
  if (placementGaps.length > 0 && epAttempts >= GAP_BUDGET) {
    if (fs.existsSync(existing)) {
      // §16.1：沿用既有來源版本 guard——manifest 話 briefSha 唔夾＝呢份
      // callsheet 係過期採用版本：有效舊版本先可以 blocked preview 續用；
      // 採用來源變咗要具名處理（新 episode 由 world 重算開）——唔以舊鏡表
      // 續行，亦唔可以 drift 分支重行創作變相重開無額度同一問題。
      const manEx = readCreativeManifest(path.join(jobDir(jobId), "creative"));
      if (!manEx) {
        // §17.1：冇 manifest＝採用版本未知——唔可以 speak「已驗有效」，具名拒。
        throw new Error(`sound_repair_budget_exhausted_no_manifest: 修訂額度耗盡＋冇 creative manifest（採用版本未知）——唔可以當已驗有效照食；要人手確認 creative/ 狀態或明示採用版本`);
      }
      if (manEx.briefSha !== briefSha(input.brief)) {
        throw new Error(`sound_repair_budget_exhausted_and_stale: 修訂額度耗盡（episode ${GAP_BUDGET} 輪）＋callsheet 採用來源已變（manifest briefSha ${manEx.briefSha.slice(0, 12)} vs 今次 ${briefSha(input.brief).slice(0, 12)}）——過期鏡表唔可以 blocked preview 續用、亦唔可以悄悄重開；要明示採用版本更新或人手處理`);
      }
      // §17.1：復用 resume 分支同款 entries sha 逐檔對磁碟——brief 不變而
      // script/plan 漂移都唔可以 speak「已驗有效」（manEx null 已上面具名拒）。
      const creativeRootEx = path.join(jobDir(jobId), "creative");
      const driftedEx = (manEx.entries ?? []).filter((e) => {
        const f = path.join(creativeRootEx, e.file);
        try {
          const now = createHash("sha256").update(fs.readFileSync(f)).digest("hex");
          return now !== e.sha256;
        } catch {
          return true;
        }
      });
      if (driftedEx.length) {
        throw new Error(`sound_repair_budget_exhausted_and_drifted: 修訂額度耗盡＋creative 檔同 manifest sha 唔夾（${driftedEx.map((d) => d.file).join("、")}）——採用內容被改過，callsheet 唔可以當已驗有效照食；要人手對齊或明示採用版本更新`);
      }
      const sheet = loadCallSheet(existing);
      await io.speak("producer", `修訂額度耗盡＋${placementGaps.length} 條 gap——照食既有 callsheet（${sheet.shots.length} 鏡，採用版本已驗有效），gaps 留底收尾 blocked 判斷，唔重開創作。`, "warn");
      return sheet;
    }
    throw new Error(`sound_repair_budget_exhausted: 修訂額度耗盡（episode ${GAP_BUDGET} 輪）＋${placementGaps.length} 條聲畫 gap 未解，且冇既有 callsheet 可採用——缺有效採用具名 blocked，唔盲生成`);
  }
  if (fs.existsSync(existing) && canRevise) {
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
      } else if (pendingAdopt.length) {
        // root R2 修①（0928）：resume 照食場景嘅 pending consumer——有待採納
        // 修訂 turn 唔照食，fall through 落修訂輪（creativeFresh 因 pending 轉
        // false→reviseForGaps 帶 turn 內容返導演席；採納喺 plan 落盤收口）。
        await io.speak("producer", `resume：${pendingAdopt.length} 條對話修訂待採納——唔照食 callsheet，返導演席修訂輪。`, "warn");
      } else {
        const sheet = loadCallSheet(existing);
        await io.speak("producer", `resume：照返 callsheet.json（${sheet.shots.length} 鏡），唔重開檯。`);
        return sheet;
      }
    }
  }
  if (input.callSheetPath) {
    const sheet = loadCallSheet(input.callSheetPath);
    // root R3 修②：plug 顯式外來 callsheet——對話修訂鏈唔接管呢輪，pending
    // 明確 blocked 具名（唔靜默失聯）。
    settleQueue((t) => `callsheet-plug-override：外來 callsheet 顯式載入——對話修訂鏈唔接管呢輪（turn ${t.turnId}），重交或改用內部修訂路`);
    await io.speak("producer", `callsheet plug 載入：${sheet.shots.length} 鏡。`);
    return sheet;
  }
  // 統籌裁決 0930「閘跟提案」：brief 冇秒數（--duration 缺）→時長閘跟導演
  // 提案（duration_proposal_due 寫入 creative-intent spec.targetSec），唔用
  // 600（internal 無限時 sentinel）做規格。
  const readProposedTargetSec = (jid: string): number | undefined => {
    // 讀位三層：creative-intent spec/頂層（charter duration_proposal_due 指定
    // 寫入位）→director-plan spec.targetSec/頂層（Y8KH 實證：導演會將提案寫
    // 喺 plan 度而唔入 intent spec——r4 輪 spec{} 空＋plan targetSec 12 在場，
    // 淨讀 intent 令閘跌返 600）。兩處都冇＝undefined（閘鏈 600 sentinel）。
    for (const f of ["creative-intent.json", "director-plan.json"]) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(jobDir(jid), "creative", f), "utf8")) as { spec?: { targetSec?: number }; targetSec?: number };
        const t = d.spec?.targetSec ?? d.targetSec;
        if (typeof t === "number" && t > 0) return t;
      } catch { /* 檔未生＝跳過下一位 */ }
    }
    return undefined;
  };
  const targetSec = input.durationSec ?? readProposedTargetSec(jobId) ?? 600;
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
  // G1 批二：typed utterance 落位清單（候選 frozen key）——creative 段或
  // resume 磁碟重建；MV/非故事流冇＝undefined（beats 走 legacy 字串路）
  let typedUtteranceList: { utteranceId: string; rawText: string }[] | undefined;
  // G1 批三：版本收據三元（list 本身入 ctx.utteranceProvenance 由 world 收）
  let typedUtteranceProvenance: { scriptMdSha: string; planSha: string; utterancesDigest: string } | undefined;
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
  const creativeFresh = fs.existsSync(planOnDiskFile) && (!manHere || manHere.briefSha === briefSha(input.brief)) && !placementGaps.length && !pendingAdopt.length;
  if (!creativeFresh) {
    // §7②：gaps 情況＝revise 輪（帶磁碟上嘅 plan＋script＋差距 hint 返導演席）
    // root R2 修①：pending 係獨立修訂觸發（唔使 gaps 在場）；hint 帶 frozen
    // 快照 turn 原文（模型前快照，唔讀 live queue）。
    const reviseForGaps = (canRevise || canReviseDuration || pendingAdopt.length > 0) && fs.existsSync(planOnDiskFile)
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
              ...(pendingAdopt.length ? pendingAdopt.map((t) => `【用戶對話修訂請求 ${t.turnId}】${t.text}`) : []),
              ...(durationGaps.length ? durationGaps.map((g) =>
                `【callsheet 時長差集（機器閘結構化回報）】kind=${g.kind}；brief 硬時長 targetSec=${g.targetSec}s／outline 分配合計=${g.declared.toFixed(1)}s／實際鏡合計=${g.actual.toFixed(1)}s${g.scenes.length ? `；爆場明細：${g.scenes.map((s) => `${s.sceneId} ${s.actual.toFixed(1)}/${s.budget.toFixed(1)}s（+${s.delta.toFixed(1)}）`).join("、")}` : "；冇單場爆 band＝全片分配/可演性問題"}；quota 已用 ${g.quota.used}/${g.quota.max}——分鏡展開超額就合鏡／壓縮返 band；全片分配就重分各場 targetSec（總長對返 brief 硬時長）；budget 唔夠實現採納內容就 capability_gaps 具名，唔偷删台詞／接觸事件／用戶硬要求`) : []),
              missing.length ? `聲畫對位缺口（world audioTimeline 對照）：${missing.map((g) => g.text).join("；")}——只補返呢啲句子嘅 dialogueClock 落點：鏡表骨架（鏡數/次序/每鏡時長/動作）保持當前採納版原封，唔重寫骨架、唔因劇本句子增減重排鏡表（R20 裁決⑤：placement 修復係補落點輪，唔係重創作輪；劇本新句冇位就報 gap 唔硬塞）` : "",
              adoptions.length ? `boards 席聲畫採用矛盾（placement/onImage 落地打交）：${adoptions.map((g) => g.text).join("；")}——重新協調 placement 同鏡面安排，唔可以靠加一句 placement 字串消掉語義矛盾` : "",
              adoptions.length && notes.length ? `boards 現行採用明細：${notes.join("；")}` : "",
            ].filter(Boolean).join("\n") || undefined;
          })(),
        }
      : undefined;
    let plan = await runDirector(
      { brief: pendingAdopt.length && !reviseForGaps
          // root R2 修①：首創路（冇 previousPlan 可帶）——turn 原文入 brief；
          // revise 輪（reviseForGaps）已喺 hint 帶，唔重複。
          ? `${input.brief}\n\n【用戶對話修訂請求（採納落本輪創作）】\n${pendingAdopt.map((t) => `- ${t.text}`).join("\n")}`
          : input.brief,
        // 統籌裁決 0930（Chau 原話「冇寫秒數就任佢做」）：envelope 淨收 user
        // 指定（--duration）；冇＝undefined→duration_proposal_due 提案路——
        // 唔送程式填嘅數（600/舊預設12）做 user_locked 假鎖。
        targetSec: input.durationSec, ...(input.aspect ? { aspect: input.aspect } : {}), ...(input.language ? { language: input.language } : {}) },
      {
        crew: cfg.crew,
        model: cfg.crew.directorModel ?? (() => { throw new Error("director_model_missing: 導演席要明示 directorModel——創作整合唔借 writer 嘅平腦（SC-CREATIVE-OS-0927 分開明示）"); })(),
        receiptDir,
        fallbackModel: cfg.crew.secondFallback,
      },
      reviseForGaps,
    );
    const written = writeCreativeArtifacts(jobId, creativeDir, input.brief, plan, { targetSec: input.durationSec, ...(input.aspect ? { aspect: input.aspect } : {}), ...(input.language ? { language: input.language } : {}) });
    const planSha = written.planSha;
    // 落盤後 refresh：導演提案（spec.targetSec）已寫入 creative-intent——
    // 下游 writer/playwright/boards 閘跟提案（user 指定優先，冇先提案，
    // 再冇先 600 sentinel 防走火）。
    const targetSec = input.durationSec ?? readProposedTargetSec(jobId) ?? 600;
    await io.speak(
      "producer",
      `導演席：${plan.shots.length} 鏡節奏骨架落 creative/（assumptions ${plan.assumptions?.length ?? 0}、capability_gaps ${plan.capabilityGaps.length} 條明報）。writer 跟 treatment 寫，唔再由裸 brief 發明。`,
    );
    treatment = plan.treatment;
    directorSkeleton = skeletonOf(plan);
    // root R2 修①②（0928）：pending 採納唯一收口——plan 落盤即用 frozen 快照
    // 回寫（adopted@planSha＝採納輪證據；stale 具名 blocked）。快照後入隊嘅
    // turn 自然留下一輪（complete 淨清快照內 turnId）。revise 迴路（下方
    // runPlaywright 後）唔再讀 queue／唔再二次 complete——單一收口。
    if (frozenQueue.adopt.length || frozenQueue.stale.length) {
      completeAdoptedTurns(jobId, frozenQueue.adopt.map((t) => ({ turnId: t.turnId, adoptedRef: "creative/director-plan.json", revision: written.planSha.slice(0, 12), affectedScope: "creative：導演修訂輪（含用戶對話請求）" })), frozenQueue.stale);
    }
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
          castRoster: readCastRoster(input.castRosterPath),
        // §30-1/§31-2 G1：鎖義務＝user/task 採用契約（caller 明示）——舊 plan
        // placement 交集方式已退役；無鎖合法
        ...(input.dialogueLocks?.length ? { dialogueLocks: input.dialogueLocks } : {}) },
        { crew: cfg.crew, model: cfg.crew.directorModel ?? "", receiptDir, fallbackModel: cfg.crew.secondFallback },
      );
      scriptDialogueLines = dialogueSignalsOf(script).map((d) => d.line);
      // G1 批二＋批三：候選表 frozen 清單（beats 引用空間）＋版本收據
      // （scriptMdSha 綁 bytes；planSha＝本輪 director plan；utterancesDigest
      // ＝stableJson hash——world 落盤 dependsOn 四元用）
      const candNow = utteranceListOf(script.script_md);
      typedUtteranceList = candNow.list;
      typedUtteranceProvenance = { scriptMdSha: candNow.mdSha, planSha: planSha.slice(0, 16), utterancesDigest: utterancesDigestOf(candNow.list) };
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
        // §23 B：六類訊號同一 evaluate(script, adoptedPlan)——修觸發、hint、
        // 修後驗收三邊同一份結果（每類來源/範圍/嚴重度見 evaluateScriptAgainstPlan）。
        const ev = evaluateScriptAgainstPlan(script, plan);
        const anySignal = ev.unplaced.length > 0 || ev.declaredMissing.length > 0 || ev.newElements.length > 0
          || ev.timeGaps.length > 0 || ev.actionNews.length > 0 || ev.contactNews.length > 0;
        if (anySignal) {
          await io.speak(
            "producer",
            `修訂迴路：編劇版有 ${ev.unplaced.length} 句台詞冇導演落點${ev.actionNews.length ? `＋新動作 ${ev.actionNews.length} 項` : ""}${ev.contactNews.length ? `＋新接觸 ${ev.contactNews.length} 項` : ""}${ev.timeGaps.length ? `＋時間冇對應鏡 ${ev.timeGaps.length} 段` : ""}${ev.newElements.length ? `＋新增元素 ${ev.newElements.length} 項` : ""}——回導演修訂鏡表一輪。`,
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
              // §23 B：typed hint——完整差異原文＋newElements 內容（撤 slice
              // 200/300/400 截斷，遺失必要資料）；診斷類標明啟發式交導演逐項裁
              hint: [
                // root R2 修②（0928）：撤模型前 live queue 讀（兩次 call）——
                // pending 採納已喺 plan 落盤收口（frozen 快照）；呢度淨 script
                // 對 plan 差異訊號。
                ...(ev.unplaced.length ? [`【必要契約】冇落點台詞 ${ev.unplaced.length} 句：${ev.unplaced.map((u) => u.line).join("／")}`] : []),
                ...(ev.declaredMissing.length ? [`【必要契約】聲明台詞正文缺席（宣稱保留/新增但正文冇）：${ev.declaredMissing.join("／")}`] : []),
                ...(ev.newElements.length ? [`【變更紀錄】編劇明報新增元素 ${ev.newElements.length} 項——每項要採納到鏡表、或有來源嘅拒絕並同步修改劇本、或明示未解（唔可以清空紀錄過閘，拒絕唔可改用戶硬要求）：${ev.newElements.map((n) => `${n.what}（${n.why}）`).join("；")}`] : []),
                ...(ev.timeGaps.length ? [`【啟發式診斷·交你逐項裁】時間冇對應鏡 ${ev.timeGaps.length} 段（合法一段跨數鏡；誤報請講明理由同相關鏡引用）：${ev.timeGaps.join("；")}`] : []),
                ...(ev.actionNews.length ? [`【啟發式診斷·交你逐項裁】新動作差集（同義動作／聽者鏡可覆蓋＝誤報請講明理由）：${ev.actionNews.join("；")}`] : []),
                ...(ev.contactNews.length ? [`【啟發式診斷·交你逐項裁】新產品接觸（聲橋／畫外可覆蓋＝誤報請講明理由）：${ev.contactNews.join("；")}`] : []),
              ].join("；"),
            },
          );
          const rewritten = writeCreativeArtifacts(jobId, creativeDir, input.brief, revised, { targetSec: input.durationSec, ...(input.aspect ? { aspect: input.aspect } : {}), ...(input.language ? { language: input.language } : {}) });
          // root R2 修②（0928）：撤模型後 live queue 讀＋二次 complete——採納
          // 已喺 plan 首次落盤收口（frozen 快照）；呢度唔再讀 queue。
          updateCreativeManifest(creativeDir, input.brief, { file: "script.md", dependsOn: rewritten.planSha });
          updateCreativeManifest(creativeDir, input.brief, { file: "script.json", dependsOn: rewritten.planSha });
          plan = revised;
          directorSkeleton = skeletonOf(revised);
          // §23 B：修後驗收同一 evaluate——淨必要契約（unplaced＋假聲明）未解
          // 先 throw；newElements＝變更紀錄 emit 要採納/有據拒絕/明示未解；
          // 診斷類唔機械 FAIL（交導演逐項裁）。保存修前後結果（revision 由
          // manifest 記）；未通過候選唔標已採用成功。
          const after = evaluateScriptAgainstPlan(script, revised);
          const contractGaps = contractGapsOf(after);
          if (contractGaps.length) {
            emit(jobId, {
              agent: "producer", level: "warn",
              message: `revise 後必要契約仍缺 ${contractGaps.length} 項：${contractGaps.join("／")}`,
              data: { stage: "revise-verify", before: contractGapsOf(ev), after: contractGaps },
            });
            throw new Error(`revise_unclosed: 必要契約 revise 一輪後仍未解 ${contractGaps.length} 項（${contractGaps.join("；")}）——差距已列明，回導演席帶同片 history 修訂`);
          }
          if (after.newElements.length || after.timeGaps.length || after.actionNews.length || after.contactNews.length) {
            // §25 §23-B：newElements 採納核對——每項對 revised plan 全文 presence
            // 具名記錄（採納到鏡表＝找到／未採納）；唔係淨 warning 當採納證據。
            // 拒絕結構化渠道（導演修訂版 rejection 欄）未存在——未採納者明示
            // 「要責任席有來源採納或有據拒絕」，唔冒充已處理。
            const revisedText = JSON.stringify(revised);
            const adoptionCheck = after.newElements.map((n) => ({
              what: n.what,
              planPresence: revisedText.includes(n.what),
            }));
            emit(jobId, {
              agent: "producer", level: "warn",
              message: `revise 後非契約訊號仍在（變更紀錄 ${after.newElements.length} 項：${adoptionCheck.filter((a) => a.planPresence).length} 採納到 plan、${adoptionCheck.filter((a) => !a.planPresence).length} 未採納待責任席有據處理／診斷 ${after.timeGaps.length + after.actionNews.length + after.contactNews.length} 項待導演逐項裁）——唔機械 FAIL，明示未解`,
              data: {
                stage: "revise-verify-noncontract",
                newElements: adoptionCheck,
                diagnostics: { timeGaps: after.timeGaps, actionNews: after.actionNews, contactNews: after.contactNews },
              },
            });
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
    // G1 批二＋批三：resume 由磁碟 script.md 重建候選清單（同 mdSha 同編號）
    // ＋版本收據（planSha＝manifest entries director-plan.json sha——已載入
    // 來源，唔讀磁碟最新 manifest；缺 entry＝source-unknown 具名）
    const scriptMdDisk = path.join(creativeDir, "script.md");
    if (fs.existsSync(scriptMdDisk)) {
      const candDisk = utteranceListOf(fs.readFileSync(scriptMdDisk, "utf8"));
      typedUtteranceList = candDisk.list;
      const manHere2 = readCreativeManifest(creativeDir);
      const planEntry = manHere2?.entries?.find((e) => e.file === "director-plan.json");
      typedUtteranceProvenance = {
        scriptMdSha: candDisk.mdSha,
        planSha: planEntry?.sha256?.slice(0, 16) ?? "source-unknown",
        utterancesDigest: utterancesDigestOf(candDisk.list),
      };
    }
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
      // G1 批二：beats 引用空間（charter 教落位）
      ...(typedUtteranceList?.length ? { utterances: typedUtteranceList } : {}),
      ...(directorPlacements?.length ? { directorPlacements } : {}),
      ...(typedUtteranceList?.length ? { utterances: typedUtteranceList } : {}),
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

  // G1 批二驗收：漏引用／懸空引用＝miss 回 writer 落位（§28-6 責任分流）
  if (typedUtteranceList?.length) {
    const cov = utteranceBeatCoverage(writer.script, typedUtteranceList);
    if (cov.missing.length || cov.dangling.length) {
      emit(jobId, { agent: "producer", level: "warn",
        message: `utterance 落位 miss：${cov.missing.length} 句冇 beat 引用、${cov.dangling.length} 個懸空引用——回 writer 補位`,
        data: { stage: "utterance-coverage", missing: cov.missing, dangling: cov.dangling } });
      await io.speak("producer", `utterance 落位：${cov.missing.length} 句冇 beat 引用、${cov.dangling.length} 個懸空——事件時間線照 legacy 字串路兜住，回 writer 補位。`, "warn");
    }
  }
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
      // §25 A：callsheet 時長修訂 episode——額度真源＝job 持久欄（跨 resume
      // ／換模型唔刷新）；每輪 onAttempt 即刻 patch 落 job。
      sheetRepair: {
        attempts: readJob(jobId)?.callsheetRepairEpisode?.attempts ?? 0,
        max: SHEET_REPAIR_BUDGET,
        onAttempt: (attempts) => {
          const j = readJob(jobId);
          if (j) patch(j, { callsheetRepairEpisode: { attempts } });
        },
      },
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
  // G1 批三：收口回報（creative/resume 兩路組好嘅版本收據）
  if (typedUtteranceProvenance && typedUtteranceList?.length) {
    onUtteranceProvenance?.({ ...typedUtteranceProvenance, list: typedUtteranceList });
  }
  // 裁決 0928 D：導演聲畫落點隨 callsheet 落 world 段（audioTimeline 對照）
  // ROOT 0b7a60a：total gate 過＝durationGaps 清（修訂結果已同源驗收採用）。
  const jobAfter = readJob(jobId);
  if (jobAfter?.durationGaps?.length) patch(jobAfter, { durationGaps: [] });
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
  // G1 批三：utterance 版本收據入 ctx（world 段 audio-timeline dependsOn 四元）
  // ROOT 0b7a60a 收口裁定（supersede 差2 blocked-only 版）：真返創作 consumer
  // ——CallsheetRuntimeGap 額度准入時寫 durationGaps→authorCallSheet
  // reviseForGaps 認欄行導演修訂輪（分類/差額/quota 入 hint）→同源重驗
  // total gate；額度耗盡或修訂後再爆＝blocked（quota 唔重置，resume 唔刷新）。
  let sheet: Awaited<ReturnType<typeof authorCallSheet>>;
  for (let round = 0; ; round += 1) {
    try {
      sheet = await authorCallSheet(jobId, input, cfg, { speak, think }, (p) => {
        ctx.utteranceProvenance = p;
      });
      break;
    } catch (error) {
      if (!(error instanceof CallsheetRuntimeGap)) throw error;
      const g = error.gap;
      const job = readJob(jobId);
      const used = job?.callsheetRepairEpisode?.attempts ?? 0;
      if (round === 0 && used < SHEET_REPAIR_BUDGET) {
        if (job) patch(job, { durationGaps: [{ ...g, ts: new Date().toISOString() }], callsheetRepairEpisode: { attempts: used + 1 } });
        emit(jobId, { agent: "producer", level: "warn",
          message: `callsheet 時長差集（${g.kind}）→導演修訂輪（quota ${used + 1}/${SHEET_REPAIR_BUDGET}）：target ${g.targetSec}s／actual ${g.actual.toFixed(1)}s${g.scenes.length ? `；爆場 ${g.scenes.map((s) => `${s.sceneId}+${s.delta.toFixed(1)}s`).join("、")}` : "（冇單場爆＝全片分配）"}`,
          data: { stage: "callsheet-runtime", gap: g } });
        await speak("producer", `callsheet 時長差集回導演席修訂（${g.kind}，quota ${used + 1}/${SHEET_REPAIR_BUDGET}）。`, "warn");
        continue;
      }
      emit(jobId, { agent: "producer", level: "warn",
        message: `callsheet 時長差集額度耗盡（quota ${used}/${SHEET_REPAIR_BUDGET}）——blocked：${error.message}`,
        data: { stage: "callsheet-runtime", blocked: "callsheet_runtime_unclosed", gap: g } });
      ctx.job = patch(ctx.job, {
        status: "blocked",
        currentAgent: "producer",
        providers: trace,
        error: `callsheet_runtime_unclosed（額度耗盡，返創作層：${g.kind}）：${error.message}`,
        durationGaps: [{ ...g, ts: new Date().toISOString() }],
      });
      ctx.stopped = true;
      return;
    }
  }
  // G1 批四：resolver 一處配對＋凍結映射落盤（author 採納輪；world 讀同一
  // 檔＋驗 digest——兩側同結果，唔建持久 pool／全局 used 旗標）。同字歧義／
  // 未配到＝具名（ambiguous/unmatched）——唔靠遍歷順序。
  if (ctx.utteranceProvenance?.list.length) {
    const prov = ctx.utteranceProvenance;
    const placements = (sheet as { directorPlacements?: { word?: string; startSec?: number; endSec?: number; onImage?: string }[] }).directorPlacements ?? [];
    const r = resolveUtterancePlacements(prov.list, placements);
    const frozen: UtterancePlacementMap = {
      utterancesDigest: prov.utterancesDigest,
      callsheetDigest: sheetDigest(sheet),
      revision: prov.planSha,
      generatedAt: new Date().toISOString(),
      ...r,
    };
    fs.writeFileSync(jobFile(jobId, "creative", "utterance-placements.json"), JSON.stringify(frozen, null, 2));
    if (r.ambiguous.length || r.unmatchedUtterances.length) {
      emit(jobId, { agent: "producer", level: "warn",
        message: `utterance 落點配對：${r.pairs.length} 對；${r.unmatchedUtterances.length} 句未配到落點、${r.ambiguous.length} 組同字歧義（已記檔）`,
        data: { stage: "utterance-placements", pairs: r.pairs.length, unmatched: r.unmatchedUtterances, ambiguous: r.ambiguous } });
      await speak("producer", `utterance 落點：${r.pairs.length} 對凍結入 creative/utterance-placements.json；${r.unmatchedUtterances.length} 句未配到（回導演席補 dialogueClock）。`, "warn");
    }
  }
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
  // R19 裁決⑤（0929）：零可見板係執行格式／實際資料 coverage 問題——
  // callsheet 有合法鏡表（shots 非空＋continuity 鎖到）＝文字表模式依現行
  // 需求自動採納（記 source/mode，唔虛構用戶按過 override）。歷史曾照行只
  // 證歷史行為，唔係人手 allow 嘅證據——所以採納來源寫「現行需求自動採納」。
  // --allow-no-storyboard 降級做人手顯式 override（唔再係唯一路）。缺故事/
  // 鏡表（shots 空）照舊 capability gap 返負責席。
  const shotsLegal = (locked.shots?.length ?? 0) > 0 && continuity.cut.length > 0;
  if (boardCount === 0 && !shotsLegal && !input.allowNoStoryboard) {
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
  if (boardCount === 0 && shotsLegal) {
    ctx.job = patch(ctx.job, {
      outputs: { ...ctx.job.outputs, storyboardMode: "text-only-callsheet (auto-adopt per current requirement)" },
    });
  }
  await speak(
    "boards",
    boardCount > 0
      ? `分鏡專職鎖咗 ${continuity.cut.length} 鏡。可見板 ${boardCount} 格。故事＝分鏡＝剪接。Vault 只得 ${jobId}。下一席接走位。`
      : shotsLegal
        ? `文字表 ${continuity.cut.length} 鏡（callsheet 合法鏡表）。可見分鏡板 0——零板＋合法鏡表依現行需求自動採納 text-only 模式（source=auto-adopt；--allow-no-storyboard 係人手顯式 override 版）。`
        : `文字表 ${continuity.cut.length} 鏡。可見分鏡板 0，未逐格 GREEN。未算分鏡完成（--allow-no-storyboard 人手確認照行）。`,
    boardCount > 0 ? "info" : shotsLegal ? "info" : "warn",
  );
}
