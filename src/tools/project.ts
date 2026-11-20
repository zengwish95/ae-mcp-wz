import { z } from "zod";
import { callAE, CompId, defineTool, ItemSummary, LayerId, LayerSummary, Seconds } from "./common.ts";

const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const;

export const getProject = defineTool({
  name: "get_project",
  title: "Get project overview",
  description: "Lists the open After Effects project's items (comps, folders, footage, solids) with their ids. Use the ids with the other tools.",
  input: {
    type: z.enum(["comp", "folder", "footage", "solid", "placeholder"]).optional().describe("Only list items of this type."),
    offset: z.number().int().min(0).default(0).describe("Skip this many project items (for paging)."),
    limit: z.number().int().min(1).max(500).default(100),
  },
  output: {
    project: z.looseObject({ name: z.string(), file: z.string().nullable(), dirty: z.boolean(), numItems: z.number() }),
    items: z.array(ItemSummary),
    nextOffset: z.number().nullable().describe("Pass as offset to get the next page; null when done."),
  },
  annotations: READ_ONLY,
  async run(args, ctx) {
    return { structured: (await callAE<Record<string, unknown>>(ctx, "get_project", args)).value };
  },
});

export const inspectComp = defineTool({
  name: "inspect_comp",
  title: "Inspect a composition",
  description:
    "Describes a comp: settings, markers and its layers (id, type, timing, parent, track matte, blend mode, transform values, text, effects, and which properties are animated or driven by expressions).",
  input: {
    compId: CompId,
    time: Seconds.optional().describe("Time at which to read values; defaults to the comp's current time."),
    offset: z.number().int().min(0).default(0).describe("Skip this many layers (for paging)."),
    limit: z.number().int().min(1).max(200).default(100),
  },
  output: {
    id: z.number(),
    name: z.string(),
    width: z.number(),
    height: z.number(),
    frameRate: z.number(),
    duration: z.number(),
    layers: z.array(LayerSummary),
    nextOffset: z.number().nullable(),
  },
  annotations: READ_ONLY,
  async run(args, ctx) {
    return { structured: (await callAE<Record<string, unknown>>(ctx, "inspect_comp", args)).value };
  },
});

export const inspectLayer = defineTool({
  name: "inspect_layer",
  title: "Inspect a layer's properties",
  description:
    "Returns a layer's property tree with names and match names, values, keyframes (time, value, interpolation, ease), expressions and expression errors. By default only properties that differ from their defaults, are animated or have expressions are listed; effects, masks and shape contents are always listed.",
  input: {
    compId: CompId,
    layerId: LayerId,
    onlyModified: z.boolean().default(true).describe("Leave out properties still at their default value."),
    keyframes: z.boolean().default(true).describe("Include keyframe details."),
    maxDepth: z.number().int().min(1).max(12).default(8),
    time: Seconds.optional().describe("Time at which to read values; defaults to the comp's current time."),
  },
  output: {
    layer: LayerSummary,
    time: z.number(),
    properties: z.array(z.looseObject({ name: z.string(), matchName: z.string() })),
    truncated: z.boolean().describe("True if the tree was cut off; inspect with a smaller maxDepth or narrower layer."),
  },
  annotations: READ_ONLY,
  async run(args, ctx) {
    return { structured: (await callAE<Record<string, unknown>>(ctx, "inspect_layer", args)).value };
  },
});
