// Shape layer contents (paths, strokes, trim paths, …) and layer styles.
// Friendly items are turned into match names here, so the ExtendScript side stays generic and this
// mapping is unit-tested without After Effects.
import { z } from "zod";
import { BridgeError } from "../bridge/types.ts";
import { callAE, Color, CompId, defineTool, LayerId, PathShape, PropPath, Value, Warnings } from "./common.ts";

const Point = z.tuple([z.number(), z.number()]);
const Size = z.tuple([z.number().min(0), z.number().min(0)]);
const RelPath = z.union([z.string().min(1), z.array(z.union([z.string().min(1), z.number().int().positive()])).min(1)]);

const common = {
  name: z.string().min(1).optional().describe("Name shown in the layer's Contents, e.g. \"Hexagon\" or \"Trim\"."),
  properties: z
    .array(z.object({ path: RelPath, value: Value }))
    .optional()
    .describe('Any other property of this item by name or match name, or a path from the item down, e.g. { path: "ADBE Vector Repeater Copies", value: 5 }.'),
};

const PathItem = z.object({ type: z.literal("path"), ...common, ...PathShape.shape });
const RectItem = z.object({ type: z.literal("rectangle"), ...common, size: Size.optional(), position: Point.optional(), roundness: z.number().min(0).optional() });
const EllipseItem = z.object({ type: z.literal("ellipse"), ...common, size: Size.optional(), position: Point.optional() });
const PolystarItem = z.object({
  type: z.literal("polystar"),
  ...common,
  starType: z.enum(["star", "polygon"]).optional(),
  points: z.number().min(3).optional(),
  position: Point.optional(),
  rotation: z.number().optional(),
  outerRadius: z.number().min(0).optional(),
  innerRadius: z.number().min(0).optional().describe("Stars only."),
  outerRoundness: z.number().optional().describe("Percent."),
  innerRoundness: z.number().optional().describe("Percent, stars only."),
});
const FillItem = z.object({ type: z.literal("fill"), ...common, color: Color.optional(), opacity: z.number().min(0).max(100).optional() });
const Taper = z
  .object({
    startLength: z.number().min(0).max(100),
    endLength: z.number().min(0).max(100),
    startWidth: z.number().min(0).max(100),
    endWidth: z.number().min(0).max(100),
    startEase: z.number().min(0).max(100),
    endEase: z.number().min(0).max(100),
  })
  .partial()
  .describe("Stroke taper in percent: lengths along the path, widths of the stroke at the ends (0 = a point).");
const StrokeItem = z.object({
  type: z.literal("stroke"),
  ...common,
  color: Color.optional(),
  opacity: z.number().min(0).max(100).optional(),
  width: z.number().min(0).optional(),
  lineCap: z.enum(["butt", "round", "projecting"]).optional(),
  lineJoin: z.enum(["miter", "round", "bevel"]).optional(),
  miterLimit: z.number().min(1).optional(),
  taper: Taper.optional(),
});
const Gradient = {
  gradientType: z.enum(["linear", "radial"]).optional(),
  startPoint: Point.optional().describe("In the layer's own pixels, like the path's vertices."),
  endPoint: Point.optional(),
  highlightLength: z.number().optional().describe("Radial only, percent."),
  highlightAngle: z.number().optional().describe("Radial only, degrees."),
};
const GradientFillItem = z.object({ type: z.literal("gradientFill"), ...common, ...Gradient, opacity: z.number().min(0).max(100).optional() });
const GradientStrokeItem = z.object({
  type: z.literal("gradientStroke"),
  ...common,
  ...Gradient,
  opacity: z.number().min(0).max(100).optional(),
  width: z.number().min(0).optional(),
  lineCap: z.enum(["butt", "round", "projecting"]).optional(),
  lineJoin: z.enum(["miter", "round", "bevel"]).optional(),
});
const TrimItem = z.object({
  type: z.literal("trimPaths"),
  ...common,
  start: z.number().min(0).max(100).optional().describe("Percent of the path where the visible part starts."),
  end: z.number().min(0).max(100).optional().describe("Percent where it ends (default 100)."),
  offset: z.number().optional().describe("Degrees; 360 moves the trimmed part once around the path."),
  trimMultipleShapes: z.enum(["simultaneously", "individually"]).optional(),
});
const OtherItem = z.object({
  type: z.literal("other"),
  ...common,
  matchName: z
    .string()
    .min(1)
    .describe('Any other shape item by match name, e.g. "ADBE Vector Filter - Repeater", "ADBE Vector Filter - Offset", "ADBE Vector Filter - RC" (round corners), "ADBE Vector Filter - Merge", "ADBE Vector Filter - Wiggler", "ADBE Vector Filter - Zigzag".'),
});
const LEAVES = [PathItem, RectItem, EllipseItem, PolystarItem, FillItem, StrokeItem, GradientFillItem, GradientStrokeItem, TrimItem, OtherItem] as const;
const LeafItem = z.discriminatedUnion("type", LEAVES);
const GroupTransform = z
  .object({
    anchorPoint: Point,
    position: Point,
    scale: Point.describe("Percent."),
    rotation: z.number().describe("Degrees."),
    opacity: z.number().min(0).max(100),
    skew: z.number(),
    skewAxis: z.number(),
  })
  .partial();
