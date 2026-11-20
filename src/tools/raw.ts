// run_jsx: the raw ExtendScript escape hatch. Off unless the policy file sets allowRawExtendScript, and
// not even listed then. It still runs through the wrapper, so it gets dialog suppression, one undo step,
// the cross-process lock and the timeout: never drive After Effects with osascript directly.
import { z } from "zod";
import { BridgeError } from "../bridge/types.ts";
import { defineTool } from "./common.ts";

export const runJsx = defineTool({
  name: "run_jsx",
  title: "Run ExtendScript (escape hatch)",
  description:
    "Runs your own ExtendScript in After Effects when no other ae-motion tool can do the job. The code is the body of a function: `return` plain data (numbers, strings, arrays, objects), use ARGS for the args you pass and AEM.* helpers (AEM.comp(id), AEM.layer(comp, id), AEM.property(layer, path), AEM.fail(code, message)). It runs with dialogs suppressed, as one undo step, under the same lock and timeout as every tool. ExtendScript is ES3: no let/const, arrow functions, template strings or Array#forEach/map. Never loop until a property has no keyframes (removing the last Time Remap key turns Time Remap off), and never write \"\" + anArray (it does arithmetic). Prefer the dedicated tools: they are checked and tested.",
  input: {
    code: z.string().min(1).max(100_000).describe("ExtendScript function body. Must `return` plain data."),
    args: z.record(z.string(), z.unknown()).optional().describe("JSON values the code reads as ARGS."),
    undo: z.string().min(1).max(60).optional().describe('Name of the Edit > Undo step (shown as "ae-motion: <undo>"). Default "run script".'),
    readOnly: z.boolean().optional().describe("True if the code only reads: no undo group is opened."),
    timeoutSec: z.number().int().min(5).max(600).optional().describe("How long to wait for After Effects. Default 60."),
  },
  output: { value: z.unknown() },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  enabled: (ctx) => ctx.policy.allowRawExtendScript,
  async run(args, ctx) {
    if (!ctx.policy.allowRawExtendScript) {
      throw new BridgeError("invalid_argument", "run_jsx is switched off on this Mac.", {
        fix: `To turn it on, set "allowRawExtendScript": true in ${ctx.paths.userPolicy} and restart the agent. Prefer the dedicated tools when they can do the job.`,
      });
    }
    const r = await ctx.bridge.run({ tool: "run_jsx", body: args.code, args: args.args ?? {}, undo: args.readOnly ? undefined : `ae-motion: ${args.undo ?? "run script"}`, timeoutSec: args.timeoutSec });
    return { structured: { value: r.value }, changedProject: r.changedProject };
  },
});
