# CARD_COMBAT_PORT_0921 — Vera 判決（0921）

席：Vera（零參與全新眼）。對象：lane/combat-port 0cdcbba→424fc79→6be270b→31932bf（底 4e1651c，working tree clean，四 commit 核實）。全部數字自跑。

## 判決：MERGE_OK（附兩項非阻塞差異，見末）

## 驗收表（九項，全部自跑實數）

| # | 項 | 實數 | 判 |
|---|---|---|---|
| 1 | 三份 golden 重跑 deep-equal | 由 live `/mnt/ssd/h3studio`（HEAD＝`2bc8c90755161d15536a23b35714103a7d532e5c`，.py 零 dirty）用 gen-*.py 即場重跑（/tmp 鏡像跑，冇掂 src）：python-golden **26 case**／python-presets 六族 **[32,32,32,32,32,32]**／python-env-golden **10 case**，三份 **byte-identical** 對已 commit fixtures；test 端 `deepStrictEqual` 逐 case＋`/^2bc8c907/` anchor 斷言存在 | ✓ |
| 2 | 全套重跑 vs 基線 | lane：**527 tests / 520 pass / 5 fail / 2 skipped**（實跑）。自起臨時 worktree 跑 4e1651c 基線：**500 / 493 / 5 / 2**——五紅逐名一致（noun-lint／resume／27B-fake-fetch／no-seat-grave／Chau-home-paths）；+27 test 零新增紅。基線 worktree 已拆已 prune | ✓ |
| 3 | 非combat byte-identical | adapter.test「non-combat prose is byte-identical」綠（零 combat 句漏＋同 sheet 過 pass 輸出逐 byte 相等）；既有 h3-prose/pipeline test 全綠照舊；碼核實：buildProseLong combat 段 `if (shot.combat)` 閘、`applyCombatPass` 首行 detectCombat 早退 | ✓ |
| 4 | detectCombat no-op 閘 | 碼：`cast.size >= 2 && hasCombatCause(...)` 雙條件；早退先於一切 emit／`fs.writeFileSync`——零 event 零收據零 combat 欄。test 斷言（calmEvents=0／applied=false／combat undefined）存在且綠 | ✓ |
| 5 | ACTION_RISK 形＋收據 | 三個 emit 位 events `data` 全帶 **shot/stage/eye/verdict/proof** 五欄；收據寫 `data/jobs/<jobId>/combat/combat-pass.json`（jobFile），test 於 tmpdir 實寫實讀通過（combatShots=["SH01","SH02"]＋incompatibleShots=1） | ✓ |
| 6 | nameToEngine 角色綁定 | 碼：`[["S1",s1],["S2",s2]]` 按名長排序只管替換次序，每名綁自己 token；test 斷言 `actors.s1="陳師傅"`／`s2="大強"`＋first beat 主語 `"陳師傅 launches"` 綠 | ✓ |
| 7 | prose budget | `IDENTITY_LONG_MAX=300`（T42）；dialogue 先計入 budget 再加 combat 行、first-fit drop；兩個 budget test 綠（含 fat-packet 斷言 Physical Contact 唔 drop first） | ✓ |
| 8 | env ledger | bound 6：test（`persistent.length===6`＋"all earlier tracked changes also persist"）＋碼 `ledger.slice(-6)` ✓；light 無 persist 字：test＋碼（persistentUpdate：light 冇 remain/spreads/displaced/open→""，唔入 ledger）✓；**地點變更開新簿：碼有**（adapter 連續同-location run 各自 fresh `environmentRelay`，combat-adapter.ts:178-198）**但全 repo 零 test 釘**（adapter/env test 全單一 location） | △ |
| 9 | noun-lint＋收據對數 | noun-lint combat 四檔 **0 hit**；總 **12 hit**（studio-floor.tsx 8／script-contract.test 1／seat-writer.test 3），基線同 12 hit 同三檔——「全基線」實。收據逐 claim：27/27 ✓、527/520/5紅全基線同名 ✓、golden三份＋anchor ✓、eslint combat 0 錯 ✓（exit 0）、六族各32 ✓、not-port（VFX/plates）✓、S1 三批覆條件①②③ ✓。**一處不符：收據「全套tsc 5錯」實數 6 錯**（見差異 A） | △ |

## 差異清單（兩項，均非阻塞）

- **A. 收據 tsc 計數錯**：`CARD_COMBAT_PORT_0921.md` proof 寫「全套tsc 5錯全基線其他檔」——實數 **6 錯**（nex-blender-real-call.ts ×2 TS5097、layout.tsx LayoutProps、memory.ts node:sqlite、pipeline.test.ts bun:test、pipeline.ts 'kept'）。基線同樣 6 錯同檔同碼，combat 檔 0 錯零新增——數字計少，實質不變。
- **B. 「地點變更開新簿」有碼無 test**：行為由碼讀核實存在（逐連續同-location run 起新 environmentRelay＝新 ledger），但 adapter／environment test 全部單一 location，無 test 斷言。收據只列行為冇 claim 有 test；驗卡第 8 項「（test）」預期落差。如 foreman 要求 test 釘死，開細卡補一個斷言即可。

## 注腳

- combat-environment.ts offset 25633 有 literal NUL byte——係 regex `/\<NUL\>/g` 嘅匹配對象（清 NUL 用），grep 會當 binary file；tsc／eslint／test 全過，良性刻意。
- 收據「h3studio 自家 21/21 綠」無獨立重跑（scope 外）；取代性證據：h3studio HEAD＝anchor、.py 零 dirty、三 golden 即場 regen byte-identical。
- live 端到端 produce 未跑（收據講明範圍外，jobs 零改動硬閘遵守）。

## Handover

- 判決 MERGE_OK 已交 SlateLead/main；Grok 可按程序 sequential-merge `lane/combat-port` 入 `crew-seats`。
- 差異 A（tsc 5→6 計數）建議下次收據更正；差異 B 可開一張細卡補「地點變更開新 ledger」test 斷言（行為本身已核實正確）。
- 我冇修任何碼、冇 push、冇停服務；src 讀-only，寫入限 verify/vera/。臨時基線 worktree 已拆；/tmp 兩個 probe 檔刪除被權限擋，留喺 /tmp（vera-combat-verify/、vera-noun-combat.ts）無害。
