# ComfyUI workflows

## h3-r2v.api.json — golden parity fixture

Golden graph of the MiniMax H3 reference-to-video chain, generated ONCE from
shotdag's proven-green `build_graph` (single shot, zero ref_images, turbo LoRA,
SolAttn+FBC+SigmaShift, H3EpisodeSplit prose, H3KeyframeInject start pin):

```sh
python3 -c "import sys,json;sys.path.insert(0,'/mnt/ssd/shotdag');from shotdag.h3_submit import build_graph,BINDINGS;print(json.dumps(build_graph(script='__PROMPT__',bindings=BINDINGS,frames=260,steps=4,filename_prefix='video/SLATECREW/__SHOT__',kf_start_name='__KF_START__',kf_end_name='__KF_END__',blockout_name='__VIDEO__',wav_name='__AUDIO__'),indent=2))" > workflows/h3-r2v.api.json
```

The runtime source of truth is `src/lib/studio/h3-r2v-graph.ts`
(`buildH3Graph`); `h3-r2v-graph.test.ts` deep-equals the builder against this
file. **Runtime never reads this file.** Do not export ComfyUI templates over
it — regenerate only via the one-liner above.

Placeholders: `__PROMPT__` (prose script), `__KF_START__` / `__KF_END__`
(keyframe upload names), `__VIDEO__` (blockout upload name), `__AUDIO__` (wav
upload name), `video/SLATECREW/__SHOT__` (filename prefix); generated at
frames=260, steps=4, seed=42.

## u15-t2i.api.json — retained, unwired

Kept for a future ComfyUI stills lane. The active stills lane is U1.5 `/edit`
on node0 (`src/lib/studio/u15-edit.ts`); this workflow is not wired into the
pipeline.
