// ae-motion wrapper. Static: written once to the run dir and run by DoScriptFile for every call
// (one stable path keeps AE's Recent Scripts menu to a single entry; SPIKE.md Q1).
// It reads request.json, runs body.jsx inside the only undo group and dialog suppression, and writes
// result.json. Nothing may escape this function: an uncaught error opens a modal dialog in AE.
(function () {
  var dir = File($.fileName).parent.fsName;
  var out = { id: null, ok: false, aeVersion: app.version };
  var req = null;
  try {
    var rf = new File(dir + "/request.json");
    rf.encoding = "UTF-8";
    if (!rf.open("r")) throw new Error("cannot open request.json");
    var text = rf.read();
    rf.close();
    req = JSON.parse(text);
    out.id = req.id;
  } catch (e0) {
    out.error = { code: "bad_request", message: String(e0.message) };
  }

  if (req) {
    var rev0 = -1;
    try { rev0 = app.project.revision; } catch (e1) {}
    // If the script is stopped before it writes a result, this marker lets the server tell that apart
    // from AE not running the script at all (busy or a dialog open).
    try {
      var sf = new File(dir + "/started.json");
      sf.encoding = "UTF-8";
      if (sf.open("w")) {
        sf.write(JSON.stringify({ id: req.id, revision: rev0 }));
        sf.close();
      }
    } catch (e1b) {}
    var suppressed = false;
    var grouped = false;
    try {
      app.beginSuppressDialogs();
      suppressed = true;
      // The previous call stopped before reporting back, so its undo group may still be open: close it, so
      // this call's group isn't merged into it. (Only then: there is no way to ask AE if one is open.)
      if (req.closeStaleUndo) {
        try { app.endUndoGroup(); } catch (e1c) {}
      }
      if (req.undo) {
        app.beginUndoGroup(req.undo);
        grouped = true;
      }
      $.global.__aemArgs = req.args;
      out.value = $.evalFile(new File(dir + "/body.jsx"));
      if (out.value === undefined) out.value = null;
      out.ok = true;
    } catch (e2) {
      out.error = {
        code: e2.aemCode ? String(e2.aemCode) : "script_error",
        message: String(e2.message),
        name: String(e2.name),
        line: e2.line,
        detail: e2.aemDetail
      };
    }
    try { if (grouped) app.endUndoGroup(); } catch (e3) {}
    try { if (suppressed) app.endSuppressDialogs(false); } catch (e4) {}
    try { out.changed = app.project.revision !== rev0; } catch (e5) {}
    $.global.__aemArgs = undefined;
  }

  var json;
  try {
    json = JSON.stringify(out);
  } catch (e6) {
    json = JSON.stringify({ id: out.id, ok: false, changed: out.changed, aeVersion: out.aeVersion, error: { code: "script_error", message: "The result could not be converted to JSON." } });
  }
  try {
    var wf = new File(dir + "/result.json");
    wf.encoding = "UTF-8";
    if (wf.open("w")) {
      wf.write(json);
      wf.close();
    }
  } catch (e7) {}
})();
