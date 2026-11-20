import { z } from "zod";
import { BridgeError, FIXES, SUPPORTED_MAJOR, type BridgeErrorCode } from "../bridge/types.ts";
import { callAE, defineTool } from "./common.ts";

interface Ping {
  version: string;
  scriptingPref: boolean | null;
  project: { name: string; file: string | null; dirty: boolean; numItems: number; renderQueueItems: number; rendering: boolean };
}

interface Problem {
  code: string;
  problem: string;
  fix: string;
}

export const checkSetup = defineTool({
  name: "check_setup",
  title: "Check After Effects setup",
  description:
    "Checks that After Effects 2026 is installed and running, that this app may control it, and that its scripting setting is on. Returns plain-English fixes for anything missing. Call this first in a session, and whenever a tool reports that After Effects isn't reachable.",
  input: {
    launch: z.boolean().default(false).describe("Open After Effects if it isn't running (takes up to a minute)."),
  },
  output: {
    ok: z.boolean(),
    afterEffects: z.object({ installed: z.array(z.object({ path: z.string(), version: z.string() })), running: z.boolean(), version: z.string().nullable(), path: z.string().nullable() }),
    automationPermission: z.enum(["granted", "denied", "unknown"]),
    scriptingPref: z.enum(["on", "off", "unknown"]),
    roundTripMs: z.number().nullable(),
    project: z.looseObject({}).nullable(),
    policy: z.object({ source: z.string(), file: z.string().nullable(), importFolders: z.array(z.string()), disabledTools: z.array(z.string()) }),
    problems: z.array(z.object({ code: z.string(), problem: z.string(), fix: z.string() })),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  async run(args, ctx) {
    const problems: Problem[] = [];
    const add = (code: BridgeErrorCode | "policy_invalid", problem: string, fix?: string) => problems.push({ code, problem, fix: fix ?? FIXES[code as BridgeErrorCode] ?? "" });

    let state = await ctx.bridge.appState();
    if (!state.running && args.launch && state.installed.length) {
      try {
        await ctx.bridge.launch();
      } catch (e) {
        if (e instanceof BridgeError) add(e.code, `Could not open After Effects: ${e.message}`, e.fix);
      }
      state = await ctx.bridge.appState();
    }
    const supported = state.installed.filter((i) => Number(i.version.split(".")[0]) === SUPPORTED_MAJOR);
    if (!supported.length) add("not_installed", "After Effects 2026 isn't installed.");
    if (!state.running) add("not_running", "After Effects isn't running.");

    let permission: "granted" | "denied" | "unknown" = "unknown";
    let roundTripMs: number | null = null;
    let project: Ping["project"] | null = null;
    let prefFromAE: boolean | null = null;
    if (state.running) {
      try {
        const r = await callAE<Ping>(ctx, "ping", {}, { timeoutSec: 30 });
        permission = "granted";
        roundTripMs = r.ms;
        project = r.value.project;
        prefFromAE = r.value.scriptingPref;
      } catch (e) {
        if (!(e instanceof BridgeError)) throw e;
        if (e.code === "permission_denied") permission = "denied";
        else if (e.code !== "not_running" && e.code !== "timeout") permission = "granted"; // AE answered
        add(e.code, e.message, e.fix);
      }
    }

    const prefFile = ctx.bridge.scriptingPref(state.version).enabled;
    const pref = prefFromAE ?? prefFile;
    if (pref === false && !problems.some((p) => p.code === "pref_disabled")) add("pref_disabled", "After Effects doesn't allow scripts to write files, so results can't come back.");
    if (ctx.policy.error) add("policy_invalid", ctx.policy.error, "Fix or delete the policy file named above, then restart the agent.");

    return {
      structured: {
        ok: problems.length === 0,
        afterEffects: { installed: state.installed, running: state.running, version: state.version ?? null, path: state.path ?? null },
        automationPermission: permission,
        scriptingPref: pref === undefined ? "unknown" : pref ? "on" : "off",
        roundTripMs,
        project,
        policy: { source: ctx.policy.source, file: ctx.policy.file ?? null, importFolders: ctx.policy.importFolders, disabledTools: ctx.policy.disabledTools },
        problems,
      },
    };
  },
});
