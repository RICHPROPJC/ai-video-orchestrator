# writer primitive playbook — writer 檯跨劇目教訓（Curator 代碼寫；Chau 刪一行即否決）
- [w1] arithmetic.clock field=beats saw=SC03.B14 rule=每場 beat 數唔好超過 12 個；100 秒場按 5.5 秒上限計算，最多 18 拍，但為咗安全同節奏，控制喺 10-12 拍以內，避免觸發 zod 陣列長度上限。 hits=2 status=proven src=SC-0912-G841
- [w3] arithmetic.scenes field=scenes saw=5 rule=600秒 slate 最少 6 場；拆完先數場數，唔好交少。若原计划 5 场，需拆一场或合并后增补一场至 6 场以上。 hits=2 status=proven src=SC-0912-56LC
- [w5] schema.enum field=language saw=auto rule=language 字段只能填 zh-Hant、yue、en 其中一個字，絕對唔可以填 auto 或者中文代稱。 hits=2 status=proven src=SC-0913-L6WJ
- [w6] schema.enum field=world.timeOfDay saw=多變（夜→晨→日） rule=world 同 scenes 嘅 timeOfDay 只能填 dawn、day、dusk、night，唔可以寫「多變」或者用箭頭表示時間跨度。 hits=2 status=proven src=SC-0913-L6WJ
- [w7] schema.len field=beats.action saw=120字文學長句 rule=action 最多 48 字，要有至少一個鏡頭見得到嘅動詞（跪／押／提／畫／坐／站…）；一個 beat 係一個做得出嚟嘅動作，唔係一段文。 hits=1 status=trial src=SC-0915-LD0F
