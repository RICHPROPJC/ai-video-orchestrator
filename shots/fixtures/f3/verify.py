"""Independent Pillow/ffprobe receipt check (ordinary Python, outside Blender)."""
from pathlib import Path
import hashlib
import json
import subprocess
from PIL import Image

OUT = Path(__file__).resolve().parent
qc = json.loads((OUT / "qc.json").read_text())
results = json.loads((OUT / "results.json").read_text())
for relative, digest in qc["artifacts"].items():
    assert hashlib.sha256((OUT / relative).read_bytes()).hexdigest() == digest, relative
for name, result in results.items():
    if "expected" not in result:
        continue
    assert result["ok"] is result["expected"]
    path = OUT / name / "blockout.mp4"
    if result["ok"]:
        info = json.loads(subprocess.check_output([
            "ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0",
            "-show_entries", "stream=width,height,nb_read_frames,r_frame_rate", "-of", "json", str(path),
        ]))["streams"][0]
        assert (info["width"], info["height"], info["nb_read_frames"], info["r_frame_rate"]) == (320, 180, "5", "6/1")
        subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-f", "null", "-"], check=True)
    else:
        assert not path.exists(), name
    observation = result["observation"]
    pixels = observation["pixelEvidence"]
    if pixels:
        mask_path = OUT / name / "blockout.camera" / "hero-mask.png"
        assert hashlib.sha256(mask_path.read_bytes()).hexdigest() == pixels["sha256"]
        with Image.open(mask_path) as image:
            image = image.convert("L")
            width, height = image.size
            points = [(i % width, i // width) for i, value in enumerate(image.getdata()) if value >= 128]
        assert len(points) == pixels["pixelCount"]
        centroid = [(sum(p[0] for p in points)/len(points)+0.5)/width,
                    (sum(p[1] for p in points)/len(points)+0.5)/height] if points else None
        assert centroid == observation["hero"]["screenPos"]
assert results["shot4_bad"]["ok"] is False and results["shot4_fixed"]["ok"] is True
assert qc["blender"] == "5.1.2"
print(f"PASS: {len(results)} cases; artifact hashes, decoded MP4s, rejected-output absence, independent PIL centroids")
