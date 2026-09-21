# ComfyUI workflows

## h3-r2v.api.json — C-form golden (§5b, CFORM_0921)

Golden graph of the MiniMax H3 reference-to-video **C-form** — the motion-shot
production recipe (E2E SC-0921-9V4Y SH01.c8, tg 17976): `<Video 1>` blockout
motion-only, zero H3Keyframes nodes, `ref_images.ref_image_0` = the angle
portrait, `BINDINGS_CFORM` on the split node, 8-step turbo v1.0 with **zero
FBC/SolAttn** (the accel patch is hard-locked to the 4-step schedule; §5b
B1v3: 8-step LoRA + FBC crashes structurally, tensor 17428≠17418).

Regenerated from the builder (never exported from ComfyUI):

```sh
bun run -e 'import fs from "node:fs"; const {buildH3Graph,BINDINGS_CFORM}=await import("./src/lib/studio/h3-r2v-graph"); const {defaultConfig}=await import("./src/lib/studio/config"); const m={textEncoder:defaultConfig.motion.textEncoder,encoderType:"minimax",videoVae:defaultConfig.motion.videoVae,audioVae:defaultConfig.motion.audioVae,ref2va:defaultConfig.motion.checkpoint,fl2va:defaultConfig.motion.fl2va,turboLora:defaultConfig.motion.turboLora}; fs.writeFileSync("workflows/h3-r2v.api.json", JSON.stringify(buildH3Graph({script:"__PROMPT__",bindings:BINDINGS_CFORM,frames:260,steps:8,seed:42,filenamePrefix:"video/SLATECREW/__SHOT__",blockoutName:"__VIDEO__",refImageNames:["__PORTRAIT_A__"],wavName:"__AUDIO__",models:m}),null,2)+"\n")'
```

The runtime source of truth is `src/lib/studio/h3-r2v-graph.ts`
(`buildH3Graph`); `h3-r2v-graph.test.ts` deep-equals the builder against this
file. **Runtime never reads this file.** Do not export ComfyUI templates over
it — regenerate only via the builder.

## h3-r2v-still2video.api.json — A-form golden (§5b keyframes lane)

The no-Video-1 shape: H3Keyframes anchors 0%/100% on the U1.5 stills
(`__KF_START__`/`__KF_END__`), zero ref_images, `BINDINGS` names the stills,
same 8-step no-FBC chain. `H3Keyframes × <Video 1>` in one graph is the §5b
model-level double exposure — the builder refuses to emit it
(`keyframes_video1_coexist`); these two goldens are the only legal variant-a
shapes.

Shared placeholders: `__PROMPT__` (prose script), `__VIDEO__` (blockout
upload name), `__PORTRAIT_A__` (angle portrait upload name), `__AUDIO__` (wav
upload name), `video/SLATECREW/__SHOT__` (filename prefix); generated at
frames=260, steps=8, seed=42.

## History

Pre-CFORM_0921 this file held the v6-parity coexistence graph (keyframes two
ends × Video 1, FBC at all step counts) exported from shotdag's
`build_graph`. That shape is dead per §5b (4/8/20步全滅) — the golden is now
builder-generated per form above.

## u15-t2i.api.json — retained, unwired

Kept for a future ComfyUI stills lane. The active stills lane is U1.5 `/edit`
on node0 (`src/lib/studio/u15-edit.ts`); this workflow is not wired into the
pipeline.