const GroupItem = z.object({
  type: z.literal("group"),
  ...common,
  transform: GroupTransform.optional().describe("The group's own transform, inside the layer."),
  items: z.array(LeafItem).optional().describe("Items inside the group, in stacking order. To nest groups deeper, add the group, then call add_shape_content with group: [its name]."),
});

export const ShapeItem = z.discriminatedUnion("type", [GroupItem, ...LEAVES]);
export type ShapeItem = z.infer<typeof ShapeItem>;

const SHAPE_ITEM_HELP =
  'Items, top to bottom as in the Contents list: shapes ("path", "rectangle", "ellipse", "polystar"), paint ("fill", "stroke", "gradientFill", "gradientStroke"; gradient colour stops can\'t be set by script, see the warning), operators ("trimPaths", or "other" by match name), and "group" with its own items. Order matters as in After Effects: paint and operators act on the paths above them in the same group, so a typical line is path, stroke, trimPaths.';

// What the ExtendScript side gets: match names and property paths relative to the item.
export interface AeShapeItem {
  matchName: string;
  name?: string;
  settings: { path: (string | number)[]; value: unknown }[];
  children?: AeShapeItem[];
}

const MATCH = {
  group: "ADBE Vector Group",
  path: "ADBE Vector Shape - Group",
  rectangle: "ADBE Vector Shape - Rect",
  ellipse: "ADBE Vector Shape - Ellipse",
  polystar: "ADBE Vector Shape - Star",
  fill: "ADBE Vector Graphic - Fill",
  stroke: "ADBE Vector Graphic - Stroke",
  gradientFill: "ADBE Vector Graphic - G-Fill",
  gradientStroke: "ADBE Vector Graphic - G-Stroke",
  trimPaths: "ADBE Vector Filter - Trim",
} as const;

