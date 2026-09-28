import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { chatJsonSeat, type CrewConfig } from "./crew-llm";
import { VISIBLE_ACTION_VERBS, parseDurationTolerance } from "./script-contract";

/** SC-CREATIVE-OS-0927 §3 創作主路徑第一段：短 brief → 創作意圖 → 整片
 *  treatment → 導演節奏／事件表。呢層係通用能力（任何 brief），唔係 BP5S
 *  專用：BP5S 嗰份 director-plan.json 係佢嘅第一個案例形狀。
 *
 *  分工：creative 席只做「由 brief 推導得出嘅嘢」——treatment（有觀看價值嘅
 *  全片方案）、事件表（eventKind 分型：現象/表情/接觸/釋放終於係一等公民）、
 *  每鏡目的＋四鐘分離。落盤 jobDir/creative/，writer 席食 treatment＋硬要求
 *  寫對白／人物細節，boards 席食節奏骨架開鏡（beatIds 多對多）。
 *
 *  誠實律：capability_gaps 係本席法定輸出——sit／接觸等 renderer 未支援嘅
 *  事件要明報，唔准靜靜改寫成另一個動作過閘（REVIEW_CONTINUE §授權3）。 */

export const DIRECTOR_CHARTER = [
  "# 導演席技能 — 導演思考流程＋決策參考表（網上教材蒸餾 2026-09-27）\n\n呢份係本工知識，唔係格式規則：charter 教你交咩欄位，呢度教個腦點行。\n主體係思考次序——收到一場戲之後一步步問自己；附錄係逐項決策參考表（rule= 一行一條），行到嗰步先查。\n\n## 來源\n- StudioBinder《What is a Film Cut — Editing Cuts & Transitions Explained》（剪接種類：basic cut／J cut／L cut／insert／match cut／smash cut／cross cut）\n- StudioBinder《Ultimate Guide to Camera Shots》＋ shot list 教材（景別階梯、角度情緒、coverage 常規）\n- Wikipedia：180-degree rule、Eyeline match（continuity editing 條目）\n- NoFilmSchool／PremiumBeat 剪接教材（cutting-on-action 傳統：動作切／視線切／意念切／走位切，Reisz–Dmytryk 編輯理論系譜）\n\n# 主體：導演思考次序（六步，順住行）\n\n**第①步——呢場戲憑咩存在。**\n收到一場戲，未諗鏡頭之前先問自己：「刪咗呢場，觀眾蝕咗乜？」答得出具體嘅嘢（少咗一個轉捩點、少咗認識一個人、少咗一個伏筆），呢場先准存在；答「冇損失」，呢場唔應該存在。呢個 deletionLoss 思維由場落 beat 逐層用——每個 beat 都問同一條問題。呢步定咗之後，你成場每個決定都係為「呢個損失唔可以發生」而服務。\n\n**第②步——逐個切位問：觀眾而家正諗緊乜。**\n沿住時間軸行，去每個你打算切嘅位停一停，問：「呢一刻觀眾個腦掛住咩？」——「佢望到啲乜？」「佢把口仲有半句」「B 聽到呢句會點」。呢個答案就係你嘅本錢：觀眾嘅期待就係你下一鏡嘅入場券。某個切位答唔出觀眾諗緊乜＝你仲未識點切呢度，返去第①步睇返呢場嘅 job。\n\n**第③步——由個答案揀 cut 動機。**\n第②步嘅答案直接話你知用邊種切：觀眾想睇佢望到嘅嘢→視線切；動作未完觀眾等下半→動作切（喺動作中段切走，唔好等做完）；兩個畫面有概念呼應而呢個位係段落收尾→意念切；角色行緊去新空間→走位切（行動中段切，門前切，唔好入定先切）。揀唔到動機＝呢個 cut 唔應該存在——一係兩鏡合併，一係成段刪；「呢鏡拍夠咗」唔係動機。動機分類明細查附錄 A（d1–d7）。\n\n**第④步——coverage 由戲劇目的推。**\n每鏡問「呢鏡做緊咩戲劇工」，個工決定景別：開場定位＝wide 畫地圖（邊個喺邊、環境係咩）；對白交鋒＝medium／closeup 輪替（講者一個 size、聽者另一個 size）；情緒爆點＝size 跳到全片最近，而爆前一拍反而要闊要慢——落差就係衝擊；關鍵信息（產品、鎖、時鐘）＝insert；收尾呼吸＝拉返闊。成場 wide→窄→闊係一個完整呼吸。每鏡淨係一個觀眾望嘅位（audienceEye 必答、淨答一樣）。明細查附錄 B（d8–d14）。\n\n**第⑤步——節奏：beat 工種配鏡長同切法。**\nrhythmMap 逐個 beat 問佢做緊咩工：勾（開場頭幾秒俾問號唔俾全圖，鏡短）→推進（短鏡快切，動作切為主，冇靜鏡）→爆（切到最密＋size 最近，爆前必有呼吸蓄力）→呼吸（鏡放長、size 放闊，俾觀眾消化——唔係冇嘢發生）→收（最後一鏡停夠先切走，收嘅畫面要係觀眾拎得走嗰格）。deletionLoss 答唔出嘅 beat 併入隔籬。明細查附錄 C（d15–d20）。\n\n**第⑥步——收尾自檢：行返一次時間軸。**\n成場 cut 完之後，逐個切位再問多次第②步嗰條問題「觀眾而家正諗緊乜」，今次答案要同你嘅下一鏡完全夾：觀眾期待嘅嘢有冇開俾佢？開嘅次序係咪就係期待升溫嘅次序？軸線守唔守到（兩個人左右關係全場鎖死，換邊有冇 frontal 過渡）？爆點對白有冇收喺聽者反應鏡度？呢步邊度唔啱，返去對應嗰步改，唔好硬交。軸線／視線明細查附錄 D（d21–d23）。\n\n---\n\n# 附錄：決策參考表（行到嗰步先查；rule= 一行一條）\n\n## A. 切嘅動機分類（第③步用）\n- [d1] cut.action rule=動作切：喺動作進行中段切走（手啱啱提起嗰下切，唔好等佢放低），下一鏡接住完成下半。動作中間切＝隱形；動作完咗先切＝顯眼。cutReason 寫「動作未完，接下手」。\n- [d2] cut.look rule=視線切：角色望向畫外，下一鏡開佢望到嘅嘢。呢個係控制觀眾注意力最強嘅切法。cutReason 寫「觀眾要睇到佢望到嘅嘢」。冇下一鏡接住嘅望，唔好開（個望會爛尾）。\n- [d3] cut.idea rule=意念切（match cut）：兩個畫面喺形狀／動作／概念上呼應。留畀段落收尾或轉場，一場最多一兩下；氾濫就廉價。\n- [d4] cut.walk rule=走位切：角色行緊去新空間，喺行動中段切（未過門口切，唔好等入定先切）。行路嗰段冇新信息嘅部分全部唔好拍。\n- [d5] cut.none rule=冇動機唔准切：cutReason 答唔出「切走係因為乜」，一係合併一係刪。「呢鏡拍夠咗」唔係動機，「下一鏡有嘢觀眾要睇」先係。\n- [d6] cut.sound rule=聲音先行（J cut）：下一場嘅聲早過畫面入場，聲音拖住觀眾過場。轉場位優先用，尤其 dialogueClock 對白啱啱要接嗰啲位。\n- [d7] cut.reaction rule=爆點對白唔好收喺講者鏡：關鍵句嘅尾音收喺聽者反應鏡度，衝擊力大過收喺講者個口。placements 嘅 onImage 同句尾時間點要夾到呢一下。\n\n## B. Coverage 對照（第④步用）\n- [d8] cov.open rule=場口開場＝wide／full 做空間定位：邊個喺邊、環境係咩，觀眾未有了局之前唔好跳 closeup。一場至少一個定位鏡。\n- [d9] cov.dialogue rule=對白交鋒＝medium 同 closeup 輪替：講者一個 size、聽者另一個 size，兩個 size 交替先有節奏。同一 size 連續兩鏡＝浪費一鏡（pair-size 原則）。\n- [d10] cov.emotion rule=情緒爆點＝size 跳到最細（CU／極微距）：爆嗰下用全片最近嘅鏡。爆點之前嗰一拍反而要闊啲慢啲，落差就係衝擊。\n- [d11] cov.info rule=關鍵信息（產品細節、鎖、時鐘、手機畫面）＝insert：觀眾必須認得嘅嘢先開 insert，裝飾性細節唔使。\n- [d12] cov.close rule=收尾呼吸＝size 拉返闊：爆完之後 wide／full 畀觀眾落返地球。成場由闊行到窄再返闊係一個完整呼吸。\n- [d13] cov.minimum rule=一個對話場嘅最基本 coverage＝wide（定位）＋medium（交鋒）＋closeup（情緒）三個 size 起步；得兩個 size 嘅場要諗清楚係咪特登嘅極簡。\n- [d14] cov.eye rule=每鏡淨係一個觀眾望嘅位：audienceEye 每鏡必答，同埋只答一樣嘢（一張臉／一件物／一隻手）。觀眾一鏡要揀兩樣嘢望＝呢鏡設計失敗。\n\n## C. 節奏↔工種（第⑤步用）\n- [d15] rhythm.hook rule=勾：開場頭幾秒一個「問號畫面」——俾缺口唔俾全圖。鏡短（1–2s），信息唔齊，觀眾自己追。\n- [d16] rhythm.build rule=推進：短鏡快切（1–2s），以動作切為主，每鏡推進一格信息。推進段唔好有靜鏡。\n- [d17] rhythm.payoff rule=爆：切到全片最密＋size 跳到最近。爆前一拍必須係呼吸（蓄力），冇蓄力嘅爆冇落差。\n- [d18] rhythm.breath rule=呼吸：鏡放長（3 秒以上）、size 放闊、動作放慢。呼吸唔係冇嘢發生，係俾觀眾消化啱啱嗰下。\n- [d19] rhythm.end rule=收：最後一鏡停夠先切走（黑位前最少俾個畫面企住一陣）；收嗰個畫面要係觀眾拎得走嗰個——佢就係人哋聽日形容你套片嘅嗰格。\n- [d20] rhythm.loss rule=deletionLoss 答唔出「刪咗損失咩」嘅 beat 唔應該存在：答「冇損失」＝即刻併入隔籬 beat。\n\n## D. 軸線同視線（第⑥步自檢用）\n- [d21] axis.180 rule=兩個人嘅戲：一開場定咗邊個畫左邊，成場鎖死唔換邊（180 度軸線）。要換邊，中間必須插一個 frontal 鏡或者一個行過位嘅鏡做過渡，唔係觀眾會迷路。\n- [d22] axis.look rule=角色望嘢＝導演嘅滑鼠：先拍個望（audienceEye 寫「追住佢眼光」），下一鏡開佢望嘅嘢，觀眾就會自己望過去。呢個序列可以砌埋一齊先至剪爛佢——觀眾期待就係你嘅本錢，開咗個望一定要找數。\n- [d23] axis.offscreen rule=畫外嘢（聲、影、第二個人未現身）係最平嘅懸念：唔使特登拍。聽到就得，遲啲先開。\n- [d24] self.naked rule=每個 cut 逐個問：切走嗰下觀眾正喺度諗緊乜？答案就係下一鏡要開嘅嘢。答唔出＝呢個切位錯。" +
  ` --- 分鏡席技能到此，以下係章程 ---`,
  "# 導演席 charter — 呢套片嘅作者",
  "",
  "你係導演。收一個短 brief，交返一部拍得出嘅片嘅完整創作：個點樣睇嘅決定權喺你。",
  "",
  "你嘅工：",
  "0. 開工先讀 brief（SLATECREW_OS_SCOPE）：分清【用戶硬要求】（寫明嘅時長／產品／指定動作對白／畫幅語言）、【偏好】、【系統假設】、【未知】。台詞原文唔自動等於「只准呢啲台詞」；模板鏡數秒數唔係用戶要求（除非寫明）。然後揀流程並記喺 flow 欄：故事／對白片→可演劇本先行；MV／感官片→音樂與視覺結構先行；教學→正確內容先行；現成素材→材料理解同剪輯方案先行；用戶交完整劇本→忠實執行唔自行加戲。呢個揀擇係你嘅判斷，唔係固定流水線。",
  "1. 諗清楚呢套片點解要存在——觀眾睇完會帶走咩一句嘢。呢個係你嘅視野，全片每個決定服務佢。",
  "2. 寫一份有觀看價值嘅 treatment：開場點樣攞住觀眾、條情緒線點行、高潮喺邊、點收尾。文字要令人想睇呢條片，唔係說明書。",
  "3. 設計節奏：邊度快邊度慢、邊度停一停呼吸、邊個位係成片最大嗰下。每一段講得到佢做緊咩工（勾／推進／爆／呼吸／收），同埋刪咗佢會損失咩。",
  "4. 逐鏡設計：每鏡有目的、有觀眾望嘅位、有佢嘅畫面同點解咁剪。鏡數由你嘅節奏決定，冇人規定幾多鏡。",
  "5. 你唔肯定下游拍唔拍到嘅嘢（坐姿、接觸、特殊現象）照寫喺 capability_gaps——呢個係你要嘅嘢嘅清單，唔係你嘅限制。",
  "",
  "創作規矩（得呢幾條）：",
  "- 廣告／商業片按 brief 判讀，唔將單一案例喜好變全局法：brief／品牌要求故事感時，產品係爆點唔係被展示嘅主角，觀眾被故事拉住行；hard-sell 直接產品示範若 brief／品牌咁要求亦係合法廣告形。你先判 brief 屬邊形，再揀工（V1 0928：個案例句已移——每條片嘅內容由佢自己嘅 brief 提供）。",
  "- brief 係起點唔係劇本：佢講咗嘅嘢（時長、產品、指定動作對白）係承諾；佢冇講嘅全部由你話事，揀完講得出點解。",
  "- 秒數唔夠用＝你嘅內容未夠，加戲份量，唔准拖慢舊動作或者空鏡填秒。",
  "- 現象（冷凝、汽泡、光）、表情、觸感都係正當嘅電影內容，同動作一樣可以用。",
  "- 時間欄一律用 span:[起秒,止秒] 陣列（beats 同 shots 都係，例如 span:[0,4.5]）——機器照呢個讀；用其他名（start/end、timeIn/timeOut…）機器都會盡量收，但 span 最穩。",
  "- 對白係你嘅樂器之一：邊句喺邊個畫面講、點樣同畫面互相加乘，你話事。dialogueClock 要蓋晒片入面所有會播出嘅人聲——角色對白、畫外音（VO／旁白）、開場句收尾句都係對白事件，一句一個落點（同一句講兩次＝兩個落點）；漏一個落點，下游聲音時間線就少一句。",

  "",
  "工程欄位（機器接線用，照填就得）：beatId 寫 B01/B02；shotId 寫 NSH-A/NSH-B；事件時間秒。結構啱唔啱機器會話你知，你嘅本事花喺上面五點。",
].join("\n");

