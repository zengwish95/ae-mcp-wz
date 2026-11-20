// Spike Q6: H.264 MP4 from the render queue: template, blocking behaviour, progress.
// Usage: node spike/06-render.ts [render|async|aerender ...]   (default: all three)
// Uses the settings result channel, so it works with "Allow Scripts to Write Files" off.
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { call, log } from "./lib/ae.ts";

const OUT = join(process.cwd(), "spike", "out", "render");
mkdirSync(OUT, { recursive: true });
const TEMPLATE = "H.264 - Match Render Settings - 15 Mbps";
const which = process.argv.slice(2);
const want = (k: string) => which.length === 0 || which.includes(k);

const v = async (body: string, extra: { undo?: string; timeoutSec?: number; override?: boolean } = {}) => {
  const r = await call(body, { channel: "settings", timeoutSec: 600, suppressDialogs: true, ...extra });
  return { ms: r.raw.ms, status: r.raw.stdout, stderr: r.raw.stderr || undefined, ...(r.parsed ?? { noResult: true }) };
};

function probe(path: string) {
  if (!existsSync(path)) return { exists: false };
  const j = JSON.parse(
    execFileSync("/opt/homebrew/bin/ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height,r_frame_rate,nb_frames,pix_fmt:format=duration,format_name", "-of", "json", path], { encoding: "utf8" }),
  );
  return { exists: true, bytes: statSync(path).size, ...j.streams?.[0], ...j.format };
}

const COMP_NAME = "spike-render";
const COMP = `(function () { for (var i = 1; i <= app.project.numItems; i++) { var it = app.project.item(i); if (it instanceof CompItem && it.name === "${COMP_NAME}") return it; } throw new Error("no spike comp"); })()`;

// Setup: 1920x1080, 30 fps, 6 s, a background solid, a moving box with blur, text.
log(
  "setup",
  await v(
    `var c = app.project.items.addComp("${COMP_NAME}", 1920, 1080, 1, 6, 30);
     c.layers.addSolid([0.07, 0.07, 0.1], "spike-bg", 1920, 1080, 1);
     var s = c.layers.addSolid([0.39, 0.17, 0.64], "spike-box", 400, 400, 1);
     var p = s.property("ADBE Transform Group").property("ADBE Position"); p.setValueAtTime(0, [300, 540]); p.setValueAtTime(5, [1620, 540]);
     var b = s.property("ADBE Effect Parade").addProperty("ADBE Gaussian Blur 2"); b.property(1).setValueAtTime(0, 0); b.property(1).setValueAtTime(5, 80);
     c.layers.addText("ae-motion render spike");
     var rq = app.project.renderQueue; var other = 0; for (var i = 1; i <= rq.numItems; i++) if (rq.item(i).render) other++;
     return { id: c.id, frames: c.duration * c.frameRate, otherQueuedItems: other };`,
    { undo: "ae-motion: spike render setup" },
  ),
);

const ADD_ITEM = (file: string) => `
  var c = ${COMP}; var rq = app.project.renderQueue; var it = rq.items.add(c);
  it.applyTemplate("Best Settings");
  var om = it.outputModule(1); om.applyTemplate(${JSON.stringify(TEMPLATE)}); om.file = new File(${JSON.stringify(file)});`;

// 1. Blocking rq.render(), with read-only `override` probes from Node while it runs.
if (want("render")) {
  const file = join(OUT, "render-blocking.mp4");
  rmSync(file, { force: true });
  const rendering = v(`${ADD_ITEM(file)}
    var t0 = new Date().getTime(); rq.render(); var dt = new Date().getTime() - t0;
    // Read everything BEFORE it.remove(): touching the removed item's output module crashed AE 26.5 (SPIKE.md Q6).
    var st = it.status; var el = it.elapsedSeconds; var fmt = om.getSetting("Format"); it.remove();
    return { renderMs: dt, status: st, elapsedSeconds: el, format: fmt };`);
  let done = false;
  void rendering.then(() => (done = true));
  const probes: unknown[] = [];
  await new Promise((r) => setTimeout(r, 1000));
  while (!done && probes.length < 120) {
    const t = Date.now();
    const p = await v(`var rq = app.project.renderQueue; var it = rq.item(rq.numItems); return { rendering: rq.rendering, status: it.status, elapsed: it.elapsedSeconds };`, { override: true, timeoutSec: 5 });
    probes.push({ t: t, ms: p.ms, ...(p as any).value, err: (p as any).error?.message, status: p.status, stderr: p.stderr });
    let size = 0;
    try { size = statSync(file).size; } catch { /* not yet */ }
    (probes[probes.length - 1] as any).fileBytes = size;
    await new Promise((r) => setTimeout(r, 1000));
  }
  log("1 blocking render(): result", await rendering);
  log("1 override probes during render()", probes);
  log("1 output", probe(file));
}

