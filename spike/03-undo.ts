// Spike Q3: do undo groups work when scripts arrive through osascript → DoScriptFile?
// Usage: node spike/03-undo.ts [--with-nested]   (works in the open project; only touches items named "spike-*")
import { call, log } from "./lib/ae.ts";

const UNDO = 16; // Edit > Undo
const REDO = 2035; // Edit > Redo

async function v<T = any>(body: string, opts: { undo?: string } = {}): Promise<T> {
  const r = await call<T>(body, { timeoutSec: 60, ...opts });
  if (!r.parsed) throw new Error(`no result: ${JSON.stringify(r.raw)}`);
  if (!r.parsed.ok) throw new Error(`AE error: ${JSON.stringify(r.parsed.error)}`);
  return r.parsed.value as T;
}

// State probe: which spike items exist, and what the Edit menu's Undo item is labelled.
const state = (label: string) =>
  v(`
    var names = [];
    for (var i = 1; i <= app.project.numItems; i++) { var it = app.project.item(i); if (it.name.indexOf("spike-") === 0) names.push(it.name + (it instanceof CompItem ? "[" + it.numLayers + " layers]" : "")); }
    return { items: names, undoMenuMatchesLabel: app.findMenuCommandId(${JSON.stringify("Undo " + label)}) !== 0 };
  `);

const undo = () => v(`app.executeCommand(${UNDO}); return true;`);
const redo = () => v(`app.executeCommand(${REDO}); return true;`);

const CREATE = `
  var c = app.project.items.addComp("spike-undo-comp", 1920, 1080, 1, 5, 30);
  var s = c.layers.addSolid([0.2, 0.4, 0.9], "spike-solid", 400, 400, 1);
  var t = c.layers.addText("spike text"); t.name = "spike-text";
  var pos = s.property("ADBE Transform Group").property("ADBE Position");
  pos.setValueAtTime(0, [200, 540]); pos.setValueAtTime(2, [1720, 540]);
  return { compId: c.id, layers: c.numLayers };
`;

// A. Explicit undo group: one Cmd+Z should remove everything the call did.
const label = "ae-motion: spike create";
log("A1 create in undo group", await v(CREATE, { undo: label }));
log("A2 state (expect comp with 2 layers; Undo menu labelled with the group name)", await state(label));
await undo();
log("A3 after ONE undo (expect no spike items)", await state(label));
await redo();
log("A4 after redo (expect comp back with 2 layers)", await state(label));
await undo();

// B. No undo group at all: how many undo steps does one call create?
await v(CREATE);
log("B1 created without undo group", await state(label));
await undo();
log("B2 after one undo", await state(label));
let steps = 1;
for (; steps < 10; steps++) {
  const s = await state(label);
  if (s.items.length === 0) break;
  await undo();
}
log("B3 undo steps needed to remove everything (no group)", steps);

// C. Error halfway through an undo group (wrapper closes the group in `finally`)
const half = await call(`var c = app.project.items.addComp("spike-undo-half", 640, 360, 1, 2, 30); c.layers.addNull(); throw new Error("spike: fail halfway");`, { undo: "ae-motion: spike half", timeoutSec: 30 });
log("C1 error result", half.parsed);
log("C2 state after error (partial changes stay)", await state("ae-motion: spike half"));
await undo();
log("C3 after ONE undo (expect partial changes gone)", await state("ae-motion: spike half"));

// D. Nested groups inside one call. Opt-in: on the second run this case made AE show the modal
// "undo group mismatch, will attempt to fix" on the following Undo (see SPIKE.md Q3). Never nest groups.
if (process.argv.includes("--with-nested")) {
  await v(
    `app.beginUndoGroup("ae-motion: spike inner"); var c = app.project.items.addComp("spike-undo-nested", 640, 360, 1, 2, 30); app.endUndoGroup();
     c.layers.addNull(); return c.numLayers;`,
    { undo: "ae-motion: spike outer" },
  );
  log("D1 nested: menu shows outer label?", await state("ae-motion: spike outer"));
  log("D1b nested: menu shows inner label?", await state("ae-motion: spike inner"));
  await undo();
  log("D2 after one undo", await state("ae-motion: spike outer"));
}

// E. Two consecutive calls = two separate undo steps (one per agent action)
await v(`app.project.items.addComp("spike-undo-step1", 640, 360, 1, 2, 30); return 1;`, { undo: "ae-motion: step 1" });
await v(`app.project.items.addComp("spike-undo-step2", 640, 360, 1, 2, 30); return 2;`, { undo: "ae-motion: step 2" });
await undo();
log("E after one undo (expect only step1 left)", await state("ae-motion: step 1"));
await undo();

// F. app.project.revision as a "did this call change anything?" detector (makes undo-on-error safe)
log("F read-only call", await v(`var r0 = app.project.revision; var n = app.project.numItems; return { before: r0, after: app.project.revision };`, { undo: "ae-motion: spike readonly" }));
log("F mutating call", await v(`var r0 = app.project.revision; app.project.items.addComp("spike-rev", 640, 360, 1, 2, 30); return { before: r0, after: app.project.revision };`, { undo: "ae-motion: spike label check" }));
console.log('\n>>> Manual check: AE\'s Edit menu should now read "Undo ae-motion: spike label check".');

// Cleanup: remove anything left with the spike- prefix, then an empty "Solids" folder AE may have made.
const left = await v(
  `var n = 0; for (var i = app.project.numItems; i >= 1; i--) { var it = app.project.item(i); if (it.name.indexOf("spike-") === 0) { it.remove(); n++; } }
   for (var j = app.project.numItems; j >= 1; j--) { var f = app.project.item(j); if (f instanceof FolderItem && f.name === "Solids" && f.numItems === 0) { f.remove(); n++; } }
   return { removed: n, remaining: app.project.numItems };`,
  { undo: "ae-motion: spike cleanup" },
);
log("cleanup", left);