/** 首跑實證（0927，glm-5.3 Zhipu）：導演腦嘅自然文形係 spec/vision{coreLine,
 *  whyExist}/treatment/rhythmMap/dialogueClock.placements/shots 時間軸/
 *  soundDesignNote/capabilityGaps——而且係佳作（逐字對白落點、每拍 deletionLoss、
 *  真製作知識嘅 gaps）。schema 服務導演，唔係導演填表格：照收自然文形，
 *  機器閘淨留時間軸／覆蓋／總長呢啲下游契約。 */
const directorBeat = z.object({
  beatId: z.string().regex(/^B\d{1,3}$/),
  label: z.string().min(1),
  startSec: z.number().min(0),
  endSec: z.number().min(0),
  /** 節奏工種：勾／推進／爆／呼吸／收……自由短語 */
  job: z.string().min(1).optional(),
  /** 呢拍做緊咩（導演原文欄位名 doesWhat，等價映射保留語義） */
  doesWhat: z.string().optional(),
  rhythm: z.string().optional(),
  /** 刪段測試（導演自答：刪咗損失咩；原文欄位名 deleteLoss） */
  deletionLoss: z.string().optional(),
});

const directorShotNative = z.object({
  shotId: z.string().min(2).max(12),
  beatId: z.string().regex(/^B\d{1,3}$/),
  startSec: z.number().min(0),
  endSec: z.number().min(0),
  purpose: z.string().min(1),
  /** 導演內容欄（等價映射保留原名：eyeLine/action/cutReason 係佢嘅話） */
  audienceEye: z.string().optional(),
  frame: z.string().optional(),
  action: z.string().optional(),
  sound: z.string().optional(),
  cutReason: z.string().optional(),
  /** 自由文字（極微距／特寫／中景…）；廠 size enum 映射留 consumer */
  size: z.string().max(24).optional(),
  cast: z.array(z.string().max(8)).max(4).optional(),
  /** 對白原文（PROVENANCE_0927＋C 統籌 0927 指正）：一句可以好長、可跨鏡——
   *  完整原文契約，冇字數閘（截斷＝落點/比對兩頭唔到岸）。 */
  dialogue: z.string().min(1).optional(),
});

const dialoguePlacement = z.object({
  /** 落點台詞原文：完整保留（unplacedDialogueOf 歸一化子串比對食呢個）；
   *  冇字數閘——長句／跨鏡句唔准截。 */
  word: z.string().min(1),
  startSec: z.number().min(0),
  endSec: z.number().min(0),
  onImage: z.string().optional(),
  delivery: z.string().optional(),
});

export const DirectorPlanSchema = z.object({
  title: z.string().optional(),
  thinking: z.string().optional(),
  /** SLATECREW_OS_SCOPE §1/§2：brief 判讀＋流程選擇——短brief發展內容／完整
   *  劇本忠實執行／MV／教學／素材剪輯各按需要計劃；唔可以某一套路變全局法 */
  flow: z.union([
    z.string().min(2),
    z.object({
      kind: z.string().min(2),
      why: z.string().optional(),
      briefReading: z.object({
        hard: z.array(z.string()).optional(),
        preferences: z.array(z.string()).optional(),
        unknowns: z.array(z.string()).optional(),
      }).optional(),
    }),
  ]).optional(),
  spec: z.object({
    targetSec: z.number().positive(),
    aspect: z.string().max(12).optional(),
    language: z.string().max(12).optional(),
    product: z.string().max(32).optional(),
  }).optional(),
  vision: z.union([
    z.string().min(8),
    z.object({
      coreLine: z.string().min(4).optional(),
      whyExist: z.string().optional(),
      everyDecisionServes: z.string().optional(),
    }),
  ]),
  // §19：撤字數當質素 verdict——非空保留；完整性由責任席按本次意圖/可演內容判
  treatment: z.string().min(1),
  dialogueClock: z.object({
    placements: z.array(dialoguePlacement).optional(),
    note: z.string().optional(),
  }).optional(),
  // §19：撤固定創作上限（24拍/32鏡）——長計劃由 caller 按實際資源分段/續寫並
  // 校驗來源拼接，呢層唔截斷唔默默少交。
  rhythmMap: z.array(directorBeat).min(1),
  shots: z.array(directorShotNative).min(1),
  soundDesignNote: z.string().optional(),
  /** 節奏總綫（快慢圖）——導演原文欄位 rhythmNote，等價映射保留 */
  rhythmNote: z.string().max(800).optional(),
  /** brief 逐項對返鏡頭嘅自檢表——成片 QC 對呢份驗 */
  briefCompliance: z.record(z.string(), z.string()).optional(),
  capabilityGaps: z.array(z.union([z.string().min(4).max(200), z.object({ want: z.string(), layer: z.string() })])).default([]),
  /** 導演創作過程欄位（等價保留，唔做語義消費）：交咗幾個方向揀邊個、自檢時長 */
  coreIdeas: z.array(z.unknown()).optional(),
  directorChoices: z.unknown().optional(),
  durationCheck: z.unknown().optional(),
  assumptions: z.array(z.object({
    assumption: z.string().min(4).max(120),
    why: z.string().max(200).optional(),
  })).optional(),
}).superRefine((plan, report) => {
  const target = plan.spec?.targetSec;
  const beatIds = new Set(plan.rhythmMap.map((b) => b.beatId));
  const covered = new Set<string>();
  for (const [i, s] of plan.shots.entries()) {
    if (s.endSec <= s.startSec) {
      report.addIssue({ code: "custom", path: ["shots", i, "endSec"], message: "endSec 要 > startSec" });
    }
    if (!beatIds.has(s.beatId)) {
      report.addIssue({ code: "custom", path: ["shots", i, "beatId"], message: `${s.beatId} 唔喺 rhythmMap` });
    }
    covered.add(s.beatId);
    if (target && s.endSec > target + 1e-6) {
      report.addIssue({ code: "custom", path: ["shots", i, "endSec"], message: `鏡越出片長 ${target}s` });
    }
  }
  for (const b of plan.rhythmMap) {
    if (!covered.has(b.beatId)) {
      report.addIssue({ code: "custom", path: ["rhythmMap"], message: `beat ${b.beatId} 冇鏡覆蓋` });
    }
  }
  for (const [i, p] of (plan.dialogueClock?.placements ?? []).entries()) {
    if (!plan.shots.some((s) => p.startSec >= s.startSec - 1e-6 && p.endSec <= s.endSec + 1e-6)) {
      report.addIssue({ code: "custom", path: ["dialogueClock", "placements", i], message: `對白「${p.word}」落點唔喺任何鏡時間內` });
    }
  }
  if (target) {
    // §20③：共同 parser（finite＋範圍＋非法具名 throw；NaN fail-open 收口）
    const TOL = parseDurationTolerance();
    const end = Math.max(...plan.shots.map((s) => s.endSec));
    if (Math.abs(end - target) > target * TOL + 1e-6) {
      report.addIssue({ code: "custom", path: ["shots"], message: `片尾 ${end.toFixed(1)}s 離目標 ${target}s 超過 ±${Math.round(TOL * 100)}%（容差可配）` });
    }
  }
});

/** 對外一句版視野（QC 對返呢句；object 形取 coreLine＋whyExist 首句） */
export function directorVisionLine(plan: DirectorPlan): string {
  if (typeof plan.vision === "string") return plan.vision;
  const v = plan.vision;
  return [v.coreLine, v.whyExist?.split(/[。！？\n]/)[0]].filter(Boolean).join("——").slice(0, 200);
}

export type DirectorPlan = z.infer<typeof DirectorPlanSchema>;

export function buildCreativeEnvelope(brief: string, opts: { targetSec?: number; aspect?: string; language?: string }) {
  return {
    brief_verbatim: brief,
    // §11（0927）：時長只來自 brief 寫明嘅秒數，或者導演為呢個故事發展出
    // 嘅長度。brief 冇秒數→唔再靜靜預設 600，叫導演提案（plan.spec.targetSec）。
    ...(opts.targetSec !== undefined
      ? { user_locked: { targetSec: opts.targetSec, ...(opts.aspect ? { aspect: opts.aspect } : {}), ...(opts.language ? { language: opts.language } : {}) } }
      : {
          user_locked: { ...(opts.aspect ? { aspect: opts.aspect } : {}), ...(opts.language ? { language: opts.language } : {}) },
          duration_proposal_due: "brief 冇指定時長——你按故事需要提案 targetSec（秒），寫入 spec.targetSec",
        }),
    clock_truth: "對白時鐘＝字數×0.12+0.15（代碼真源）；時長不足＝發展內容，唔拉長",
  };
}

/** 等價格式 compiler（PI_REVIEW_HANDOFF＋Chau 0927 指令）：導演每次用佢嘅
 *  自然欄位名（beats/window/doesWhat/deleteLoss/eyeLine/cutReason/dialogue[]
 *  /capability_gaps/meta.filmTitle…）。compiler 淨做命名/格式等價映射，每步
 *  落收據；內容零改寫、零填空。真缺語義（成個 block 冇）先報 miss 返導演補。
 *  兩輪實渉形狀：run1=rhythmMap/placements；run2=beats+window/dialogue[]。 */
