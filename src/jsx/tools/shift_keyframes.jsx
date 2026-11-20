// Moves keyframes in time, keeping everything else about them (value, interpolation, eases,
// continuity, spatial tangents, roving). new time = pivot + (time - pivot) * scale + offset.
// Every check runs before the first change, and the property is never emptied (see AEM.clearKeysKeepOne).
var comp = AEM.comp(ARGS.compId);
var layer = AEM.layer(comp, ARGS.layerId);
var offset = ARGS.offset || 0;
var scale = ARGS.scale === undefined ? 1 : ARGS.scale;
var pivot = ARGS.pivot || 0;
var from = ARGS.from === undefined ? -1e9 : ARGS.from;
var to = ARGS.to === undefined ? 1e9 : ARGS.to;
var MAX_KEYS = 2000;

function mapTime(t) {
  return pivot + (t - pivot) * scale + offset;
}

// The properties to touch: the ones named, or every keyed property on the layer.
var props = [];
if (ARGS.properties) {
  for (var i = 0; i < ARGS.properties.length; i++) {
    var p0 = AEM.property(layer, ARGS.properties[i]);
    if (p0.numKeys > 0) props.push(p0);
  }
} else {
  (function walk(g) {
    for (var j = 1; j <= g.numProperties; j++) {
      var q = g.property(j);
      if (q.propertyType === PropertyType.PROPERTY) {
        if (q.numKeys > 0 && q.propertyValueType !== PropertyValueType.MARKER) props.push(q);
      } else {
        walk(q);
      }
    }
  })(layer);
}

// Plan every property first; refuse collisions before changing anything.
var plans = [];
var half = comp.frameDuration / 2;
for (var pi = 0; pi < props.length; pi++) {
  var p = props[pi];
  if (p.numKeys > MAX_KEYS) AEM.fail("invalid_argument", "\"" + p.name + "\" has " + p.numKeys + " keyframes; shift_keyframes handles at most " + MAX_KEYS + " per property.");
  var keys = [];
  var moved = 0;
  for (var k = 1; k <= p.numKeys; k++) {
    var d = AEM.grabKey(p, k);
    d.nt = d.t >= from - AEM.TIME_EPS && d.t <= to + AEM.TIME_EPS ? mapTime(d.t) : d.t;
    if (!AEM.sameTime(d.nt, d.t)) moved++;
    keys.push(d);
  }
  if (!moved) continue;
  var sorted = keys.slice(0).sort(function (x, y) { return x.nt - y.nt; });
  for (var s = 1; s < sorted.length; s++) {
    if (sorted[s].nt - sorted[s - 1].nt < half) {
      AEM.fail("invalid_argument", "On \"" + p.name + "\", keyframes from " + AEM.round(sorted[s - 1].t) + " s and " + AEM.round(sorted[s].t) + " s would land on the same frame (" + AEM.round(sorted[s].nt) + " s). Narrow the range (from/to) or change the offset/scale.", { path: AEM.pathOf(p) });
    }
  }
  plans.push({ p: p, keys: keys, moved: moved });
}

var out = [];
var warnings = [];
for (var n = 0; n < plans.length; n++) {
  var pl = plans[n];
  var pr = pl.p;
  var survivor = AEM.clearKeysKeepOne(pr);
  var newTimes = [];
  for (var a = 0; a < pl.keys.length; a++) {
    pr.setValueAtTime(pl.keys[a].nt, pl.keys[a].v);
    newTimes.push(pl.keys[a].nt);
  }
  // The survivor sat at old key 1's time; drop it unless some key moved onto that time.
  var onSurvivor = false;
  for (var b = 0; b < newTimes.length; b++) if (AEM.sameTime(newTimes[b], survivor)) onSurvivor = true;
  if (!onSurvivor) {
    var si = pr.nearestKeyIndex(survivor);
    if (pr.numKeys > pl.keys.length && AEM.sameTime(pr.keyTime(si), survivor)) pr.removeKey(si);
  }
  // Eases depend on neighbours, so attributes go on once every key exists.
  var refused = 0;
  for (var c = 0; c < pl.keys.length; c++) refused += AEM.applyKey(pr, pr.nearestKeyIndex(pl.keys[c].nt), pl.keys[c]);
  for (var r = 0; r < pl.keys.length; r++) {
    if (pl.keys[r].rv) {
      try { pr.setRovingAtKey(pr.nearestKeyIndex(pl.keys[r].nt), true); } catch (e) { refused++; }
    }
  }
  if (refused) warnings.push("\"" + pr.name + "\": After Effects refused " + refused + " keyframe setting(s) (eases or tangents); check its keyframes with inspect_layer.");
  if (pr.numKeys !== pl.keys.length) warnings.push("\"" + pr.name + "\" now has " + pr.numKeys + " keyframes, expected " + pl.keys.length + ".");
  out.push({ property: pr.name, path: AEM.pathOf(pr), moved: pl.moved, numKeys: pr.numKeys, keyframes: AEM.keyframes(pr, 50) });
}
if (layer.timeRemapEnabled === false) {
  for (var z = 0; z < plans.length; z++) if (plans[z].p.matchName === "ADBE Time Remapping") warnings.push("Time Remap is off after the shift; turn it back on with set_properties.");
}
return { layerId: layer.id, properties: out, warnings: warnings };
