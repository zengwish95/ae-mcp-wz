import { z } from "zod";
import { BridgeError } from "../bridge/types.ts";
import { DEFAULT_EASE, resolveEase } from "../eases.ts";
import { callAE, Color, CompId, defineTool, Ease, ItemSummary, KEY_DETAIL_FIELDS, KeyDetails, LayerId, LayerSummary, PropertyRef, PropPath, Seconds, TextStyle, Value, Warnings } from "./common.ts";

const EDIT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

export const setProperties = defineTool({
  name: "set_properties",
  title: "Set comp or layer properties",
  description:
    "Changes static (non-animated) settings in one undo step: comp settings (without layerId: name, size, duration, frame rate, work area, motion blur and frame blending switches…), or a layer's name, timing (start time, in/out points, time stretch, Time Remap on/off), parent, track matte, blend mode, the Timeline switches (3D, Preserve Underlying Transparency \"T\", motion blur, adjustment, guide, collapse transformations, fx, quality, frame blending, auto-orient), order, transform values, text and any other property by path. Properties that have keyframes must be changed with animate; to move existing keyframes in time use shift_keyframes.",
  input: {
    compId: CompId,
    layerId: LayerId.optional().describe("Omit to change only comp settings."),
    comp: z
      .object({
        name: z.string().min(1),
        width: z.number().int().min(4),
        height: z.number().int().min(4),
        duration: z.number().positive(),
        frameRate: z.number().min(1),
        bgColor: Color,
        workAreaStart: Seconds,
        workAreaDuration: z.number().positive(),
        motionBlur: z.boolean().describe("The comp's Enable Motion Blur switch (layers also need theirs on)."),
        frameBlending: z.boolean().describe("The comp's Enable Frame Blending switch."),
        hideShyLayers: z.boolean(),
        shutterAngle: z.number().min(0).max(720),
        shutterPhase: z.number().min(-360).max(360),
        motionBlurSamplesPerFrame: z.number().int().min(2).max(64),
        motionBlurAdaptiveSampleLimit: z.number().int().min(16).max(256),
        preserveNestedFrameRate: z.boolean(),
        preserveNestedResolution: z.boolean(),
      })
      .partial()
      .optional(),
    layer: z
      .object({
        name: z.string().min(1),
        startTime: z.number(),
        inPoint: Seconds,
        outPoint: Seconds,
        enabled: z.boolean(),
        solo: z.boolean(),
        shy: z.boolean(),
        locked: z.boolean().describe("Locked layers can't be changed until unlocked."),
        label: z.number().int().min(0).max(16).describe("Label color index 0–16."),
        threeD: z.boolean(),
        threeDPerChar: z.boolean().describe("Text layers: Enable Per-character 3D (makes the layer 3D)."),
        preserveTransparency: z.boolean().describe('The "T" switch (Preserve Underlying Transparency): the layer only shows where the layers below it are opaque.'),
        motionBlur: z.boolean().describe("The layer's motion blur switch (the comp's must be on to see it)."),
        adjustmentLayer: z.boolean(),
        guideLayer: z.boolean().describe("Guide layers show in the comp but don't render."),
        collapseTransformation: z.boolean().describe("Collapse Transformations (precomps) or Continuously Rasterize (vector footage). Shape and text layers always have it on."),
        effectsActive: z.boolean().describe("The fx switch: turns all of the layer's effects on or off."),
        quality: z.enum(["best", "draft", "wireframe"]),
        samplingQuality: z.enum(["bilinear", "bicubic"]),
        frameBlending: z.enum(["none", "frameMix", "pixelMotion"]).describe("Precomp and footage layers with motion."),
        audioEnabled: z.boolean().describe("Layers with audio."),
        autoOrient: z.enum(["off", "alongPath", "towardsCamera", "charactersTowardCamera"]).describe('"towardsCamera" is for 3D layers (cameras and lights: towards the point of interest); "charactersTowardCamera" needs per-character 3D text.'),
        blendMode: z.string().describe('e.g. "normal", "multiply", "screen", "add", "overlay".'),
        stretch: z
          .number()
          .refine((v) => v !== 0, "stretch can't be 0")
          .describe("Time stretch in percent: 100 is normal speed, 200 half speed, a negative value plays backwards."),
        timeRemapEnabled: z.boolean().describe("Turn Time Remap on (adds keys at the layer's start and end) or off. Only precomp and footage layers can be time-remapped."),
        parentLayerId: z.union([LayerId, z.null()]).describe("Parent layer, or null to unparent."),
        parentWithJump: z
          .boolean()
          .describe("With parentLayerId: false (default) keeps the layer where it is on screen; true keeps its transform values as they are, so it may jump (like Shift-parenting in AE)."),
        trackMatte: z.union([z.object({ layerId: LayerId, type: z.enum(["alpha", "alpha_inverted", "luma", "luma_inverted"]) }), z.null()]).describe("Use another layer as this layer's matte, or null to remove."),
        moveTo: z
          .union([z.object({ position: z.enum(["top", "bottom"]) }), z.object({ beforeLayerId: LayerId }), z.object({ afterLayerId: LayerId })])
          .describe("Reorder the layer in the stack."),
      })
      .partial()
      .optional(),
    transform: z
      .object({
        anchorPoint: z.array(z.number()).min(2).max(3),
        position: z.array(z.number()).min(2).max(3),
        scale: z.array(z.number()).min(2).max(3).describe("Percent, e.g. [100, 100]."),
        rotation: z.number().describe("Degrees."),
        opacity: z.number().min(0).max(100),
        orientation: z.array(z.number()).length(3),
        xRotation: z.number(),
        yRotation: z.number(),
      })
      .partial()
      .optional(),
    text: TextStyle.optional().describe("For text layers."),
    properties: z.array(z.object({ path: PropertyRef, value: Value })).optional().describe("Any other property, e.g. an effect parameter."),
  },
  output: { comp: ItemSummary.optional(), layer: LayerSummary.optional(), warnings: Warnings },
  annotations: EDIT,
  async run(args, ctx) {
    const what = args.layerId === undefined ? "comp settings" : "layer properties";
    const r = await callAE<Record<string, unknown>>(ctx, "set_properties", args, { undo: `set ${what}` });
    return { structured: r.value, changedProject: r.changedProject };
  },
});

