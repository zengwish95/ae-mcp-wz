// Keys are found first (by index, or the key within half a frame of the time), every change is
// checked, then values, details and finally roving (which moves key times) are applied.
var comp = AEM.comp(ARGS.compId);
var layer = AEM.layer(comp, ARGS.layerId);
var p = AEM.property(layer, ARGS.property);
if (p.numKeys === 0) AEM.fail("not_found", "\"" + p.name + "\" has no keyframes. Use animate to add some.");
var idx = [];
for (var i = 0; i < ARGS.keys.length; i++) {
  var k = ARGS.keys[i];
  var n;
  if (k.index !== undefined) {
    if (k.index > p.numKeys) AEM.fail("not_found", "\"" + p.name + "\" has " + p.numKeys + " keyframes; there is no keyframe " + k.index + ".");
    n = k.index;
  } else {
    n = p.nearestKeyIndex(k.time);
    if (Math.abs(p.keyTime(n) - k.time) > comp.frameDuration / 2) {
      var times = [];
      for (var t = 1; t <= Math.min(p.numKeys, 20); t++) times.push(AEM.round(p.keyTime(t)));
      AEM.fail("not_found", "\"" + p.name + "\" has no keyframe at " + k.time + " s. Its keys are at " + times.join(", ") + " s.");
    }
  }
  if (AEM.has(idx, n)) AEM.fail("invalid_argument", "Two entries in keys pick the keyframe at " + AEM.round(p.keyTime(n)) + " s.");
  idx.push(n);
  AEM.checkKeyDetails(p, n, k.details);
}
for (var v = 0; v < ARGS.keys.length; v++) if (ARGS.keys[v].value !== undefined) p.setValueAtKey(idx[v], AEM.toValue(p, ARGS.keys[v].value));
for (var d = 0; d < ARGS.keys.length; d++) AEM.applyKeyDetails(p, idx[d], ARGS.keys[d].details);
for (var r = 0; r < ARGS.keys.length; r++) AEM.applyRoving(p, idx[r], ARGS.keys[r].details);
var warnings = [];
if (p.canSetExpression && p.expressionEnabled && p.expression !== "") warnings.push("\"" + p.name + "\" has an expression, which overrides its keyframes.");
return { property: p.name, path: AEM.pathOf(p), numKeys: p.numKeys, keyframes: AEM.keyframes(p, 50), warnings: warnings };
