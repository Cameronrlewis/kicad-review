// Retained PCB drawing primitives. Classic script; no report or DOM ownership.
// create(canvas,{scene?,revision?,onFailure?}) -> renderer|null.
// setScene uploads geometry; setCamera({x,y,z,width,height,dpr}) never does.
// All drawing settings, including flip, enter ONLY through setAppearance(state).
// draw({camera?,mask?,filter?,override?}) reuses retained ranges. Callbacks receive scene objects.
// hitTest([xCSS,yCSS]) returns visible leaf geometry with retained changeIds; no bbox targets.
// Renderer worldToScreen/screenToWorld use its current camera and Appearance flip.
// readPixel uses backing-pixel GL coordinates.
// appearance.grid = {visible, size(mm)} draws a dot grid (absent = off); camera {x,y,z,width,height,dpr} z is CSS px/mm.
(() => {
  "use strict";
  const categories = ["tracks", "vias", "pads", "zones", "filledShapes", "images", "text", "graphics"];
  const sides = [null, "front", "back"];
  const MAX_VERTICES = 2000000;
  function validateScene(scene) {
    const fail = () => { throw new TypeError("Invalid board scene"); };
    if (!scene || scene.version !== 1 || scene.units !== "um" || typeof scene.complete !== "boolean") fail();
    for (const key of ["bounds", "warnings", "layers", "nets", "objects"]) if (!Array.isArray(scene[key])) fail();
    const box = b => Array.isArray(b) && b.length === 4 && b.every(Number.isSafeInteger) && b[0] <= b[2] && b[1] <= b[3];
    if (!box(scene.bounds)) fail();
    const layers = new Set(), layerIds = new Set(), nets = new Set();
    for (const l of scene.layers) {
      if (!l || !Number.isInteger(l.id) || l.id < 0 || l.id > 255 || typeof l.name !== "string" || layers.has(l.name) || layerIds.has(l.id)) fail();
      layers.add(l.name); layerIds.add(l.id);
    }
    for (const n of scene.nets) {
      if (!n || !Number.isSafeInteger(n.id) || n.id < 0 || typeof n.name !== "string" || nets.has(n.id)) fail();
      nets.add(n.id);
    }
    let vertices = 0;
    function geometry(value, depth = 0) {
      if (depth > 32) fail();
      if (typeof value === "number") { if (!Number.isSafeInteger(value)) fail(); }
      else if (Array.isArray(value)) for (const v of value) geometry(v, depth + 1);
      else if (value && typeof value === "object") for (const v of Object.values(value)) geometry(v, depth + 1);
    }
    const point = p => Array.isArray(p) && p.length === 2 && p.every(Number.isSafeInteger);
    for (const o of scene.objects) {
      if (!o || typeof o.uuid !== "string" || typeof o.changeUuid !== "string" || typeof o.kind !== "string" || !box(o.box) || !Array.isArray(o.layers) || o.layers.some(l => !layers.has(l)) || !nets.has(o.net) || !o.geometry || typeof o.geometry !== "object") fail();
      geometry(o.geometry);
      if (o.geometry.segments !== undefined && (!Array.isArray(o.geometry.segments) || o.geometry.segments.some(s => !Array.isArray(s) || s.length !== 5 || !s.every(Number.isSafeInteger) || s[4] < 0))) fail();
      if (o.geometry.rings !== undefined && (!Array.isArray(o.geometry.rings) || o.geometry.rings.some(r => !Array.isArray(r) || r.some(p => !point(p))))) fail();
      for (const p of [o.geometry.primitive, o.geometry.drill, ...Object.values(o.geometry.layerPrimitives || {})].filter(Boolean)) {
        if (!point(p.center) || !point(p.size) || p.size.some(n => n < 0) || !Number.isSafeInteger(p.angle ?? 0)) fail();
      }
      const text = o.geometry.text;
      if (text && (!point(text.at) || !point(text.size) || typeof text.value !== "string")) fail();
      vertices += (o.geometry.segments?.length || 0) * 2;
      vertices += (o.geometry.rings || []).reduce((n,r)=>n+r.length,0);
      vertices += (o.geometry.primitive ? 4 : 0) + (o.geometry.drill ? 4 : 0) + (text ? text.value.length * 6 : 0);
      if (vertices > MAX_VERTICES) fail();
    }
    return scene;
  }
  function layerFactor(layer, state = {}) {
    if (state.layers?.[layer]?.visible === false) return 0;
    if (!state.activeLayer || layer === state.activeLayer || !["dim", "hide"].includes(state.contrast)) return 1;
    return layer === "Edge.Cuts" ? .3 : state.contrast === "hide" ? 0 : .2;
  }
  const worldToScreen = ([x,y],c) => [c.width/2+(x-c.x)*c.z*(c.flip?-1:1), c.height/2+(y-c.y)*c.z];
  const screenToWorld = ([x,y],c) => [c.x+(x-c.width/2)/c.z*(c.flip?-1:1), c.y+(y-c.height/2)/c.z];
  // Glyph atlas layout is static so batches can be built without a canvas: 95 ASCII glyphs, regular then bold.
  const CELL_W = 32, CELL_H = 48, ATLAS_COLS = 16, ATLAS_W = CELL_W*ATLAS_COLS, ATLAS_H = CELL_H*12, MESH = 13;
  const glyphSlot = (ch, bold) => { const code = ch.codePointAt(0); return (bold ? 95 : 0) + (code >= 32 && code <= 126 ? code : 63) - 32; };
  // All instance coordinates are mm relative to this origin, never absolute floats.
  function buildBatches(scene, revision = "head") {
    validateScene(scene);
    const centerUm = [scene.bounds[0] / 2 + scene.bounds[2] / 2, scene.bounds[1] / 2 + scene.bounds[3] / 2];
    const origin = centerUm.map(n => n / 1000);
    const netIndices = new Map(scene.nets.map((n, i) => [n.id, i]));
    const batches = new Map();
    function append(o, index, layer, segment, pass = "copper") {
      const key = `${revision}|${layer}|${o.kind}${pass === "copper" ? "" : "|" + pass}`;
      if (!batches.has(key)) batches.set(key, {key, layer, kind:o.kind, pass, instances:[], ranges:[], origin, nets:scene.nets});
      const b = batches.get(key), start = b.instances.length / 9;
      b.instances.push((segment[0]-centerUm[0])/1000, (segment[1]-centerUm[1])/1000, (segment[2]-centerUm[0])/1000, (segment[3]-centerUm[1])/1000, segment[4]/2000, netIndices.get(o.net), Math.max(0,categories.indexOf(o.category)), Math.max(0,sides.indexOf(o.side)), index);
      const previous = b.ranges.at(-1);
      if (previous?.objectIndex === index) previous.count++;
      else b.ranges.push({uuid:o.uuid, changeUuid:o.changeUuid, changeIds:o.changeIds || [], objectIndex:index, start, count:1, layers:o.layers});
    }
    function capsule(p) {
      const [w,h] = p.size, r = Math.min(w,h), distance = Math.abs(w-h)/2;
      const angle = (p.angle || 0) * Math.PI/180000 + (h>w ? Math.PI/2 : 0);
      const dx = distance*Math.cos(angle), dy = -distance*Math.sin(angle);
      return [p.center[0]-dx,p.center[1]-dy,p.center[0]+dx,p.center[1]+dy,r];
    }
    const rel = ([x,y]) => [(x-centerUm[0])/1000, (y-centerUm[1])/1000];
    function meshBatch(o, layer, pass) {
      const key = `${revision}|${layer}|${o.kind}|${pass}`;
      if (!batches.has(key)) batches.set(key, {key, layer, kind:o.kind, pass, instances:[], mesh:[], ranges:[], origin, nets:scene.nets});
      return batches.get(key);
    }
    // Vertex: pos, local, shape(a,b,r,mode), rot(cos,sin), meta(net,category,side). Mode 1 solid, 2 rounded box SDF, 3 glyph.
    const vert = (b, o, x, y, lx, ly, sa, sb, sr, mode, c, s) =>
      b.mesh.push(x, y, lx, ly, sa, sb, sr, mode, c, s, netIndices.get(o.net), Math.max(0,categories.indexOf(o.category)), Math.max(0,sides.indexOf(o.side)));
    const count = b => b.mesh.length / MESH;
    const range = (b, o, index, first, extra) => b.ranges.push({uuid:o.uuid, changeUuid:o.changeUuid, changeIds:o.changeIds || [], objectIndex:index, first, count:count(b)-first, layers:o.layers, ...extra});
    function box(b, o, p) {
      const [w,h] = p.size.map(n => n/2000), t = (p.angle || 0)*Math.PI/180000, c = Math.cos(t), s = Math.sin(t);
      const r = p.shape === "oval" ? Math.min(w,h) : p.shape === "roundrect" ? Math.min((p.radius || 0)/1000, w, h) : 0;
      const [cx,cy] = rel(p.center);
      for (const [sx,sy] of [[-1,-1],[1,-1],[1,1],[-1,-1],[1,1],[-1,1]]) { const lx = sx*w, ly = sy*h; vert(b,o,cx+lx*c+ly*s,cy-lx*s+ly*c,lx,ly,w,h,r,2,c,s); }
    }
    function trapezoid(b, o, p) {
      const [w,h] = p.size.map(n => n/1000), [dx,dy] = (p.delta || [0,0]).map(n => n/1000), t = (p.angle || 0)*Math.PI/180000, c = Math.cos(t), s = Math.sin(t);
      const [cx,cy] = rel(p.center);
      const k = [[-1,-1],[1,-1],[1,1],[-1,1]].map(([sx,sy]) => { const lx = sx*w/2-sx*sy*dy/2, ly = sy*h/2+sx*sy*dx/2; return [cx+lx*c+ly*s, cy-lx*s+ly*c]; });
      for (const i of [0,1,2,0,2,3]) vert(b,o,k[i][0],k[i][1],0,0,0,0,0,1,1,0);
    }
    const quad = (b, o, [x0,y0,x1,y1]) => { for (const [x,y] of [[x0,y0],[x1,y0],[x1,y1],[x0,y0],[x1,y1],[x0,y1]]) vert(b,o,x,y,0,0,0,0,0,1,1,0); };
    // Triangle fans from each ring's first vertex; stencil parity (see draw) makes concave rings and holes correct.
    const bounds = pts => [Math.min(...pts.map(p=>p[0]))-.001, Math.min(...pts.map(p=>p[1]))-.001, Math.max(...pts.map(p=>p[0]))+.001, Math.max(...pts.map(p=>p[1]))+.001];
    function fan(b, o, r) { for (let i = 1; i < r.length-1; i++) for (const p of [r[0],r[i],r[i+1]]) vert(b,o,p[0],p[1],0,0,0,0,0,1,1,0); }
    function fillObject(b, o, index, rings) {
      const first = count(b), parts = [], union = o.kind === "pad"; // pad primitives union; zone rings are even-odd together
      for (const r of rings) {
        const f = count(b); fan(b,o,r);
        if (union) { const bf = count(b); quad(b,o,bounds(r)); parts.push({first:f, count:bf-f, boxFirst:bf}); }
      }
      if (!union) parts.push({first, count:count(b)-first, boxFirst:count(b)});
      const boxFirst = count(b); quad(b,o,bounds(rings.flat()));
      if (!union) parts[0].boxFirst = boxFirst;
      range(b,o,index,first,{parts,union,boxFirst});
    }
    function text(b, o, t) {
      const [sw,sh] = t.size.map(n => n/1000), lines = t.value.split("\n"), h = lines.length*sh, j = t.justify || [];
      const top = j.includes("top") ? 0 : j.includes("bottom") ? -h : -h/2, th = t.angle*Math.PI/180000, c = Math.cos(th), s = Math.sin(th), mir = t.mirror ? -1 : 1;
      const [ax,ay] = rel(t.at), slant = t.italic ? .2 : 0;
      lines.forEach((line,li) => {
        const left = j.includes("left") ? 0 : j.includes("right") ? -line.length*sw : -line.length*sw/2;
        [...line].forEach((ch,ci) => {
          if (ch === " ") return;
          const slot = glyphSlot(ch, t.bold), col = slot % ATLAS_COLS, row = Math.floor(slot/ATLAS_COLS);
          const u0 = col*CELL_W/ATLAS_W, u1 = (col+1)*CELL_W/ATLAS_W, v0 = row*CELL_H/ATLAS_H, v1 = (row+1)*CELL_H/ATLAS_H;
          // The atlas cell is wider/taller than the glyph body; expand the quad so the body spans the advance.
          const x0 = left+ci*sw-sw/6, x1 = left+(ci+1)*sw+sw/6, y0 = top+li*sh-.3*sh, y1 = top+(li+1)*sh+.3*sh, yc = top+(li+.5)*sh;
          const P = (px,py) => { const x = mir*(px-slant*(py-yc)); return [ax+x*c+py*s, ay-x*s+py*c]; };
          const k = {a:[...P(x0,y0),u0,v0], b:[...P(x1,y0),u1,v0], c:[...P(x1,y1),u1,v1], d:[...P(x0,y1),u0,v1]};
          for (const i of "abcacd") vert(b,o,k[i][0],k[i][1],k[i][2],k[i][3],0,0,0,3,1,0);
        });
      });
    }
    scene.objects.forEach((o,index) => {
      if (o.hidden) return;
      const g = o.geometry;
      const rings = (g.rings || []).filter(r => r.length >= 3).map(r => r.map(rel));
      for (const l of o.layers) {
        for (const s of g.segments || []) append(o,index,l,s);
        const p = g.layerPrimitives?.[l] || g.primitive;
        if (p?.shape === "circle") append(o,index,l,[...p.center,...p.center,p.size[0]]);
        else if (p && p.size[0] > 0 && p.size[1] > 0 && ["rect","oval","roundrect"].includes(p.shape)) { const b = meshBatch(o,l,"mesh"), f = count(b); box(b,o,p); range(b,o,index,f); }
        else if (p?.shape === "trapezoid") { const b = meshBatch(o,l,"mesh"), f = count(b); trapezoid(b,o,p); range(b,o,index,f); }
        if (rings.length) { const b = meshBatch(o,l,"fill"); fillObject(b,o,index,rings); }
        if (g.text) { const b = meshBatch(o,l,"text"), f = count(b); text(b,o,g.text); range(b,o,index,f); }
      }
      // A single drill overlay per object avoids darkened duplicate walls on multilayer pads.
      if (g.drill && o.layers.length) {
        const hole = capsule(g.drill), wall = [...hole]; wall[4] += 100;
        append(o,index,o.layers[0],wall,"wall"); append(o,index,o.layers[0],hole,"hole");
      }
    });
    return [...batches.values()].map(b => ({...b,instances:new Float32Array(b.instances),mesh:new Float32Array(b.mesh)}));
  }
  const header = `#version 300 es
precision highp float;
uniform vec2 cameraCenter;
uniform vec2 viewportSize;
uniform float zoom;
uniform float mirrorX;
out vec2 localPoint;
flat out vec4 shape;
flat out int netIndex;
flat out int categoryIndex;
flat out int sideIndex;
vec4 project(vec2 world){ return vec4((world-cameraCenter)*zoom*vec2(mirrorX,1.0)/viewportSize*vec2(2,-2),0,1); }
`;
  // Instanced capsule (segments, circles, drills): shape=(halfLength,radius,0,0).
  const capsuleVertexSource = header + `
layout(location=0) in vec2 corner;
layout(location=1) in vec4 endpoints;
layout(location=2) in float radius;
layout(location=3) in float netId;
layout(location=4) in float categoryId;
layout(location=5) in float sideId;
layout(location=6) in float objectId;
void main() {
 vec2 delta=endpoints.zw-endpoints.xy;
 float len=length(delta);
 vec2 tangent=len>0.0 ? delta/len : vec2(1,0);
 vec2 normal=vec2(-tangent.y,tangent.x);
 vec2 center=(endpoints.xy+endpoints.zw)*0.5;
 float margin=1.0/zoom;
 localPoint=corner*vec2(len*0.5+radius+margin,radius+margin);
 gl_Position=project(center+tangent*localPoint.x+normal*localPoint.y);
 shape=vec4(len*0.5,radius,0.0,0.0); netIndex=int(netId);
 categoryIndex=int(categoryId); sideIndex=int(sideId);
}`;
  // Triangle mesh (pad boxes, fills, glyphs). Rounded boxes grow by one pixel for anti-aliasing.
  const meshVertexSource = header + `
layout(location=0) in vec2 pos;
layout(location=1) in vec2 local;
layout(location=2) in vec4 shapeIn;
layout(location=3) in vec2 rot;
layout(location=4) in vec3 meta;
void main() {
 float grow=shapeIn.w==2.0 ? 1.0/zoom : 0.0;
 vec2 g=sign(local)*grow;
 localPoint=local+g;
 gl_Position=project(pos+vec2(g.x*rot.x+g.y*rot.y,-g.x*rot.y+g.y*rot.x));
 shape=shapeIn; netIndex=int(meta.x); categoryIndex=int(meta.y); sideIndex=int(meta.z);
}`;
  const fragmentSource = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 localPoint;
flat in vec4 shape;
flat in int netIndex;
flat in int categoryIndex;
flat in int sideIndex;
uniform vec4 layerColor;
uniform float layerOpacity;
uniform vec3 backgroundColor;
uniform float contrastFactor;
uniform sampler2D netStyle;
uniform sampler2D atlas;
uniform int selectedNet;
uniform int zeroNet;
uniform float categoryOpacity[8];
uniform float sideVisible[3];
uniform int drillPass;
uniform bool customEnabled;
uniform vec4 customStyle;
out vec4 outColor;
void main() {
 int mode=int(shape.w);
 float d=-1.0;
 if(mode==0) d=length(vec2(max(abs(localPoint.x)-shape.x,0.0),localPoint.y))-shape.y;
 else if(mode==2){ vec2 q=abs(localPoint)-shape.xy+shape.z; d=length(max(q,0.0))+min(max(q.x,q.y),0.0)-shape.z; }
 float aa=max(fwidth(d),0.000001);
 float coverage=mode==1 ? 1.0 : mode==3 ? texture(atlas,localPoint).a : 1.0-smoothstep(-aa,aa,d);
 vec4 ns=texelFetch(netStyle,ivec2(netIndex,0),0);
 float opacity=categoryOpacity[categoryIndex]*sideVisible[sideIndex];
 if(ns.a==-1.0 || coverage==0.0 || opacity==0.0) discard;
 bool netColor=ns.a>=0.0 && drillPass==0;
 vec3 rgb=netColor ? ns.rgb : layerColor.rgb;
 float retained=selectedNet>=0 && netIndex!=selectedNet && netIndex!=zeroNet ? 0.2 : 1.0;
 if(drillPass==0) rgb=mix(backgroundColor,rgb,contrastFactor*retained);
 outColor=customEnabled ? vec4(customStyle.rgb,customStyle.a*coverage)
   : vec4(rgb,(netColor ? ns.a*layerOpacity : layerColor.a)*opacity*coverage);
}`;
  // Fullscreen dot grid: world position is rebuilt per fragment so it never swims with pan.
  const gridVertexSource = `#version 300 es
layout(location=0) in vec2 corner;
void main(){ gl_Position=vec4(corner,0,1); }`;
  const gridFragmentSource = `#version 300 es
precision highp float;
uniform vec2 viewportSize;
uniform vec2 phase;
uniform float zoom;
uniform float mirrorX;
uniform float spacing;
uniform float dpr;
uniform vec4 color;
out vec4 outColor;
void main() {
 vec2 css=vec2(gl_FragCoord.x,viewportSize.y*dpr-gl_FragCoord.y)/dpr;
 vec2 u=(phase+(css-viewportSize*0.5)*vec2(mirrorX,1.0)/zoom)/spacing;
 float dist=length((fract(u+0.5)-0.5)*spacing*zoom*dpr);
 float a=1.0-smoothstep(0.5,1.0,dist);
 if(a<=0.0) discard;
 outColor=vec4(color.rgb,color.a*a);
}`;
  function create(canvas, opts = {}) {
    let gl;
    try { gl = canvas.getContext("webgl2", {alpha:false, antialias:false, stencil:true, premultipliedAlpha:false}); } catch { return null; }
    if (!gl || !gl.getParameter(gl.STENCIL_BITS)) return null;
    const resources = [], stats = {uploads:0, textureUploads:0, draws:0, vertices:0, instances:0, disposed:false};
    const retained = new Map();
    let disposed = false, failed = false, scene = null, batches = [], appearance = {}, camera = {}, netDirty = true, observer = null, frame = 0, atlasReady = false;
    const own = (type, value) => { if (!value) throw new Error(`Cannot allocate ${type}`); resources.push([type,value]); return value; };
    function dispose() {
      if (disposed) return;
      disposed = true; stats.disposed = true;
      canvas.removeEventListener("webglcontextlost", lost);
      observer?.disconnect(); observer = null;
      if (frame) cancelAnimationFrame(frame); frame = 0;
      for (const [type,value] of resources.splice(0).reverse()) gl[`delete${type}`](value);
      batches = []; retained.clear();
    }
    function failure(error) { if (failed) return; failed = true; dispose(); opts.onFailure?.(error); }
    function lost(event) { event.preventDefault(); failure(new Error("Board WebGL context lost")); }
    canvas.addEventListener("webglcontextlost", lost);
    try {
      const names = ["cameraCenter","viewportSize","zoom","mirrorX","layerColor","layerOpacity","backgroundColor","contrastFactor","netStyle","atlas","selectedNet","zeroNet","categoryOpacity[0]","sideVisible[0]","drillPass","customEnabled","customStyle"];
      function link(vertex, fragment, list) {
        const program = own("Program",gl.createProgram());
        for (const [type,source] of [[gl.VERTEX_SHADER,vertex],[gl.FRAGMENT_SHADER,fragment]]) {
          const shader = own("Shader",gl.createShader(type)); gl.shaderSource(shader,source); gl.compileShader(shader);
          if (!gl.getShaderParameter(shader,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || "Board shader compilation failed");
          gl.attachShader(program,shader);
        }
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program,gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || "Board shader link failed");
        return {program, u:Object.fromEntries(list.map(n=>[n,gl.getUniformLocation(program,n)]))};
      }
      const capsuleProgram = link(capsuleVertexSource,fragmentSource,names), meshProgram = link(meshVertexSource,fragmentSource,names);
      const gridProgram = link(gridVertexSource,gridFragmentSource,["viewportSize","phase","zoom","mirrorX","spacing","dpr","color"]);
      const quad = own("Buffer",gl.createBuffer());
      gl.bindBuffer(gl.ARRAY_BUFFER,quad); gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,1,1,-1,-1,1,1,-1,1]),gl.STATIC_DRAW); stats.uploads++;
      const texture = own("Texture",gl.createTexture());
      gl.bindTexture(gl.TEXTURE_2D,texture);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      const atlas = own("Texture",gl.createTexture());
      gl.bindTexture(gl.TEXTURE_2D,atlas); gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array(4));
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      // System-monospace glyph atlas, generated locally and uploaded once, only when a scene has text.
      function uploadAtlas() {
        if (atlasReady) return;
        const c = document.createElement("canvas"); c.width = ATLAS_W; c.height = ATLAS_H;
        const x = c.getContext("2d"); x.fillStyle = "#fff"; x.textAlign = "center"; x.textBaseline = "middle";
        for (let slot = 0; slot < 190; slot++) {
          x.font = `${slot >= 95 ? "bold " : ""}40px monospace`;
          x.fillText(String.fromCharCode(32 + slot % 95), (slot % ATLAS_COLS)*CELL_W + CELL_W/2, Math.floor(slot/ATLAS_COLS)*CELL_H + CELL_H/2);
        }
        gl.bindTexture(gl.TEXTURE_2D,atlas); gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,c); gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
        stats.textureUploads++; atlasReady = true;
      }
      function setScene(next, revision = "head") {
        if (disposed) return;
        if (!next) { scene = null; batches = []; netDirty = true; return; }
        if (opts.retained && retained.has(next)) { scene = next; batches = retained.get(next); netDirty = true; return; }
        const cpu = buildBatches(next, revision);
        if (next.nets.length > gl.getParameter(gl.MAX_TEXTURE_SIZE)) throw new TypeError("Too many board nets");
        // A scene replacement is the only operation that replaces retained buffers.
        for (const b of (opts.retained ? [] : batches)) for (const [type,value] of [["Buffer",b.buffer],["VertexArray",b.vao]]) {
          gl[`delete${type}`](value); resources.splice(resources.findIndex(r=>r[1]===value),1);
        }
        scene = next; batches = [];
        stats.instances = cpu.reduce((n,b)=>n+b.instances.length/9,0);
        stats.vertices = stats.instances * 6 + cpu.reduce((n,b)=>n+b.mesh.length/MESH,0);
        try {
          if (cpu.some(b=>b.pass === "text")) uploadAtlas();
          for (const b of cpu) {
            b.vao = own("VertexArray",gl.createVertexArray()); gl.bindVertexArray(b.vao);
            if (b.mesh.length) {
              b.buffer = own("Buffer",gl.createBuffer()); gl.bindBuffer(gl.ARRAY_BUFFER,b.buffer);
              gl.bufferData(gl.ARRAY_BUFFER,b.mesh,gl.STATIC_DRAW); stats.uploads++;
              for (const [location,size,offset] of [[0,2,0],[1,2,2],[2,4,4],[3,2,8],[4,3,10]]) { gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location,size,gl.FLOAT,false,MESH*4,offset*4); }
              batches.push(b); continue;
            }
            gl.bindBuffer(gl.ARRAY_BUFFER,quad); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
            b.buffer = own("Buffer",gl.createBuffer()); gl.bindBuffer(gl.ARRAY_BUFFER,b.buffer);
            gl.bufferData(gl.ARRAY_BUFFER,b.instances,gl.STATIC_DRAW); stats.uploads++;
            for (const [location,size,offset] of [[1,4,0],[2,1,4],[3,1,5],[4,1,6],[5,1,7],[6,1,8]]) {
              gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location,size,gl.FLOAT,false,36,offset*4); gl.vertexAttribDivisor(location,1);
            }
            batches.push(b);
          }
          if (opts.retained) retained.set(next, batches);
          netDirty = true;
        } catch (error) { failure(error); }
      }
      const rgba = c => [c[0]/255,c[1]/255,c[2]/255,c[3] ?? 1];
      const gridVao = own("VertexArray",gl.createVertexArray());
      gl.bindVertexArray(gridVao); gl.bindBuffer(gl.ARRAY_BUFFER,quad); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
      // Stencil parity fill: the stencil is cleared per object, so overlapping zones never share parity.
      // ponytail: full-surface clear per object; scissor to the object box if many fills ever profile hot.
      function drawFill(r) {
        gl.enable(gl.STENCIL_TEST); gl.stencilMask(0xff); gl.clearStencil(0); gl.clear(gl.STENCIL_BUFFER_BIT);
        gl.colorMask(false,false,false,false); gl.stencilFunc(gl.ALWAYS,0,0xff);
        if (r.union) {
          // Per ring: bit 0 holds ring parity, then ORs into bit 1 so overlapping pad primitives never cancel.
          for (const part of r.parts) {
            gl.stencilMask(1); gl.clear(gl.STENCIL_BUFFER_BIT);
            gl.stencilFunc(gl.ALWAYS,0,0xff); gl.stencilOp(gl.KEEP,gl.KEEP,gl.INVERT); gl.drawArrays(gl.TRIANGLES,part.first,part.count);
            gl.stencilMask(2); gl.stencilFunc(gl.EQUAL,3,1); gl.stencilOp(gl.KEEP,gl.KEEP,gl.REPLACE); gl.drawArrays(gl.TRIANGLES,part.boxFirst,6);
          }
          gl.colorMask(true,true,true,true); gl.stencilMask(0); gl.stencilFunc(gl.EQUAL,2,2); gl.stencilOp(gl.KEEP,gl.KEEP,gl.KEEP);
        } else {
          gl.stencilOp(gl.KEEP,gl.KEEP,gl.INVERT); gl.drawArrays(gl.TRIANGLES,r.parts[0].first,r.parts[0].count);
          gl.colorMask(true,true,true,true); gl.stencilMask(0); gl.stencilFunc(gl.EQUAL,1,1); gl.stencilOp(gl.KEEP,gl.KEEP,gl.KEEP);
        }
        gl.drawArrays(gl.TRIANGLES,r.boxFirst,6); stats.draws++;
        gl.disable(gl.STENCIL_TEST); gl.stencilMask(0xff);
      }
      // Resize observation: one coalesced rAF draw, never a permanent loop; zero-sized docks keep the last valid camera.
      function scheduleDraw() {
        if (opts.manual || frame || disposed) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          const w = canvas.clientWidth, h = canvas.clientHeight;
          if (w > 0 && h > 0) { camera = {...camera, width:w, height:h}; draw(); }
        });
      }
      if (!opts.manual && typeof ResizeObserver === "function") { observer = new ResizeObserver(scheduleDraw); observer.observe(canvas); }
      function layerRGBA(layer,kind,net) {
        const key=globalThis.KicadColors.layerThemeKeys[layer];
        const color=(net==null?null:appearance.netColors?.[net]) || appearance.colors?.[key] || rgba(appearance.layers?.[layer]?.color || globalThis.KicadColors.layers[layer] || [194,194,194,1]);
        return [...color.slice(0,3),color[3]*(appearance.layerOpacity?.[layer]??appearance.layers?.[layer]?.opacity??1)*(appearance.objectOpacity?.[kind]??1)];
      }
      function draw(options = {}) {
        if (disposed) return false;
        if (options.camera) camera = {...camera,...options.camera};
        const width = camera.width ?? canvas.clientWidth, height = camera.height ?? canvas.clientHeight;
        const dpr = camera.dpr ?? globalThis.devicePixelRatio ?? 1, z = camera.z ?? 1;
        if (!(width > 0 && height > 0 && z > 0 && Number.isFinite(z))) return false;
        const bw = Math.max(1,Math.round(width*dpr)), bh = Math.max(1,Math.round(height*dpr));
        if (canvas.width !== bw) canvas.width = bw;
        if (canvas.height !== bh) canvas.height = bh;
        gl.bindFramebuffer(gl.FRAMEBUFFER, options.target?.framebuffer ?? null);
        gl.disable(gl.SCISSOR_TEST);
        gl.viewport(0,0,bw,bh); gl.disable(gl.DEPTH_TEST); gl.disable(gl.STENCIL_TEST);
        gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA,gl.ONE,gl.ONE_MINUS_SRC_ALPHA); gl.colorMask(true,true,true,true); gl.stencilMask(0xff);
        const background = options.background || appearance.boardBackground || rgba(appearance.background || globalThis.KicadColors.objects.background);
        if (options.clear !== false) { gl.clearColor(...(options.mask ? [0,0,0,1] : background)); gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT); }
        if (!scene) return true;
        const origin = [(scene.bounds[0]/2+scene.bounds[2]/2)/1000,(scene.bounds[1]/2+scene.bounds[3]/2)/1000];
        const mirror = appearance.flip ? -1 : 1, selected = scene.nets.findIndex(n=>n.name===appearance.selectedNet);
        const opacity = categories.map(c=>appearance.objects?.[c]?.visible===false ? 0 : appearance.objects?.[c]?.opacity ?? 1);
        const sideVisible = [1,appearance.objects?.frontFootprints?.visible===false ? 0 : 1,appearance.objects?.backFootprints?.visible===false ? 0 : 1];
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D,atlas);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D,texture);
        for (const {program,u} of [capsuleProgram,meshProgram]) {
          gl.useProgram(program);
          gl.uniform3fv(u.backgroundColor,background.slice(0,3));
          gl.uniform2f(u.viewportSize,width,height); gl.uniform1f(u.zoom,z); gl.uniform1f(u.mirrorX,mirror);
          gl.uniform2f(u.cameraCenter,(camera.x ?? origin[0])-origin[0],(camera.y ?? origin[1])-origin[1]);
          gl.uniform1fv(u["categoryOpacity[0]"],opacity); gl.uniform1fv(u["sideVisible[0]"],sideVisible);
          gl.uniform1i(u.selectedNet,selected); gl.uniform1i(u.zeroNet,scene.nets.findIndex(n=>n.id===0));
          gl.uniform1i(u.netStyle,0); gl.uniform1i(u.atlas,1); gl.uniform1i(u.customEnabled,0);
        }
        const grid = appearance.grid;
        if (options.grid !== false && !options.mask && grid?.visible && grid.size > 0 && grid.size*z >= 4) {
          const {program,u} = gridProgram, cx = camera.x ?? origin[0], cy = camera.y ?? origin[1], g = grid.size;
          gl.useProgram(program); gl.bindVertexArray(gridVao);
          gl.uniform2f(u.viewportSize,width,height); gl.uniform2f(u.phase,((cx%g)+g)%g,((cy%g)+g)%g);
          gl.uniform1f(u.zoom,z); gl.uniform1f(u.mirrorX,mirror); gl.uniform1f(u.spacing,g); gl.uniform1f(u.dpr,dpr);
          gl.uniform4fv(u.color,appearance.colors?.['board.grid'] || rgba(globalThis.KicadColors.objects.grid));
          gl.drawArrays(gl.TRIANGLES,0,6); stats.draws++;
        }
        if (netDirty) {
          const data = new Float32Array(Math.max(1,scene.nets.length)*4);
          for(let i=0;i<scene.nets.length;i++) data[i*4+3]=-2;
          scene.nets.forEach((n,i)=>{
            const style = appearance.nets?.[n.name];
            if (style?.visible === false) data[i*4+3] = -1;
            else if (appearance.netColors?.[n.name] || style?.color) data.set(appearance.netColors?.[n.name] || rgba(style.color),i*4);
          });
          gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,Math.max(1,scene.nets.length),1,0,gl.RGBA,gl.FLOAT,data); stats.textureUploads++; netDirty=false;
        }
        const priority = globalThis.KicadColors.drawPriority;
        const rank = {wall:1,hole:2}, within = {fill:0,text:2};
        const ordered = [...batches].sort((a,b)=> {
          const ra = rank[a.pass] ?? 0, rb = rank[b.pass] ?? 0;
          if (ra || rb) return ra-rb;
          if ((a.layer===appearance.activeLayer)!==(b.layer===appearance.activeLayer)) return a.layer===appearance.activeLayer ? 1 : -1;
          return priority.indexOf(b.layer)-priority.indexOf(a.layer) || (within[a.pass] ?? 1)-(within[b.pass] ?? 1);
        });
        for (const b of ordered) {
          if (options.mask && b.pass === "wall") continue;
          const drill = b.pass === "wall" || b.pass === "hole", capsule = drill || b.pass === "copper";
          const factor = drill ? 1 : layerFactor(b.layer,appearance);
          if (!factor) continue;
          const {program,u} = capsule ? capsuleProgram : meshProgram;
          const color = b.pass === "hole" ? (appearance.colors?.['board.via_hole'] || background) : b.pass === "wall" ? (appearance.colors?.['board.via_hole_walls'] || rgba(globalThis.KicadColors.objects.viaHolewalls)) : layerRGBA(b.layer,null,null);
          gl.useProgram(program);
          gl.uniform4fv(u.layerColor,color); gl.uniform1f(u.layerOpacity,appearance.layers?.[b.layer]?.opacity??1); gl.uniform1f(u.contrastFactor,factor); gl.uniform1i(u.drillPass,drill ? 1 : 0);
          gl.bindVertexArray(b.vao);
          if (options.mask || options.filter || options.override) {
            for (const range of b.ranges) {
              const object = scene.objects[range.objectIndex];
              // Resolve effective visibility BEFORE callbacks. An override cannot revive hidden geometry.
              const netName = scene.nets.find(n=>n.id===object.net)?.name;
              const net = appearance.nets?.[netName];
              const netColor = appearance.netColors?.[netName] || (net?.color ? rgba(net.color) : null);
              const layer = drill ? object.layers.find(l=>layerFactor(l,appearance)>0 && (appearance.layers?.[l]?.opacity ?? 1)>0) : b.layer;
              const layerStyle = appearance.layers?.[layer];
              const base = drill ? layerRGBA(layer,null,null) : color;
              const alpha = (netColor ? netColor[3] * (appearance.layerOpacity?.[layer] ?? layerStyle?.opacity ?? 1) : base[3]) * (appearance.objects?.[object.category]?.opacity ?? 1);
              if (object.hidden || !layer || !layerFactor(layer,appearance) || alpha <= 0 || net?.visible === false || appearance.objects?.[object.category]?.visible === false ||
                  object.side && appearance.objects?.[object.side+"Footprints"]?.visible === false ||
                  options.mask && object.pickable === false || options.filter && !options.filter(object)) continue;
              if (drill && appearance.activeLayer?.endsWith(".Cu") && !range.layers.includes(appearance.activeLayer)) continue;
              const retained = selected >= 0 && object.net !== 0 && scene.nets[selected]?.id !== object.net ? .2 : 1;
              const rgb = !drill && netColor ? netColor.slice(0,3) : color.slice(0,3);
              const normal = {color:rgb.map((v,i)=>background[i]+(v-background[i])*factor*retained), opacity:alpha};
              const style = options.override ? options.override(object,normal) : options.mask ? {color:[1,1,1],opacity:1} : normal;
              // Drills subtract from masks; they never become independent hit targets.
              gl.uniform1i(u.customEnabled,1);
              gl.uniform4fv(u.customStyle,options.mask && drill ? [0,0,0,1] : [...style.color,style.opacity]);
              if (capsule) {
                gl.bindBuffer(gl.ARRAY_BUFFER,b.buffer);
                for (const [loc,size,offset] of [[1,4,0],[2,1,4],[3,1,5],[4,1,6],[5,1,7],[6,1,8]]) gl.vertexAttribPointer(loc,size,gl.FLOAT,false,36,range.start*36+offset*4);
                gl.drawArraysInstanced(gl.TRIANGLES,0,6,range.count); stats.draws++;
              } else if (b.pass === "fill") drawFill(range);
              else { gl.drawArrays(gl.TRIANGLES,range.first,range.count); stats.draws++; }
            }
            gl.uniform1i(u.customEnabled,0);
          } else if (drill) {
            // Blind/buried drills exist only in their physical copper span. Explicit
            // layer eyes still apply before the high-contrast Edge.Cuts exception.
            for (const range of b.ranges) {
              if (!range.layers.some(l=>appearance.layers?.[l]?.visible!==false) || appearance.activeLayer?.endsWith(".Cu") && !range.layers.includes(appearance.activeLayer)) continue;
              // Rebase instanced attributes instead of uploading per-object data.
              gl.bindBuffer(gl.ARRAY_BUFFER,b.buffer);
              for (const [loc,size,offset] of [[1,4,0],[2,1,4],[3,1,5],[4,1,6],[5,1,7],[6,1,8]]) gl.vertexAttribPointer(loc,size,gl.FLOAT,false,36,range.start*36+offset*4);
              gl.drawArraysInstanced(gl.TRIANGLES,0,6,range.count); stats.draws++;
            }
          } else if (capsule) {
            gl.bindBuffer(gl.ARRAY_BUFFER,b.buffer);
            for (const [loc,size,offset] of [[1,4,0],[2,1,4],[3,1,5],[4,1,6],[5,1,7],[6,1,8]]) gl.vertexAttribPointer(loc,size,gl.FLOAT,false,36,offset*4);
            gl.drawArraysInstanced(gl.TRIANGLES,0,6,b.instances.length/9); stats.draws++;
          }
          else if (b.pass === "fill") for (const r of b.ranges) drawFill(r);
          else { gl.drawArrays(gl.TRIANGLES,0,b.mesh.length/MESH); stats.draws++; }
        }
        gl.bindVertexArray(null);
        return true;
      }
      const projectionCamera = () => ({...camera,flip:!!appearance.flip});
      function hitTest(point) {
        if (disposed || !scene) return [];
        const [x,y] = Array.isArray(point) ? point : [point.x,point.y];
        const c = projectionCamera();
        if (![x,y].every(Number.isFinite) || x<0 || y<0 || x>=c.width || y>=c.height) return [];
        const [wx,wy] = screenToWorld([x,y],c), hits = [];
        // ponytail: bbox-pruned per-leaf mask readback reuses exact retained shaders/holes.
        // Replace with a single ID target only if profiling large-board clicks warrants it.
        try {
          for (const object of scene.objects) {
            const [x0,y0,x1,y1] = object.box.map(n=>n/1000);
            if (object.hidden || object.pickable === false || wx<x0 || wx>x1 || wy<y0 || wy>y1) continue;
            draw({mask:true,filter:o=>o===object});
            const dpr = c.dpr ?? globalThis.devicePixelRatio ?? 1;
            if (api.readPixel(Math.floor(x*dpr),canvas.height-1-Math.floor(y*dpr))[0]>127) hits.push(object);
          }
        } finally { draw(); }
        const priority = globalThis.KicadColors.drawPriority;
        const front = o => Math.max(...o.layers.filter(l=>layerFactor(l,appearance)>0).map(l=>l===appearance.activeLayer ? priority.length+1 : priority.length-priority.indexOf(l)));
        const area = o => (o.box[2]-o.box[0])*(o.box[3]-o.box[1]);
        return hits.sort((a,b)=>front(b)-front(a) || area(a)-area(b) || a.uuid.localeCompare(b.uuid));
      }
      const api = {
        gl, stats, setScene, setCamera(next) { camera = {...next}; },
        get appearance() { return structuredClone(appearance); },
        layerRGBA,
        setAppearance(state) { appearance = structuredClone(state || {}); netDirty = true; scheduleDraw(); },
        draw, dispose, hitTest,
        worldToScreen(point) { return worldToScreen(point,projectionCamera()); },
        screenToWorld(point) { return screenToWorld(point,projectionCamera()); },
        readPixel(x,y) {
          const pixel = new Uint8Array(4);
          if (!disposed) gl.readPixels(x,y,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
          return Array.from(pixel);
        }
      };
      if (opts.scene) setScene(opts.scene,opts.revision);
      return disposed ? null : api;
    } catch (error) { failure(error); return null; }
  }
  globalThis.BoardGL = {create,validateScene,buildBatches,layerFactor,worldToScreen,screenToWorld,categories,sides};
})();
