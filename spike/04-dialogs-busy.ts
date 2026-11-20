// Spike Q4: dialog suppression and the not-running / busy / modal-open cases.
// Usage: node spike/04-dialogs-busy.ts <not-running|suppress|busy|override|modal|user-dialog>
//   suppress, busy and modal open dialogs in AE that must be clicked away (see SPIKE.md Q4).
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { call, doScriptText, isRunning, log, runJsx, summarize } from "./lib/ae.ts";

// "Did a timed-out/refused call run later?" is answered with a marker file the probe writes
// (needs the "Allow Scripts to Write Files" pref, like the result channel itself).
const markerPath = (name: string) => join(process.cwd(), "spike", "out", `marker-${name}-${Date.now()}.txt`);
const writeMarker = (p: string) => `var __m = new File(${JSON.stringify(p)}); __m.open("w"); __m.write(String(new Date().getTime())); __m.close();`;

const which = process.argv[2];

async function notRunning() {
  log("is running (before)", await isRunning());
  // First event to a non-running app: does AppleScript launch it, and does DoScriptFile wait for it to be ready?
  const r = await call("return { version: app.version, build: app.buildNumber, isWatchFolder: app.isWatchFolder };", { timeoutSec: 300 });
  log("first DoScriptFile while not running (launches AE)", { ...summarize(r.raw), parsed: r.parsed });
  log("is running (after)", await isRunning());
}

async function suppress() {
  // Cases that may open a dialog say so in its text; click it away and note what you saw.
  if (process.argv.includes("--with-unsuppressed")) {
    // A) uncaught error, no wrapper, no suppression (observed in Q1: modal error dialog, status "1").
    const a = await runJsx("throw new Error('spike A: uncaught, unsuppressed. Click OK.');", { timeoutSec: 60 });
    log("A uncaught throw, no suppress", summarize(a));
  }

  // B) uncaught throw with beginSuppressDialogs (no try/catch): does suppression stop the error dialog?
  const b = await runJsx("app.beginSuppressDialogs(); throw new Error('spike B: uncaught under beginSuppressDialogs. Click OK.');", { timeoutSec: 60 });
  log("B uncaught throw, beginSuppressDialogs", summarize(b));
  const bReset = await call("app.endSuppressDialogs(false); return 'reset';", { timeoutSec: 20 });
  log("B reset", bReset.parsed);

  // C) AE-internal failure: opening a missing project, under suppression, inside the wrapper
  const c = await call("app.open(new File('/nonexistent/ae-motion-spike.aep')); return 'returned';", { timeoutSec: 60, suppressDialogs: true });
  log("C app.open(missing file), suppressDialogs + wrapper", { ...summarize(c.raw), parsed: c.parsed });

  // D) script alert() under suppressDialogs
  const d = await call("alert('spike D: alert() under beginSuppressDialogs. If you see this, it is NOT suppressed. Click OK.'); return 'after alert';", { timeoutSec: 60, suppressDialogs: true });
  log("D alert() under beginSuppressDialogs", { ...summarize(d.raw), parsed: d.parsed });

  // E) AE's own "save changes?" prompt: dirty the throwaway project, then app.newProject() under suppression.
  const e = await call(
    "app.project.items.addComp('spike-dirty', 640, 360, 1, 1, 30); var wasDirty = app.project.dirty; var p = app.newProject(); return { wasDirty: wasDirty, newProjectReturned: p === null ? 'null' : 'Project', numItemsNow: app.project.numItems, file: app.project.file ? app.project.file.fsName : null };",
    { timeoutSec: 120, suppressDialogs: true },
  );
  log("E app.newProject() with a dirty project, suppressDialogs", { ...summarize(e.raw), parsed: e.parsed });

  // E2) The non-prompting way to drop a dirty project
  const e2 = await call(
    "app.project.items.addComp('spike-dirty2', 640, 360, 1, 1, 30); var before = app.project.dirty; app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES); return { dirtyBefore: before, itemsAfter: app.project.numItems, dirtyAfter: app.project.dirty };",
    { timeoutSec: 60, suppressDialogs: true },
  );
  log("E2 project.close(DO_NOT_SAVE_CHANGES) on a dirty project", { ...summarize(e2.raw), parsed: e2.parsed });

  // F) A broken expression: modal, banner, or just expressionError?
  const f = await call(
    `var c = app.project.items.addComp('spike-expr', 640, 360, 1, 1, 30); var l = c.layers.addNull(); var p = l.property('ADBE Transform Group').property('ADBE Position');
     var threw = null; try { p.expression = 'wiggle(2,'; } catch (err) { threw = String(err.message); }
     var res = { threw: threw, expressionEnabled: p.expressionEnabled, expressionError: p.expressionError };
     c.remove(); return res;`,
    { timeoutSec: 60, suppressDialogs: true, undo: "ae-motion: spike expr" },
  );
  log("F broken expression, suppressDialogs", { ...summarize(f.raw), parsed: f.parsed });
}

