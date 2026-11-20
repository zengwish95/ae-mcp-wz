// Removes effects from one layer. Every reference is resolved before anything is removed, then the
// effects go by index from last to first (indexes shift on removal; removed objects are never touched).
var comp = AEM.comp(ARGS.compId);
var layer = AEM.layer(comp, ARGS.layerId);
var parade = layer.property("ADBE Effect Parade");
if (!parade || parade.numProperties === 0) AEM.fail("not_found", "Layer \"" + layer.name + "\" has no effects.");

function listing() {
  var all = [];
  for (var i = 1; i <= parade.numProperties; i++) all.push({ index: i, name: parade.property(i).name, matchName: parade.property(i).matchName });
  return all;
}

var picked = [];
for (var r = 0; r < ARGS.effects.length; r++) {
  var ref = ARGS.effects[r];
  var hits = [];
  for (var k = 1; k <= parade.numProperties; k++) {
    var e = parade.property(k);
    if (typeof ref === "number" ? k === ref : e.name === ref || e.matchName === ref) hits.push(k);
  }
  if (!hits.length) AEM.fail("not_found", "Layer \"" + layer.name + "\" has no effect " + (typeof ref === "number" ? "at index " + ref : "\"" + ref + "\"") + ". Its effects are listed in the error detail.", { effects: listing() });
  // A match name (e.g. two Gaussian Blurs) can be ambiguous; removing all of them would be a surprise.
  if (hits.length > 1) AEM.fail("invalid_argument", "\"" + ref + "\" matches " + hits.length + " effects on layer \"" + layer.name + "\". Use the effect's index or its own name (both in the error detail).", { effects: listing() });
  if (!AEM.has(picked, hits[0])) picked.push(hits[0]);
}
picked.sort(function (a, b) { return b - a; });

var removed = [];
for (var d = 0; d < picked.length; d++) {
  var fx = parade.property(picked[d]);
  removed.unshift({ index: picked[d], name: fx.name, matchName: fx.matchName });
  fx.remove();
}

// Expressions that name a removed effect will now error. Look through the comp's expressions for them.
var warnings = [];
var broken = [];
function walk(g, l) {
  for (var i = 1; i <= g.numProperties && broken.length < 20; i++) {
    var p = g.property(i);
    if (p.propertyType === PropertyType.PROPERTY) {
      if (p.canSetExpression && p.expression !== "") {
        for (var x = 0; x < removed.length; x++) {
          if (p.expression.indexOf("\"" + removed[x].name + "\"") >= 0 || p.expression.indexOf("'" + removed[x].name + "'") >= 0) {
            broken.push({ layerId: l.id, layer: l.name, property: p.name, path: AEM.pathOf(p), effect: removed[x].name });
            break;
          }
        }
      }
    } else {
      walk(p, l);
    }
  }
}
for (var li = 1; li <= comp.numLayers; li++) walk(comp.layer(li), comp.layer(li));
if (broken.length) warnings.push(broken.length + " expression(s) in this comp mention a removed effect by name and may now error; see referencingExpressions. Fix them with set_expression, or Edit > Undo this step.");

return { layerId: layer.id, removed: removed, remaining: listing(), referencingExpressions: broken, warnings: warnings };
