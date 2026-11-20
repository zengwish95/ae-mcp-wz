// Manual smoke test for retiming tools, remove_effect and abort handling, against the real After Effects 2026.
// Usage: node scripts/retime-smoke.ts [--keep]
// Works in two throwaway comps that it deletes at the end (unless --keep), so it is safe to run with a
// real project open. Run/log folders go to ./.smoke. Enables run_jsx for this run only.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AuditLog } from "../src/audit.ts";
import { OsascriptBridge } from "../src/bridge/osascript.ts";
import { resolvePaths } from "../src/paths.ts";
import { loadPolicy } from "../src/policy.ts";
import { createServer } from "../src/server.ts";

const root = join(process.cwd(), ".smoke");
const appSupport = join(root, "app-support-retime");
mkdirSync(appSupport, { recursive: true });
writeFileSync(join(appSupport, "policy.json"), JSON.stringify({ allowRawExtendScript: true }));
const paths = resolvePaths({ ...process.env, AE_MOTION_APP_SUPPORT: appSupport, AE_MOTION_LOG_DIR: join(root, "logs"), AE_MOTION_FRAMES_DIR: join(root, "frames"), AE_MOTION_MACHINE_POLICY: join(root, "no-machine-policy.json") });
const server = createServer({ bridge: new OsascriptBridge(paths), policy: loadPolicy(paths), paths }, new AuditLog(paths.auditLog));
const [a, b] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "ae-motion-retime-smoke", version: "1" });
await Promise.all([server.connect(a), client.connect(b)]);

let failures = 0;
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
const times = (s: any) => (s.keyframes ?? []).map((k: any) => k.time);
const same = (x: number[], y: number[]) => x.length === y.length && x.every((v, i) => Math.abs(v - y[i]) < 0.002);

const setup = await step("check_setup", "check_setup", {}, ok((s) => s.ok, "setup has problems"));
if (!setup.structuredContent?.ok) process.exit(1);

