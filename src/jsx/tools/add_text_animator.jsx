// Adding to a group invalidates references to its earlier children (as for shape contents), so the
// animator and its selectors are found again by index for every step, and values are set last.
var comp = AEM.comp(ARGS.compId);
var layer = AEM.layer(comp, ARGS.layerId);
if (!(layer instanceof TextLayer)) AEM.fail("invalid_argument", "Layer \"" + layer.name + "\" is a " + AEM.layerType(layer) + " layer; text animators need a text layer.");
var warnings = [];

function animators() {
  return AEM.layer(comp, ARGS.layerId).property("ADBE Text Properties").property("ADBE Text Animators");
}
var ai;
if (ARGS.animator === null) {
  ai = animators().addProperty("ADBE Text Animator").propertyIndex;
  if (ARGS.name !== undefined) animators().property(ai).name = ARGS.name;
} else {
  var found = null;
  try { found = animators().property(ARGS.animator); } catch (e) { found = null; }
  if (!found) {
    var names = [];
    for (var n = 1; n <= animators().numProperties; n++) names.push(n + ": " + animators().property(n).name);
    AEM.fail("not_found", "Layer \"" + layer.name + "\" has no text animator " + ARGS.animator + ". Its animators: " + (names.join(", ") || "none") + ".");
  }
  ai = found.propertyIndex;
}
function anim() { return animators().property(ai); }
function props() { return anim().property("ADBE Text Animator Properties"); }
function selectors() { return anim().property("ADBE Text Selectors"); }

// Every animator property already exists but stays hidden (and refuses values) until it is added.
// Adding one that is already shown changes nothing (spike 2026-11-19), so always add.
for (var i = 0; i < ARGS.properties.length; i++) {
  var mn = ARGS.properties[i].matchName;
  if (!props().canAddProperty(mn)) AEM.fail("invalid_argument", "\"" + mn + "\" isn't a text animator property. Use a match name such as \"ADBE Text Position 3D\" or \"ADBE Text Tracking Amount\".");
  props().addProperty(mn);
}
var added = [];
for (var s = 0; s < ARGS.selectors.length; s++) {
  var smn = ARGS.selectors[s].matchName;
  if (!selectors().canAddProperty(smn)) AEM.fail("invalid_argument", "Can't add \"" + smn + "\" to the animator's selectors.");
  added.push(selectors().addProperty(smn).propertyIndex);
}

// Values, now that nothing else is added.
var propOut = [];
for (var j = 0; j < ARGS.properties.length; j++) {
  var p = props().property(ARGS.properties[j].matchName);
  AEM.setStatic(p, ARGS.properties[j].value);
  propOut.push({ name: p.name, matchName: p.matchName, path: AEM.pathOf(p), value: AEM.value(p) });
}
for (var k = 0; k < ARGS.selectors.length; k++) {
  var spec = ARGS.selectors[k];
  if (spec.name !== undefined) selectors().property(added[k]).name = spec.name;
  for (var t = 0; t < spec.settings.length; t++) AEM.setStatic(AEM.property(selectors().property(added[k]), spec.settings[t].path), spec.settings[t].value);
  if (spec.expression) {
    var ep = AEM.property(selectors().property(added[k]), spec.expression.path);
    ep.expression = spec.expression.text;
    if (ep.expressionError) warnings.push("Expression selector \"" + selectors().property(added[k]).name + "\": " + ep.expressionError);
  }
}
var more = AEM.layer(comp, ARGS.layerId).property("ADBE Text Properties").property("ADBE Text More Options");
for (var m = 0; m < ARGS.moreOptions.length; m++) AEM.setStatic(AEM.property(more, ARGS.moreOptions[m].path), ARGS.moreOptions[m].value);

var selOut = [];
for (var q = 0; q < added.length; q++) selOut.push(AEM.summarizeGroup(selectors().property(added[q])));
var a = anim();
return { layerId: layer.id, animator: { name: a.name, matchName: a.matchName, index: ai, path: AEM.pathOf(a) }, properties: propOut, selectors: selOut, warnings: warnings };