export function compileDirectorPlan(raw: unknown): { plan: DirectorPlan; receipt: string[]; misses: string[] } {
  const receipt: string[] = [];
  const misses: string[] = [];
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const a = (src.answer && typeof src.answer === "object" ? src.answer : src) as Record<string, unknown>;
  if (a !== src) receipt.push("unwrap: answer → 頂層");

  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  /** 時間段字串等價解析：「0.0–3.2」（十進制秒）、「00:00-00:05」（mm:ss） */
  const win = (v: unknown): { s?: number; e?: number } => {
    // 陣列形 span [start, end]（WSY6 實測：模型交 span:[0,4.5]——第三款自然形）
    if (Array.isArray(v) && v.length >= 2 && typeof v[0] === "number" && typeof v[1] === "number") {
      return { s: v[0] as number, e: v[1] as number };
    }
    if (typeof v !== "string") return {};
    const m = v.match(/(\d+(?:\.\d+)?)(?::(\d+(?:\.\d+)?))?\s*[–—~-]\s*(\d+(?:\.\d+)?)(?::(\d+(?:\.\d+)?))?/);
    if (!m) return {};
    const sec = (a?: string, b?: string) => (b !== undefined ? Number(a) * 60 + Number(b) : Number(a));
    return { s: sec(m[1], m[2]), e: sec(m[3], m[4]) };
  };

  // 值語義時間提取器（六款自然形後嘅根治）：欄位名係開放集，值類型先係語義
  // ——①任何 [number, number] 陣列值（span/[起,止]）②key 掃描 start*/from* 對
  // end*/to* 嘅數字對（tStart/tEnd/startSec/timeIn…全族）③範圍字串（win）。
  // 等價 compiler 本義：收自然形，唔追欄位名。
  const timeOf = (o: Record<string, unknown>): { s?: number; e?: number } => {
    for (const v of Object.values(o)) {
      const w = win(v);
      if (w.s !== undefined && w.e !== undefined) return w;
    }
    let sv2: number | undefined; let ev2: number | undefined;
    for (const [k, v] of Object.entries(o)) {
      if (typeof v !== "number") continue;
      const lk = k.toLowerCase();
      if (sv2 === undefined && /(start|from|begin|onset|^in$|^t$)/.test(lk)) sv2 = v;
      else if (ev2 === undefined && /(end|to$|finish|out$|until)/.test(lk)) ev2 = v;
    }
    if (sv2 !== undefined && ev2 !== undefined) return { s: sv2, e: ev2 };
    return win(o.window ?? o.timeRange ?? o.time ?? o.t);
  };

  // meta → title/spec
  const meta = (a.meta && typeof a.meta === "object" ? a.meta : {}) as Record<string, unknown>;
  const title = typeof a.title === "string" ? a.title : typeof meta.filmTitle === "string" ? meta.filmTitle : undefined;
  if (title && !a.title) receipt.push("title ← meta.filmTitle");
  const specSrc = (a.spec && typeof a.spec === "object" ? a.spec : meta) as Record<string, unknown>;
  const targetSec = num(specSrc.targetSec);
  const spec = targetSec ? {
    targetSec,
    ...(typeof specSrc.aspect === "string" ? { aspect: specSrc.aspect } : {}),
    ...(typeof specSrc.language === "string" ? { language: specSrc.language } : {}),
    ...(typeof specSrc.product === "string" ? { product: specSrc.product } : {}),
  } : undefined;
  if (spec && !a.spec) receipt.push("spec ← meta{targetSec,aspect,language}");

  // beats | rhythmMap → rhythmMap
  const beatsRaw = (Array.isArray(a.rhythmMap) ? a.rhythmMap : Array.isArray(a.beats) ? a.beats : null) as Record<string, unknown>[] | null;
  if (!beatsRaw) misses.push("節奏表（beats/rhythmMap）整體缺席——回導演補，唔准編");
  const rhythmMap = (beatsRaw ?? []).map((b) => {
    const w = timeOf(b);
    const s = num(b.startSec) ?? w.s;
    const e = num(b.endSec) ?? w.e;
    if ((b.span ?? b.window ?? b.timeRange ?? b.time) && s !== undefined) receipt.push(`beat ${String(b.beatId)} span "${JSON.stringify(b.span ?? b.window ?? b.timeRange ?? b.time)}" → ${s}–${e}s`);
    // label 等價鏈：name/label/tempo/job 都係導演自己嘅字——冇先至用 beatId
    const label = [b.label, b.name, b.tempo, b.job].find((v) => typeof v === "string" && String(v).trim()) ?? b.beatId;
    if (b.tempo && !b.label && !b.name) receipt.push(`beat ${String(b.beatId)} label ← tempo`);
    return {
      beatId: String(b.beatId ?? ""),
      label: String(label),
      ...(s !== undefined ? { startSec: s } : { startSec: 0 }),
      ...(e !== undefined ? { endSec: e } : { endSec: 0 }),
      ...(typeof b.job === "string" ? { job: b.job } : {}),
      ...(typeof (b.doesWhat ?? b.note) === "string" ? { doesWhat: String(b.doesWhat ?? b.note) } : {}),
      ...(typeof (b.rhythm ?? b.tempo) === "string" ? { rhythm: String(b.rhythm ?? b.tempo) } : {}),
      ...(typeof (b.deletionLoss ?? b.deleteLoss ?? b.loss_if_cut) === "string" ? { deletionLoss: String(b.deletionLoss ?? b.deleteLoss ?? b.loss_if_cut) } : {}),
    };
  });

  // shots：eyeLine→audienceEye（等價），action/cutReason 原名保留
  const shotsRaw = (Array.isArray(a.shots) ? a.shots : []) as Record<string, unknown>[];
  if (!shotsRaw.length) misses.push("shots 整體缺席——回導演補");
  // beatId 衍生（第五款自然形：shots 冇 beatId、淨時間——模型心智＝鏡跟時間
  // 唔跟拍）。等價映射：同 beats 時間窗重疊最大嗰拍；內容零改寫。
  const beatWindows = rhythmMap.map((b) => ({ id: String(b.beatId), s: b.startSec, e: b.endSec }));
  const deriveBeatId = (sv: number, ev: number): string => {
    let best = ""; let ov = -1;
    for (const bw of beatWindows) {
      const o = Math.min(ev, bw.e) - Math.max(sv, bw.s);
      if (o > ov) { ov = o; best = bw.id; }
    }
    return best;
  };
  const shots = shotsRaw.map((s) => {
    const w = timeOf(s);
    const sv = num(s.startSec) ?? num(s.start) ?? w.s;
    const ev = num(s.endSec) ?? num(s.end) ?? w.e ?? (num(s.durSec) !== undefined && sv !== undefined ? sv + num(s.durSec)! : undefined);
    if (sv === undefined || ev === undefined) misses.push(`shot ${String(s.shotId ?? "?")} 時間欄缺席（交咗嘅 keys：${Object.keys(s).join(",")}）——回導演補，唔准編`);
    return {
      shotId: String(s.shotId ?? ""),
      beatId: (String(s.beatId ?? "").trim() || (sv !== undefined && ev !== undefined ? deriveBeatId(sv, ev) : "")),
      ...(sv !== undefined ? { startSec: sv } : { startSec: 0 }),
      ...(ev !== undefined ? { endSec: ev } : { endSec: 0 }),
      purpose: String(s.purpose ?? s.subject ?? s.action ?? s.why ?? s.goal ?? s.description ?? s.note ?? ""),
      ...(typeof (s.audienceEye ?? s.eyeLine ?? s.audience_eye) === "string" ? { audienceEye: String(s.audienceEye ?? s.eyeLine ?? s.audience_eye) } : {}),
      ...(typeof (s.frame ?? s.camera) === "string" ? { frame: String(s.frame ?? s.camera) } : {}),
      ...(typeof s.action === "string" ? { action: s.action } : {}),
      ...(typeof s.sound === "string" ? { sound: s.sound } : {}),
      ...(typeof (s.cutReason ?? s.cut) === "string" ? { cutReason: String(s.cutReason ?? s.cut) } : {}),
      ...(typeof s.size === "string" ? { size: s.size } : {}),
      ...(Array.isArray(s.cast) ? { cast: (s.cast as unknown[]).map(String) } : {}),
      ...(typeof s.dialogue === "string" ? { dialogue: s.dialogue } : {}),
    };
  });
  const derivedBeat = shotsRaw.filter((s) => !String(s.beatId ?? "").trim()).length;
  if (derivedBeat > 0) receipt.push(`shots.beatId ← 時間重疊衍生 ×${derivedBeat}（模型交零 beatId，第五款自然形——內容零改寫）`);
  if (shotsRaw.some((s) => typeof s.eyeLine === "string")) receipt.push("shots.eyeLine → audienceEye（全部保留原文）");
  if (shotsRaw.some((s) => typeof s.camera === "string" && !s.frame)) receipt.push("shots.camera → frame");

  // dialogue[] | dialogueClock → dialogueClock
  let dialogueClock: DirectorPlan["dialogueClock"];
  const dcRaw = a.dialogueClock ?? a.dialogue_clock;
  if (Array.isArray(dcRaw)) {
    // 陣列形：直接係落點列表
    dialogueClock = {
      placements: (dcRaw as Record<string, unknown>[]).map((d) => {
        const w2 = win(d.window ?? d.time);
        const s2 = num(d.startSec) ?? num(d.start) ?? w2.s;
        const e2 = num(d.endSec) ?? num(d.end) ?? w2.e;
        return {
          word: String(d.text ?? d.word ?? d.line ?? ""),
          ...(s2 !== undefined ? { startSec: s2 } : { startSec: 0 }),
          ...(e2 !== undefined ? { endSec: e2 } : { endSec: 0 }),
          ...(typeof (d.onImage ?? d.on_image) === "string" ? { onImage: String(d.onImage ?? d.on_image) } : {}),
          ...(typeof d.delivery === "string" ? { delivery: d.delivery } : {}),
        };
      }),
    };
    receipt.push("dialogueClock ← dialogue_clock（陣列→placements）");
  } else if (typeof dcRaw === "string") {
    // 散文自述形：對白落點喺 shots.dialogue；呢句係時鐘自述，升做 note
    dialogueClock = { note: dcRaw.slice(0, 240) };
    receipt.push("dialogueClock ← dialogue_clock（字串自述→note；逐字落點喺 shots.dialogue）");
  } else if (dcRaw && typeof dcRaw === "object") {
    if (a.dialogue_clock) receipt.push("dialogueClock ← dialogue_clock");
    dialogueClock = dcRaw as DirectorPlan["dialogueClock"];
  } else {
    const dlist = (Array.isArray(a.dialogue) ? a.dialogue : Array.isArray(a.dialogue_plan) ? a.dialogue_plan : null) as Record<string, unknown>[] | null;
    if (dlist) {
      // 淨落點先入 placements；note 類條目（冇 text/word）係導演旁述——升做 note，唔係填空
      const placements = dlist
        .filter((d) => typeof (d.text ?? d.word ?? d.line) === "string" && String(d.text ?? d.word ?? d.line).trim())
        .map((d) => {
          const w = win(d.window);
          const s = num(d.startSec) ?? w.s;
          const e = num(d.endSec) ?? w.e;
          return {
            word: String(d.text ?? d.word ?? d.line),
            ...(s !== undefined ? { startSec: s } : { startSec: 0 }),
            ...(e !== undefined ? { endSec: e } : { endSec: 0 }),
            ...(typeof d.onImage === "string" ? { onImage: d.onImage } : {}),
            ...(typeof d.delivery === "string" ? { delivery: d.delivery } : {}),
          };
        });
      const noteEntry = dlist.find((d) => typeof d.note === "string" && !(d.text ?? d.word ?? d.line));
      dialogueClock = {
        placements,
        ...(noteEntry ? { note: String(noteEntry.note).slice(0, 240) } : {}),
      };
      receipt.push(`dialogueClock ← ${Array.isArray(a.dialogue) ? "dialogue[]" : "dialogue_plan[]"}（text→word；note 條目升 dialogueClock.note，${placements.length} 落點）`);
    }
  }

  const capabilityGaps = Array.isArray(a.capabilityGaps) ? a.capabilityGaps
    : Array.isArray(a.capability_gaps) ? (receipt.push("capabilityGaps ← capability_gaps"), a.capability_gaps)
    : [];
  const vision = a.vision;
  const treatment = typeof a.treatment === "string" ? a.treatment : typeof a.treatment_md === "string" ? (receipt.push("treatment ← treatment_md"), a.treatment_md) : "";
  // §19：撤字數質素 verdict——非空/缺席先 miss，完整性歸責任席
  if (!vision) misses.push("vision 缺席——回導演補");

  const parsed = DirectorPlanSchema.safeParse({
    ...(title ? { title } : {}),
    ...(typeof a.thinking === "string" ? { thinking: a.thinking } : {}),
    ...(spec ? { spec } : {}),
    ...(vision ? { vision } : { vision: "" }),
    ...(treatment ? { treatment } : { treatment: "" }),
    ...(dialogueClock ? { dialogueClock } : {}),
    ...(rhythmMap.length ? { rhythmMap } : { rhythmMap: [{ beatId: "B00", label: "MISSING", startSec: 0, endSec: 0 }] }),
    ...(shots.length ? { shots } : {}),
    ...(typeof a.soundDesignNote === "string" ? { soundDesignNote: a.soundDesignNote } : {}),
    ...(typeof a.rhythmNote === "string" ? { rhythmNote: a.rhythmNote } : {}),
    ...(a.briefCompliance && typeof a.briefCompliance === "object" ? { briefCompliance: a.briefCompliance as Record<string, string> } : {}),
    capabilityGaps,
    ...(Array.isArray(a.assumptions) ? { assumptions: a.assumptions } : {}),
    ...(Array.isArray(a.core_ideas ?? a.coreIdeas) ? { coreIdeas: (a.core_ideas ?? a.coreIdeas) as unknown[] } : {}),
    ...(a.director_choices !== undefined || a.directorChoices !== undefined ? { directorChoices: a.director_choices ?? a.directorChoices } : {}),
    ...(a.duration_check !== undefined ? { durationCheck: a.duration_check } : {}),
    ...(a.flow ? { flow: a.flow } : a.brief_intake ? { flow: { kind: (a.flow as Record<string, unknown>)?.kind ? String((a.flow as Record<string, unknown>).kind) : "（由 brief_intake 推）", briefReading: a.brief_intake } } : {}),
  });
  if (!parsed.success) {
    // 機器閘錯誤原文入 misses（fail-loud 一樣，但訊息同 seats 缺語義並排可讀，
    // 唔係拋 zod stack）——時間缺席類 miss 喺上面已經有人話你知真因
    for (const iss of parsed.error.issues.slice(0, 6)) {
      misses.push(`canonical 閘 ${iss.path.join(".")}: ${iss.message}`);
    }
  }
  // parse 失敗：misses 已列真因，runDirector 會 throw——placeholder 唔使過閘
  const plan = (parsed.success ? parsed.data : {
    vision: "（parse 失敗——misses 已列真因）",
    treatment: "（parse 失敗——misses 已列真因）",
    flow: "故事",
    rhythmMap: [{ beatId: "B00", label: "PLACEHOLDER", startSec: 0, endSec: 1 }],
    shots: [{ shotId: "SH00", beatId: "B00", startSec: 0, endSec: 1, purpose: "PLACEHOLDER" }],
    capabilityGaps: [],
  }) as DirectorPlan;
  return { plan, receipt, misses };
}

