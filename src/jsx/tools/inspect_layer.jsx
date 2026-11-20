var comp = AEM.comp(ARGS.compId);
var layer = AEM.layer(comp, ARGS.layerId);
var time = ARGS.time === undefined ? comp.time : ARGS.time;
var tree = AEM.describe(layer, { onlyModified: ARGS.onlyModified, maxDepth: ARGS.maxDepth, keyframes: ARGS.keyframes, time: time, maxNodes: 400 });
return { layer: AEM.summarizeLayer(layer, time, { animated: false }), time: AEM.round(time), properties: tree.properties, truncated: tree.truncated };
