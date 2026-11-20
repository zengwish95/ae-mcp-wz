// The real bridge: osascript → After Effects `DoScriptFile` (DESIGN.md §3, SPIKE.md Q1–Q4).
// One call at a time (in-process queue + cross-process lock); never launches AE implicitly.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bodyFile, WRAPPER } from "../jsx/index.ts";
import type { Paths } from "../paths.ts";
import { AE_BUNDLE_ID, bundleVersion, findAppState, readScriptingPref, runningApp } from "./ae-app.ts";
import { LOCK_BUSY, withLock } from "./lock.ts";
import { classify, type RawRun, type StartedMarker, type WrapperResult } from "./outcome.ts";
import { BridgeError, FIXES, SUPPORTED_MAJOR, type AppState, type Bridge, type BridgeRequest, type BridgeResult, type ScriptingPref } from "./types.ts";

// argv: wrapper path, AppleEvent timeout. The `is running` check is answered locally, so a call to a
// closed AE returns "not-running" instead of launching it (any AppleEvent would launch it).
const APPLESCRIPT = `on run argv
  if application id "${AE_BUNDLE_ID}" is not running then return "not-running"
  with timeout of ((item 2 of argv) as integer) seconds
    tell application id "${AE_BUNDLE_ID}"
      return «event miscfile» (POSIX file (item 1 of argv))
    end tell
  end timeout
end run`;

const CALL_FILES = ["request.json", "body.jsx", "result.json", "started.json"];

export interface OsascriptBridgeOptions {
  defaultTimeoutSec?: number;
  lockWaitMs?: number;
}

export class OsascriptBridge implements Bridge {
  readonly runDir: string;
  private readonly paths: Paths;
  private readonly defaultTimeoutSec: number;
  private readonly lockWaitMs: number;
  private tail: Promise<unknown> = Promise.resolve();
  private checked?: { pid: number; version: string };
  // Set when a call was stopped by AE mid-script: the next call closes the undo group it left open.
  private staleUndo = false;

  constructor(paths: Paths, opts: OsascriptBridgeOptions = {}) {
    this.paths = paths;
    this.runDir = paths.runDir;
    this.defaultTimeoutSec = opts.defaultTimeoutSec ?? 60;
    this.lockWaitMs = opts.lockWaitMs ?? 15_000;
  }

  run<T = unknown>(req: BridgeRequest): Promise<BridgeResult<T>> {
    const next = this.tail.then(() => this.runNow<T>(req));
    this.tail = next.catch(() => undefined);
    return next;
  }

  appState(): Promise<AppState> {
    return findAppState();
  }

  scriptingPref(version?: string): ScriptingPref {
    return readScriptingPref(this.paths.aePrefsRoot, version);
  }

