"""Decode receipt videos; fail on empty, swapped, overlapping or unoccluded mattes."""
from pathlib import Path
import hashlib
import json
import subprocess

OUT = Path(__file__).resolve().parent
WIDTH, HEIGHT, FRAMES = 320, 180, 6

def decode(name):
    path = OUT / name
    meta = json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0",
        "-show_entries", "stream=width,height,nb_read_frames,r_frame_rate", "-of", "json", str(path),
    ]))["streams"][0]
    assert (meta["width"], meta["height"], int(meta["nb_read_frames"]), meta["r_frame_rate"]) == (WIDTH, HEIGHT, FRAMES, "6/1"), meta
    raw = subprocess.check_output(["ffmpeg", "-v", "error", "-i", str(path), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
    assert len(raw) == WIDTH * HEIGHT * FRAMES * 3
    return [raw[i:i+WIDTH*HEIGHT*3] for i in range(0, len(raw), WIDTH*HEIGHT*3)]

blockout, hero, extras = [decode(name) for name in ("blockout.mp4", "hero-matte.mp4", "extras-matte.mp4")]
counts = []
for b, h, e in zip(blockout, hero, extras):
    hp = {i//3 for i in range(0, len(h), 3) if min(h[i:i+3]) > 240}
    ep = {i//3 for i in range(0, len(e), 3) if min(e[i:i+3]) > 240}
    red = {i//3 for i in range(0, len(b), 3) if b[i] > 1.4*b[i+1] and b[i] > 1.4*b[i+2] and b[i] > 100}
    blue = {i//3 for i in range(0, len(b), 3) if b[i+2] > 1.4*b[i] and b[i+2] > 1.3*b[i+1] and b[i+2] > 100}
    green = {i//3 for i in range(0, len(b), 3) if b[i+1] > 1.4*b[i] and b[i+1] > 1.4*b[i+2] and b[i+1] > 100}
    assert len(hp) > 100 and len(ep) > 100 and len(green) > 100
    assert not hp & ep
    assert len(hp & red) / len(hp) > 0.9
    assert len(ep & blue) / len(ep) > 0.9
    assert len(hp & green) / len(green) < 0.02
    assert sum(p % WIDTH for p in hp)/len(hp) < sum(p % WIDTH for p in ep)/len(ep)
    # Nearly all pixels must be black or white (only antialiased boundaries intermediate).
    for mask in (h, e):
        assert sum(v < 15 or v > 240 for v in mask) / len(mask) > 0.98
    counts.append({"hero": len(hp), "extras": len(ep)})
assert hero[0] != hero[-1], "animated mask did not move"
assert extras[0] == extras[-1], "static extras mask changed"
receipt = json.loads((OUT / "observation.json").read_text())
for name, digest in receipt["artifacts"].items():
    assert hashlib.sha256((OUT / name).read_bytes()).hexdigest() == digest
checks = ["video_dimensions_fps_frames", "nonempty_distinct_masks", "mask_matches_material_color", "foreground_occlusion", "binary_masks", "animated_hero_static_extras", "artifact_hashes"]
(OUT / "qc.json").write_text(json.dumps({"verdict": "PASS", "checks": checks, "pixel_counts": counts}, indent=2) + "\n")
print("PASS: " + ", ".join(checks))
