"""Regenerate combat-fixtures/python-presets.json from the real h3studio module.

Read-only against /mnt/ssd/h3studio. The TS preset registry (combat-presets.ts)
must deep-equal this fixture — every family entry verbatim.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, "/mnt/ssd/h3studio")

import prompt_presets as pp  # noqa: E402

anchor = __import__("subprocess").run(
    ["git", "-C", "/mnt/ssd/h3studio", "rev-parse", "HEAD"],
    capture_output=True, text=True, check=True).stdout.strip()

out = {
    "source": "prompt_presets.py",
    "h3studio_commit": anchor,
    "families": {
        "CREATIVE_BRIEF_PRESETS": pp.CREATIVE_BRIEF_PRESETS,
        "VISUAL_STYLE_PRESETS": pp.VISUAL_STYLE_PRESETS,
        "TRANSITION_STYLE_PRESETS": pp.TRANSITION_STYLE_PRESETS,
        "CONSTRAINT_PRESETS": pp.CONSTRAINT_PRESETS,
        "SOUNDSCAPE_PRESETS": pp.SOUNDSCAPE_PRESETS,
        "MUSIC_PRESETS": pp.MUSIC_PRESETS,
    },
    "shot_recommendations": pp.SHOT_RECOMMENDATIONS,
    "marker_recommendations": pp.MARKER_RECOMMENDATIONS,
}

dest = Path("src/lib/studio/combat-fixtures/python-presets.json")
dest.write_text(json.dumps(out, ensure_ascii=False, indent=1, sort_keys=True) + "\n",
                encoding="utf-8")
print(f"wrote {dest}: 6 families, sizes",
      [len(v) for v in out["families"].values()], f"(h3studio @ {anchor[:8]})")
