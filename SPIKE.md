# Phase 0 spike: findings

Run on 2026-10-30 to 2026-11-01 against **After Effects 2026 (26.5.0, build 89, ExtendScript 4.5.6)** on macOS 26.7.1, Node 24.22.
Every experiment ran in a throwaway untitled project. Items were named `spike-*` and removed afterwards.

**Bottom line:** the osascript → `DoScriptFile` bridge works, and it's fast (about 170 ms per call). But two assumptions in DESIGN.md were wrong:

1. **AE does not return the script's value.** `DoScriptFile` and `DoScript` only return a status, `"0"` (ok) or `"1"` (failed or not run). Results need their own channel (Q1).
2. **`app.beginSuppressDialogs()` doesn't stop the dialogs that matter.** Uncaught script errors, `alert()`, save prompts, the "second script" warning and "undo group mismatch" all still appear as blocking modals. The bridge has to avoid them by construction instead (Q4).

Everything else held up. Undo groups work well. Frame capture and H.264 rendering work **without** the "Allow Scripts to Write Files and Access Network" pref. `renderQueue.renderAsync()` exists and keeps AE responsive while it renders.

## How to re-run

```sh
npm install                               # dev deps only (typescript, @types/node)
node spike/01-roundtrip.ts [--with-syntax-error]
node spike/02-addressing.ts               # includes a missing-by-name case that can hang about 4 min on a chooser
node spike/03-undo.ts [--with-nested]     # --with-nested can trigger AE's "undo group mismatch" modal
node spike/04-dialogs-busy.ts <not-running|suppress|busy|override|modal|user-dialog>
node spike/05-frame-capture.ts <label>    # run once with the pref on and once with it off
node spike/06-render.ts [render|async|aerender]
```

Shared helpers are in `spike/lib/ae.ts`. Raw logs from the runs are in `spike/out/*.log` (gitignored). `04 suppress`, `04 busy` and `04 modal` open dialogs in AE that someone has to click away. `06` needs `ffprobe` (Homebrew) for verification.

---

## Q1. osascript → DoScriptFile round-trip: **Partial (return value refuted, rest confirmed)**

The AppleScript uses raw event codes, `«event miscfile»` (DoScriptFile) and `«event miscdosc»` (DoScript) from `ae.sdef`. The target and the script path are passed as `argv`. Nothing is interpolated into the AppleScript source.

| What | Result |
|---|---|
| Return value | **Refuted.** The reply is `"0"` for success and `"1"` for an uncaught error or a script that wasn't run, whatever the script evaluates to. Tried: DoScriptFile and DoScript, raw codes and dictionary terms, with and without semicolons. |
| Result channel (file) | The wrapper writes `{ok, value \| error}` JSON to `result.json` in a private 0700 temp dir. Node reads it once `osascript` returns. The write is finished by then, because the call is synchronous. Unicode survives (`héllo ✓ 日本 "q"`). **Needs the "Allow Scripts to Write Files" pref** (Q5). |
| Result channel (settings) | The wrapper calls `app.settings.saveSetting("ae-motion…", key, nonce + ":" + encodeURIComponent(json))` and then `app.preferences.saveToDisk()`. Node reads the value from `~/Library/Preferences/Adobe/After Effects/26.5/Adobe After Effects 26.5 Prefs.txt`. Same latency (median 182 ms); 1 MB in 205–254 ms. **Works with the pref off.** Relies on AE's undocumented prefs text format (`"key" = "…"` lines, wrapped with `"\<CR><TAB><TAB>"`). |
| Latency | `osascript` alone: 41–47 ms. Trivial DoScriptFile: median 167–173 ms (p95 185). Full call with wrapper and result file: median 175–180 ms (p95 192). A precompiled `.scpt` saves about 15–20 ms (median 153–157). |
| Large scripts | A 20 MB string literal in the script took 406 ms (1 MB: 210 ms). No size problem. |
| Large results | 1 MB in 173 ms, 10 MB in 238 ms, 50 MB in 550 ms (file channel). Building data in ExtendScript is slow: a 100k-iteration `push` loop took about 17 s, and 1M iterations went past 120 s. |
| Errors (caught) | A wrapper with try/catch returns `{name, message, line, number}` in about 150 ms with no dialog. AE's own errors are descriptive, e.g. `After Effects error: Unable to call "item" because of parameter 1. The range has no values.` |
| Syntax errors | Can't be caught if they're in the wrapper file itself. **Loading the body with `$.evalFile(bodyPath)` inside the try catches them** (`TypeError: Variable expected`, no dialog). |
| Errors (uncaught) | Reply `"1"` **plus a modal error dialog in AE**, which blocks every later call until a person clicks it. |
| Long scripts | After a few seconds AE shows an "Executing script wrapper.jsx… script execution time" progress window with a **Cancel** button. Cancel stopped a runaway script. |
| Engine | ExtendScript 4.5.6, which has a **native `JSON`**. An ES3 JSON polyfill I wrote didn't even parse in this engine. None is needed. |
| Side effect | **Every `DoScriptFile` path is added to AE's File > Scripts > Recent Script Files list** (`MRU Script Path ID # n` in prefs). With a new temp path per call, the user's menu fills with dead entries. |

