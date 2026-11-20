// Cross-process lock on the run dir: two ae-motion servers (say Claude Desktop and Claude Code) must not
// drive After Effects at the same time, because AE refuses a second script with a modal (SPIKE.md Q4).
import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function withLock<T>(lockFile: string, waitMs: number, fn: () => Promise<T>): Promise<T | typeof LOCK_BUSY> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(lockFile, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let holder = NaN;
      try {
        holder = Number(readFileSync(lockFile, "utf8"));
      } catch {
        /* removed meanwhile: retry */
      }
      if (Number.isFinite(holder) && !alive(holder)) {
        rmSync(lockFile, { force: true }); // stale: its process is gone
        continue;
      }
      if (Date.now() > deadline) return LOCK_BUSY;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lockFile, { force: true });
  }
}

export const LOCK_BUSY = Symbol("lock busy");
