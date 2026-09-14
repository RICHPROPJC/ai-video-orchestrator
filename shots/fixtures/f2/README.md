# F2 stance port and parity receipt

All five new actions are implemented in CharacterAction, Zod and world.py:
lie, kneel, crouch, lean, turn_away. `results.json` records live Blender 5.1.2
transform comparisons and five Astra blockouts with every camera check passing.
`qc.json` records dHash distances using the repository's existing
`frameHashes/hamming` helper and artifact SHA256s.

| Action | vs copied historical C5 f0 | vs regenerated frozen C5 math |
| --- | --- | --- |
| lie | 2 | 0 |
| kneel | 1 | 0 |
| crouch | missing | 0 |
| lean | missing | 0 |
| turn_away | missing | 0 |

The required threshold is ≤4. Full historical acceptance remains blocked on
`crouch.f0.png`, `lean.f0.png`, and `turn_away.f0.png`. The supplied C5 directory
contains lie/kneel/sit frames and scripts only. `reference/` preserves those
files unchanged; `reference-manifest.json` records their SHA256s. Generated frames
live separately in `regenerated-c5/`; they are not labelled historical receipts.

`legacy_fixture.py` is the copied C5 lie script with only its final `main()` call
removed so the fixture can import the authored functions. The reference original
is preserved alongside its hash. For the comparison, the fixture constructs the
same C5 mannequin and placement, tags its parts, and applies either the frozen
C5 math or the new typed action. It preserves C5's factory camera aspect during
unprojection before switching to the 864×480 render size. This isolates stance
math from the different Astra character proportions and uses FLAT+MATERIAL.

The runtime test separately spawns each normal Astra character, applies the typed
action twice (idempotence), frames evaluated hero meshes, and renders a gated
320×180 MP4 (three frames at 6 fps). It checks pose changes after walking and
moving, rest-scale restoration, and rejection of an invented action.

From repository root, with Blender 5.1.2 and the F3 Pillow dependency installed:

```sh
LIBGL_ALWAYS_SOFTWARE=1 GALLIUM_DRIVER=llvmpipe blender -b -t 2 --python-exit-code 1 -P shots/fixtures/f2/headless.py > shots/fixtures/f2/headless.log 2>&1
./node_modules/.bin/tsx shots/fixtures/f2/verify.ts
./node_modules/.bin/tsx --test src/lib/blender/stances.test.ts src/lib/blender/plan.test.ts
```

The verifier exits nonzero on a measured parity failure; it writes
`BLOCKED_MISSING_HISTORICAL_REFERENCES` when comparisons pass but historical
reference files are absent. These are build fixtures, not production outputs;
event_id/trace_id are not applicable. Neither the original reference checkout
nor external C5 files are runtime dependencies.
