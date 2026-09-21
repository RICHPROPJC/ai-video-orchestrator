# CARD_INSIDE_VISIBLE_0921 — 入面一個有問題冇人知（attempt燈＋開工掃墓）

卡文出自 inside-dispatch dig §4（`SlateLead/out/INSIDE_DISPATCH_DIG_0921.md`）；Chau 0921 釘。Wire 行；worktree `/mnt/ssd/crew-wt/inside`（branch lane/inside-visible，base 4e1651c）。

## 原則（照dig）

唔加新 state 檔（A4「one log written twice」）；沿用 events.jsonl 呢本已有帳；缺嘅係燈，唔係簿。

## S1 卡A attempt燈 —— a10a1c1

- `crew-llm.ts` `ChatJsonOpts` 加 `onAttempt?: (r:{attempt, valid, errors}) => void`，喺收據落檔嗰行（receipts.push 後）即叫——**attempt 完結一刻**，唔使等收場。
- `SeatIo` 加 `warn?: (message) => void` 頻道；`seat-writer`（outline＋beats 兩 pass）同 `seat-boards`（每場 pass）駁燈：`!valid` 即 `io.warn?.("<席位> <unit> attempt N ✗ <errors首行>")`。
- `pipeline.ts` 兩行：writer/boards io 各加 `warn: (m) => io.speak("<席位>", m, "warn")` → A4 events.jsonl。P8CN 式 3m44s 靜音變即時 warn。
- 共 ~25 行，零 schema 改動，零新 state 檔。

## S2 卡B 開工掃墓 —— b7cdd6c

- `store.ts` `failedRecent()`：runningBlocker 同款 listJobs 掃法——`failed` 未收屍全部列出；`running` 靜 >30min 一樣現形；>30min 標 `stale`。`failedRecentLines()`：`⚠ [STALE ]<slate> <status> <N> 分鐘前：<error 首60字>（未收屍）`。
- `cli.ts` produce preflight（blocker 前印，**現形唔阻路**——serial floor 照舊管）＋`status` 無參數命令（屍體行先行）。「job 靜靜死冇任何 seat 知」斷根：任何下一個 produce/status 必撞正屍體。

## S3 test —— b76c171

- 卡A unit：chatJson 三連 reply（兩衰一好）→ `onAttempt` 逐 attempt 火 `[[1,false],[2,false],[3,true]]`，失敗帶 errors 行。
- 卡A wiring：pipeline `io.warn` 產生嗰條 warn event（`writer … attempt 1 ✗ …`）落 events.jsonl——store.test A4 式 scratch＋emit＋readEvents 實證。
- 卡B：四 job 場景——fresh failed（唔 STALE）／26h failed（STALE）／45min running（STALE）／活 running（唔列）；writeJob 會重打 updatedAt 戳，屍體以磁碟 backdate 模擬真遺棄（jobDir=data/jobs/<id>）。格式斷言 STALE 旗＋（未收屍）＋error 首行。

## 測試實數（worktree；tsx --test --test-force-exit src/lib/studio/*.test.ts，proxy unset）

| 項 | 實數 |
|---|---|
| crew-llm＋store 兩檔 | **34/34 pass**（+3 新測試） |
| 全套 | **503 tests / 496 pass / 5 fail / 2 skipped** |
| 紅名對拍 | 5 紅＝4908bc8 基線 7 紅**逐名子集**（減嘅 2 紅＝Fable untracked `still-h3-proxy.test.ts` 兩紅——worktree 冇 untracked 檔，非修好非新增）；**零新增紅** |
| 2 skipped | 兩個 WIST dry-run test 要 `data/jobs/SC-0913-WIST`（worktree 冇 job 數據；卡禁掂 jobs 數據照辦唔 copy——主樹行會全跑） |
| tsc --noEmit | 3 錯全 pre-existing（memory node:sqlite／pipeline.test bun:test／pipeline kept）。另 worktree 見 `layout.tsx LayoutProps` 一錯＝**冇 .next build 產物嘅環境噪音**（主樹 4e1651c 無此錯），非本卡引入 |

## 依賴申報（DISPATCH_BOARD 規3）

掂 `pipeline.ts` 僅 io 物件兩行（writer/boards call 區），MULTISHOT_WIRE（Mo）嘅 motion 段零接觸；crew-llm/store/cli/seat-*/tests 無他卡在場。

## 未做

未 merge 入 crew-seats（等 Vera＋SlateLead 派）；未 push；未掂 data/jobs、Fable 產物、服務。
