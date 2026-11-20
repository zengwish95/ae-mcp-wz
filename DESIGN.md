# ae-motion MCP — Design

Status: Phase 0 (spike) and Phase 1 (core) done. Sections changed by spike findings are marked *(Phase 0)*; decisions made while building Phase 1 are marked *(Phase 1)*.

## 1. What this is for

A designer or marketer describes a motion graphic in their AI coding agent (Claude Code, Codex, Cursor, …). The agent:

1. Builds it live in the running After Effects — comps, layers, keyframes, expressions where they make sense.
2. Captures preview frames, looks at them, and fixes what's off.
3. Renders an MP4 from After Effects' render queue.
4. Saves a clean, editable `.aep` that other designers can open and adjust by hand.
5. Handles follow-ups ("make the logo land harder") by editing that same project.

## 2. Principles

- **Lightweight.** Small server, runtime dependencies limited to the MCP SDK and zod (the SDK's required peer dependency) *(Phase 1)*, no After Effects panel, no network listener.
- **Agent-agnostic.** Plain MCP over stdio. No Claude-only features. Anything an agent needs to know lives in the server (instructions, tool descriptions, resources), not in one vendor's format.
- **Low friction for non-technical users.** One-click install, a single macOS permission prompt, no daily authentication.
- **Designer-editable output.** The `.aep` is the deliverable, not a by-product.
- **Safe by default.** No `eval` of external input, no world-writable IPC, server-side policy, local audit log.

## 3. Architecture

```
AI agent (any MCP client)
   │  stdio (JSON-RPC)
   ▼
ae-motion MCP server (TypeScript, Node; later a single binary)
   │  writes ExtendScript to a stable per-user script path
   │  osascript → After Effects AppleScript `DoScriptFile` (one call in flight)
   ▼
Running Adobe After Effects 2026
   │  script runs inside an undo group; AE replies only "0"/"1",
   │  so the script writes its JSON result to a result channel
   ▼
server reads the result → typed MCP tool result
```

- **macOS only for v1.** Windows would need a separate bridge (a CEP panel with an install-time token) — out of scope for now; keep the bridge behind an interface so it can be added.
- **AE 2026 only** *(Phase 0)*. Addressed by bundle id `com.adobe.AfterEffects.application` (never by app name: a missing name hangs on a "Where is…?" chooser); `app.version` is checked to be 26.x.
- **Synchronous request/response.** Every tool call returns only after After Effects finished, with a timeout. No polling, no shared command file.
- **One call at a time** *(Phase 0)*. AE refuses a script while another runs and shows a modal "second script" warning, so the server queues calls. It checks `is running` without launching AE first (any AppleEvent launches it), and launches only on explicit request.
- **Result channel** *(Phase 0)*. `DoScriptFile` returns only a status (`"0"`/`"1"`), never the script's value, so the wrapper writes its JSON result to a private per-call file (0600, in a 0700 dir) that the server reads after `osascript` returns. **This requires AE's "Allow Scripts to Write Files and Access Network" pref** (decided 2026-11-01; the pref-free settings-store channel tested in the spike was not chosen). `check_setup` reads the pref and explains how to turn it on.
- **ExtendScript library.** The After Effects side is a set of ExtendScript snippets/functions bundled with the server and sent per call (ES3-compatible; consider types-for-adobe for typing). Results are always JSON strings.
- **Every mutation runs in `app.beginUndoGroup("ae-motion: <action>")`**, so a user can Cmd+Z one agent step at a time. Only the wrapper opens a group; nothing inside it may nest one *(Phase 0: nesting can trigger AE's modal "undo group mismatch")*. `app.project.revision` tells whether a failed call changed anything.
- **Avoid modal dialogs by construction** *(Phase 0)*. `app.beginSuppressDialogs` is still used, but it does **not** stop uncaught-error dialogs, `alert()`, save prompts or the "second script" warning. So: every error is caught (the body is loaded with `$.evalFile` inside try/catch, so syntax errors are caught too), no prompting APIs (`close(CloseOptions.DO_NOT_SAVE_CHANGES)`, never `newProject()` on a dirty project), and one call at a time. A `"1"` with no result means "AE didn't run it (busy or a dialog is open)" and is reported, not retried. The wrapper writes `started.json` (request id + project revision) before running the body, so a run that started but never wrote a result is reported as `script_aborted` instead; the bridge then reads the revision with a tiny call to say whether the project changed, and the next call closes the undo group the stopped run may have left open. Every `not_run`, `timeout` and `script_aborted` fix tells the agent to stop and ask the user to check AE: each extra command sent while a dialog is open can add another dialog (2026-11-05 postmortem: an agent driving AE with raw osascript scripts, outside ae-motion, flooded the user with dialogs).
- **Never empty a keyframed property** *(2026-11-05)*. Removing the last Time Remap key turns Time Remap off. `animate` (replace) and `shift_keyframes` keep one old key until the new ones exist; `remove_keyframes` refuses to remove every Time Remap key. Keys are removed by index from last to first, never with `while (numKeys > 0)`.
- **Failed calls leave partial changes in place** *(Phase 1, decided 2026-11-01)*. The wrapper compares `app.project.revision`; the error tells the agent that changes were made and that Edit > Undo "ae-motion: …" reverts the call. Nothing is undone automatically.
- **Never touch an AE object after `remove()`** *(Phase 0)*. It can crash AE instead of throwing. Serialize AE objects field by field (`"" + obj` throws).
- **Stable identifiers.** Refer to items and layers by `id` (plus names for readability), not by panel index.
- **Property paths say which child** *(2026-11-10)*. Inside indexed groups (effects, masks, shape contents) every child of a kind has the same match name (`"ADBE Vector Group"`), and AE allows duplicate names. Paths in results use the child's name when no sibling shares it, else its 1-based index, so a path passed back always reaches the same property.
- **Shape and layer facts** *(2026-11-10 spike)*. Adding a property to a group invalidates references to its earlier children, so items are re-found by index after each add. Shape operators are added by match name only (`canAddProperty("Trim Paths")` is false). A path's ease speed is in multiples of the segment's average rate (a linear key reads speed 1). `instanceof AVLayer` is false for text and shape layers in AE 2026, so AV-only checks use `AEM.isAV`.
- **Text, gradient, Essential Graphics and keyframe facts** *(2026-11-19 spike, AE 26.5)*. A new text animator has no selector, and every animator property already exists on it but stays hidden (setting a value fails with "the property or a parent property is hidden") until `addProperty` shows it; `canAddProperty` stays true and re-adding is a no-op. Dropdowns are 1-based menu indexes (checked with the undocumented `Property.valueText`). **Gradient colour stops can't be scripted**: `ADBE Vector Grad Colors` is `NO_VALUE` and takes no expression, no bundled preset contains one, applying an `.ffx` preset replaces a shape layer's whole Contents, Copy/Paste clobbers the user's clipboard, and importing a hand-built `.aepx` with gradient data crashed AE. Gradients keep AE's default ramp and the tools warn. Essential Graphics: a new control goes to index 1 (not last), so the index is found by diffing names; controls can't be removed or reordered; precomp layers expose them as `ADBE Layer Overrides` > control name. Shape and text layers are always continuously rasterized (`canSetCollapseTransformation` false). Spatial tangents must have 3 values even on 2D layers; setting a temporal ease turns a hold side back into bezier, so interpolation is set again after it.

## 4. Security model

| When | User sees | Protects against |
|---|---|---|
| Install (once per host app) | macOS "… wants to control Adobe After Effects" → OK | Other software driving AE; macOS verifies the calling app |
| Setup (once per user) *(Phase 0)* | Turn on AE Settings > Scripting & Expressions > "Allow Scripts to Write Files and Access Network" (`check_setup` guides it) | Needed for the result channel |
| Daily use | Nothing | No port, no token, nothing to log in to |
| Risky actions | The agent client's own approval prompt | Model mistakes |

- Note: the Automation permission belongs to the host app (Terminal, Claude, Codex), not to this server specifically. Accepted trade-off; document it.
- Note *(Phase 0)*: the scripting pref is AE-wide: it lets any AE script (not just this server's) write files and use the network. Accepted trade-off; documented in the README.
- **Server-side policy file** (`~/Library/Application Support/ae-motion/policy.json`; a machine-wide `/Library/Application Support/ae-motion/policy.json`, for every user of this Mac, replaces it when present): `importFolders` (default: the home folder *(Phase 1)*), `disabledTools`, and `allowRawExtendScript` (turns on `run_jsx`). Paths are checked after resolving symlinks. A malformed policy fails closed (no imports). Enforced by the server regardless of which client is connected.
- **Tool annotations** (`readOnlyHint`, `destructiveHint`) so clients that honor them prompt appropriately. Treat as hints; the server policy is the real gate.
- **Audit log**: append-only JSONL of every tool call (tool, args summary, duration, result status), plus the full text of any raw ExtendScript executed.
- **Never `eval`** anything from outside the server.

## 5. Tools (target ~12–15, all typed with input and output schemas)

| Tool | Purpose |
|---|---|
| `check_setup` | Is AE running, which version, permission granted, prefs needed. Plain-English fixes. |
| `get_project` | Project summary: comps, folders, footage, active comp. Paginated, compact. |
| `inspect_comp` / `inspect_layer` | Layer list, property tree with match names, keyframes, expressions and their errors. |
| `create_comp` | New comp (size, fps, duration, bg color). |
| `create_layer` | Text, shape (rectangle, ellipse, freeform path, or full `contents`), solid, null, camera, adjustment, footage import (allowed folders only). |
| `add_shape_content` | Shape items by friendly type (path, rectangle, ellipse, polystar, fill, stroke with taper, gradientFill/gradientStroke without stops, trimPaths, group with transform) or any other vector item by match name; the server maps them to match names, AE adds them in order. Returns each item's property path for `animate`. *(2026-11-10)* |
| `set_properties` | Comp settings (incl. motion blur, frame blending, shy switches), or a layer's transform, timing (incl. time stretch and Time Remap on/off), blend mode, parenting (with or without jump), 3D, track matte, the Timeline switches (Preserve Underlying Transparency, motion blur, adjustment, guide, collapse, fx, quality, sampling, frame blending, audio, auto-orient, per-character 3D) *(2026-11-19)*, text properties, any property by path, and layer order *(Phase 1)*. Checks `canSetTimeRemapEnabled`, AV-only switches and parent cycles first. |
| `add_text_animator` | Text animator with friendly animator properties and range / wiggly / expression selectors (based on characters, words or lines; percent or index units), or additions to an existing animator; More Options grouping. Returns paths for `animate`. *(2026-11-19)* |
| `shift_keyframes` / `remove_keyframes` | Retime existing keyframes (offset/scale around a pivot, optional property list and time range), keeping value, interpolation, eases, continuity, spatial tangents and roving; collisions refused before any change. Remove keys by all/range/times. |
| `animate` | Keyframes with named eases (brand motion tokens → AE temporal ease). The default path for motion. Keyframes can also carry exact details (interpolation per side, speed/influence eases, spatial tangents, continuous/auto-bezier, roving, labels) *(2026-11-19)*. |
| `edit_keyframes` | Change existing keys in place (value and the same details), picked by time or index; every key and detail checked before any change. *(2026-11-19)* |
| `set_expression` | Set/remove; returns `expressionError` so the agent can fix it. |
| `add_effect` | By display name or match name (`canAddProperty`); unknown names return suggestions from `app.effects`; set parameters. |
| `remove_effect` | Remove effects from a layer by stack index, instance name or (unambiguous) match name; all references resolved before any removal, then removed last-to-first; reports comp expressions that name a removed effect. *(2026-11-06)* |
| `set_layer_style` | Layer styles have no `addProperty` route: their properties stay hidden until the Layer > Layer Styles menu command runs (`app.executeCommand` 9000–9008) on the selected layer of the active comp. So the tool opens the comp, selects only that layer, runs the command, restores the selection, then sets settings by display name or match name. Runs inside the call's undo group (one Undo reverts it all). Pattern Overlay has no menu command. *(2026-11-10)* |
| `essential_graphics` | Template name, add properties as controls (`addToMotionGraphicsTemplateAs`), rename controls, list them. *(2026-11-19)* |
| `delete_items` | Delete layers and project items by id, one undo step, marked destructive *(Phase 1)*. |
| `capture_frame` | `comp.saveFrameToPng(t, file).wait()` (needs no scripting pref), flattened onto the comp background (AE writes transparent RGBA) and downscaled in Node so the long side is ≤ 1280 px by default (the comp is never changed, so a capture adds no undo step); return MCP image content **and** the file path (for clients that can't show images). *(Phase 0, Phase 1)* |
| `render` | H.264 MP4 via render queue (`H.264 - Match Render Settings - 15 Mbps`) with `renderAsync()` so AE stays responsive; progress notifications from item status + elapsed time (AE exposes no percentage); output into the project's `renders/`. *(Phase 0)* |
| `save_project` | Save `.aep` into the handoff folder, collect assets with relative paths. |
| `audit_project` | Report handoff problems (see §6). Reports, doesn't block. |
| `find_preset` / `import_template` | Search the shared preset library manifest; import `.aep` templates / apply `.ffx`. |
| `run_jsx` | Escape hatch for anything the typed tools don't cover. Runs through the wrapper (dialog suppression, undo, lock, timeout). Gated by `allowRawExtendScript` (not even listed otherwise), marked destructive, fully logged. *(done early, 2026-11-05)* |

## 6. Editability guidance (written guidance, not enforcement)

Put this in the server `instructions` and the `motion_design_guide` resource:

- Use keyframes for anything a designer will want to retime or nudge.
- Use expressions when they're genuinely the better tool (procedural backgrounds, systems driven by one control, complex scenes). When you do, expose the knobs on a **Controls** null (sliders, color, checkbox) and put a one-line comment at the top of each expression.
- Name every layer and precomp; one precomp per scene; nulls to move groups; markers on beats; color labels.
- No per-frame keyframe dumps.

`audit_project` flags only real handoff problems: expression errors, missing fonts, unnamed layers, layers fully outside the frame, absolute asset paths, unusually dense keyframes. It does **not** restrict which expressions are allowed.

## 7. Working with other engines and shared knowledge

Three layers:

1. **Knowledge** — portable, outside any engine.
   - Brand + motion tokens (colors, fonts, durations, named eases as cubic-beziers) in one repo. This server converts eases to AE temporal ease; Remotion/HyperFrames read them as code.
   - Skills (`SKILL.md`, readable by Claude and other agents) hold taste and workflows and call whichever engine fits. This server stays thin.
   - The same guide is exposed as an MCP resource for clients without skills.
2. **Engines** — chosen by deliverable.

   | Need | Engine |
   |---|---|
   | Editable `.aep` a designer will touch | this server |
   | Many data-driven variants | Remotion (`~/claude-motion`) |
   | Fast web-native motion, no designer handoff | HyperFrames |
   | Motion for web/app | build in AE → Lottie (Bodymovin) |

   **Routing gotcha:** the installed HyperFrames skills claim to be the default for any video request. Server instructions and skills need an explicit rule: "if a designer will edit it, or an `.aep` is needed, use ae-motion."
3. **Assets** — a preset library (git repo or folder) of `.ffx`, template `.aep`s and brand assets with a `manifest.json` (name, description, parameters, preview GIF).

Combining engines: import Remotion/HyperFrames renders (e.g. transparent data-viz) as footage layers; rebuild a web composition in AE by having the agent read its timing as reference (no automatic converter); export AE work to Lottie for web playback.

## 8. File locations

| What | Where |
|---|---|
| This server's source | `~/ae-mcp-wz` (github.com/zengwish95/ae-mcp-wz) |
| Finished projects (`.aep`, `renders/*.mp4`, `assets/`) | `~/Movies/AE Motion/<ProjectName>/` (configurable) |
| Settings and policy | `~/Library/Application Support/ae-motion/` |
| Logs | `~/Library/Logs/ae-motion/audit.jsonl` |
| Captured frames | `~/Library/Caches/ae-motion/frames/` (newest 200 kept) *(Phase 1)* |
| Temporary scripts | one stable wrapper path under `~/Library/Application Support/ae-motion/run/` (each `DoScriptFile` path is added to AE's Recent Scripts menu), per-call body/result files there (0600), stale files swept at startup *(Phase 0)* |

MCP server name: `ae-motion`. Do not reuse `AfterEffectsMCP` or `~/Documents/ae-mcp-bridge` from the old repo.

## 9. Distribution (later phase)

- Single binary (no Node needed) inside a signed macOS `.pkg`.
- The installer detects installed agents and registers the server in each config: Claude Desktop, Claude Code, Codex (`~/.codex/config.toml`), Cursor.
- Optional `.mcpb` for one-click Claude Desktop install.

## 10. Phases

**Phase 0 — spike (prove the risky assumptions before building).** *Done; findings in `SPIKE.md`.* Against AE 2026 on this Mac:

1. `osascript` → `DoScriptFile` round-trip: does the script's return value come back? Latency? Large scripts? How do ExtendScript errors surface?
2. How to address the app reliably (app name vs bundle id; 2025 and 2026 both installed).
3. Undo groups work when invoked this way.
4. `app.beginSuppressDialogs` / behavior when AE is busy, has a modal open, or isn't running.
5. Frame capture (`CompItem.saveFrameToPng` or single-frame render): does it need the "Allow Scripts to Write Files and Access Network" pref? Is there a route that avoids it?
6. H.264 MP4 via the render queue: which output module template exists, is `renderQueue.render()` blocking, how to report progress.

Output: `SPIKE.md` with findings and any design changes, then stop for review.

**Phase 1 — core.** *Done.* Bridge, `check_setup`, inspect tools, create/set/animate/expression/effect, `delete_items`, `capture_frame`, undo groups, audit log, policy file. Tests against a mock bridge (`npm test`) plus a manual smoke script for real AE (`npm run smoke`).

**Retiming + dialog safety (2026-11-05).** `shift_keyframes`, `remove_keyframes`, `run_jsx`, `set_properties` stretch/Time Remap/parent-with-jump, `script_aborted`. Live check: `node scripts/retime-smoke.ts`.

**Shapes + layer styles (2026-11-10).** `add_shape_content`, `create_layer` paths/contents, path values in `set_properties`/`animate`/`inspect_layer`, `set_layer_style`. Live check: `node scripts/shapes-smoke.ts`.

**Text, Essential Graphics, switches + keyframe details (2026-11-19).** `add_text_animator`, `essential_graphics`, `edit_keyframes`, keyframe details in `animate`/`inspect_layer`, layer and comp switches in `set_properties`, gradient fill/stroke items (stops not scriptable). Live check: `node scripts/phase3-smoke.ts`.

**Phase 2 — handoff.** `render`, `save_project`, `audit_project`, motion tokens, preset library tools.

**Phase 3 — distribution.** Single binary, `.pkg`, client auto-registration.

**Ongoing — evals.** ~30 real motion-design prompts, scored with captured frames; use them to tune tool descriptions.

## 11. Open questions

- Is there a brand template `.aep` (colors, fonts, lower-thirds, title cards) to build from?
- Default project output folder — is `~/Movies/AE Motion/` right?
- Default for `run_extendscript`: on (with client approval prompts) or off?
- Any Windows users who need support later?

## 12. Non-goals / boundaries

- Don't copy code from `~/Downloads/after-effects-mcp-main` (MIT, reference only; attribute if any snippet is adapted).
- Don't modify `~/claude-motion`.