const GRADIENT_FIELDS = {
  gradientType: ["ADBE Vector Grad Type"],
  startPoint: ["ADBE Vector Grad Start Pt"],
  endPoint: ["ADBE Vector Grad End Pt"],
  highlightLength: ["ADBE Vector Grad HiLite Length"],
  highlightAngle: ["ADBE Vector Grad HiLite Angle"],
};
// Friendly field -> property path inside the item. (AE really spells "Roundess".)
const FIELDS: Record<string, Record<string, string[]>> = {
  rectangle: { size: ["ADBE Vector Rect Size"], position: ["ADBE Vector Rect Position"], roundness: ["ADBE Vector Rect Roundness"] },
  ellipse: { size: ["ADBE Vector Ellipse Size"], position: ["ADBE Vector Ellipse Position"] },
  polystar: {
    starType: ["ADBE Vector Star Type"],
    points: ["ADBE Vector Star Points"],
    position: ["ADBE Vector Star Position"],
    rotation: ["ADBE Vector Star Rotation"],
    outerRadius: ["ADBE Vector Star Outer Radius"],
    innerRadius: ["ADBE Vector Star Inner Radius"],
    outerRoundness: ["ADBE Vector Star Outer Roundess"],
    innerRoundness: ["ADBE Vector Star Inner Roundess"],
  },
  fill: { color: ["ADBE Vector Fill Color"], opacity: ["ADBE Vector Fill Opacity"] },
  stroke: {
    color: ["ADBE Vector Stroke Color"],
    opacity: ["ADBE Vector Stroke Opacity"],
    width: ["ADBE Vector Stroke Width"],
    lineCap: ["ADBE Vector Stroke Line Cap"],
    lineJoin: ["ADBE Vector Stroke Line Join"],
    miterLimit: ["ADBE Vector Stroke Miter Limit"],
  },
  gradientFill: { ...GRADIENT_FIELDS, opacity: ["ADBE Vector Fill Opacity"] },
  gradientStroke: {
    ...GRADIENT_FIELDS,
    opacity: ["ADBE Vector Stroke Opacity"],
    width: ["ADBE Vector Stroke Width"],
    lineCap: ["ADBE Vector Stroke Line Cap"],
    lineJoin: ["ADBE Vector Stroke Line Join"],
  },
  trimPaths: { start: ["ADBE Vector Trim Start"], end: ["ADBE Vector Trim End"], offset: ["ADBE Vector Trim Offset"], trimMultipleShapes: ["ADBE Vector Trim Type"] },
};
const TAPER: Record<string, string> = {
  startLength: "ADBE Vector Taper Start Length",
  endLength: "ADBE Vector Taper End Length",
  startWidth: "ADBE Vector Taper Start Width",
  endWidth: "ADBE Vector Taper End Width",
  startEase: "ADBE Vector Taper Start Ease",
  endEase: "ADBE Vector Taper End Ease",
};
const GROUP_TRANSFORM: Record<string, string> = {
  anchorPoint: "ADBE Vector Anchor",
  position: "ADBE Vector Position",
  scale: "ADBE Vector Scale",
  rotation: "ADBE Vector Rotation",
  opacity: "ADBE Vector Group Opacity",
  skew: "ADBE Vector Skew",
  skewAxis: "ADBE Vector Skew Axis",
};
// Dropdowns are 1-based menu indexes in AE.
const ENUMS: Record<string, string[]> = {
  starType: ["star", "polygon"],
  lineCap: ["butt", "round", "projecting"],
  lineJoin: ["miter", "round", "bevel"],
  trimMultipleShapes: ["simultaneously", "individually"],
  gradientType: ["linear", "radial"],
};
const SKIP = new Set(["type", "name", "properties", "items", "transform", "taper", "matchName", "vertices", "inTangents", "outTangents", "closed"]);

