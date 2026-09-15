# F3 camera gate — live Blender 5.1.2 receipt

This is a synthetic reconstruction of the documented Shot4 failure, not a
backfill of its original footage: HeroRig and CamTarget are at x=38, while the
actual hero mesh stays at x=0. The bad camera looks at CamTarget; the fixed camera
uses `camera.frame` on HeroRig's evaluated child meshes. The reference KB file
was not present in the searched local trees; the A7 camera contract supplies
the failure geometry and acceptance rule.

`results.json` contains observations and verdicts. `qc.json` records the live
Blender version, cases, and SHA256s. Each render attempt has a
`<case>/blockout.camera/observation.json`; cases with geometry also have the
frame and selected-hero mask PNG. Only passing attempts produce `blockout.mp4`.
The fixed Shot4 fixture additionally exercises F1's matte MP4 and mask PNG tools.
These are build fixtures: event_id/trace_id are not applicable and no production
output is claimed.

Cases cover displaced proxy targets, repair by hero mesh framing, a second
pass-index 2 decoy, foreground occlusion, render-hidden blockers, shifted framing
despite a correct aim vector, constrained camera transforms, mutation after a
pass, midpoint vs current-frame selection, evaluated mesh/rig following,
`camera.frame` occlusion reporting, missing hero masks, and missing Pillow.

From repository root, use the same Blender 5.1.2 installation for rendering and
installing its Python dependency. Set `BLENDER_PYTHON` to that installation's
bundled Python (3.13 in this run):

```sh
"$BLENDER_PYTHON" -m pip install --target shots/fixtures/f3/.deps -r blender_addon/requirements.txt
LIBGL_ALWAYS_SOFTWARE=1 GALLIUM_DRIVER=llvmpipe blender -b -t 2 --python-exit-code 1 -P shots/fixtures/f3/headless.py > shots/fixtures/f3/headless.log 2>&1
python3 shots/fixtures/f3/verify.py
./node_modules/.bin/tsx --test src/lib/blender/observe.test.ts
./node_modules/.bin/tsc --noEmit --strict --skipLibCheck --target ES2020 --moduleResolution bundler --module esnext src/lib/blender/index.ts src/lib/blender/observe.test.ts
```

The fixture loads `.deps` locally; that directory is ignored, and the executor
has no machine-specific runtime imports. The independent verifier uses ordinary
Python with Pillow plus ffprobe/ffmpeg. It recomputes the PNG centroids, verifies
artifact hashes, decodes accepted MP4s (320×180, five frames at 6 fps), and asserts
that rejected attempts have no movie. TypeScript tests compare its verdicts to
every live Python receipt and reject stale or incomplete pixel evidence.

The geometry checks are advisory; the PIL screen-position check is mandatory.
Tests do not claim whole-shot visibility or production event integration. The
repository-wide typecheck failures recorded in the F1 receipt remain outside
this lane; the isolated Blender TypeScript check covers this change.
