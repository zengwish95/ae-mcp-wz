// The bridge runs one ExtendScript call in After Effects and returns its JSON value.
// Errors carry a stable code and a plain-English fix (shown to the agent, who relays it to the user).

export type BridgeErrorCode =
  | "not_installed"
  | "not_running"
  | "wrong_version"
  | "permission_denied" // macOS Automation permission missing (-1743)
  | "pref_disabled" // "Allow Scripts to Write Files and Access Network" is off: no result file
  | "not_run" // AE replied "1" without running the script: busy (another script/render) or a dialog is open
  | "timeout" // AppleEvent timed out (-1712); AE may still be working
  | "connection_lost" // AE quit or crashed during the call (-609)
  | "busy_elsewhere" // another ae-motion process holds the lock
  | "no_result" // AE ran the script but no result came back, for an unknown reason
  | "script_aborted" // AE started the script but it never reported back (stopped mid-script, or the result could not be written)
  | "script_error" // the ExtendScript threw; `aeMessage` has After Effects' message
  | "not_found"
  | "invalid_argument"
  | "animated" // a static value was set on a property that has keyframes
  | "osascript_failed";

export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  readonly fix?: string;
  readonly changedProject: boolean; // the call changed the project before failing (changes are left in place)
  readonly detail?: unknown;
  constructor(code: BridgeErrorCode, message: string, opts: { fix?: string; changedProject?: boolean; detail?: unknown } = {}) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.fix = opts.fix;
    this.changedProject = opts.changedProject ?? false;
    this.detail = opts.detail;
  }
}

export interface BridgeRequest {
  tool: string; // for logs
  body: string; // ExtendScript function body; receives ARGS and the AEM helpers, must `return` plain data
  args?: unknown; // JSON, read by the wrapper from request.json (never spliced into code)
  undo?: string; // undo group name; omit for read-only calls
  timeoutSec?: number;
}

export interface BridgeResult<T = unknown> {
  value: T;
  changedProject: boolean;
  aeVersion: string;
  ms: number;
}

export interface AppState {
  installed: { path: string; version: string }[];
  running: boolean;
  pid?: number;
  path?: string;
  version?: string; // e.g. "26.5.0" from the running app's Info.plist
}

export interface Bridge {
  run<T = unknown>(req: BridgeRequest): Promise<BridgeResult<T>>;
  appState(): Promise<AppState>;
  launch(timeoutMs?: number): Promise<void>;
  scriptingPref(version?: string): ScriptingPref;
  runDir: string; // where a call may ask AE to write files (e.g. captured frames)
}

export interface ScriptingPref {
  enabled: boolean | undefined; // undefined: prefs file not found or unreadable
  file?: string;
}

export const SUPPORTED_MAJOR = 26;

export const FIXES: Partial<Record<BridgeErrorCode, string>> = {
  not_installed: "Install Adobe After Effects 2026 from the Creative Cloud app.",
  not_running: "Open Adobe After Effects 2026 and try again (or call check_setup with launch: true).",
  wrong_version: "This tool supports After Effects 2026. Quit the other version and open After Effects 2026.",
  permission_denied:
    "macOS is blocking control of After Effects. Open System Settings > Privacy & Security > Automation, find the app you are using (for example Claude, Terminal, Cursor or Codex) and turn on \"Adobe After Effects 2026\". Then try again.",
  pref_disabled:
    "In After Effects, open Settings > Scripting & Expressions and turn on \"Allow Scripts to Write Files and Access Network\". Then try again.",
  not_run:
    "After Effects didn't run the command. It is probably busy (rendering or running another script) or showing a dialog. Ask the user to check After Effects, close any open dialog or wait for the render to finish, and send nothing else to After Effects until they say it's clear: each extra command can add another dialog.",
  timeout: "After Effects didn't answer in time. It may still be working, or a dialog may be waiting. Ask the user to check After Effects before sending anything else; don't retry in a loop.",
  connection_lost: "After Effects quit or crashed during the command. Reopen it (it may offer to recover the project), then call check_setup.",
  script_aborted:
    "After Effects started the script but stopped before it could report back. Dialogs were suppressed, so After Effects should be free. Don't retry the same call: inspect the comp or layer to see what state it is in, then change the request (for example a different property or layer type).",
  busy_elsewhere: "Another ae-motion session is using After Effects right now. Wait for it to finish, then try again.",
};
