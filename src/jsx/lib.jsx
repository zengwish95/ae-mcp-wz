// ae-motion ExtendScript helpers (ES3: no let/const, arrow functions, Array#indexOf/map/forEach or Object.keys).
// Prepended to every tool body, which then runs as function (ARGS) { ... } and uses AEM.*.
// Rules learned in the spike (SPIKE.md):
//  - never touch an AE object after remove() (it can crash AE): re-find by id instead;
//  - never "" + anAEObject (throws): serialize fields explicitly;
//  - return plain data only (numbers, strings, booleans, arrays, plain objects).
var AEM = (function () {
  var A = {};

  A.fail = function (code, message, detail) {
    var e = new Error(message);
    e.aemCode = code;
    if (detail !== undefined) e.aemDetail = detail;
    throw e;
  };

  A.round = function (n) {
    return Math.round(n * 10000) / 10000;
  };

  A.num = function (v) {
    if (typeof v === "number") return A.round(v);
    if (v instanceof Array) {
      var o = [];
      for (var i = 0; i < v.length; i++) o.push(typeof v[i] === "number" ? A.round(v[i]) : v[i]);
      return o;
    }
    return v;
  };

  A.has = function (arr, x) {
    for (var i = 0; i < arr.length; i++) if (arr[i] === x) return true;
    return false;
  };

  // ---- enums <-> names ---------------------------------------------------------------------------

  function enumTable(obj, names) {
    var t = { byName: {}, byValue: {} };
    for (var i = 0; i < names.length; i++) {
      var v = obj[names[i]];
      if (v === undefined) continue;
      var n = names[i].toLowerCase();
      t.byName[n] = v;
      t.byValue[String(v)] = n;
    }
    return t;
  }

  var BLEND = enumTable(BlendingMode, ["NORMAL", "DISSOLVE", "DANCING_DISSOLVE", "DARKEN", "MULTIPLY", "COLOR_BURN", "CLASSIC_COLOR_BURN", "LINEAR_BURN", "DARKER_COLOR", "ADD", "LIGHTEN", "SCREEN", "COLOR_DODGE", "CLASSIC_COLOR_DODGE", "LINEAR_DODGE", "LIGHTER_COLOR", "OVERLAY", "SOFT_LIGHT", "HARD_LIGHT", "LINEAR_LIGHT", "VIVID_LIGHT", "PIN_LIGHT", "HARD_MIX", "DIFFERENCE", "CLASSIC_DIFFERENCE", "EXCLUSION", "SUBTRACT", "DIVIDE", "HUE", "SATURATION", "COLOR", "LUMINOSITY", "STENCIL_ALPHA", "STENCIL_LUMA", "SILHOUETE_ALPHA", "SILHOUETTE_LUMA", "ALPHA_ADD", "LUMINESCENT_PREMUL"]);
  var MATTE = enumTable(TrackMatteType, ["ALPHA", "ALPHA_INVERTED", "LUMA", "LUMA_INVERTED", "NO_TRACK_MATTE"]);
  var INTERP = enumTable(KeyframeInterpolationType, ["LINEAR", "BEZIER", "HOLD"]);
  var JUSTIFY = enumTable(ParagraphJustification, ["LEFT_JUSTIFY", "CENTER_JUSTIFY", "RIGHT_JUSTIFY", "FULL_JUSTIFY_LASTLINE_LEFT", "FULL_JUSTIFY_LASTLINE_CENTER", "FULL_JUSTIFY_LASTLINE_RIGHT", "FULL_JUSTIFY_LASTLINE_FULL"]);
  var LIGHT = enumTable(LightType, ["PARALLEL", "SPOT", "POINT", "AMBIENT"]);

  function fromName(table, name, what) {
    var v = table.byName[String(name).toLowerCase()];
    if (v === undefined) {
      var all = [];
      for (var k in table.byName) all.push(k);
      A.fail("invalid_argument", "Unknown " + what + " \"" + name + "\". Use one of: " + all.join(", ") + ".");
    }
    return v;
  }

  A.blendName = function (v) { return BLEND.byValue[String(v)] || String(v); };
  A.blendValue = function (n) { return fromName(BLEND, n, "blend mode"); };
  A.matteName = function (v) { return MATTE.byValue[String(v)] || String(v); };
  A.matteValue = function (n) { return fromName(MATTE, n, "track matte type"); };
  A.interpName = function (v) { return INTERP.byValue[String(v)] || String(v); };
  A.lightValue = function (n) { return fromName(LIGHT, n, "light type"); };
  // "left" | "center" | "right" | "full" are accepted as shorthands.
  A.justifyValue = function (n) {
    var s = String(n).toLowerCase();
    if (s === "left" || s === "center" || s === "right") s = s + "_justify";
    if (s === "full") s = "full_justify_lastline_left";
    return fromName(JUSTIFY, s, "justification");
  };
  A.justifyName = function (v) {
    var n = JUSTIFY.byValue[String(v)];
    return n ? n.replace("_justify", "") : String(v);
  };

  // ---- items and layers ----------------------------------------------------------------------------

  A.item = function (id) {
    var it = null;
    try { it = app.project.itemByID(id); } catch (e) { it = null; } // throws for unknown ids
    if (!it) A.fail("not_found", "No project item with id " + id + ". Call get_project to see current ids.");
    return it;
  };

  A.comp = function (id) {
    var it = A.item(id);
    if (!(it instanceof CompItem)) A.fail("invalid_argument", "Item " + id + " (\"" + it.name + "\") is not a composition.");
    return it;
  };

  A.findLayer = function (comp, id) {
    for (var i = 1; i <= comp.numLayers; i++) {
      var l = comp.layer(i);
      if (l.id === id) return l;
    }
    return null;
  };

  A.layer = function (comp, id) {
    var l = A.findLayer(comp, id);
    if (!l) A.fail("not_found", "Comp \"" + comp.name + "\" has no layer with id " + id + ". Call inspect_comp to see current layer ids.");
    return l;
  };

  A.itemType = function (it) {
    if (it instanceof CompItem) return "comp";
    if (it instanceof FolderItem) return "folder";
    if (it instanceof FootageItem) {
      if (it.mainSource instanceof SolidSource) return "solid";
      if (it.mainSource instanceof PlaceholderSource) return "placeholder";
      return "footage";
    }
    return "item";
  };

  // Text and shape layers are AV layers (blend modes, 3D, mattes, layer styles), but in AE 2026
  // `instanceof AVLayer` is false for them (spike 2026-11-10), so check all three.
  A.isAV = function (l) {
    return l instanceof AVLayer || l instanceof ShapeLayer || l instanceof TextLayer;
  };

  A.layerType = function (l) {
    if (l instanceof TextLayer) return "text";
    if (l instanceof ShapeLayer) return "shape";
    if (l instanceof CameraLayer) return "camera";
    if (l instanceof LightLayer) return "light";
    if (l.nullLayer) return "null";
    if (l.adjustmentLayer) return "adjustment";
    if (l.source instanceof CompItem) return "precomp";
    if (l.source instanceof FootageItem && l.source.mainSource instanceof SolidSource) return "solid";
    if (l.source) return "footage";
    return "layer";
  };

  A.summarizeItem = function (it) {
    var root = app.project.rootFolder.id;
    var o = { id: it.id, name: it.name, type: A.itemType(it), parentFolderId: it.parentFolder && it.parentFolder.id !== root ? it.parentFolder.id : null, label: it.label };
    if (it instanceof CompItem) {
      o.width = it.width;
      o.height = it.height;
      o.pixelAspect = A.round(it.pixelAspect);
      o.frameRate = A.round(it.frameRate);
      o.duration = A.round(it.duration);
      o.numLayers = it.numLayers;
      o.bgColor = A.num(it.bgColor);
      o.motionBlur = it.motionBlur;
      o.frameBlending = it.frameBlending;
      o.hideShyLayers = it.hideShyLayers;
    } else if (it instanceof FootageItem) {
      o.width = it.width;
      o.height = it.height;
      o.duration = A.round(it.duration);
      o.file = it.file ? it.file.fsName : null;
      o.missing = it.footageMissing;
    } else if (it instanceof FolderItem) {
      o.numItems = it.numItems;
    }
    return o;
  };

  // ---- properties ----------------------------------------------------------------------------------

  // Friendly names for the properties agents touch most. Anything else: a path of names or match names.
  A.ALIAS = {
    anchorPoint: ["ADBE Transform Group", "ADBE Anchor Point"],
    position: ["ADBE Transform Group", "ADBE Position"],
    scale: ["ADBE Transform Group", "ADBE Scale"],
    rotation: ["ADBE Transform Group", "ADBE Rotate Z"],
    opacity: ["ADBE Transform Group", "ADBE Opacity"],
    orientation: ["ADBE Transform Group", "ADBE Orientation"],
    xRotation: ["ADBE Transform Group", "ADBE Rotate X"],
    yRotation: ["ADBE Transform Group", "ADBE Rotate Y"],
    sourceText: ["ADBE Text Properties", "ADBE Text Document"]
  };
  A.TRANSFORM_2D = ["anchorPoint", "position", "scale", "rotation", "opacity"];
  A.TRANSFORM_3D = ["anchorPoint", "position", "scale", "orientation", "xRotation", "yRotation", "rotation", "opacity"];

  function pathText(steps) {
    var s = [];
    for (var i = 0; i < steps.length; i++) s.push(String(steps[i]));
    return s.join(" > ");
  }

  A.resolve = function (layer, path) {
    var steps = path;
    if (typeof path === "string") {
      steps = A.ALIAS[path];
      if (!steps) {
        var names = [];
        for (var k in A.ALIAS) names.push(k);
        A.fail("invalid_argument", "Unknown property name \"" + path + "\". Use one of " + names.join(", ") + ", or a path of names/match names such as [\"ADBE Effect Parade\", \"Gaussian Blur\", \"Blurriness\"].");
      }
    }
    var p = layer;
    for (var i = 0; i < steps.length; i++) {
      var next = null;
      try { next = p.property(steps[i]); } catch (e) { next = null; }
      if (!next) A.fail("not_found", "\"" + layer.name + "\" has no property " + pathText(steps.slice(0, i + 1)) + ". Use inspect_layer to see property names and match names.");
      p = next;
    }
    return p;
  };

  // layer can also be a property group (e.g. a shape item), with path relative to it.
  A.property = function (layer, path) {
    var p = A.resolve(layer, path);
    if (p.propertyType !== PropertyType.PROPERTY) A.fail("invalid_argument", "\"" + p.name + "\" is a group, not a property with a value.");
    return p;
  };

  // Path of match names from the layer down. Inside indexed groups (effects, masks, shape contents) the
  // match name doesn't say which child it is ("ADBE Vector Group" for every group), so those steps are
  // the child's name when no sibling shares it, else its 1-based index.
  A.pathOf = function (p) {
    var steps = [];
    while (p && p.parentProperty) {
      var parent = p.parentProperty;
      var step = p.matchName;
      if (parent.propertyType === PropertyType.INDEXED_GROUP) {
        var same = 0;
        for (var i = 1; i <= parent.numProperties; i++) if (parent.property(i).name === p.name) same++;
        step = same === 1 ? p.name : p.propertyIndex;
      }
      steps.unshift(step);
      p = parent;
    }
    return steps;
  };

  A.textDoc = function (d) {
    var o = { text: d.text };
    function grab(key, f) { try { o[key] = f(); } catch (e) {} } // mixed-style text throws on some fields
    grab("font", function () { return d.font; });
    grab("fontSize", function () { return A.round(d.fontSize); });
    grab("fillColor", function () { return d.applyFill ? A.num(d.fillColor) : null; });
    grab("strokeColor", function () { return d.applyStroke ? A.num(d.strokeColor) : null; });
    grab("strokeWidth", function () { return d.applyStroke ? A.round(d.strokeWidth) : null; });
    grab("justification", function () { return A.justifyName(d.justification); });
    grab("tracking", function () { return d.tracking; });
    grab("leading", function () { return d.autoLeading ? "auto" : A.round(d.leading); });
    return o;
  };

  A.value = function (p, time) {
    var t = p.propertyValueType;
    if (t === PropertyValueType.NO_VALUE || t === PropertyValueType.CUSTOM_VALUE || t === PropertyValueType.MARKER) return null;
    var v;
    try { v = time === undefined ? p.value : p.valueAtTime(time, false); } catch (e) { return null; }
    if (t === PropertyValueType.TEXT_DOCUMENT) return A.textDoc(v);
    if (t === PropertyValueType.SHAPE) return A.shapeData(v);
    return A.num(v);
  };

  // ---- path (Shape) values -------------------------------------------------------------------------
  // A path is { vertices, inTangents, outTangents, closed } with tangents relative to their vertex, as in
  // AE. Never "" + aShape (throws). Big paths (traced artwork) are summarized to keep results small.
  A.MAX_PATH_VERTICES = 200;

  function points(list) {
    var o = [];
    for (var i = 0; i < list.length; i++) o.push(A.num(list[i]));
    return o;
  }

  A.shapeData = function (s) {
    var n = s.vertices.length;
    if (n > A.MAX_PATH_VERTICES) return { closed: s.closed, numVertices: n, truncated: true };
    return { vertices: points(s.vertices), inTangents: points(s.inTangents), outTangents: points(s.outTangents), closed: s.closed };
  };

  // JSON path -> Shape. Missing tangents are [0, 0] (corners); closed defaults to `closedDefault`.
  A.toShape = function (v, closedDefault) {
    if (!v || !v.vertices || !v.vertices.length) A.fail("invalid_argument", "A path value is { vertices: [[x, y], ...], inTangents?, outTangents?, closed? }.");
    var n = v.vertices.length;
    function handles(list, what) {
      if (list === undefined) {
        var zeros = [];
        for (var i = 0; i < n; i++) zeros.push([0, 0]);
        return zeros;
      }
      if (list.length !== n) A.fail("invalid_argument", what + " has " + list.length + " entries but the path has " + n + " vertices.");
      return list;
    }
    var s = new Shape();
    s.vertices = v.vertices;
    s.inTangents = handles(v.inTangents, "inTangents");
    s.outTangents = handles(v.outTangents, "outTangents");
    s.closed = v.closed !== undefined ? v.closed : closedDefault !== false;
    return s;
  };

  A.color = function (v) {
    if (typeof v === "string") {
      var m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(v);
      if (!m) A.fail("invalid_argument", "Colors are [r, g, b] from 0 to 1, or a hex string like \"#7B2FF7\". Got \"" + v + "\".");
      var hex = m[1] + (m[2] || "");
      var out = [];
      for (var i = 0; i < hex.length; i += 2) out.push(A.round(parseInt(hex.substr(i, 2), 16) / 255));
      return out;
    }
    return v;
  };

  // JSON value -> AE value for property p: hex colors, missing alpha, and missing dimensions
  // (e.g. [x, y] for a 3D position) are filled in from the current value.
  A.toValue = function (p, v) {
    var t = p.propertyValueType;
    if (t === PropertyValueType.TEXT_DOCUMENT) return A.applyText(p.value, v);
    if (t === PropertyValueType.SHAPE) return A.toShape(v, p.value.closed);
    if (t === PropertyValueType.COLOR) {
      v = A.color(v);
      if (v instanceof Array && v.length === 3) v = [v[0], v[1], v[2], 1];
    }
    var cur = p.value;
    if (v instanceof Array && cur instanceof Array && v.length < cur.length) {
      var padded = [];
      for (var i = 0; i < cur.length; i++) padded.push(i < v.length ? v[i] : cur[i]);
      v = padded;
    }
    return v;
  };

  A.applyText = function (doc, f) {
    if (typeof f === "string") {
      doc.text = f;
      return doc;
    }
    if (f.text !== undefined) doc.text = f.text;
    if (f.font !== undefined) doc.font = f.font;
    if (f.fontSize !== undefined) doc.fontSize = f.fontSize;
    if (f.fillColor !== undefined) {
      doc.applyFill = true;
      doc.fillColor = A.color(f.fillColor).slice(0, 3);
    }
    if (f.strokeColor !== undefined) {
      doc.applyStroke = f.strokeColor !== null;
      if (f.strokeColor !== null) doc.strokeColor = A.color(f.strokeColor).slice(0, 3);
    }
    if (f.strokeWidth !== undefined) doc.strokeWidth = f.strokeWidth;
    if (f.justification !== undefined) doc.justification = A.justifyValue(f.justification);
    if (f.tracking !== undefined) doc.tracking = f.tracking;
    if (f.leading !== undefined) {
      if (f.leading === "auto") doc.autoLeading = true;
      else {
        doc.autoLeading = false;
        doc.leading = f.leading;
      }
    }
    return doc;
  };

  A.setStatic = function (p, v) {
    if (p.numKeys > 0) A.fail("animated", "\"" + p.name + "\" has keyframes, so it can't take a single value. Use animate (with replace: true) to change its motion.");
    p.setValue(A.toValue(p, v));
  };

  // AE keeps the requested font name even when the font is missing; app.fonts says whether it's a substitute.
  A.fontWarning = function (requested) {
    if (requested === undefined) return null;
    var found;
    try { found = app.fonts.getFontsByPostScriptName(requested); } catch (e) { return null; }
    for (var i = 0; found && i < found.length; i++) if (!found[i].isSubstitute) return null;
    return "Font \"" + requested + "\" isn't installed on this Mac, so After Effects shows a substitute. Use the PostScript name of an installed font (e.g. \"Inter-Bold\"), or ask the user which font to use.";
  };

  // ---- keyframes and eases -----------------------------------------------------------------------

  function easeData(list) {
    var o = [];
    for (var i = 0; i < list.length; i++) o.push({ speed: A.round(list[i].speed), influence: A.round(list[i].influence) });
    return o.length === 1 ? o[0] : o;
  }

  A.keyframes = function (p, max) {
    var out = [];
    var n = Math.min(p.numKeys, max || 100);
    for (var k = 1; k <= n; k++) {
      var kf = { time: A.round(p.keyTime(k)), value: null, inInterpolation: A.interpName(p.keyInInterpolationType(k)), outInterpolation: A.interpName(p.keyOutInterpolationType(k)) };
      try {
        var pvt = p.propertyValueType;
        var kv = p.keyValue(k);
        kf.value = pvt === PropertyValueType.TEXT_DOCUMENT ? A.textDoc(kv).text : pvt === PropertyValueType.SHAPE ? A.shapeData(kv) : A.num(kv);
      } catch (e) {}
      try {
        kf.inEase = easeData(p.keyInTemporalEase(k));
        kf.outEase = easeData(p.keyOutTemporalEase(k));
        kf.temporalContinuous = p.keyTemporalContinuous(k);
        kf.temporalAutoBezier = p.keyTemporalAutoBezier(k);
      } catch (e2) {}
      if (p.isSpatial) {
        try {
          kf.inTangent = A.num(p.keyInSpatialTangent(k));
          kf.outTangent = A.num(p.keyOutSpatialTangent(k));
          kf.spatialContinuous = p.keySpatialContinuous(k);
          kf.spatialAutoBezier = p.keySpatialAutoBezier(k);
          kf.roving = p.keyRoving(k);
        } catch (e3) {}
      }
      try {
        var label = p.keyLabel(k);
        if (label) kf.label = label;
      } catch (e4) {}
      out.push(kf);
    }
    return out;
  };

  // ---- keyframe details (interpolation, exact eases, spatial tangents, roving, labels) -------------
  // d: { inInterpolation, outInterpolation, inEase, outEase, temporalContinuous, temporalAutoBezier,
  //      inTangent, outTangent, spatialContinuous, spatialAutoBezier, roving, label }, all optional.
  // checkKeyDetails runs before anything changes, because AE stops the script on a refused call.
  var SPATIAL_FIELDS = ["inTangent", "outTangent", "spatialContinuous", "spatialAutoBezier", "roving"];

  A.checkKeyDetails = function (p, k, d) {
    var at = " (keyframe at " + A.round(p.keyTime(k)) + " s on \"" + p.name + "\")";
    if (!p.isSpatial) {
      for (var i = 0; i < SPATIAL_FIELDS.length; i++) {
        if (d[SPATIAL_FIELDS[i]] !== undefined) A.fail("invalid_argument", SPATIAL_FIELDS[i] + " is only for spatial properties such as position or anchor point" + at + ".");
      }
    }
    if (d.roving === true && (k === 1 || k === p.numKeys)) A.fail("invalid_argument", "The first and last keyframes can't rove" + at + ".");
    if (d.spatialAutoBezier === true && (d.inTangent || d.outTangent)) A.fail("invalid_argument", "Give tangents or spatialAutoBezier: true, not both" + at + ".");
    if (d.temporalAutoBezier === true && (d.inEase || d.outEase)) A.fail("invalid_argument", "Give eases or temporalAutoBezier: true, not both" + at + ".");
    var dims = A.easeDims(p);
    var sides = ["inEase", "outEase"];
    for (var s = 0; s < sides.length; s++) {
      var e = d[sides[s]];
      if (e && e.length !== undefined && e.length !== dims) A.fail("invalid_argument", sides[s] + " has " + e.length + " entries but \"" + p.name + "\" takes " + dims + (dims === 1 ? " ease (give one object)" : " (one per dimension)") + at + ".");
    }
    var n = p.isSpatial ? p.keyInSpatialTangent(k).length : 0; // 3 even for 2D layers' position
    var tans = ["inTangent", "outTangent"];
    for (var t = 0; t < tans.length; t++) {
      if (d[tans[t]] && d[tans[t]].length > n) A.fail("invalid_argument", tans[t] + " has " + d[tans[t]].length + " values; \"" + p.name + "\" has " + n + at + ".");
    }
  };

  function eases(e, dims) {
    var o = [];
    for (var i = 0; i < dims; i++) {
      var x = e.length !== undefined ? e[i] : e;
      o.push(new KeyframeEase(x.speed, x.influence));
    }
    return o;
  }
  function padTangent(v, n) {
    var o = [];
    for (var i = 0; i < n; i++) o.push(i < v.length ? v[i] : 0);
    return o;
  }

  // Applies everything but roving (which moves key times; apply it last with applyRoving).
  A.applyKeyDetails = function (p, k, d) {
    var BEZ = KeyframeInterpolationType.BEZIER;
    var inType = d.inInterpolation !== undefined ? fromName(INTERP, d.inInterpolation, "interpolation") : p.keyInInterpolationType(k);
    var outType = d.outInterpolation !== undefined ? fromName(INTERP, d.outInterpolation, "interpolation") : p.keyOutInterpolationType(k);
    // An exact ease needs bezier on that side unless the side was set explicitly.
    if (d.inEase && d.inInterpolation === undefined) inType = BEZ;
    if (d.outEase && d.outInterpolation === undefined) outType = BEZ;
    var setTypes = d.inInterpolation !== undefined || d.outInterpolation !== undefined || d.inEase || d.outEase;
    if (setTypes) p.setInterpolationTypeAtKey(k, inType, outType);
    if (d.temporalContinuous !== undefined) p.setTemporalContinuousAtKey(k, d.temporalContinuous);
    if (d.temporalAutoBezier !== undefined) p.setTemporalAutoBezierAtKey(k, d.temporalAutoBezier);
    if (d.inEase || d.outEase) {
      var dims = A.easeDims(p);
      p.setTemporalEaseAtKey(k, d.inEase ? eases(d.inEase, dims) : p.keyInTemporalEase(k), d.outEase ? eases(d.outEase, dims) : p.keyOutTemporalEase(k));
      // Setting an ease turns a hold side back into bezier (spike 2026-11-19), so set the types again.
      p.setInterpolationTypeAtKey(k, inType, outType);
    }
    if (p.isSpatial) {
      if (d.spatialAutoBezier !== undefined) p.setSpatialAutoBezierAtKey(k, d.spatialAutoBezier);
      if (d.spatialContinuous !== undefined) p.setSpatialContinuousAtKey(k, d.spatialContinuous);
      if (d.inTangent || d.outTangent) {
        var n = p.keyInSpatialTangent(k).length;
        p.setSpatialTangentsAtKey(k, d.inTangent ? padTangent(d.inTangent, n) : p.keyInSpatialTangent(k), d.outTangent ? padTangent(d.outTangent, n) : p.keyOutSpatialTangent(k));
      }
    }
    if (d.label !== undefined) p.setLabelAtKey(k, d.label);
  };

  A.applyRoving = function (p, k, d) {
    if (d.roving !== undefined) p.setRovingAtKey(k, d.roving);
  };

  // ---- replacing keyframes without ever emptying the property ----------------------------------
  // Removing a property's last keyframe is not neutral: on Time Remap it turns Time Remap off. So a
  // replace keeps one old key (the survivor) until the new keys exist, then drops it. Keys are always
  // removed by index from last to first; no "while (numKeys > 0)" loops (one that fails to remove spins).
  A.TIME_EPS = 0.0001;

  A.sameTime = function (a, b) {
    return Math.abs(a - b) < A.TIME_EPS;
  };

  // Removes every key but the first; returns the survivor's time, or null if there were no keys.
  A.clearKeysKeepOne = function (p) {
    if (p.numKeys === 0) return null;
    for (var k = p.numKeys; k >= 2; k--) p.removeKey(k);
    return p.keyTime(1);
  };

  // After the new keys are set: drop the survivor unless a new key sits at its time, in which case
  // that key was written over the survivor and its old interpolation is reset to a fresh key's.
  A.dropSurvivor = function (p, survivorTime, newTimes) {
    if (survivorTime === null) return;
    for (var i = 0; i < newTimes.length; i++) {
      if (A.sameTime(newTimes[i], survivorTime)) {
        var k = p.nearestKeyIndex(survivorTime);
        var LIN = KeyframeInterpolationType.LINEAR;
        p.setInterpolationTypeAtKey(k, LIN, LIN);
        if (p.isSpatial) {
          try { p.setSpatialAutoBezierAtKey(k, true); } catch (e) {}
        }
        return;
      }
    }
    var idx = p.nearestKeyIndex(survivorTime);
    if (p.numKeys > 1 && A.sameTime(p.keyTime(idx), survivorTime)) p.removeKey(idx);
  };

  // Everything about one keyframe that a retime has to carry over.
  A.grabKey = function (p, k) {
    var d = { t: p.keyTime(k), v: p.keyValue(k), ii: p.keyInInterpolationType(k), oi: p.keyOutInterpolationType(k) };
    try { d.ie = p.keyInTemporalEase(k); d.oe = p.keyOutTemporalEase(k); } catch (e) {}
    try { d.tc = p.keyTemporalContinuous(k); d.ta = p.keyTemporalAutoBezier(k); } catch (e2) {}
    if (p.isSpatial) {
      try { d.ist = p.keyInSpatialTangent(k); d.ost = p.keyOutSpatialTangent(k); } catch (e3) {}
      try { d.sc = p.keySpatialContinuous(k); d.sa = p.keySpatialAutoBezier(k); } catch (e4) {}
      try { d.rv = p.keyRoving(k); } catch (e5) {}
    }
    return d;
  };

  // Restores a grabbed key's attributes onto key k. Returns the number of attributes AE refused.
  A.applyKey = function (p, k, d) {
    var failed = 0;
    function step(f) { try { f(); } catch (e) { failed++; } }
    step(function () { p.setInterpolationTypeAtKey(k, d.ii, d.oi); });
    if (d.ie) step(function () { p.setTemporalEaseAtKey(k, d.ie, d.oe); });
    if (d.tc !== undefined) step(function () { p.setTemporalContinuousAtKey(k, d.tc); p.setTemporalAutoBezierAtKey(k, d.ta); });
    if (d.ist) step(function () { p.setSpatialTangentsAtKey(k, d.ist, d.ost); });
    if (d.sc !== undefined) step(function () { p.setSpatialContinuousAtKey(k, d.sc); p.setSpatialAutoBezierAtKey(k, d.sa); });
    return failed;
  };

  // Cubic-bezier (x1, y1, x2, y2) over one keyframe segment -> AE temporal ease.
  // AE's outgoing handle is (influence * dt, speed * influence * dt); matching it to the bezier's
  // first control point (x1 * dt, y1 * dv) gives influence = x1 and speed = (y1 / x1) * dv / dt.
  // The incoming side mirrors it with (1 - x2, 1 - y2). Pure math: unit-tested in Node.
  A.easeNumbers = function (bez, avgSpeed) {
    function clampInf(x) { return Math.max(0.1, Math.min(100, x * 100)); }
    var dxOut = bez[0];
    var dxIn = 1 - bez[2];
    return {
      outSpeed: dxOut > 0.0001 ? (bez[1] / dxOut) * avgSpeed : 0,
      outInfluence: clampInf(dxOut),
      inSpeed: dxIn > 0.0001 ? ((1 - bez[3]) / dxIn) * avgSpeed : 0,
      inInfluence: clampInf(dxIn)
    };
  };

  // Spatial and color properties take one ease; others one per dimension.
  A.easeDims = function (p) {
    if (p.isSpatial || p.propertyValueType === PropertyValueType.COLOR) return 1;
    var v = p.keyValue(1);
    return v instanceof Array ? v.length : 1;
  };

  // Applies the ease of the segment from key ka to key kb. ease: [x1, y1, x2, y2] | "linear" | "hold".
  A.applyEase = function (p, ka, kb, ease) {
    var LIN = KeyframeInterpolationType.LINEAR;
    var BEZ = KeyframeInterpolationType.BEZIER;
    if (ease === "hold") {
      p.setInterpolationTypeAtKey(ka, p.keyInInterpolationType(ka), KeyframeInterpolationType.HOLD);
      return;
    }
    if (ease === "linear") {
      p.setInterpolationTypeAtKey(ka, p.keyInInterpolationType(ka), LIN);
      p.setInterpolationTypeAtKey(kb, LIN, p.keyOutInterpolationType(kb));
      return;
    }
    var dt = p.keyTime(kb) - p.keyTime(ka);
    var va = p.keyValue(ka);
    var vb = p.keyValue(kb);
    var dims = A.easeDims(p);
    var deltas = [];
    if (p.propertyValueType === PropertyValueType.SHAPE) {
      deltas.push(dt); // a path's ease speed is in multiples of the segment's average rate (spike: linear = 1)
    } else if (dims === 1 && va instanceof Array) {
      var sum = 0;
      for (var i = 0; i < va.length; i++) sum += (vb[i] - va[i]) * (vb[i] - va[i]);
      deltas.push(Math.sqrt(sum)); // speed along the path
    } else if (dims === 1) {
      deltas.push(vb - va);
    } else {
      for (var j = 0; j < dims; j++) deltas.push(vb[j] - va[j]);
    }
    var outE = [];
    var inE = [];
    for (var d = 0; d < deltas.length; d++) {
      var n = A.easeNumbers(ease, deltas[d] / dt);
      outE.push(new KeyframeEase(n.outSpeed, n.outInfluence));
      inE.push(new KeyframeEase(n.inSpeed, n.inInfluence));
    }
    p.setInterpolationTypeAtKey(ka, p.keyInInterpolationType(ka), BEZ);
    p.setInterpolationTypeAtKey(kb, BEZ, p.keyOutInterpolationType(kb));
    p.setTemporalEaseAtKey(ka, p.keyInTemporalEase(ka), outE);
    p.setTemporalEaseAtKey(kb, inE, p.keyOutTemporalEase(kb));
  };

  // ---- shape layer contents ------------------------------------------------------------------------
  // The server turns friendly items into { matchName, name?, settings: [{ path, value }], children? }.
  // AE invalidates references to a group's earlier children whenever a child is added, so containers
  // are looked up again for every item and items are kept by index, never by reference.

  // The "Contents" group of a shape layer, or of a group in it (steps: group names or 1-based indexes).
  A.shapeContents = function (layer, steps) {
    if (!(layer instanceof ShapeLayer)) A.fail("invalid_argument", "Layer \"" + layer.name + "\" is a " + A.layerType(layer) + " layer; shape contents need a shape layer.");
    var box = layer.property("ADBE Root Vectors Group");
    for (var i = 0; i < steps.length; i++) {
      var g = null;
      try { g = box.property(steps[i]); } catch (e) { g = null; }
      if (!g || g.matchName !== "ADBE Vector Group") A.fail("not_found", "Layer \"" + layer.name + "\" has no shape group " + pathText(steps.slice(0, i + 1)) + " in its contents. Use inspect_layer to see the groups.");
      box = g.property("ADBE Vectors Group");
    }
    return box;
  };

  // Adds items in order at the end of the container; returns their summaries (children included).
  A.addShapeItems = function (layer, steps, items) {
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var box = A.shapeContents(layer, steps);
      if (!box.canAddProperty(it.matchName)) A.fail("invalid_argument", "\"" + it.matchName + "\" can't be added to shape contents. Use a shape item match name such as \"ADBE Vector Filter - Repeater\".");
      var p = box.addProperty(it.matchName);
      var index = p.propertyIndex;
      if (it.name !== undefined) p.name = it.name;
      for (var s = 0; s < it.settings.length; s++) A.setStatic(A.property(p, it.settings[s].path), it.settings[s].value);
      out.push(index);
      if (it.children && it.children.length) {
        var kids = A.addShapeItems(layer, steps.concat([index]), it.children);
        for (var k = 0; k < kids.length; k++) out.push(kids[k]);
      }
    }
    // Summaries last: re-find each added item, since later additions invalidated earlier references.
    var done = [];
    for (var j = 0; j < out.length; j++) {
      if (typeof out[j] !== "number") {
        done.push(out[j]);
        continue;
      }
      done.push(A.summarizeShapeItem(A.shapeContents(layer, steps).property(out[j])));
    }
    return done;
  };

  // A group's own values (one level of sub-groups, e.g. a stroke's Taper), with paths from the layer.
  // skip: match names of sub-groups not to list.
  A.summarizeGroup = function (p, skip) {
    var o = { name: p.name, matchName: p.matchName, path: A.pathOf(p), properties: [] };
    function walk(g, prefix, depth) {
      for (var i = 1; i <= g.numProperties; i++) {
        var q = g.property(i);
        if (q.propertyType === PropertyType.PROPERTY) {
          if (q.propertyValueType === PropertyValueType.NO_VALUE) continue;
          o.properties.push({ name: prefix + q.name, matchName: q.matchName, value: A.value(q) });
        } else if (depth < 1 && !A.has(skip || [], q.matchName)) {
          walk(q, prefix + q.name + " > ", depth + 1);
        }
      }
    }
    walk(p, "", 0);
    return o;
  };

  A.summarizeShapeItem = function (p) {
    return A.summarizeGroup(p, ["ADBE Vectors Group", "ADBE Vector Stroke Dashes"]);
  };

  // ---- describing layers ---------------------------------------------------------------------------

  function isAnimated(p) {
    if (p.numKeys > 0) return true;
    try { return p.canSetExpression && p.expressionEnabled && p.expression !== ""; } catch (e) { return false; }
  }

  // Animated or expression-driven properties anywhere in the layer, as paths of match names.
  A.animatedProps = function (layer, max) {
    var out = [];
    var limit = max || 50;
    function walk(g) {
      for (var i = 1; i <= g.numProperties && out.length < limit; i++) {
        var p = g.property(i);
        if (p.propertyType === PropertyType.PROPERTY) {
          if (isAnimated(p)) out.push({ path: A.pathOf(p), name: p.name, numKeys: p.numKeys, expression: p.canSetExpression && p.expression !== "" });
        } else {
          walk(p);
        }
      }
    }
    walk(layer);
    return out;
  };

  // The Timeline switches of an AV layer, by the names set_properties takes.
  var QUALITY_NAME = {}, FRAME_BLEND_NAME = {}, ORIENT_NAME = {};
  QUALITY_NAME[LayerQuality.BEST] = "best"; QUALITY_NAME[LayerQuality.DRAFT] = "draft"; QUALITY_NAME[LayerQuality.WIREFRAME] = "wireframe";
  FRAME_BLEND_NAME[FrameBlendingType.NO_FRAME_BLEND] = "none"; FRAME_BLEND_NAME[FrameBlendingType.FRAME_MIX] = "frameMix"; FRAME_BLEND_NAME[FrameBlendingType.PIXEL_MOTION] = "pixelMotion";
  ORIENT_NAME[AutoOrientType.NO_AUTO_ORIENT] = "off"; ORIENT_NAME[AutoOrientType.ALONG_PATH] = "alongPath"; ORIENT_NAME[AutoOrientType.CAMERA_OR_POINT_OF_INTEREST] = "towardsCamera"; ORIENT_NAME[AutoOrientType.CHARACTERS_TOWARD_CAMERA] = "charactersTowardCamera";
  A.layerSwitches = function (l) {
    var o = {};
    function grab(key, f) { try { o[key] = f(); } catch (e) {} }
    grab("preserveTransparency", function () { return l.preserveTransparency; });
    grab("motionBlur", function () { return l.motionBlur; });
    grab("adjustmentLayer", function () { return l.adjustmentLayer; });
    grab("guideLayer", function () { return l.guideLayer; });
    grab("collapseTransformation", function () { return l.collapseTransformation; });
    grab("effectsActive", function () { return l.effectsActive; });
    grab("quality", function () { return QUALITY_NAME[l.quality]; });
    grab("frameBlending", function () { return FRAME_BLEND_NAME[l.frameBlendingType]; });
    grab("autoOrient", function () { return ORIENT_NAME[l.autoOrient]; });
    if (l instanceof TextLayer) grab("threeDPerChar", function () { return l.threeDPerChar; });
    return o;
  };

  A.summarizeLayer = function (l, time, opts) {
    opts = opts || {};
    var o = {
      id: l.id,
      index: l.index,
      name: l.name,
      type: A.layerType(l),
      enabled: l.enabled,
      startTime: A.round(l.startTime),
      inPoint: A.round(l.inPoint),
      outPoint: A.round(l.outPoint),
      parentId: l.parent ? l.parent.id : null,
      label: l.label,
      shy: l.shy,
      locked: l.locked,
      solo: l.solo
    };
    if (A.isAV(l)) {
      o.threeD = l.threeDLayer;
      o.blendMode = A.blendName(l.blendingMode);
      o.trackMatte = null;
      try {
        if (l.trackMatteType !== TrackMatteType.NO_TRACK_MATTE && l.trackMatteLayer) o.trackMatte = { layerId: l.trackMatteLayer.id, type: A.matteName(l.trackMatteType) };
      } catch (e) {}
      o.isTrackMatte = l.isTrackMatte;
      o.stretch = A.round(l.stretch);
      o.timeRemapEnabled = l.timeRemapEnabled;
      if (l.source) o.sourceId = l.source.id;
      o.switches = A.layerSwitches(l);
    }
    var names = o.threeD ? A.TRANSFORM_3D : A.TRANSFORM_2D;
    o.transform = {};
    var tr = l.property("ADBE Transform Group");
    for (var i = 0; i < names.length; i++) {
      var p = null;
      try { p = tr.property(A.ALIAS[names[i]][1]); } catch (e2) {}
      if (p) o.transform[names[i]] = A.value(p, time);
    }
    if (l instanceof TextLayer) o.text = A.value(l.property("ADBE Text Properties").property("ADBE Text Document"), time);
    var fx = l.property("ADBE Effect Parade");
    if (fx) {
      o.effects = [];
      for (var k = 1; k <= fx.numProperties; k++) {
        var e = fx.property(k);
        o.effects.push({ index: k, name: e.name, matchName: e.matchName, enabled: e.enabled });
      }
    }
    if (opts.animated !== false) o.animated = A.animatedProps(l);
    return o;
  };

  // Property tree for inspect_layer. With onlyModified, unchanged default properties are left out, but
  // effects, masks and shape contents are always listed.
  A.describe = function (g, opts) {
    var budget = { left: opts.maxNodes || 400, truncated: false };
    function node(p, depth) {
      if (budget.left <= 0) {
        budget.truncated = true;
        return null;
      }
      var n = { name: p.name, matchName: p.matchName };
      if (p.propertyType === PropertyType.PROPERTY) {
        var keep = !opts.onlyModified || isAnimated(p);
        if (!keep) {
          try { keep = p.isModified; } catch (e) { keep = false; }
        }
        if (!keep) return null;
        n.value = A.value(p, opts.time);
        if (p.numKeys > 0) {
          n.numKeys = p.numKeys;
          if (opts.keyframes) n.keyframes = A.keyframes(p, 50);
        }
        if (p.canSetExpression && p.expression !== "") {
          n.expression = p.expression;
          n.expressionEnabled = p.expressionEnabled;
          if (p.expressionError) n.expressionError = p.expressionError;
        }
        budget.left--;
        return n;
      }
      var always = p.parentProperty && p.parentProperty.propertyType === PropertyType.INDEXED_GROUP;
      if (depth >= (opts.maxDepth || 8)) {
        n.children = "…";
        budget.left--;
        return n;
      }
      n.children = [];
      for (var i = 1; i <= p.numProperties; i++) {
        var c = node(p.property(i), depth + 1);
        if (c) n.children.push(c);
      }
      if (!n.children.length && !always && opts.onlyModified) return null;
      if (always) n.enabled = p.enabled;
      budget.left--;
      return n;
    }
    var out = [];
    for (var i = 1; i <= g.numProperties; i++) {
      var c = node(g.property(i), 1);
      if (c) out.push(c);
    }
    return { properties: out, truncated: budget.truncated };
  };

  return A;
})();
