var comp = AEM.comp(ARGS.compId);
var layer = AEM.layer(comp, ARGS.layerId);
var p = AEM.property(layer, ARGS.property);
if (!p.canSetExpression) AEM.fail("invalid_argument", "\"" + p.name + "\" can't take an expression.");
p.expression = ARGS.expression === null ? "" : ARGS.expression;
// Evaluate once so expressionError is filled in.
var value = null;
try { value = AEM.value(p, comp.time); } catch (e) {}
return {
  property: p.name,
  path: AEM.pathOf(p),
  removed: ARGS.expression === null,
  expressionEnabled: p.expressionEnabled,
  expressionError: p.expressionError ? p.expressionError : null,
  valueAtCurrentTime: value
};
