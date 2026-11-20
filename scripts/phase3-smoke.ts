// Manual smoke test for text animators, gradient items, Essential Graphics, layer switches and keyframe
// details, against the real After Effects 2026. Usage: node scripts/phase3-smoke.ts [--keep]
// Works in one throwaway comp that it deletes at the end (unless --keep), so it is safe to run with a
// real project open. Run/log/frame folders go to ./.smoke.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AuditLog } from "../src/audit.ts";
import { OsascriptBridge } from "../src/bridge/osascript.ts";
import { resolvePaths } from "../src/paths.ts";
import { loadPolicy } from "../src/policy.ts";
import { createServer } from "../src/server.ts";

const root = join(process.cwd(), ".smoke");
mkdirSync(root, { recursive: true });
const paths = resolvePaths({ ...process.env, AE_MOTION_APP_SUPPORT: join(root, "app-support"), AE_MOTION_LOG_DIR: join(root, "logs"), AE_MOTION_FRAMES_DIR: join(root, "frames") });
const server = createServer({ bridge: new OsascriptBridge(paths), policy: loadPolicy(paths), paths }, new AuditLog(paths.auditLog));
const [a, b] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "ae-motion-phase3-smoke", version: "1" });
await Promise.all([server.connect(a), client.connect(b)]);

