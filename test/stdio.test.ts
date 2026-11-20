// The real entry point over stdio, as an agent would spawn it. Lists tools only, so AE isn't needed.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("node src/index.ts speaks MCP over stdio", { skip: process.platform !== "darwin" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "ae-motion-stdio-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL("../src/index.ts", import.meta.url).pathname],
    env: { ...(process.env as Record<string, string>), AE_MOTION_APP_SUPPORT: join(root, "app"), AE_MOTION_LOG_DIR: join(root, "logs"), AE_MOTION_FRAMES_DIR: join(root, "frames") },
    stderr: "pipe",
  });
  const client = new Client({ name: "stdio-test", version: "1" });
  try {
    await client.connect(transport);
    assert.deepEqual(client.getServerVersion()?.name, "ae-motion");
    const { tools } = await client.listTools();
    assert.equal(tools.length, 20);
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});
