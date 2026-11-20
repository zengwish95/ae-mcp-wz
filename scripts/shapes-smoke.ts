// Manual smoke test for shape contents (freeform paths, strokes with taper, Trim Paths) and layer styles,
// against the real After Effects 2026. Usage: node scripts/shapes-smoke.ts [--keep]
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
const client = new Client({ name: "ae-motion-shapes-smoke", version: "1" });
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
const near = (x: number, y: number) => Math.abs(x - y) < 0.01;

// A 6-point hexagon outline, radius 150, like the "glow stroke template" rig.
const hexagon = (r: number, turn = 0) => Array.from({ length: 6 }, (_, i) => [Math.round(r * Math.cos(((i * 60 + turn) * Math.PI) / 180) * 100) / 100, Math.round(r * Math.sin(((i * 60 + turn) * Math.PI) / 180) * 100) / 100]);

const setup = await step("check_setup", "check_setup", {}, ok((s) => s.ok, "setup has problems"));
if (!setup.structuredContent?.ok) process.exit(1);

const C = (await step("create comp", "create_comp", { name: "__ae-motion shapes smoke", width: 800, height: 600, duration: 4, bgColor: "#0B0B14" })).structuredContent.comp.id;
try {
  const made = await step(
    "create_layer shape with contents: group > path, tapered stroke, trim paths",
    "create_layer",
    {
      compId: C,
      type: "shape",
      name: "STROKE base",
      shape: {
        contents: [
          {
            type: "group",
            name: "Line",
            transform: { scale: [172, 172], rotation: -64 },
            items: [
              { type: "path", name: "Hexagon", vertices: hexagon(150), closed: true },
              { type: "stroke", name: "Core", color: "#FFF4B0", width: 10, lineCap: "round", taper: { startLength: 30, endLength: 30, startWidth: 0, endWidth: 0 } },
              { type: "trimPaths", name: "Trim", end: 16.6 },
            ],
          },
        ],
      },
    },
    ok((s) => s.items.length === 4 && s.items[0].path.join("/") === "ADBE Root Vectors Group/Line" && s.items[3].name === "Trim", "unexpected items"),
  );
  const L = made.structuredContent.layer.id;
  const [group, hex, core, trim] = made.structuredContent.items;
  console.log(`    trim path: ${JSON.stringify(trim.path)}`);
  const val = (item: any, matchName: string) => item.properties.find((p: any) => p.matchName === matchName)?.value;
  const setOk = near(val(trim, "ADBE Vector Trim End"), 16.6) && val(core, "ADBE Vector Taper Start Length") === 30 && val(group, "ADBE Vector Scale")?.[0] === 172 && val(hex, "ADBE Vector Shape")?.vertices?.length === 6;
  await step("values were set, and inspect_layer reports path vertices", "inspect_layer", { compId: C, layerId: L }, ok((s) => setOk && JSON.stringify(s.properties).includes('"vertices"'), "values not as requested"));

  // The "left" line from the rig: start 0→16.6 over 0–0.67 s; end 0→4→16.6 at 0.42, 2.87, 3.47 s.
  await step(
    "animate Trim Paths start/end and taper by the returned paths",
    "animate",
    {
      compId: C,
      layerId: L,
      tracks: [
        { property: [...trim.path, "ADBE Vector Trim Start"], ease: "easeInOutCubic", keyframes: [{ time: 0, value: 0 }, { time: 0.67, value: 16.6 }] },
        { property: [...trim.path, "ADBE Vector Trim End"], ease: "easeInOutCubic", keyframes: [{ time: 0.42, value: 0 }, { time: 2.87, value: 4 }, { time: 3.47, value: 16.6 }] },
        { property: [...core.path, "ADBE Vector Stroke Taper", "ADBE Vector Taper Start Length"], keyframes: [{ time: 0, value: 0 }, { time: 1, value: 30 }] },
      ],
    },
    ok((s) => s.tracks.map((t: any) => t.numKeys).join() === "2,3,2", "wrong key counts"),
  );
  await step(
    "animate the path itself (ease on a Shape property)",
    "animate",
    { compId: C, layerId: L, tracks: [{ property: [...hex.path, "ADBE Vector Shape"], ease: "easeOutBack", keyframes: [{ time: 0, value: { vertices: hexagon(150) } }, { time: 2, value: { vertices: hexagon(120, 30), closed: true } }] }] },
    ok((s) => s.tracks[0].numKeys === 2 && s.tracks[0].keyframes[1].value.vertices.length === 6 && s.tracks[0].keyframes[0].outEase.influence > 30, "path keys wrong"),
  );
  await step("add a spare open path at the top level", "add_shape_content", { compId: C, layerId: L, items: [{ type: "path", name: "Spare", vertices: [[0, 0], [50, 0]], closed: false }] }, ok((s) => s.items[0].path.join("/") === "ADBE Root Vectors Group/Spare", "spare path not added"));
  await step(
    "set_properties replaces a static path",
    "set_properties",
    { compId: C, layerId: L, properties: [{ path: ["ADBE Root Vectors Group", "Spare", "ADBE Vector Shape"], value: { vertices: [[0, 0], [80, 40], [160, 0]], inTangents: [[0, 0], [-30, 0], [0, 0]], outTangents: [[0, 0], [30, 0], [0, 0]], closed: false } }] },
  );

  await step("add_shape_content into the group (fill + round corners by match name)", "add_shape_content", { compId: C, layerId: L, group: ["Line"], items: [{ type: "fill", color: "#FF8A00", opacity: 0 }, { type: "other", matchName: "ADBE Vector Filter - RC" }] }, ok((s) => s.items.length === 2 && s.items[1].matchName === "ADBE Vector Filter - RC", "items not added"));
  await step("a second group with the same name gets an index in its path", "add_shape_content", { compId: C, layerId: L, items: [{ type: "group", name: "Line", items: [{ type: "ellipse", size: [40, 40] }, { type: "fill" }] }] }, ok((s) => typeof s.items[0].path[1] === "number", "path not indexed"));

  const glow = await step(
    "set_layer_style applies Outer Glow and sets color, size, opacity",
    "set_layer_style",
    { compId: C, layerId: L, style: "outerGlow", settings: [{ name: "Color", value: "#FF4FA0" }, { name: "Size", value: 171 }, { name: "Opacity", value: 60 }] },
    ok((s) => s.style.applied && s.style.justApplied && s.settings.find((x: any) => x.matchName === "outerGlow/blur").value === 171, "glow not applied/set"),
  );
  await step("set_layer_style Inner Glow (orange) by match-name suffix", "set_layer_style", { compId: C, layerId: L, style: "innerGlow", settings: [{ name: "color", value: "#FF8A00" }, { name: "blur", value: 20 }] }, ok((s) => s.style.justApplied, "inner glow not applied"));
  await step("set_layer_style on an applied style doesn't re-run the menu command", "set_layer_style", { compId: C, layerId: L, style: "outerGlow", settings: [{ name: "Spread", value: 10 }] }, ok((s) => !s.style.justApplied && s.settings.find((x: any) => x.name === "Spread").value === 10, "re-applied or not set"));
  await step("an unknown setting lists the real ones", "set_layer_style", { compId: C, layerId: L, style: "outerGlow", settings: [{ name: "Glowiness", value: 1 }] }, fails(/no setting "Glowiness"/));
  await step("animate the glow size by the returned path", "animate", { compId: C, layerId: L, tracks: [{ property: [...glow.structuredContent.path, "outerGlow/blur"], keyframes: [{ time: 0, value: 60 }, { time: 2, value: 171 }] }] }, ok((s) => s.tracks[0].numKeys === 2, "glow not animated"));
  await step("hide the inner glow", "set_layer_style", { compId: C, layerId: L, style: "innerGlow", enabled: false }, ok((s) => s.style.enabled === false, "still enabled"));
  await step("a style that was never applied can't take settings when hidden", "set_layer_style", { compId: C, layerId: L, style: "satin", enabled: false, settings: [{ name: "Opacity", value: 5 }] }, fails(/isn't applied/));

  const solidLayer = (await step("create solid", "create_layer", { compId: C, type: "solid", name: "Not a shape", color: "#222233" })).structuredContent.layer;
  const solid = solidLayer.id;
  const cam = (await step("create camera", "create_layer", { compId: C, type: "camera", name: "Cam" })).structuredContent.layer.id;
  await step("add_shape_content on a solid is refused", "add_shape_content", { compId: C, layerId: solid, items: [{ type: "fill" }] }, fails(/shape contents need a shape layer/));
  await step("add_shape_content into a missing group is refused", "add_shape_content", { compId: C, layerId: L, group: ["Nope"], items: [{ type: "fill" }] }, fails(/no shape group Nope/));
  await step("set_layer_style on a camera is refused", "set_layer_style", { compId: C, layerId: cam, style: "dropShadow" }, fails(/can't have layer styles/));
  await step("drop shadow works on a solid too", "set_layer_style", { compId: C, layerId: solid, style: "dropShadow", settings: [{ name: "Distance", value: 12 }] }, ok((s) => s.style.applied, "no shadow"));
  // Deleting a solid layer leaves its solid in the project, so remove that too.
  await step("delete the helper layers and the solid", "delete_items", { compId: C, layerIds: [solid, cam], itemIds: [solidLayer.sourceId] });

  for (const time of [1, 3.47]) {
    const r = await step(`capture_frame t=${time}`, "capture_frame", { compId: C, time });
    if (!r.isError) console.log(`    ${r.structuredContent.path}`);
  }
} finally {
  if (!process.argv.includes("--keep")) await step("delete the smoke comp", "delete_items", { itemIds: [C] });
}
await client.close();
await server.close();
console.log(failures ? `\n${failures} step(s) failed` : "\nall steps passed");
process.exit(failures ? 1 : 0);
