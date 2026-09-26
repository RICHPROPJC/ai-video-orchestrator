import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  preflightGate,
  brokenBulletsIn,
  playbookFiles,
  gpuFreeMiBNvidiaSmi,
  DEFAULT_MIN_FREE_MIB,
} from "./gates";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-gate-"));
const seats = path.join(tmp, "seats"); // 淨放好檔
const seatsBad = path.join(tmp, "seats-bad"); // 爛 bullet 檔喺呢度
const projects = path.join(tmp, "projects");

const GOOD = `- [g1] schema.missing field=sceneId saw=undefined rule=頂層 key 唔准加斜線。 hits=3 status=proven src=grave1
chau 手寫 note 行（raw，合法）
`;
const BAD = `- [w1] schema.enum field=language saw=auto rule=唔准 auto。 hits=1 status=trial src=grave2
- 這行以 bullet 開頭但唔過 BULLET_RE（爛 bullet）
- [w2] schema.missing field=x saw=y rule=z hits=not-a-number status=trial src=w
`;

function write(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

test("gates: 好 playbook 過驗（raw 手寫行唔當 bullet）", () => {
  write(path.join(seats, "writer.primitive.md"), GOOD);
  write(path.join(seats, "boards.primitive.md"), "- [b1] schema.array field=shots saw=2 rule=beats 要有 beatId。 hits=1 status=trial src=g\n");
  const ok = preflightGate({ seatsDir: seats, projectsDir: projects, skipRigProbe: true });
  assert.equal(ok.playbook.length, 2);
  assert.ok(ok.playbook[0]!.includes("1 bullet"));
});

test("gates: 爛 bullet 即 throw——帶檔：行＋收據句", () => {
  write(path.join(seatsBad, "all.primitive.md"), BAD);
  assert.throws(
    () => preflightGate({ seatsDir: seatsBad, projectsDir: projects, skipRigProbe: true }),
    (e: Error) => {
      const m = e.message;
      return (
        /preflight fail/.test(m) &&
        /all\.primitive\.md:2/.test(m) &&
        /all\.primitive\.md:3/.test(m) &&
        /DTQH\/BEQ5\/OLHR/.test(m)
      );
    },
  );
  const broken = brokenBulletsIn(path.join(seatsBad, "all.primitive.md"));
  assert.deepEqual(broken.map((b) => b.line), [2, 3]);
});

test("gates: drama playbook 檔都入驗（projects/<drama>/playbook/<scope>.md）", () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "wb-gate-d-"));
  try {
    const s2 = path.join(fresh, "seats");
    write(path.join(s2, "writer.primitive.md"), GOOD);
    write(
      path.join(fresh, "projects", "guojia-lingdaoren", "playbook", "writer.md"),
      "- [w104] arithmetic.clock field=scenes.targetSec saw=15.0s rule=targetSec 加埋要對 slate。 hits=2 status=proven src=x\n- 爛行 drama 檔\n",
    );
    const files = playbookFiles({ seatsDir: s2, projectsDir: path.join(fresh, "projects"), drama: "guojia-lingdaoren" });
    assert.equal(files.length, 2);
    assert.throws(
      () => preflightGate({ seatsDir: s2, projectsDir: path.join(fresh, "projects"), drama: "guojia-lingdaoren", skipRigProbe: true }),
      /writer\.md:2/,
    );
  } finally {
    fs.rmSync(fresh, { recursive: true, force: true });
  }
});

test("gates: skintokens GPU build＋free VRAM 過 floor——過", () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "wb-gate-r-"));
  try {
    const binDir = path.join(fresh, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const bin = path.join(binDir, "skintokens-cli");
    fs.writeFileSync(bin, "#!/bin/sh\n");
    fs.writeFileSync(path.join(binDir, "libggml-cuda.so"), "elf");
    const ok = preflightGate({
      seatsDir: seats,
      projectsDir: projects,
      skintokensBin: bin,
      gpuFreeMiB: () => 8192,
    });
    assert.ok(ok.rig.some((l) => l.includes("GPU build")));
    assert.ok(ok.rig.some((l) => l.includes("8192MiB")));
  } finally {
    fs.rmSync(fresh, { recursive: true, force: true });
  }
});

test("gates: 冇 libggml-cuda.so＝CPU build——唔開工（1KU5 死法閘）", () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "wb-gate-c-"));
  try {
    const binDir = path.join(fresh, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const bin = path.join(binDir, "skintokens-cli");
    fs.writeFileSync(bin, "#!/bin/sh\n");
    assert.throws(
      () => preflightGate({ seatsDir: seats, projectsDir: projects, skintokensBin: bin, gpuFreeMiB: () => 8192 }),
      /libggml-cuda\.so/,
    );
  } finally {
    fs.rmSync(fresh, { recursive: true, force: true });
  }
});

test("gates: free VRAM 375MiB < floor——唔開工（1KU5 實數）", () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "wb-gate-v-"));
  try {
    const binDir = path.join(fresh, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const bin = path.join(binDir, "skintokens-cli");
    fs.writeFileSync(bin, "#!/bin/sh\n");
    fs.writeFileSync(path.join(binDir, "libggml-cuda.so"), "elf");
    assert.throws(
      () => preflightGate({ seatsDir: seats, projectsDir: projects, skintokensBin: bin, gpuFreeMiB: () => 375 }),
      (e: Error) => /375MiB < floor/.test(e.message) && /1KU5/.test(e.message),
    );
    assert.equal(DEFAULT_MIN_FREE_MIB, 1536);
  } finally {
    fs.rmSync(fresh, { recursive: true, force: true });
  }
});

test("gates: bin 唔存在／量唔到卡——都係 fail-loud", () => {
  assert.throws(
    () => preflightGate({ seatsDir: seats, projectsDir: projects, skintokensBin: "/nope/skintokens-cli" }),
    /bin 唔存在/,
  );
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "wb-gate-n-"));
  try {
    const binDir = path.join(fresh, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const bin = path.join(binDir, "skintokens-cli");
    fs.writeFileSync(bin, "#!/bin/sh\n");
    fs.writeFileSync(path.join(binDir, "libggml-cuda.so"), "elf");
    assert.throws(
      () => preflightGate({ seatsDir: seats, projectsDir: projects, skintokensBin: bin, gpuFreeMiB: () => null }),
      /量唔到 free VRAM/,
    );
  } finally {
    fs.rmSync(fresh, { recursive: true, force: true });
  }
});

test("gates: 兩閘同 throw——一次睇晒所有死因", () => {
  assert.throws(
    () =>
      preflightGate({
        seatsDir: seatsBad, // all.primitive.md 仲爛緊
        projectsDir: projects,
        skintokensBin: "/nope/skintokens-cli",
      }),
    (e: Error) => {
      const m = e.message;
      return /preflight fail（\d+ 項/.test(m) && /爛 bullet/.test(m) && /bin 唔存在/.test(m);
    },
  );
});

test("gates: nvidia-smi 量法存在（真機冇卡返 null 唔爆）", () => {
  const n = gpuFreeMiBNvidiaSmi();
  assert.ok(n === null || n > 0);
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});
