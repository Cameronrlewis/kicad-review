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
function defaults() {
  return {colors:clone(DEFAULTS),layerOpacity:{},netColors:{},
    objectOpacity:{tracks:1,vias:1,pads:1,zones:.6,shapes:1,images:.6},
    markStyle:'outline'};
}
function validateState(value) {
  if(!object(value)||!object(value.colors)||!object(value.layerOpacity)||
     !object(value.objectOpacity)||!object(value.netColors)||
     !['outline','recolour'].includes(value.markStyle)) throw new Error('Invalid appearance.');
  const out=defaults();
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
  return out;
}
window.KrAppearance = {parseColor, parseTheme, defaults, validateState};
})();