  // Opens AE (`open -b` needs no Automation permission) and waits until it runs a script.
  async launch(timeoutMs = 180_000): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      execFile("/usr/bin/open", ["-b", AE_BUNDLE_ID], (e) => (e ? reject(new BridgeError("not_installed", "Could not open After Effects.", { fix: FIXES.not_installed })) : resolve())),
    );
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        // DoScriptFile waits for AE to finish starting (12.9 s in the spike), so one long call is enough.
        await this.run({ tool: "launch", body: "return true;", timeoutSec: Math.max(10, Math.round((deadline - Date.now()) / 1000)) });
        return;
      } catch (e) {
        if (!(e instanceof BridgeError) || e.code !== "not_running" || Date.now() > deadline) throw e;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  private async checkVersion(): Promise<string> {
    const st = await runningApp();
    if (!st) throw new BridgeError("not_running", "After Effects isn't running.", { fix: FIXES.not_running });
    if (this.checked?.pid !== st.pid) {
      const version = await bundleVersion(st.path);
      if (Number(version.split(".")[0]) !== SUPPORTED_MAJOR) {
        throw new BridgeError("wrong_version", `The running After Effects is version ${version || "unknown"}, but ae-motion supports After Effects 2026 (26.x).`, { fix: FIXES.wrong_version });
      }
      this.checked = { pid: st.pid, version };
    }
    return this.checked.version;
  }

  private prepareRunDir(): void {
    mkdirSync(this.runDir, { recursive: true, mode: 0o700 });
    chmodSync(this.runDir, 0o700);
    const wrapper = join(this.runDir, "wrapper.jsx");
    if (!existsSync(wrapper) || readFileSync(wrapper, "utf8") !== WRAPPER) writeFileSync(wrapper, WRAPPER, { mode: 0o600 });
    this.sweep();
  }

  // Leftovers from a call that was killed (the spike found one); also run before every call.
  // Captured frames are deleted by capture_frame itself; old ones are left from killed calls.
  private sweep(): void {
    for (const f of CALL_FILES) rmSync(join(this.runDir, f), { force: true, recursive: true });
    for (const f of readdirSync(this.runDir)) {
      if (/^frame-.*\.png$/.test(f) && Date.now() - statSync(join(this.runDir, f)).mtimeMs > 10 * 60_000) rmSync(join(this.runDir, f), { force: true });
    }
  }

  private async runNow<T>(req: BridgeRequest): Promise<BridgeResult<T>> {
    const started = performance.now();
    const version = await this.checkVersion();
    const timeoutSec = req.timeoutSec ?? this.defaultTimeoutSec;
    mkdirSync(this.runDir, { recursive: true, mode: 0o700 });
    const got = await withLock(join(this.runDir, "lock"), this.lockWaitMs, async () => {
      this.prepareRunDir();
      const id = randomUUID();
      const closeStaleUndo = this.staleUndo;
      this.staleUndo = false;
      try {
        const { raw, result, started } = await this.once(id, bodyFile(req.body), { id, undo: req.undo ?? null, args: req.args ?? {}, closeStaleUndo }, timeoutSec);
        let revisionAfter: number | undefined;
        if (result === undefined && started?.id === id) {
          // Stopped mid-script. Its undo group may still be open, and whether it changed the project
          // is unknown: ask AE for the revision with a tiny read-only call.
          this.staleUndo = true;
          revisionAfter = await this.revision();
        }
        const pref = result === undefined ? this.scriptingPref(version).enabled : undefined;
        return classify(raw, result, id, pref, timeoutSec, started, revisionAfter);
      } finally {
        this.sweep();
      }
    });
    if (got === LOCK_BUSY) throw new BridgeError("busy_elsewhere", "Another ae-motion session is using After Effects.", { fix: FIXES.busy_elsewhere });
    return { value: got.value as T, changedProject: got.changedProject, aeVersion: got.aeVersion, ms: Math.round(performance.now() - started) };
  }

  // One DoScriptFile round trip: writes the request and body, runs the wrapper, reads its files.
  private async once(id: string, body: string, request: Record<string, unknown>, timeoutSec: number): Promise<{ raw: RawRun; result?: WrapperResult; started?: StartedMarker }> {
    for (const f of CALL_FILES) rmSync(join(this.runDir, f), { force: true, recursive: true });
    const opts = { encoding: "utf8" as const, mode: 0o600 };
    writeFileSync(join(this.runDir, "request.json"), JSON.stringify(request), opts);
    writeFileSync(join(this.runDir, "body.jsx"), body, opts);
    const raw = await this.osascript(timeoutSec);
    return { raw, result: readJson<WrapperResult>(join(this.runDir, "result.json")), started: readJson<StartedMarker>(join(this.runDir, "started.json")) };
  }

  // The project revision, or undefined if AE can't answer right now.
  private async revision(): Promise<number | undefined> {
    const id = randomUUID();
    try {
      const { result } = await this.once(id, bodyFile("return app.project.revision;"), { id, undo: null, args: {}, closeStaleUndo: false }, 10);
      return result?.id === id && result.ok && typeof result.value === "number" ? result.value : undefined;
    } catch {
      return undefined;
    }
  }

  private osascript(timeoutSec: number): Promise<RawRun> {
    return new Promise((resolve) => {
      execFile(
        "/usr/bin/osascript",
        ["-e", APPLESCRIPT, join(this.runDir, "wrapper.jsx"), String(timeoutSec)],
        { encoding: "utf8", timeout: (timeoutSec + 10) * 1000, maxBuffer: 16 * 1024 * 1024 },
        (e, stdout, stderr) => {
          const err = e as (Error & { code?: number | string; killed?: boolean }) | null;
          resolve({ exitCode: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr: stderr.trim(), killed: Boolean(err?.killed) });
        },
      );
    });
  }
}

function readJson<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}
