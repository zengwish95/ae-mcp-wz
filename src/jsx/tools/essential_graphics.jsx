// Essential Graphics controls are numbered 1..motionGraphicsTemplateControllerCount. A new control
// doesn't go last (in AE 26.5 it went to index 1), so its index is found by comparing the names
// before and after. Scripts can add and rename controls but not remove or reorder them.
var comp = AEM.comp(ARGS.compId);
var warnings = [];

// Check everything before changing anything.
var props = [];
for (var i = 0; i < ARGS.add.length; i++) {
  var a = ARGS.add[i];
  var layer = AEM.layer(comp, a.layerId);
  var p = AEM.property(layer, a.property);
  var ok = false;
  try { ok = p.canAddToMotionGraphicsTemplate(comp); } catch (e) { ok = false; }
  if (!ok) AEM.fail("invalid_argument", "\"" + p.name + "\" on \"" + layer.name + "\" can't be added to Essential Graphics. After Effects allows Source Text, transform values, and effect parameters such as sliders, colors, checkboxes, angles, points and dropdowns.");
  props.push({ layerId: layer.id, path: AEM.pathOf(p) });
}
var count = comp.motionGraphicsTemplateControllerCount;
for (var r = 0; r < ARGS.rename.length; r++) {
  if (ARGS.rename[r].index > count + ARGS.add.length) AEM.fail("not_found", "Comp \"" + comp.name + "\" has " + count + " Essential Graphics controls; there is no control " + ARGS.rename[r].index + ".");
}

if (ARGS.templateName !== undefined) comp.motionGraphicsTemplateName = ARGS.templateName;
function controlNames() {
  var o = [];
  for (var c = 1; c <= comp.motionGraphicsTemplateControllerCount; c++) o.push(comp.getMotionGraphicsTemplateControllerName(c));
  return o;
}
var added = [];
for (var j = 0; j < ARGS.add.length; j++) {
  var q = AEM.property(AEM.layer(comp, props[j].layerId), props[j].path);
  var before = controlNames();
  if (ARGS.add[j].name !== undefined) q.addToMotionGraphicsTemplateAs(comp, ARGS.add[j].name);
  else q.addToMotionGraphicsTemplate(comp);
  var after = controlNames();
  if (after.length === before.length) {
    warnings.push("\"" + q.name + "\" was not added (it may already be a control).");
    continue;
  }
  var at = 0;
  while (at < before.length && before[at] === after[at]) at++;
  for (var u = 0; u < added.length; u++) if (added[u].index >= at + 1) added[u].index++;
  added.push({ index: at + 1, name: after[at], layerId: props[j].layerId, path: props[j].path });
}
for (var k = 0; k < ARGS.rename.length; k++) comp.setMotionGraphicsControllerName(ARGS.rename[k].index, ARGS.rename[k].name);
if (ARGS.open) comp.openInEssentialGraphics();

var controls = [];
for (var c = 1; c <= comp.motionGraphicsTemplateControllerCount; c++) controls.push({ index: c, name: comp.getMotionGraphicsTemplateControllerName(c) });
return { compId: comp.id, templateName: comp.motionGraphicsTemplateName, controls: controls, added: added, warnings: warnings };
