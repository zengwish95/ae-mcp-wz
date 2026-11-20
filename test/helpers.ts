// Test helpers: a scriptable mock bridge and throwaway paths.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AuditLog } from "../src/audit.ts";
import type { AppState, Bridge, BridgeRequest, BridgeResult, ScriptingPref } from "../src/bridge/types.ts";
import { resolvePaths, type Paths } from "../src/paths.ts";
import { loadPolicy, type Policy } from "../src/policy.ts";
import { createServer } from "../src/server.ts";

export function tempPaths(): Paths & { cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "ae-motion-test-"));
  const paths = resolvePaths({ AE_MOTION_HOME: root, AE_MOTION_MACHINE_POLICY: join(root, "machine-policy.json") });
  return { ...paths, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

type Handler = (req: BridgeRequest) => unknown | Promise<unknown>;

export class MockBridge implements Bridge {
  readonly runDir: string;
  calls: BridgeRequest[] = [];
  handler: Handler = () => ({});
  state: AppState = { installed: [{ path: "/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app", version: "26.5.0" }], running: true, pid: 1, path: "/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app", version: "26.5.0" };
  pref: ScriptingPref = { enabled: true };
  launched = false;

  constructor(runDir: string) {
    this.runDir = runDir;
  }

  async run<T>(req: BridgeRequest): Promise<BridgeResult<T>> {
    this.calls.push(req);
    const value = await this.handler(req);
    return { value: value as T, changedProject: req.undo !== undefined, aeVersion: "26.5x89", ms: 1 };
  }
  async appState() {
    return this.state;
  }
  async launch() {
    this.launched = true;
    this.state = { ...this.state, running: true };
  }
  scriptingPref() {
    return this.pref;
  }
}

export async function connect(opts: { policy?: Partial<Policy> } = {}) {
  const paths = tempPaths();
  const { mkdirSync } = await import("node:fs");
  mkdirSync(paths.runDir, { recursive: true });
  const bridge = new MockBridge(paths.runDir);
  const policy = { ...loadPolicy(paths), ...opts.policy };
  const server = createServer({ bridge, policy, paths }, new AuditLog(paths.auditLog));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return {
    client,
    bridge,
    paths,
    async close() {
      await client.close();
      await server.close();
      paths.cleanup();
    },
  };
}

export function text(result: unknown): string {
  return (((result as { content?: unknown }).content as { type: string; text?: string }[]) ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
}
