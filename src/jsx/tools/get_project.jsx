var p = app.project;
var total = p.numItems;
var items = [];
var end = Math.min(total, ARGS.offset + ARGS.limit);
for (var i = ARGS.offset + 1; i <= end; i++) {
  var it = p.item(i);
  if (ARGS.type && AEM.itemType(it) !== ARGS.type) continue;
  items.push(AEM.summarizeItem(it));
}
var active = p.activeItem;
return {
  project: { name: p.file ? p.file.name : "Untitled Project", file: p.file ? p.file.fsName : null, dirty: p.dirty, numItems: total, activeItemId: active ? active.id : null, bitsPerChannel: p.bitsPerChannel },
  items: items,
  nextOffset: end < total ? end : null
};
