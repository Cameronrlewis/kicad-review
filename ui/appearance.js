// window.Appearance: the one store for board/schematic look. Classic script, loaded before review.js.
// get/patch/subscribe/reset; defaults(names) is the single source of default state (Task 8 adds controls).
(() => {
  "use strict";
  const KEY = "kr.appearance.v1";
  const OBJECT_ROWS = [
    ["tracks","Tracks",1],["vias","Vias",1],["pads","Pads",1],
    ["zones","Zones",.6],["filledShapes","Filled Shapes",1],["images","Images",.6],
    ["frontFootprints","Footprints Front"],["backFootprints","Footprints Back"],
    ["values","Values"],["references","References"],["footprintText","Footprint Text"],
    ["ratsnest","Ratsnest"],["drcMarkers","DRC markers"],["drawingSheet","Drawing Sheet"],["grid","Grid"]
  ];
  const names = () => globalThis.KicadColors.appearanceOrder;
  function defaults(layerNames = names()) {
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
    const out = structuredClone(base);
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
  let state, layerNames = names(), listeners = new Set();
  const read = () => { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } };
  const write = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {} };
  const snapshot = () => structuredClone(state);
  const notify = () => { for (const fn of [...listeners]) fn(snapshot()); return snapshot(); };
  state = merge(defaults(), read());
  state.selectedNet = null;   // transient
  globalThis.Appearance = {
    OBJECT_ROWS, defaults, normalize: (input, layerNames) => merge(defaults(layerNames), input),
    get: snapshot,
    configure(boardLayers) { layerNames = [...new Set([...names(), ...boardLayers])]; state = merge(defaults(layerNames), read()); state.selectedNet = null; return snapshot(); },
    patch(partial) { state = merge(state, partial); write(); return notify(); },
    reset() { state = defaults(layerNames); write(); return notify(); },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  };
})();
