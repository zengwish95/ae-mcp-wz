import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { AuditLog, summarizeArgs } from "../src/audit.ts";
import { LOCK_BUSY, withLock } from "../src/bridge/lock.ts";
import { isPathAllowed, loadPolicy } from "../src/policy.ts";
import { tempPaths } from "./helpers.ts";

test("default policy allows imports from the home folder only", () => {
  const p = tempPaths();
  try {
    const pol = loadPolicy(p);
    assert.equal(pol.source, "default");
    mkdirSync(join(p.home, "Desktop"), { recursive: true });
    writeFileSync(join(p.home, "Desktop", "logo.png"), "x");
    assert.ok(isPathAllowed(join(p.home, "Desktop", "logo.png"), pol.importFolders));
    assert.ok(!isPathAllowed("/etc/hosts", pol.importFolders));
    assert.ok(!isPathAllowed(join(p.home, "..", "elsewhere.png"), pol.importFolders));
    assert.ok(!isPathAllowed("relative/logo.png", pol.importFolders));
    writeFileSync(join(p.home, "..dotted.png"), "x");
    assert.ok(isPathAllowed(join(p.home, "..dotted.png"), pol.importFolders));
  } finally {
    p.cleanup();
  }
});

test("symlinks out of an allowed folder are refused", () => {
  const p = tempPaths();
  try {
    mkdirSync(join(p.home, "assets"), { recursive: true });
    symlinkSync("/etc/hosts", join(p.home, "assets", "sneaky.png"));
    const pol = loadPolicy(p);
    assert.ok(!isPathAllowed(join(p.home, "assets", "sneaky.png"), pol.importFolders));
  } finally {
    p.cleanup();
  }
});

test("user policy narrows folders; machine policy wins; malformed policy fails closed", () => {
  const p = tempPaths();
  try {
    mkdirSync(p.appSupport, { recursive: true });
    writeFileSync(p.userPolicy, JSON.stringify({ importFolders: ["~/Movies/AE Motion"], disabledTools: ["delete_items"] }));
    const user = loadPolicy(p);
    assert.equal(user.source, "user");
    assert.deepEqual(user.disabledTools, ["delete_items"]);
    assert.ok(user.importFolders[0].endsWith(join("Movies", "AE Motion")));

    writeFileSync(p.machinePolicy, JSON.stringify({ importFolders: [] }));
    assert.equal(loadPolicy(p).source, "machine");
    assert.deepEqual(loadPolicy(p).importFolders, []);

    writeFileSync(p.machinePolicy, JSON.stringify({ importFolder: ["~"] })); // typo: unknown key
    const bad = loadPolicy(p);
    assert.ok(bad.error);
    assert.deepEqual(bad.importFolders, []);

    // A malformed policy keeps the tools it switches off switched off.
    writeFileSync(p.machinePolicy, JSON.stringify({ importFolder: ["~"], disabledTools: ["delete_items", 3] }));
    assert.deepEqual(loadPolicy(p).disabledTools, ["delete_items"]);
  } finally {
    p.cleanup();
  }
});

test("audit log appends summarized JSON lines, private to the user", () => {
  const p = tempPaths();
  try {
    const log = new AuditLog(p.auditLog);
    log.write({ tool: "animate", client: "test 1", args: { long: "x".repeat(500), many: Array.from({ length: 50 }, (_, i) => i) }, ms: 12, status: "ok" });
    log.write({ tool: "create_comp", args: {}, ms: 3, status: "error", error: "not_running" });
    const lines = readFileSync(p.auditLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].args.many, "[50 items]");
    assert.match(lines[0].args.long, /… \(500 chars\)$/);
    assert.equal(lines[1].error, "not_running");
    assert.equal(statSync(p.auditLog).mode & 0o777, 0o600);
  } finally {
    p.cleanup();
  }
  assert.deepEqual(summarizeArgs({ a: [1, 2] }), { a: [1, 2] });
});

test("lock: busy while held, stale locks from dead processes are taken over", async () => {
  const p = tempPaths();
  try {
    mkdirSync(p.runDir, { recursive: true });
    const lock = join(p.runDir, "lock");
    let inner: unknown;
    await withLock(lock, 0, async () => {
      inner = await withLock(lock, 50, async () => "second");
    });
    assert.equal(inner, LOCK_BUSY);
    writeFileSync(lock, "999999"); // no such process
    assert.equal(await withLock(lock, 0, async () => "taken"), "taken");
  } finally {
    p.cleanup();
  }
});
