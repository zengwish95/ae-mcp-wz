// Text animators: animator properties (position, opacity, tracking, …) driven by range, wiggly or
// expression selectors. Friendly fields are turned into match names here, as for shape contents.
import { z } from "zod";
import { BridgeError } from "../bridge/types.ts";
import { callAE, Color, CompId, defineTool, LayerId, PropPath, Value, Warnings } from "./common.ts";

const Point = z.tuple([z.number(), z.number()]);
const Vec = z.array(z.number()).min(2).max(3);

const AnimatorProperties = z
  .object({
    anchorPoint: Vec,
    position: Vec.describe("Offset of each character in pixels, e.g. [0, 80] to come up from below."),
    scale: Vec.describe("Percent."),
    skew: z.number(),
    skewAxis: z.number(),
    xRotation: z.number(),
    yRotation: z.number(),
    rotation: z.number().describe("Degrees."),
    opacity: z.number().min(0).max(100),
    fillColor: Color,
    strokeColor: Color,
    fillHue: z.number(),
    fillSaturation: z.number(),
    fillBrightness: z.number(),
    fillOpacity: z.number().min(0).max(100),
    strokeHue: z.number(),
    strokeSaturation: z.number(),
    strokeBrightness: z.number(),
    strokeOpacity: z.number().min(0).max(100),
    strokeWidth: z.number(),
    lineAnchor: z.number().describe("Percent."),
    lineSpacing: Point,
    trackingType: z.enum(["beforeAndAfter", "before", "after"]),
    trackingAmount: z.number(),
    characterAlignment: z.enum(["leftOrTop", "center", "rightOrBottom", "adjustKerning"]),
    characterRange: z.enum(["preserveCaseAndDigits", "fullUnicode"]),
    characterValue: z.number(),
    characterOffset: z.number(),
    blur: Point,
  })
  .partial()
  .describe("The animator's properties and the values they reach on fully selected characters, e.g. { position: [0, 80], opacity: 0 }.");

const BasedOn = z.enum(["characters", "charactersExcludingSpaces", "words", "lines"]).describe("What one unit of the selection is: per-character, per-word or per-line offsets.");
const Mode = z.enum(["add", "subtract", "intersect", "min", "max", "difference"]).describe("How this selector combines with the ones above it.");

const RangeSelector = z.object({
  type: z.literal("range"),
  name: z.string().min(1).optional(),
  units: z.enum(["percentage", "index"]).optional().describe("Whether start/end/offset are percent of the text (default) or counts of units."),
  start: z.number().optional(),
  end: z.number().optional(),
  offset: z.number().optional().describe("Animate this to sweep the selection across the text."),
  basedOn: BasedOn.optional(),
  mode: Mode.optional(),
  amount: z.number().optional().describe("Percent of the animator's effect, -100 to 100."),
  shape: z.enum(["square", "rampUp", "rampDown", "triangle", "round", "smooth"]).optional(),
  smoothness: z.number().min(0).max(100).optional().describe("Square shape only."),
  easeHigh: z.number().min(-100).max(100).optional(),
  easeLow: z.number().min(-100).max(100).optional(),
  randomizeOrder: z.boolean().optional(),
  randomSeed: z.number().int().optional(),
});
const WigglySelector = z.object({
  type: z.literal("wiggly"),
  name: z.string().min(1).optional(),
  basedOn: BasedOn.optional(),
  mode: Mode.optional(),
  maxAmount: z.number().optional(),
  minAmount: z.number().optional(),
  wigglesPerSecond: z.number().min(0).optional(),
  correlation: z.number().min(0).max(100).optional(),
  temporalPhase: z.number().optional(),
  spatialPhase: z.number().optional(),
  lockDimensions: z.boolean().optional(),
  randomSeed: z.number().int().optional(),
});
const ExpressionSelector = z.object({
  type: z.literal("expression"),
  name: z.string().min(1).optional(),
  basedOn: BasedOn.optional(),
  amount: z
    .string()
    .min(1)
    .describe("Expression for Amount, evaluated per unit (textIndex, textTotal and selectorValue are available); returns 0–100, e.g. \"// stagger\\nlinear(time - textIndex * 0.05, 0, 0.5, 100, 0)\"."),
});
export const TextSelector = z.discriminatedUnion("type", [RangeSelector, WigglySelector, ExpressionSelector]);
export type TextSelector = z.infer<typeof TextSelector>;

const MoreOptions = z
  .object({
    anchorPointGrouping: z.enum(["character", "word", "line", "all"]).describe("What rotates and scales around its own anchor."),
    groupingAlignment: Point.describe("Percent, moves that anchor within each group."),
  })
  .partial();

