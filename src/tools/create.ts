import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { BridgeError } from "../bridge/types.ts";
import { isPathAllowed } from "../policy.ts";
import { callAE, Color, CompId, defineTool, ItemSummary, LayerId, LayerSummary, PathShape, PropPath, Seconds, TextStyle, Warnings } from "./common.ts";
import { gradientWarnings, ShapeItem, toAeItems } from "./shapes.ts";

export const createComp = defineTool({
  name: "create_comp",
  title: "Create a composition",
  description: "Creates a new composition. One comp per scene keeps the project easy for designers to edit; give it a clear name.",
  input: {
    name: z.string().min(1),
    width: z.number().int().min(4).max(30000).default(1920),
    height: z.number().int().min(4).max(30000).default(1080),
    frameRate: z.number().min(1).max(999).default(30),
    duration: z.number().positive().max(10800).default(10).describe("Length in seconds."),
    pixelAspect: z.number().positive().default(1),
    bgColor: Color.optional().describe("Background color (also used behind captured frames)."),
    folderId: z.number().int().positive().optional().describe("Project folder to put the comp in."),
    openInViewer: z.boolean().default(true).describe("Open the comp in After Effects so the user sees it being built."),
  },
  output: { comp: ItemSummary },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  async run(args, ctx) {
    const r = await callAE<Record<string, unknown>>(ctx, "create_comp", args, { undo: `create comp "${args.name}"` });
    return { structured: { comp: r.value }, changedProject: r.changedProject };
  },
});

export const createLayer = defineTool({
  name: "create_layer",
  title: "Create a layer",
  description:
    "Adds a layer to a comp: text, shape (rectangle, ellipse, freeform path, or full contents with strokes, Trim Paths and groups), solid, null, adjustment, camera, light, or footage imported from a file. New layers go on top and last the whole comp unless timing is given. Name every layer so designers can find it. Shape layers come back with the paths of their contents, for add_shape_content and animate.",
  input: {
    compId: CompId,
    type: z.enum(["text", "shape", "solid", "null", "adjustment", "camera", "light", "footage"]),
    name: z.string().min(1).optional(),
    text: TextStyle.optional().describe("For text layers. fontSize defaults to 1/12 of the comp height; justification to center."),
    shape: z
      .object({
        kind: z.enum(["rectangle", "ellipse", "path"]).default("rectangle"),
        size: z.tuple([z.number().positive(), z.number().positive()]).optional().describe("[width, height] in pixels; default a quarter of the comp height."),
        roundness: z.number().min(0).optional().describe("Corner radius in pixels (rectangles)."),
        path: PathShape.optional().describe("For kind \"path\": a freeform bezier path, centered on the layer's position."),
        fillColor: z.union([Color, z.null()]).optional().describe("Fill color (default white), or null for no fill. Open paths default to no fill."),
        strokeColor: Color.optional().describe("Open paths default to a white stroke."),
        strokeWidth: z.number().min(0).optional().describe("Open paths default to 4 px."),
        contents: z
          .array(ShapeItem)
          .min(1)
          .optional()
          .describe("Build the layer's Contents from these items instead (same items as add_shape_content), e.g. a group with a path, a stroke and trimPaths. kind, size, colors etc. are then ignored."),
      })
      .optional()
      .describe("For shape layers: a simple rectangle, ellipse or path with fill/stroke, or full contents."),
    color: Color.optional().describe("For solid layers (default white)."),
    width: z.number().int().positive().optional().describe("For solid/adjustment layers; default comp width."),
    height: z.number().int().positive().optional().describe("For solid/adjustment layers; default comp height."),
    lightType: z.enum(["parallel", "spot", "point", "ambient"]).optional(),
    footagePath: z.string().optional().describe("For footage layers: absolute path of an image, video or audio file. Reused if already imported."),
    position: z.array(z.number()).min(2).max(3).optional().describe("[x, y] (or [x, y, z]) in comp pixels; default the comp center."),
    threeD: z.boolean().optional(),
    startTime: Seconds.optional(),
    inPoint: Seconds.optional(),
    outPoint: Seconds.optional(),
    parentLayerId: LayerId.optional().describe("Parent the new layer to this layer."),
    blendMode: z.string().optional().describe('Blend mode, e.g. "normal", "multiply", "screen", "add", "overlay".'),
  },
  output: {
    layer: LayerSummary,
    contents: z.array(z.looseObject({ name: z.string(), matchName: z.string(), path: PropPath })).optional().describe("Shape layers: the top-level contents."),
    items: z.array(z.looseObject({ name: z.string(), matchName: z.string(), path: PropPath })).optional().describe("Shape layers built from shape.contents: every item with its values."),
    warnings: Warnings,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  async run(args, ctx) {
    if (args.shape?.kind === "path" && !args.shape.path && !args.shape.contents) throw new BridgeError("invalid_argument", 'shape.kind "path" needs shape.path ({ vertices, inTangents?, outTangents?, closed? }).');
    let footage: { footagePath: string; footageUri: string } | undefined;
    if (args.type === "footage") {
      const p = args.footagePath;
      if (!p || !isAbsolute(p)) throw new BridgeError("invalid_argument", "Footage layers need footagePath, an absolute file path.");
      // Send AE the resolved real path that was checked, not the caller's spelling (symlinks, "..").
      let real: string;
      try {
        real = realpathSync(p);
      } catch {
        throw new BridgeError("not_found", `There is no file at "${p}".`);
      }
      if (!isPathAllowed(real, ctx.policy.importFolders)) {
        throw new BridgeError("invalid_argument", `Importing from "${p}" isn't allowed by this Mac's ae-motion policy.`, {
          fix: `Allowed folders: ${ctx.policy.importFolders.join(", ") || "none"}. Move the file there, or ask whoever manages this Mac to allow the folder.`,
        });
      }
      // ExtendScript's File() URI-decodes its argument ("%2E%2E" → ".."), so escape "%" or AE could open a
      // different file than the one checked above. create_layer.jsx also verifies the decoded path.
      footage = { footagePath: real, footageUri: real.replace(/%/g, "%25") };
    }
    const { contents, ...shape } = args.shape ?? {};
    const aeContents = args.type === "shape" && contents ? toAeItems(contents) : undefined;
    const sent = { ...args, ...footage, ...(aeContents ? { shape, contents: aeContents } : {}) };
    const r = await callAE<{ layer: Record<string, unknown>; warnings: string[] }>(ctx, "create_layer", sent, { undo: `add ${args.type} layer${args.name ? ` "${args.name}"` : ""}` });
    return { structured: { ...r.value, warnings: [...r.value.warnings, ...gradientWarnings(aeContents ?? [])] }, changedProject: r.changedProject };
  },
});
