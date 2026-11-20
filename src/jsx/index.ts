// Loads the bundled ExtendScript sources and builds the per-call body.jsx.
import { readFileSync } from "node:fs";

const here = new URL(".", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, here), "utf8");

export const WRAPPER = read("wrapper.jsx");
export const LIB = read("lib.jsx");

const cache = new Map<string, string>();
export function toolScript(name: string): string {
  let s = cache.get(name);
  if (s === undefined) {
    s = read(`tools/${name}.jsx`);
    cache.set(name, s);
  }
  return s;
}

// BOM so ExtendScript reads it as UTF-8. ARGS comes from request.json (parsed by the wrapper), not from code.
export function bodyFile(toolBody: string): string {
  return "﻿" + LIB + "\n(function (ARGS) {\n" + toolBody + "\n})($.global.__aemArgs);\n";
}
