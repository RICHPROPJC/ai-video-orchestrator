# F1 headless render tools

Vendored from `chau-ch/blender-ai-control` commit
`6c4d9044e28bc803faca746f2a01425245f8bd41`:
`types.ts` and the `TOOL_CATALOG` declaration extracted from `engine.ts`.
Python dependencies: `executor.py`, `world.py`, `skills.py`; package initializer
is intentionally headless. No reference checkout, server, planner or UI is needed
at runtime. F1 added render handlers/catalog entries and material viewport colors;
F3 adds the evaluated camera observation and mandatory pixel gate.

Import `TOOL_CATALOG` from this directory. Dispatch Python calls through
`astra.executor.run_call({"tool": name, "args": args})` with the repository's
`blender_addon` directory on Python's import path.

| Tool | Required args | Optional args |
| --- | --- | --- |
| `render.frame` | `path` ending `.png` | `frame`, `width`, `height`, `mask` |
| `render.animation` | `path` ending `.mp4` | `frameStart`, `frameEnd`, `fps`, `width`, `height` |
| `render.matte` | `path` ending `.mp4`, `mask` | same as animation |

Omitted dimensions/timing use the current scene. Frame ranges are inclusive;
MP4 dimensions must be even. An active camera is required. Invalid arguments and
render/encoder failures raise exceptions; success returns the actual output path
in the dispatch result's `message`. Camera-gate rejection returns `ok=false`,
the observation and checks, and writes no new MP4. FFmpeg with CPU `libx264`
must be on PATH. Blender's Python also needs `blender_addon/requirements.txt`.

All renders use WORKBENCH, FLAT lighting and MATERIAL colors. Workbench does not
provide an IndexOB render pass: mattes select geometry by `object.pass_index`,
assign temporary white target / black occluder materials, and use a black world.
Legend: set=1, hero=2, extras=3, door=4, ocean=5, cams=6, sky=8. Matte boundaries
are antialiased; MP4 uses lossless H.264 encoding with YUV420 conversion. This is
an object-index silhouette, not a transparent-material or volumetric matte.
Scene settings, current frame, geometry and material slots are restored on exit.

## F3 camera gate

`camera.mode follow=<rig>` and `camera.frame {follow?: string}` resolve only
pass-index 2 meshes beneath the selected rig. Geometry bounds and camera forward
vectors use the evaluated depsgraph. Without a follow selection, exactly one
hero root must exist; missing or ambiguous heroes fail. `camera.frame` returns
its geometry observation and checks, including intervening mesh ray hits.

Every `render.animation` performs a fresh check at
`floor((frameStart + frameEnd) / 2)` at the requested output resolution. Beside
the MP4 it writes `<stem>.camera/{frame.png,hero-mask.png,observation.json}`.
The mask whites only the selected hero meshes, even if another object also has
pass_index 2. Pillow counts pixels >=128 and measures their centroid in normalized
image coordinates (origin top-left). At least 16 pixels and both coordinates in
the inclusive central region [0.25, 0.75] are required. Missing Pillow fails with
`pillow_unconfigured`; no caller-provided verdict or prior receipt authorizes a run.

`observe` and `runChecks` in TypeScript consume the Blender observation, not a
planner's abstract scene. `hero.screenPos` stays null without pixel evidence;
`camera.occluded` is null when unmeasured. `camera_aimed_at_hero` (15° tolerance)
and `camera_occluded` are advisory geometry checks; `hero_on_screen` is the
required animation gate, as specified by the camera contract. A successful
`camera_occluded` check means **unoccluded**. Python remains the execution gate;
TypeScript reports receipt measurements and checks for downstream consumers.

F3 checks the midpoint, not visibility throughout a shot. Existing output files
are left untouched on a rejected retry; consumers must use the returned verdict
and fresh observation rather than file existence. First-person views that cannot
show the hero do not bypass this gate. F4 schema/planner integration is separate.

Receipts and rerun commands: `shots/fixtures/f1/README.md` (historical F1) and
`shots/fixtures/f3/README.md` (current gate and render regression).
