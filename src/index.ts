#!/usr/bin/env node
// ae-motion MCP server over stdio. stdout is the MCP channel: diagnostics go to stderr only.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AuditLog } from "./audit.ts";
import { OsascriptBridge } from "./bridge/osascript.ts";
import { resolvePaths } from "./paths.ts";
import { loadPolicy } from "./policy.ts";
import { createServer } from "./server.ts";

if (process.platform !== "darwin") {
  process.stderr.write("ae-motion: this server runs on macOS only (it drives After Effects through AppleScript).\n");
  process.exit(1);
}

const paths = resolvePaths();
const policy = loadPolicy(paths);
if (policy.error) process.stderr.write(`ae-motion: ${policy.error}\n`);
const server = createServer({ bridge: new OsascriptBridge(paths), policy, paths }, new AuditLog(paths.auditLog));
await server.connect(new StdioServerTransport());
