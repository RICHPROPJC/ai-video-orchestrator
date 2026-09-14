# F1 headless render tools

Vendored from `chau-ch/blender-ai-control` commit
`6c4d9044e28bc803faca746f2a01425245f8bd41`:
`types.ts` and the `TOOL_CATALOG` declaration extracted from `engine.ts`.
Python dependencies: `executor.py`, `world.py`, `skills.py`; package initializer
is intentionally headless. No reference checkout, server, planner or UI is needed
at runtime. F1 adds only render handlers/catalog entries and material viewport colors.

Import `TOOL_CATALOG` from this directory. Dispatch Python calls through
`astra.executor.run_call({"tool": name, "args": args})` with the repository's
`blender_addon` directory on Python's import path.

| Tool | Required args | Optional args |
| --- | --- | --- |
| `render.frame` | `path` ending `.png` | `frame`, `width`, `height` |
| `render.animation` | `path` ending `.mp4` | `frameStart`, `frameEnd`, `fps`, `width`, `height` |
| `render.matte` | `path` ending `.mp4`, `mask` | same as animation |

Omitted dimensions/timing use the current scene. Frame ranges are inclusive;
MP4 dimensions must be even. An active camera is required. Invalid arguments and
render/encoder failures raise exceptions; success returns the actual output path
in the dispatch result's `message`. FFmpeg with CPU `libx264` must be on PATH.

All renders use WORKBENCH, FLAT lighting and MATERIAL colors. Workbench does not
provide an IndexOB render pass: mattes select geometry by `object.pass_index`,
assign temporary white target / black occluder materials, and use a black world.
Legend: set=1, hero=2, extras=3, door=4, ocean=5, cams=6, sky=8. Matte boundaries
are antialiased; MP4 uses lossless H.264 encoding with YUV420 conversion. This is
an object-index silhouette, not a transparent-material or volumetric matte.
Scene settings, current frame, geometry and material slots are restored on exit.

Receipt and rerun commands: `shots/fixtures/f1/README.md`. Camera acceptance gates
belong to F3; this commit does not implement or claim them.
