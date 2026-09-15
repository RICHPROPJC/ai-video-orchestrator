import test from "node:test";
import assert from "node:assert/strict";
import { sshPasswordOptional, sshPassword } from "./scp-upload";

test("sshPasswordOptional resolves (env or vimax secrets.env)", () => {
  const pw = sshPasswordOptional();
  assert.ok(typeof pw === "string" && pw.length > 0);
  assert.equal(sshPassword().length, pw!.length);
});

test("env SLATECREW beats secrets file", () => {
  const prev = process.env.SLATECREW_SSH_PASS;
  process.env.SLATECREW_SSH_PASS = "env-wins-test";
  try {
    assert.equal(sshPasswordOptional(), "env-wins-test");
  } finally {
    if (prev !== undefined) process.env.SLATECREW_SSH_PASS = prev;
    else delete process.env.SLATECREW_SSH_PASS;
  }
});
