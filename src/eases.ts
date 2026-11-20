// Named eases as cubic-beziers (CSS convention: x1, y1, x2, y2 on normalised time/value).
// lib.jsx converts them to After Effects temporal ease (speed + influence) per keyframe segment.
// Phase 2 adds brand motion tokens on top of these.
export type Bezier = [number, number, number, number];
export type ResolvedEase = Bezier | "linear" | "hold";

export const NAMED_EASES = {
  linear: "linear",
  hold: "hold",
  ease: [0.25, 0.1, 0.25, 1],
  easeIn: [0.42, 0, 1, 1],
  easeOut: [0, 0, 0.58, 1],
  easeInOut: [0.42, 0, 0.58, 1],
  easeInCubic: [0.32, 0, 0.67, 0],
  easeOutCubic: [0.33, 1, 0.68, 1],
  easeInOutCubic: [0.65, 0, 0.35, 1],
  easeOutQuint: [0.22, 1, 0.36, 1],
  easeInOutQuint: [0.83, 0, 0.17, 1],
  easeOutExpo: [0.16, 1, 0.3, 1],
  easeInOutExpo: [0.87, 0, 0.13, 1],
  easeOutBack: [0.34, 1.56, 0.64, 1],
  easeInBack: [0.36, 0, 0.66, -0.56],
} as const satisfies Record<string, ResolvedEase>;

export type EaseName = keyof typeof NAMED_EASES;
export const EASE_NAMES = Object.keys(NAMED_EASES) as [EaseName, ...EaseName[]];
export const DEFAULT_EASE: EaseName = "easeInOut";

export function resolveEase(e: EaseName | Bezier | undefined, fallback: EaseName | Bezier = DEFAULT_EASE): ResolvedEase {
  const v = e ?? fallback;
  if (typeof v === "string") {
    const named = NAMED_EASES[v];
    return typeof named === "string" ? named : [...named];
  }
  return v;
}
