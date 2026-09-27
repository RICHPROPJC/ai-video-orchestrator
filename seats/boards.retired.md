# boards retired playbook — 已退役教訓存檔（Curator 代碼寫；Chau 刪一行即否決）
# 本檔唔會被 assemblePlaybook 載入（佢只讀 <scope>.primitive.md 同 projects/<drama>/playbook/<scope>.md）。
# 退役唔係刪史：原文逐字保留，每條附退役原因＋依據。SC-CREATIVE-OS-0927 P0。
- [b4] arithmetic.clock field=shots.durationSec saw=9.3s rule=durationSec 必須大於等於對白字數 × 0.23 + 0.6 嘅結果。例如 38 字對白需要 9.3s，唔可以只寫 8.5s。 hits=2 status=proven src=SC-0912-C7IQ
  # retired 2026-09-27 SC-CREATIVE-OS-0927 §2A：同 charter 時鐘（0.12+0.15）相撞且一齊餵入模型；對白時鐘單一真源＝代碼（boards-contract 計法），playbook 唔另背係數
- [b8] arithmetic.sum field=shots.totalSec saw=84.9s rule=總和若低於 budgetSec 嘅 91%，必須逐個將最短嘅鏡頭拉長（唔超過 15s），直到總和達標，唔可以寧願低過下限。 hits=2 status=proven src=SC-0912-YGTS
  # retired 2026-09-27 SC-CREATIVE-OS-0927 §2A/§1：拉長舊動作湊秒替代創作——時長不足＝內容缺口，返創作層發展事件；band 邊界由 boards-expand 代碼閘管
- [b9] arithmetic.sum field=shots.durationSec saw=49.1s rule=若總和超過 budgetSec 嘅 109%，必須逐個將最長嘅鏡頭削短（唔低過 5.2s），直到總和落返入 [0.91, 1.09] × budgetSec 範圍內，唔可以憑感覺填數。 hits=2 status=proven src=SC-0913-07JZ
  # retired 2026-09-27 SC-CREATIVE-OS-0927 §2A：5.2s 係舊修補常數（同 b4/b8 一組相撞時計）；每鏡下限由 frame-grid shotSecMin 代碼真源管，總長 band 由 boards-expand 管
- [b12] schema.array field=shots.beatId saw=SC01.B01 rule=beatId must be a single string, never an array. If merging beats, pick one primary beatId string. hits=2 status=proven src=SC-0923-DTQH
  # retired 2026-09-27 SC-CREATIVE-OS-0927 §2B：呢句＋「全 beat 必須各有 shot」夾埋凍結咗「一動詞一鏡」碎切結構；beatIds[] 多對多覆蓋屬 P1 schema（CREATIVE_OS_DECISION_0927 §3），唔喺 playbook 層凍結
