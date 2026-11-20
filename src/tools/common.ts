// Shared pieces for tool definitions: the spec type, reusable zod schemas and the AE call helper.
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Bridge, BridgeResult } from "../bridge/types.ts";
import { EASE_NAMES } from "../eases.ts";
import { toolScript } from "../jsx/index.ts";
import type { Paths } from "../paths.ts";
import type { Policy } from "../policy.ts";

export interface ToolContext {
  bridge: Bridge;
  policy: Policy;
  paths: Paths;
}

export type ContentBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export interface ToolOutput {
  structured: Record<string, unknown>;
  content?: ContentBlock[]; // defaults to the structured result as JSON text
  changedProject?: boolean;
}

export interface ToolSpec<I extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  input: I;
  output: z.ZodRawShape;
  annotations: ToolAnnotations;
  // When false the tool isn't listed at all (e.g. switched off by policy). Default: listed.
  enabled?(ctx: ToolContext): boolean;
  run(args: z.infer<z.ZodObject<I>>, ctx: ToolContext): Promise<ToolOutput>;
}

export function defineTool<I extends z.ZodRawShape>(spec: ToolSpec<I>): ToolSpec<I> {
  return spec;
}

// Runs src/jsx/tools/<script>.jsx. `undo` names the Edit > Undo step ("ae-motion: …").
export function callAE<T>(ctx: ToolContext, script: string, args: unknown, opts: { undo?: string; timeoutSec?: number } = {}): Promise<BridgeResult<T>> {
  return ctx.bridge.run<T>({ tool: script, body: toolScript(script), args, undo: opts.undo ? `ae-motion: ${opts.undo}` : undefined, timeoutSec: opts.timeoutSec });
}

// ---- schemas ---------------------------------------------------------------------------------------

export const CompId = z.number().int().positive().describe("Composition id, from get_project or create_comp.");
export const LayerId = z.number().int().positive().describe("Layer id, from inspect_comp or create_layer. Ids don't change when layers are reordered.");
export const Seconds = z.number().min(0).describe("Time in seconds from the start of the comp.");

export const Color = z
  .union([z.array(z.number().min(0).max(1)).min(3).max(4), z.string().regex(/^#?[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/)])
  .describe('Color as [r, g, b] from 0 to 1, or a hex string like "#7B2FF7".');

export const PROPERTY_ALIASES = ["anchorPoint", "position", "scale", "rotation", "opacity", "orientation", "xRotation", "yRotation", "sourceText"] as const;
export const PropertyRef = z
  .union([z.enum(PROPERTY_ALIASES), z.array(z.union([z.string(), z.number().int().positive()])).min(1)])
  .describe(
    'A transform name ("position", "scale", "rotation", "opacity", "anchorPoint", "orientation", "xRotation", "yRotation", "sourceText"), or a path of names / match names / 1-based indexes from the layer down, e.g. ["ADBE Effect Parade", "Gaussian Blur", "Blurriness"]. inspect_layer shows the match names.',
  );

export const TextStyle = z
  .object({
    text: z.string().describe("The text. Use \\r for a line break."),
    font: z.string().describe('PostScript font name, e.g. "Inter-Bold". If it isn\'t installed, AE substitutes a font and a warning says so.'),
    fontSize: z.number().positive(),
    fillColor: Color,
    strokeColor: z.union([Color, z.null()]).describe("Stroke color, or null for no stroke."),
    strokeWidth: z.number().min(0),
    justification: z.enum(["left", "center", "right", "full"]),
    tracking: z.number(),
    leading: z.union([z.number().positive(), z.literal("auto")]),
  })
  .partial();

const Point = z.tuple([z.number(), z.number()]);
export const PathShape = z
  .object({
    vertices: z.array(Point).min(1).describe("Points [x, y] in the layer's own pixels; [0, 0] is the layer's anchor (usually the comp center for a new shape layer)."),
    inTangents: z.array(Point).optional().describe("Incoming bezier handle of each vertex, relative to that vertex. Default [0, 0] (a sharp corner)."),
    outTangents: z.array(Point).optional().describe("Outgoing bezier handle of each vertex, relative to that vertex. Default [0, 0]."),
    closed: z.boolean().optional().describe("Closed outline (default) or open line."),
  })
  .describe("A bezier path, the same shape inspect_layer reports for Path properties.");

// Before TextStyle: an object union member strips unknown keys, so TextStyle would swallow a path.
export const Value = z
  .union([z.number(), z.array(z.number()).min(1).max(4), z.string(), z.boolean(), PathShape, TextStyle])
  .describe(
    "Property value: a number (rotation in degrees, opacity 0–100), an array ([x, y] position in pixels, [x, y] scale in percent), a hex color string, a path { vertices, inTangents, outTangents, closed } for Path properties, or for sourceText a string or text style object.",
  );

// Property paths in results: match names, plus names (or 1-based indexes when names repeat) for
// children of effects, masks and shape contents. They can be passed back as a property path.
export const PropPath = z.array(z.union([z.string(), z.number()]));

export const Ease = z
  .union([z.enum(EASE_NAMES), z.tuple([z.number().min(0).max(1), z.number(), z.number().min(0).max(1), z.number()])])
  .describe(`How the motion moves from this keyframe to the next: one of ${EASE_NAMES.join(", ")}, or a cubic-bezier [x1, y1, x2, y2] like CSS.`);

const TemporalEase = z.object({
  speed: z.number().describe("Units per second at the key: pixels/s along the path for position, degrees/s for rotation, percent/s for opacity."),
  influence: z.number().min(0.1).max(100).describe("Percent of the time to the neighbouring key that the ease reaches over."),
});
const EaseSide = z
  .union([TemporalEase, z.array(TemporalEase).min(1).max(3)])
  .describe("An exact After Effects ease (as inspect_layer reports it): one { speed, influence }, or one per dimension for properties such as scale.");
const Interp = z.enum(["linear", "bezier", "hold"]);
const Tangent = z.array(z.number()).min(2).max(3);

// Per-keyframe details, the way the Graph Editor and Keyframe Interpolation dialog set them.
export const KeyDetails = {
  inInterpolation: Interp.optional(),
  outInterpolation: Interp.optional().describe('"hold" freezes the value until the next key.'),
  inEase: EaseSide.optional(),
  outEase: EaseSide.optional(),
  temporalContinuous: z.boolean().optional().describe("Continuous bezier: the in and out eases stay matched."),
  temporalAutoBezier: z.boolean().optional(),
  inTangent: Tangent.optional().describe("Spatial properties (position, anchor point, effect points): the motion path handle coming into this key, in pixels relative to the key's value. Setting a tangent turns spatial auto-bezier off."),
  outTangent: Tangent.optional().describe("The motion path handle leaving this key, e.g. [120, 0] for a curve that leaves to the right."),
  spatialContinuous: z.boolean().optional().describe("Keeps the in and out handles in line (a smooth corner)."),
  spatialAutoBezier: z.boolean().optional(),
  roving: z.boolean().optional().describe("Spatial, not the first or last key: the key's time floats to give an even speed."),
  label: z.number().int().min(0).max(16).optional().describe("Keyframe label colour, 0 (none) to 16."),
};
export const KEY_DETAIL_FIELDS = Object.keys(KeyDetails);

export const Warnings = z.array(z.string()).describe("Things the agent should know or tell the user.");

// Nested AE data is described loosely; the key fields are typed.
export const LayerSummary = z.looseObject({ id: z.number(), index: z.number(), name: z.string(), type: z.string() });
export const ItemSummary = z.looseObject({ id: z.number(), name: z.string(), type: z.string() });
