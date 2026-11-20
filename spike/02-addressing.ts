// Spike Q2: how to address the right After Effects when several versions may be installed.
// Usage: node spike/02-addressing.ts
// Note: only AE 2026 is installed on the spike machine; the 2025 cases test the "missing" path.
import { execFileSync } from "node:child_process";
import { AE_2026_PATH, AE_BUNDLE_ID, call, isRunning, log, osa, summarize, type Target } from "./lib/ae.ts";

function sh(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: "utf8" }).trim();
  } catch (e) {
    return `ERROR: ${(e as Error).message.split("\n")[0]}`;
  }
}

// 1. Discovery without talking to AE (no Automation permission involved)
const installs = sh("/usr/bin/mdfind", [`kMDItemCFBundleIdentifier == '${AE_BUNDLE_ID}'`]).split("\n").filter(Boolean);
log(
  "installed apps with the AE bundle id (Spotlight)",
  installs.map((p) => ({
    path: p,
    version: sh("/usr/bin/defaults", ["read", `${p}/Contents/Info`, "CFBundleShortVersionString"]),
    bundleId: sh("/usr/bin/defaults", ["read", `${p}/Contents/Info`, "CFBundleIdentifier"]),
  })),
);
log("running instance (lsappinfo)", sh("/usr/bin/lsappinfo", ["info", "-only", "bundlepath", "-only", "pid", "-app", AE_BUNDLE_ID]));
log("is running (OSA, no event sent)", await isRunning());

// 2. Each addressing form, asking AE to identify itself
const targets: [string, Target][] = [
  ["bundle id", { kind: "id", value: AE_BUNDLE_ID }],
  ["app name 2026", { kind: "name", value: "Adobe After Effects 2026" }],
  ["POSIX path 2026", { kind: "path", value: AE_2026_PATH }],
  ["app name 2025 (not installed)", { kind: "name", value: "Adobe After Effects 2025" }],
  ["path 2025 (not installed)", { kind: "path", value: "/Applications/Adobe After Effects 2025/Adobe After Effects 2025.app" }],
  ["render engine path (different bundle id)", { kind: "path", value: "/Applications/Adobe After Effects 2026/Adobe After Effects Render Engine 2026.app" }],
];
for (const [label, target] of targets) {
  if (label.startsWith("render engine")) {
    // Do not send it a script (that would launch it); only check whether it is a separate app id.
    log(label, { bundleId: sh("/usr/bin/defaults", ["read", `${target.value}/Contents/Info`, "CFBundleIdentifier"]) });
    continue;
  }
  const r = await call("return { version: app.version, build: app.buildNumber, path: Folder.appPackage.fsName };", { target, timeoutSec: 30 });
  log(label, { ...summarize(r.raw), parsed: r.parsed });
}

// 3. What `application id` resolves to when not running (path LaunchServices would launch)
log("LaunchServices default for the bundle id", (await osa(`return POSIX path of (path to application id "${AE_BUNDLE_ID}")`)).stdout);
