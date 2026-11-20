# ae-motion

An MCP server that lets a coding agent (Claude Code, Claude Desktop, Codex, Cursor, …) build motion graphics live in **Adobe After Effects 2026** on macOS. The agent creates comps, layers, keyframes, expressions and effects, checks captured frames, and leaves a project a designer can edit by hand.

Design: [`DESIGN.md`](DESIGN.md). Phase 0 findings: [`SPIKE.md`](SPIKE.md).

## Requirements

- macOS with Adobe After Effects 2026.
- Node.js 22.18 or newer (runs the TypeScript source directly; no build step).
- In After Effects: **Settings > Scripting & Expressions > "Allow Scripts to Write Files and Access Network"** turned on (once per user). `check_setup` tells the user if it's off.
- The first call makes macOS ask whether your agent app may control "Adobe After Effects 2026". Click **OK**. If it was refused: System Settings > Privacy & Security > Automation.

## Install

```sh
git clone https://github.com/zengwish95/ae-mcp-wz.git ~/ae-mcp-wz
cd ~/ae-mcp-wz && npm install --omit=dev
```

Register it with your agent. Use the absolute path to `node` (`which node`): GUI apps often don't have your shell's `PATH`.

**Claude Code**
```sh
claude mcp add ae-motion -- /opt/homebrew/bin/node ~/ae-mcp-wz/src/index.ts
```

**Claude Desktop**: `~/Library/Application Support/Claude/claude_desktop_config.json`
```json
{ "mcpServers": { "ae-motion": { "command": "/opt/homebrew/bin/node", "args": ["/Users/you/ae-mcp-wz/src/index.ts"] } } }
```

**Codex**: `~/.codex/config.toml`
```toml
[mcp_servers.ae-motion]
command = "/opt/homebrew/bin/node"
args = ["/Users/you/ae-mcp-wz/src/index.ts"]
```

**Cursor**: `~/.cursor/mcp.json`, same shape as Claude Desktop.

Then ask the agent something like *"Open After Effects and make a 5-second title card: our logo fades in, the tagline slides up with a soft overshoot."*

## Using it on your own project

ae-motion has no per-project setup: it works on whatever project is open in After Effects.

1. **Open the project in After Effects yourself** (File > Open). There's no tool to open a project yet.
2. **Ask the agent to start from it**, e.g. *"Call `get_project`, then in the comp 'Main' add a lower third…"*. `get_project` lists the open project's comps, footage and solids, with the ids the other tools use.
3. **Save it yourself** (⌘S). There's no save tool yet, so nothing reaches the `.aep` until you save. Each agent call is one **Edit > Undo** step, so you can step back through what it did.

Also check:

- **Claude Code scope.** `claude mcp add` registers the server for the current folder only. To have it in every folder, add `--scope user`:
  ```sh
  claude mcp add --scope user ae-motion -- /opt/homebrew/bin/node ~/ae-mcp-wz/src/index.ts
  ```
  `claude mcp list` shows whether it's available where you are. `--scope project` instead writes a `.mcp.json` into the folder to share with a team. Claude Desktop, Codex and Cursor configs already apply everywhere.
