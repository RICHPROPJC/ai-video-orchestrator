# boards primitive playbook — boards 檯跨劇目教訓（Curator 代碼寫；Chau 刪一行即否決）
- [b3] schema.ref field=props.heldBy saw=A rule=props.heldBy 必須引用同一個鏡頭 cast 入面實際存在嘅 characterId。如果道具係由某角色持有，就確保嗰個角色嘅 characterId 已經喺該鏡頭嘅 cast array 入面。 hits=2 status=proven src=SC-0912-T0N1
- [b4] arithmetic.clock field=shots.durationSec saw=9.3s rule=durationSec 必須大於等於對白字數 × 0.23 + 0.6 嘅結果。例如 38 字對白需要 9.3s，唔可以只寫 8.5s。 hits=2 status=proven src=SC-0912-C7IQ
- [b5] schema.enum field=cast.stanceEnd saw=walk rule=stanceEnd 字段絕對唔可以用 gait 嘅值（如 walk, reach, turn, plant），只能係 stand, lean, crouch 其中一個。 hits=2 status=proven src=SC-0912-2Y0V
- [b6] schema.enum field=cast.travelTo saw=far rule=travelTo 只能引用 cast 入面嘅 slot 值（L, C, R），唔可以用 depth 值（near, mid, far）或者任何座標/文字描述。 hits=2 status=proven src=SC-0912-2Y0V
- [b7] schema.roster field=cast.slot saw=C/mid rule=同一鏡頭內唔可以有兩個人物佔有相同嘅 slot 同 depth 組合。例如兩人都寫 slot:C, depth:mid 係違規嘅，必須將其中一人調到 L/R 或者改 depth。 hits=2 status=proven src=SC-0912-BO9W
- [b8] arithmetic.sum field=shots.totalSec saw=84.9s rule=總和若低於 budgetSec 嘅 91%，必須逐個將最短嘅鏡頭拉長（唔超過 15s），直到總和達標，唔可以寧願低過下限。 hits=2 status=proven src=SC-0912-YGTS
- [b9] arithmetic.sum field=shots.durationSec saw=49.1s rule=若總和超過 budgetSec 嘅 109%，必須逐個將最長嘅鏡頭削短（唔低過 5.2s），直到總和落返入 [0.91, 1.09] × budgetSec 範圍內，唔可以憑感覺填數。 hits=2 status=proven src=SC-0913-07JZ
- [b10] schema.len field=shots.action saw=37-gram rule=action 最多 48 字，一句短過一句長；要有至少一個鏡頭見得到嘅動詞（跪／押／提／畫／坐／站…），唔好文學描寫——T35 0.5 門檻會判死長 action。 hits=1 status=trial src=SC-0915-LD0F
- [b11] stills.noun field=require.location saw=總統府地下審判室 rule=require.location 寫畫面見到嘅房 2–8 字（地下室、宿舍、走廊）。機構／劇名只入 heading。/edit prompt 跟官方 U1.5 gallery 寫夠數百字（每張 Image 角色、改咩留咩、光、材質、接觸），唔寫六行電報、唔寫故仔。 hits=2 status=proven src=SC-0915-LD0F- [b12] stills.forbid field=props.forbid saw=screen rule=光框／全息／infograph／hologram／數據卡 嘅 forbid 唔可以寫 screen 或 螢幕——光框本身就係螢幕，寫入 forbid 會殺合法形。phone／book 照寫。 hits=1 status=trial src=SC-0919-WR1Q
