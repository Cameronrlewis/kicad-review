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

await import("./board-gl.js");
const G = globalThis.BoardGL;
const primitiveScene = {version:1,units:"um",complete:true,warnings:[],bounds:[0,0,4000,4000],
 layers:[{id:0,name:"F.Cu",type:"signal",enabled:true}],nets:[{id:0,name:""}],
 objects:[{kind:"track",uuid:"a",changeUuid:"a",ref:"",layers:["F.Cu"],net:0,
 category:"tracks",side:null,hidden:false,box:[0,0,4000,1000],
 geometry:{segments:[[500,500,3500,500,500]]}}]};
G.validateScene(primitiveScene);
const batches = G.buildBatches(primitiveScene,"base");
assert.equal(batches.length,1);
assert.equal(batches[0].key,"base|F.Cu|track");
assert.equal(batches[0].instances.length,9);
assert.equal(batches[0].ranges[0].uuid,"a");
assert.deepEqual(Array.from(batches[0].instances).slice(0,5),[-1.5,-1.5,1.5,-1.5,.25]);
assert.equal(G.layerFactor("B.Cu",{activeLayer:"F.Cu",contrast:"dim"}),.2);
assert.equal(G.layerFactor("B.Cu",{activeLayer:"F.Cu",contrast:"hide"}),0);
assert.equal(G.layerFactor("Edge.Cuts",{activeLayer:"F.Cu",contrast:"hide"}),.3);
assert.equal(G.layerFactor("Edge.Cuts",{layers:{"Edge.Cuts":{visible:false}},contrast:"hide"}),0);
for (const patch of [{version:2},{units:"mm"},{bounds:[0,0,Infinity,0]}, {layers:[{id:-1,name:"F.Cu"}]}, {nets:[]}, {objects:null}]) {
 assert.throws(()=>G.validateScene({...primitiveScene,...patch}));
}
const clone = () => structuredClone(primitiveScene);
let bad = clone(); bad.objects[0].geometry.segments[0][0] = Number.MAX_SAFE_INTEGER+1;
assert.throws(()=>G.validateScene(bad));
bad = clone(); bad.objects[0].geometry.segments[0].pop(); assert.throws(()=>G.validateScene(bad));
const sparse = clone(); sparse.nets.push({id:999999,name:"GND"}); sparse.objects[0].net=999999;
assert.equal(G.buildBatches(sparse,"head")[0].instances[5],1);
const via = clone(); via.objects=[{...via.objects[0],kind:"via",category:"vias",geometry:{primitive:{shape:"circle",center:[2000,2000],size:[1000,1000],angle:0},drill:{center:[2000,2000],size:[500,300],angle:90000,plated:true}}}];
const vb = G.buildBatches(via,"head");
assert.equal(vb.length,3); assert.equal(vb[0].instances[4],.5);
assert.deepEqual(vb.map(b=>b.pass),["copper","wall","hole"]);
console.log("PASS retained batches, validation, contrast, compact nets and via drills");

// Renderer refusal and failure paths never report a successful empty renderer.
assert.equal(G.create({getContext:()=>null}),null);
assert.equal(G.create({getContext:()=>{throw new Error("disabled");}}),null);
assert.equal(G.create({getContext:()=>({getParameter:()=>0})}),null);
for (const stage of ["compile","link"]) {
 const allocated = new Set(), deleted = new Set(), failures=[];
 const allocate = () => {const v={};allocated.add(v);return v;};
 const gl = {STENCIL_BITS:1,COMPILE_STATUS:2,LINK_STATUS:3,VERTEX_SHADER:4,FRAGMENT_SHADER:5,
  getParameter:()=>8,createProgram:allocate,createShader:allocate,
  shaderSource(){},compileShader(){},attachShader(){},linkProgram(){},
  getShaderParameter:()=>stage!=="compile",getProgramParameter:()=>stage!=="link",
  getShaderInfoLog:()=>"compile failed",getProgramInfoLog:()=>"link failed",
  deleteProgram:v=>deleted.add(v),deleteShader:v=>deleted.add(v)};
 const canvas={getContext:()=>gl,addEventListener(){},removeEventListener(){}};
 assert.equal(G.create(canvas,{onFailure:e=>failures.push(e)}),null);
 assert.equal(failures.length,1);
 assert.deepEqual(deleted,allocated);
}
const offset = clone();
const shift = 8000000000000;
offset.bounds=offset.bounds.map(n=>n+shift);
offset.objects[0].box=offset.objects[0].box.map(n=>n+shift);
offset.objects[0].geometry.segments[0]=offset.objects[0].geometry.segments[0].map((n,i)=>i<4?n+shift:n);
assert.deepEqual(G.buildBatches(offset)[0].instances,batches[0].instances);
console.log("PASS WebGL refusal, shader failure cleanup and offset precision");
bad = clone(); bad.objects[0].geometry={rings:[Array(2000001).fill([0,0])]};
assert.throws(()=>G.validateScene(bad));
bad = clone(); bad.objects[0].geometry={rings:[[["0",0]]]};
assert.throws(()=>G.validateScene(bad));
console.log("PASS primitive vertex budget and ring coordinate validation");
const multiple = clone(); multiple.objects[0].geometry.segments.push([3500,500,3500,3500,500]);
const combined = G.buildBatches(multiple)[0];
assert.equal(combined.instances.length,18);
assert.equal(combined.ranges.length,1);
assert.equal(combined.ranges[0].count,2);
console.log("PASS contiguous object ranges retain all segment instances");
