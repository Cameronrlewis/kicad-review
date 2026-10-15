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
{
 const camera={x:10,y:20,z:8,width:800,height:600,dpr:2,flip:true};
 const px=G.worldToScreen([12,23],camera);
 assert.deepEqual(px,[384,324]);
 assert.deepEqual(G.screenToWorld(px,camera),[12,23]);
 assert.deepEqual(G.worldToScreen([10,20],camera),[400,300]);
 const s=clone();
 s.objects[0]={...s.objects[0],kind:"zone",category:"zones",geometry:{rings:[[[0,0],[10000,0],[10000,10000],[0,10000]],[[2000,2000],[8000,2000],[8000,8000],[2000,8000]]]}};
 const fill=G.buildBatches(s).find(b=>b.pass==="fill");
 assert.equal(fill.ranges.length,1);
  const t=clone(); t.objects[0]={...t.objects[0],kind:"text",category:"text",geometry:{text:{value:"R1 a",at:[1000,1000],size:[1000,1000],angle:0}}};
 assert.equal(G.buildBatches(t).find(b=>b.pass==="text").mesh.length/13,3*6);
 console.log("PASS camera transforms, ring fills and text quads");
}

{
 globalThis.window=globalThis;
 await import("./appearance-state.js");
 const K=globalThis.KrAppearance, names=["F.Cu","B.Cu","Edge.Cuts"], d=K.boardDefaults(names), norm=(x,n=names)=>K.normalizeBoard(x,n);
 assert.equal(d.objects.tracks.opacity,1); assert.equal(d.objects.vias.opacity,1); assert.equal(d.objects.pads.opacity,1);
 assert.equal(d.objects.zones.opacity,.6); assert.equal(d.objects.images.opacity,.6); assert.equal(d.contrast,"normal");
 assert.equal(norm({layers:{"F.Cu":{opacity:NaN}},contrast:"bad"}).contrast,"normal");
 assert.equal(norm({layers:{"F.Cu":{visible:false}}},[...names,"In1.Cu"]).layers["In1.Cu"].visible,true);
 const hostile=norm({nets:{"<img onerror=x>":{visible:false},"__proto__":{visible:false}}});
 assert.equal(hostile.nets["<img onerror=x>"].visible,false); assert.equal(Object.getPrototypeOf(hostile.nets).hostile,undefined);
 assert.equal(norm({nets:{GND:{color:[1,2,3,1]}}}).nets.GND.color[0],1);
 // Blocked or malformed storage still yields a working store; clearing a net colour removes it everywhere.
 const blocked={getItem(){throw new Error("blocked")},setItem(){throw new Error("blocked")}};
 const store=K.createStore({viewerId:"t",storage:()=>blocked});
 store.patch({nets:{GND:{color:[1,2,3,1]}}}); assert.deepEqual(store.get().netColors.GND.length,4);
 store.patch({nets:{GND:{color:null}}}); assert.equal(store.get().netColors.GND,undefined); assert.equal(store.get().nets.GND.color,undefined);
 const bad=K.createStore({viewerId:"t",storage:()=>({getItem:()=>"{not json",setItem(){}})});
 assert.equal(bad.get().contrast,"normal");
 console.log("PASS Appearance defaults, normalization, net colour clear and blocked storage");
}
