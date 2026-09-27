# writer retired playbook — 已退役教訓存檔（Curator 代碼寫；Chau 刪一行即否決）
# 本檔唔會被 assemblePlaybook 載入（佢只讀 <scope>.primitive.md 同 projects/<drama>/playbook/<scope>.md）。
# 退役唔係刪史：原文逐字保留，每條附退役原因＋依據。SC-CREATIVE-OS-0927 P0。
- [w1] arithmetic.clock field=beats saw=SC03.B14 rule=每場 beat 數唔好超過 12 個；100 秒場按 5.5 秒上限計算，最多 18 拍，但為咗安全同節奏，控制喺 10-12 拍以內，避免觸發 zod 陣列長度上限。 hits=2 status=proven src=SC-0912-G841
  # retired 2026-09-27 SC-CREATIVE-OS-0927 §2B：100 秒場經驗跨時長硬套（26s 廣告被推到 12 拍）；拍數＝事件密度函數，上限由 script-contract maxBeatsIn(targetSec) 代碼真源管
- [w7] schema.len field=beats.action saw=水漬一圈圈散開 rule=Action 必須係單一物理動詞+物件。嚴禁寫純視覺現象（如水漬一圈圈散開、陽光下閃亮）或修飾詞（如慢慢、收返）作為主要動作，只寫角色對物件施加嘅物理位移。 hits=2 status=proven src=SC-0915-LD0F
  # retired 2026-09-27 SC-CREATIVE-OS-0927 §2B/§2C：消滅正當電影事件（BP5S brief 主體「冷凝水沿樽身滑落」正係視覺現象）；可見動詞閘已降級非阻塞診斷（actionVerbGaps）
- [w13] schema.action field=beats.action saw=瞇眼 rule=避免使用‘瞇眼’、‘捽心口’等模糊或複合動詞，必須選用單一、清晰、鏡頭可視嘅物理動詞（如‘眨眼’、‘拍’）以符合 action 規範。 hits=17 status=proven src=SC-0924-BP5S
  # retired 2026-09-27 SC-CREATIVE-OS-0927 §2D：病根＝驗收器詞表覆蓋缺口（睇唔到「瞇」）被重試屈 writer 改動作，再被 format-PASS 自動升級機制複利成 hits=17 跨劇目禁語（冤案）；詞表已補瞇捽等字＋閘已降診斷，markPass 已停止自動升級
