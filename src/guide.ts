// What every agent needs to know, whatever its vendor (DESIGN.md §2, §6, §7). Sent as the server's
// `instructions` and, in longer form, as the motion_design_guide resource.
import { EASE_NAMES } from "./eases.ts";

export const INSTRUCTIONS = `ae-motion builds motion graphics live in the user's running Adobe After Effects 2026 and leaves a project a designer can edit by hand.

Use ae-motion (not a web/HTML video tool) whenever a designer will edit the result or an After Effects project (.aep) is wanted.

Workflow:
1. Call check_setup first. If it reports problems, tell the user the fix in plain words and stop until it's done.
2. Use ids from get_project / inspect_comp / create_* in later calls. Times are seconds; positions are comp pixels; colors are [r,g,b] 0-1 or "#RRGGBB".
3. Build with create_comp, create_layer, add_shape_content (paths, strokes, Trim Paths), add_text_animator (per-character/word/line text animation), set_properties (incl. layer switches), animate (keyframes), edit_keyframes (interpolation, exact eases, motion path tangents), set_expression, add_effect, set_layer_style, essential_graphics. Retime existing work with shift_keyframes, remove_keyframes and set_properties (layer timing, comp duration and work area).
4. Check your work with capture_frame at the key moments, look at the image, and fix what's off before telling the user it's done.
5. Every changing call is one Edit > Undo step in After Effects, named "ae-motion: …".

Make it editable:
- Prefer keyframes (animate) for anything a designer may want to retime or nudge. No per-frame keyframe dumps.
- Use expressions when they're the better tool; start each with a one-line // comment and put its knobs on a "Controls" null as slider/color/checkbox effects.
- Name every layer and comp, one comp per scene, nulls to move groups together.

If a call fails, read its "How to fix" line. Errors marked as changing the project left those changes in place.
After a timeout, not_run or script_aborted error, don't retry in a loop: every extra command sent while After Effects shows a dialog can add another dialog. Stop and ask the user to check After Effects, then continue.
Never drive After Effects with osascript or DoScriptFile yourself while ae-motion is available: those scripts run without dialog suppression, so each error opens a modal dialog in front of the user.
Read the motion_design_guide resource for more detail.`;

