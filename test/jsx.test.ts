// Static checks on the ExtendScript that runs inside AE. A syntax error there is caught by the wrapper,
// but an ES3 incompatibility (like a reserved word as an object key) only shows up in AE, so lint for it.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { bodyFile, LIB, toolScript, WRAPPER } from "../src/jsx/index.ts";

const TOOLS = readdirSync(new URL("../src/jsx/tools/", import.meta.url)).map((f) => f.replace(/\.jsx$/, ""));
const SOURCES: [string, string][] = [["wrapper.jsx", WRAPPER], ["lib.jsx", LIB], ...TOOLS.map((t) => [`tools/${t}.jsx`, toolScript(t)] as [string, string])];

test("every ExtendScript file parses", () => {
  assert.doesNotThrow(() => new vm.Script(WRAPPER, { filename: "wrapper.jsx" }));
  for (const t of TOOLS) assert.doesNotThrow(() => new vm.Script(bodyFile(toolScript(t)), { filename: `${t}.jsx` }), t);
});

test("no ES3-incompatible syntax", () => {
  const reserved = "in|class|const|enum|export|extends|import|super|default|delete|new|this|void|with|typeof|instanceof|var|function|return|case|switch|catch|finally|throw|try|do|while|for|if|else|break|continue|abstract|boolean|byte|char|double|final|float|goto|implements|int|interface|long|native|package|private|protected|public|short|static|synchronized|throws|transient|volatile|debugger";
  for (const [name, src] of SOURCES) {
    const code = src.replace(/\/\/.*$/gm, "").replace(/"(?:[^"\\]|\\.)*"/g, '""');
    assert.doesNotMatch(code, new RegExp(`[{,]\\s*(${reserved})\\s*:`), `${name}: reserved word as object key`);
    assert.doesNotMatch(code, new RegExp(`\\.(${reserved})\\b`), `${name}: reserved word as property name`);
    assert.doesNotMatch(code, /\b(let|const)\s|=>|`/, `${name}: ES6 syntax`);
    // ES5 array/object methods (String#indexOf and #slice are ES3 and fine).
    assert.doesNotMatch(code, /\.(forEach|map|filter|reduce|some|every|trim)\(|\bObject\.keys\b/, `${name}: ES5 method`);
  }
});

// AEM.easeNumbers is pure math: run lib.jsx in a sandbox with stub enums.
function loadLib() {
  const enums = new Proxy({}, { get: (_t, k) => (typeof k === "string" ? k : undefined) });
  class Shape {
    vertices: number[][] = [];
    inTangents: number[][] = [];
    outTangents: number[][] = [];
    closed = true;
  }
  const sandbox: Record<string, unknown> = { BlendingMode: enums, TrackMatteType: enums, KeyframeInterpolationType: enums, ParagraphJustification: enums, LightType: enums, PropertyType: enums, LayerQuality: enums, FrameBlendingType: enums, AutoOrientType: enums, Shape };
  // fromJSON builds data inside the sandbox, so `instanceof Array` there holds as it does in AE.
  vm.runInNewContext(LIB + "\nAEM.fromJSON = function (s) { return JSON.parse(s); };\nthis.AEM = AEM;", sandbox);
  return sandbox.AEM as {
    easeNumbers(b: number[], avg: number): { outSpeed: number; outInfluence: number; inSpeed: number; inInfluence: number };
    color(v: unknown): number[];
    clearKeysKeepOne(p: FakeProp): number | null;
    dropSurvivor(p: FakeProp, survivor: number | null, times: number[]): void;
    toShape(v: unknown, closedDefault?: boolean): { vertices: number[][]; inTangents: number[][]; outTangents: number[][]; closed: boolean };
    shapeData(s: unknown): Record<string, unknown>;
    pathOf(p: unknown): (string | number)[];
    MAX_PATH_VERTICES: number;
    fromJSON(s: string): unknown;
  };
}

test("cubic-bezier to AE temporal ease", () => {
  const AEM = loadLib();
  // easeInOut (0.42, 0, 0.58, 1): leaves and arrives at rest, 42% influence both sides.
  const io = AEM.easeNumbers([0.42, 0, 0.58, 1], 100);
  assert.equal(io.outSpeed, 0);
  assert.equal(io.inSpeed, 0);
  assert.ok(Math.abs(io.outInfluence - 42) < 1e-9 && Math.abs(io.inInfluence - 42) < 1e-9);
  // ease-out (0, 0, 0.58, 1): no outgoing handle (min influence), eases into the end.
  const out = AEM.easeNumbers([0, 0, 0.58, 1], 100);
  assert.equal(out.outInfluence, 0.1);
  assert.equal(out.inSpeed, 0);
  // easeOutBack overshoot: outgoing speed above the average speed.
  const back = AEM.easeNumbers([0.34, 1.56, 0.64, 1], 100);
  assert.ok(Math.abs(back.outSpeed - (1.56 / 0.34) * 100) < 1e-9);
  // linear-equivalent bezier gives the average speed on both sides.
  const lin = AEM.easeNumbers([1 / 3, 1 / 3, 2 / 3, 2 / 3], 50);
  assert.ok(Math.abs(lin.outSpeed - 50) < 1e-9 && Math.abs(lin.inSpeed - 50) < 1e-9);
});

test("hex colors", () => {
  const AEM = loadLib();
  assert.deepEqual([...AEM.color("#FF0080")], [1, 0, 0.502]);
  assert.deepEqual([...AEM.color([0.1, 0.2, 0.3])], [0.1, 0.2, 0.3]);
  assert.throws(() => AEM.color("red"));
});

// A keyframed property that, like Time Remap, switches off if its last key is removed.
class FakeProp {
  keys: { t: number; v: number; interp?: string }[];
  emptied = false;
  isSpatial = false;
  constructor(times: number[]) {
    this.keys = times.map((t) => ({ t, v: t, interp: "BEZIER" }));
  }
  get numKeys() {
    return this.keys.length;
  }
  keyTime(k: number) {
    return this.keys[k - 1].t;
  }
  removeKey(k: number) {
    this.keys.splice(k - 1, 1);
    if (!this.keys.length) this.emptied = true;
  }
  nearestKeyIndex(t: number) {
    let best = 1;
    this.keys.forEach((k, i) => {
      if (Math.abs(k.t - t) < Math.abs(this.keys[best - 1].t - t)) best = i + 1;
    });
    return best;
  }
  setValueAtTime(t: number, v: number) {
    const same = this.keys.find((k) => Math.abs(k.t - t) < 1e-4);
    if (same) same.v = v;
    else this.keys.push({ t, v }), this.keys.sort((a, b) => a.t - b.t);
  }
  setInterpolationTypeAtKey(k: number, a: string) {
    this.keys[k - 1].interp = a;
  }
}

test("replacing keyframes never empties the property (Time Remap stays on)", () => {
  const AEM = loadLib();
  for (const [old, next] of [
    [[0, 5, 10], [2, 8]],
    [[0, 5, 10], [0, 4]],
    [[3], [3]],
    [[], [1, 2]],
  ] as [number[], number[]][]) {
    const p = new FakeProp(old);
    const survivor = AEM.clearKeysKeepOne(p);
    for (const t of next) p.setValueAtTime(t, t * 10);
    AEM.dropSurvivor(p, survivor, next);
    assert.deepEqual(p.keys.map((k) => k.t), next, `${old} -> ${next}`);
    assert.deepEqual(p.keys.map((k) => k.v), next.map((t) => t * 10));
    assert.equal(p.emptied, false, `${old} -> ${next} emptied the property`);
  }
  // A key written over the survivor gets a fresh key's interpolation, not the old one.
  const p = new FakeProp([0, 5]);
  const s0 = AEM.clearKeysKeepOne(p);
  p.setValueAtTime(0, 1);
  AEM.dropSurvivor(p, s0, [0]);
  assert.equal(p.keys[0].interp, "LINEAR");
});

test("path values: JSON <-> Shape", () => {
  const AEM = loadLib();
  const s = AEM.toShape({ vertices: [[0, 0], [10, 0], [10, 10]], outTangents: [[1, 0], [0, 0], [0, 0]] }, false);
  const plain = (x: unknown) => JSON.parse(JSON.stringify(x)); // sandbox arrays aren't this realm's arrays
  assert.deepEqual(plain(s.inTangents), [[0, 0], [0, 0], [0, 0]]);
  assert.deepEqual(plain(s.outTangents[0]), [1, 0]);
  assert.equal(s.closed, false, "closed falls back to the current value");
  assert.equal(AEM.toShape({ vertices: [[0, 0]], closed: true }, false).closed, true);
  assert.throws(() => AEM.toShape({ vertices: [[0, 0], [1, 1]], inTangents: [[0, 0]] }), /inTangents has 1 entries/);
  assert.throws(() => AEM.toShape({ vertices: [] }), /A path value is/);
  const back = AEM.shapeData(AEM.fromJSON('{"vertices": [[0.123456, 1]], "inTangents": [[0, 0]], "outTangents": [[0, 0]], "closed": true}'));
  assert.deepEqual(JSON.parse(JSON.stringify(back)), { vertices: [[0.1235, 1]], inTangents: [[0, 0]], outTangents: [[0, 0]], closed: true });
  const big = Array.from({ length: AEM.MAX_PATH_VERTICES + 1 }, () => [0, 0]);
  assert.deepEqual(JSON.parse(JSON.stringify(AEM.shapeData({ vertices: big, inTangents: big, outTangents: big, closed: false }))), { closed: false, numVertices: big.length, truncated: true });
});

test("property paths name children of indexed groups, by index when names repeat", () => {
  const AEM = loadLib();
  type Node = { name: string; matchName: string; propertyType: string; propertyIndex: number; parentProperty: Node | null; kids: Node[]; numProperties: number; property(i: number): Node };
  const node = (name: string, matchName: string, propertyType: string, kids: Node[] = []): Node => {
    const n: Node = { name, matchName, propertyType, propertyIndex: 0, parentProperty: null, kids, numProperties: kids.length, property: (i) => kids[i - 1] };
    kids.forEach((k, i) => Object.assign(k, { parentProperty: n, propertyIndex: i + 1 }));
    return n;
  };
  const trim = node("Trim Paths 1", "ADBE Vector Filter - Trim", "NAMED_GROUP", [node("End", "ADBE Vector Trim End", "PROPERTY")]);
  const lineA = node("Line", "ADBE Vector Group", "NAMED_GROUP", [node("Contents", "ADBE Vectors Group", "INDEXED_GROUP", [trim])]);
  const lineB = node("Line", "ADBE Vector Group", "NAMED_GROUP");
  const solo = node("Glow", "ADBE Vector Group", "NAMED_GROUP");
  const root = node("Contents", "ADBE Root Vectors Group", "INDEXED_GROUP", [lineA, lineB, solo]);
  const layer = node("STROKE base", "ADBE Vector Layer", "NAMED_GROUP", [root]);
  layer.parentProperty = null;
  assert.deepEqual([...AEM.pathOf(trim.kids[0])], ["ADBE Root Vectors Group", 1, "ADBE Vectors Group", "Trim Paths 1", "ADBE Vector Trim End"]);
  assert.deepEqual([...AEM.pathOf(solo)], ["ADBE Root Vectors Group", "Glow"]);
});
