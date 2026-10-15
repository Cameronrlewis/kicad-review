// Strict KiCad colour-theme parsing and detached appearance snapshots.
(() => {
'use strict';
const DEFAULTS = window.KicadColors.themeDefaults;
const clone = value => JSON.parse(JSON.stringify(value));
const object = x => !!x && typeof x === 'object' && !Array.isArray(x);
const own = (x,k) => Object.prototype.hasOwnProperty.call(x,k);
const number = (x,lo,hi) => typeof x === 'number' && Number.isFinite(x) && x>=lo && x<=hi;
function parseColor(value) {
  if (typeof value !== 'string') throw new Error('Expected a colour string.');
  const s = value.trim();
  if (/^#[0-9a-f]{3,4}$/i.test(s)) {
    const a = [...s.slice(1)].map(c=>parseInt(c+c,16)/255);
    if(a.length===3) a.push(1);
    return a;
  }
  if (/^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s)) {
    const a = s.slice(1).match(/../g).map(c=>parseInt(c,16)/255);
    if(a.length===3) a.push(1);
    return a;
  }
  const m = /^(rgb|rgba)\(([^()]*)\)$/i.exec(s);
  if (!m) throw new Error('Use rgb(), rgba(), or a hex colour.');
  const parts = m[2].split(',').map(x=>x.trim());
  if(parts.length !== (m[1].toLowerCase()==='rgb'?3:4) ||
     parts.some(x=>!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(x))) throw new Error('Invalid colour components.');
  const a = parts.map(Number);
  if(!a.slice(0,3).every(x=>number(x,0,255)) ||
     (a.length===4&&!number(a[3],0,1))) throw new Error('Colour is out of range.');
  return [a[0]/255,a[1]/255,a[2]/255,a.length===4?a[3]:1];
}
function parseTheme(text) {
  if(typeof text!=='string'||text.length>1048576) throw new Error('Theme exceeds 1 MiB.');
  let bytes=0;
  for(const char of text) {
    const code=char.codePointAt(0);
    bytes += code<=0x7f ? 1 : code<=0x7ff ? 2 : code<=0xffff ? 3 : 4;
    if(bytes>1048576) throw new Error('Theme exceeds 1 MiB.');
  }
  let doc;
  try { doc=JSON.parse(text.replace(/^\uFEFF/,'')); }
  catch { throw new Error('Invalid JSON. Choose a KiCad colour theme.'); }
  if(!object(doc)||!object(doc.meta)||doc.meta.version!==5)
    throw new Error('Expected KiCad colour theme version 5.');
  for(const section of ['board','schematic'])
    if(own(doc,section)&&!object(doc[section])) throw new Error('Invalid '+section+' section.');
  if(own(doc.board||{},'copper')&&!object(doc.board.copper))
    throw new Error('Invalid board.copper section.');
  const result=clone(DEFAULTS);
  let found=0;
  for(const key of Object.keys(DEFAULTS)) {
    let value=doc, present=true;
    for(const part of key.split('.')) {
      if(!object(value)||!own(value,part)) { present=false; break; }
      value=value[part];
    }
    if(present) {
      try { result[key]=parseColor(value); }
      catch(error) { throw new Error(key+': '+error.message); }
      found++;
    }
  }
  if(!found) throw new Error('No supported board or schematic colours found.');
  return result;
}
  const OBJECT_ROWS = [
    ["tracks","Tracks",1],["vias","Vias",1],["pads","Pads",1],
    ["zones","Zones",.6],["filledShapes","Filled Shapes",1],["images","Images",.6],
    ["frontFootprints","Footprints Front"],["backFootprints","Footprints Back"],
    ["values","Values"],["references","References"],["footprintText","Footprint Text"],
    ["ratsnest","Ratsnest"],["drcMarkers","DRC markers"],["drawingSheet","Drawing Sheet"],["grid","Grid"]
  ];
  const names = () => globalThis.KicadColors.appearanceOrder;
  function boardDefaults(layerNames = names()) {
    const L = globalThis.KicadColors.layers;
    return {version:1, activeLayer:layerNames.includes("F.Cu") ? "F.Cu" : layerNames[0] || null,
      contrast:"normal", flip:false, units:"mm", grid:{visible:false, size:.5}, markStyle:"outline",
      layers:Object.fromEntries(layerNames.map(n => [n, {visible:true, color:[...(L[n] || [194,194,194,1])], opacity:1}])),
      objects:Object.fromEntries(OBJECT_ROWS.map(([id,,opacity]) => [id, {visible:true, opacity:opacity ?? 1}])),
      nets:{}, selectedNet:null};
  }
  const plain = v => v && typeof v === "object" && !Array.isArray(v);
  // Copy only keys the defaults know (nets/layers/objects are keyed records); wrong types fall back to the default.
  function merge(base, input) {
    const out = clone(base);
    if (!plain(input)) return out;
    for (const k of ["activeLayer","selectedNet"]) if (input[k] === null || typeof input[k] === "string") out[k] = input[k];
    for (const [k, ok] of [["contrast",["normal","dim","hide"]],["units",["mm","in","mil"]],["markStyle",["outline","recolour"]]]) if (ok.includes(input[k])) out[k] = input[k];
    if (typeof input.flip === "boolean") out.flip = input.flip;
    if (plain(input.grid)) {
      if (typeof input.grid.visible === "boolean") out.grid.visible = input.grid.visible;
      if (Number.isFinite(input.grid.size) && input.grid.size > 0) out.grid.size = input.grid.size;
    }
    const num = (v, lo, hi) => Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined;
    for (const group of ["layers","objects","nets"]) if (plain(input[group])) for (const [name, s] of Object.entries(input[group])) {
      if (!plain(s) || name === "__proto__" || (group !== "nets" && !Object.hasOwn(out[group], name))) continue;
      const t = Object.hasOwn(out[group], name) ? out[group][name] : (out[group][name] = {});
      if (typeof s.visible === "boolean") t.visible = s.visible;
      const o = num(s.opacity, 0, 1); if (o !== undefined && group !== "nets") t.opacity = o;
      if (Array.isArray(s.color) && s.color.length === 4 && s.color.every(Number.isFinite))
        t.color = s.color.map((v, i) => i < 3 ? Math.round(num(v, 0, 255)) : num(v, 0, 1));
    }
    return out;
  }

function defaults() {
  return {...boardDefaults(),colors:clone(DEFAULTS),layerOpacity:{},netColors:{},
    objectOpacity:{tracks:1,vias:1,pads:1,zones:.6,shapes:1,images:.6},
    markStyle:'outline'};
}
function validateState(value) {
  if(!object(value)||!object(value.colors)||!object(value.layerOpacity)||
     !object(value.objectOpacity)||!object(value.netColors)||
     !['outline','recolour'].includes(value.markStyle)) throw new Error('Invalid appearance.');
  const out={...defaults(),...merge(boardDefaults(),value)};
  const rgba = a=>Array.isArray(a)&&a.length===4&&Array.from(a).every(x=>number(x,0,1));
  for(const k of Object.keys(DEFAULTS)) {
    if(!own(value.colors,k)||!rgba(value.colors[k])) throw new Error('Invalid colour '+k);
    out.colors[k]=value.colors[k].slice();
  }
  for(const k of Object.keys(out.objectOpacity)) {
    if(!number(value.objectOpacity[k],0,1)) throw new Error('Invalid object opacity.');
    out.objectOpacity[k]=value.objectOpacity[k];
  }
  for(const [k,v] of Object.entries(value.layerOpacity)) {
    if(!own(window.KicadColors.layerThemeKeys,k)||!number(v,0,1))
      throw new Error('Invalid layer opacity.');
    out.layerOpacity[k]=v;
  }
  // A null-prototype map avoids special names such as __proto__ in net data.
  out.netColors=Object.create(null);
  for(const [k,v] of Object.entries(value.netColors)) {
    if(k.length>512||!rgba(v)) throw new Error('Invalid net colour.');
    out.netColors[k]=v.slice();
  }
  out.markStyle=value.markStyle;
  // Legacy panel fields are views of the same canonical palette and opacity.
  for(const [layer,key] of Object.entries(window.KicadColors.layerThemeKeys)) {
    out.layers[layer] ??= {visible:true,opacity:1};
    out.layers[layer].color=out.colors[key].map((v,i)=>i<3?Math.round(v*255):v);
    out.layers[layer].opacity=out.layerOpacity[layer]??1;
  }
  for(const [kind,opacity] of Object.entries(out.objectOpacity))
    out.objects[kind==='shapes'?'filledShapes':kind].opacity=opacity;
  out.nets=Object.assign(Object.create(null),out.nets);
  for(const [net,rgba] of Object.entries(out.netColors))
    out.nets[net]={...out.nets[net],color:rgba.map((v,i)=>i<3?Math.round(v*255):v)};
  return out;
}
const STORAGE_KEY='kr.appearance.v1';
function readEnvelope(storage) {
  const empty=()=>({version:1,viewers:Object.create(null)});
  try {
    const raw=storage().getItem(STORAGE_KEY);
    if(!raw||raw.length>4194304) return empty();
    const doc=JSON.parse(raw);
    if(!object(doc)||doc.version!==1||!object(doc.viewers)) return empty();
    const envelope=empty();
    for(const [id,value] of Object.entries(doc.viewers)) {
      try { envelope.viewers[id]=validateState(value); }
      catch { /* A corrupt viewer must not poison other projects. */ }
    }
    return envelope;
  } catch { return empty(); }
}
class ThemeImportError extends Error {
  constructor(message) { super(message); this.name='ThemeImportError'; }
}
function createStore({viewerId,storage=()=>window.localStorage}) {
  let state=validateState(readEnvelope(storage).viewers[viewerId]||defaults());
  const listeners=new Set();
  function get() { return clone(state); }
  function set(next) {
    const candidate=validateState(next);
    state=candidate;
    try {
      // Read again so another viewer's intervening edits survive this write.
      const envelope=readEnvelope(storage);
      envelope.viewers[viewerId]=candidate;
      storage().setItem(STORAGE_KEY,JSON.stringify(envelope));
    } catch { /* Session edits still work when persistence is blocked. */ }
    for(const listener of listeners) listener(clone(candidate));
    return get();
  }
  function patch(partial) {
    if(!object(partial)) throw new Error('Invalid appearance patch.');
    const next={...state,...partial};
    for(const key of ['colors','layerOpacity','objectOpacity','netColors']) {
      if(own(partial,key)) {
        if(!object(partial[key])) throw new Error('Invalid appearance patch.');
        next[key]={...state[key],...partial[key]};
      }
    }
    const legacy=merge(state,partial);
    for(const layer of Object.keys(partial.layers||{})) {
      const style=legacy.layers[layer]; if(!style) continue;
      const key=window.KicadColors.layerThemeKeys[layer];
      if(key && style.color && !own(partial.colors||{},key)) next.colors={...next.colors,[key]:style.color.map((v,i)=>i<3?v/255:v)};
      if(key && own(partial.layers[layer],'opacity') && !own(partial.layerOpacity||{},layer)) next.layerOpacity={...next.layerOpacity,[layer]:style.opacity};
    }
    for(const kind of Object.keys(partial.objects||{})) {
      const style=legacy.objects[kind]; if(!style) continue;
      const key=kind==='filledShapes'?'shapes':kind;
      if(own(next.objectOpacity,key)&&own(style,'opacity')&&!own(partial.objectOpacity||{},key)) next.objectOpacity={...next.objectOpacity,[key]:style.opacity};
    }
    for(const net of Object.keys(partial.nets||{})) {
      const style=Object.hasOwn(legacy.nets,net)&&legacy.nets[net];
      if(style?.color&&!own(partial.netColors||{},net)) next.netColors={...next.netColors,[net]:style.color.map((v,i)=>i<3?v/255:v)};
    }
    // Merge legacy record patches without replacing their siblings.
    for(const group of ['layers','objects','nets']) if(own(partial,group))
      next[group]=merge(state,{[group]:partial[group]})[group];
    return set(next);
  }
  return {
    get, set, patch,
    import(text) {
      let colors;
      try { colors=parseTheme(text); }
      catch(error) { throw new ThemeImportError(error.message); }
      return set({...state,colors});
    },
    reset:()=>set(defaults()),
    subscribe(listener) { listeners.add(listener); return ()=>listeners.delete(listener); }
  };
}
function resolve(state) {
  const value=validateState(state);
  const over=(fg,bg)=>fg.slice(0,3).map((v,i)=>v*fg[3]+bg[i]*(1-fg[3])).concat(1);
  return {...value,boardBackground:over(value.colors['board.background'],DEFAULTS['board.background']),
    schematicBackground:over(value.colors['schematic.background'],DEFAULTS['schematic.background'])};
}
window.KrAppearance = {resolve, OBJECT_ROWS, boardDefaults, normalizeBoard:(input,layerNames)=>merge(boardDefaults(layerNames),input), parseColor, parseTheme, defaults, validateState, createStore, ThemeImportError};
})();
