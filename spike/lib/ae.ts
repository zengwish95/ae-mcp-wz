// Spike-only bridge helpers: osascript → After Effects `DoScriptFile`.
// Not production code; Phase 1 rewrites this as src/bridge.
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export const AE_BUNDLE_ID = "com.adobe.AfterEffects.application";
export const AE_2026_PATH = "/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app";

// How the AppleScript `tell` addresses After Effects.
export type Target =
  | { kind: "id"; value: string }
  | { kind: "name"; value: string }
  | { kind: "path"; value: string };

export const DEFAULT_TARGET: Target = { kind: "id", value: AE_BUNDLE_ID };

export interface OsaResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  ms: number;
  killed: boolean;
}

function asLiteral(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

// The target value is passed as argv item 2 (never interpolated), so the app is resolved at run time:
// no compile-time terminology lookup and no "Where is …?" chooser for a missing app.
function tellTarget(t: Target): string {
  return t.kind === "id" ? "application id (item 2 of argv)" : "application (item 2 of argv)";
}

// Runs AppleScript source with argv; never interpolates argv into the source.
export function osa(source: string, args: string[] = [], killAfterMs = 600_000): Promise<OsaResult> {
  const started = performance.now();
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/osascript",
      ["-e", source, ...args],
      { timeout: killAfterMs, maxBuffer: 256 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
        resolve({
          ok: !e,
          stdout: stdout.replace(/\n$/, ""),
          stderr: stderr.trim(),
          code: e ? (typeof e.code === "number" ? e.code : null) : 0,
          ms: Math.round(performance.now() - started),
          killed: Boolean(e?.killed),
        });
      },
    );
  });
}

export interface DoScriptOptions {
  target?: Target;
  timeoutSec?: number; // AppleEvent reply timeout (`with timeout of`)
  override?: boolean; // DoScriptFile's "override" parameter
  mode?: "file" | "text"; // DoScriptFile vs DoScript
}

// Raw event codes («event miscfile» = DoScriptFile, «event miscdosc» = DoScript, «class Over» = override)
// so the script compiles without needing AE's dictionary for a particular app name.
function doScriptSource(o: DoScriptOptions): string {
  const target = tellTarget(o.target ?? DEFAULT_TARGET);
  const timeout = o.timeoutSec ?? 120;
  const event = o.mode === "text" ? "«event miscdosc» (item 1 of argv)" : "«event miscfile» (POSIX file (item 1 of argv))";
  const given = o.override ? " given «class Over»:true" : "";
  return [
    "on run argv",
    `  with timeout of ${timeout} seconds`,
    `    tell ${target}`,
    `      return ${event}${given}`,
    "    end tell",
    "  end timeout",
    "end run",
  ].join("\n");
}

export function doScriptFile(path: string, o: DoScriptOptions = {}): Promise<OsaResult> {
  return osa(doScriptSource({ ...o, mode: "file" }), [path, (o.target ?? DEFAULT_TARGET).value]);
}

export function doScriptText(code: string, o: DoScriptOptions = {}): Promise<OsaResult> {
  return osa(doScriptSource({ ...o, mode: "text" }), [code, (o.target ?? DEFAULT_TARGET).value]);
}

export interface TempScript {
  path: string;
  dir: string;
  cleanup(): void;
}