const Keyframe = z.object({
  time: Seconds,
  value: Value,
  ease: Ease.optional().describe(`Ease to the next keyframe; defaults to the track's ease, else ${DEFAULT_EASE}.`),
  ...KeyDetails,
});

// The detail fields a keyframe actually sets (sent to AE only when there are some).
export function keyDetails(k: Record<string, unknown>): Record<string, unknown> | undefined {
  const d: Record<string, unknown> = {};
  for (const f of KEY_DETAIL_FIELDS) if (k[f] !== undefined) d[f] = k[f];
  return Object.keys(d).length ? d : undefined;
}

export const animate = defineTool({
  name: "animate",
  title: "Animate layer properties with keyframes",
  description:
    "Sets keyframes on one or more properties of a layer, in one undo step. This is the default way to make motion: designers can retime and nudge keyframes. Each keyframe's ease shapes the motion from it to the next keyframe. A keyframe can also set exact After Effects details, which win over its ease: interpolation per side, inEase/outEase speed and influence, motion path tangents (inTangent/outTangent, to curve a position path), continuous/auto-bezier, roving and a label. By default a track replaces the property's existing keyframes. To change details of existing keys without re-setting them, use edit_keyframes.",
  input: {
    compId: CompId,
    layerId: LayerId,
    tracks: z
      .array(
        z.object({
          property: PropertyRef,
          keyframes: z.array(Keyframe).min(1),
          ease: Ease.optional().describe("Default ease for this track's keyframes."),
          replace: z.boolean().default(true).describe("Remove the property's existing keyframes first."),
        }),
      )
      .min(1),
  },
  output: {
    layerId: z.number(),
    tracks: z.array(z.looseObject({ property: z.string(), numKeys: z.number() })),
    warnings: Warnings,
  },
  annotations: EDIT,
  async run(args, ctx) {
    const tracks = args.tracks.map((t) => {
      const keyframes = [...t.keyframes].sort((a, b) => a.time - b.time);
      for (let i = 1; i < keyframes.length; i++) {
        if (keyframes[i].time === keyframes[i - 1].time) throw new BridgeError("invalid_argument", `Two keyframes at ${keyframes[i].time} s on the same property.`);
      }
      return { property: t.property, replace: t.replace, keyframes: keyframes.map((k) => ({ time: k.time, value: k.value, ease: resolveEase(k.ease, t.ease ?? DEFAULT_EASE), details: keyDetails(k) })) };
    });
    const names = tracks.map((t) => (typeof t.property === "string" ? t.property : String(t.property[t.property.length - 1]))).join(", ");
    const r = await callAE<Record<string, unknown>>(ctx, "animate", { compId: args.compId, layerId: args.layerId, tracks }, { undo: `animate ${names}` });
    return { structured: r.value, changedProject: r.changedProject };
  },
});

