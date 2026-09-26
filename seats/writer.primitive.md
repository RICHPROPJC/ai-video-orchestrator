# writer primitive playbook — writer 檯跨劇目教訓（Curator 代碼寫；Chau 刪一行即否決）
- [w1] arithmetic.clock field=beats saw=SC03.B14 rule=每場 beat 數唔好超過 12 個；100 秒場按 5.5 秒上限計算，最多 18 拍，但為咗安全同節奏，控制喺 10-12 拍以內，避免觸發 zod 陣列長度上限。 hits=2 status=proven src=SC-0912-G841
- [w3] arithmetic.scenes field=scenes saw=5 rule=600秒 slate 最少 6 場；拆完先數場數，唔好交少。若原计划 5 场，需拆一场或合并后增补一场至 6 场以上。 hits=2 status=proven src=SC-0912-56LC
- [w5] schema.enum field=language saw=auto rule=language 字段只能填 zh-Hant、yue、en 其中一個字，絕對唔可以填 auto 或者中文代稱。 hits=2 status=proven src=SC-0913-L6WJ
- [w6] schema.enum field=world.timeOfDay saw=多變（夜→晨→日） rule=world 同 scenes 嘅 timeOfDay 只能填 dawn、day、dusk、night，唔可以寫「多變」或者用箭頭表示時間跨度。 hits=2 status=proven src=SC-0913-L6WJ
- [w7] schema.len field=beats.action saw=手掌慢慢收返 rule=action 必須只包含一個鏡頭可見的物理動詞（如放、坐、站），嚴禁使用「慢慢」、「收返」等描述性修飾詞或狀態描繪，確保動作純粹且可見。 hits=2 status=proven src=SC-0915-LD0F
- [w8] stills.noun field=scenes.location saw=總統府地下審判室 rule=scenes[].location 寫畫面見到嘅房 2–8 字（地下室、宿舍、走廊）。機構／劇名只入 heading。beats.action 只寫見到嘅郁動同物件，唔寫故仔、唔寫片。 hits=2 status=proven src=SC-0915-LD0F
- [w10] schema.enum field=characters.voice.pitchHz saw=0 rule=voice.pitchHz 必須大於等於 60；填 0 會觸發 'Too small' 錯誤，請確保所有角色聲調在 60-400 Hz 範圍內。 hits=2 status=proven src=SC-0923-OLHR
- [w12] schema.missing field=output.status saw=blocked rule=Never output status objects like 'blocked'. Always return valid schema fields; report brief errors in thinking only. hits=2 status=proven src=SC-0923-BEQ5
- [w13] schema.action field=beats.action saw=舉玻璃樽 rule=「舉」可能被視作複合或狀態，改用「提」或「拿」後直接接物件，確保單一物理動詞。 hits=7 status=proven src=SC-0924-BP5S