// Per-user temp dir ($TMPDIR on macOS is per-user), private 0700 dir, file 0600.
export function writeTempScript(code: string, opts: { bom?: boolean } = {}): TempScript {
  const dir = mkdtempSync(join(tmpdir(), "ae-motion-spike-"));
  const path = join(dir, "script.jsx");
  writeFileSync(path, (opts.bom ? "\uFEFF" : "") + code, { encoding: "utf8", mode: 0o600 });
  return { path, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export async function runJsx(code: string, o: DoScriptOptions & { bom?: boolean } = {}): Promise<OsaResult> {
  const tmp = writeTempScript(code, { bom: o.bom ?? true });
  try {
    return await doScriptFile(tmp.path, o);
  } finally {
    tmp.cleanup();
  }
}

export interface WrapOptions {
  undo?: string; // undo group name; omit for read-only
  suppressDialogs?: boolean;
  resultPath?: string; // where the script writes its JSON result (see SPIKE.md Q1: DoScriptFile only returns "0"/"1")
  settingsNonce?: string; // also/instead return the result through app.settings + saveToDisk (no file-write pref needed)
  settingsKey?: string; // defaults to SETTINGS_KEY; override calls use their own key so they cannot clobber the running call's result
  evalFile?: string; // if set, the body is loaded with $.evalFile(evalFile) inside try/catch (catches syntax errors)
}

// AE 2026 ExtendScript (4.5.6) has a native JSON object, so no polyfill is needed.
// Envelope: run `body` (which must `return` a value) inside try/catch, optional undo group and
// dialog suppression; the JSON result {ok, value | error} is written to `resultPath`.
export function wrap(body: string, o: WrapOptions = {}): string {
  const run = o.evalFile ? `$.evalFile(${JSON.stringify(o.evalFile)})` : `(function () {\n${body}\n})()`;
  return [
    "(function () {",
    "  var __out;",
    o.suppressDialogs ? "  app.beginSuppressDialogs();" : "",
    o.undo ? `  app.beginUndoGroup(${JSON.stringify(o.undo)});` : "",
    "  try {",
    `    var __v = ${run};`,
    "    __out = JSON.stringify({ ok: true, value: __v === undefined ? null : __v });",
    "  } catch (e) {",
    "    __out = JSON.stringify({ ok: false, error: { name: String(e.name), message: String(e.message), line: e.line, number: e.number, source: e.source ? String(e.source).slice(0, 200) : null } });",
    "  } finally {",
    o.undo ? "    app.endUndoGroup();" : "",
    o.suppressDialogs ? "    app.endSuppressDialogs(false);" : "",
    "  }",
    // Never throw past this point: an uncaught error here would open a modal dialog in AE.
    o.resultPath
      ? `  try { var __f = new File(${JSON.stringify(o.resultPath)}); __f.encoding = "UTF-8"; if (__f.open("w")) { __f.write(__out); __f.close(); } } catch (__e) {}`
      : "",
    o.settingsNonce
      ? `  try { app.settings.saveSetting(${JSON.stringify(SETTINGS_SECTION)}, ${JSON.stringify(o.settingsKey ?? SETTINGS_KEY)}, ${JSON.stringify(o.settingsNonce + ":")} + encodeURIComponent(__out)); app.preferences.saveToDisk(); } catch (__e) {}`
      : "",
    "  return __out;",
    "})();",
  ].join("\n");
}

export const SETTINGS_SECTION = "ae-motion-spike";
export const SETTINGS_KEY = "last-result";
export const AE_PREFS_FILE = join(homedir(), "Library/Preferences/Adobe/After Effects/26.5/Adobe After Effects 26.5 Prefs.txt");

// Reads `"key" = "…"` from section ["Settings_<section>"] of AE's prefs file. Long values are
// wrapped as `"part"\<CR><TAB><TAB>"part"`; the value is URI-encoded, so it holds no quotes.
export function readSettingFromPrefsFile(section = SETTINGS_SECTION, key = SETTINGS_KEY, file = AE_PREFS_FILE): string | undefined {
  const text = readFileSync(file, "latin1");
  const start = text.indexOf(`["Settings_${section}"]`);
  if (start < 0) return undefined;
  const end = text.indexOf("\r[", start + 1);
  const body = text.slice(start, end < 0 ? undefined : end);
  const m = new RegExp(String.raw`"${key}" = ((?:"[^"]*"\\\r\t+)*"[^"]*")`).exec(body);
  if (!m) return undefined;
  return [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]).join("");
}

export interface CallResult<T> {
  raw: OsaResult;
  parsed?: { ok: boolean; value?: T; error?: any };
  resultBytes?: number;
}

// One round-trip: write wrapper (+ optional separate body file) to a private temp dir,
// DoScriptFile it, read the JSON result file, delete everything.
export async function call<T = unknown>(
  body: string,
  o: Omit<WrapOptions, "resultPath" | "evalFile" | "settingsNonce"> & DoScriptOptions & { useEvalFile?: boolean; channel?: "file" | "settings" } = {},
): Promise<CallResult<T> & { channel: "file" | "settings" }> {
  const channel = o.channel ?? "file";
  const nonce = randomUUID();
  const settingsKey = o.override ? SETTINGS_KEY + "-override" : SETTINGS_KEY;
  const dir = mkdtempSync(join(tmpdir(), "ae-motion-spike-"));
  const resultPath = join(dir, "result.json");
  const bodyPath = join(dir, "body.jsx");
  const wrapperPath = join(dir, "wrapper.jsx");
  try {
    if (o.useEvalFile) writeFileSync(bodyPath, "\uFEFF(function () {\n" + body + "\n})();", { encoding: "utf8", mode: 0o600 });
    const wrapped = wrap(body, { ...o, evalFile: o.useEvalFile ? bodyPath : undefined, ...(channel === "file" ? { resultPath } : { settingsNonce: nonce, settingsKey }) });
    writeFileSync(wrapperPath, "\uFEFF" + wrapped, { encoding: "utf8", mode: 0o600 });
    const raw = await doScriptFile(wrapperPath, o);
    let parsed;
    let resultBytes;
    let text: string | undefined;
    if (channel === "file" && existsSync(resultPath)) text = readFileSync(resultPath, "utf8");
    if (channel === "settings") {
      const v = readSettingFromPrefsFile(SETTINGS_SECTION, settingsKey);
      if (v?.startsWith(nonce + ":")) text = decodeURIComponent(v.slice(nonce.length + 1));
    }
    if (text !== undefined) {
      resultBytes = Buffer.byteLength(text);
      try {
        parsed = JSON.parse(text);
      } catch {
        /* caller inspects raw */
      }
    }
    return { raw, parsed, resultBytes, channel };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function isRunning(bundleId = AE_BUNDLE_ID): Promise<boolean> {
  // `application id … is running` is answered by the OSA runtime locally: no launch, no Automation prompt.
  const r = await osa(`return application id ${asLiteral(bundleId)} is running`);
  return r.stdout === "true";
}

export function log(label: string, data: unknown): void {
  console.log(`\n## ${label}\n` + (typeof data === "string" ? data : JSON.stringify(data, null, 2)));
}

export function summarize(r: OsaResult, max = 300): Record<string, unknown> {
  return {
    ok: r.ok,
    ms: r.ms,
    code: r.code,
    stdout: r.stdout.length > max ? r.stdout.slice(0, max) + `… (${r.stdout.length} chars)` : r.stdout,
    stderr: r.stderr,
    killed: r.killed,
  };
}
