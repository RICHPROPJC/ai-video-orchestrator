"""Positive control for the validated batch boundary: fixed script, JSON data only."""
from pathlib import Path
import json
import sys

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "blender_addon"))
sys.path.insert(0, str(ROOT / "shots/fixtures/f3/.deps"))
import bpy
from astra.executor import run_call

args = sys.argv[sys.argv.index("--") + 1:]
calls_path, receipt_path = map(Path, args)
calls = json.loads(calls_path.read_text())
results = []
for call in calls:
    result = run_call(call)
    results.append(result)
    if not result["ok"]:
        break
receipt = {"ok": len(results) == len(calls) and all(r["ok"] for r in results),
           "blender": bpy.app.version_string, "bpyCalls": len(results), "results": results,
           "receipt_kind": "live_headless_positive_control"}
receipt_path.write_text(json.dumps(receipt, indent=2) + "\n")
assert receipt["ok"], receipt