let failures = 0;
const nullSources: number[] = []; // null layers keep a solid in the project after the comp is deleted
type Result = { isError?: boolean; structuredContent?: any; content?: any[] };
const textOf = (r: Result) => (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join(" ");

async function step(label: string, tool: string, args: Record<string, unknown>, check: (r: Result) => string | true = (r) => (r.isError ? "error" : true)): Promise<Result> {
  const r = (await client.callTool({ name: tool, arguments: args })) as Result;
  const verdict = check(r);
  if (verdict === true) console.log(`✓ ${label}`);
  else {
    failures++;
    console.log(`✗ ${label}: ${verdict}\n    ${textOf(r).slice(0, 600)}`);
  }
  return r;
}
const ok = (pred: (s: any) => boolean, why: string) => (r: Result) => (r.isError ? "unexpected error" : pred(r.structuredContent) ? true : why);
const fails = (pattern: RegExp) => (r: Result) => (r.isError && pattern.test(textOf(r)) ? true : `expected an error matching ${pattern}`);
const near = (x: number, y: number) => Math.abs(x - y) < 0.01;


const setup = await step("check_setup", "check_setup", {}, ok((s) => s.ok, "setup has problems"));
if (!setup.structuredContent?.ok) process.exit(1);

const C = (await step("create comp", "create_comp", { name: "__ae-motion phase3 smoke", width: 800, height: 600, duration: 4, bgColor: "#0B0B14" })).structuredContent.comp.id;
try {
  // ---- text animators --------------------------------------------------------------------------
  const T = (await step("create text layer", "create_layer", { compId: C, type: "text", name: "Title", text: { text: "Power Agents\rwith ae-motion", fontSize: 60 } })).structuredContent.layer.id;
  const rise = await step(
    "add_text_animator: position + opacity, range selector by lines, ramp up",
    "add_text_animator",
    {
      compId: C,
      layerId: T,
      name: "Rise",
      properties: { position: [0, 80], opacity: 0 },
      selectors: [{ type: "range", name: "Lines", basedOn: "lines", shape: "rampUp", easeLow: 50 }],
      moreOptions: { anchorPointGrouping: "line" },
    },
    ok((s) => {
      const v = (mn: string) => s.selectors[0].properties.find((p: any) => p.matchName === mn)?.value;
      return s.animator.name === "Rise" && s.properties.length === 2 && s.properties[0].value.join() === "0,80,0" && v("ADBE Text Range Type2") === 4 && v("ADBE Text Range Shape") === 2 && v("ADBE Text Levels Min Ease") === 50;
    }, "animator values not as requested"),
  );
  const sel = rise.structuredContent.selectors[0];
  await step(
    "animate the range selector offset by its returned path",
    "animate",
    { compId: C, layerId: T, tracks: [{ property: [...sel.path, "ADBE Text Percent Offset"], ease: "easeOutCubic", keyframes: [{ time: 0, value: -100 }, { time: 1.5, value: 100 }] }] },
    ok((s) => s.tracks[0].numKeys === 2, "offset not animated"),
  );
  await step(
    "add tracking to the existing animator, by name",
    "add_text_animator",
    { compId: C, layerId: T, animator: "Rise", properties: { trackingAmount: 20 } },
    ok((s) => s.animator.index === 1 && s.properties[0].matchName === "ADBE Text Tracking Amount" && s.selectors.length === 0, "not added to Rise"),
  );
  await step(
    "wiggly selector on its own animator",
    "add_text_animator",
    { compId: C, layerId: T, name: "Jitter", properties: { rotation: 8 }, selectors: [{ type: "wiggly", basedOn: "characters", maxAmount: 100, minAmount: -100, mode: "add" }] },
    ok((s) => s.selectors[0].matchName === "ADBE Text Wiggly Selector", "no wiggly selector"),
  );
  await step(
    "index units: start/end count characters",
    "add_text_animator",
    { compId: C, layerId: T, name: "First word", properties: { fillColor: "#FF8A00" }, selectors: [{ type: "range", units: "index", basedOn: "words", start: 0, end: 1 }] },
    ok((s) => s.selectors[0].properties.find((p: any) => p.matchName === "ADBE Text Index End")?.value === 1, "index end not set"),
  );
  await step("expression selector with a broken expression warns", "add_text_animator", { compId: C, layerId: T, name: "Expr", properties: { blur: [2, 2] }, selectors: [{ type: "expression", amount: "// broken\nnope(" }] }, ok((s) => s.warnings.length === 1, "no warning"));
  await step("missing animator name lists the real ones", "add_text_animator", { compId: C, layerId: T, animator: "Nope", properties: { opacity: 50 } }, fails(/no text animator Nope.*1: Rise/));

  // ---- gradients -------------------------------------------------------------------------------
  const G = await step(
    "create_layer shape with a gradient fill warns about stops",
    "create_layer",
    { compId: C, type: "shape", name: "Gradient", position: [400, 500], shape: { contents: [{ type: "group", name: "Box", items: [{ type: "rectangle", size: [300, 120] }, { type: "gradientFill", gradientType: "linear", startPoint: [-150, 0], endPoint: [150, 0] }] }] } },
    ok((s) => s.warnings.some((w: string) => /colour stops/.test(w)) && s.items[2].properties.find((p: any) => p.matchName === "ADBE Vector Grad End Pt").value[0] === 150, "no warning or wrong end point"),
  );
  const GL = G.structuredContent.layer.id;
  await step("gradient stroke item", "add_shape_content", { compId: C, layerId: GL, group: ["Box"], items: [{ type: "gradientStroke", width: 6, lineCap: "round" }] }, ok((s) => s.items[0].matchName === "ADBE Vector Graphic - G-Stroke", "no gradient stroke"));

  // ---- layer switches --------------------------------------------------------------------------
  await step(
    "set_properties: T switch, motion blur, draft quality, guide, fx off",
    "set_properties",
    { compId: C, layerId: GL, layer: { preserveTransparency: true, motionBlur: true, quality: "draft", guideLayer: true, effectsActive: false } },
    ok((s) => {
      const w = s.layer.switches;
      return w.preserveTransparency && w.motionBlur && w.quality === "draft" && w.collapseTransformation && w.guideLayer && !w.effectsActive;
    }, "switches not set"),
  );
  await step("switches back off", "set_properties", { compId: C, layerId: GL, layer: { preserveTransparency: false, guideLayer: false, quality: "best" } }, ok((s) => !s.layer.switches.preserveTransparency && s.layer.switches.quality === "best", "not reset"));
  await step("continuously rasterize can't be turned off on a shape layer", "set_properties", { compId: C, layerId: GL, layer: { collapseTransformation: false } }, fails(/always continuously rasterized/));
  await step("frame blending on a shape layer is refused", "set_properties", { compId: C, layerId: GL, layer: { frameBlending: "frameMix" } }, fails(/can't frame-blend/));
  await step("per-character 3D on a shape layer is refused", "set_properties", { compId: C, layerId: GL, layer: { threeDPerChar: true } }, fails(/Per-character 3D is for text layers/));
  await step("per-character 3D text facing the camera", "set_properties", { compId: C, layerId: T, layer: { threeDPerChar: true, autoOrient: "charactersTowardCamera" } }, ok((s) => s.layer.switches.threeDPerChar && s.layer.switches.autoOrient === "charactersTowardCamera", "not set"));
  await step("and back", "set_properties", { compId: C, layerId: T, layer: { autoOrient: "off", threeDPerChar: false, threeD: false } }, ok((s) => !s.layer.switches.threeDPerChar, "still per-char 3D"));
  await step("comp switches", "set_properties", { compId: C, comp: { motionBlur: true, frameBlending: true, shutterAngle: 270 } }, ok((s) => s.comp.motionBlur && s.comp.frameBlending, "comp switches not set"));

  // ---- keyframe details ------------------------------------------------------------------------
  const mover = (await step("create null", "create_layer", { compId: C, type: "null", name: "Mover" })).structuredContent.layer;
  const N = mover.id;
  nullSources.push(mover.sourceId);
  const curved = await step(
    "animate position with motion path tangents, a roving middle key and a label",
    "animate",
    {
      compId: C,
      layerId: N,
      tracks: [
        {
          property: "position",
          ease: "linear",
          keyframes: [
            { time: 0, value: [100, 300], outTangent: [150, -200], label: 3 },
            { time: 1, value: [400, 200], roving: true },
            { time: 2, value: [700, 300], inTangent: [-150, -200] },
          ],
        },
      ],
    },
    ok((s) => {
      const k = s.tracks[0].keyframes;
      return k[0].outTangent[0] === 150 && k[0].outTangent[1] === -200 && k[0].spatialAutoBezier === false && k[0].label === 3 && k[1].roving === true && k[2].inTangent[0] === -150;
    }, "tangents/roving/label wrong"),
  );
  console.log(`    keys: ${JSON.stringify(curved.structuredContent?.tracks?.[0]?.keyframes?.map((k: any) => [k.time, k.inTangent, k.outTangent, k.roving]))}`);
  await step("animate scale", "animate", { compId: C, layerId: N, tracks: [{ property: "scale", keyframes: [{ time: 0, value: [100, 100] }, { time: 2, value: [50, 200] }] }] });
  await step(
    "edit_keyframes: exact per-dimension eases and hold",
    "edit_keyframes",
    {
      compId: C,
      layerId: N,
      property: "scale",
      keys: [
        { index: 1, outEase: [{ speed: 0, influence: 80 }, { speed: 0, influence: 20 }, { speed: 0, influence: 50 }] },
        { time: 2, inEase: { speed: 10, influence: 66 }, outInterpolation: "hold" },
      ],
    },
    ok((s) => {
      const k = s.keyframes;
      return k[0].outEase.length === 3 && k[0].outEase[0].influence === 80 && k[0].outEase[1].influence === 20 && k[1].inEase[2].influence === 66 && k[1].outInterpolation === "hold";
    }, "eases not as requested"),
  );
  await step("edit_keyframes: value and continuous tangents on position", "edit_keyframes", { compId: C, layerId: N, property: "position", keys: [{ index: 3, value: [650, 350], spatialContinuous: true }] }, ok((s) => s.keyframes[2].value[0] === 650 && s.keyframes[2].spatialContinuous === true, "not edited"));
  await step("roving the first key is refused", "edit_keyframes", { compId: C, layerId: N, property: "position", keys: [{ index: 1, roving: true }] }, fails(/first and last keyframes can't rove/));
  await step("tangents on opacity are refused", "animate", { compId: C, layerId: N, tracks: [{ property: "opacity", keyframes: [{ time: 0, value: 0, outTangent: [1, 1] }, { time: 1, value: 100 }] }] }, fails(/only for spatial properties/));
  await step("wrong number of eases is refused", "edit_keyframes", { compId: C, layerId: N, property: "scale", keys: [{ index: 1, outEase: [{ speed: 0, influence: 50 }] }] }, fails(/takes 3/));
  await step("no key at that time", "edit_keyframes", { compId: C, layerId: N, property: "scale", keys: [{ time: 1, label: 2 }] }, fails(/no keyframe at 1 s.*0, 2/));

  // ---- Essential Graphics ----------------------------------------------------------------------
  await step("add a Leading slider", "add_effect", { compId: C, layerId: T, effect: "Slider Control", name: "Leading", parameters: [{ name: "Slider", value: 72 }] });
  await step(
    "drive the text's leading from the slider",
    "set_expression",
    { compId: C, layerId: T, property: "sourceText", expression: '// leading from the "Leading" slider (Essential Graphics)\ntext.sourceText.style.setAutoLeading(false).setLeading(effect("Leading")("Slider"))' },
    ok((s) => s.expressionError === null, "expression error"),
  );
  const eg = await step(
    "essential_graphics: template name, source text and the slider as controls",
    "essential_graphics",
    { compId: C, templateName: "Smoke title", add: [{ layerId: T, property: "sourceText", name: "Headline" }, { layerId: T, property: ["ADBE Effect Parade", "Leading", "ADBE Slider Control-0001"], name: "Leading" }] },
    ok((s) => {
      const byName = (n: string) => s.controls.find((c: any) => c.name === n)?.index;
      return s.templateName === "Smoke title" && s.controls.length === 2 && s.added.every((a: any) => byName(a.name) === a.index) && s.added.map((a: any) => a.name).join() === "Headline,Leading";
    }, "added indexes don't match the controls"),
  );
  console.log(`    controls: ${JSON.stringify(eg.structuredContent?.controls)}`);
  const headline = eg.structuredContent.added[0].index;
  await step("rename a control", "essential_graphics", { compId: C, rename: [{ index: headline, name: "Title text" }] }, ok((s) => s.controls[headline - 1].name === "Title text", "not renamed"));
  await step("list controls (read-only)", "essential_graphics", { compId: C }, ok((s) => s.controls.length === 2, "wrong count"));
  await step("gradient colours can't be a control", "essential_graphics", { compId: C, add: [{ layerId: GL, property: ["ADBE Root Vectors Group", "Box", "ADBE Vectors Group", 2, "ADBE Vector Grad Colors"] }] }, fails(/can't be added to Essential Graphics/));
  await step("position can", "essential_graphics", { compId: C, add: [{ layerId: N, property: "position", name: "Mover position" }] }, ok((s) => s.controls.length === 3 && s.controls[s.added[0].index - 1].name === "Mover position", "position not added"));
  await step("renaming a missing control is refused", "essential_graphics", { compId: C, rename: [{ index: 9, name: "x" }] }, fails(/no control 9/));

  for (const time of [0.3, 0.9, 1.6]) {
    const r = await step(`capture_frame t=${time}`, "capture_frame", { compId: C, time });
    if (!r.isError) console.log(`    ${r.structuredContent.path}`);
  }
} finally {
  if (!process.argv.includes("--keep")) await step("delete the smoke comps", "delete_items", { itemIds: [C, ...nullSources] });
}
await client.close();
await server.close();
console.log(failures ? `\n${failures} step(s) failed` : "\nall steps passed");
process.exit(failures ? 1 : 0);