export const GUIDE = `# Motion design guide for ae-motion

## Editability (the .aep is the deliverable)
- Keyframes for anything a designer will want to retime or nudge. Keep keyframe counts small: a move is usually 2-4 keyframes with eases, not one per frame.
- Expressions where they're genuinely better: procedural backgrounds, many layers driven by one control, wiggle/loop behaviour. Add a "Controls" null layer, give it Slider/Color/Checkbox Control effects (add_effect "Slider Control"), and reference them from the expression. Start every expression with a one-line // comment.
- Name every layer and precomp. One comp per scene. Use nulls to move groups. Use label colors to group related layers.

## Eases
Named eases: ${EASE_NAMES.join(", ")}. Or give a cubic-bezier [x1, y1, x2, y2] like CSS.
A keyframe's ease shapes the motion from that keyframe to the next. Typical choices:
- Elements entering: easeOutCubic or easeOutExpo (fast in, settle).
- Elements leaving: easeInCubic.
- Moves between two rest positions: easeInOutCubic.
- A little overshoot ("lands harder", "bouncier"): easeOutBack.
- Steps or blinks: hold.

## Values
- position: [x, y] (or [x, y, z] for 3D layers) in comp pixels; [0, 0] is the top-left of the comp.
- scale: [x, y] in percent. rotation: degrees. opacity: 0-100.
- sourceText: a string, or { text, font, fontSize, fillColor, justification, tracking, leading }.
- Colors: [r, g, b] from 0 to 1, or "#RRGGBB".
- Any other property: a path of names or match names from the layer, e.g. ["ADBE Effect Parade", "Gaussian Blur", "Blurriness"]. inspect_layer lists them.

## Shape layers
- create_layer type "shape" makes a rectangle, ellipse or freeform path (shape.kind "path" with shape.path), or builds whole contents with shape.contents.
- add_shape_content adds more: path, rectangle, ellipse, polystar, fill, stroke (with taper), trimPaths, group (with its own transform and items), or any other operator by match name ("other").
- Order is as in AE's Contents list: paint and operators act on the paths above them in the same group. A drawn-on line is a group with path, stroke, trimPaths; animate the trim's Start/End.
- Paths are { vertices, inTangents, outTangents, closed }, with tangents relative to their vertex. inspect_layer reports existing paths the same way, so a path can be copied from one layer to another.
- Every added item comes back with its path; animate a property with that path plus its match name, e.g. [...trim.path, "ADBE Vector Trim End"].

- Gradient fills and strokes ("gradientFill", "gradientStroke") take type, start/end points and opacity, but scripts can't set their colour stops: they stay AE's default white-to-black. Tell the user which stops you meant so they can set them (Edit Gradient… next to Colors). For a two-colour gradient that needs no hand edit, Gradient Ramp (add_effect) has Start Color and End Color.

## Text animators
- add_text_animator adds an animator with properties (position, scale, rotation, opacity, fillColor, trackingAmount, blur…) and selectors. Values are what fully selected characters reach: { position: [0, 80], opacity: 0 } with an offset sweep makes characters rise in.
- Range selector: basedOn "characters", "words" or "lines" sets per-character / per-word / per-line offsets; shape "rampUp" with easeLow gives a soft cascade. Animate its Offset (or Start/End) by the returned path, e.g. [...selector.path, "ADBE Text Percent Offset"] from -100 to 100. units "index" counts units instead of percent.
- Wiggly selectors randomize; expression selectors compute Amount per unit (textIndex, textTotal).
- To add to an existing animator, pass animator (its name or index). moreOptions.anchorPointGrouping ("character", "word", "line", "all") sets what rotates and scales around its own anchor.

## Layer switches
- set_properties layer: preserveTransparency (the "T" switch), motionBlur, adjustmentLayer, guideLayer, collapseTransformation, effectsActive, quality, samplingQuality, frameBlending, audioEnabled, autoOrient, threeDPerChar. Comp: motionBlur, frameBlending, hideShyLayers, shutterAngle/Phase. inspect_comp lists each layer's switches.
- Motion blur and frame blending need both the layer's and the comp's switch on.

## Keyframe details
- Named eases cover most motion. When matching an existing AE animation exactly, give a keyframe inEase/outEase { speed, influence } as inspect_layer reports them (one per dimension for scale), and in/outInterpolation ("linear", "bezier", "hold").
- Curved motion paths: inTangent/outTangent on position keys, relative to the key, e.g. outTangent [150, -200]. spatialContinuous keeps the handles in line; roving (not on the first or last key) evens out speed.
- animate takes these per keyframe; edit_keyframes changes them on existing keys (by time or index) without re-setting values.

## Essential Graphics
- essential_graphics sets the template name and adds properties as named controls: Source Text, transform values, effect parameters. A control AE doesn't offer directly (e.g. text leading): add a Slider Control effect, drive the property with an expression (for leading: text.sourceText.style.setAutoLeading(false).setLeading(effect("Leading")("Slider"))), then add the slider.
- New controls go to the top of the list; the result gives each control's index. Scripts can't remove or reorder controls: ask the user to do that in the panel.
- In a comp that uses the template as a precomp, its controls are Essential Properties: set_properties with path ["ADBE Layer Overrides", "<control name>"].

## Layer styles
- set_layer_style applies drop shadow, inner/outer glow, bevel and emboss, satin, color/gradient overlay or stroke, and sets its settings by display name ("Size", "Spread", "Color", "Opacity"). Animate a setting with the returned path plus its match name, e.g. [...path, "outerGlow/blur"].
- It opens the comp in the viewer to apply the style. Glow-like looks can also come from effects (add_effect "Glow"), which need no viewer.

## Retiming
- Move keys with shift_keyframes (keeps eases and tangents), not by deleting and re-adding them.
- Layer start, in/out points, time stretch, parenting and Time Remap on/off: set_properties layer.*. Comp duration and work area: set_properties comp.*.
- Removing every Time Remap keyframe turns Time Remap off; remove_keyframes refuses to, and animate/shift_keyframes never empty a property.

## When something goes wrong
- timeout / not_run: After Effects is busy or showing a dialog. Ask the user to look; send nothing else until they say it's clear.
- script_aborted: After Effects started the script but it stopped before reporting back. Inspect what changed, then change the request instead of retrying it.
- If you must run your own ExtendScript (only when the policy enables run_jsx), use run_jsx: it gets dialog suppression, undo and the lock. Outside it, every script must start with app.beginSuppressDialogs(), log to a file after each step, never loop until a property has no keys, and never concatenate a string with an array.

## Checking your work
capture_frame shows the frame over the comp background color. Capture the key moments (start, the main beat, the end) and compare against what was asked.
`;
