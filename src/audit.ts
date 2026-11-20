// Append-only JSONL audit log of every tool call (DESIGN.md §4). Never contains image data.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface AuditEntry {
  ts: string;
  tool: string;
  client?: string;
  args: unknown;
  ms: number;
  status: "ok" | "error";
  error?: string; // error code
  changedProject?: boolean;
}

export class AuditLog {
  private readonly file: string;
  constructor(file: string) {
    this.file = file;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  }

  write(entry: Omit<AuditEntry, "ts" | "args"> & { args: unknown }): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry, args: summarizeArgs(entry.args) }) + "\n";
    try {
      appendFileSync(this.file, line, { encoding: "utf8", mode: 0o600 });
    } catch (e) {
      // Logging must never break a tool call; report on stderr (the MCP channel is stdout).
      process.stderr.write(`ae-motion: could not write audit log: ${(e as Error).message}\n`);
    }
  }
}

const MAX_STRING = 200;
const MAX_ARRAY = 20;

// Keeps the log readable: long strings are cut, long arrays are reduced to a count.
export function summarizeArgs(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return v.length > MAX_STRING ? v.slice(0, MAX_STRING) + `… (${v.length} chars)` : v;
  if (Array.isArray(v)) {
    if (v.length > MAX_ARRAY) return `[${v.length} items]`;
    return v.map((x) => summarizeArgs(x, depth + 1));
  }
  if (v && typeof v === "object") {
    if (depth > 4) return "{…}";
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, summarizeArgs(x, depth + 1)]));
  }
  return v;
}
