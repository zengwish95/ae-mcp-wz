// Essential Graphics: the comp's template name and its controls (properties added to the panel).
import { z } from "zod";
import { BridgeError } from "../bridge/types.ts";
import { callAE, CompId, defineTool, LayerId, PropertyRef, PropPath, Warnings } from "./common.ts";

export const essentialGraphics = defineTool({
  name: "essential_graphics",
  title: "Edit a comp's Essential Graphics controls",
  description:
    'Sets up a comp\'s Essential Graphics panel, in one undo step: the template name, properties added as controls (with the name the panel shows), and new names for existing controls. Controls can be any property After Effects allows there: Source Text, transform values, effect parameters (e.g. a Slider Control driving an expression), colors, checkboxes, dropdowns. For a control AE has no direct property for (such as text leading), add an expression control effect to a layer, drive the property from it with set_expression, and add the effect\'s parameter here. Precomp layers then show the controls under Essential Properties, which set_properties can change by path ["ADBE Layer Overrides", <control name>]. Scripts can\'t remove or reorder controls; tell the user to do that in the panel.',
  input: {
    compId: CompId,
    templateName: z.string().min(1).optional().describe("Name of the template (shown at the top of the Essential Graphics panel)."),
    add: z
      .array(
        z.object({
          layerId: LayerId.describe("A layer in this comp."),
          property: PropertyRef,
          name: z.string().min(1).optional().describe("Name shown in the panel; defaults to After Effects' name for the property."),
        }),
      )
      .optional()
      .describe("Properties to add as controls, in order."),
    rename: z
      .array(z.object({ index: z.number().int().positive().describe("1-based control index, as returned in controls."), name: z.string().min(1) }))
      .optional(),
    open: z.boolean().optional().describe("Also show the comp in the Essential Graphics panel."),
  },
  output: {
    compId: z.number(),
    templateName: z.string(),
    controls: z.array(z.object({ index: z.number(), name: z.string() })),
    added: z.array(z.looseObject({ index: z.number(), name: z.string(), layerId: z.number(), path: PropPath })),
    warnings: Warnings,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  async run(args, ctx) {
    const n = (args.add?.length ?? 0) + (args.rename?.length ?? 0);
    if (!n && args.templateName === undefined && !args.open) {
      // Read-only: list the controls.
      const r = await callAE<Record<string, unknown>>(ctx, "essential_graphics", { compId: args.compId, add: [], rename: [] });
      return { structured: r.value, changedProject: false };
    }
    const names = args.rename?.map((r) => r.index) ?? [];
    if (new Set(names).size !== names.length) throw new BridgeError("invalid_argument", "rename names the same control twice.");
    const what = args.add?.length ? `add ${args.add.length} Essential Graphics control${args.add.length === 1 ? "" : "s"}` : "edit Essential Graphics";
    const r = await callAE<Record<string, unknown>>(ctx, "essential_graphics", { ...args, add: args.add ?? [], rename: args.rename ?? [] }, { undo: what });
    return { structured: r.value, changedProject: r.changedProject };
  },
});
