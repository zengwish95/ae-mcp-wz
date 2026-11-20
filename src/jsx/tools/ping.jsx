// check_setup round-trip: proves the bridge, permission, result file and version in one call.
var p = app.project;
var pref = null;
try { pref = app.preferences.getPrefAsLong("Main Pref Section v2", "Pref_SCRIPTING_FILE_NETWORK_SECURITY", PREFType.PREF_Type_MACHINE_SPECIFIC) === 1; } catch (e) {}
return {
  version: app.version,
  scriptingPref: pref,
  project: { name: p.file ? p.file.name : "Untitled Project", file: p.file ? p.file.fsName : null, dirty: p.dirty, numItems: p.numItems, renderQueueItems: p.renderQueue.numItems, rendering: p.renderQueue.rendering }
};
