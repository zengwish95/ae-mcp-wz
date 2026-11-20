// Finding After Effects without talking to it (no Automation permission needed), and reading its
// scripting pref from the prefs file on disk (SPIKE.md Q2, Q5).
import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AppState, ScriptingPref } from "./types.ts";

const exec = promisify(execFile);
export const AE_BUNDLE_ID = "com.adobe.AfterEffects.application";

async function out(cmd: string, args: string[]): Promise<string> {
  try {
    return (await exec(cmd, args, { encoding: "utf8", timeout: 10_000 })).stdout.trim();
  } catch {
    return "";
  }
}

export async function bundleVersion(appPath: string): Promise<string> {
  return out("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", join(appPath, "Contents", "Info.plist")]);
}

// lsappinfo answers locally; it never launches the app and needs no Automation permission.
export async function runningApp(): Promise<{ pid: number; path: string } | undefined> {
  return parseLsappinfo(await out("/usr/bin/lsappinfo", ["info", "-only", "bundlepath", "-only", "pid", "-app", AE_BUNDLE_ID]));
}

// Older macOS prints `"LSBundlePath"="…"` and `"pid"=123`; newer prints `bundle path="…"` and `pid = 123`.
// A closed app prints nothing.
export function parseLsappinfo(info: string): { pid: number; path: string } | undefined {
  const path = /(?:"LSBundlePath"|\bbundle path)\s*=\s*"([^"]+)"/.exec(info)?.[1];
  const pid = Number(/(?:"pid"|\bpid)\s*=\s*(\d+)/.exec(info)?.[1]);
  return path && pid ? { pid, path } : undefined;
}

export async function findAppState(): Promise<AppState> {
  const paths = (await out("/usr/bin/mdfind", [`kMDItemCFBundleIdentifier == '${AE_BUNDLE_ID}'`])).split("\n").filter((p) => p.endsWith(".app"));
  const installed = await Promise.all(paths.map(async (path) => ({ path, version: await bundleVersion(path) })));
  const running = await runningApp();
  if (!running) return { installed, running: false };
  return { installed, running: true, ...running, version: installed.find((i) => i.path === running.path)?.version ?? (await bundleVersion(running.path)) };
}

// "26.5.0" → the prefs folder "26.5". Without a version, the newest 26.x folder is used.
export function readScriptingPref(prefsRoot: string, version?: string): ScriptingPref {
  let folder = version ? version.split(".").slice(0, 2).join(".") : undefined;
  if (!folder) {
    try {
      folder = readdirSync(prefsRoot)
        .filter((d) => /^26\.\d+$/.test(d))
        .sort((a, b) => Number(a.split(".")[1]) - Number(b.split(".")[1]))
        .pop();
    } catch {
      return { enabled: undefined };
    }
  }
  if (!folder) return { enabled: undefined };
  const file = join(prefsRoot, folder, `Adobe After Effects ${folder} Prefs.txt`);
  try {
    const m = /"Pref_SCRIPTING_FILE_NETWORK_SECURITY" = "(\d)"/.exec(readFileSync(file, "latin1"));
    return { enabled: m ? m[1] === "1" : undefined, file };
  } catch {
    return { enabled: undefined, file };
  }
}