export function toAeItems(items: ShapeItem[]): AeShapeItem[] {
  return items.map((item) => {
    const settings: AeShapeItem["settings"] = [];
    const matchName = item.type === "other" ? item.matchName : MATCH[item.type];
    if (item.type === "path") {
      const n = item.vertices.length;
      for (const k of ["inTangents", "outTangents"] as const) {
        if (item[k] && item[k].length !== n) throw new BridgeError("invalid_argument", `Path${item.name ? ` "${item.name}"` : ""}: ${k} has ${item[k].length} entries but there are ${n} vertices.`);
      }
      const value: Record<string, unknown> = { vertices: item.vertices };
      if (item.inTangents) value.inTangents = item.inTangents;
      if (item.outTangents) value.outTangents = item.outTangents;
      value.closed = item.closed ?? true;
      settings.push({ path: ["ADBE Vector Shape"], value });
    }
    const fields = FIELDS[item.type] ?? {};
    for (const [k, v] of Object.entries(item)) {
      if (SKIP.has(k) || v === undefined) continue;
      const path = fields[k];
      if (!path) continue;
      settings.push({ path, value: ENUMS[k] ? ENUMS[k].indexOf(v as string) + 1 : v });
    }
    if (item.type === "stroke" && item.taper) {
      for (const [k, v] of Object.entries(item.taper)) if (v !== undefined) settings.push({ path: ["ADBE Vector Stroke Taper", TAPER[k]], value: v });
    }
    if (item.type === "group" && item.transform) {
      for (const [k, v] of Object.entries(item.transform)) if (v !== undefined) settings.push({ path: ["ADBE Vector Transform Group", GROUP_TRANSFORM[k]], value: v });
    }
    for (const p of item.properties ?? []) settings.push({ path: typeof p.path === "string" ? [p.path] : p.path, value: p.value });
    const out: AeShapeItem = { matchName, settings };
    if (item.name !== undefined) out.name = item.name;
    if (item.type === "group" && item.items?.length) out.children = toAeItems(item.items);
    return out;
  });
}

const ShapeItemSummary = z.looseObject({ name: z.string(), matchName: z.string(), path: PropPath });

export const addShapeContent = defineTool({
  name: "add_shape_content",
  title: "Add paths, strokes, trim paths and more to a shape layer",
  description: `Adds items to a shape layer's Contents (or to a group in it), in one undo step: freeform bezier paths, rectangles, ellipses, stars/polygons, fills, strokes (with taper), Trim Paths, groups, and any other shape operator by match name (repeater, offset, round corners, wiggle…). ${SHAPE_ITEM_HELP} The result lists every added item with its path and values; animate any of them with that path plus the property's match name, e.g. [...trimPathsItem.path, "ADBE Vector Trim End"]. Create the layer with create_layer (type "shape", shape.contents builds the whole layer in one call).`,
  input: {
    compId: CompId,
    layerId: LayerId,
    group: z
      .array(z.union([z.string().min(1), z.number().int().positive()]))
      .optional()
      .describe('Add inside this group: group names (or 1-based indexes) from the layer\'s Contents down, e.g. ["Line"]. Omit to add at the top level.'),
    items: z.array(ShapeItem).min(1).describe(SHAPE_ITEM_HELP),
  },
  output: { layerId: z.number(), items: z.array(ShapeItemSummary), warnings: Warnings },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  async run(args, ctx) {
    const items = toAeItems(args.items);
    const r = await callAE<{ warnings: string[] }>(ctx, "add_shape_content", { compId: args.compId, layerId: args.layerId, group: args.group ?? [], items }, { undo: `add ${describeItems(args.items)}` });
    return { structured: { ...r.value, warnings: [...r.value.warnings, ...gradientWarnings(items)] }, changedProject: r.changedProject };
  },
});

const LABEL: Record<ShapeItem["type"], string> = {
  group: "group",
  path: "path",
  rectangle: "rectangle",
  ellipse: "ellipse",
  polystar: "polystar",
  fill: "fill",
  stroke: "stroke",
  gradientFill: "gradient fill",
  gradientStroke: "gradient stroke",
  trimPaths: "trim paths",
  other: "shape item",
};
// After Effects gives scripts no access to gradient colour stops (no value, no expressions; checked in
// AE 26.5), so a gradient keeps AE's default white-to-black ramp until a person edits it.
const GRADIENT_MATCH = new Set<string>([MATCH.gradientFill, MATCH.gradientStroke]);
export function gradientWarnings(items: AeShapeItem[]): string[] {
  const n = (list: AeShapeItem[]): number => list.reduce((sum, i) => sum + (GRADIENT_MATCH.has(i.matchName) ? 1 : 0) + n(i.children ?? []), 0);
  const count = n(items);
  if (!count) return [];
  return [
    `${count === 1 ? "The gradient uses" : `The ${count} gradients use`} After Effects' default white-to-black colours: scripts can't set gradient colour stops. Tell the user which stops you intended, so they can set them in After Effects: select the gradient, click "Edit Gradient…" next to Colors, and set each stop.`,
  ];
}

