// Each keyframe's `ease` shapes the motion from that keyframe to the next one.
var comp = AEM.comp(ARGS.compId);
var layer = AEM.layer(comp, ARGS.layerId);
var out = [];
var warnings = [];
for (var t = 0; t < ARGS.tracks.length; t++) {
  var track = ARGS.tracks[t];
  var p = AEM.property(layer, track.property);
  if (!p.canVaryOverTime) AEM.fail("invalid_argument", "\"" + p.name + "\" can't be animated.");
  // Replace keeps one old key until the new ones exist: emptying Time Remap would switch it off.
  var survivor = track.replace ? AEM.clearKeysKeepOne(p) : null;
  var kfs = track.keyframes; // sorted by time on the server
  var times = [];
  for (var i = 0; i < kfs.length; i++) {
    p.setValueAtTime(kfs[i].time, AEM.toValue(p, kfs[i].value));
    times.push(kfs[i].time);
  }
  AEM.dropSurvivor(p, survivor, times);
  // Check keyframe details now that the keys exist (first/last and dimensions are known).
  for (var c = 0; c < kfs.length; c++) if (kfs[c].details) AEM.checkKeyDetails(p, p.nearestKeyIndex(kfs[c].time), kfs[c].details);
  for (var j = 0; j + 1 < kfs.length; j++) {
    AEM.applyEase(p, p.nearestKeyIndex(kfs[j].time), p.nearestKeyIndex(kfs[j + 1].time), kfs[j].ease);
  }
  // Details win over the eases; roving goes last because it moves key times (indexes stay).
  var idx = [];
  for (var d = 0; d < kfs.length; d++) idx.push(p.nearestKeyIndex(kfs[d].time));
  for (var e = 0; e < kfs.length; e++) if (kfs[e].details) AEM.applyKeyDetails(p, idx[e], kfs[e].details);
  for (var r = 0; r < kfs.length; r++) if (kfs[r].details) AEM.applyRoving(p, idx[r], kfs[r].details);
  if (p.canSetExpression && p.expressionEnabled && p.expression !== "") warnings.push("\"" + p.name + "\" has an expression, which overrides its keyframes.");
  out.push({ property: p.name, path: AEM.pathOf(p), numKeys: p.numKeys, keyframes: AEM.keyframes(p, 50) });
}
return { layerId: layer.id, tracks: out, warnings: warnings };