// 2. rq.renderAsync(): does the call return before rendering ends? Can normal calls run meanwhile?
if (want("async")) {
  const file = join(OUT, "render-async.mp4");
  rmSync(file, { force: true });
  const start = await v(`${ADD_ITEM(file)}
    var t0 = new Date().getTime(); var r = rq.renderAsync(); var dt = new Date().getTime() - t0;
    var keys = []; if (r) for (var k in r) keys.push(k + ":" + typeof r[k]);
    return { returnedAfterMs: dt, returnType: typeof r, returnKeys: keys.join(","), renderingNow: rq.rendering, status: it.status };`);
  log("2 renderAsync() call", start);
  const polls: unknown[] = [];
  for (let i = 0; i < 120; i++) {
    const p = await v(`var rq = app.project.renderQueue; var it = rq.item(rq.numItems); return { rendering: rq.rendering, status: it.status, elapsed: it.elapsedSeconds };`, { timeoutSec: 5 });
    let size = 0;
    try { size = statSync(file).size; } catch { /* not yet */ }
    polls.push({ ms: p.ms, status: p.status, ...(p as any).value, err: (p as any).error?.message, stderr: p.stderr, fileBytes: size });
    const val = (p as any).value;
    if (val && !val.rendering && val.status !== 3016 && val.status !== 3015) break;
    if (p.status === "1" || p.stderr) break; // refused (another script running?) — stop probing
    await new Promise((r) => setTimeout(r, 1000));
  }
  log("2 normal (non-override) polls during renderAsync", polls);
  log("2 remove item", await v(`var rq = app.project.renderQueue; var it = rq.item(rq.numItems); var st = it.status; if (!rq.rendering) it.remove(); return st;`));
  log("2 output", probe(file));
}

// 3. aerender CLI on a saved copy of the project (separate headless AE process, progress on stdout).
if (want("aerender")) {
  const aep = join(OUT, "render-aerender.aep");
  const file = join(OUT, "render-aerender.mp4");
  rmSync(file, { force: true });
  // saveWithoutChanging? No such API: save() re-points the open project at this file. Acceptable for the throwaway project.
  log("3 save project copy", await v(`return app.project.save(new File(${JSON.stringify(aep)}));`));
  const t0 = performance.now();
  const lines: string[] = [];
  await new Promise<void>((resolve) => {
    const child = execFile("/Applications/Adobe After Effects 2026/aerender", ["-project", aep, "-comp", COMP_NAME, "-RStemplate", "Best Settings", "-OMtemplate", TEMPLATE, "-output", file], { maxBuffer: 64 * 1024 * 1024 });
    child.stdout?.on("data", (d: string) => lines.push(...String(d).split("\n").filter(Boolean).map((l) => `${Math.round(performance.now() - t0)}ms ${l}`)));
    child.stderr?.on("data", (d: string) => lines.push(`ERR ${d}`));
    child.on("close", (code) => {
      lines.push(`exit ${code}`);
      resolve();
    });
  });
  log("3 aerender total ms", Math.round(performance.now() - t0));
  log("3 aerender output (PROGRESS lines and first/last lines)", lines.filter((l, i) => i < 8 || /PROGRESS|ERROR|exit/i.test(l)).slice(0, 80));
  log("3 output", probe(file));
}

// Cleanup: spike items; leave the render queue empty
log(
  "cleanup",
  await v(
    `var rq = app.project.renderQueue; for (var j = rq.numItems; j >= 1; j--) { if (rq.item(j).comp.name.indexOf("spike-") === 0 && !rq.rendering) rq.item(j).remove(); }
     var n = 0; for (var i = app.project.numItems; i >= 1; i--) { var it = app.project.item(i); if (it.name.indexOf("spike-") === 0) { it.remove(); n++; } }
     for (var k = app.project.numItems; k >= 1; k--) { var f = app.project.item(k); if (f instanceof FolderItem && f.name === "Solids" && f.numItems === 0) { f.remove(); n++; } }
     return { removed: n, rqItems: rq.numItems };`,
    { undo: "ae-motion: spike cleanup" },
  ),
);
