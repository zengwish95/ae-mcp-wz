// Manual smoke test against the real After Effects 2026: drives the real server through an MCP client.
// Usage: node scripts/smoke.ts [--keep]   (--keep leaves the smoke comp in the project to look at)
// Work in a throwaway project. Run/log/frame folders go to ./.smoke (gitignored), not the real locations.
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
const client = new Client({ name: "ae-motion-smoke", version: "1" });
await Promise.all([server.connect(a), client.connect(b)]);

let failures = 0;
type Result = { isError?: boolean; structuredContent?: any; content?: any[] };

async function step(label: string, tool: string, args: Record<string, unknown>, check: (r: Result) => string | true = (r) => (r.isError ? "error" : true)): Promise<Result> {
  const t = performance.now();
  const r = (await client.callTool({ name: tool, arguments: args })) as Result;
  const verdict = check(r);
  const ms = Math.round(performance.now() - t);
  const textOut = (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join(" ");
  if (verdict === true) console.log(`✓ ${label} (${ms} ms)`);
  else {
    failures++;
    console.log(`✗ ${label} (${ms} ms): ${verdict}\n    ${textOut.slice(0, 600)}`);
  }
  return r;
}

const ok = (pred: (s: any) => boolean, why: string) => (r: Result) => (r.isError ? `unexpected error` : pred(r.structuredContent) ? true : why);
const fails = (pattern: RegExp) => (r: Result) => {
  const t = (r.content ?? []).map((c) => c.text ?? "").join(" ");
  return r.isError && pattern.test(t) ? true : `expected an error matching ${pattern}`;
};

const setup = await step("check_setup", "check_setup", {}, ok((s) => s.ok, "setup has problems"));
if (!setup.structuredContent?.ok) {
  console.log(JSON.stringify(setup.structuredContent?.problems, null, 2));
  process.exit(1);
}
await step("get_project", "get_project", {});

const comp = (await step("create_comp", "create_comp", { name: "ae-motion smoke", duration: 4, bgColor: "#101018" }, ok((s) => s.comp.id > 0, "no comp id"))).structuredContent.comp;
const C = comp.id;
const box = (await step("create_layer shape", "create_layer", { compId: C, type: "shape", name: "Box", shape: { kind: "rectangle", size: [300, 300], roundness: 40, fillColor: "#7B2FF7" } })).structuredContent.layer;
const title = (await step("create_layer text (unicode)", "create_layer", { compId: C, type: "text", name: "Title", text: { text: "ae-motion ✓ 日本", fontSize: 110, fillColor: [1, 1, 1] }, position: [960, 860] }, ok((s) => s.layer.text.text === "ae-motion ✓ 日本", "text mismatch"))).structuredContent.layer;
const controls = (await step("create_layer null", "create_layer", { compId: C, type: "null", name: "Controls" })).structuredContent.layer;

await step("add_effect Slider Control", "add_effect", { compId: C, layerId: controls.id, effect: "Slider Control", name: "Wiggle Amount", parameters: [{ name: "Slider", value: 15 }] }, ok((s) => s.parameters[0].value === 15, "slider not set"));
await step("add_effect unknown → suggestions", "add_effect", { compId: C, layerId: box.id, effect: "Gausian Blurr" }, fails(/not_found/));
await step("add_effect Gaussian Blur with parameter", "add_effect", { compId: C, layerId: box.id, effect: "Gaussian Blur", parameters: [{ name: "Blurriness", value: 4 }] });

await step(
  "animate position/scale (easeOutBack) + opacity",
  "animate",
  {
    compId: C,
    layerId: box.id,
    tracks: [
      { property: "position", ease: "easeOutBack", keyframes: [{ time: 0, value: [300, 480] }, { time: 1.5, value: [1620, 480] }] },
      { property: "scale", ease: "easeOutCubic", keyframes: [{ time: 0, value: [0, 0] }, { time: 1, value: [100, 100] }] },
      { property: "opacity", keyframes: [{ time: 0, value: 0, ease: "linear" }, { time: 0.5, value: 100 }] },
    ],
  },
  ok((s) => s.tracks.length === 3 && s.tracks[0].numKeys === 2 && s.tracks[0].keyframes[0].outEase.influence > 30, "keyframes/eases not as expected"),
);
await step("animate effect parameter by path", "animate", { compId: C, layerId: box.id, tracks: [{ property: ["ADBE Effect Parade", "Gaussian Blur", "Blurriness"], keyframes: [{ time: 0, value: 40 }, { time: 1.5, value: 0, ease: "hold" }] }] });
await step("animate title opacity", "animate", { compId: C, layerId: title.id, tracks: [{ property: "opacity", ease: "easeOutCubic", keyframes: [{ time: 1, value: 0 }, { time: 2, value: 100 }] }] });

await step(
  "set_expression (valid, reads Controls)",
  "set_expression",
  { compId: C, layerId: box.id, property: "rotation", expression: '// Wiggle strength comes from Controls > Wiggle Amount\nwiggle(2, thisComp.layer("Controls").effect("Wiggle Amount")("Slider"))' },
  ok((s) => s.expressionError === null, "expression should work"),
);
await step("set_expression (broken) reports expressionError", "set_expression", { compId: C, layerId: title.id, property: "rotation", expression: "wiggle(2," }, ok((s) => typeof s.expressionError === "string" && s.expressionError.length > 0, "no expressionError"));
await step("set_expression remove", "set_expression", { compId: C, layerId: title.id, property: "rotation", expression: null }, ok((s) => s.removed, "not removed"));

await step(
  "set_properties text/label/order/parent",
  "set_properties",
  { compId: C, layerId: title.id, text: { text: "Hello from ae-motion", tracking: 20 }, layer: { label: 9, moveTo: { position: "top" }, parentLayerId: controls.id } },
  ok((s) => s.layer.text.text === "Hello from ae-motion" && s.layer.parentId === controls.id && s.layer.index === 1, "properties not applied"),
);
await step("set_properties static value on animated property → animated", "set_properties", { compId: C, layerId: box.id, transform: { position: [0, 0] } }, fails(/\[animated\]/));
await step("set_properties comp settings", "set_properties", { compId: C, comp: { name: "ae-motion smoke", bgColor: "#0B0B14" } });
await step("set_properties missing font → warning", "set_properties", { compId: C, layerId: title.id, text: { font: "NoSuchFont-Regular" } }, ok((s) => s.warnings.length === 1, "no font warning"));
await step("unknown layer id → not_found", "inspect_layer", { compId: C, layerId: 999999 }, fails(/\[not_found\]/));

await step("inspect_comp", "inspect_comp", { compId: C, time: 1 }, ok((s) => s.layers.length === 3 && s.layers.some((l: any) => l.animated.length >= 3), "layers/animated missing"));
await step("inspect_layer (modified only)", "inspect_layer", { compId: C, layerId: box.id }, ok((s) => JSON.stringify(s.properties).includes("ADBE Gaussian Blur 2"), "effect missing from tree"));

for (const time of [0.25, 0.75, 1.6, 3]) {
  const r = await step(`capture_frame t=${time}`, "capture_frame", { compId: C, time }, ok((s) => s.width === 960 && s.height === 540, "unexpected size"));
  if (!r.isError) console.log(`    ${r.structuredContent.path}`);
}
await step("capture_frame full", "capture_frame", { compId: C, time: 2, resolution: "full" }, ok((s) => s.width === 1920, "not full size"));

await step("delete_items layer", "delete_items", { compId: C, layerIds: [title.id, 424242] }, ok((s) => s.removed.length === 1 && s.missing.length === 1, "unexpected delete result"));
// Null layers leave a "Null N" solid in the project after their comp is gone, so remove that too.
if (!process.argv.includes("--keep")) await step("delete_items comp + null solid (cleanup)", "delete_items", { itemIds: [C, controls.sourceId] }, ok((s) => s.removed.length === 2, "cleanup incomplete"));

await client.close();
await server.close();
console.log(failures ? `\n${failures} step(s) failed` : "\nAll smoke steps passed");
process.exit(failures ? 1 : 0);
