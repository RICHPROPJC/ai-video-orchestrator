# REFILL_DIG_0915 — Vera hard-compare

**Verdict: MERGE_HOLD** (selective cherry-pick only; no wholesale refill → `crew-seats`)

| Repo | Tip | Branch / note |
|------|-----|----------------|
| REFILL | `39e2f68839941151e9e45d6ef93008d90996a339` | 3-commit cloud copy (init + `5293551` bulk + `39e2f68` H3 lock) |
| CREW | `d7b3c3835dbbe14f248de6de99871980a59ac588` | `crew-seats` — **docs-only** H3 lock (`docs/H3_FOUR_LANE_LOCK_0915.md` admits code gaps) |

**Histories diverge.** Refill is not a fast-forward of crew. Cherry-pick = copy files + reconcile ~40 differing paths under `src/`.

Chau was right: refill is **most-good, not full-good** — solid clinic logic and unit tests, but missing live-job proof, unwired subsystems, and filename heuristics.

---

## Acceptance table

| # | Check | Evidence | Result |
|---|--------|----------|--------|
| 1 | Refill tip read | `git -C refill log -1 --stat 39e2f68` → 12 files (+766/−9) | PASS (read) |
| 2 | Crew tip read | `git -C crew log -1 --stat d7b3c38` → 1 doc file | PASS (read) |
| 3 | Only-in-refill inventory | `diff -rq crew/src refill/src` | 8 modules + 4 UI/API paths **absent from crew** |
| 4 | Pipeline `h3_plan` wiring | `grep writeH3Plan crew/src` → empty; refill `pipeline.ts` writes `motion/SHxx.h3_plan.json` before submit | **FAIL crew** / PASS refill |
| 5 | Targeted unit tests | `npx tsx --test` 9 files on refill → **66/66 pass** | PASS (synthetic only) |
| 6 | Real job spatial | `grep '"spatial"' crew/data/jobs/SC-0915-LD0F` → none | **UNPROVEN** on live slate |
| 7 | Blender fixtures vs spatial gate | refill has `shots/fixtures/f{1,2,3}/`; `spatial-lock.test.ts` uses **clinic desk only** | **UNPROVEN** cross-link |
| 8 | Mesh live POST | `planAssetShell` → `writeMeshDryRun` only; **not imported in pipeline** | **DRY-RUN ONLY** |
| 9 | AuK `/run` in factory | `/mnt/ssd/serve-auk.py` exposes `/run`; refill adds `runAukRun()` but **pipeline still uses `/tts` via `ensureAudibleShotWav`** | **LIB ONLY** |
| 10 | `gapSec` compat | refill `assertNoOuterGap(gapSec)`; crew spine path uses `gapSec > 0` audio concat | **CONFLICT** if merged naively |

---

## Per-path verdicts

### USE — cherry-pick first (low blast radius, tests green)

| Path | Why |
|------|-----|
| `src/lib/studio/h3-slots.ts` | Four-lane plan + `assertH3SubmitWiring` — matches SSOT; 153-line test file |
| `src/lib/studio/h3-slots.test.ts` | Clinic hold/hop + wiring throws |
| `src/lib/studio/native-cut.ts` | Bans xfade/setpts/morph in outer ffmpeg |
| `src/lib/studio/native-cut.test.ts` | 3 cases |
| `src/lib/studio/h3-r2v-graph.ts` (diff hunk only) | Comment clarifying 0%/100% vs H3Keyframes — no behavior change |

**Also USE (pipeline slices, not whole file):**

- `writeH3Plan()` + `prevShotOf()` + dual `writeH3Plan` call sites before `submitH3Shot`
- `muxArgs` → `assertNativeFfmpeg`
- preview concat → `concatCopyArgs`

---

### USE-WITH-CARE — merge with explicit follow-ups

| Path | Risk / gap |
|------|------------|
| `src/lib/studio/h3-prose.ts` | **Forced** `hold` + `morph` in `validateProse` — will **fail existing variant-A slates** until prose regenerated. Location-return pin (`prevLocation`) is good. |
| `src/lib/studio/h3-prose.test.ts` | Tests synthetic golden only |
| `src/lib/studio/auk-tts.ts` | `/run` + emotion-tag guards correct vs `serve-auk.py`; **`runAukRun` unwired** in pipeline. `/tts` one-take guard is safe. |
| `src/lib/studio/auk-tts.test.ts` | Mock fetch only — no live :9882 |
| `src/lib/studio/spatial-lock.ts` | Numeric gate logic sound; **clinic desk fixture only**. Pipeline calls `assertSpatialGate` at layout — old sheets without `shot.spatial` pass through (numbers-only). |
| `src/lib/studio/spatial-lock.test.ts` | One blender script string test; **no f1/f2/f3 fixture replay** |
| `src/lib/studio/floor-tab.ts` | Adds `gate` + `h3` tabs |
| `src/lib/studio/floor-tab.test.ts` | Parse only |
| `src/components/studio-floor.tsx` | Embeds clinic cards for gate/h3 — UI only |
| `src/lib/studio/pipeline.ts` (spatial + gap) | `assertNoOuterGap` **breaks crew `gapSec>0` spine** — gate behind flag or drop gap path first |
| `src/lib/studio/types.ts` (spatial block) | Required if spatial-lock lands |
| `src/lib/studio/config.ts` (tripo/trellis) | Empty defaults OK |
| `src/lib/studio/plates.ts` + `plates.test.ts` | Standing-plate guards; no pipeline hook |
| `src/components/h3-plan-card.tsx` | Clinic display |
| `src/app/h3/page.tsx` | Clinic page |
| `src/app/api/h3/route.ts` | JSON clinic endpoint |

