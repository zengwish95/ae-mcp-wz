import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { decodePng, downscale, encodePng, flatten } from "../png.ts";
import { callAE, CompId, defineTool, Seconds } from "./common.ts";

const MAX_AUTO = 1280; // long side for resolution "auto"
const KEEP_FRAMES = 200;

interface Captured {
  compId: number;
  name: string;
  time: number;
  frame: number;
  width: number;
  height: number;
  bgColor: [number, number, number];
}

export function scaleFactor(resolution: "auto" | "full" | "half" | "third" | "quarter", width: number, height: number): number {
  if (resolution === "auto") return Math.max(1, Math.ceil(Math.max(width, height) / MAX_AUTO));
  return { full: 1, half: 2, third: 3, quarter: 4 }[resolution];
}

export const captureFrame = defineTool({
  name: "capture_frame",
  title: "Capture a frame",
  description:
    "Renders one frame of a comp as a PNG and returns the image, so you can check the result and fix what's off. The frame is shown over the comp's background color. Also returns the file path, for clients that can't display images.",
  input: {
    compId: CompId,
    time: Seconds.optional().describe("Defaults to the comp's current time."),
    resolution: z.enum(["auto", "full", "half", "third", "quarter"]).default("auto").describe('"auto" keeps the long side at most 1280 px.'),
  },
  output: {
    path: z.string(),
    compId: z.number(),
    name: z.string(),
    time: z.number(),
    frame: z.number(),
    width: z.number(),
    height: z.number(),
    compWidth: z.number(),
    compHeight: z.number(),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  async run(args, ctx) {
    const raw = join(ctx.bridge.runDir, `frame-${randomUUID()}.png`);
    try {
      const r = await callAE<Captured>(ctx, "capture_frame", { compId: args.compId, time: args.time, outPath: raw }, { timeoutSec: 120 });
      const c = r.value;
      const img = downscale(flatten(decodePng(readFileSync(raw)), c.bgColor), scaleFactor(args.resolution, c.width, c.height));
      const png = encodePng(img);
      mkdirSync(ctx.paths.framesDir, { recursive: true, mode: 0o700 });
      const safe = c.name.replace(/[^\w.-]+/g, "_").slice(0, 60);
      const path = join(ctx.paths.framesDir, `${safe}-${c.compId}-f${c.frame}-${Date.now()}.png`);
      writeFileSync(path, png, { mode: 0o600 });
      pruneFrames(ctx.paths.framesDir);
      const structured = { path, compId: c.compId, name: c.name, time: c.time, frame: c.frame, width: img.width, height: img.height, compWidth: c.width, compHeight: c.height };
      return {
        structured,
        content: [
          { type: "image", data: png.toString("base64"), mimeType: "image/png" },
          { type: "text", text: JSON.stringify(structured) },
        ],
      };
    } finally {
      rmSync(raw, { force: true });
    }
  },
});

function pruneFrames(dir: string): void {
  // Another ae-motion process may prune the same folder meanwhile: a vanished file is not an error.
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".png"))
    .map((f) => ({ f, t: statSync(join(dir, f), { throwIfNoEntry: false })?.mtimeMs ?? 0 }))
    .sort((a, b) => b.t - a.t);
  for (const { f } of files.slice(KEEP_FRAMES)) rmSync(join(dir, f), { force: true });
}
