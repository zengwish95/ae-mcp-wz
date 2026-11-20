import { captureFrame } from "./capture.ts";
import { createComp, createLayer } from "./create.ts";
import { addEffect, animate, deleteItems, removeEffect, setExpression, setProperties } from "./edit.ts";
import { essentialGraphics } from "./eg.ts";
import { editKeyframes, removeKeyframes, shiftKeyframes } from "./keyframes.ts";
import { getProject, inspectComp, inspectLayer } from "./project.ts";
import { runJsx } from "./raw.ts";
import { checkSetup } from "./setup.ts";
import { addShapeContent, setLayerStyle } from "./shapes.ts";
import { addTextAnimator } from "./text.ts";

export const ALL_TOOLS = [checkSetup, getProject, inspectComp, inspectLayer, createComp, createLayer, addShapeContent, addTextAnimator, setProperties, animate, editKeyframes, shiftKeyframes, removeKeyframes, setExpression, addEffect, removeEffect, setLayerStyle, essentialGraphics, deleteItems, captureFrame, runJsx];