export const setExpression = defineTool({
  name: "set_expression",
  title: "Set or remove an expression",
  description:
    "Sets (or with null removes) an expression on a property and reports expressionError, so a broken expression can be fixed right away. Use expressions where they're the better tool (procedural motion, many things driven by one control); start each with a one-line // comment, and expose its knobs as sliders on a Controls null.",
  input: {
    compId: CompId,
    layerId: LayerId,
    property: PropertyRef,
    expression: z.union([z.string().min(1), z.null()]).describe("Expression text (JavaScript engine), or null to remove the expression."),
  },
  output: {
    property: z.string(),
    path: PropPath,
    removed: z.boolean(),
    expressionEnabled: z.boolean(),
    expressionError: z.string().nullable().describe("After Effects' error message; null if the expression works."),
    valueAtCurrentTime: z.unknown(),
  },
  annotations: EDIT,
  async run(args, ctx) {
    const r = await callAE<Record<string, unknown>>(ctx, "set_expression", args, { undo: args.expression === null ? "remove expression" : "set expression" });
    return { structured: r.value, changedProject: r.changedProject };
  },
});

export const addEffect = defineTool({
  name: "add_effect",
  title: "Add an effect",
  description:
    'Adds an effect to a layer by display name ("Gaussian Blur") or match name ("ADBE Gaussian Blur 2") and optionally sets parameters. Unknown names come back with suggestions. The result lists the effect\'s parameters, which can later be animated with the path ["ADBE Effect Parade", <effect name>, <parameter name>].',
  input: {
    compId: CompId,
    layerId: LayerId,
    effect: z.string().min(1),
    name: z.string().min(1).optional().describe("Rename the effect instance, e.g. \"Glow - logo\"."),
    parameters: z.array(z.object({ name: z.string().min(1).describe("Parameter name or match name."), value: Value })).optional(),
  },
  output: {
    effect: z.looseObject({ index: z.number(), name: z.string(), matchName: z.string() }),
    path: PropPath,
    parameters: z.array(z.looseObject({ name: z.string(), matchName: z.string() })),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  async run(args, ctx) {
    const r = await callAE<Record<string, unknown>>(ctx, "add_effect", args, { undo: `add effect ${args.effect}` });
    return { structured: r.value, changedProject: r.changedProject };
  },
});

export const removeEffect = defineTool({
  name: "remove_effect",
  title: "Remove effects from a layer",
  description:
    'Removes one or more effects from a layer, in one undo step. Name each effect by its 1-based index in the layer\'s effect stack (inspect_comp / inspect_layer list it), its own name ("Glow - logo"), or its match name ("ADBE Gaussian Blur 2") when only one effect on the layer has it. Nothing is removed if any reference is missing or ambiguous. Warns about expressions in the comp that mention a removed effect by name.',
  input: {
    compId: CompId,
    layerId: LayerId,
    effects: z
      .array(z.union([z.number().int().positive(), z.string().min(1)]))
      .min(1)
      .describe('Effects to remove: indexes (1 = top of the effect stack), instance names or match names, e.g. [2] or ["Gaussian Blur"].'),
  },
  output: {
    layerId: z.number(),
    removed: z.array(z.object({ index: z.number(), name: z.string(), matchName: z.string() })),
    remaining: z.array(z.object({ index: z.number(), name: z.string(), matchName: z.string() })),
    referencingExpressions: z.array(z.looseObject({ layerId: z.number(), property: z.string(), effect: z.string() })),
    warnings: Warnings,
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  async run(args, ctx) {
    const n = args.effects.length;
    const r = await callAE<Record<string, unknown>>(ctx, "remove_effect", args, { undo: `remove ${n === 1 ? "effect" : `${n} effects`}` });
    return { structured: r.value, changedProject: r.changedProject };
  },
});

export const deleteItems = defineTool({
  name: "delete_items",
  title: "Delete layers or project items",
  description: "Deletes layers from a comp and/or project items (comps, footage, folders) by id, in one undo step. Ids that no longer exist are reported, not treated as errors.",
  input: {
    compId: CompId.optional().describe("Required when deleting layers."),
    layerIds: z.array(LayerId).optional(),
    itemIds: z.array(z.number().int().positive()).optional().describe("Project item ids (deleting a folder deletes its contents)."),
  },
  output: {
    removed: z.array(z.object({ kind: z.string(), id: z.number(), name: z.string() })),
    missing: z.array(z.object({ kind: z.string(), id: z.number() })),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  async run(args, ctx) {
    if (!args.layerIds?.length && !args.itemIds?.length) throw new BridgeError("invalid_argument", "Give layerIds and/or itemIds to delete.");
    if (args.layerIds?.length && args.compId === undefined) throw new BridgeError("invalid_argument", "Deleting layers needs the compId they belong to.");
    const n = (args.layerIds?.length ?? 0) + (args.itemIds?.length ?? 0);
    const r = await callAE<Record<string, unknown>>(ctx, "delete_items", args, { undo: `delete ${n} item${n === 1 ? "" : "s"}` });
    return { structured: r.value, changedProject: r.changedProject };
  },
});
