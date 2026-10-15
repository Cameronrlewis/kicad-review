// Retained PCB drawing primitives. Classic script; no report or DOM ownership.
// create(canvas,{scene?,revision?,onFailure?}) -> renderer|null.
// setScene uploads geometry; setCamera({x,y,z,width,height,dpr}) never does.
// All drawing settings, including flip, enter ONLY through setAppearance(state).
// draw({camera?}) paints the retained scene; readPixel uses backing-pixel GL coordinates.
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
      if (text && (!point(text.at) || !point(text.size))) fail();
      vertices += (o.geometry.segments?.length || 0) * 2;
      vertices += (o.geometry.rings || []).reduce((n,r)=>n+r.length,0);
      vertices += (o.geometry.primitive ? 4 : 0) + (o.geometry.drill ? 4 : 0) + (text ? 4 : 0);
      if (vertices > MAX_VERTICES) fail();
    }
    return scene;
  }
  function layerFactor(layer, state = {}) {
    if (state.layers?.[layer]?.visible === false) return 0;
    if (!state.activeLayer || layer === state.activeLayer || !["dim", "hide"].includes(state.contrast)) return 1;
    return layer === "Edge.Cuts" ? .3 : state.contrast === "hide" ? 0 : .2;
  }
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
    scene.objects.forEach((o,index) => {
      if (o.hidden) return;
      const g = o.geometry;
      for (const l of o.layers) {
        for (const s of g.segments || []) append(o,index,l,s);
        const p = g.layerPrimitives?.[l] || g.primitive;
        if (p?.shape === "circle") append(o,index,l,[...p.center,...p.center,p.size[0]]);
      }
      // A single drill overlay per object avoids darkened duplicate walls on multilayer pads.
      if (g.drill && o.layers.length) {
        const hole = capsule(g.drill), wall = [...hole]; wall[4] += 100;
        append(o,index,o.layers[0],wall,"wall"); append(o,index,o.layers[0],hole,"hole");
      }
    });
    return [...batches.values()].map(b => ({...b,instances:new Float32Array(b.instances)}));
  }
  const vertexSource = `#version 300 es
precision highp float;
layout(location=0) in vec2 corner;
layout(location=1) in vec4 endpoints;
layout(location=2) in float radius;
layout(location=3) in float netId;
layout(location=4) in float categoryId;
layout(location=5) in float sideId;
layout(location=6) in float objectId;
uniform vec2 cameraCenter;
uniform vec2 viewportSize;
uniform float zoom;
uniform float mirrorX;
out vec2 localPoint;
flat out float halfLength;
flat out float r;
flat out int netIndex;
flat out int categoryIndex;
flat out int sideIndex;
void main() {
 vec2 delta=endpoints.zw-endpoints.xy;
 float len=length(delta);
 vec2 tangent=len>0.0 ? delta/len : vec2(1,0);
 vec2 normal=vec2(-tangent.y,tangent.x);
 vec2 center=(endpoints.xy+endpoints.zw)*0.5;
 float margin=1.0/zoom;
 localPoint=corner*vec2(len*0.5+radius+margin,radius+margin);
 vec2 world=center+tangent*localPoint.x+normal*localPoint.y;
 gl_Position=vec4((world-cameraCenter)*zoom*vec2(mirrorX,1.0)/viewportSize*vec2(2,-2),0,1);
 halfLength=len*0.5; r=radius; netIndex=int(netId);
 categoryIndex=int(categoryId); sideIndex=int(sideId);
}`;
  const fragmentSource = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 localPoint;
