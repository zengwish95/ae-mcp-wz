// Re-find every target by id right before removing it: touching a removed object can crash AE.
var removed = [];
var missing = [];
if (ARGS.layerIds && ARGS.layerIds.length) {
  var comp = AEM.comp(ARGS.compId);
  for (var i = 0; i < ARGS.layerIds.length; i++) {
    var l = AEM.findLayer(comp, ARGS.layerIds[i]);
    if (!l) { missing.push({ kind: "layer", id: ARGS.layerIds[i] }); continue; }
    var info = { kind: "layer", id: l.id, name: l.name };
    l.remove();
    removed.push(info);
  }
}
if (ARGS.itemIds && ARGS.itemIds.length) {
  for (var j = 0; j < ARGS.itemIds.length; j++) {
    var it = null;
    try { it = app.project.itemByID(ARGS.itemIds[j]); } catch (e) { it = null; }
    if (!it) { missing.push({ kind: "item", id: ARGS.itemIds[j] }); continue; }
    var inf = { kind: AEM.itemType(it), id: it.id, name: it.name };
    it.remove();
    removed.push(inf);
  }
}
return { removed: removed, missing: missing };
