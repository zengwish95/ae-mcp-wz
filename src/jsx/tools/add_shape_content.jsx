// Items come from the server as { matchName, name?, settings: [{ path, value }], children? }.
var comp = AEM.comp(ARGS.compId);
var layer = AEM.layer(comp, ARGS.layerId);
var steps = ARGS.group || [];
AEM.shapeContents(layer, steps); // fails up front if the layer or group is wrong
var items = AEM.addShapeItems(layer, steps, ARGS.items);
return { layerId: layer.id, items: items, warnings: [] };
