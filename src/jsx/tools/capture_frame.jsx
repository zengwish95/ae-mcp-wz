// saveFrameToPng needs no scripting pref (SPIKE.md Q5). It is async: wait() blocks until the file exists.
var comp = AEM.comp(ARGS.compId);
var time = ARGS.time === undefined ? comp.time : ARGS.time;
if (time < 0 || time > comp.duration) AEM.fail("invalid_argument", "Time " + time + " s is outside the comp (0 to " + AEM.round(comp.duration) + " s).");
var job = comp.saveFrameToPng(time, new File(ARGS.outPath));
job.wait();
if (job._hasException) AEM.fail("script_error", "After Effects could not render the frame.");
return { compId: comp.id, name: comp.name, time: AEM.round(time), frame: Math.round(time * comp.frameRate), width: comp.width, height: comp.height, bgColor: AEM.num(comp.bgColor) };
