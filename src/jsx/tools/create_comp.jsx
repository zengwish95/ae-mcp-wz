var a = ARGS;
var comp = app.project.items.addComp(a.name, a.width, a.height, a.pixelAspect, a.duration, a.frameRate);
if (a.bgColor !== undefined) comp.bgColor = AEM.color(a.bgColor).slice(0, 3);
if (a.folderId !== undefined) {
  var f = AEM.item(a.folderId);
  if (!(f instanceof FolderItem)) AEM.fail("invalid_argument", "Item " + a.folderId + " is not a folder.");
  comp.parentFolder = f;
}
if (a.openInViewer) comp.openInViewer();
return AEM.summarizeItem(comp);
