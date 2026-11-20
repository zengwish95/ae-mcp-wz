// End to end through a real MCP client over an in-memory transport, with a mock bridge.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { BridgeError, FIXES } from "../src/bridge/types.ts";
import { encodePng } from "../src/png.ts";
import { connect, text } from "./helpers.ts";

test("lists the tools with descriptions, schemas and annotations; serves the guide", async () => {
  const t = await connect();
  try {
    const { tools } = await t.client.listTools();
    const names = tools.map((x) => x.name).sort();
    assert.deepEqual(names, ["add_effect", "add_shape_content", "add_text_animator", "animate", "capture_frame", "check_setup", "create_comp", "create_layer", "delete_items", "edit_keyframes", "essential_graphics", "get_project", "inspect_comp", "inspect_layer", "remove_effect", "remove_keyframes", "set_expression", "set_layer_style", "set_properties", "shift_keyframes"]);
    for (const tool of tools) {
      assert.ok(tool.description && tool.description.length > 40, tool.name);
      assert.equal(tool.inputSchema.type, "object");
      assert.ok(tool.outputSchema, `${tool.name} has an output schema`);
      assert.equal(typeof tool.annotations?.readOnlyHint, "boolean", tool.name);
    }
    assert.equal(tools.find((x) => x.name === "delete_items")!.annotations!.destructiveHint, true);
    assert.match(t.client.getInstructions() ?? "", /check_setup first/);
    const guide = await t.client.readResource({ uri: "ae-motion://guide" });
    assert.match(String((guide.contents[0] as { text?: string }).text), /Editability/);
  } finally {
    await t.close();
  }
});

