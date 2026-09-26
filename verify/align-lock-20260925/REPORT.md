# ALIGN-LOCK correction evidence — 2026-09-25

Scope: local source, seat instructions, workflow fixtures and offline validation. Existing uncommitted work was retained. No commit, process stop, producer restart, new produce job or external message was issued. No project output was retroactively relabelled as passing.

Changes:

- `runBoards` now owns visible boards, cuts, shot/percentage mapping, per-cell QC and bounded repair. Rejected crops are composited into repair input boards; only accepted replacements overwrite their corresponding destinations. Per-attempt receipts retain source boards, SHA-256, input paths, cut paths, destinations and QC paths. Text-only runs are drafts; dry-run is not a boarded pass. Plugged/resumed text sheets also owe visible boards.
- Empty `buildings` no longer fabricates buildings from room/table names. Building look-dev images and remembered story stills are excluded from the shared keyframe-sheet reference lane; all required uncut identity sheets are gathered.
- H3 uses six individual anchor slots then ordered `images_batch`. Percent count and image count must match. Standalone multishot rejects Video 1, keyframe names/start images and non-identity-sheet references. Legacy chained Video 1 multishot is rejected; scheduling splits solo C-form and identity-only multishot. The separately disputed single-shot percentages + Video 1 allowance remains unchanged; no §5b adjudication is claimed.
- Submission, segment planning and concat gating use upward `17k+5`. Manifest frame numbers cannot override the computed budget. Eight 68-frame requests budget 73 each / 584 total; 577 is rejected. Segment manifests are regenerated from the current plan.
- Sound QC compares delivered shot dialogue rather than unread voiceover and writes its comparison scope. Existing full-shot silence, AuK :9882 and SenseVoice :9881 were retained. `/run` remains unwired and is documented as such.
- One canvas includes storyboard cuts, identity/scenery/prop nodes and keyframes. Cut links connect keyframes; reference links are separate. PNG thumbnails use bounded WebP previews; full images load on opening. Audio remains on the film page.

Validation (counts overlap; do not add them):

- `targeted-108.tap`: 108/108 passed at the broad checkpoint.
- `visual-23.tap`: 23/23 passed after adding full runBoards and preview tests.
- `routing-57.tap`: 57/57 passed after rejecting legacy chained multishot and changing scheduling.
- `regressions-4.tap`: 4/4 passed after composing rejected crops into repair input. Checks replacement isolation, actual preview dimensions, seventh-plus anchor order and rejection of the 577-frame override.
- `lint.txt`: focused ESLint result. `git diff --check` passed.
- `sha256.json`: source and test-log hashes for this review.

`synthetic-board-fixture/` contains test-generated red/blue boards and crops, not episode artwork. Fixture receipts may point to their original `/tmp/align-boards-*` paths.

Whole-project typecheck is still **not green**: `typecheck.txt` records existing `.ts` import-extension errors in scratch scripts, missing `node:sqlite` / `bun:test` declarations, and the missing `STILLS_EDIT` export in the pre-existing proxy. The new-code type error found during verification was corrected.

Live U1.5/H3 rendering, live visual QC and browser interaction were not run. This is source/offline-test evidence, not a delivered-film claim. Mothership event_id / trace_id and live delivery QC: not applicable; none fabricated. Existing running produce output is not claimed to include these changes.
