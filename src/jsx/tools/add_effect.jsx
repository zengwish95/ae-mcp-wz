var comp = AEM.comp(ARGS.compId);
var layer = AEM.layer(comp, ARGS.layerId);
var wanted = String(ARGS.effect);
var parade = layer.property("ADBE Effect Parade");
if (!parade) AEM.fail("invalid_argument", "Layer \"" + layer.name + "\" can't have effects.");
// canAddProperty takes a display name or match name and is instant. Only scan app.effects (read once:
// each app.effects access rebuilds the whole list) to make suggestions.
if (!parade.canAddProperty(wanted)) {
  var list = app.effects;
  var words = wanted.toLowerCase().split(/\s+/);
  var suggestions = [];
  for (var j = 0; j < list.length && suggestions.length < 10; j++) {
    var cand = list[j];
    var hay = (cand.displayName + " " + cand.matchName + " " + cand.category).toLowerCase();
    for (var w = 0; w < words.length; w++) {
      if (words[w].length > 2 && hay.indexOf(words[w].substr(0, 4)) >= 0) {
        suggestions.push({ displayName: cand.displayName, matchName: cand.matchName, category: cand.category });
        break;
      }
    }
  }
  AEM.fail("not_found", "No effect called \"" + wanted + "\" can be added to layer \"" + layer.name + "\".", { suggestions: suggestions });
}
var fx = parade.addProperty(wanted);
if (ARGS.name !== undefined) fx.name = ARGS.name;
var requested = ARGS.parameters || [];
for (var k = 0; k < requested.length; k++) {
  var pp = null;
  try { pp = fx.property(requested[k].name); } catch (e2) {}
  if (!pp || pp.propertyType !== PropertyType.PROPERTY) AEM.fail("not_found", "\"" + fx.name + "\" has no parameter \"" + requested[k].name + "\". Its parameters are listed in the error detail.", { parameters: AEM.describe(fx, { onlyModified: false, maxDepth: 2 }).properties });
  AEM.setStatic(pp, requested[k].value);
}
var paramList = [];
for (var n = 1; n <= fx.numProperties; n++) {
  var q = fx.property(n);
  if (q.propertyType === PropertyType.PROPERTY && q.propertyValueType !== PropertyValueType.NO_VALUE) paramList.push({ name: q.name, matchName: q.matchName, value: AEM.value(q) });
}
return { effect: { index: fx.propertyIndex, name: fx.name, matchName: fx.matchName }, path: AEM.pathOf(fx), parameters: paramList };
