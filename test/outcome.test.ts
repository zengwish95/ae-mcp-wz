import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, type RawRun } from "../src/bridge/outcome.ts";
import { BridgeError } from "../src/bridge/types.ts";

const ok: RawRun = { exitCode: 0, stdout: "0\n", stderr: "", killed: false };
const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    assert.ok(e instanceof BridgeError);
    return { code: e.code, fix: e.fix, changed: e.changedProject, detail: e.detail };
  }
  assert.fail("expected an error");
};

test("a matching ok result returns its value", () => {
  const r = classify(ok, { id: "a", ok: true, value: { x: 1 }, changed: true, aeVersion: "26.5x89" }, "a", true, 60);
  assert.deepEqual(r, { value: { x: 1 }, changedProject: true, aeVersion: "26.5x89" });
});

test("AppleScript errors map to codes with fixes", () => {
  assert.equal(code(() => classify({ ...ok, exitCode: 1, stdout: "", stderr: "94:140: execution error: Adobe After Effects 2026 got an error: AppleEvent timed out. (-1712)" }, undefined, "a", true, 5))!.code, "timeout");
  const denied = code(() => classify({ ...ok, exitCode: 1, stdout: "", stderr: "execution error: Not authorized to send Apple events to Adobe After Effects 2026. (-1743)" }, undefined, "a", true, 5))!;
  assert.equal(denied.code, "permission_denied");
  assert.match(denied.fix!, /Automation/);
  assert.equal(code(() => classify({ ...ok, exitCode: 1, stdout: "", stderr: "got an error: Connection is invalid. (-609)" }, undefined, "a", true, 5))!.code, "connection_lost");
  assert.equal(code(() => classify({ ...ok, exitCode: 1, stdout: "", stderr: "weird" }, undefined, "a", true, 5))!.code, "osascript_failed");
  assert.equal(code(() => classify({ ...ok, killed: true, exitCode: 1 }, undefined, "a", true, 5))!.code, "timeout");
});

test("our not-running guard", () => {
  assert.equal(code(() => classify({ ...ok, stdout: "not-running\n" }, undefined, "a", true, 5))!.code, "not_running");
});

test('reply "1" without a result means AE did not run it (busy or dialog)', () => {
  const e = code(() => classify({ ...ok, stdout: "1\n" }, undefined, "a", true, 5))!;
  assert.equal(e.code, "not_run");
  assert.match(e.fix!, /dialog/);
});

test('reply "0" without a result is pref_disabled when the pref is off, else no_result', () => {
  assert.equal(code(() => classify(ok, undefined, "a", false, 5))!.code, "pref_disabled");
  assert.equal(code(() => classify(ok, undefined, "a", true, 5))!.code, "no_result");
  assert.equal(code(() => classify(ok, undefined, "a", undefined, 5))!.code, "no_result");
});

test("a stale result for another request is rejected", () => {
  assert.equal(code(() => classify(ok, { id: "old", ok: true, value: 1 }, "new", true, 5))!.code, "no_result");
});

test("script errors keep AE's message, our codes, detail and the changed flag", () => {
  const e = code(() => classify(ok, { id: "a", ok: false, changed: true, error: { code: "not_found", message: "No layer 9", detail: { s: 1 } } }, "a", true, 5))!;
  assert.deepEqual(e, { code: "not_found", fix: undefined, changed: true, detail: { s: 1 } });
  assert.equal(code(() => classify(ok, { id: "a", ok: false, error: { code: "bogus", message: "x" } }, "a", true, 5))!.code, "script_error");
});

test("a started marker without a result means AE stopped the script (not busy)", () => {
  const started = { id: "a", revision: 7 };
  const same = code(() => classify({ ...ok, stdout: "1\n" }, undefined, "a", true, 5, started, 7))!;
  assert.equal(same.code, "script_aborted");
  assert.equal(same.changed, false);
  assert.match(same.fix!, /Don't retry/);
  assert.equal(code(() => classify({ ...ok, stdout: "1\n" }, undefined, "a", true, 5, started, 9))!.changed, true);
  // Revision unknown: assume it may have changed.
  assert.equal(code(() => classify(ok, undefined, "a", true, 5, started))!.changed, true);
  // A marker from another request is ignored: still "not run".
  assert.equal(code(() => classify({ ...ok, stdout: "1\n" }, undefined, "a", true, 5, { id: "old", revision: 1 }, 1))!.code, "not_run");
});

test("lsappinfo output is parsed in both the old and the new macOS format", async () => {
  const { parseLsappinfo } = await import("../src/bridge/ae-app.ts");
  const app = "/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app";
  assert.deepEqual(parseLsappinfo(`"LSBundlePath"="${app}"\n"pid"=6965`), { pid: 6965, path: app });
  const modern = `[ NULL ]  ASN:0x0-0x1418417: \n    bundleID=[ NULL ] \n    bundle path="${app}"\n    executable path=[ NULL ] \n    pid = 6965 !cgsConnection !signalled type=[ NULL ]`;
  assert.deepEqual(parseLsappinfo(modern), { pid: 6965, path: app });
  assert.equal(parseLsappinfo(""), undefined);
});
