# all primitive playbook — 全部檯跨劇目教訓（Curator 代碼寫；Chau 刪一行即否決）
- [g1] schema.missing field=sceneId saw=undefined rule=絕對唔可以喺 JSON 頂層 key 前面加斜線、空格或冒號。sceneId 必須係純 key "sceneId"。每次交稿前逐字檢查頂層 JSON 結構。 hits=2 status=proven src=SC-0912-78N8
- [g2] schema.roster field=people_count saw=5 rule=Portrait returned 5 faces but require is 1; check the face count matches the required count before accepting. hits=1 status=trial src=SC-0915-LD0F
- [g3] schema.missing field=summary saw=placeholders rule=Summary or description must not contain placeholder text; rewrite to remove any template tokens. hits=1 status=trial src=SC-0915-LD0F
- [g4] machine.func field=loadBaseCast saw=undefined rule=Avoid calling import_keyframe_prompt.loadBaseCast directly; the function reference is broken in the current environment. hits=1 status=trial src=SC-0915-LD0F
- [g5] machine.auth field=job_error saw=password rule=Ensure SSH password env vars are set before running scp routes. hits=1 status=trial src=SC-0915-LD0F
- [g6] machine.check field=shot_list saw=Missing rule=Ensure all stills are generated before running picture QC; missing /edit inputs cause retry failures. hits=1 status=trial src=SC-0915-LD0F
