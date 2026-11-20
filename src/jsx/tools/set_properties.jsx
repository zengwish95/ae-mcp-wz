var a = ARGS;
var comp = AEM.comp(a.compId);
var warnings = [];

if (a.comp) {
  var c = a.comp;
  if (c.name !== undefined) comp.name = c.name;
  if (c.width !== undefined) comp.width = c.width;
  if (c.height !== undefined) comp.height = c.height;
  if (c.duration !== undefined) comp.duration = c.duration;
  if (c.frameRate !== undefined) comp.frameRate = c.frameRate;
  if (c.bgColor !== undefined) comp.bgColor = AEM.color(c.bgColor).slice(0, 3);
  if (c.workAreaStart !== undefined) comp.workAreaStart = c.workAreaStart;
  if (c.workAreaDuration !== undefined) comp.workAreaDuration = c.workAreaDuration;
  if (c.motionBlur !== undefined) comp.motionBlur = c.motionBlur;
  if (c.frameBlending !== undefined) comp.frameBlending = c.frameBlending;
  if (c.hideShyLayers !== undefined) comp.hideShyLayers = c.hideShyLayers;
  if (c.shutterAngle !== undefined) comp.shutterAngle = c.shutterAngle;
  if (c.shutterPhase !== undefined) comp.shutterPhase = c.shutterPhase;
  if (c.motionBlurSamplesPerFrame !== undefined) comp.motionBlurSamplesPerFrame = c.motionBlurSamplesPerFrame;
  if (c.motionBlurAdaptiveSampleLimit !== undefined) comp.motionBlurAdaptiveSampleLimit = c.motionBlurAdaptiveSampleLimit;
  if (c.preserveNestedFrameRate !== undefined) comp.preserveNestedFrameRate = c.preserveNestedFrameRate;
  if (c.preserveNestedResolution !== undefined) comp.preserveNestedResolution = c.preserveNestedResolution;
}

if (a.layerId === undefined) {
  if (a.layer || a.transform || a.text || a.properties) AEM.fail("invalid_argument", "layer, transform, text and properties need a layerId.");
  return { comp: AEM.summarizeItem(comp), warnings: warnings };
}