- **Footage outside your home folder.** Imports are allowed from your home folder by default. For a drive or shared volume, list it in the [policy](#policy-and-logs-for-it):
  ```json
  { "importFolders": ["~", "/Volumes/Brand"] }
  ```
- **Work on a copy.** A call that fails partway leaves its changes in place. Before a big session on a project you care about, Save As a copy or commit the `.aep` to version control.

## Tools

| Tool | What it does |
|---|---|
| `check_setup` | Is AE installed and running, is control allowed, is the scripting setting on. Plain-English fixes. Can open AE. |
| `get_project` | The project's comps, folders, footage and solids, with ids. |
| `inspect_comp` | Comp settings, markers and layers (timing, parent, matte, transform, text, effects, what's animated). |
| `inspect_layer` | A layer's property tree: match names, values, keyframes with eases, expressions and their errors. |
| `create_comp` | New composition. |
| `create_layer` | Text, shape (rectangle, ellipse, freeform path, or full contents), solid, null, adjustment, camera, light, or footage from a file. |
| `add_shape_content` | Add to a shape layer's Contents or a group in it: bezier paths, rectangles, ellipses, stars/polygons, fills, strokes with taper, gradient fills and strokes (see below), Trim Paths, groups, and any other shape operator by match name (repeater, offset, round corners…). |
| `add_text_animator` | Text animators: position, scale, rotation, opacity, fill colour, tracking, blur… driven by range selectors (per character, word or line), wiggly or expression selectors. |
| `set_properties` | Static comp or layer settings: comp duration, work area, motion blur and frame blending; layer order, timing (in/out, time stretch, Time Remap on/off), parent (optionally with jump), track matte, the Timeline switches (Preserve Underlying Transparency "T", motion blur, adjustment, guide, collapse, fx, quality, frame blending, auto-orient, per-character 3D), transform, text, any property by path. |
| `animate` | Keyframes on one or more properties with named eases or cubic-beziers, plus exact AE details per keyframe (interpolation, speed/influence, motion path tangents, roving, labels). |
| `edit_keyframes` | Change existing keyframes in place: value, interpolation, exact eases, motion path tangents, continuous/auto-bezier, roving, labels. |
| `shift_keyframes` | Move or scale existing keyframes in time (optionally only some properties or a time range), keeping eases and tangents. |
| `remove_keyframes` | Remove all, a time range, or specific keyframes from a property. Won't empty Time Remap. |
| `set_expression` | Set or remove an expression; returns AE's expression error. |
| `add_effect` | Add an effect by name and set parameters; unknown names get suggestions. |
| `remove_effect` | Remove effects from a layer by index, instance name or match name; warns about expressions that used them. |
| `set_layer_style` | Apply a layer style (drop shadow, inner/outer glow, bevel and emboss, satin, color/gradient overlay, stroke) and set or hide it. Opens the comp in the viewer to apply it; your layer selection is restored. |
| `essential_graphics` | A comp's Essential Graphics panel: template name, add properties as named controls, rename controls. Precomp layers' Essential Properties can then be set with `set_properties`. |
| `delete_items` | Delete layers or project items. |
| `capture_frame` | A frame as PNG (image + file path), over the comp background, long side ≤ 1280 px by default. |
| `run_jsx` | Escape hatch: your own ExtendScript, run through the same wrapper (dialogs suppressed, one undo step, lock, timeout). Off and not listed unless the policy sets `"allowRawExtendScript": true`. |

**What scripts can't do in After Effects 2026**, so ae-motion can't either:
- set gradient colour stops (shape gradient fills and strokes, Gradient Overlay). ae-motion adds the gradient with AE's default white-to-black stops and tells the agent to ask you to set them (Edit Gradient… next to Colors). Gradient Ramp only has a start and an end colour, which `add_effect` / `set_properties` can set;
- remove or reorder Essential Graphics controls;
- remove a single layer style (it can be hidden).

Every changing call is a single **Edit > Undo** step in After Effects named "ae-motion: …". If a call fails partway, its changes are left in place and the error says so.

## Policy and logs (for IT)

- Policy: `~/Library/Application Support/ae-motion/policy.json`, or machine-wide `/Library/Application Support/ae-motion/policy.json` (wins when present, e.g. pushed by MDM):
  ```json
  { "importFolders": ["~/Movies/AE Motion", "/Volumes/Brand"], "disabledTools": ["delete_items"] }
  ```
  `importFolders` defaults to the home folder. `"allowRawExtendScript": true` turns on `run_jsx`. A malformed policy turns imports off until it's fixed.
- Audit log: `~/Library/Logs/ae-motion/audit.jsonl`, one line per tool call (tool, client, summarized arguments, duration, status).
- The "Allow Scripts to Write Files and Access Network" setting applies to every After Effects script, not only this server's.

## Development

```sh
npm install
npm test            # unit + MCP tests against a mock bridge (no AE needed)
npm run typecheck
npm run smoke       # drives the real AE 2026: use a throwaway project; add -- --keep to leave the comp
node scripts/retime-smoke.ts   # real AE: retiming tools, Time Remap safety, script_aborted; uses and deletes two throwaway comps
node scripts/shapes-smoke.ts   # real AE: shape contents, Trim Paths, path keyframes, layer styles; uses and deletes one throwaway comp
node scripts/phase3-smoke.ts   # real AE: text animators, gradients, switches, keyframe details, Essential Graphics; one throwaway comp
```

The spike scripts from Phase 0 are in `spike/` (see `SPIKE.md`).
