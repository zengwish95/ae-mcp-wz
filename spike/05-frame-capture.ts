// Spike Q5: frame capture, and whether it needs "Allow Scripts to Write Files and Access Network".
// Usage: node spike/05-frame-capture.ts <label>     e.g. pref-on, pref-off
// Results come back through the settings channel (works with the pref off); the file channel is tested separately.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { AE_PREFS_FILE, call, log } from "./lib/ae.ts";

const label = process.argv[2] ?? "run";
const OUT = join(process.cwd(), "spike", "out", "capture");
mkdirSync(OUT, { recursive: true });

const v = async (body: string, extra: { undo?: string; timeoutSec?: number } = {}) => {
  const r = await call(body, { channel: "settings", timeoutSec: 120, suppressDialogs: true, ...extra });
  return { ms: r.raw.ms, status: r.raw.stdout, ...(r.parsed ?? { noResult: true, stderr: r.raw.stderr }) };
};

function pngSize(path: string) {
  const b = readFileSync(path);
  return { bytes: b.length, width: b.readUInt32BE(16), height: b.readUInt32BE(20), isPng: b.toString("latin1", 1, 4) === "PNG" };
}

async function waitForFile(path: string, timeoutMs = 15000): Promise<number | null> {
  const t = performance.now();
  while (performance.now() - t < timeoutMs) {
    if (existsSync(path) && statSync(path).size > 0) return Math.round(performance.now() - t);
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

// 0. Pref state, as AE and as the prefs file report it
const prefFile = /"Pref_SCRIPTING_FILE_NETWORK_SECURITY" = "(\d)"/.exec(readFileSync(AE_PREFS_FILE, "latin1"))?.[1];
log("pref (prefs file on disk)", prefFile);
log("pref (getPrefAsLong in AE)", await v(`return app.preferences.getPrefAsLong("Main Pref Section v2", "Pref_SCRIPTING_FILE_NETWORK_SECURITY", PREFType.PREF_Type_MACHINE_SPECIFIC);`));

// 1. Does the file result channel work in this state?
const fileChan = await call("return 'file channel ok';", { channel: "file", timeoutSec: 30 });
log("file result channel", { status: fileChan.raw.stdout, parsed: fileChan.parsed ?? "NO RESULT FILE" });

// 2. Plain File write from a script (try/catch, so no dialog); Node checks the result
const plain = join(OUT, `plain-write-${label}.txt`);
rmSync(plain, { force: true });
log("plain File.write", { inScript: await v(`var f = new File(${JSON.stringify(plain)}); var o = f.open("w"); var w = o ? f.write("x") : false; f.close(); return { opened: o, wrote: w, error: f.error };`), existsOnDisk: existsSync(plain) });

// 3. Test comp
const setup = await v(
  `var c = app.project.items.addComp("spike-capture", 1280, 720, 1, 3, 30); c.bgColor = [0.07, 0.07, 0.1];
   var s = c.layers.addSolid([0.39, 0.17, 0.64], "spike-box", 300, 300, 1);
   var p = s.property("ADBE Transform Group").property("ADBE Position"); p.setValueAtTime(0, [200, 360]); p.setValueAtTime(2, [1080, 360]);
   var t = c.layers.addText("ae-motion spike"); return { id: c.id };`,
  { undo: "ae-motion: spike capture setup" },
);
log("setup", setup);
const COMP = `(function () { for (var i = 1; i <= app.project.numItems; i++) { var it = app.project.item(i); if (it instanceof CompItem && it.name === "spike-capture") return it; } throw new Error("no spike comp"); })()`;

// 4A. CompItem.saveFrameToPng(time, file)
const a = join(OUT, `A-saveFrameToPng-${label}.png`);
rmSync(a, { force: true });
// It returns a promise-like object (wait/onComplete/onError/_isReady); check readiness before and after wait().
const aRes = await v(`var c = ${COMP}; var t0 = new Date().getTime(); var r = c.saveFrameToPng(1.0, new File(${JSON.stringify(a)})); var readyAtReturn = r._isReady; var t1 = new Date().getTime(); r.wait(); return { readyAtReturn: readyAtReturn, callMs: t1 - t0, waitMs: new Date().getTime() - t1, hasException: r._hasException };`);
const aWait = await waitForFile(a);
log("A saveFrameToPng(1.0)", { ...aRes, fileAppearedMsAfterReturn: aWait, png: aWait !== null ? pngSize(a) : null });

// 4A2. Same with resolutionFactor [2,2]: does capture follow comp resolution? (cheaper previews)
const a2 = join(OUT, `A2-saveFrameToPng-half-${label}.png`);
rmSync(a2, { force: true });
const a2Res = await v(`var c = ${COMP}; var old = c.resolutionFactor; c.resolutionFactor = [2, 2]; try { c.saveFrameToPng(1.0, new File(${JSON.stringify(a2)})).wait(); } finally { c.resolutionFactor = old; } return "ok";`);
const a2Wait = await waitForFile(a2);
log("A2 saveFrameToPng at resolutionFactor [2,2]", { ...a2Res, fileAppearedMsAfterReturn: a2Wait, png: a2Wait !== null ? pngSize(a2) : null });

// 4B. Render queue, one frame. Output-module "Format" is read-only via setSettings and there is no PNG
// template, so use the built-in "TIFF Sequence with Alpha" template and convert with macOS `sips`.
const prefix = `B-rq-${label}_`;
for (const f of readdirSync(OUT)) if (f.startsWith(prefix)) rmSync(join(OUT, f));
const bRes = await v(`
  var c = ${COMP}; var rq = app.project.renderQueue;
  var it = rq.items.add(c); var om = it.outputModule(1);
  it.timeSpanStart = 1.0; it.timeSpanDuration = c.frameDuration;
  om.applyTemplate("TIFF Sequence with Alpha");
  om.file = new File(${JSON.stringify(join(OUT, prefix + "[#####].tif"))});
  var t0 = new Date().getTime(); rq.render(); var dt = new Date().getTime() - t0;
  var st = String(it.status); var fmt = om.getSetting("Format");
  it.remove();
  return { renderMs: dt, status: st, format: fmt };`);
const bFile = readdirSync(OUT).find((f) => f.startsWith(prefix));
let bPng = null;
if (bFile) {
  const png = join(OUT, bFile.replace(/\.tif$/, ".png"));
  const t = performance.now();
  execFileSync("/usr/bin/sips", ["-s", "format", "png", join(OUT, bFile), "--out", png], { stdio: "ignore" });
  bPng = { sipsMs: Math.round(performance.now() - t), ...pngSize(png) };
}
log("B render queue single frame (TIFF template + sips)", { ...bRes, file: bFile ?? null, png: bPng });

// 5. Other APIs the server needs: do they depend on the pref? (save() re-points the open project at the file)
const aep = join(OUT, `save-${label}.aep`);
rmSync(aep, { force: true });
const ev = await call("return 'evalFile body ran';", { channel: "settings", useEvalFile: true, timeoutSec: 30 });
log("$.evalFile-loaded body", ev.parsed);
log(
  "read / import / save / callSystem",
  await v(`
    var res = {};
    try { var f = new File(${JSON.stringify(a)}); f.encoding = "BINARY"; res.readOpen = f.open("r"); res.readLen = f.read(8).length; f.close(); } catch (e) { res.readErr = e.message; }
    try { var item = app.project.importFile(new ImportOptions(new File(${JSON.stringify(a)}))); res.imported = item.name; item.remove(); } catch (e) { res.importErr = e.message; }
    try { res.saved = app.project.save(new File(${JSON.stringify(aep)})); } catch (e) { res.saveErr = e.message; }
    try { res.callSystem = system.callSystem("echo hi"); } catch (e) { res.callSystemErr = e.message; }
    return res;`),
);
log(".aep on disk", existsSync(aep));

// Cleanup (one undo step)
log(
  "cleanup",
  await v(
    `var n = 0; for (var i = app.project.numItems; i >= 1; i--) { var it = app.project.item(i); if (it.name.indexOf("spike-") === 0 || (it instanceof FolderItem && it.name === "Solids" && it.numItems === 0)) { it.remove(); n++; } } return n;`,
    { undo: "ae-motion: spike cleanup" },
  ),
);
