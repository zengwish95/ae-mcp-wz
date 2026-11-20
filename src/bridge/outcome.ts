// Turns one osascript run + the result file into a value or a BridgeError (SPIKE.md Q1, Q4, Q5).
import { BridgeError, FIXES, type BridgeErrorCode } from "./types.ts";

export interface RawRun {
  exitCode: number; // osascript exit code (0 = AppleScript succeeded)
  stdout: string; // "0" / "1" from DoScriptFile, or "not-running" from our pre-check
  stderr: string;
  killed: boolean; // Node killed osascript after the hard deadline
}

export interface WrapperResult {
  id: string | null;
  ok: boolean;
  value?: unknown;
  changed?: boolean;
  aeVersion?: string;
  error?: { code?: string; message?: string; name?: string; line?: number; detail?: unknown };
}

// Written by the wrapper right before it runs the tool body (see wrapper.jsx).
export interface StartedMarker {
  id: string | null;
  revision?: number; // app.project.revision before the body ran
}

export interface Classified {
  value: unknown;
  changedProject: boolean;
  aeVersion: string;
}

const APPLE_EVENT_ERRORS: Record<string, BridgeErrorCode> = {
  "-1712": "timeout",
  "-1743": "permission_denied",
  "-600": "not_running",
  "-609": "connection_lost",
  "-1728": "not_installed",
  "-10814": "not_installed",
};

const SCRIPT_CODES = new Set<BridgeErrorCode>(["not_found", "invalid_argument", "animated"]);

function err(code: BridgeErrorCode, message: string, extra: { changedProject?: boolean; detail?: unknown } = {}) {
  return new BridgeError(code, message, { fix: FIXES[code], ...extra });
}

// `prefEnabled` is consulted only to explain a missing result file. `started` is the wrapper's marker
// for this call, if one was written; `revisionAfter` is the project revision read after an aborted run.
export function classify(
  run: RawRun,
  result: WrapperResult | undefined,
  expectedId: string,
  prefEnabled: boolean | undefined,
  timeoutSec: number,
  started?: StartedMarker,
  revisionAfter?: number,
): Classified {
  if (run.killed) throw err("timeout", `After Effects didn't answer within ${timeoutSec} s.`);
  if (run.exitCode !== 0) {
    const n = /\((-?\d+)\)\s*$/.exec(run.stderr)?.[1];
    const code = (n && APPLE_EVENT_ERRORS[n]) || "osascript_failed";
    const message = code === "timeout" ? `After Effects didn't answer within ${timeoutSec} s.` : `Could not talk to After Effects: ${run.stderr || `osascript exited with ${run.exitCode}`}`;
    throw err(code, message);
  }
  const reply = run.stdout.trim();
  if (reply === "not-running") throw err("not_running", "After Effects isn't running.");

  if (result === undefined) {
    // The wrapper started the body but never wrote a result: AE stopped the script before it could
    // report back (an internal error, or the result file couldn't be written). Not "busy".
    if (started && started.id === expectedId) {
      const known = revisionAfter !== undefined && started.revision !== undefined && started.revision >= 0;
      const changedProject = known ? revisionAfter !== started.revision : true;
      const message = known
        ? `After Effects stopped the command before it could report back${changedProject ? " after it had changed the project" : " before it changed anything"}.`
        : "After Effects stopped the command before it could report back. It may have changed the project before stopping.";
      throw err("script_aborted", message, { changedProject });
    }
    if (reply === "1") throw err("not_run", "After Effects did not run the command.");
    if (prefEnabled === false) throw err("pref_disabled", "After Effects ran the command but could not return the result, because scripts are not allowed to write files.");
    throw err("no_result", `After Effects ran the command but no result came back (reply "${reply}").`);
  }
  if (result.id !== expectedId) throw err("no_result", "After Effects returned a result for a different request; please try again.");

  const changedProject = result.changed === true;
  if (!result.ok) {
    const e = result.error ?? {};
    const code: BridgeErrorCode = e.code && SCRIPT_CODES.has(e.code as BridgeErrorCode) ? (e.code as BridgeErrorCode) : "script_error";
    throw new BridgeError(code, e.message ?? "After Effects reported an error.", { changedProject, detail: e.detail });
  }
  return { value: result.value ?? null, changedProject, aeVersion: result.aeVersion ?? "" };
}
