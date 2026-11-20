// Removes keyframes from one property: all of them, those in a time range, or those at given times.
// Keys go by index from last to first, so nothing is skipped and there is no open-ended loop.
var comp = AEM.comp(ARGS.compId);
var layer = AEM.layer(comp, ARGS.layerId);
var p = AEM.property(layer, ARGS.property);
var half = comp.frameDuration / 2;

function selected(t) {
  if (ARGS.all) return true;
  if (ARGS.times) {
    for (var i = 0; i < ARGS.times.length; i++) if (Math.abs(ARGS.times[i] - t) < half) return true;
    return false;
  }
  var from = ARGS.from === undefined ? -1e9 : ARGS.from;
  var to = ARGS.to === undefined ? 1e9 : ARGS.to;
  return t >= from - AEM.TIME_EPS && t <= to + AEM.TIME_EPS;
}

var doomed = [];
for (var k = 1; k <= p.numKeys; k++) if (selected(p.keyTime(k))) doomed.push(k);
var isRemap = p.matchName === "ADBE Time Remapping";
if (isRemap && doomed.length && doomed.length === p.numKeys) {
  AEM.fail("invalid_argument", "Removing every Time Remap keyframe turns Time Remap off. Keep at least one, or turn Time Remap off with set_properties (layer.timeRemapEnabled: false).");
}
var removed = [];
for (var d = doomed.length - 1; d >= 0; d--) {
  removed.unshift(AEM.round(p.keyTime(doomed[d])));
  p.removeKey(doomed[d]);
}
var warnings = [];
if (!removed.length) warnings.push("No keyframes on \"" + p.name + "\" matched, so nothing was removed.");
if (p.numKeys === 0 && p.canSetExpression && p.expression === "") warnings.push("\"" + p.name + "\" has no keyframes left; it now holds the value it had at the current time.");
return { property: p.name, path: AEM.pathOf(p), removed: removed, numKeys: p.numKeys, keyframes: AEM.keyframes(p, 50), warnings: warnings };
