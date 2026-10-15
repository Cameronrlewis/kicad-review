import assert from "node:assert/strict";
await import("./kicad-colors.js");
const C = globalThis.KicadColors;
assert.deepEqual(C.layers["F.Cu"], [200,52,52,1]);
assert.deepEqual(C.layers["B.Cu"], [77,127,196,1]);
assert.deepEqual(C.layers["F.Mask"], [216,100,255,.4]);
assert.deepEqual(C.layers["User.9"], [232,178,167,1]);
assert.deepEqual(C.layers["In13.Cu"], [167,165,198,1]);
// Inner copper does not repeat a single fixed-size palette.
assert.deepEqual(C.layers["In9.Cu"], [141,203,129,1]);
assert.deepEqual(C.layers["In17.Cu"], [237,124,51,1]);
assert.deepEqual(C.layers["In30.Cu"], [242,237,161,1]);
assert.deepEqual(C.layers["User.45"], [194,194,194,1]);
assert.equal(Object.keys(C.layers).length, 95);
assert.equal(C.appearanceOrder.indexOf("F.Adhes") + 1,
             C.appearanceOrder.indexOf("B.Adhes"));
assert.equal(C.appearanceOrder.at(-1), "User.45");
assert.deepEqual(C.objects.background, [0,16,35,1]);
assert.deepEqual(C.objects.ratsnest, [0,248,255,.35]);

// Every layer appears exactly once in each independently defined order.
const names = Object.keys(C.layers).sort();
assert.deepEqual([...C.appearanceOrder].sort(), names);
assert.equal(new Set(C.drawPriority).size, C.drawPriority.length);
assert.deepEqual(C.drawPriority.filter(name => name in C.layers).sort(), names);
assert.notDeepEqual(C.drawPriority.filter(name => name in C.layers), C.appearanceOrder);
for (const name of ["overlay", "netnames", "holes"]) {
  assert.ok(C.drawPriority.indexOf(name) < C.drawPriority.indexOf("F.Cu"));
  assert.ok(C.drawPriority.indexOf(name) < C.drawPriority.indexOf("B.Cu"));
}
assert.equal(C.drawPriority.at(-1), "grid");
assert.equal(Object.keys(C.objects).length, 24);
for (const rgba of [...Object.values(C.layers), ...Object.values(C.objects)]) {
  assert.equal(rgba.length, 4);
  assert.ok(rgba.slice(0, 3).every(v => Number.isInteger(v) && v >= 0 && v <= 255));
  assert.ok(rgba[3] >= 0 && rgba[3] <= 1);
}
console.log("PASS KiCad display data: 95 layers, 24 objects, Appearance and draw orders");