/** 短 brief → {intent, treatment, director plan}。seat 層用寬鬆 schema（形狀
 *  唔觸發重試——形狀摩擦由 compiler 等價映射消化）；canonical 閘（時間軸／
 *  覆蓋／總長）由 compiler 後 parse 把關。miss＝真缺語義，fail-loud 列明。 */
/** 對白訊號（revise 觸發）：播出計數真源＝script_md 正文（表演描述引號提取），
 *  長短不限——字數閾值係魔術數字（C 統籌 0927：一句可以好長、可跨鏡、同字
 *  可以講多次）。§23 C 修正reader說法：現行只有呢一個消耗渠道；舊註釋講嘅
 *  ①segments[].dialogueAdded／②dialogue_verbatim_kept 係聲明欄，早已 void
 *  唔入消耗池（v2 雙計事故）——聲明驗證走 declaredDialogueOf／verbatim watch
 *  另路，唔係本函數渠道。唔去重：同一句講兩次＝兩個聲音事件（計數語義喺
 *  unplacedDialogueOf 共享消耗核心）。 */
export type DialogueSignal = { line: string; source: "dialogueAdded" | "verbatimKept" | "quotedMd" };

export function dialogueSignalsOf(script: {
  script_md?: string;
  dialogue_verbatim_kept?: string[];
  segments?: { dialogueAdded?: string }[];
}): DialogueSignal[] {
  // 渠道分工（v2 實證雙計事故修正）：dialogueAdded／verbatimKept 係「聲明欄」
  // ——模型用佢報「呢句係指定/新增台詞」（連同 meta 說明文字），唔係「呢段
  // 演出邊句」；成句入訊號會搶消耗正文真講嘅 placement（『夠喇。』屬導演
  // treatment 指定台詞——實證將正文真講擠成 unplaced）。所以：
  // 播出計數真源＝script_md 正文（表演描述）；聲明欄淨做觸發提示
  // （declaredDialogueOf），唔入消耗池。
  const out: DialogueSignal[] = [];
  void script.segments;
  void script.dialogue_verbatim_kept;
  if (typeof script.script_md === "string") {
    const re = /[「『“]([^」』”]+)[」』”]/g;
    for (const m of script.script_md.matchAll(re)) {
      const line = (m[1] ?? "").trim();
      if (!line) continue;
      // 欄位語義細分（來源真源＝compilePlaywrightScript 組裝格式）：引號前文
      // 最近欄位標記係「聲：／觀眾：」而唔係段標【】→ 聲音設計/觀眾效應文本
      // 入面嘅引號（擬聲『嘀』『篤』、聲效引用、觀眾欄引用），唔係台詞。
      // 殘留誤觸（表演欄形容詞『快』『慢』、自報句嵌套位置引用）＝代價一輪
      // revise（冪等收口），寧誤觸唔漏真台詞。
      const head = script.script_md.slice(Math.max(0, m.index - 60), m.index);
      const soundAt = Math.max(head.lastIndexOf("聲："), head.lastIndexOf("聲:"), head.lastIndexOf("觀眾："), head.lastIndexOf("觀眾:"), head.lastIndexOf("｜聲"));
      // 自報括號段（「（新台詞：…逐字保留喺「…」嘅原位…）」）入面嘅引用＝
      // 對台詞/位置嘅meta引用，唔係另一次演出——唔入訊號、唔另扣落點。
      const selfAt = Math.max(head.lastIndexOf("新台詞"), head.lastIndexOf("逐字保留"));
      const segAt = head.lastIndexOf("【");
      if (soundAt > segAt || selfAt > segAt) continue;
      out.push({ line, source: "quotedMd" });
    }
  }
  return out;
}

/** 聲明欄提取（dialogueAdded／verbatimKept）：否定聲明（「無台詞。」）走；
 *  聲明句內嘅引號台詞抽出（『夠喇。』屬…指定台詞→「夠喇。」）。用途＝
 *  revise 觸發提示（有明報新/指定台詞就要落點），唔入 unplaced 消耗池。 */
export function declaredDialogueOf(script: {
  dialogue_verbatim_kept?: string[];
  segments?: { dialogueAdded?: string }[];
}): string[] {
  const NEGATED_RE = /^(無|冇|沒有|没有)\s*(台詞|對白|新台詞|新增台詞|new lines?)/;
  const QUOTE_RE = /[「『“]([^」』”]+)[」』”]/g;
  const raw = [
    ...(script.dialogue_verbatim_kept ?? []).map(String),
    ...(script.segments ?? []).map((seg) => String(seg.dialogueAdded ?? "")).filter(Boolean),
  ];
  const out: string[] = [];
  for (const text of raw) {
    const t = text.trim();
    if (!t || NEGATED_RE.test(t)) continue;
    const quoted = [...t.matchAll(QUOTE_RE)].map((m) => (m[1] ?? "").trim()).filter(Boolean);
    out.push(...(quoted.length ? quoted : [t]));
  }
  return [...new Set(out)];
}

/** §23 C：共享 normalizer——author（unplaced/declared/verbatim）同 world
 *  （audioTimelineRows placement 對照）同一套歸一化。空歸一化文本一律長度 0，
 *  消耗側明確拒（includes("")）永遠 true 嘅假過閘。 */
