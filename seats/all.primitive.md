# all primitive playbook — 全部檯跨劇目教訓（Curator 代碼寫；Chau 刪一行即否決）
- [g1] schema.missing field=sceneId saw=undefined rule=絕對唔可以喺 JSON 頂層 key 前面加斜線、空格或冒號。sceneId 必須係純 key "sceneId"。每次交稿前逐字檢查頂層 JSON 結構。 hits=2 status=proven src=SC-0912-78N8
- [g6] machine.check field=shot_list saw=Missing rule=--scene hop 嗰陣，picture QC 嘅 geometry 預檢只可以對 hop 自己嗰幕嘅 shots（同 stills／QC lane 一齊 crop），唔可以用成個 slate 嘅 shot list 去判 missing stills——其餘幕嘅 stills 係其他 hop 嘅事。 hits=1 status=trial src=SC-0915-LD0F