---

### DO-NOT-MERGE (as-is)

| Path | Why |
|------|-----|
| **Whole refill tree → crew-seats** | Unrelated git history; 323-file bulk commit; would overwrite crew polish (`fleet`, `scp-upload`, live `SC-0915-LD0F` job) |
| `src/lib/studio/assets.ts` | **Dry-run shell only** — writes JSON stubs, never POSTs Tripo/Trellis |
| `src/lib/studio/mesh-provider.ts` | `writeMeshDryRun` only — no GPU receipt |
| `src/lib/studio/assets.test.ts` | Validates temp-dir JSON, not mesh quality |
| `src/app/spatial/page.tsx` | Demo clinic — not production spatial proof |
| `src/components/spatial-receipt.tsx` | Demo component |
| `src/app/api/spatial/route.ts` | Clinic JSON only |
| Refill `shots/fixtures/f{1,2,3}/` **as spatial proof** | Real blender binaries exist in refill but **spatial-lock never imports them** — do not claim “proven” |

---

## Risk dig (mandatory)

### 1. `prevId` filename heuristic (`h3-slots.ts`)

```225:228:refill/src/lib/studio/h3-slots.ts
  if (prevId && fileName(wiring.kfStart).startsWith(prevId)) {
    throw new Error(`${plan.shotId}: kf_start is prev last/still (${prevId}) — eats the old scene`);
  }
```

- Prefix match on basename only — **false positive** if shot ids share prefix (`SH01` vs `SH010`).
- **false negative** if prev still renamed without id prefix.
- Acceptable as fail-loud clinic guard; not production-grade identity.

### 2. Forced hold/morph prose

`validateProse` now **requires** `\bhold\b` and `\bmorph\b` in body. Crew `pipeline.ts` calls `validateProse` on variant A before submit — **will hard-fail** until all motion prose rebuilt with `Hold {duration}s` line. Synthetic tests pass; **SC-0915-LD0F not re-run**.

### 3. Spatial unproven vs blender fixtures

- Refill ships heavy `shots/fixtures/f1|f2|f3` (observation.json, blockout.mp4, headless.py).
- `spatial-lock` tests: synthetic `clinicDesk()` AABB only + one `blenderBlockoutScript` string match.
- **No test** runs `lockCallSheetShot` against f2 kneel/lie or f3 occluded cases.
- Live crew job **has zero `spatial` fields** — gate is no-op today.

### 4. Dry-run mesh

- `planAssetShell` writes `*.u15_edit.json`, `mesh_dryrun.json`, `import_mesh.json` — **never called from pipeline**.
- Config tripo/trellis default empty → skip. Safe but **zero factory value** until wired + live POST.

### 5. AuK `/run` vs `/tts`

- `serve-auk.py` on disk: `/run` (NL instruction) + `/tts` (verbatim clone) — matches refill API shape.
- Factory path: `ensureAudibleShotWav` → `runAukTts` → `/tts` only. `/run` is **dead code in production** until beat-level instruction wiring lands.

---

## Crew honesty cross-check

`docs/H3_FOUR_LANE_LOCK_0915.md` on crew **already lists** fail-loud kf_start + `h3_plan.json` as ❌. Refill **implements** those in code — crew doc is stale relative to refill, accurate relative to crew `src/`.

---

## Recommended merge order (for Grok, after MERGE_OK on slices)

1. `h3-slots.ts` + test + pipeline `writeH3Plan` hooks  
2. `native-cut.ts` + test + mux/concat guards (**resolve `gapSec` first**)  
3. `h3-prose.ts` hold/morph + `prevLocation` in `h3MotionPack` — **regenerate prose fixtures**  
4. `auk-tts.ts` one-take guards (defer `/run` until pipeline hook)  
5. `spatial-lock.ts` + types — **behind `shot.spatial` presence**; add f2/f3 fixture tests before claiming proven  
6. UI clinic tabs last  

---

## Handover

- **MERGE_HOLD** wholesale. **Cherry-pick USE list** (~6 files + pipeline hunks).
- Tests: 66/66 synthetic on refill; **zero** integration test on `SC-0915-LD0F` or live Comfy/AuK.
- Biggest merge hazard: `assertNoOuterGap` vs crew `gapSec` spine + forced prose validation on live slates.
- Parent bullets below.
