# global playbook — 機器級教訓，全部 seat 共用（Curator 代碼寫；Chau 刪一行即否決）
- [g1] schema.missing field=sceneId saw=undefined rule=絕對唔可以喺 JSON 頂層 key 前面加斜線、空格或冒號。sceneId 必須係純 key "sceneId"。每次交稿前逐字檢查頂層 JSON 結構。 hits=2 status=proven src=SC-0912-78N8