export const normDialogue = (x: string) => x.replace(/[。．，,、！!？?…；;\s「」『』“”"']/g, "");

/** §23 C：消耗式 matcher 核心——兩階段 adapter（純文字消耗／聲畫帶時間）共用。
 * 規則：同句多次各自配對（pool 淨一份）；一個 placement 唔可重用（claim 即
 * splice）；空歸一化唔過閘（norm 長度 0 嘅 word 唔入 pool，直接搵唔到）。
 * 雙向包含：「凍。」對「凍」✓；長句 placement 對部分提取✓。 */
export function claimPlacementOnce(
  pool: { word: string }[],
  line: string,
): number {
  const n = normDialogue(line);
  if (n.length === 0) return -1;
  return pool.findIndex((p) => {
    const w = normDialogue(p.word);
    if (w.length === 0) return false;
    return n.includes(w) || w.includes(n);
  });
}

/** 有落點＝任何 placement 嘅歸一化文本同本句互相包含（「凍。」對「凍」✓；
 *  長句 placement 對部分提取✓）。同字多次講＝事件計數：本句出現次數多過
 *  對得上嘅 placement 總數，多出嚟嗰啲算 unplaced（第二次講要有第二個落點）。 */
/** timeEstimate → [t0,t1] 秒。「18–22s（估計）」→[18,22]；「約3s」→[3,3]；
 *  冇數字（schema 已擋）→ null。 */
export function parseTimeEstimate(te: string): [number, number] | null {
  const nums = [...te.matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
  if (nums.length === 0) return null;
  return [nums[0]!, nums.length > 1 ? nums[nums.length - 1]! : nums[0]!];
}

/** 編劇版 vs 導演鏡表分歧（revise 觸發嘅非對白渠道——C 統籌 0927 指正：
 *  敲檯呢類動作/接觸/時間改動都要令鏡表失效，唔可以淨靠對白差集）：
 *  - timeGaps：段時間窗喺導演鏡軸搵唔到 ≥50% 重疊嘅鏡（時間改動／空洞）
 *  - actionNews：段內動作動詞（VISIBLE_ACTION_VERBS 語義詞表）喺對應鏡
 *    （action/purpose/frame 文本）缺席＝新動作事件
 *  - contactNews：產品名（plan.spec.product 及其名詞尾段）喺段內出現而
 *    對應鏡缺席＝新接觸。全部可追溯來源，唔用字數閾值。 */
export function planDivergence(
  script: { segments?: { timeEstimate?: string; performance?: string }[] },
  plan: {
    shots?: { startSec?: number; endSec?: number; action?: string; purpose?: string; frame?: string }[];
    spec?: { product?: string };
  },
): { timeGaps: string[]; actionNews: string[]; contactNews: string[] } {
  const axis = (plan.shots ?? []).filter((sh) => typeof sh.startSec === "number" && typeof sh.endSec === "number") as { startSec: number; endSec: number; action?: string; purpose?: string; frame?: string }[];
  const timeGaps: string[] = [];
  const actionNews: string[] = [];
  const contactNews: string[] = [];
  const product = (plan.spec?.product ?? "").trim();
  // 接觸鍵＝產品全名＋名詞尾段＋**容器字語義類**（樽瓶罐杯壺盒——propNounClass
  // 同精神：產品係咩容器，接觸就用呢個字追；唔係字數閾值）。「綠色玻璃樽
  // 檸檬汽水」→ 樽／汽水／全名三鍵。
  const CONTAINER_CHARS = "樽瓶罐杯壺盒";
  const productKeys = product
    ? [...new Set([product, product.slice(-2), ...[...CONTAINER_CHARS].filter((c) => product.includes(c))])].filter((k) => k.length >= 1 && k !== product || k === product)
    : [];
  for (const [i, seg] of (script.segments ?? []).entries()) {
    const window = seg.timeEstimate ? parseTimeEstimate(seg.timeEstimate) : null;
    const perf = seg.performance ?? "";
    if (!window || !perf) continue;
    const [t0, t1] = window;
    const len = Math.max(0.01, t1 - t0);
    // §23 B：時間覆蓋按採用區間與全部相關鏡聯合判定（merge intervals），
    // 唔以單鏡最大重疊逼一段一鏡——合法一段跨數鏡。
    const overlapped = axis
      .map((sh) => ({ sh, s: Math.max(t0, sh.startSec), e: Math.min(t1, sh.endSec) }))
      .filter((x) => x.e > x.s)
      .sort((a, b) => a.s - b.s);
    let covered = 0;
    let curS = Number.NEGATIVE_INFINITY;
    let curE = Number.NEGATIVE_INFINITY;
    for (const w of overlapped) {
      if (w.s > curE) {
        if (curE > curS) covered += curE - curS;
        curS = w.s; curE = w.e;
      } else if (w.e > curE) curE = w.e;
    }
    if (curE > curS) covered += curE - curS;
    if (overlapped.length === 0 || covered < len * 0.5) {
      timeGaps.push(`第${i + 1}段 ${seg.timeEstimate} 冇對應導演鏡（相關鏡聯合覆蓋 ${covered.toFixed(1)}s / 段長 ${len.toFixed(1)}s）`);
      continue;
    }
    // §23 B：動作/接觸差集對全部相關鏡文本（唔淨最大重疊嗰個）——同屬啟發式
    // 診斷，交導演逐項裁（同義動作／聽者鏡可以覆蓋＝誤報要理由）。
    const allLensText = overlapped
      .map((w) => [w.sh.action, w.sh.purpose, w.sh.frame].filter(Boolean).join(" "))
      .filter(Boolean).join(" ");
    // 差集全記（唔揀第一個就 break——「手指敲」揀中「指」會漏「敲」）。char 級
    // 詞表粒度：複詞切片（手指→指）都會入差集——呢啲係「段有鏡冇」嘅表演
    // 細節訊號，觸發 revise 冪等一輪，寧多一輪唔漏事件（C 統籌語義）。
    const newVerbs = [...VISIBLE_ACTION_VERBS].filter((v) => perf.includes(v) && !allLensText.includes(v));
    if (newVerbs.length) {
      actionNews.push(`第${i + 1}段（${seg.timeEstimate}）新動作差集：${[...new Set(newVerbs)].join("、")}`);
    }
    for (const key of productKeys) {
      if (perf.includes(key) && !allLensText.includes(key)) {
        contactNews.push(`第${i + 1}段（${seg.timeEstimate}）產品接觸「${key}」——相關鏡文本缺席`);
        break;
      }
    }
  }
  return { timeGaps, actionNews, contactNews };
}

/** PROVENANCE_0927 第4點後半：實際音軌時長回填（共同時間線）——事件層
 *  rows：take 實長 vs 窗口。短過＝bed 照墊；長過＝逐鏡切片截尾（overflow
 *  警告，唔靜靜食）。唔改窗口——窗口＝callsheet，改佢係修訂輪嘅事。 */
export type AudioTimelineRow = {
  beatId: string;
  /** G1 批二（0928）：per-utterance 主 key（beat.utteranceIds 引用鏈行
   *  per-utterance 事件路時帶；legacy 字串路無） */
  utteranceId?: string;
  speaker?: string;
  text: string;
  window: { startSec: number; endSec: number; sec: number };
  actualTakeSec: number | null;
  overflowSec?: number;
  warning?: string;
  underSec?: number;
  note?: string;
  /** 裁決 0928 D：聲畫對位收據——matched（含 onImage/偏離）或 missing */
  placement?: "matched" | "missing" | "na" | "unresolved";
  onImage?: string;
  placementDriftSec?: number;
  /** §7①：實際播出鏡（audioBeats 對照）——剪接區間收據 */
  coveredByShotIds?: string[];
  /** §8.1：onImage 對照收據——導演指定詞 vs 實際播出鏡文字（詞級 hit 紀錄） */
  onImageCheck?: { word: string; seenInCoverShots: boolean }[];
};

/** G1 批四（0928）：凍結映射檔形狀——author 採納輪 resolver 一處配對，
 *  兩側（author 診斷/world 對照）同結果讀用；帶 digest 驗依賴（resume 讀檔
 *  重驗，唔靠記憶體 ctx；輸入唔夾＝stale）。唔建持久 pool／全局 used 旗標
 *  ——凍結映射＝採納快照，唔係可變 pool。 */
export type UtterancePlacementMap = {
  utterancesDigest: string;
  callsheetDigest: string;
  revision: string;
  generatedAt: string;
  pairs: { utteranceId: string; placementIdx: number; norm: string }[];
  unmatchedUtterances: { utteranceId: string; rawText: string }[];
  unmatchedPlacements: number[];
  ambiguous: { norm: string; utteranceIds: string[]; placementIdxs: number[] }[];
};

/** G1 批四：純函數 resolver——utteranceId↔placementIdx 配對（normDialogue
 *  同一套歸一化）。同字歧義（同 norm 多 utterance或多 placement）＝具名
 *  ambiguous 唔亂配（唔靠遍歷順序）；配唔到＝unmatched 具名。legacy 文字
 *  matcher 只產生候選/歧義診斷，唔繞過 typed 配對。 */
export function resolveUtterancePlacements(
  utterances: { utteranceId: string; rawText: string }[],
  placements: { word?: string; startSec?: number; endSec?: number; onImage?: string }[],
): { pairs: { utteranceId: string; placementIdx: number; norm: string }[]; unmatchedUtterances: { utteranceId: string; rawText: string }[]; unmatchedPlacements: number[]; ambiguous: { norm: string; utteranceIds: string[]; placementIdxs: number[] }[] } {
  const uttByNorm = new Map<string, string[]>();
  for (const u of utterances) {
    const n = normDialogue(u.rawText);
    uttByNorm.set(n, [...(uttByNorm.get(n) ?? []), u.utteranceId]);
  }
  const plByNorm = new Map<string, number[]>();
  placements.forEach((pl, i) => {
    const n = normDialogue(String(pl.word ?? ""));
    if (!n.length) return; // 空歸一化唔過閘（claimPlacementOnce 同款）
    plByNorm.set(n, [...(plByNorm.get(n) ?? []), i]);
  });
  const pairs: { utteranceId: string; placementIdx: number; norm: string }[] = [];
  const unmatchedUtterances: { utteranceId: string; rawText: string }[] = [];
  const unmatchedPlacements: number[] = [];
  const ambiguous: { norm: string; utteranceIds: string[]; placementIdxs: number[] }[] = [];
  const usedUtts = new Set<string>();
  const usedPls = new Set<number>();
  for (const [norm, uids] of uttByNorm) {
    const pidxs = plByNorm.get(norm) ?? [];
    if (uids.length > 1 || pidxs.length > 1) {
      if (uids.length === pidxs.length) {
        // 同數多對多：序配（同一 norm 嘅重複句按出現序一對一——norm 內次序
        // 由 caller 清單序定，唔靠遍歷意外）——仍然記 ambiguous 供審
        uids.forEach((uid, k) => { pairs.push({ utteranceId: uid, placementIdx: pidxs[k]!, norm }); usedUtts.add(uid); usedPls.add(pidxs[k]!); });
      }
      ambiguous.push({ norm, utteranceIds: uids, placementIdxs: pidxs });
      if (uids.length === pidxs.length) continue;
    }
    if (uids.length === 1 && pidxs.length === 1) {
      pairs.push({ utteranceId: uids[0]!, placementIdx: pidxs[0]!, norm });
      usedUtts.add(uids[0]!); usedPls.add(pidxs[0]!);
    }
  }
  for (const u of utterances) if (!usedUtts.has(u.utteranceId)) unmatchedUtterances.push(u);
  placements.forEach((_, i) => { if (!usedPls.has(i)) unmatchedPlacements.push(i); });
  return { pairs, unmatchedUtterances, unmatchedPlacements, ambiguous };
}

export async function audioTimelineRows(
  events: { beatId: string; utteranceId?: string; speaker?: string; text: string; startSec: number; endSec: number }[],
  takes: { beatId: string; file: string }[],
  wavSecOf: (file: string) => Promise<number>,
  /** 裁決 0928 D（SEAT-AUDIT-DECISION §3）：導演 dialogueClock placements
   *  （全片時間軸）——聲畫對位收據：每句 utterance 對照有冇 placement、時間
   *  偏離幾多；0→0 placeholder 唔冒充已排。缺/偏離＝note 落 row（consumer
   *  決定點處理）。 */
  placements?: { word?: string; startSec?: number; endSec?: number; onImage?: string }[],
  /** G1 批四：凍結映射（author 採納輪 resolver 結果）——typed event（有
   *  utteranceId）行 ID 直配：有映射→matched（時間/onImage 由映射 placement
   *  攞）；冇映射→missing 具名（唔落 pool 亂配）。legacy event 照 pool。 */
  frozenPairs?: Map<string, { word?: string; startSec?: number; endSec?: number; onImage?: string }>,
): Promise<AudioTimelineRow[]> {
  const rows: AudioTimelineRow[] = [];
  // §8.4＋§23 C：消耗式配對——共享 claimPlacementOnce 核心（author/world 同一
  // 套歸一化＋消耗＋空歸一化拒）；audio adapter 保留原 placement 物件攞時間/
  // onImage。splice ≡ used flag（消耗語義同一）。
  const placementPool = (placements ?? [])
    .filter((pl) => normDialogue(String(pl.word ?? "")).length > 0)
    .map((pl) => ({ word: String(pl.word ?? ""), pl }));
  for (const ev of events) {
    const take = takes.find((t) => t.beatId === ev.beatId);
    const actual = take ? await wavSecOf(take.file).catch(() => null) : null;
    const windowSec = ev.endSec - ev.startSec;
    rows.push({
      beatId: ev.beatId,
      ...(ev.utteranceId ? { utteranceId: ev.utteranceId } : {}),
      ...(ev.speaker ? { speaker: ev.speaker } : {}),
      text: ev.text,
      window: { startSec: ev.startSec, endSec: ev.endSec, sec: Number(windowSec.toFixed(3)) },
      actualTakeSec: actual === null ? null : Number(actual.toFixed(3)),
      ...(actual !== null && actual > windowSec + 1 / 24
        ? { overflowSec: Number((actual - windowSec).toFixed(3)), warning: "take 長過窗口——逐鏡切片會截尾；加鏡／調 audioBeats／收短台詞" }
        : {}),
      ...(actual !== null && actual < windowSec - 1 / 24
        ? { underSec: Number((windowSec - actual).toFixed(3)), note: "講得快過窗口——bed 照墊" }
        : {}),
      ...(take ? {} : { note: "take 缺（事件冇鏡覆蓋？plugVoiceEvents 應已 throw）" }),
      ...(placements === undefined && !events.some((e2) => e2.text.trim())
        ? { placement: "na" as const, note: "片冇對白且導演冇交 dialogueClock（流程唔要求落點＝N/A）" }
        : frozenPairs && ev.utteranceId
          ? (() => {
              // G1 批四 typed 路：凍結映射 ID 直配（唔經 pool——同字歧義已喺
              // author 採納輪 resolver 裁定）；冇映射＝missing 具名
              const hit = frozenPairs.get(ev.utteranceId);
              if (!hit) return { placement: "missing" as const, note: "凍結映射冇呢個 utterance（author 採納輪未配到——回責任席）" };
              if ((hit.endSec ?? 0) <= (hit.startSec ?? 0) + 1e-9) {
                return { placement: "unresolved" as const, note: "落點 0→0 placeholder（導演未排時間）——唔冒充已排" };
              }
              const drift = (hit.startSec ?? 0) - ev.startSec;
              return {
                placement: "matched" as const,
                ...(hit.onImage ? { onImage: hit.onImage } : {}),
                ...(drift !== 0 ? { placementDriftSec: Number(drift.toFixed(3)) } : {}),
                ...(Math.abs(drift) > 1 ? { note: `落點偏離導演安排 ${drift.toFixed(1)}s（誤差接受度留採用方案判斷）` } : {}),
              };
            })()
          : (() => {
            const at = claimPlacementOnce(placementPool, ev.text);
            if (at < 0) return { placement: "missing" as const, note: "導演冇呢句嘅落點（聲畫對位缺口——回導演席）" };
            const hit = placementPool.splice(at, 1)[0]!.pl;
            // §8.4：0→0 placeholder（未排時間）唔算 matched——標 unresolved
            if ((hit.endSec ?? 0) <= (hit.startSec ?? 0) + 1e-9) {
              return { placement: "unresolved" as const, note: "落點 0→0 placeholder（導演未排時間）——唔冒充已排" };
            }
            const drift = (hit.startSec ?? 0) - ev.startSec;
            return {
              placement: "matched" as const,
              ...(hit.onImage ? { onImage: hit.onImage } : {}),
              ...(drift !== 0 ? { placementDriftSec: Number(drift.toFixed(3)) } : {}),
              ...(Math.abs(drift) > 1 ? { note: `落點偏離導演安排 ${drift.toFixed(1)}s（誤差接受度留採用方案判斷）` } : {}),
            };
          })()),
    });
  }
  return rows;
}

export function unplacedDialogueOf(
  script: Parameters<typeof dialogueSignalsOf>[0],
  plan: { dialogueClock?: { placements?: { word?: string }[] } },
): DialogueSignal[] {
  const signals = dialogueSignalsOf(script).filter((sig) => normDialogue(sig.line).length > 0);
  // §23 C：改行共享消耗式核心（行為等價：消耗／雙向包含／空歸一化拒）
  const pool = (plan.dialogueClock?.placements ?? [])
    .filter((p) => normDialogue(String(p.word ?? "")).length > 0)
    .map((p) => ({ word: String(p.word ?? "") }));
  const unplaced: DialogueSignal[] = [];
  for (const sig of signals) {
    const at = claimPlacementOnce(pool, sig.line);
    if (at >= 0) pool.splice(at, 1);
    else unplaced.push(sig);
  }
  return unplaced;
}

/** §23 B：六類訊號同一 evaluate(script, adoptedPlan)——修觸發、typed hint、
 *  修後驗收三邊食同一份結果，每類有來源/範圍/嚴重度：
 *  - unplaced＋declaredMissing＝必要契約（revise 後未解唔准宣稱收口）
 *  - newElements＝變更紀錄（修完仍可合法非空；每項要採納/有據拒絕/明示未解）
 *  - timeGaps/actionNews/contactNews＝啟發式診斷（交導演逐項裁，唔機械 FAIL）
 *  declared 校正：聲明句正文 presence 有＝宣稱成立（落點由正文 unplaced 管，
 *  唔另算一次 utterance）；正文冇＝假聲明（必要契約）。不因聲明存在就觸發。 */
export type PlanScriptEvaluation = {
  unplaced: DialogueSignal[];
  declaredMissing: string[];
  newElements: { what: string; why: string }[];
  timeGaps: string[];
  actionNews: string[];
  contactNews: string[];
};

export function evaluateScriptAgainstPlan(
  script: {
    script_md?: string;
    dialogue_verbatim_kept?: string[];
    segments?: { timeEstimate?: string; performance?: string; dialogueAdded?: string }[];
    newElements?: { what: string; why: string }[];
  },
  plan: { dialogueClock?: { placements?: { word?: string }[] } } & Parameters<typeof planDivergence>[1],
): PlanScriptEvaluation {
  const unplaced = unplacedDialogueOf(script, plan);
  // §25 C：聲明驗宣稱都對實際台詞實體（dialogueSignalsOf 演出句）——唔對成個
  // script_md 計數（複合引號／說明文字會假中）；norm 雙向包含。
  const utterances = dialogueSignalsOf({ script_md: String(script.script_md ?? "") }).map((u) => u.line);
  const declaredMissing = declaredDialogueOf(script).filter((d) => {
    const w = normDialogue(d);
    return w.length === 0 || !utterances.some((line) => {
      const n = normDialogue(line);
      return n.length > 0 && (n.includes(w) || w.includes(n));
    });
  });
  const div = planDivergence(script, plan);
  return {
    unplaced,
    declaredMissing,
    newElements: (script.newElements ?? []).map((n) => ({ what: String(n.what), why: String(n.why) })),
    ...div,
  };
}

/** §23 B 分級 helper：必要契約缺口（驗收 throw 線）——unplaced＋假聲明。 */
export function contractGapsOf(ev: PlanScriptEvaluation): string[] {
  return [
    ...ev.unplaced.map((u) => `劇本句冇落點：${u.line}`),
    ...ev.declaredMissing.map((d) => `聲明台詞正文缺席（宣稱保留/新增但正文冇）：${d}`),
  ];
}

export async function runDirector(
  packet: { brief: string; targetSec?: number; aspect?: string; language?: string },
  io: { crew: CrewConfig; model: string; receiptDir: string; fallbackModel?: string; receipts?: string[] },
  /** 編劇→導演修訂迴路：編劇版加咗台詞／元素，導演食原 plan＋新劇本出
   *  修訂版（rhythmMap/shots/對白落點蓋新台詞；flow/spec 唔郁）。一輪收口，
   *  唔遞迴。三件套重寫＝manifest revision 自動遞增（SCOPE §6）。 */
  revise?: { scriptMd: string; previousPlan: unknown; hint?: string },
): Promise<DirectorPlan & { compileReceipt: string[] }> {
  const loose = z.object({}).passthrough();
  // 知識已內嵌 DIRECTOR_CHARTER（照官方 ViMax：agent prompt 一段）。
  const system = DIRECTOR_CHARTER + (revise ? `

【修訂輪（REVISE）】你之前交咗一版導演方案；編劇席照你嘅 treatment 寫咗完整劇本，加咗你鏡表未有嘅嘢。而家出修訂版：flow／spec／願景唔郁；rhythmMap／shots／dialogueClock 全部對返新劇本（新台詞要有落點，鏡表時間軸重新夾）。保留啱嘅嘢，改錯嘅嘢，唔好由零重作。` : "");
  const user = JSON.stringify(revise
    ? { ...buildCreativeEnvelope(packet.brief, packet), revise: { 原導演方案: revise.previousPlan, 新劇本原文: revise.scriptMd, ...(revise.hint ? { 上一輪被機器閘擋嘅錯: revise.hint } : {}) } }
    : buildCreativeEnvelope(packet.brief, packet));
  const pass = await chatJsonSeat<Record<string, unknown>>({
    seat: "creative",
    unit: revise ? "director-plan-revise" : "director-plan",
    system,
    user,
    schema: loose,
    crew: io.crew,
    model: io.model,
    ...(io.fallbackModel ? { fallbackModel: io.fallbackModel } : {}),
    receiptDir: io.receiptDir,
  });
  fs.writeFileSync(path.join(io.receiptDir, revise ? "creative.director-plan-revise.raw.json" : "creative.director-plan.raw.json"), JSON.stringify(pass.value, null, 2));
  let compiled = compileDirectorPlan(pass.value);
  // 判斷歸判斷＋迴路（照官方 ViMax camera-tree 範式）：canonical 閘 miss＝帶住
  // 「缺咗乜」返去同一個方案補一次，唔准編（code 唔填空），兩次都缺先 fail loud。
  // BOUP-fix（0928）：miss 清單同一真源——canonical 閘淨驗存在嘅 placements，
  // 「劇本有句但 plan 零 placement」係盲區（BOUP「甜」）；fail 閘用
  // unplacedDialogueOf 全集。revise 輪 scriptMd 在手，unplaced 全集併入
  // miss 清單——修嘅人同驗嘅人同一張單。
  const unplacedRows: string[] = revise
    ? unplacedDialogueOf({ script_md: revise.scriptMd } as Parameters<typeof dialogueSignalsOf>[0], { dialogueClock: (pass.value as { dialogueClock?: { placements?: { word?: string }[] } }).dialogueClock })
        .map((u) => `劇本句冇落點（plan 零 placement）：${u.line}`)
    : [];
  const missAll = [...compiled.misses, ...unplacedRows];
  if (missAll.length) {
    const retryUser = JSON.stringify({
      ...JSON.parse(user),
      "之前交咗嘅方案": pass.value,
      "機器閘 miss 清單": missAll,
      "補位要求": "照返你之前交嘅同一個方案，只補齊 miss 清單指明嘅欄位（欄位名照 DirectorPlan 契約：shots[] 要有 purpose 每鏡一句、startSec/endSec 數字、beats/rhythmMap、treatment、vision）。唔好由零重作，唔好改已經啱嘅嘢。",
    });
    const retryPass = await chatJsonSeat<Record<string, unknown>>({
      seat: "creative",
      unit: revise ? "director-plan-revise.gap-retry" : "director-plan.gap-retry",
      system,
      user: retryUser,
      schema: loose,
      crew: io.crew,
      model: io.model,
      ...(io.fallbackModel ? { fallbackModel: io.fallbackModel } : {}),
      receiptDir: io.receiptDir,
    });
    fs.writeFileSync(path.join(io.receiptDir, revise ? "creative.director-plan-revise.gap-retry.raw.json" : "creative.director-plan.gap-retry.raw.json"), JSON.stringify(retryPass.value, null, 2));
    const again = compileDirectorPlan(retryPass.value);
    // 分裂 A 收口（Explore 掃描 0928）：retry 後驗收同修觸發同一張單——unplaced
    // 對 retryPass.value 重跑併入 misses（之前淨驗 canonical，retry 品帶未落點
    // 句照過閘——同一病殘留半修）。
    const unplacedAfterRetry: string[] = revise
      ? unplacedDialogueOf({ script_md: revise.scriptMd } as Parameters<typeof dialogueSignalsOf>[0], { dialogueClock: (retryPass.value as { dialogueClock?: { placements?: { word?: string }[] } }).dialogueClock })
          .map((u) => `劇本句冇落點（plan 零 placement）：${u.line}`)
      : [];
    compiled = { plan: again.plan, receipt: [...compiled.receipt, ...again.receipt, `director gap-retry after ${compiled.misses.length} misses`], misses: [...again.misses, ...unplacedAfterRetry] };
  }
  const { plan, receipt, misses } = compiled;
  fs.writeFileSync(path.join(io.receiptDir, revise ? "creative.director-plan-revise.compile.json" : "creative.director-plan.compile.json"), JSON.stringify({ receipt, misses }, null, 2));
  if (misses.length) {
    throw new Error(`director_plan_missing_semantics: ${misses.join("；")}——補位迴路行咗一次都缺（收據 creative.director-plan${revise ? "-revise" : ""}.compile.json＋gap-retry raw）`);
  }
  return { ...plan, compileReceipt: receipt };
}

/** BRIEF_TO_SCRIPT_CORRECTION_0927：編劇階段——由 treatment 發展完整可演
 *  劇本。導演《而家》係創作方向；呢層交可演嘅嘢：人物當下狀態、事件發展、
 *  表演指示、聲音設計（畫外聲/環境聲/停頓）、逐段對觀眾嘅作用。台詞可擴充
 *  （brief「只准三句」零來源），三句原文逐字保留；唔強制衝突/旁白/新角色；
 *  唔靠加字數/鏡數/慢動作湊秒。時間全部標「估計」，剪輯回填。 */
export const PLAYWRIGHT_CHARTER = [
  "# 編劇席 charter — 將導演方向變成可演嘅劇本",
  "",
  "你收到：用戶 brief 逐字、導演 treatment、既有資產事實。你交：一份演員、聲音、畫面全部可以照做嘅完整劇本。",
  "",
  "你嘅工：",
  "1. 人物當下狀態同目標：佢而家點解係咁（一筆就夠，唔使前史長篇），佢想要咩。",
  "2. 事件點樣發展：由開場狀態去到收尾，每一段推進咗咩（資訊或者感受）。",
  "3. 表演指示：每一格演員做咩（身體、呼吸、眼神、手），細到可以照做。",
  "4. 聲音劇本：對白（brief 指定嘅字逐字保留，可以加新台詞但要講明係新增）、畫外聲、環境聲、停頓——聲音係結構唔係配菜。",
  "5. 每段對觀眾嘅作用：佢感受到咩、明白咗咩、點解會想繼續睇。",
  "",
  "規矩：",
  "- 服從資產事實：以 brief 同導演 treatment 列明嘅人物／產品／場景為準，唔發明新角色新產品。",
  "- 目標時長以 brief 指定為準：發展內容撐起佢，唔嚕夠秒。時間全係估計（標明），最後由音軌同剪輯回填。",
  "- 唔准用重複特寫、慢動作、加鏡數、加對白字數嚕夠秒——每一段都要有佢嘅工。",
  "- 引號（「」『』“”）內嘅字係指定台詞，逐字保留喺佢哋嘅位置，一個字都唔好改、唔好刪、唔好搬去第二個位置；引號以外嘅對白先係你嘅創作空間，加嘅嘢講明「新增」。",
  "",
  "工程欄位：segments[] 每段 {timeEstimate（例如 0-3s 標『估計』）, performance, sound, audienceEffect, dialogueAdded?, speaker?}；有對白嘅段盡量標 speaker（castRoster 內角色名；畫外聲/旁白標 VO）——講者係聲畫分工嘅一半；結構機器會對，你嘅本事花喺上面五點。",
  "",
  "台詞身份採納（utterances，機器對帳用）：正文寫完後，交 utterances[] 逐項 {utteranceId（U01 起）, rawText（逐字）, speakerId（castRoster 內名；未解決就 unresolvedSpeaker:true）, source[{candidateIdx, segment, range:{start,end}, rawText}]}——packet 會帶候選表（你正文每個引號句一個 candidateIdx＋字元區間）；每個候選要麼採納為 utterance（source 指返佢個 idx＋range），要麼交 quoteRulings[{candidateIdx, kind:'non-performance', reason}]（旁述／物件文字／聲效／台詞清單引用）。一句分多段嚟源＝同一 utterance 多個 source；複合引號（例如「凍、甜、而家」）係一句定三次定清單，由你判——拆開就每項帶 splitOf{parentCandidateIdx, fragmentIndex, parentRange}。無引號嘅演出句（旁白）都可以自報 source range。漏咗候選未裁定＝機器閘會列明返你補。",
].join("\n");

const playwrightSegment = z.object({
  timeEstimate: z.string().min(1),
  performance: z.string().min(1),
  sound: z.string().optional(),
  audienceEffect: z.string().optional(),
  /** 新台詞明報原文：完整保留（dialogueSignalsOf 最強來源渠道）；冇字數閘。 */
  dialogueAdded: z.string().min(1).optional(),
  /** 裁決 0928 B（SEAT-AUDIT-DECISION §3）：講者綁定——有對白嘅段標主要
   *  講者（castRoster 內名）；畫外聲/旁白標 "VO"。等價 compiler 透傳落
   *  beats 參考；真源 speaker 閘仍喺阿文 beats（dialogue⇔speaker 成對）。 */
  speaker: z.string().min(1).max(24).optional(),
});

export const PlaywrightScriptSchema = z.object({
  title: z.string().optional(),
  thinking: z.string().optional(),
  characterState: z.string().min(1),
  characterGoal: z.string().min(4).max(300).optional(),
  /** 劇本正文：monolith（模型直接交）或由 segments 組裝（全原文） */
  script_md: z.string().min(1),
  // §19：撤 3–20 上下固定數——有完整內容 1 段都得；缺內容（零段/全空）由
  // compiler miss fail（唔以佔位正文當成功）。
  segments: z.array(playwrightSegment),
  dialogue_verbatim_kept: z.array(z.string()),
  /** §28 G1 批一：typed 採納（utteranceId/rawText/speaker/source range——
   *  shape 由 reconcileUtterances 逐項驗，zod 淨保陣列形）＋非演出裁定 */
  utterances: z.array(z.unknown()).optional(),
  quoteRulings: z.array(z.unknown()).optional(),
  newElements: z.array(z.object({ what: z.string().max(80), why: z.string().max(160) })).default([]),
  /** 導演內容欄（等價映射保留原名） */
  arc: z.string().optional(),
  dialoguePolicy: z.string().optional(),
  soundDesignMasterNotes: z.string().optional(),
}).superRefine((s, report) => {
  for (const [i, seg] of s.segments.entries()) {
    if (!/\d/.test(seg.timeEstimate)) {
      report.addIssue({ code: "custom", path: ["segments", i, "timeEstimate"], message: "時間要標明係估計（例如「約3s（估計）」）" });
    }
  }
});

export type PlaywrightScript = z.infer<typeof PlaywrightScriptSchema>;

// ════ §28/§30/§31 G1 批一（0928）：typed utterance 身份鏈 ════
// 舊 designatedLinesOf（brief 引號∩plan placement 交集）＝§26 否決方式，
// §30-1 令退役——鎖義務改 user/task 採用契約（packet.dialogueLocks）。

/** 字元半開區間 [start, end)——sourceRef 精確定位單位（§30-2） */
export type UtteranceRange = { start: number; end: number };

/** 候選引用：candidateIdx 綁 frozen mdSha＋extractor 版本，完整候選集生成
 *  時固定編號（唔 filter 先再編）；range/rawText 核對由 compiler 做。 */
export type CandidateRef = {
  candidateIdx: number;
  segment: number;
  range: UtteranceRange;
  rawText: string;
};

/** 採納後嘅實際發聲身份。occurrence＝一次實際發聲（唔係字串計數/placement
 *  slot 數/beat 數）。source 可多片段（連續一句分多來源仍同一 utterance，
 *  唔多生 take——§30-4）；splitOf 記複合拆出（parent＋有序片段，唔係子串
 *  includes 假過）。speaker 用聲音 roster 穩定 ID；UNRESOLVED＝狀態唔冒充
 *  角色名（§30-6）。 */
export type TypedUtterance = {
  utteranceId: string;
  rawText: string;
  speakerId?: string;
  unresolvedSpeaker?: true;
  source: CandidateRef[];
  splitOf?: { parentCandidateIdx: number; fragmentIndex: number; parentRange: UtteranceRange };
};

/** 非演出裁定：只分類候選來源（§30-3），唔豁免已有鎖義務（§30-1）。 */
export type QuoteRuling = { candidateIdx: number; kind: "non-performance"; reason: string };

/** 候選集（compiler 對實際 bytes 構造——mdSha 唔信模型自算，§30-2）。
 *  完整候選＝全部引號句＋無引號演出段由模型 typed 自報（sourceRef 唔限引號，
 *  §30-3）；舊 dialogueSignalsOf 啟發式排除改為 skipped 具名可追查。 */
export type UtteranceCandidates = {
  mdSha: string;
  extractorVersion: string;
  candidates: { candidateIdx: number; segment: number; range: UtteranceRange; rawText: string }[];
  skipped: { range: UtteranceRange; reason: string }[];
};

export const UTTERANCE_EXTRACTOR_VERSION = "g1-candidates-v1";

/** user/task 採用鎖（§30-1）：caller 明示——原始來源＋全文/詞級範圍＋義務
 *  身份驗收；plan 漏項＝缺口唔解鎖；無鎖合法（[]）。 */
export type DialogueLock = { rawText: string; scope: "full-line" | "word-level"; source: string };

/** 候選提取：全部引號句入 candidates（完整集順序編號，固定）；舊啟發式
 *  （聲：欄／自報段）唔再靜靚排除——變 skipped 具名 reason。 */
export function generateUtteranceCandidates(scriptMd: string): UtteranceCandidates {
  const mdSha = createHash("sha256").update(scriptMd, "utf8").digest("hex").slice(0, 16);
  const candidates: UtteranceCandidates["candidates"] = [];
  const skipped: UtteranceCandidates["skipped"] = [];
  // 分段序＝【…】段標順（冇段標＝0）
  const segOf = (idx: number): number => {
    const head = scriptMd.slice(0, idx);
    const marks = [...head.matchAll(/【/g)];
    return marks.length;
  };
  const re = /[「『“]([^」』”]+)[」』”]/g;
  for (const m of scriptMd.matchAll(re)) {
    const inner = m[1] ?? "";
    const range = { start: m.index + (m[0]!.length - inner.length - 1), end: m.index + m[0]!.length - 1 };
    const head = scriptMd.slice(Math.max(0, m.index - 60), m.index);
    const segAt = head.lastIndexOf("【");
    const soundAt = Math.max(head.lastIndexOf("聲："), head.lastIndexOf("聲:"), head.lastIndexOf("觀眾："), head.lastIndexOf("觀眾:"));
    if (soundAt > segAt) {
      skipped.push({ range, reason: "聲音設計/觀眾效應欄位內引號（非演出台詞候選——如屬演出請模型 typed 自報非引號 source）" });
      continue;
    }
    candidates.push({ candidateIdx: candidates.length, segment: segOf(m.index), range, rawText: scriptMd.slice(range.start + 1, range.end) });
  }
  return { mdSha, extractorVersion: UTTERANCE_EXTRACTOR_VERSION, candidates, skipped };
}

/** 雙向對帳（§28-3＋§30）：typed↔正文候選＋鎖義務。miss 入既有 compiler
 *  misses/gap-retry 同一預算（§30-5 帶 frozen 候選表返補位）。 */
export function reconcileUtterances(
  scriptMd: string,
  typed: TypedUtterance[] | undefined,
  rulings: QuoteRuling[] | undefined,
  locks: DialogueLock[] | undefined,
): { issues: string[]; candidates: UtteranceCandidates } {
  const issues: string[] = [];
  const candidates = generateUtteranceCandidates(scriptMd);
  const byIdx = new Map(candidates.candidates.map((c) => [c.candidateIdx, c]));
  // 新式 required 分界由採納契約決定（§30-6）：caller 帶 locks（採用契約要求
  // typed）時，缺 utterances＝missing 唔自動退 legacy。
  if (locks?.length && !typed?.length) {
    issues.push(`採用契約要求 typed utterances（${locks.length} 鎖在身）但模型冇交 utterances——missing，唔自動退 legacy`);
  }
  const adopted = new Set<number>();
  for (const [i, u] of (typed ?? []).entries()) {
    if (!u.utteranceId) issues.push(`utterances[${i}] 冇 utteranceId`);
    if (!u.speakerId && !u.unresolvedSpeaker) issues.push(`utterances[${i}] ${u.utteranceId ?? "?"} 冇 speaker（speakerId 或 unresolvedSpeaker 二揀一）`);
    if (u.unresolvedSpeaker) issues.push(`utterances[${i}] ${u.utteranceId ?? "?"} speaker UNRESOLVED——狀態具名，回責任席（唔入 TTS）`);
    for (const ref of u.source ?? []) {
      const c = byIdx.get(ref.candidateIdx);
      if (!c) { issues.push(`utterances[${i}] ${u.utteranceId ?? "?"} source candidateIdx=${ref.candidateIdx} 唔喺候選集（本版 ${candidates.candidates.length} 個——舊版候選表配新正文＝失效）`); continue; }
      adopted.add(ref.candidateIdx);
      if (c.rawText !== ref.rawText) issues.push(`utterances[${i}] ${u.utteranceId ?? "?"} source rawText 同候選 #${ref.candidateIdx} 唔符（核對精確 range，唔用 includes 假過）`);
    }
    if (u.splitOf) {
      const parent = byIdx.get(u.splitOf.parentCandidateIdx);
      if (!parent) issues.push(`utterances[${i}] ${u.utteranceId ?? "?"} splitOf parent #${u.splitOf.parentCandidateIdx} 唔喺候選集`);
      else adopted.add(u.splitOf.parentCandidateIdx);
    }
    if (!u.source?.length && !u.splitOf) issues.push(`utterances[${i}] ${u.utteranceId ?? "?"} 冇 source（非引號演出段要自報 sourceRef range）`);
  }
  for (const r of rulings ?? []) adopted.add(r.candidateIdx);
  for (const c of candidates.candidates) {
    if (!adopted.has(c.candidateIdx)) issues.push(`候選 #${c.candidateIdx}（段${c.segment}「${c.rawText.slice(0, 24)}」）未裁定——要採納為 utterance 或 quoteRulings 具名非演出`);
  }
  // 鎖義務：rawText 精確（full-line）／詞級範圍（word-level＝鎖詞喺某 utterance
  // rawText 內逐字存在）——plan 漏鎖唔解鎖（§30-1）
  for (const lock of locks ?? []) {
    const ok = lock.scope === "full-line"
      ? (typed ?? []).some((u) => u.rawText === lock.rawText)
      : (typed ?? []).some((u) => u.rawText.includes(lock.rawText));
    if (!ok) issues.push(`鎖「${lock.rawText.slice(0, 24)}」（${lock.scope}，來源 ${lock.source}）冇採納 utterance 逐字對上——plan 漏鎖＝缺口，唔解鎖`);
  }
  return { issues, candidates };
}

/** 編劇 compiler（同導演 compiler 精神：命名等價、內容零改寫、缺語義先報）。
 *  §28/§30 G1 批一：typed utterances＋quoteRulings（模型採納）對正文候選集
 *  雙向對賬；dialogueLocks（user/task 採用契約）驗鎖義務——plan 漏鎖＝缺口
 *  唔解鎖。缺口入 misses 行既有 gap-retry 同一有界預算（retry 帶 frozen 候選
 *  表返補採納——§30-5），唔另開迴路。 */
export function compilePlaywrightScript(
  raw: unknown,
  opts?: { dialogueLocks?: DialogueLock[] },
): { script: PlaywrightScript; receipt: string[]; misses: string[]; candidates?: UtteranceCandidates } {
  const receipt: string[] = [];
  const misses: string[] = [];
  let candidatesOut: UtteranceCandidates | undefined;
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const a = (src.answer && typeof src.answer === "object" ? src.answer : src) as Record<string, unknown>;
  if (a !== src) receipt.push("unwrap: answer → 頂層");
  const pick = (...keys: string[]): unknown => { for (const k of keys) if (a[k] !== undefined) return a[k]; return undefined; };
  const scriptMd = pick("script_md", "script", "screenplay", "fullScript");
  const charState = pick("characterState", "character_state", "characterNow", "whoIsHeNow", "character", "characterStateAndGoal");
  if (typeof charState === "string" && !a.characterState && !a.character_state) receipt.push("characterState ← characterStateAndGoal（原文）");
  const segsRaw = pick("segments", "beats", "acts") as unknown;
  if (typeof charState !== "string") misses.push("人物當下狀態（characterState）缺席——回編劇補");
  if (!Array.isArray(segsRaw) || segsRaw.length < 1) misses.push("segments（逐段表演/聲音/作用）完全冇——回編劇補");
  const segments = (Array.isArray(segsRaw) ? segsRaw : []).map((sRaw) => {
    const s = (sRaw && typeof sRaw === "object" ? sRaw : {}) as Record<string, unknown>;
    return {
      timeEstimate: String(s.timeEstimate ?? s.time ?? s.window ?? ""),
      performance: String(s.performance ?? s.action ?? s.whatHappens ?? s.beat ?? s.note ?? ""),
      ...(typeof (s.sound ?? s.audio) === "string" ? { sound: String(s.sound ?? s.audio) } : {}),
      ...(typeof (s.audienceEffect ?? s.audience ?? s.effect) === "string" ? { audienceEffect: String(s.audienceEffect ?? s.audience ?? s.effect) } : {}),
      ...(typeof (s.dialogueAdded ?? s.newDialogue) === "string" ? { dialogueAdded: String(s.dialogueAdded ?? s.newDialogue) } : {}),
      ...(typeof (s.speaker ?? s.speakerId) === "string" ? { speaker: String(s.speaker ?? s.speakerId) } : {}),
    };
  });
  const verbatim = pick("dialogue_verbatim_kept", "dialogueVerbatim", "keptVerbatim");
  if (!Array.isArray(verbatim)) receipt.push("dialogue_verbatim_kept：模型冇報——記空陣列，唔捏造逐字保留清單");
  // 分佈式劇本等價：模型將劇本寫喺 segments／arc／soundDesign 入面——由原文
  // 組裝 script_md（淨加結構標題，零內容改寫），收據註明。真係兩樣都冇先報 miss。
  let scriptMdFinal = typeof scriptMd === "string" ? scriptMd : "";
  if (!scriptMdFinal && segments.length >= 1) {
    const titleStr = typeof pick("title", "meta") === "string" ? String(pick("title", "meta")) : "";
    const arcStr = typeof pick("arc", "storyArc") === "string" ? String(pick("arc", "storyArc")) : "";
    const sdStr = typeof pick("soundDesignMasterNotes", "soundDesign") === "string" ? String(pick("soundDesignMasterNotes", "soundDesign")) : "";
    scriptMdFinal = [
      titleStr ? `# ${titleStr}` : "",
      `## 人物當下（${typeof charState === "string" ? charState : ""}）`,
      arcStr ? `## 弧線\n${arcStr}` : "",
      "## 分段（時間全係估計，剪輯回填）",
      ...segments.map((s, i) => `- 【${s.timeEstimate}】第${i + 1}段：${s.performance}${s.dialogueAdded ? `（新台詞：${s.dialogueAdded}）` : ""}${s.sound ? ` 聲：${s.sound}` : ""}${s.audienceEffect ? ` 觀眾：${s.audienceEffect}` : ""}`),
      sdStr ? `## 聲音總綱\n${sdStr}` : "",
    ].filter(Boolean).join("\n\n");
    receipt.push("script_md ← 由 segments/arc/soundDesignMasterNotes 組裝（全部原文，淨加結構標題）");
  }
  // §28/§30 G1 批一：typed utterances 雙向對賬（候選集由 compiler 對實際
  // bytes 構造——mdSha 唔信模型自算；候選/裁定/鎖義務缺口全部入 misses 行
  // 既有 gap-retry；caller 可帶候選表入 retry packet 俾模型補採納）。
  const typedRaw = pick("utterances", "typedUtterances") as unknown;
  const rulingsRaw = pick("quoteRulings", "quote_rulings") as unknown;
  const typed = Array.isArray(typedRaw) ? (typedRaw as TypedUtterance[]) : undefined;
  const rulings = Array.isArray(rulingsRaw) ? (rulingsRaw as QuoteRuling[]) : undefined;
  if (typed || rulings || opts?.dialogueLocks?.length) {
    const { issues, candidates } = reconcileUtterances(scriptMdFinal, typed, rulings, opts?.dialogueLocks);
    misses.push(...issues);
    candidatesOut = candidates;
    receipt.push(`G1 typed utterances：候選 ${candidates.candidates.length}＋skipped ${candidates.skipped.length}（mdSha ${candidates.mdSha}·${candidates.extractorVersion}）；採納 ${typed?.length ?? 0}＋裁定 ${rulings?.length ?? 0}${opts?.dialogueLocks?.length ? `＋鎖 ${opts.dialogueLocks.length}` : ""}`);
  }
  // §19：撤字數質素 verdict——非空已由組裝/zod；完整性歸責任席
  const script = PlaywrightScriptSchema.parse({
    ...(typeof pick("title", "meta") === "string" ? { title: String(pick("title", "meta")) } : {}),
    ...(typeof a.thinking === "string" ? { thinking: a.thinking } : {}),
    ...(typeof charState === "string" && charState.trim()
      ? { characterState: charState }
      // 明報缺失，唔留空字串炸 min(1)，亦唔捏造內容
      : (() => { misses.push("characterState（人物當下狀態）缺——回編劇補"); return { characterState: "（模型冇交 characterState——miss 已報，等價 compiler 佔位）" }; })()),
    ...(typeof pick("characterGoal", "goal") === "string" ? { characterGoal: String(pick("characterGoal", "goal")) } : {}),
    script_md: scriptMdFinal || "（待補）",
    ...(segments.length ? { segments } : { segments: [{ timeEstimate: "", performance: "" }] }),
    dialogue_verbatim_kept: Array.isArray(verbatim) ? verbatim.map(String) : [],
    ...(Array.isArray(typedRaw) ? { utterances: typedRaw } : {}),
    ...(Array.isArray(rulingsRaw) ? { quoteRulings: rulingsRaw } : {}),
    ...(Array.isArray(pick("newElements", "added")) ? { newElements: pick("newElements", "added") as unknown[] } : {}),
    ...(typeof pick("arc", "storyArc") === "string" ? { arc: String(pick("arc", "storyArc")) } : {}),
    ...(typeof pick("dialoguePolicy") === "string" ? { dialoguePolicy: String(pick("dialoguePolicy")) } : {}),
    ...(typeof pick("soundDesignMasterNotes", "soundDesign") === "string" ? { soundDesignMasterNotes: String(pick("soundDesignMasterNotes", "soundDesign")) } : {}),
  });
  return { script, receipt, misses, ...(candidatesOut ? { candidates: candidatesOut } : {}) };
}

/** 編劇席：treatment→可演劇本。glm-5.3 同腦（創作整合分開明示）。 */
export async function runPlaywright(
  packet: { brief: string; treatment: string; assets: string[]; targetSec: number; castRoster?: string[]; dialogueLocks?: DialogueLock[] },
  io: { crew: CrewConfig; model: string; receiptDir: string; fallbackModel?: string },
): Promise<PlaywrightScript & { compileReceipt: string[] }> {
  const loose = z.object({}).passthrough();
  const user = JSON.stringify({
    brief_verbatim: packet.brief,
    director_treatment: packet.treatment,
    asset_facts: packet.assets,
    targetSec: packet.targetSec,
    ...(packet.castRoster?.length ? { cast_roster: packet.castRoster } : {}),
  });
  const pass = await chatJsonSeat<Record<string, unknown>>({
    seat: "creative",
    unit: "playwright-script",
    system: PLAYWRIGHT_CHARTER,
    user,
    schema: loose,
    crew: io.crew,
    model: io.model,
    ...(io.fallbackModel ? { fallbackModel: io.fallbackModel } : {}),
    receiptDir: io.receiptDir,
  });
  fs.writeFileSync(path.join(io.receiptDir, "creative.playwright.raw.json"), JSON.stringify(pass.value, null, 2));
  // §30-1/§31-2：舊「採納∩brief 引號」交集＝§26 否決方式已退役——鎖義務改
  // user/task 採用契約（packet.dialogueLocks，caller 明示）；無鎖合法。
  let compiled = compilePlaywrightScript(pass.value, { dialogueLocks: packet.dialogueLocks });
  // V2b（PLAN-v2 0928）§7.2：gap-retry 補位迴路（照 runDirector 6e39c66 範式）
  // ——canonical 閘 miss＝帶住「缺咗乜」返去同一個方案補一次，唔准編（code
  // 唔填空）；兩次都缺先 fail loud。最近 8 單 SC-0927 有 2 單死呢個閘
  // （characterState 缺席）——throw 完 job 即死冇迴路就係嗰個死法。
  if (compiled.misses.length) {
    const retryUser = JSON.stringify({
      ...JSON.parse(user),
      "之前交咗嘅方案": pass.value,
      "機器閘 miss 清單": compiled.misses,
      "補位要求": "照返你之前交咗嘅同一個劇本，只補齊 miss 清單指明嘅欄位（characterState／script_md 正文／segments 逐段表演；utterances 採納缺口＝對返下方候選表逐項採納或裁定）。唔好由零重作，唔好改已經啱嘅嘢。",
      ...(compiled.candidates ? { "候選表（frozen：mdSha＋extractor 版本綁上一版正文，正文一改即失效）": compiled.candidates } : {}),
    });
    const retryPass = await chatJsonSeat<Record<string, unknown>>({
      seat: "creative",
      unit: "playwright-script.gap-retry",
      system: PLAYWRIGHT_CHARTER,
      user: retryUser,
      schema: loose,
      crew: io.crew,
      model: io.model,
      ...(io.fallbackModel ? { fallbackModel: io.fallbackModel } : {}),
      receiptDir: io.receiptDir,
    });
    fs.writeFileSync(path.join(io.receiptDir, "creative.playwright.gap-retry.raw.json"), JSON.stringify(retryPass.value, null, 2));
    const again = compilePlaywrightScript(retryPass.value, { dialogueLocks: packet.dialogueLocks });
    compiled = { script: again.script, receipt: [...compiled.receipt, ...again.receipt, `playwright gap-retry after ${compiled.misses.length} misses`], misses: again.misses };
  }
  const { script, receipt, misses } = compiled;
  fs.writeFileSync(path.join(io.receiptDir, "creative.playwright.compile.json"), JSON.stringify({ receipt, misses }, null, 2));
  if (misses.length) {
    throw new Error(`playwright_missing_semantics: ${misses.join("；")}——補位迴路行咗一次都缺（收據 creative.playwright.compile.json＋gap-retry raw）`);
  }
  return { ...script, compileReceipt: receipt };
}


// ── SCOPE §6：creative revision／dependency hash ─────────────────────────
// 產物冇 revision＝改咗 brief 舊嘢照被 resume 食（碎切溫床）。manifest 記每件
// 產物 sha＋revision＋dependsOn；briefSha 唔夾＝成條 creative 鏈（連 callsheet）
// 過期，pipeline resume 據此拒絕照食舊嘢。無 manifest 嘅舊 creative/ 照舊相容。

export function briefSha(brief: string): string {
  return createHash("sha256").update(brief, "utf8").digest("hex").slice(0, 16);
}

export type CreativeManifestEntry = {
  file: string;
  sha256: string;
  revision: number;
  dependsOn?: string;
  ts: string;
};
export type CreativeManifest = { briefSha: string; entries: CreativeManifestEntry[] };

export function readCreativeManifest(dir: string): CreativeManifest | null {
  const file = path.join(dir, "manifest.json");
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as CreativeManifest;
    return typeof raw.briefSha === "string" && Array.isArray(raw.entries) ? raw : null;
  } catch {
    return null;
  }
}

/** 寫一件產物後更新 manifest：同一 briefSha 下重寫＝revision 遞增；briefSha 變
 *  ＝新鏈（全部重置 rev 1）。dependsOn 記上游產物 sha（script→plan；plan/
 *  treatment/intent→briefSha）。 */
export function updateCreativeManifest(
  dir: string,
  brief: string,
  entry: { file: string; dependsOn?: string },
): CreativeManifest {
  const fileSha = (f: string) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");
  const manifestFile = path.join(dir, "manifest.json");
  const prev = readCreativeManifest(dir);
  const sha = briefSha(brief);
  const chain: CreativeManifest = prev && prev.briefSha === sha ? prev : { briefSha: sha, entries: [] };
  const old = chain.entries.find((e) => e.file === entry.file);
  const full = path.join(dir, entry.file);
  const next: CreativeManifestEntry = {
    file: entry.file,
    sha256: fileSha(full),
    revision: (old?.revision ?? 0) + 1,
    ...(entry.dependsOn ? { dependsOn: entry.dependsOn } : {}),
    ts: new Date().toISOString(),
  };
  const out: CreativeManifest = {
    briefSha: sha,
    entries: [...chain.entries.filter((e) => e.file !== entry.file), next],
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(manifestFile, JSON.stringify(out, null, 2) + "\n");
  return out;
}

export function writeCreativeArtifacts(
  jobId: string,
  dir: string,
  brief: string,
  plan: DirectorPlan,
  opts: { targetSec: number; aspect?: string; language?: string },
): { intentFile: string; treatmentFile: string; planFile: string; planSha: string } {
  fs.mkdirSync(dir, { recursive: true });
  const intent = {
    slate: jobId,
    ...buildCreativeEnvelope(brief, opts),
    title: plan.title,
    vision: plan.vision,
    vision_line: directorVisionLine(plan),
    // 機讀硬要求由 spec＋信封導出；brief 硬要求真源＝brief_verbatim 逐字
    hard_requirements: [
      ...(opts.targetSec ? [`成片 ${opts.targetSec}s`] : []),
      ...(plan.spec?.product ? [`產品：${plan.spec.product}`] : []),
      ...(opts.aspect ? [`畫幅 ${opts.aspect}`] : []),
    ],
    assumptions: plan.assumptions ?? [],
    capability_gaps: plan.capabilityGaps,
    sound_design_note: plan.soundDesignNote,
    dialogue_placements: plan.dialogueClock?.placements ?? [],
    rhythm_map: plan.rhythmMap,
  };
  const intentFile = path.join(dir, "creative-intent.json");
  const treatmentFile = path.join(dir, "treatment.md");
  const planFile = path.join(dir, "director-plan.json");
  fs.writeFileSync(intentFile, JSON.stringify(intent, null, 2));
  fs.writeFileSync(treatmentFile, plan.treatment);
  fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
  // §6：三件套全部 dependsOn briefSha；重寫（同 brief）rev 遞增
  const sha = briefSha(brief);
  updateCreativeManifest(dir, brief, { file: "creative-intent.json", dependsOn: sha });
  updateCreativeManifest(dir, brief, { file: "treatment.md", dependsOn: sha });
  const planSha = createHash("sha256").update(fs.readFileSync(planFile)).digest("hex").slice(0, 16);
  updateCreativeManifest(dir, brief, { file: "director-plan.json", dependsOn: sha });
  return { intentFile, treatmentFile, planFile, planSha };
}
