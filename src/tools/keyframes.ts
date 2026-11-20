// Changing existing keyframes: shift_keyframes, remove_keyframes and edit_keyframes.
import { z } from "zod";
import { BridgeError } from "../bridge/types.ts";
import { callAE, CompId, defineTool, KeyDetails, LayerId, PropertyRef, PropPath, Value, Warnings } from "./common.ts";
import { keyDetails } from "./edit.ts";

const KeyedProperty = z.looseObject({ property: z.string(), path: PropPath, numKeys: z.number() });

export const shiftKeyframes = defineTool({
  name: "shift_keyframes",
  title: "Move keyframes in time",
  description:
    "Moves a layer's existing keyframes in time, in one undo step, keeping their values, eases, interpolation and spatial tangents. New time = pivot + (time − pivot) × scale + offset. Limit it to some properties and/or a time range (keys outside the range stay put). Use it to retime animations, e.g. push an out-animation later or stretch a move. Refuses moves that would put two keys on one frame, before changing anything. Layer start/in/out points are changed with set_properties.",
  input: {
    compId: CompId,
    layerId: LayerId,
    properties: z.array(PropertyRef).min(1).optional().describe("Properties to retime; omit for every keyframed property on the layer (Time Remap included)."),
    offset: z.number().optional().describe("Seconds to add (negative moves earlier). Default 0."),
    scale: z.number().positive().optional().describe("Time scale around pivot: 2 doubles the spacing, 0.5 halves it. Default 1."),
    pivot: z.number().optional().describe("Time in seconds that scale is measured from. Default 0."),
    from: z.number().optional().describe("Only keys at or after this time (seconds) move."),
    to: z.number().optional().describe("Only keys at or before this time (seconds) move."),
  },
  output: { layerId: z.number(), properties: z.array(KeyedProperty.extend({ moved: z.number() })), warnings: Warnings },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  async run(args, ctx) {
    if ((args.offset ?? 0) === 0 && (args.scale ?? 1) === 1) throw new BridgeError("invalid_argument", "Give an offset and/or a scale other than 1; otherwise nothing would move.");
    if (args.from !== undefined && args.to !== undefined && args.from > args.to) throw new BridgeError("invalid_argument", "from must not be later than to.");
    const r = await callAE<Record<string, unknown>>(ctx, "shift_keyframes", args, { undo: "shift keyframes", timeoutSec: 120 });
    return { structured: r.value, changedProject: r.changedProject };
  },
});

export const removeKeyframes = defineTool({
  name: "remove_keyframes",
  title: "Remove keyframes",
  description:
    "Removes keyframes from one property, in one undo step: all of them (all: true), the ones in a time range (from/to), or the ones at given times. The property then holds the value it has at the current time. Won't remove every Time Remap keyframe, because that turns Time Remap off (use set_properties for that).",
  input: {
    compId: CompId,
    layerId: LayerId,
    property: PropertyRef,
    all: z.boolean().optional().describe("Remove every keyframe on the property."),
    from: z.number().optional().describe("Remove keys at or after this time (seconds)."),
    to: z.number().optional().describe("Remove keys at or before this time (seconds)."),
    times: z.array(z.number()).min(1).optional().describe("Remove the keys at these times (matched to the nearest frame)."),
  },
  output: { property: z.string(), path: PropPath, removed: z.array(z.number()), numKeys: z.number(), keyframes: z.array(z.unknown()), warnings: Warnings },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  async run(args, ctx) {
    const modes = [args.all === true, args.times !== undefined, args.from !== undefined || args.to !== undefined].filter(Boolean).length;
    if (modes !== 1) throw new BridgeError("invalid_argument", "Choose exactly one of: all: true, times, or a from/to range.");
    if (args.from !== undefined && args.to !== undefined && args.from > args.to) throw new BridgeError("invalid_argument", "from must not be later than to.");
    const r = await callAE<Record<string, unknown>>(ctx, "remove_keyframes", args, { undo: "remove keyframes" });
    return { structured: r.value, changedProject: r.changedProject };
  },
});

export const editKeyframes = defineTool({
  name: "edit_keyframes",
  title: "Edit keyframe interpolation, eases and tangents",
  description:
    "Changes existing keyframes of one property in place, in one undo step, without moving them: their value, interpolation per side (linear, bezier, hold), exact eases (speed and influence, per dimension where AE has one per dimension), temporal continuous/auto-bezier, and for spatial properties the motion path tangents, spatial continuous/auto-bezier and roving; also keyframe labels. Pick each key by time (matched to the nearest frame) or 1-based index. inspect_layer with keyframes: true shows the current details. Nothing changes if any key or detail is refused.",
  input: {
    compId: CompId,
    layerId: LayerId,
    property: PropertyRef,
    keys: z
      .array(
        z.object({
          time: z.number().min(0).optional().describe("The key at this time (seconds)."),
          index: z.number().int().positive().optional().describe("Or the key with this 1-based index."),
          value: Value.optional().describe("New value for this key."),
          ...KeyDetails,
        }),
      )
      .min(1),
  },
  output: { property: z.string(), path: PropPath, numKeys: z.number(), keyframes: z.array(z.unknown()), warnings: Warnings },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async run(args, ctx) {
    const keys = args.keys.map((k, i) => {
      if ((k.time === undefined) === (k.index === undefined)) throw new BridgeError("invalid_argument", `keys[${i}]: give time or index (one of them).`);
      const details = keyDetails(k);
      if (!details && k.value === undefined) throw new BridgeError("invalid_argument", `keys[${i}]: nothing to change.`);
      return { time: k.time, index: k.index, value: k.value, details: details ?? {} };
    });
    const r = await callAE<Record<string, unknown>>(ctx, "edit_keyframes", { compId: args.compId, layerId: args.layerId, property: args.property, keys }, { undo: `edit ${keys.length} keyframe${keys.length === 1 ? "" : "s"}` });
    return { structured: r.value, changedProject: r.changedProject };
  },
});
