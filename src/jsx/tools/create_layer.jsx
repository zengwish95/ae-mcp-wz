var a = ARGS;
var comp = AEM.comp(a.compId);
var center = [comp.width / 2, comp.height / 2];
var warnings = [];
var layer;
var shapeItems = null;

if (a.type === "text") {
  layer = comp.layers.addText(a.text && a.text.text !== undefined ? a.text.text : "Text");
  var tp = layer.property("ADBE Text Properties").property("ADBE Text Document");
  var fields = a.text || {};
  // New text inherits AE's last-used style (the spike saw 235 px); give it a size that fits the comp.
  if (fields.fontSize === undefined) fields.fontSize = Math.round(comp.height / 12);
  if (fields.justification === undefined) fields.justification = "center";
  tp.setValue(AEM.applyText(tp.value, fields));
  var fw = AEM.fontWarning(fields.font);
  if (fw) warnings.push(fw);
} else if (a.type === "solid" || a.type === "adjustment") {
  var color = a.color !== undefined ? AEM.color(a.color).slice(0, 3) : [1, 1, 1];
  layer = comp.layers.addSolid(color, a.name || (a.type === "adjustment" ? "Adjustment Layer" : "Solid"), a.width || comp.width, a.height || comp.height, comp.pixelAspect, comp.duration);
  if (a.type === "adjustment") layer.adjustmentLayer = true;
} else if (a.type === "null") {
  layer = comp.layers.addNull(comp.duration);
} else if (a.type === "shape" && a.contents) {
  // Contents built by the server from shape items (see add_shape_content).
  layer = comp.layers.addShape();
  shapeItems = AEM.addShapeItems(layer, [], a.contents);
} else if (a.type === "shape") {
  layer = comp.layers.addShape();
  var s = a.shape || {};
  var group = layer.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group");
  group.name = s.kind === "ellipse" ? "Ellipse" : s.kind === "path" ? "Path" : "Rectangle";
  var contents = group.property("ADBE Vectors Group");
  var size = s.size || [comp.height / 4, comp.height / 4];
  var open = s.kind === "path" && s.path.closed === false;
  if (s.kind === "ellipse") {
    contents.addProperty("ADBE Vector Shape - Ellipse").property("ADBE Vector Ellipse Size").setValue(size);
  } else if (s.kind === "path") {
    var pp = contents.addProperty("ADBE Vector Shape - Group").property("ADBE Vector Shape");
    pp.setValue(AEM.toShape(s.path, true));
  } else {
    var rect = contents.addProperty("ADBE Vector Shape - Rect");
    rect.property("ADBE Vector Rect Size").setValue(size);
    if (s.roundness !== undefined) rect.property("ADBE Vector Rect Roundness").setValue(s.roundness);
  }
  // An open path is a line: stroke it (white, 4 px) and leave it unfilled unless told otherwise.
  if (open && s.strokeColor === undefined) s.strokeColor = [1, 1, 1];
  if (open && s.strokeWidth === undefined) s.strokeWidth = 4;
  if (open && s.fillColor === undefined) s.fillColor = null;
  if (s.strokeColor !== undefined) {
    var stroke = contents.addProperty("ADBE Vector Graphic - Stroke");
    stroke.property("ADBE Vector Stroke Color").setValue(AEM.toValue(stroke.property("ADBE Vector Stroke Color"), s.strokeColor));
    if (s.strokeWidth !== undefined) stroke.property("ADBE Vector Stroke Width").setValue(s.strokeWidth);
  }
  if (s.fillColor !== null) {
    var fill = contents.addProperty("ADBE Vector Graphic - Fill");
    var fc = fill.property("ADBE Vector Fill Color");
    fc.setValue(AEM.toValue(fc, s.fillColor === undefined ? [1, 1, 1] : s.fillColor));
  }
} else if (a.type === "camera") {
  layer = comp.layers.addCamera(a.name || "Camera", center);
} else if (a.type === "light") {
  layer = comp.layers.addLight(a.name || "Light", center);
  if (a.lightType !== undefined) layer.lightType = AEM.lightValue(a.lightType);
} else if (a.type === "footage") {
  // Reuse footage already imported from the same file, so repeated calls don't duplicate it.
  var src = null;
  for (var i = 1; i <= app.project.numItems; i++) {
    var it = app.project.item(i);
    if (it instanceof FootageItem && it.file && it.file.fsName === a.footagePath) { src = it; break; }
  }
  if (!src) {
    // The server checked footagePath against the import policy; refuse if File() resolves elsewhere.
    var ff = new File(a.footageUri || a.footagePath);
    if (ff.fsName !== a.footagePath) AEM.fail("invalid_argument", "After Effects resolved \"" + a.footagePath + "\" to a different file (\"" + ff.fsName + "\"), so it wasn't imported.");
    var io = new ImportOptions(ff);
    if (!io.canImportAs(ImportAsType.FOOTAGE)) AEM.fail("invalid_argument", "After Effects can't import \"" + a.footagePath + "\" as footage.");
    src = app.project.importFile(io);
  }
  layer = comp.layers.add(src);
} else {
  AEM.fail("invalid_argument", "Unknown layer type \"" + a.type + "\".");
}

if (a.name !== undefined) layer.name = a.name;
if (a.threeD !== undefined && AEM.isAV(layer)) layer.threeDLayer = a.threeD;
if (a.position !== undefined) AEM.setStatic(AEM.property(layer, "position"), a.position);
if (a.startTime !== undefined) layer.startTime = a.startTime;
if (a.inPoint !== undefined) layer.inPoint = a.inPoint;
if (a.outPoint !== undefined) layer.outPoint = a.outPoint;
if (a.parentLayerId !== undefined) layer.parent = AEM.layer(comp, a.parentLayerId);
if (a.blendMode !== undefined) layer.blendingMode = AEM.blendValue(a.blendMode);

var result = { layer: AEM.summarizeLayer(layer, comp.time, { animated: false }), warnings: warnings };
if (shapeItems) {
  result.items = shapeItems;
} else if (layer instanceof ShapeLayer) {
  // Top-level contents, so later calls can address them (add_shape_content group, animate paths).
  var rootVectors = layer.property("ADBE Root Vectors Group");
  result.contents = [];
  for (var ci = 1; ci <= rootVectors.numProperties; ci++) {
    var item = rootVectors.property(ci);
    result.contents.push({ name: item.name, matchName: item.matchName, path: AEM.pathOf(item) });
  }
}
return result;