const PROPERTY: Record<string, string> = {
  anchorPoint: "ADBE Text Anchor Point 3D",
  position: "ADBE Text Position 3D",
  scale: "ADBE Text Scale 3D",
  skew: "ADBE Text Skew",
  skewAxis: "ADBE Text Skew Axis",
  xRotation: "ADBE Text Rotation X",
  yRotation: "ADBE Text Rotation Y",
  rotation: "ADBE Text Rotation",
  opacity: "ADBE Text Opacity",
  fillColor: "ADBE Text Fill Color",
  strokeColor: "ADBE Text Stroke Color",
  fillHue: "ADBE Text Fill Hue",
  fillSaturation: "ADBE Text Fill Saturation",
  fillBrightness: "ADBE Text Fill Brightness",
  fillOpacity: "ADBE Text Fill Opacity",
  strokeHue: "ADBE Text Stroke Hue",
  strokeSaturation: "ADBE Text Stroke Saturation",
  strokeBrightness: "ADBE Text Stroke Brightness",
  strokeOpacity: "ADBE Text Stroke Opacity",
  strokeWidth: "ADBE Text Stroke Width",
  lineAnchor: "ADBE Text Line Anchor",
  lineSpacing: "ADBE Text Line Spacing",
  trackingType: "ADBE Text Track Type",
  trackingAmount: "ADBE Text Tracking Amount",
  characterAlignment: "ADBE Text Character Change Type",
  characterRange: "ADBE Text Character Range",
  characterValue: "ADBE Text Character Replace",
  characterOffset: "ADBE Text Character Offset",
  blur: "ADBE Text Blur",
};

const ADV = "ADBE Text Range Advanced";
// Field -> path inside the selector. Units comes first: index start/end only exist once it is set.
const RANGE: Record<string, string[]> = {
  units: [ADV, "ADBE Text Range Units"],
  basedOn: [ADV, "ADBE Text Range Type2"],
  mode: [ADV, "ADBE Text Selector Mode"],
  amount: [ADV, "ADBE Text Selector Max Amount"],
  shape: [ADV, "ADBE Text Range Shape"],
  smoothness: [ADV, "ADBE Text Selector Smoothness"],
  easeHigh: [ADV, "ADBE Text Levels Max Ease"],
  easeLow: [ADV, "ADBE Text Levels Min Ease"],
  randomizeOrder: [ADV, "ADBE Text Randomize Order"],
  randomSeed: [ADV, "ADBE Text Random Seed"],
};
const WIGGLY: Record<string, string[]> = {
  basedOn: ["ADBE Text Range Type2"],
  mode: ["ADBE Text Selector Mode"],
  maxAmount: ["ADBE Text Wiggly Max Amount"],
  minAmount: ["ADBE Text Wiggly Min Amount"],
  wigglesPerSecond: ["ADBE Text Temporal Freq"],
  correlation: ["ADBE Text Character Correlation"],
  temporalPhase: ["ADBE Text Temporal Phase"],
  spatialPhase: ["ADBE Text Spatial Phase"],
  lockDimensions: ["ADBE Text Wiggly Lock Dim"],
  randomSeed: ["ADBE Text Wiggly Random Seed"],
};
const MORE: Record<string, string[]> = { anchorPointGrouping: ["ADBE Text Anchor Point Option"], groupingAlignment: ["ADBE Text Anchor Point Align"] };
const SELECTOR_MATCH = { range: "ADBE Text Selector", wiggly: "ADBE Text Wiggly Selector", expression: "ADBE Text Expressible Selector" } as const;

// Dropdowns are 1-based menu indexes in AE; checkboxes are 0/1.
const ENUMS: Record<string, readonly string[]> = {
  trackingType: AnimatorProperties.shape.trackingType.unwrap().options,
  characterAlignment: AnimatorProperties.shape.characterAlignment.unwrap().options,
  characterRange: AnimatorProperties.shape.characterRange.unwrap().options,
  units: ["percentage", "index"],
  basedOn: BasedOn.options,
  mode: Mode.options,
  shape: RangeSelector.shape.shape.unwrap().options,
  anchorPointGrouping: MoreOptions.shape.anchorPointGrouping.unwrap().options,
};
function aeValue(field: string, v: unknown): unknown {
  if (typeof v === "boolean") return v ? 1 : 0;
  const e = ENUMS[field];
  return e && typeof v === "string" ? e.indexOf(v) + 1 : v;
}

type Setting = { path: (string | number)[]; value: unknown };
export interface AeSelector {
  matchName: string;
  name?: string;
  settings: Setting[];
  expression?: { path: string[]; text: string };
}

