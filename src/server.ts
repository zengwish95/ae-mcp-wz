// Builds the MCP server: tool registration with policy gating, audit logging and error mapping.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AuditLog } from "./audit.ts";
import { BridgeError } from "./bridge/types.ts";
import { GUIDE, INSTRUCTIONS } from "./guide.ts";
import type { ToolContext, ToolOutput, ToolSpec } from "./tools/common.ts";
import { ALL_TOOLS } from "./tools/index.ts";

export const SERVER_NAME = "ae-motion";
export const SERVER_VERSION = "0.1.0";

type CallResult = {
  content: ToolOutput["content"] & {};
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export function createServer(ctx: ToolContext, audit: AuditLog, tools: ToolSpec[] = ALL_TOOLS as unknown as ToolSpec[]): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });

  for (const tool of tools) {
    if (tool.enabled && !tool.enabled(ctx)) continue;
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.input, outputSchema: tool.output, annotations: { title: tool.title, ...tool.annotations } },
      async (args: Record<string, unknown>): Promise<CallResult> => {
        const started = performance.now();
        const client = server.server.getClientVersion();
        const clientName = client ? `${client.name} ${client.version}` : undefined;
        try {
          if (ctx.policy.disabledTools.includes(tool.name)) {
            throw new BridgeError("invalid_argument", `The tool ${tool.name} is switched off by this Mac's ae-motion policy.`, { fix: "Ask whoever manages this Mac if it should be enabled." });
          }
          const out = await tool.run(args as never, ctx);
          audit.write({ tool: tool.name, client: clientName, args, ms: Math.round(performance.now() - started), status: "ok", changedProject: out.changedProject });
          return { content: out.content ?? [{ type: "text", text: JSON.stringify(out.structured) }], structuredContent: out.structured };
        } catch (e) {
          const be = e instanceof BridgeError ? e : undefined;
          audit.write({ tool: tool.name, client: clientName, args, ms: Math.round(performance.now() - started), status: "error", error: be?.code ?? "internal_error", changedProject: be?.changedProject });
          return { isError: true, content: [{ type: "text", text: errorText(tool.name, e) }] };
        }
      },
    );
  }

  server.registerResource(
    "motion_design_guide",
    "ae-motion://guide",
    { title: "Motion design guide", description: "How to build editable motion graphics with ae-motion: editability rules, eases, values.", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: GUIDE }] }),
  );

  return server;
}

export function errorText(tool: string, e: unknown): string {
  if (!(e instanceof BridgeError)) return `${tool} failed unexpectedly: ${(e as Error)?.message ?? String(e)}`;
  const lines = [`${tool} failed [${e.code}]: ${e.message}`];
  if (e.fix) lines.push(`How to fix: ${e.fix}`);
  if (e.changedProject) lines.push(`Some changes were made before the error and are still in the project. Edit > Undo "ae-motion: …" in After Effects reverts this call.`);
  if (e.detail !== undefined) {
    const d = JSON.stringify(e.detail);
    lines.push(`Detail: ${d.length > 4000 ? d.slice(0, 4000) + "…" : d}`);
  }
  return lines.join("\n");
}