const outer = (await step("create outer comp", "create_comp", { name: "__ae-motion retime smoke", width: 640, height: 360, duration: 10 })).structuredContent.comp.id;
const inner = (await step("create inner comp", "create_comp", { name: "__ae-motion retime smoke inner", width: 640, height: 360, duration: 10 })).structuredContent.comp.id;
try {
  const pre = await step("run_jsx adds the inner comp as a layer", "run_jsx", { code: "var c = AEM.comp(ARGS.outer); var l = c.layers.add(AEM.item(ARGS.inner)); l.name = 'precomp'; return l.id;", args: { outer, inner }, undo: "add precomp" }, ok((s) => typeof s.value === "number", "no layer id"));
  const preId = pre.structuredContent.value;
  const solidId = (await step("create solid", "create_layer", { compId: outer, type: "solid", name: "solid", color: "#336699" })).structuredContent.layer.id;

  await step("timeRemapEnabled on a solid is refused cleanly", "set_properties", { compId: outer, layerId: solidId, layer: { timeRemapEnabled: true } }, fails(/invalid_argument.*can't be time-remapped/));
  await step("timeRemapEnabled on the precomp", "set_properties", { compId: outer, layerId: preId, layer: { timeRemapEnabled: true } }, ok((s) => s.layer.timeRemapEnabled === true, "Time Remap not on"));

  const remap = ["ADBE Time Remapping"];
  await step("animate replaces Time Remap keys without turning it off", "animate", { compId: outer, layerId: preId, tracks: [{ property: remap, keyframes: [{ time: 1, value: 0, ease: "linear" }, { time: 9, value: 5, ease: "linear" }] }] }, ok((s) => same(times(s.tracks[0]), [1, 9]), "wrong Time Remap keys"));
  await step("Time Remap is still on", "inspect_layer", { compId: outer, layerId: preId }, ok((s) => s.layer.timeRemapEnabled === true, "Time Remap turned off"));

  await step("animate opacity", "animate", { compId: outer, layerId: preId, tracks: [{ property: "opacity", keyframes: [{ time: 0, value: 0 }, { time: 1, value: 100 }, { time: 8, value: 100, ease: "easeInCubic" }, { time: 9, value: 0 }] }] }, ok((s) => same(times(s.tracks[0]), [0, 1, 8, 9]), "wrong opacity keys"));
  const shifted = await step("shift the out-animation 1 s later", "shift_keyframes", { compId: outer, layerId: preId, properties: ["opacity"], from: 7.5, offset: 1 }, ok((s) => same(times(s.properties[0]), [0, 1, 9, 10]) && s.properties[0].moved === 2, "wrong shifted times"));
  const k9 = shifted.structuredContent?.properties?.[0]?.keyframes?.[2];
  console.log(`    key at 9 s: out ${k9?.outInterpolation}, outEase influence ${k9?.outEase?.influence}`);
  await step("a colliding shift is refused before any change", "shift_keyframes", { compId: outer, layerId: preId, properties: ["opacity"], from: 8.5, offset: -9 }, fails(/same frame/));
  await step("scale every keyed property (incl. Time Remap) around 0", "shift_keyframes", { compId: outer, layerId: preId, scale: 0.5 }, ok((s) => s.properties.length === 2 && s.warnings.length === 0, "expected 2 properties and no warnings"));
  await step("Time Remap still on after shifting it", "inspect_layer", { compId: outer, layerId: preId }, ok((s) => s.layer.timeRemapEnabled === true, "Time Remap turned off"));

  await step("removing every Time Remap key is refused", "remove_keyframes", { compId: outer, layerId: preId, property: remap, all: true }, fails(/turns Time Remap off/));
  await step("remove one opacity key", "remove_keyframes", { compId: outer, layerId: preId, property: "opacity", times: [0] }, ok((s) => s.removed.length === 1 && s.numKeys === 3, "wrong removal"));

  // remove_effect: two Gaussian Blurs (ambiguous match name) and a named Glow an expression points at.
  await step("add blur 1", "add_effect", { compId: outer, layerId: solidId, effect: "ADBE Gaussian Blur 2" });
  await step("add blur 2", "add_effect", { compId: outer, layerId: solidId, effect: "ADBE Gaussian Blur 2", name: "Blur B" });
  await step("add named glow", "add_effect", { compId: outer, layerId: solidId, effect: "ADBE Glo2", name: "Glow - logo" });
  await step("expression that uses the glow", "set_expression", { compId: outer, layerId: solidId, property: "opacity", expression: "// follows the glow\neffect(\"Glow - logo\")(3) * 10" }, ok((s) => s.expressionError === null, "expression errored"));
  await step("an ambiguous match name is refused", "remove_effect", { compId: outer, layerId: solidId, effects: ["ADBE Gaussian Blur 2"] }, fails(/matches 2 effects/));
  await step("an unknown effect is refused, listing the effects", "remove_effect", { compId: outer, layerId: solidId, effects: [1, "Nope"] }, fails(/no effect "Nope"/));
  await step("remove by index", "remove_effect", { compId: outer, layerId: solidId, effects: [1] }, ok((s) => s.removed[0].index === 1 && s.remaining.length === 2 && s.remaining[0].name === "Blur B", "wrong effect removed"));
  await step("remove by name warns about the expression", "remove_effect", { compId: outer, layerId: solidId, effects: ["Glow - logo"] }, ok((s) => s.remaining.length === 1 && s.referencingExpressions.length === 1 && s.warnings.length === 1, "no expression warning"));
  await step("remove the opacity expression", "set_expression", { compId: outer, layerId: solidId, property: "opacity", expression: null });

  await step("stretch and parent with jump", "set_properties", { compId: outer, layerId: solidId, layer: { stretch: 200, parentLayerId: preId, parentWithJump: true } }, ok((s) => s.layer.stretch === 200 && s.layer.parentId === preId, "stretch/parent not set"));
  await step("parenting a layer to its own child is refused", "set_properties", { compId: outer, layerId: preId, layer: { parentLayerId: solidId } }, fails(/child of/));

  // A run that starts but never reports back must come back as script_aborted, not "busy or a dialog".
  // Simulated by putting a folder where the wrapper writes result.json, so the write fails.
  await step("a run with no result is reported as script_aborted", "run_jsx", { code: "new Folder(File($.fileName).parent.fsName + '/result.json').create(); return 1;", readOnly: true }, (r) => {
    const t = textOf(r);
    if (r.isError && /script_aborted/.test(t) && /before it changed anything/.test(t)) return true;
    return r.isError ? "wrong error" : "no error";
  });
  await step("the next call works normally", "inspect_comp", { compId: outer }, ok((s) => s.numLayers === 2, "comp not readable"));
} finally {
  if (!process.argv.includes("--keep")) await step("delete the smoke comps", "delete_items", { itemIds: [outer, inner] });
}
await client.close();
await server.close();
console.log(failures ? `\n${failures} step(s) failed` : "\nall steps passed");
process.exit(failures ? 1 : 0);