export function toAeSelector(s: TextSelector): AeSelector {
  const settings: Setting[] = [];
  const out: AeSelector = { matchName: SELECTOR_MATCH[s.type], settings };
  if (s.name !== undefined) out.name = s.name;
  if (s.type === "range") {
    for (const k of Object.keys(RANGE)) {
      const v = (s as Record<string, unknown>)[k];
      if (v !== undefined) settings.push({ path: RANGE[k], value: aeValue(k, v) });
    }
    const which = s.units === "index" ? "Index" : "Percent";
    for (const k of ["start", "end", "offset"] as const) {
      if (s[k] !== undefined) settings.push({ path: [`ADBE Text ${which} ${k[0].toUpperCase()}${k.slice(1)}`], value: s[k] });
    }
  } else if (s.type === "wiggly") {
    for (const k of Object.keys(WIGGLY)) {
      const v = (s as Record<string, unknown>)[k];
      if (v !== undefined) settings.push({ path: WIGGLY[k], value: aeValue(k, v) });
    }
  } else {
    if (s.basedOn !== undefined) settings.push({ path: ["ADBE Text Range Type2"], value: aeValue("basedOn", s.basedOn) });
    out.expression = { path: ["ADBE Text Expressible Amount"], text: s.amount };
  }
  return out;
}

export function toAeAnimatorProperties(p: z.infer<typeof AnimatorProperties> = {}, extra: { matchName: string; value: z.infer<typeof Value> }[] = []) {
  const out = Object.entries(p)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ({ matchName: PROPERTY[k], value: aeValue(k, v) }));
  return [...out, ...extra];
}

const GroupSummary = z.looseObject({ name: z.string(), matchName: z.string(), path: PropPath });

export const addTextAnimator = defineTool({
  name: "add_text_animator",
  title: "Add a text animator",
  description:
    "Adds a text animator to a text layer (or adds properties and selectors to an existing one), in one undo step: animator properties such as position, scale, rotation, opacity, fill color, tracking or blur, and the selectors that choose which characters they act on. A range selector with basedOn \"characters\", \"words\" or \"lines\" gives per-character, per-word or per-line offsets; animate its offset (or start/end) to make the classic cascades. A new animator gets one range selector unless selectors are given. Wiggly selectors randomize, expression selectors compute an amount per unit. The result lists the animator, its properties and each selector with paths, so their values can be animated with animate, e.g. [...selector.path, \"ADBE Text Percent Offset\"].",
  input: {
    compId: CompId,
    layerId: LayerId,
    animator: z
      .union([z.string().min(1), z.number().int().positive()])
      .optional()
      .describe("Add to this existing animator (name or 1-based index) instead of creating one."),
    name: z.string().min(1).optional().describe('Name for a new animator, e.g. "Rise in".'),
    properties: AnimatorProperties.optional(),
    otherProperties: z
      .array(z.object({ matchName: z.string().min(1), value: Value }))
      .optional()
      .describe('Animator properties by match name, e.g. { matchName: "ADBE Text Fill Hue", value: 90 }.'),
    selectors: z.array(TextSelector).optional().describe("Selectors to add, top to bottom."),
    moreOptions: MoreOptions.optional().describe("The text layer's More Options (shared by all its animators)."),
  },
  output: {
    layerId: z.number(),
    animator: GroupSummary,
    properties: z.array(GroupSummary),
    selectors: z.array(GroupSummary),
    warnings: Warnings,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  async run(args, ctx) {
    const properties = toAeAnimatorProperties(args.properties, args.otherProperties);
    const selectorInput = args.selectors ?? (args.animator === undefined ? [{ type: "range" as const }] : []);
    if (args.animator !== undefined && args.name !== undefined) throw new BridgeError("invalid_argument", "name is for a new animator; to rename an existing one use set_properties.");
    if (args.animator !== undefined && !properties.length && !selectorInput.length && !args.moreOptions) throw new BridgeError("invalid_argument", "Nothing to add: give properties, otherProperties, selectors or moreOptions.");
    const moreOptions = Object.entries(args.moreOptions ?? {})
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => ({ path: MORE[k], value: aeValue(k, v) }));
    const r = await callAE<Record<string, unknown>>(
      ctx,
      "add_text_animator",
      { compId: args.compId, layerId: args.layerId, animator: args.animator ?? null, name: args.name, properties, selectors: selectorInput.map(toAeSelector), moreOptions },
      { undo: args.animator === undefined ? `add text animator${args.name ? ` "${args.name}"` : ""}` : "add to text animator" },
    );
    return { structured: r.value, changedProject: r.changedProject };
  },
});