async function busy() {
  // Call 1 runs a 15 s busy loop. Call 2 starts 2 s later with a 5 s AppleEvent timeout.
  // Questions: does call 2 time out? Does its script still run later (a ghost write)?
  const marker = markerPath("busy");
  const long = runJsx("var t = new Date().getTime(); while (new Date().getTime() - t < 15000) {} 'long done';", { timeoutSec: 60 });
  await new Promise((r) => setTimeout(r, 2000));
  const short = await runJsx(writeMarker(marker) + " 'short ran';", { timeoutSec: 5 });
  log("call 2 while call 1 busy (5 s timeout)", summarize(short));
  log("call 1", summarize(await long));
  await new Promise((r) => setTimeout(r, 2000));
  log("did timed-out call 2 run afterwards?", existsSync(marker) ? `YES, at ${readFileSync(marker, "utf8")}` : "no marker file: never ran");
  rmSync(marker, { force: true });
}

async function override() {
  // Same as busy(), but call 2 uses DoScriptFile's `override` flag.
  // Timestamps show whether call 2 ran *during* call 1 (true concurrency) or after it.
  const long = call("var t = new Date().getTime(); while (new Date().getTime() - t < 10000) {} return { start: t, end: new Date().getTime() };", { timeoutSec: 60 });
  await new Promise((r) => setTimeout(r, 2000));
  const short = await call("return { ranAt: new Date().getTime(), items: app.project.numItems };", { timeoutSec: 5, override: true });
  log("call 2 with override while call 1 busy", { ...summarize(short.raw), parsed: short.parsed });
  const first = await long;
  log("call 1", { ...summarize(first.raw), parsed: first.parsed });
}

async function modal() {
  // Call 1 opens a blocking alert (the user clicks OK when told). Call 2 probes with a 5 s timeout,
  // then a DoScript (text) probe, then an `is running` check (which must not block).
  const marker = markerPath("modal");
  // The user can't see this terminal while it runs, so the alert itself says when to click.
  const blocked = runJsx("alert('ae-motion spike: modal test. Please WAIT 20 SECONDS, then click OK (and OK on anything else that appeared).'); 'alert closed';", { timeoutSec: 300 });
  await new Promise((r) => setTimeout(r, 3000));
  log("is running while modal open", await isRunning());
  const probe = await runJsx(writeMarker(marker) + " 'probe ran';", { timeoutSec: 5 });
  log("DoScriptFile probe while modal open (5 s timeout)", summarize(probe));
  const textMarker = markerPath("modal-text");
  const probeText = await doScriptText(writeMarker(textMarker) + " 'text probe ran';", { timeoutSec: 5 });
  log("DoScript (text) probe while modal open (5 s timeout)", summarize(probeText));
  log("call 1 after OK", summarize(await blocked));
  await new Promise((r) => setTimeout(r, 2000));
  for (const [label, m] of [["DoScriptFile probe", marker], ["DoScript text probe", textMarker]]) {
    log(`did ${label} run afterwards?`, existsSync(m) ? `YES, at ${readFileSync(m, "utf8")} (alert closed ~${Date.now() - 2000})` : "no marker file: never ran");
    rmSync(m, { force: true });
  }
}

async function userDialog() {
  // Open a normal AE dialog first (After Effects > Settings > General…), then run this case.
  const r = await call("return { ranAt: new Date().getTime() };", { timeoutSec: 8 });
  log("call while a user-opened AE dialog is open (8 s timeout)", { ...summarize(r.raw), parsed: r.parsed });
}

const cases: Record<string, () => Promise<void>> = { "not-running": notRunning, suppress, busy, override, modal, "user-dialog": userDialog };
const fn = cases[which ?? ""];
if (!fn) {
  console.error(`usage: node spike/04-dialogs-busy.ts <${Object.keys(cases).join("|")}>`);
  process.exit(2);
}
await fn();
