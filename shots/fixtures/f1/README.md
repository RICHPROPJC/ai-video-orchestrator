# F1 live headless fixture

From repository root, with Blender 5.1.2 and CPU FFmpeg installed:

```sh
LIBGL_ALWAYS_SOFTWARE=1 GALLIUM_DRIVER=llvmpipe blender -b -t 2 --python-exit-code 1 -P shots/fixtures/f1/headless.py > shots/fixtures/f1/headless.log 2>&1
python3 shots/fixtures/f1/verify.py
./node_modules/.bin/tsc --noEmit --strict --skipLibCheck --target ES2020 --moduleResolution bundler --module esnext src/lib/blender/index.ts
```

`frame.png`, `blockout.mp4`, `hero-matte.mp4`, `extras-matte.mp4` are generated
locally by the vendored executor, not backfilled. `observation.json` records
Blender version, scene observation, source-restoration checks and artifact SHA256s.
`qc.json` records decoded-video checks: six 320×180 frames at 6 fps, nonempty
and distinct masks, color agreement, foreground occlusion, binary interiors,
animated hero and static extras, matching artifact hashes.

This build fixture has no production event_id/trace_id and makes no production
output claim. The headless log records the actual Blender version.

Repository-wide `npm run typecheck` is blocked by existing errors outside F1:
missing LayoutProps, bun:test types, loadBaseCast, ProduceInput/JobRecord drama
and episode fields, and PortraitResult.kept. The isolated F1 typecheck is the
scope-specific check; no other lane files are changed.
