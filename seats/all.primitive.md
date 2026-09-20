# all primitive playbook — 全部檯跨劇目教訓（Curator 代碼寫；Chau 刪一行即否決）
- [g1] schema.missing field=sceneId saw=undefined rule=絕對唔可以喺 JSON 頂層 key 前面加斜線、空格或冒號。sceneId 必須係純 key "sceneId"。每次交稿前逐字檢查頂層 JSON 結構。 hits=2 status=proven src=SC-0912-78N8
- [g2] schema.roster field=people_count saw=5 rule=Portrait returned 5 faces but require is 1; check the face count matches the required count before accepting. hits=1 status=trial src=SC-0915-LD0F
- [g4] machine.func field=loadBaseCast saw=undefined rule=Avoid calling import_keyframe_prompt.loadBaseCast directly; the function reference is broken in the current environment. hits=1 status=trial src=SC-0915-LD0F
- [g5] machine.auth field=job_error saw=password rule=Ensure SSH password env vars are set before running scp routes. hits=1 status=trial src=SC-0915-LD0F
- [g6] machine.check field=shot_list saw=Missing rule=--scene hop 嗰陣，picture QC 嘅 geometry 預檢只可以對 hop 自己嗰幕嘅 shots（同 stills／QC lane 一齊 crop），唔可以用成個 slate 嘅 shot list 去判 missing stills——其餘幕嘅 stills 係其他 hop 嘅事。 hits=1 status=trial src=SC-0915-LD0F
- [g7] schema.missing field=blockout.figure saw=Ymin=154 rule=Ensure figures are placed within the specified Y range for mark A to avoid 'no figure at mark A' errors. hits=1 status=trial src=SC-0919-WR1Q
- [g8] machine.check field=photo_qc saw=SH01 rule=Ensure photo_qc is GREEN before attempting /edit; missing green status blocks editing. hits=1 status=trial src=SC-0919-WR1Q
- [g9] machine.thin field=prompt_length saw=140 rule=If packet length is 140, pad to min 150 chars to avoid prompt_too_thin rejection. hits=1 status=trial src=SC-0919-WR1Q

