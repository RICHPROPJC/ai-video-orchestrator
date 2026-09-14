# F4 spec / plan boundary receipt

`GET /spec` exposes JSON Schema generated from the Zod schemas used by
`validatePlan`. All catalog tools have strict authoring schemas. Model plans expose only
coordinate-free calls and named relational operations; numeric transforms remain
inside authored factories and skill expansions. The five playbook identities/intent aliases were extracted from the
read-only reference commit `6c4d9044e28bc803faca746f2a01425245f8bd41`; no prompt
compiler or new F5 playbook was copied. The 19 skill expansions mirror the
vendored Python skill definitions and are validated before dispatch.

`malformed.json` contains exactly ten rejected plans. `qc.json` records their
named failures, **zero executor calls, zero Blender processes, zero bpy calls**,
and artifact SHA256s. The same dispatcher then runs a coordinate-free valid batch through
Blender 5.1.2 as a positive control: `headless.json`, `headless.log`, the midpoint
frame/mask/observation in `blockout.camera/`, and `blockout.mp4` are live outputs.
The positive control is counted separately from the malformed plans.

Run from repository root, with Blender 5.1.2 and the F3 Pillow dependency installed:

```sh
./node_modules/.bin/tsx --test src/lib/blender/plan.test.ts
FORGE_BLENDER=blender ./node_modules/.bin/tsx shots/fixtures/f4/receipt.ts
./node_modules/.bin/tsc --noEmit --strict --skipLibCheck --target ES2020 --moduleResolution bundler --module esnext --resolveJsonModule --esModuleInterop src/lib/blender/index.ts src/lib/blender/plan.test.ts src/app/spec/route.ts shots/fixtures/f4/receipt.ts
```

Tests invoke the actual GET route handler and verify its response/schema parity;
they do not start a production server. This fixture never calls produce or model
services. Production event_id/trace_id are not applicable.