var layer = AEM.layer(comp, a.layerId);
var L = a.layer || {};
// Check up front what AE would otherwise reject by stopping the whole script (no catch runs for that).
var isAV = AEM.isAV(layer);
function needAV(what) {
  if (!isAV) AEM.fail("invalid_argument", "Layer \"" + layer.name + "\" is a " + AEM.layerType(layer) + " layer, which has no " + what + ".");
}
if (L.threeD !== undefined) needAV("3D switch");
if (L.blendMode !== undefined) needAV("blend mode");
if (L.trackMatte !== undefined) needAV("track matte");
var AV_SWITCHES = { preserveTransparency: "Preserve Underlying Transparency switch", motionBlur: "motion blur switch", adjustmentLayer: "adjustment switch", guideLayer: "guide layer setting", collapseTransformation: "collapse transformations switch", effectsActive: "fx switch", quality: "quality switch", samplingQuality: "sampling quality", frameBlending: "frame blending switch", audioEnabled: "audio switch" };
for (var sw in AV_SWITCHES) if (L[sw] !== undefined) needAV(AV_SWITCHES[sw]);
var QUALITY = { best: LayerQuality.BEST, draft: LayerQuality.DRAFT, wireframe: LayerQuality.WIREFRAME };
var SAMPLING = { bilinear: LayerSamplingQuality.BILINEAR, bicubic: LayerSamplingQuality.BICUBIC };
var FRAME_BLEND = { none: FrameBlendingType.NO_FRAME_BLEND, frameMix: FrameBlendingType.FRAME_MIX, pixelMotion: FrameBlendingType.PIXEL_MOTION };
var ORIENT = { off: AutoOrientType.NO_AUTO_ORIENT, alongPath: AutoOrientType.ALONG_PATH, towardsCamera: AutoOrientType.CAMERA_OR_POINT_OF_INTEREST, charactersTowardCamera: AutoOrientType.CHARACTERS_TOWARD_CAMERA };
if (L.collapseTransformation !== undefined && !layer.canSetCollapseTransformation) AEM.fail("invalid_argument", "Layer \"" + layer.name + "\" (" + AEM.layerType(layer) + ") can't change its collapse transformations / continuously rasterize switch. Shape and text layers are always continuously rasterized; precomp and vector footage layers can switch it.");
if (L.audioEnabled !== undefined && !layer.hasAudio) AEM.fail("invalid_argument", "Layer \"" + layer.name + "\" has no audio.");
if (L.frameBlending !== undefined && L.frameBlending !== "none" && !(layer.source && layer.hasVideo && layer.source.duration > 0)) AEM.fail("invalid_argument", "Layer \"" + layer.name + "\" (" + AEM.layerType(layer) + ") can't frame-blend. Only precomp and video footage layers can.");
if (L.threeDPerChar !== undefined && !(layer instanceof TextLayer)) AEM.fail("invalid_argument", "Per-character 3D is for text layers; \"" + layer.name + "\" is a " + AEM.layerType(layer) + " layer.");
if (L.autoOrient === "charactersTowardCamera" && !(layer instanceof TextLayer && (L.threeDPerChar === true || (L.threeDPerChar === undefined && layer.threeDPerChar)))) AEM.fail("invalid_argument", "autoOrient \"charactersTowardCamera\" needs a text layer with per-character 3D (layer.threeDPerChar: true).");
if (L.autoOrient === "towardsCamera" && !(layer instanceof CameraLayer || layer instanceof LightLayer || L.threeD === true || (L.threeD === undefined && isAV && layer.threeDLayer))) AEM.fail("invalid_argument", "autoOrient \"towardsCamera\" needs a 3D layer (or a camera or light).");
if (L.timeRemapEnabled === true && !layer.canSetTimeRemapEnabled) {
  AEM.fail("invalid_argument", "Layer \"" + layer.name + "\" (" + AEM.layerType(layer) + ") can't be time-remapped. Only precomp and footage layers can.");
}
if (L.parentLayerId !== undefined && L.parentLayerId !== null) {
  if (L.parentLayerId === layer.id) AEM.fail("invalid_argument", "A layer can't be its own parent.");
  for (var anc = AEM.layer(comp, L.parentLayerId); anc; anc = anc.parent) {
    if (anc.id === layer.id) AEM.fail("invalid_argument", "Layer " + L.parentLayerId + " is a child of \"" + layer.name + "\", so it can't be its parent.");
  }
}
if (L.name !== undefined) layer.name = L.name;
if (L.timeRemapEnabled !== undefined) layer.timeRemapEnabled = L.timeRemapEnabled;
if (L.stretch !== undefined) layer.stretch = L.stretch;
if (L.startTime !== undefined) layer.startTime = L.startTime;
// Moving later: set the out point first so the in point never passes it.
if (L.inPoint !== undefined && L.outPoint !== undefined && L.inPoint >= layer.outPoint) {
  layer.outPoint = L.outPoint;
  layer.inPoint = L.inPoint;
} else {
  if (L.inPoint !== undefined) layer.inPoint = L.inPoint;
  if (L.outPoint !== undefined) layer.outPoint = L.outPoint;
}
if (L.enabled !== undefined) layer.enabled = L.enabled;
if (L.solo !== undefined) layer.solo = L.solo;
if (L.shy !== undefined) layer.shy = L.shy;
if (L.label !== undefined) layer.label = L.label;
if (L.threeD !== undefined) layer.threeDLayer = L.threeD;
if (L.threeDPerChar !== undefined) layer.threeDPerChar = L.threeDPerChar;
if (L.autoOrient !== undefined) layer.autoOrient = ORIENT[L.autoOrient];
if (L.preserveTransparency !== undefined) layer.preserveTransparency = L.preserveTransparency;
if (L.motionBlur !== undefined) layer.motionBlur = L.motionBlur;
if (L.adjustmentLayer !== undefined) layer.adjustmentLayer = L.adjustmentLayer;
if (L.guideLayer !== undefined) layer.guideLayer = L.guideLayer;
if (L.collapseTransformation !== undefined) layer.collapseTransformation = L.collapseTransformation;
if (L.effectsActive !== undefined) layer.effectsActive = L.effectsActive;
if (L.quality !== undefined) layer.quality = QUALITY[L.quality];
if (L.samplingQuality !== undefined) layer.samplingQuality = SAMPLING[L.samplingQuality];
if (L.frameBlending !== undefined) layer.frameBlendingType = FRAME_BLEND[L.frameBlending];
if (L.audioEnabled !== undefined) layer.audioEnabled = L.audioEnabled;
if (L.blendMode !== undefined) layer.blendingMode = AEM.blendValue(L.blendMode);
if (L.parentLayerId !== undefined) {
  var par = L.parentLayerId === null ? null : AEM.layer(comp, L.parentLayerId);
  if (L.parentWithJump) layer.setParentWithJump(par);
  else layer.parent = par;
}
if (L.trackMatte !== undefined) {
  if (L.trackMatte === null) layer.removeTrackMatte();
  else layer.setTrackMatte(AEM.layer(comp, L.trackMatte.layerId), AEM.matteValue(L.trackMatte.type));
}
if (L.moveTo !== undefined) {
  var m = L.moveTo;
  if (m.position === "top") layer.moveToBeginning();
  else if (m.position === "bottom") layer.moveToEnd();
  else if (m.beforeLayerId !== undefined) layer.moveBefore(AEM.layer(comp, m.beforeLayerId));
  else if (m.afterLayerId !== undefined) layer.moveAfter(AEM.layer(comp, m.afterLayerId));
}

if (a.transform) {
  for (var k in a.transform) AEM.setStatic(AEM.property(layer, k), a.transform[k]);
}

if (a.text) {
  if (!(layer instanceof TextLayer)) AEM.fail("invalid_argument", "Layer \"" + layer.name + "\" is not a text layer.");
  var tp = AEM.property(layer, "sourceText");
  if (tp.numKeys > 0) AEM.fail("animated", "This text layer's Source Text has keyframes; it can't take a single value.");
  tp.setValue(AEM.applyText(tp.value, a.text));
  var fw = AEM.fontWarning(a.text.font);
  if (fw) warnings.push(fw);
}

if (a.properties) {
  for (var i = 0; i < a.properties.length; i++) {
    var p = AEM.property(layer, a.properties[i].path);
    AEM.setStatic(p, a.properties[i].value);
    if (p.canSetExpression && p.expressionEnabled && p.expression !== "") warnings.push("\"" + p.name + "\" has an expression, which overrides the value you set.");
  }
}

// Locking last: a locked layer can't be changed.
if (L.locked !== undefined) layer.locked = L.locked;

return { layer: AEM.summarizeLayer(layer, comp.time, { animated: false }), warnings: warnings };