flat in float halfLength;
flat in float r;
flat in int netIndex;
flat in int categoryIndex;
flat in int sideIndex;
uniform vec4 layerColor;
uniform vec3 backgroundColor;
uniform float contrastFactor;
uniform sampler2D netStyle;
uniform int selectedNet;
uniform int zeroNet;
uniform float categoryOpacity[8];
uniform float sideVisible[3];
uniform int drillPass;
out vec4 outColor;
void main() {
 float d=length(vec2(max(abs(localPoint.x)-halfLength,0.0),localPoint.y))-r;
 float aa=max(fwidth(d),0.000001);
 float coverage=1.0-smoothstep(-aa,aa,d);
 vec4 ns=texelFetch(netStyle,ivec2(netIndex,0),0);
 float opacity=categoryOpacity[categoryIndex]*sideVisible[sideIndex];
 if(ns.a<0.0 || coverage==0.0 || opacity==0.0) discard;
 vec3 rgb=ns.a>0.0 && drillPass==0 ? ns.rgb : layerColor.rgb;
 float retained=selectedNet>=0 && netIndex!=selectedNet && netIndex!=zeroNet ? 0.2 : 1.0;
 if(drillPass==0) rgb=mix(backgroundColor,rgb,contrastFactor*retained);
 outColor=vec4(rgb,layerColor.a*opacity*coverage*(ns.a>0.0 ? ns.a : 1.0));
}`;
  function create(canvas, opts = {}) {
    let gl;
    try { gl = canvas.getContext("webgl2", {alpha:false, antialias:false, stencil:true, premultipliedAlpha:false}); } catch { return null; }
    if (!gl || !gl.getParameter(gl.STENCIL_BITS)) return null;
    const resources = [], stats = {uploads:0, textureUploads:0, draws:0, vertices:0, instances:0, disposed:false};
    let disposed = false, failed = false, scene = null, batches = [], appearance = {}, camera = {}, netDirty = true;
    const own = (type, value) => { if (!value) throw new Error(`Cannot allocate ${type}`); resources.push([type,value]); return value; };
    function dispose() {
      if (disposed) return;
      disposed = true; stats.disposed = true;
      canvas.removeEventListener("webglcontextlost", lost);
      for (const [type,value] of resources.splice(0).reverse()) gl[`delete${type}`](value);
      batches = [];
    }
    function failure(error) { if (failed) return; failed = true; dispose(); opts.onFailure?.(error); }
    function lost(event) { event.preventDefault(); failure(new Error("Board WebGL context lost")); }
    canvas.addEventListener("webglcontextlost", lost);
    try {
      const program = own("Program",gl.createProgram());
      for (const [type,source] of [[gl.VERTEX_SHADER,vertexSource],[gl.FRAGMENT_SHADER,fragmentSource]]) {
        const shader = own("Shader",gl.createShader(type)); gl.shaderSource(shader,source); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || "Board shader compilation failed");
        gl.attachShader(program,shader);
      }
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program,gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || "Board shader link failed");
      const uniforms = Object.fromEntries(["cameraCenter","viewportSize","zoom","mirrorX","layerColor","backgroundColor","contrastFactor","netStyle","selectedNet","zeroNet","categoryOpacity[0]","sideVisible[0]","drillPass"].map(n=>[n,gl.getUniformLocation(program,n)]));
      const quad = own("Buffer",gl.createBuffer());
      gl.bindBuffer(gl.ARRAY_BUFFER,quad); gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,1,1,-1,-1,1,1,-1,1]),gl.STATIC_DRAW); stats.uploads++;
      const texture = own("Texture",gl.createTexture());
      gl.bindTexture(gl.TEXTURE_2D,texture);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      function setScene(next, revision = "head") {
        if (disposed) return;
        const cpu = buildBatches(next, revision);
        if (next.nets.length > gl.getParameter(gl.MAX_TEXTURE_SIZE)) throw new TypeError("Too many board nets");
        // A scene replacement is the only operation that replaces retained buffers.
        for (const b of batches) for (const [type,value] of [["Buffer",b.buffer],["VertexArray",b.vao]]) {
          gl[`delete${type}`](value); resources.splice(resources.findIndex(r=>r[1]===value),1);
        }
        scene = next; batches = [];
        stats.instances = cpu.reduce((n,b)=>n+b.instances.length/9,0);
        stats.vertices = stats.instances * 6;
        try {
          for (const b of cpu) {
            b.vao = own("VertexArray",gl.createVertexArray()); gl.bindVertexArray(b.vao);
            gl.bindBuffer(gl.ARRAY_BUFFER,quad); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
            b.buffer = own("Buffer",gl.createBuffer()); gl.bindBuffer(gl.ARRAY_BUFFER,b.buffer);
            gl.bufferData(gl.ARRAY_BUFFER,b.instances,gl.STATIC_DRAW); stats.uploads++;
            for (const [location,size,offset] of [[1,4,0],[2,1,4],[3,1,5],[4,1,6],[5,1,7],[6,1,8]]) {
              gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location,size,gl.FLOAT,false,36,offset*4); gl.vertexAttribDivisor(location,1);
            }
            batches.push(b);
          }
          netDirty = true;
        } catch (error) { failure(error); }
      }
      const rgba = c => [c[0]/255,c[1]/255,c[2]/255,c[3] ?? 1];
      function draw(options = {}) {
        if (disposed || !scene) return false;
        if (options.camera) camera = {...camera,...options.camera};
        const width = camera.width ?? canvas.clientWidth, height = camera.height ?? canvas.clientHeight;
        const dpr = camera.dpr ?? globalThis.devicePixelRatio ?? 1, z = camera.z ?? 1;
        if (!(width > 0 && height > 0 && z > 0 && Number.isFinite(z))) return false;
        const bw = Math.max(1,Math.round(width*dpr)), bh = Math.max(1,Math.round(height*dpr));
        if (canvas.width !== bw) canvas.width = bw;
        if (canvas.height !== bh) canvas.height = bh;
        gl.viewport(0,0,bw,bh); gl.disable(gl.DEPTH_TEST); gl.disable(gl.STENCIL_TEST);
        gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA); gl.useProgram(program);
        const background = rgba(globalThis.KicadColors.objects.background);
        gl.clearColor(...background); gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
        gl.uniform3fv(uniforms.backgroundColor,background.slice(0,3));
        gl.uniform2f(uniforms.viewportSize,width,height); gl.uniform1f(uniforms.zoom,z); gl.uniform1f(uniforms.mirrorX,appearance.flip ? -1 : 1);
        const origin = [(scene.bounds[0]/2+scene.bounds[2]/2)/1000,(scene.bounds[1]/2+scene.bounds[3]/2)/1000];
        gl.uniform2f(uniforms.cameraCenter,(camera.x ?? origin[0])-origin[0],(camera.y ?? origin[1])-origin[1]);
        gl.uniform1fv(uniforms["categoryOpacity[0]"],categories.map(c=>appearance.objects?.[c]?.visible===false ? 0 : appearance.objects?.[c]?.opacity ?? 1));
        gl.uniform1fv(uniforms["sideVisible[0]"],[1,appearance.objects?.frontFootprints?.visible===false ? 0 : 1,appearance.objects?.backFootprints?.visible===false ? 0 : 1]);
        const selected = scene.nets.findIndex(n=>n.name===appearance.selectedNet);
        gl.uniform1i(uniforms.selectedNet,selected); gl.uniform1i(uniforms.zeroNet,scene.nets.findIndex(n=>n.id===0));
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D,texture); gl.uniform1i(uniforms.netStyle,0);
        if (netDirty) {
          const data = new Float32Array(Math.max(1,scene.nets.length)*4);
          scene.nets.forEach((n,i)=>{
            const style = appearance.nets?.[n.name];
            if (style?.visible === false) data[i*4+3] = -1;
            else if (style?.color) data.set(rgba(style.color),i*4);
          });
          gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,Math.max(1,scene.nets.length),1,0,gl.RGBA,gl.FLOAT,data); stats.textureUploads++; netDirty=false;
        }
        const priority = globalThis.KicadColors.drawPriority;
        const ordered = [...batches].sort((a,b)=> {
          if (a.pass !== "copper" || b.pass !== "copper") return ({copper:0,wall:1,hole:2}[a.pass]-{copper:0,wall:1,hole:2}[b.pass]);
          if ((a.layer===appearance.activeLayer)!==(b.layer===appearance.activeLayer)) return a.layer===appearance.activeLayer ? 1 : -1;
          return priority.indexOf(b.layer)-priority.indexOf(a.layer);
        });
        for (const b of ordered) {
          const drill = b.pass !== "copper";
          const factor = drill ? 1 : layerFactor(b.layer,appearance);
          if (!factor) continue;
          const color = b.pass === "hole" ? background : b.pass === "wall" ? rgba(globalThis.KicadColors.objects.viaHolewalls) : rgba(appearance.layers?.[b.layer]?.color || globalThis.KicadColors.layers[b.layer] || [194,194,194,1]);
          if (!drill) color[3] *= appearance.layers?.[b.layer]?.opacity ?? 1;
          gl.uniform4fv(uniforms.layerColor,color); gl.uniform1f(uniforms.contrastFactor,factor); gl.uniform1i(uniforms.drillPass,drill ? 1 : 0);
          gl.bindVertexArray(b.vao);
          if (drill) {
            // Blind/buried drills exist only in their physical copper span. Explicit
            // layer eyes still apply before the high-contrast Edge.Cuts exception.
            for (const range of b.ranges) {
              if (!range.layers.some(l=>appearance.layers?.[l]?.visible!==false) || appearance.activeLayer?.endsWith(".Cu") && !range.layers.includes(appearance.activeLayer)) continue;
              // Rebase instanced attributes instead of uploading per-object data.
              gl.bindBuffer(gl.ARRAY_BUFFER,b.buffer);
              for (const [loc,size,offset] of [[1,4,0],[2,1,4],[3,1,5],[4,1,6],[5,1,7],[6,1,8]]) gl.vertexAttribPointer(loc,size,gl.FLOAT,false,36,range.start*36+offset*4);
              gl.drawArraysInstanced(gl.TRIANGLES,0,6,range.count); stats.draws++;
            }
          } else { gl.drawArraysInstanced(gl.TRIANGLES,0,6,b.instances.length/9); stats.draws++; }
        }
        gl.bindVertexArray(null);
        return true;
      }
      const api = {
        stats, setScene, setCamera(next) { camera = {...next}; },
        setAppearance(state) { appearance = structuredClone(state || {}); netDirty = true; },
        draw, dispose,
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
  globalThis.BoardGL = {create,validateScene,buildBatches,layerFactor,categories,sides};
})();
