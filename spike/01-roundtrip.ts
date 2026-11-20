// Spike Q1: osascript → DoScriptFile round-trip: return value, latency, large scripts/results, errors.
// Usage: node spike/01-roundtrip.ts [--with-syntax-error]
//   --with-syntax-error also checks that a syntax error inside $.evalFile is caught (if it is not,
//   After Effects shows a modal error dialog that must be clicked away).
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call, doScriptText, log, osa, runJsx, summarize } from "./lib/ae.ts";

function stats(ms: number[]) {
  const s = [...ms].sort((a, b) => a - b);
  const pick = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, min: s[0], median: pick(0.5), p95: pick(0.95), max: s[s.length - 1] };
}

// 1. What does the AppleScript reply contain?
log("reply for a script whose last value is 'hello'", summarize(await runJsx("'hello';", { timeoutSec: 30 })));
log("reply for DoScript (text) 'hello'", summarize(await doScriptText("'hello';", { timeoutSec: 30 })));

// 2. Result-file channel
const r = await call("return { version: app.version, engine: $.version, json: typeof JSON, text: 'héllo ✓ 日本 \"q\" \\n' };", { timeoutSec: 30 });
log("call() via result file", { ...summarize(r.raw), parsed: r.parsed });

// 3. Latency
const osaOnly: number[] = [];
for (let i = 0; i < 10; i++) osaOnly.push((await osa("return 1")).ms);
log("osascript alone (no AE event)", stats(osaOnly));

const raw: number[] = [];
for (let i = 0; i < 20; i++) raw.push((await runJsx("'x';", { timeoutSec: 30 })).ms);
log("DoScriptFile trivial (status only)", stats(raw));

const full: number[] = [];
for (let i = 0; i < 20; i++) full.push((await call("return app.project.numItems;", { timeoutSec: 30 })).raw.ms);
log("call() trivial (wrapper + result file)", stats(full));

// Precompiled AppleScript vs `osascript -e` (compile per call)
const dir = mkdtempSync(join(tmpdir(), "ae-motion-spike-"));
try {
  const scpt = join(dir, "do.scpt");
  execFileSync("/usr/bin/osacompile", ["-o", scpt, "-e", 'on run argv\ntell application id "com.adobe.AfterEffects.application" to return «event miscdosc» (item 1 of argv)\nend run']);
  const pre: number[] = [];
  for (let i = 0; i < 20; i++) {
    const t = performance.now();
    execFileSync("/usr/bin/osascript", [scpt, "'x';"]);
    pre.push(Math.round(performance.now() - t));
  }
  log("precompiled .scpt DoScript trivial", stats(pre));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// 4. Large scripts (padding is a big string literal that the script measures)
for (const mb of [0.1, 1, 5, 20]) {
  const n = Math.round(mb * 1024 * 1024);
  const body = `var big = "${"a".repeat(n)}"; return big.length;`;
  const res = await call(body, { timeoutSec: 120 });
  log(`script with ${mb} MB literal`, { ms: res.raw.ms, status: res.raw.stdout, value: res.parsed?.value, expected: n });
}

// 5. Large results
for (const mb of [1, 10, 50]) {
  const n = Math.round(mb * 1024 * 1024);
  // Doubling, not a loop: a 1M-iteration ExtendScript loop takes minutes (first run of this spike hit that).
  const res = await call(`var s = "a"; while (s.length < ${n}) s += s; return s.substring(0, ${n});`, { timeoutSec: 120 });
  log(`result of ${mb} MB`, { ms: res.raw.ms, bytes: res.resultBytes, lengthOk: (res.parsed?.value as string | undefined)?.length === n });
}

// 5b. Settings result channel (app.settings + saveToDisk → AE prefs file); works with the file-write pref off (Q5)
const sChan: number[] = [];
for (let i = 0; i < 10; i++) sChan.push((await call("return app.project.numItems;", { channel: "settings", timeoutSec: 30 })).raw.ms);
log("settings channel trivial", stats(sChan));
const sBig = await call(`var s = "a"; while (s.length < 1048576) s += s; return s.substring(0, 1048576);`, { channel: "settings", timeoutSec: 60 });
log("settings channel 1 MB result", { ms: sBig.raw.ms, lengthOk: (sBig.parsed?.value as string | undefined)?.length === 1048576 });
const sUni = await call("return 'héllo ✓ 日本 \"q\"';", { channel: "settings", timeoutSec: 30 });
log("settings channel unicode", sUni.parsed);
await call("return 0;", { channel: "settings", timeoutSec: 30 }); // leave the stored value small

// 6. Errors that the wrapper catches (no dialog)
const thrown = await call("throw new Error('spike: thrown inside wrapper');", { timeoutSec: 30 });
log("runtime throw inside wrapper", { ...summarize(thrown.raw), parsed: thrown.parsed });
const refErr = await call("return notDefinedThing.foo;", { timeoutSec: 30 });
log("ReferenceError inside wrapper", { ...summarize(refErr.raw), parsed: refErr.parsed });
const aeErr = await call("return app.project.item(9999);", { timeoutSec: 30 });
log("AE API error inside wrapper (item index out of range)", { ...summarize(aeErr.raw), parsed: aeErr.parsed });

if (process.argv.includes("--with-syntax-error")) {
  const syn = await call("var = ;", { timeoutSec: 60, useEvalFile: true });
  log("syntax error in body loaded via $.evalFile", { ...summarize(syn.raw), parsed: syn.parsed });
}