test("create_comp sends defaults and an undo label, and is audited", async () => {
  const t = await connect();
  try {
    t.bridge.handler = () => ({ id: 7, name: "Intro", type: "comp", width: 1920, height: 1080 });
    const r = await t.client.callTool({ name: "create_comp", arguments: { name: "Intro" } });
    assert.ok(!r.isError, text(r));
    assert.deepEqual((r.structuredContent as { comp: { id: number } }).comp.id, 7);
    const call = t.bridge.calls[0];
    assert.equal(call.tool, "create_comp");
    assert.equal(call.undo, 'ae-motion: create comp "Intro"');
    assert.deepEqual(call.args, { name: "Intro", width: 1920, height: 1080, frameRate: 30, duration: 10, pixelAspect: 1, openInViewer: true });
    const log = readFileSync(t.paths.auditLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(log[0].tool, "create_comp");
    assert.equal(log[0].client, "test-client 1.0.0");
    assert.equal(log[0].changedProject, true);
  } finally {
    await t.close();
  }
});

test("read-only tools don't open an undo group", async () => {
  const t = await connect();
  try {
    t.bridge.handler = () => ({ project: { name: "Untitled", file: null, dirty: false, numItems: 0 }, items: [], nextOffset: null });
    const r = await t.client.callTool({ name: "get_project", arguments: {} });
    assert.ok(!r.isError, text(r));
    assert.equal(t.bridge.calls[0].undo, undefined);
  } finally {
    await t.close();
  }
});

test("bridge errors come back as isError text with the fix and the partial-change note", async () => {
  const t = await connect();
  try {
    t.bridge.handler = () => {
      throw new BridgeError("pref_disabled", "no result", { fix: FIXES.pref_disabled });
    };
    const r = await t.client.callTool({ name: "get_project", arguments: {} });
    assert.equal(r.isError, true);
    assert.match(text(r), /\[pref_disabled\]/);
    assert.match(text(r), /How to fix: In After Effects, open Settings > Scripting & Expressions/);

    t.bridge.handler = () => {
      throw new BridgeError("script_error", "After Effects error: bad value", { changedProject: true, detail: { hint: 1 } });
    };
    const r2 = await t.client.callTool({ name: "set_properties", arguments: { compId: 1, layerId: 2, transform: { opacity: 50 } } });
    assert.match(text(r2), /still in the project/);
    assert.match(text(r2), /Detail: \{"hint":1\}/);
    const log = readFileSync(t.paths.auditLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(log.map((l) => l.error), ["pref_disabled", "script_error"]);
  } finally {
    await t.close();
  }
});

test("invalid input is rejected before reaching After Effects", async () => {
  const t = await connect();
  try {
    const r = await t.client.callTool({ name: "create_comp", arguments: { name: "", width: -5 } });
    assert.equal(r.isError, true);
    assert.equal(t.bridge.calls.length, 0);
  } finally {
    await t.close();
  }
});

test("animate sorts keyframes, resolves eases and rejects duplicate times", async () => {
  const t = await connect();
  try {
    t.bridge.handler = () => ({ layerId: 2, tracks: [{ property: "Position", numKeys: 2 }], warnings: [] });
    const r = await t.client.callTool({
      name: "animate",
      arguments: { compId: 1, layerId: 2, tracks: [{ property: "position", ease: "easeOutBack", keyframes: [{ time: 1, value: [960, 540] }, { time: 0, value: [0, 540], ease: "linear" }, { time: 2, value: [960, 600], ease: [0.1, 0.2, 0.3, 1] }] }] },
    });
    assert.ok(!r.isError, text(r));
    const args = t.bridge.calls[0].args as { tracks: { replace: boolean; keyframes: { time: number; ease: unknown }[] }[] };
    assert.deepEqual(args.tracks[0].keyframes.map((k) => k.time), [0, 1, 2]);
    assert.deepEqual(args.tracks[0].keyframes.map((k) => k.ease), ["linear", [0.34, 1.56, 0.64, 1], [0.1, 0.2, 0.3, 1]]);
    assert.equal(args.tracks[0].replace, true);
    assert.equal(t.bridge.calls[0].undo, "ae-motion: animate position");

    const dup = await t.client.callTool({ name: "animate", arguments: { compId: 1, layerId: 2, tracks: [{ property: "opacity", keyframes: [{ time: 1, value: 0 }, { time: 1, value: 100 }] }] } });
    assert.equal(dup.isError, true);
    assert.match(text(dup), /Two keyframes at 1 s/);
  } finally {
    await t.close();
  }
});

test("footage import is checked against the policy before AE is called", async () => {
  const t = await connect();
  try {
    const r = await t.client.callTool({ name: "create_layer", arguments: { compId: 1, type: "footage", footagePath: "/etc/hosts" } });
    assert.equal(r.isError, true);
    assert.match(text(r), /isn't allowed by this Mac's ae-motion policy/);
    assert.equal(t.bridge.calls.length, 0);
  } finally {
    await t.close();
  }
});

test("footage is sent as its checked real path, with % escaped for ExtendScript's File()", async () => {
  const t = await connect();
  try {
    const { mkdirSync, symlinkSync } = await import("node:fs");
    const { join } = await import("node:path");
    mkdirSync(join(t.paths.home, "assets"), { recursive: true });
    const file = join(t.paths.home, "assets", "50%2E.png");
    writeFileSync(file, "x");
    symlinkSync(file, join(t.paths.home, "link.png"));
    t.bridge.handler = () => ({ layer: { id: 2, index: 1, name: "logo", type: "footage" }, warnings: [] });
    const r = await t.client.callTool({ name: "create_layer", arguments: { compId: 1, type: "footage", footagePath: join(t.paths.home, "link.png") } });
    assert.ok(!r.isError, text(r));
    const args = t.bridge.calls[0].args as { footagePath: string; footageUri: string };
    assert.ok(args.footagePath.endsWith(join("assets", "50%2E.png")));
    assert.ok(args.footageUri.endsWith(join("assets", "50%252E.png")));
    const missing = await t.client.callTool({ name: "create_layer", arguments: { compId: 1, type: "footage", footagePath: join(t.paths.home, "nope.png") } });
    assert.equal(missing.isError, true);
    assert.equal(t.bridge.calls.length, 1);
  } finally {
    await t.close();
  }
});

test("policy can switch a tool off", async () => {
  const t = await connect({ policy: { disabledTools: ["delete_items"] } });
  try {
    const r = await t.client.callTool({ name: "delete_items", arguments: { itemIds: [3] } });
    assert.equal(r.isError, true);
    assert.match(text(r), /switched off/);
    assert.equal(t.bridge.calls.length, 0);
  } finally {
    await t.close();
  }
});

test("capture_frame flattens AE's RGBA frame, downsizes it and returns image + path", async () => {
  const t = await connect();
  try {
    t.bridge.handler = (req) => {
      const { outPath } = req.args as { outPath: string };
      // 4x2 fully transparent frame: after flattening it must be the comp background (blue).
      writeFileSync(outPath, encodePng({ width: 4, height: 2, channels: 4, data: new Float32Array(4 * 2 * 4) }));
      return { compId: 1, name: "Intro / v1", time: 1, frame: 30, width: 4, height: 2, bgColor: [0, 0, 1] };
    };
    const r = await t.client.callTool({ name: "capture_frame", arguments: { compId: 1, time: 1, resolution: "half" } });
    assert.ok(!r.isError, text(r));
    const content = r.content as { type: string; data?: string; mimeType?: string }[];
    assert.equal(content[0].type, "image");
    assert.equal(content[0].mimeType, "image/png");
    const s = r.structuredContent as { path: string; width: number; height: number };
    assert.deepEqual([s.width, s.height], [2, 1]);
    assert.ok(existsSync(s.path) && s.path.startsWith(t.paths.framesDir));
    const { decodePng } = await import("../src/png.ts");
    const img = decodePng(readFileSync(s.path));
    assert.deepEqual([...img.data.slice(0, 3)], [0, 0, 1]);
    assert.equal(existsSync((t.bridge.calls[0].args as { outPath: string }).outPath), false, "raw frame removed");
  } finally {
    await t.close();
  }
});

test("check_setup reports problems with fixes and launches AE on request", async () => {
  const t = await connect();
  try {
    t.bridge.state = { installed: t.bridge.state.installed, running: false };
    t.bridge.pref = { enabled: false };
    const r = await t.client.callTool({ name: "check_setup", arguments: {} });
    const s = r.structuredContent as { ok: boolean; problems: { code: string; fix: string }[]; scriptingPref: string };
    assert.equal(s.ok, false);
    assert.deepEqual(s.problems.map((p) => p.code), ["not_running", "pref_disabled"]);
    assert.ok(s.problems.every((p) => p.fix.length > 10));
    assert.equal(s.scriptingPref, "off");

    t.bridge.pref = { enabled: true };
    t.bridge.handler = () => ({ version: "26.5x89", scriptingPref: true, project: { name: "Untitled Project", file: null, dirty: false, numItems: 0, renderQueueItems: 0, rendering: false } });
    const r2 = await t.client.callTool({ name: "check_setup", arguments: { launch: true } });
    const s2 = r2.structuredContent as { ok: boolean; automationPermission: string };
    assert.ok(t.bridge.launched);
    assert.equal(s2.ok, true, text(r2));
    assert.equal(s2.automationPermission, "granted");

    t.bridge.handler = () => {
      throw new BridgeError("permission_denied", "Not authorized", { fix: FIXES.permission_denied });
    };
    const r3 = await t.client.callTool({ name: "check_setup", arguments: {} });
    assert.equal((r3.structuredContent as { automationPermission: string }).automationPermission, "denied");
  } finally {
    await t.close();
  }
});

test("delete_items validates its arguments", async () => {
  const t = await connect();
  try {
    const r = await t.client.callTool({ name: "delete_items", arguments: { layerIds: [1] } });
    assert.match(text(r), /needs the compId/);
    const r2 = await t.client.callTool({ name: "delete_items", arguments: {} });
    assert.match(text(r2), /Give layerIds and\/or itemIds/);
  } finally {
    await t.close();
  }
});

test("run_jsx is hidden unless the policy allows raw ExtendScript, and then runs through the wrapper", async () => {
  const off = await connect();
  try {
    const { tools } = await off.client.listTools();
    assert.ok(!tools.some((x) => x.name === "run_jsx"));
  } finally {
    await off.close();
  }
  const on = await connect({ policy: { allowRawExtendScript: true } });
  try {
    const { tools } = await on.client.listTools();
    assert.ok(tools.some((x) => x.name === "run_jsx"));
    on.bridge.handler = () => 42;
    const r = await on.client.callTool({ name: "run_jsx", arguments: { code: "return ARGS.n;", args: { n: 42 }, undo: "nudge" } });
    assert.ok(!r.isError, text(r));
    assert.deepEqual(r.structuredContent, { value: 42 });
    const call = on.bridge.calls.at(-1)!;
    assert.equal(call.body, "return ARGS.n;");
    assert.deepEqual(call.args, { n: 42 });
    assert.equal(call.undo, "ae-motion: nudge");
    await on.client.callTool({ name: "run_jsx", arguments: { code: "return 1;", readOnly: true } });
    assert.equal(on.bridge.calls.at(-1)!.undo, undefined);
  } finally {
    await on.close();
  }
});

test("shift_keyframes and remove_keyframes validate before calling After Effects", async () => {
  const t = await connect();
  try {
    const nothing = await t.client.callTool({ name: "shift_keyframes", arguments: { compId: 1, layerId: 2 } });
    assert.ok(nothing.isError);
    assert.match(text(nothing), /offset and\/or a scale/);
    const backwards = await t.client.callTool({ name: "shift_keyframes", arguments: { compId: 1, layerId: 2, offset: 1, from: 5, to: 2 } });
    assert.ok(backwards.isError);
    const two = await t.client.callTool({ name: "remove_keyframes", arguments: { compId: 1, layerId: 2, property: "opacity", all: true, times: [1] } });
    assert.ok(two.isError);
    assert.match(text(two), /exactly one/);
    assert.equal(t.bridge.calls.length, 0);

    t.bridge.handler = () => ({ layerId: 2, properties: [], warnings: [] });
    const ok = await t.client.callTool({ name: "shift_keyframes", arguments: { compId: 1, layerId: 2, offset: 2, from: 7.5, properties: ["opacity"] } });
    assert.ok(!ok.isError, text(ok));
    assert.equal(t.bridge.calls[0].tool, "shift_keyframes");
    assert.equal(t.bridge.calls[0].undo, "ae-motion: shift keyframes");
    assert.deepEqual(t.bridge.calls[0].args, { compId: 1, layerId: 2, offset: 2, from: 7.5, properties: ["opacity"] });
  } finally {
    await t.close();
  }
});

test("remove_effect sends the references and a matching undo label", async () => {
  const t = await connect();
  try {
    t.bridge.handler = () => ({ layerId: 2, removed: [{ index: 1, name: "Glow", matchName: "ADBE Glo2" }], remaining: [], referencingExpressions: [], warnings: [] });
    const one = await t.client.callTool({ name: "remove_effect", arguments: { compId: 1, layerId: 2, effects: ["Glow"] } });
    assert.ok(!one.isError, text(one));
    assert.equal(t.bridge.calls[0].tool, "remove_effect");
    assert.equal(t.bridge.calls[0].undo, "ae-motion: remove effect");
    await t.client.callTool({ name: "remove_effect", arguments: { compId: 1, layerId: 2, effects: [1, "Glow"] } });
    assert.equal(t.bridge.calls[1].undo, "ae-motion: remove 2 effects");
    const none = await t.client.callTool({ name: "remove_effect", arguments: { compId: 1, layerId: 2, effects: [] } });
    assert.ok(none.isError);
    assert.equal(t.bridge.calls.length, 2);
    const tools = (await t.client.listTools()).tools;
    assert.equal(tools.find((x) => x.name === "remove_effect")!.annotations!.destructiveHint, true);
  } finally {
    await t.close();
  }
});

test("add_shape_content turns friendly items into match names, in order", async () => {
  const t = await connect();
  try {
    t.bridge.handler = () => ({ layerId: 2, items: [], warnings: [] });
    const r = await t.client.callTool({
      name: "add_shape_content",
      arguments: {
        compId: 1,
        layerId: 2,
        group: ["Line"],
        items: [
          { type: "path", name: "Hexagon", vertices: [[0, 0], [10, 0], [10, 10]], outTangents: [[1, 0], [0, 0], [0, 0]], closed: false },
          { type: "stroke", color: "#FFFFFF", width: 6, lineCap: "round", taper: { startLength: 20, endWidth: 0 } },
          { type: "trimPaths", end: 16.6, trimMultipleShapes: "individually" },
          { type: "other", matchName: "ADBE Vector Filter - Repeater", properties: [{ path: "ADBE Vector Repeater Copies", value: 5 }] },
        ],
      },
    });
    assert.ok(!r.isError, text(r));
    const call = t.bridge.calls[0];
    assert.equal(call.tool, "add_shape_content");
    assert.equal(call.undo, "ae-motion: add 4 shape items");
    const args = call.args as { group: string[]; items: { matchName: string; name?: string; settings: { path: string[]; value: unknown }[] }[] };
    assert.deepEqual(args.group, ["Line"]);
    assert.deepEqual(args.items.map((i) => i.matchName), ["ADBE Vector Shape - Group", "ADBE Vector Graphic - Stroke", "ADBE Vector Filter - Trim", "ADBE Vector Filter - Repeater"]);
    assert.equal(args.items[0].name, "Hexagon");
    assert.deepEqual(args.items[0].settings, [{ path: ["ADBE Vector Shape"], value: { vertices: [[0, 0], [10, 0], [10, 10]], outTangents: [[1, 0], [0, 0], [0, 0]], closed: false } }]);
    assert.deepEqual(args.items[1].settings, [
      { path: ["ADBE Vector Stroke Color"], value: "#FFFFFF" },
      { path: ["ADBE Vector Stroke Width"], value: 6 },
      { path: ["ADBE Vector Stroke Line Cap"], value: 2 },
      { path: ["ADBE Vector Stroke Taper", "ADBE Vector Taper Start Length"], value: 20 },
      { path: ["ADBE Vector Stroke Taper", "ADBE Vector Taper End Width"], value: 0 },
    ]);
    assert.deepEqual(args.items[2].settings, [{ path: ["ADBE Vector Trim End"], value: 16.6 }, { path: ["ADBE Vector Trim Type"], value: 2 }]);
    assert.deepEqual(args.items[3].settings, [{ path: ["ADBE Vector Repeater Copies"], value: 5 }]);

    const bad = await t.client.callTool({ name: "add_shape_content", arguments: { compId: 1, layerId: 2, items: [{ type: "path", vertices: [[0, 0], [1, 1]], inTangents: [[0, 0]] }] } });
    assert.ok(bad.isError);
    assert.match(text(bad), /inTangents has 1 entries but there are 2 vertices/);
    assert.equal(t.bridge.calls.length, 1);
  } finally {
    await t.close();
  }
});

test("create_layer builds shape contents or a freeform path", async () => {
  const t = await connect();
  try {
    t.bridge.handler = () => ({ layer: { id: 5, index: 1, name: "STROKE base", type: "shape" }, items: [], warnings: [] });
    const r = await t.client.callTool({
      name: "create_layer",
      arguments: { compId: 1, type: "shape", name: "STROKE base", shape: { contents: [{ type: "group", name: "Line", transform: { rotation: -64 }, items: [{ type: "path", vertices: [[0, 0], [5, 5]] }, { type: "stroke" }, { type: "trimPaths" }] }] } },
    });
    assert.ok(!r.isError, text(r));
    const args = t.bridge.calls[0].args as { shape: Record<string, unknown>; contents: { matchName: string; settings: unknown[]; children: { matchName: string }[] }[] };
    assert.equal(args.shape.contents, undefined);
    assert.equal(args.contents[0].matchName, "ADBE Vector Group");
    assert.deepEqual(args.contents[0].settings, [{ path: ["ADBE Vector Transform Group", "ADBE Vector Rotation"], value: -64 }]);
    assert.deepEqual(args.contents[0].children.map((c) => c.matchName), ["ADBE Vector Shape - Group", "ADBE Vector Graphic - Stroke", "ADBE Vector Filter - Trim"]);

    const noPath = await t.client.callTool({ name: "create_layer", arguments: { compId: 1, type: "shape", shape: { kind: "path" } } });
    assert.ok(noPath.isError);
    assert.match(text(noPath), /needs shape.path/);
    assert.equal(t.bridge.calls.length, 1);
  } finally {
    await t.close();
  }
});

test("set_layer_style sends the style's match name and menu command", async () => {
  const t = await connect();
  try {
    t.bridge.handler = () => ({ layerId: 2, style: { name: "Outer Glow", matchName: "outerGlow/enabled", applied: true, enabled: true }, path: ["ADBE Layer Styles", "outerGlow/enabled"], settings: [] });
    const r = await t.client.callTool({ name: "set_layer_style", arguments: { compId: 1, layerId: 2, style: "outerGlow", settings: [{ name: "Size", value: 171 }, { name: "Opacity", value: 60 }] } });
    assert.ok(!r.isError, text(r));
    const call = t.bridge.calls[0];
    assert.equal(call.undo, "ae-motion: set Outer Glow");
    assert.deepEqual(call.args, { compId: 1, layerId: 2, matchName: "outerGlow/enabled", command: 9002, styleName: "Outer Glow", enabled: undefined, settings: [{ name: "Size", value: 171 }, { name: "Opacity", value: 60 }] });
    await t.client.callTool({ name: "set_layer_style", arguments: { compId: 1, layerId: 2, style: "satin", enabled: false } });
    assert.equal(t.bridge.calls[1].undo, "ae-motion: hide Satin");
    assert.equal((t.bridge.calls[1].args as { matchName: string }).matchName, "chromeFX/enabled");
    const unknown = await t.client.callTool({ name: "set_layer_style", arguments: { compId: 1, layerId: 2, style: "patternOverlay" } });
    assert.ok(unknown.isError);
  } finally {
    await t.close();
  }
});

test("add_text_animator maps properties and selectors, and adds a range selector by default", async () => {
  const t = await connect();
  try {
    t.bridge.handler = () => ({ layerId: 2, animator: { name: "Rise", matchName: "ADBE Text Animator", path: [] }, properties: [], selectors: [], warnings: [] });
    const r = await t.client.callTool({
      name: "add_text_animator",
      arguments: {
        compId: 1,
        layerId: 2,
        name: "Rise",
        properties: { position: [0, 80], opacity: 0, trackingType: "after" },
        selectors: [
          { type: "range", basedOn: "lines", units: "index", start: 0, end: 1, offset: 0, shape: "rampUp", randomizeOrder: true },
          { type: "wiggly", basedOn: "words", maxAmount: 50, lockDimensions: true },
          { type: "expression", amount: "// fade\n100" },
        ],
        moreOptions: { anchorPointGrouping: "line" },
      },
    });
    assert.ok(!r.isError, text(r));
    const call = t.bridge.calls[0];
    assert.equal(call.undo, 'ae-motion: add text animator "Rise"');
    const a = call.args as { animator: unknown; properties: unknown[]; selectors: { matchName: string; settings: { path: string[]; value: unknown }[]; expression?: unknown }[]; moreOptions: unknown[] };
    assert.equal(a.animator, null);
    assert.deepEqual(a.properties, [
      { matchName: "ADBE Text Position 3D", value: [0, 80] },
      { matchName: "ADBE Text Opacity", value: 0 },
      { matchName: "ADBE Text Track Type", value: 3 },
    ]);
    assert.deepEqual(a.selectors.map((s) => s.matchName), ["ADBE Text Selector", "ADBE Text Wiggly Selector", "ADBE Text Expressible Selector"]);
    // Units first, so the index start/end exist when they are set.
    assert.deepEqual(a.selectors[0].settings, [
      { path: ["ADBE Text Range Advanced", "ADBE Text Range Units"], value: 2 },
      { path: ["ADBE Text Range Advanced", "ADBE Text Range Type2"], value: 4 },
      { path: ["ADBE Text Range Advanced", "ADBE Text Range Shape"], value: 2 },
      { path: ["ADBE Text Range Advanced", "ADBE Text Randomize Order"], value: 1 },
      { path: ["ADBE Text Index Start"], value: 0 },
      { path: ["ADBE Text Index End"], value: 1 },
      { path: ["ADBE Text Index Offset"], value: 0 },
    ]);
    assert.deepEqual(a.selectors[1].settings, [
      { path: ["ADBE Text Range Type2"], value: 3 },
      { path: ["ADBE Text Wiggly Max Amount"], value: 50 },
      { path: ["ADBE Text Wiggly Lock Dim"], value: 1 },
    ]);
    assert.deepEqual(a.selectors[2].expression, { path: ["ADBE Text Expressible Amount"], text: "// fade\n100" });
    assert.deepEqual(a.moreOptions, [{ path: ["ADBE Text Anchor Point Option"], value: 3 }]);

    await t.client.callTool({ name: "add_text_animator", arguments: { compId: 1, layerId: 2, properties: { blur: [4, 4] } } });
    const d = t.bridge.calls[1].args as { selectors: { matchName: string; settings: unknown[] }[] };
    assert.deepEqual(d.selectors, [{ matchName: "ADBE Text Selector", settings: [] }]);

    const nothing = await t.client.callTool({ name: "add_text_animator", arguments: { compId: 1, layerId: 2, animator: "Rise" } });
    assert.ok(nothing.isError);
    assert.match(text(nothing), /Nothing to add/);
    assert.equal(t.bridge.calls.length, 2);
  } finally {
    await t.close();
  }
});

test("gradient items map to match names and warn that their stops need a person", async () => {
  const t = await connect();
  try {
    t.bridge.handler = () => ({ layerId: 2, items: [], warnings: [] });
    const r = await t.client.callTool({
      name: "add_shape_content",
      arguments: { compId: 1, layerId: 2, items: [{ type: "gradientFill", gradientType: "radial", startPoint: [0, 0], endPoint: [100, 0] }, { type: "gradientStroke", width: 4 }] },
    });
    assert.ok(!r.isError, text(r));
    const a = t.bridge.calls[0].args as { items: { matchName: string; settings: unknown[] }[] };
    assert.deepEqual(a.items.map((i) => i.matchName), ["ADBE Vector Graphic - G-Fill", "ADBE Vector Graphic - G-Stroke"]);
    assert.deepEqual(a.items[0].settings, [
      { path: ["ADBE Vector Grad Type"], value: 2 },
      { path: ["ADBE Vector Grad Start Pt"], value: [0, 0] },
      { path: ["ADBE Vector Grad End Pt"], value: [100, 0] },
    ]);
    const s = r.structuredContent as { warnings: string[] };
    assert.equal(s.warnings.length, 1);
    assert.match(s.warnings[0], /The 2 gradients use .*Edit Gradient/);
  } finally {
    await t.close();
  }
});

test("animate and edit_keyframes send keyframe details only when given", async () => {
  const t = await connect();
  try {
    t.bridge.handler = () => ({ layerId: 2, tracks: [], property: "Position", path: [], numKeys: 2, keyframes: [], warnings: [] });
    await t.client.callTool({
      name: "animate",
      arguments: { compId: 1, layerId: 2, tracks: [{ property: "position", keyframes: [{ time: 0, value: [0, 0], outTangent: [100, 0], label: 3 }, { time: 1, value: [200, 0] }] }] },
    });
    const kfs = (t.bridge.calls[0].args as { tracks: { keyframes: { details?: unknown }[] }[] }).tracks[0].keyframes;
    assert.deepEqual(kfs[0].details, { outTangent: [100, 0], label: 3 });
    assert.equal(kfs[1].details, undefined);

    const r = await t.client.callTool({
      name: "edit_keyframes",
      arguments: { compId: 1, layerId: 2, property: "scale", keys: [{ index: 2, inEase: [{ speed: 0, influence: 80 }, { speed: 0, influence: 80 }, { speed: 0, influence: 80 }], outInterpolation: "hold" }] },
    });
    assert.ok(!r.isError, text(r));
    assert.equal(t.bridge.calls[1].undo, "ae-motion: edit 1 keyframe");
    const k = (t.bridge.calls[1].args as { keys: { index: number; details: Record<string, unknown> }[] }).keys[0];
    assert.equal(k.index, 2);
    assert.deepEqual(Object.keys(k.details), ["outInterpolation", "inEase"]);

    const both = await t.client.callTool({ name: "edit_keyframes", arguments: { compId: 1, layerId: 2, property: "opacity", keys: [{ time: 1, index: 1, label: 2 }] } });
    assert.match(text(both), /give time or index/);
    const empty = await t.client.callTool({ name: "edit_keyframes", arguments: { compId: 1, layerId: 2, property: "opacity", keys: [{ time: 1 }] } });
    assert.match(text(empty), /nothing to change/);
    const badInfluence = await t.client.callTool({ name: "edit_keyframes", arguments: { compId: 1, layerId: 2, property: "opacity", keys: [{ time: 1, inEase: { speed: 0, influence: 0 } }] } });
    assert.ok(badInfluence.isError);
    assert.equal(t.bridge.calls.length, 2);
  } finally {
    await t.close();
  }
});

test("essential_graphics lists controls read-only and labels changes", async () => {
  const t = await connect();
  try {
    t.bridge.handler = () => ({ compId: 1, templateName: "Title", controls: [], added: [], warnings: [] });
    await t.client.callTool({ name: "essential_graphics", arguments: { compId: 1 } });
    assert.equal(t.bridge.calls[0].undo, undefined);
    await t.client.callTool({ name: "essential_graphics", arguments: { compId: 1, templateName: "Title", add: [{ layerId: 3, property: "sourceText", name: "Headline" }] } });
    assert.equal(t.bridge.calls[1].undo, "ae-motion: add 1 Essential Graphics control");
    const dup = await t.client.callTool({ name: "essential_graphics", arguments: { compId: 1, rename: [{ index: 1, name: "A" }, { index: 1, name: "B" }] } });
    assert.match(text(dup), /same control twice/);
  } finally {
    await t.close();
  }
});
