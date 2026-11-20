// Server-side policy (DESIGN.md §4). Enforced here regardless of which MCP client is connected.
// A machine-wide policy (MDM) replaces the user policy entirely. A malformed policy fails closed.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { z } from "zod";
import { expandHome, type Paths } from "./paths.ts";

const PolicyFile = z
  .object({
    // Folders footage may be imported from. "~" means the user's home folder.
    importFolders: z.array(z.string().min(1)).optional(),
    // Tools that are switched off for this machine/user.
    disabledTools: z.array(z.string()).optional(),
    // run_jsx, the raw ExtendScript escape hatch. Off (and not listed) unless a policy turns it on.
    allowRawExtendScript: z.boolean().optional(),
  })
  .strict();

export interface Policy {
  source: "default" | "user" | "machine";
  file?: string;
  importFolders: string[]; // absolute, real paths
  disabledTools: string[];
  allowRawExtendScript: boolean;
  error?: string; // set when the policy file could not be used; everything risky is then off
}

export const DEFAULT_IMPORT_FOLDERS = ["~"];

export function loadPolicy(paths: Paths): Policy {
  const file = existsSync(paths.machinePolicy) ? paths.machinePolicy : existsSync(paths.userPolicy) ? paths.userPolicy : undefined;
  const source = file === undefined ? "default" : file === paths.machinePolicy ? "machine" : "user";
  let raw: z.infer<typeof PolicyFile> = {};
  if (file) {
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(file, "utf8"));
      raw = PolicyFile.parse(json);
    } catch (e) {
      const message = e instanceof z.ZodError ? z.prettifyError(e) : (e as Error).message;
      // Fail closed: a typo elsewhere in the file must not switch back on the tools it disables.
      const listed = (json as { disabledTools?: unknown } | undefined)?.disabledTools;
      const disabledTools = Array.isArray(listed) ? listed.filter((t): t is string => typeof t === "string") : [];
      return { source, file, importFolders: [], disabledTools, allowRawExtendScript: false, error: `Policy file ${file} is invalid, so imports are off until it is fixed: ${message}` };
    }
  }
  return {
    source,
    file,
    importFolders: (raw.importFolders ?? DEFAULT_IMPORT_FOLDERS).map((f) => realOrSelf(normalize(expandHome(f, paths.home)))),
    disabledTools: raw.disabledTools ?? [],
    allowRawExtendScript: raw.allowRawExtendScript ?? false,
  };
}

function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

// True if `path` (after resolving symlinks and "..") is inside one of the allowed folders.
export function isPathAllowed(path: string, folders: string[]): boolean {
  if (!isAbsolute(path)) return false;
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    // Not there (yet): judge by the real path of its parent folder.
    const n = normalize(path);
    real = join(realOrSelf(dirname(n)), basename(n));
  }
  return folders.some((f) => {
    const rel = relative(f, real);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  });
}
