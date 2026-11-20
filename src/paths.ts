// File locations (DESIGN.md §8). Every path can be redirected with AE_MOTION_* env vars (used by tests).
import { homedir } from "node:os";
import { join } from "node:path";

export interface Paths {
  home: string;
  appSupport: string; // settings, policy, run dir
  runDir: string; // stable wrapper + per-call request/body/result files
  userPolicy: string;
  machinePolicy: string; // for every user of this Mac; wins over the user policy when present
  logDir: string;
  auditLog: string;
  framesDir: string;
  aePrefsRoot: string; // ~/Library/Preferences/Adobe/After Effects
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const home = env.AE_MOTION_HOME ?? homedir();
  const appSupport = env.AE_MOTION_APP_SUPPORT ?? join(home, "Library", "Application Support", "ae-motion");
  const logDir = env.AE_MOTION_LOG_DIR ?? join(home, "Library", "Logs", "ae-motion");
  return {
    home,
    appSupport,
    runDir: join(appSupport, "run"),
    userPolicy: join(appSupport, "policy.json"),
    machinePolicy: env.AE_MOTION_MACHINE_POLICY ?? "/Library/Application Support/ae-motion/policy.json",
    logDir,
    auditLog: join(logDir, "audit.jsonl"),
    framesDir: env.AE_MOTION_FRAMES_DIR ?? join(home, "Library", "Caches", "ae-motion", "frames"),
    aePrefsRoot: env.AE_MOTION_AE_PREFS ?? join(home, "Library", "Preferences", "Adobe", "After Effects"),
  };
}

export function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}