## Q2. Addressing the right app: **Confirmed for 2026 (2025 dropped)**

AE 2025 isn't installed: `/Applications/Adobe After Effects 2025/` only holds a leftover `Scripts/` folder, and LaunchServices has no record of it. **Decision (user): support AE 2026 only.** The 2025 coexistence case is out of scope.

| Form | Result |
|---|---|
| `application id "com.adobe.AfterEffects.application"` | Works, about 155 ms. |
| `application "Adobe After Effects 2026"` | Works, about 172 ms. |
| `application "/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app"` | Works, about 178 ms. |
| Missing app by **path** | Clean failure in 68 ms: `Can't get application "…" (-1728)`. |
| Missing app by **name** | **Hung for 266 s** before returning `-1728`. Likely a "Where is …?" chooser. **Never address AE by name.** |

- The bundle id has no version in it (`com.adobe.AfterEffects.application`, with one shared `~/Library/Preferences/com.adobe.AfterEffects.application.plist`). That strongly suggests all versions share it. The render engine app has its own id (`com.adobe.AfterEffectsRenderEngine`).
- Discovery that never touches AE and needs no Automation permission:
  - `mdfind "kMDItemCFBundleIdentifier == 'com.adobe.AfterEffects.application'"` finds installs.
  - `lsappinfo info -only bundlepath -only pid -app <id>` shows the running instance.
  - `application id "<id>" is running` from OSA answers without launching AE.
- From inside a script, `app.version` gives `"26.5x89"` and `Folder.appPackage.fsName` gives the app path, which confirms the target.

## Q3. Undo groups: **Confirmed, with one hazard**

| Case | Result |
|---|---|
| A call wrapped in `beginUndoGroup("ae-motion: spike create")` / `endUndoGroup()` | **One Undo removes everything** (a comp with a solid, a text layer and keyframes). Redo restores it all. |
| Edit menu label | The user saw **"Undo ae-motion: spike label check"**. The group name reaches the user. (`app.findMenuCommandId("Undo …")` gave contradictory answers and can't be used to check this.) |
| Same call, no group | **7** undo steps. |
| Error halfway through a group (closed in `finally`) | Partial changes stay, and **one Undo removes them**. |
| Two calls | Two separate undo steps, one per agent action, as intended. |
| Nested groups | Run 1: merged into the outer group. **Run 2: the following Undo opened AE's modal "undo group mismatch, will attempt to fix"**, which blocked all calls until it was clicked. **Never nest.** |
| `app.project.revision` | Unchanged by a read-only call (806 → 806); increases with a mutation (806 → 830). This makes "undo this call on error" safe, because it never undoes someone else's step. |

`app.executeCommand(16)` is Undo and `2035` is Redo. Both work from a script.

## Q4. Dialogs, busy, modal-open, not running: **Partial (`beginSuppressDialogs` refuted as a safety net)**

**Dialog suppression** (`04 suppress`):

| Case | Suppressed? |
|---|---|
| Uncaught `throw` under `beginSuppressDialogs` | **No.** The error dialog appeared (23 s until the user clicked it). |
| `alert()` under suppression | **No.** |
| `app.newProject()` with a dirty project | **No.** The save prompt appeared. It returned `null` and the project wasn't replaced. |
| `app.open(missing file)` inside the wrapper | No dialog. A caught error: "Path is not valid." |
| Broken expression (`wiggle(2,`) | No dialog and no throw. It's reported in `property.expressionError` ("SyntaxError: Unexpected token '}'"). That's what `set_expression` needs. |
| `app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES)` | Closes a dirty project in 169 ms with no prompt. AE opens a fresh untitled project on its own. |

