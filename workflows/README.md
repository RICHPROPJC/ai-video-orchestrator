# ComfyUI workflows (API format)

Default generation is **your local Comfy at http://127.0.0.1:8188**. No extra wrapper.

1. Open ComfyUI as you already do.
2. `Workflow → Browse Templates → Video → MiniMax H3` (I2V) and SenseNova U1.5 T2I.
3. `File → Export (API)` and replace these JSON files, **keeping** the `__PROMPT__` / `__CKPT__` / `__IMAGE__` tokens (or add them on the prompt and checkpoint widgets).
4. Swap checkpoints in `slatecrew.config.json` or `npm run slatecrew -- models set stills.checkpoint YourFile.safetensors`.

Official references:

- MiniMax H3 templates: https://github.com/Comfy-Org/workflow_templates
- SenseNova U1.5 nodes: https://github.com/OpenSenseNova/ComfyUI-SenseNova-U1
- Comfy API: POST `/prompt` → poll `/history/{id}` → GET `/view`
