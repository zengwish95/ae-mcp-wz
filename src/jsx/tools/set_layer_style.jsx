// Layer styles can't be added with addProperty: their properties exist but stay hidden until the style
// is applied with its Layer > Layer Styles menu command, which acts on the selected layers of the active
// comp. So: open the comp, select only this layer, run the command, then restore the selection.
// (Spike 2026-11-10: the command runs fine inside the ae-motion undo group; one Undo reverts it all.)
var comp = AEM.comp(ARGS.compId);
var layer = AEM.layer(comp, ARGS.layerId);
var styles = AEM.isAV(layer) ? layer.property("ADBE Layer Styles") : null;
if (!styles) AEM.fail("invalid_argument", "Layer \"" + layer.name + "\" is a " + AEM.layerType(layer) + " layer, which can't have layer styles.");

function styleGroup() {
  return AEM.layer(comp, ARGS.layerId).property("ADBE Layer Styles").property(ARGS.matchName);
}

var applied = false;
if (!styleGroup().canSetEnabled && ARGS.enabled !== false) {
  if (layer.locked) AEM.fail("invalid_argument", "Layer \"" + layer.name + "\" is locked. Unlock it first (set_properties layer.locked: false).");
  var selected = [];
  for (var i = 1; i <= comp.numLayers; i++) {
    if (comp.layer(i).selected) selected.push(comp.layer(i).id);
    comp.layer(i).selected = false;
  }
  comp.openInViewer();
  layer.selected = true;
  app.executeCommand(ARGS.command);
  for (var j = 1; j <= comp.numLayers; j++) comp.layer(j).selected = AEM.has(selected, comp.layer(j).id);
  if (!styleGroup().canSetEnabled) AEM.fail("script_error", "After Effects didn't apply " + ARGS.styleName + " to \"" + layer.name + "\". Ask the user to apply it with Layer > Layer Styles > " + ARGS.styleName + ".");
  applied = true;
}

var g = styleGroup();
if (g.canSetEnabled && ARGS.enabled !== undefined) g.enabled = ARGS.enabled;

// Settings by match name ("outerGlow/blur"), its last part ("blur") or display name ("Size", "blend mode").
function squash(s) {
  return String(s).toLowerCase().replace(/[\s_-]/g, "");
}
function findSetting(name) {
  var prefix = ARGS.matchName.split("/")[0] + "/";
  var want = squash(name);
  for (var k = 1; k <= g.numProperties; k++) {
    var q = g.property(k);
    if (q.matchName === name || q.matchName === prefix + name || squash(q.name) === want) return q;
  }
  return null;
}
function listSettings() {
  var o = [];
  for (var k = 1; k <= g.numProperties; k++) {
    var q = g.property(k);
    if (q.propertyType === PropertyType.PROPERTY && q.propertyValueType !== PropertyValueType.NO_VALUE) o.push({ name: q.name, matchName: q.matchName, value: AEM.value(q) });
  }
  return o;
}
var settings = ARGS.settings || [];
if (settings.length && !g.canSetEnabled) AEM.fail("invalid_argument", ARGS.styleName + " isn't applied to \"" + layer.name + "\", so its settings can't be changed. Call set_layer_style without enabled: false first.");
for (var n = 0; n < settings.length; n++) {
  var q = findSetting(settings[n].name);
  if (!q || q.propertyType !== PropertyType.PROPERTY) AEM.fail("not_found", ARGS.styleName + " has no setting \"" + settings[n].name + "\". Its settings are listed in the error detail.", { settings: listSettings() });
  if (q.propertyValueType === PropertyValueType.NO_VALUE) AEM.fail("invalid_argument", "\"" + q.name + "\" can't be set by script (After Effects doesn't expose it).");
  AEM.setStatic(q, settings[n].value);
}

return {
  layerId: layer.id,
  style: { name: g.name, matchName: g.matchName, applied: g.canSetEnabled, enabled: g.canSetEnabled ? g.enabled : false, justApplied: applied },
  path: AEM.pathOf(g),
  settings: g.canSetEnabled ? listSettings() : []
};