export function describeItems(items: ShapeItem[]): string {
  return items.length === 1 ? LABEL[items[0].type] : `${items.length} shape items`;
}

// ---- layer styles ----------------------------------------------------------------------------------

// Match name of the style group and its Layer > Layer Styles menu command (stable ids; the menu names
// are localized). Pattern Overlay has no menu command in After Effects, so it can't be applied.
export const LAYER_STYLES = {
  dropShadow: { matchName: "dropShadow/enabled", command: 9000, label: "Drop Shadow" },
  innerShadow: { matchName: "innerShadow/enabled", command: 9001, label: "Inner Shadow" },
  outerGlow: { matchName: "outerGlow/enabled", command: 9002, label: "Outer Glow" },
  innerGlow: { matchName: "innerGlow/enabled", command: 9003, label: "Inner Glow" },
  bevelEmboss: { matchName: "bevelEmboss/enabled", command: 9004, label: "Bevel and Emboss" },
  satin: { matchName: "chromeFX/enabled", command: 9005, label: "Satin" },
  colorOverlay: { matchName: "solidFill/enabled", command: 9006, label: "Color Overlay" },
  gradientOverlay: { matchName: "gradientFill/enabled", command: 9007, label: "Gradient Overlay" },
  stroke: { matchName: "frameFX/enabled", command: 9008, label: "Stroke" },
} as const;
const STYLE_NAMES = Object.keys(LAYER_STYLES) as [keyof typeof LAYER_STYLES, ...(keyof typeof LAYER_STYLES)[]];

export const setLayerStyle = defineTool({
  name: "set_layer_style",
  title: "Apply or change a layer style",
  description:
    'Applies a layer style (Layer > Layer Styles: drop shadow, inner shadow, outer glow, inner glow, bevel and emboss, satin, color overlay, gradient overlay, stroke) to a layer if it doesn\'t have it yet, and sets its settings, in one undo step. Applying one opens the comp in the viewer and briefly selects the layer (the selection is restored). Settings go by display name ("Size", "Spread", "Opacity", "Color", "Blend Mode") or match name ("outerGlow/blur"); dropdowns take their 1-based menu index. The result lists every setting with its path, so it can be animated with animate. enabled: false hides an applied style (AE has no script command to remove a single style).',
  input: {
    compId: CompId,
    layerId: LayerId,
    style: z.enum(STYLE_NAMES),
    enabled: z.boolean().optional().describe("Show (default when applying) or hide the style."),
    settings: z.array(z.object({ name: z.string().min(1), value: Value })).optional().describe('e.g. [{ name: "Color", value: "#FF4FA0" }, { name: "Size", value: 171 }, { name: "Opacity", value: 60 }].'),
  },
  output: {
    layerId: z.number(),
    style: z.looseObject({ name: z.string(), matchName: z.string(), applied: z.boolean(), enabled: z.boolean() }),
    path: PropPath,
    settings: z.array(z.looseObject({ name: z.string(), matchName: z.string() })),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async run(args, ctx) {
    const s = LAYER_STYLES[args.style];
    const verb = args.enabled === false ? "hide" : args.settings?.length ? "set" : "apply";
    const r = await callAE<Record<string, unknown>>(
      ctx,
      "set_layer_style",
      { compId: args.compId, layerId: args.layerId, matchName: s.matchName, command: s.command, styleName: s.label, enabled: args.enabled, settings: args.settings },
      { undo: `${verb} ${s.label}` },
    );
    return { structured: r.value, changedProject: r.changedProject };
  },
});