**Busy and modal** (`04 busy`, `override`, `modal`, `user-dialog`):

| State when a call arrives | What happens |
|---|---|
| Another script running (ours or the user's) | AE shows the modal **"Attempt was made to run a second script while another script was already running. Second script was not run. Try using 'DoScript "your_script_here" with override'…"**. Our call times out (`-1712`) or gets `"1"`. It **never runs later**, as marker files proved. |
| A script's `alert()` open | DoScriptFile: `AppleEvent timed out (-1712)` after 5 s. DoScript text: instant `"1"` plus the "second script" warning. Neither ran later. |
| An AE warning dialog open (e.g. "undo group mismatch") | **Instant `"1"`** for every call (about 140 ms). No extra dialogs. |
| A dialog the user opened (After Effects > Settings) | **Runs normally**, 145 ms. |
| Blocking `renderQueue.render()` in progress | AE answers no events, not even `override`. The probe waited until the render ended (Q6). |
| `override: true` while a script is running | **Runs re-entrantly in the middle of the other script.** It ran 2.2 s into a 10 s loop and took 326 ms, and the first script still finished. That's possible, but it's real concurrency inside ExtendScript, so use it only for read-only status, if at all. |
| AE not running | `is running` returns false without launching. **Any DoScriptFile launches AE**: the first call took 12.9 s and ran once AE was ready. After the crash (Q6), my next call **silently relaunched AE**. |

**So:** a bare `"1"` with no result is ambiguous: an uncaught error, a busy AE, or a dialog open in AE. With every error caught by the wrapper, it can only mean **"AE didn't run the command"**. The bridge should say so in plain English ("After Effects is busy or showing a dialog; check AE and try again") and not retry blindly.

Automation permission: the first call worked with no prompt noticed in this session. The host app was probably already approved. **The denied case (`-1743`, errAEEventNotPermitted) wasn't observed**, so it needs a check on a fresh account.

## Q5. Frame capture and the scripting pref: **Confirmed: capture does not need the pref**

The user turned the pref off and back on for this test. **Changing it was needed only to test both states. Capture works either way.**

| | Pref **on** | Pref **off** |
|---|---|---|
| `comp.saveFrameToPng(t, file)` | Works | **Works** |
| Render queue, single frame (TIFF template, then `sips`) | Works (387 ms + 76 ms) | **Works** (125 ms + 55 ms) |
| `app.project.save(file)`, `importFile`, `$.evalFile`, `File.read` | Work | **Work** |
| Result channel: file | Works | **Fails.** `File.open("w")` creates an empty file, then `write` throws `ReferenceError: Permission denied (is Preferences > Scripting & Expressions > Allow Scripts to Write Files and Access Network enabled?)` |
| Result channel: settings | Works | **Works** |
| `system.callSystem` | Works | Denied (same message) |
| Reading the pref | `getPrefAsLong("Main Pref Section v2", "Pref_SCRIPTING_FILE_NETWORK_SECURITY", PREF_Type_MACHINE_SPECIFIC)` returns 1 or 0. The prefs file on disk updates as soon as the setting is changed. | |

`saveFrameToPng` details:
- It returns a promise-like object (`wait`, `onComplete`, `onError`, `_isReady`). It isn't ready at return. **`.wait()` blocks until the file exists** (35–40 ms for 1280×720).
- Output is a **16-bit RGBA PNG with transparency**. The comp background colour isn't rendered, so white text on a transparent frame looked blank in the viewer. **`capture_frame` must flatten the image onto `comp.bgColor`** (Node `zlib` is enough; no dependency needed).
- It follows `comp.resolutionFactor`: `[2,2]` gives 640×360, which makes cheap previews possible.

Render-queue route: output-module `"Format"` is **read-only** through `setSettings`, and there's **no PNG template**. "TIFF Sequence with Alpha" plus macOS `sips` works. `saveFrameToPng` is simpler and faster, so it's the primary route.

## Q6. H.264 MP4 from the render queue: **Confirmed: `renderAsync` is the way**

- **Templates present:** `H.264 - Match Render Settings -  5 Mbps` (note the double space), `… - 15 Mbps`, `… - 40 Mbps`, plus High Quality, Lossless and others. The default output module for a new queue item is already H.264. Use `applyTemplate("H.264 - Match Render Settings - 15 Mbps")` and render settings `"Best Settings"`.
- **Output verified with `ffprobe`:** h264, 1920×1080, yuv420p, 30 fps, 180 frames, 6.000 s, about 2.9 MB for all three routes.
- `renderQueue.canQueueInAME` is `false`, so Media Encoder isn't an option.

| Route | Blocks? | Progress | Time (6 s 1080p clip) |
|---|---|---|---|
| `renderQueue.render()` | **Yes.** The call returns when the render is done. AE answers no events meanwhile, not even `override`. | None | 3.2 s |
| **`renderQueue.renderAsync()`** | **No.** Returns in 9 ms (`undefined`). Normal calls keep working during the render (about 170 ms each, no dialogs). | Poll `item.status` (QUEUED 3015 → RENDERING 3016 → DONE 3019; ERR_STOPPED 3018, USER_STOPPED 3017), `rq.rendering` and `item.elapsedSeconds`. `elapsedSeconds` stays 0 until done, there's **no percentage**, and the MP4 is written only at the end. | About 3 s |
| `aerender` CLI (separate headless AE) | No (separate process) | Per-frame `PROGRESS:  0:00:01:04 (35): 0 Seconds` lines on stdout | **16.3 s** (about 4 s to start, 7 s first frame). Needs the project saved to disk first. |

**AE crash (my bug, but a key finding):** a script read `om.getSetting()` after `it.remove()` on that output module's queue item. AE didn't throw: it **crashed** (`EXC_BAD_ACCESS` in `Scripting::OutputModule::GetSetting`). AE saved a recovery copy into `spike/out/`. Separately, string-concatenating an AE object (`"" + compItem`) **throws** ("Object of type CompItem found where a Number, Array, or Property is needed").

---

## Changes to DESIGN.md

Updated where a finding contradicts it:

1. **§3 result path:** "returns a JSON string" changed to: AE returns only a status, so results come back through a per-call result file, which requires the scripting pref (see Decision below). §4 gains a one-time setup row for the pref and a note that it is AE-wide.
2. **§3 dialogs:** "Suppress modal dialogs with `beginSuppressDialogs`" changed to: avoid them by construction. That means catching every error, loading the body with `$.evalFile`, never calling prompting APIs, never nesting undo groups, and allowing one call at a time.
3. **§3 concurrency:** added a single in-flight call queue, plus no automatic launch of AE.
4. **§3 target:** "2026 primary, 2025 if cheap" changed to 2026 only, addressed by bundle id, version checked.
5. **§5 `capture_frame` and `render`:** now name the routes: `saveFrameToPng().wait()` flattened onto the background, and `renderAsync` with status polling (no percentage).
6. **§8 temp scripts:** "deleted after each call" changed to a stable script path (Recent Scripts menu), plus a stale-file sweep at startup.
7. **§10:** Phase 0 marked done.

## Decision: result channel and the scripting pref

**Chosen (user, 2026-11-01): A, the file channel. Users must turn on "Allow Scripts to Write Files and Access Network".** B (the settings store) was the spike's recommendation; it stays documented here as evidence that a pref-free route exists, and the spike lib keeps it (`channel: "settings"`).

The options as presented:

| Option | Setup for each user | Security posture | Risk |
|---|---|---|---|
| **A. File channel.** Require "Allow Scripts to Write Files and Access Network" on. | Each user ticks one AE setting (`check_setup` explains how). | The pref lets *any* AE script write files and use the network. | Documented, simple, robust. |
| **B. Settings channel.** Pref can stay off. | **None** | Pref stays off, which is tighter. | Depends on AE's undocumented prefs text format, which an AE update could change. Each call rewrites the about 180 KB prefs file, and the last result sits in it until the next call. |
| C. Both: B by default, A when the pref is on | None | As B | Two code paths |

The spike recommended B (zero setup, pref stays off); the decision is A (documented, simpler, no dependence on AE's prefs file format).

## Recommended Phase 1 plan

1. **Bridge (`src/bridge/`)**
   - One queue, so only one AE call is in flight.
   - Target `application id "com.adobe.AfterEffects.application"` and pass `argv` only. Optionally precompile the AppleScript with `osacompile` at startup to save about 15 ms.
   - Check before every call, without launching AE: `is running` (OSA) plus `lsappinfo`. Launch AE only when the user asks, through `check_setup`.
   - Use one stable wrapper path in `~/Library/Application Support/ae-motion/run/`, so AE's Recent Scripts menu gets a single entry. Write a fresh body file and result file per call (0600), and sweep stale files at startup.
   - Result channel: the per-call result file (decision A). If the pref is off, the wrapper's write fails silently and the call comes back with status `"0"` and no result: map that to `pref_disabled`, with the fix in plain English.
   - Map outcomes to typed errors:
     - `ok`
     - `script_error` (the structured AE error)
     - `not_run` (status `"1"` with no result: "AE busy or showing a dialog")
     - `timeout` (`-1712`)
     - `not_running`
     - `permission_denied` (`-1743`)
     - `pref_disabled` (status `"0"` but no result file)
     - `wrong_version`
   - Timeouts per tool. Never retry a mutation automatically.
2. **ExtendScript runtime (`src/jsx/`)**
   - The wrapper is the only place that calls `begin/endUndoGroup` and `begin/endSuppressDialogs`. It loads the body with `$.evalFile` inside try/catch, and its result write never throws.
   - On error after a change (checked with `revision`), offer to undo it, or do it automatically (to decide in Phase 1).
   - Serialize AE objects with explicit fields only; never use `"" + obj`.
   - Read everything before any `remove()`.
   - Look items up by `id`.
3. **`check_setup`**
   - Report whether AE is installed and running, its version (26.x), and whether Automation permission is granted.
   - Report the scripting pref (read from the prefs file on disk without AE, or with `getPrefAsLong` in AE) with step-by-step instructions to turn it on, a result-file round-trip self-test, and whether a dialog seems to be blocking AE (instant `"1"`), each with a plain-English fix.
4. **Tools:** `get_project`, `inspect_comp`/`inspect_layer`, `create_comp`, `create_layer`, `set_properties`, `animate`, `set_expression` (returns `expressionError`), `add_effect`.
   - `capture_frame` uses `saveFrameToPng(t, file).wait()`, with an optional `resolutionFactor`. It flattens the RGBA image onto `bgColor` in Node and returns MCP image content plus the file path.
5. **Safety pieces:** audit log (JSONL) and the policy file, as designed.
6. **Tests:** unit tests on a mock bridge, covering every outcome above including `not_run`, timeouts and malformed results. Plus `spike`-style manual smoke scripts against real AE.
7. **Carry into Phase 2 (`render`):**
   - `renderAsync()`, polled about once a second through the normal queue.
   - Progress notifications carry the status and elapsed time, with a frame-count estimate, because AE gives no percentage.
   - Refuse mutations while rendering.
   - Temporarily un-queue other render-queue items and restore them after.
   - Read the H.264 template name from the `templates` list instead of hard-coding it (note the double space in "-  5 Mbps").
   - `aerender` stays an optional background mode for long renders.

Small checks for early Phase 1:
- Does `DoScript` with a one-line `$.evalFile("…")` keep the Recent Scripts menu clean? It also failed faster than DoScriptFile when a modal was open.
- What does the `-1743` permission-denied case look like on a fresh account?

## Leftovers and cleanup

- **AE project:** the throwaway project was closed without saving. AE is on a fresh untitled project with an empty render queue.
- **Temp files:** none left in `$TMPDIR`. One stale dir from the interrupted busy test was found and deleted.
- **Files inside the repo:** spike outputs are in `spike/out/` (gitignored): logs, PNGs, MP4s, the `.aep` saves, AE auto-save folders, and AE's crash-recovery copy `spike-save-pref-off_1.aep`. Safe to delete.
- **Changes to the user's AE data**, none of them preferences:
  - `Settings_ae-motion-spike` in the AE 26.5 prefs file still holds three keys, now emptied. ExtendScript can't delete a setting.
  - AE's Recent Script Files list holds about 10 dead temp-script paths.
  - macOS wrote `~/Library/Logs/DiagnosticReports/After Effects-2026-11-01-175717.ips` for the crash.
- **Scripting pref:** back on, as it was before the spike.
- **`~/Downloads/after-effects-mcp-main` and `~/claude-motion`:** not touched.
