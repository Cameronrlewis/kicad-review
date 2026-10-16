// Single public store facade; project stores share the validated Stage 7 model.
(() => {
  "use strict";
  const stores = new Map(), listeners = new Set();
  let current, unsubscribe = () => {};
  function configure(boardLayers = [], viewerId = 'default') {
    if (!stores.has(viewerId)) stores.set(viewerId, KrAppearance.createStore({viewerId}));
    if (current !== stores.get(viewerId)) {
      unsubscribe(); current = stores.get(viewerId);
      unsubscribe = current.subscribe(state => { for (const fn of [...listeners]) fn(structuredClone(state)); });
    }
    return current.get();
  }
  // ---- controls: createElement/textContent only, so hostile layer or net names stay literal text ----
  const OBJECT_ROWS = KrAppearance.OBJECT_ROWS;
  const SVGNS = "http:" + "//www.w3.org/2000/svg";   // split: the offline report must contain no URL literal
  const h = (tag, props = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") e.className = v;
      else if (k === "role" || k.startsWith("aria-") || k.startsWith("data-")) e.setAttribute(k, v);
      else e[k] = v;
    }
    e.append(...kids); return e;
  };
  const eyeIcon = () => {
    const svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("viewBox", "0 0 16 16"); svg.setAttribute("class", "eye"); svg.setAttribute("aria-hidden", "true");
    for (const [tag, a] of [["path", {d:"M1 8s2.6-4.5 7-4.5S15 8 15 8s-2.6 4.5-7 4.5S1 8 1 8z"}], ["circle", {cx:8, cy:8, r:2}], ["path", {class:"slash", d:"M2.5 13.5l11-11"}]]) {
      const n = document.createElementNS(SVGNS, tag); for (const k in a) n.setAttribute(k, a[k]); svg.append(n);
    }
    return svg;
  };
  const hex = c => "#" + c.slice(0, 3).map(v => Math.round(v).toString(16).padStart(2, "0")).join("");
  const rgb = v => [1, 3, 5].map(i => parseInt(v.slice(i, i + 2), 16));
  const setIf = (el, prop, value) => { if (el[prop] !== value) el[prop] = value; };
  const eye = (label, onClick) => { const b = h("button", {type:"button", class:"eye-btn", "aria-label":label}, eyeIcon()); b.onclick = onClick; return b; };
  const TABS = [["layers", "Layers"], ["objects", "Objects"], ["nets", "Nets"]];
  const MAX_NET_ROWS = 500;

  // Import/reset controls. A request counter plus store identity makes late file reads, resets and project switches drop stale imports.
  function mountPresets(host, getStore, onError = () => {}) {
    const reset = h("button", {type:"button", class:"btn", "data-appearance-reset":""}, "Reset to KiCad defaults");
    const open = h("button", {type:"button", class:"btn", "data-appearance-import":""}, "Import KiCad theme (.json)");
    const input = h("input", {type:"file", accept:".json,application/json", hidden:true, "data-appearance-file":"", "aria-label":"KiCad colour theme file", "aria-describedby":"appearance-import-error"});
    const msg = h("p", {id:"appearance-import-error", role:"alert", hidden:true, "data-appearance-error":""});
    host.replaceChildren(reset, open, input, msg);
    const controller = new AbortController(), options = {signal:controller.signal};
    let sequence = 0;
    const show = (text, ok) => {
      msg.textContent = text; msg.hidden = !text; msg.classList.toggle("ok", !!ok);
      msg.setAttribute("role", ok ? "status" : "alert"); input.setAttribute("aria-invalid", String(!!text && !ok));
      if (text && !ok) onError(text);
    };
    open.addEventListener("click", () => input.click(), options);
    reset.addEventListener("click", () => { sequence++; getStore().reset(); show(""); }, options);
    input.addEventListener("change", async () => {
      const file = input.files[0]; input.value = "";
      if (!file) return;
      const request = ++sequence, target = getStore();
      try {
        if (file.size > 1048576) throw new Error("Theme exceeds 1 MiB.");
        const text = await file.text();
        if (request !== sequence || target !== getStore()) return;
        target.import(text);   // whole file validates before one store.set()
        let name = ""; try { name = JSON.parse(text).meta?.name || ""; } catch {}
        show(`Imported theme${typeof name === "string" && name ? ": " + name : ""}`, true);
      } catch (reason) {
        if (request !== sequence || target !== getStore()) return;
        show("Theme not imported. " + reason.message);
      }
    }, options);
    return Object.assign(() => { sequence++; controller.abort(); }, {cancelPending:() => { sequence++; }});
  }
  // mount(root, {layers:[{name,title,visible}], nets:[name], getState, onChange(patch), onReset, fallback})
  // update(next) syncs values in place, so slider focus and drag survive every change.
  function mount(root, ctx) {
    const rows = {layers:new Map(), objects:new Map(), nets:new Map()}, keys = {layers:"", nets:""};
    let tab = "layers", filter = "";
    const tablist = h("div", {role:"tablist", class:"appearance-tabs", "aria-label":"Appearance"});
    const tabEls = TABS.map(([id, label]) => {
      const t = h("button", {type:"button", role:"tab", id:`ap-tab-${id}`, "aria-controls":`ap-panel-${id}`, "data-ap-tab":id}, label);
      t.onclick = () => { tab = id; sync(); };
      t.onkeydown = e => {
        const vis = tabEls.filter(x => !x.hidden), i = vis.indexOf(t);
        const to = e.key === "Home" ? vis[0] : e.key === "End" ? vis.at(-1) : e.key === "ArrowRight" ? vis[(i + 1) % vis.length] : e.key === "ArrowLeft" ? vis[(i + vis.length - 1) % vis.length] : null;
        if (to) { e.preventDefault(); to.click(); to.focus(); }
      };
      tablist.append(t); return t;
    });
    const panels = Object.fromEntries(TABS.map(([id]) => [id, h("div", {role:"tabpanel", id:`ap-panel-${id}`, class:"appearance-body", "aria-labelledby":`ap-tab-${id}`})]));
    const note = h("p", {class:"appearance-note", role:"status"});
    const search = h("input", {type:"search", class:"net-filter", placeholder:"Filter nets", "aria-label":"Filter nets"});
    search.oninput = () => { filter = search.value.trim().toLowerCase(); sync(); };
    const clearNets = h("button", {type:"button", class:"btn"}, "Use layer colours");
    clearNets.onclick = () => ctx.onChange({nets:Object.fromEntries(Object.keys(ctx.getState().nets).map(n => [n, {color:null}]))});
    const netBox = h("div", {class:"net-rows"}), more = h("p", {class:"more muted"});
    panels.nets.append(h("div", {class:"net-tools"}, search, clearNets), netBox, more);
    panels.layers.append(h("div", {class:"layer-rows"}));
    panels.objects.append(h("div", {class:"object-rows"}));
    // Layer Display Options: inactive layers + flip + reset, always visible under the tab body.
    const contrast = ["normal", "dim", "hide"].map(v => {
      const i = h("input", {type:"radio", name:"ap-contrast", value:v}); i.onchange = () => i.checked && ctx.onChange({contrast:v});
      return [v, i, h("label", {class:"radio"}, i, " " + v[0].toUpperCase() + v.slice(1))];
    });
    const contrastBox = h("fieldset", {class:"contrast"}, h("legend", {}, "Inactive layers (H):"), ...contrast.map(c => c[2]));
    const flip = h("input", {type:"checkbox"}); flip.onchange = () => ctx.onChange({flip:flip.checked});
    const presets = h("div", {class:"presets"}); const stopPresets = mountPresets(presets, () => current);
    const options = h("div", {class:"appearance-options"}, h("h4", {}, "Layer Display Options"), contrastBox,
      h("label", {class:"check"}, flip, " Flip board view"), presets);
    root.replaceChildren(tablist, ...Object.values(panels), note, options);
    root.classList.add("appearance");

    const range = (label, onInput) => { const r = h("input", {type:"range", min:0, max:100, step:1, "aria-label":label}); r.oninput = () => onInput(+r.value / 100); return r; };
    const colorInput = (label, onInput) => { const c = h("input", {type:"color", "aria-label":label}); c.oninput = () => onInput(rgb(c.value)); return c; };
    function layerRow(l) {
      const name = l.name, label = l.label || name, c = colorInput(`${label} colour`, v => ctx.onChange({layers:{[name]:{color:[...v, ctx.getState().layers[name].color[3]]}}}));
      const e = eye(`Show ${label}`, () => ctx.onChange({layers:{[name]:{visible:!ctx.visible(name)}}}));
      const act = h("button", {type:"button", class:"name"}, label); act.title = l.title || label; act.onclick = () => ctx.onChange({activeLayer:name});
      const a = range(`${label} alpha`, v => ctx.onChange({layers:{[name]:{color:[...ctx.getState().layers[name].color.slice(0, 3), v]}}}));
      const value = h("output", {"aria-hidden":"true"});
      return {el:h("div", {class:"appearance-row", "data-layer":name}, c, e, act, ...(l.changed ? [h("span", {class:"mark", title:"changed in this review"}, "~")] : []), h("span", {class:"appearance-alpha"}, a, value)), c, e, act, a, value};
    }
    function objectRow([id, label, opacity]) {
      const rowId = id, off = ctx.unavailable?.[id], isGrid = id === "grid";
      const e = eye(`Show ${label}`, () => ctx.onChange(isGrid ? {grid:{visible:!ctx.getState().grid.visible}} : {objects:{[id]:{visible:!ctx.getState().objects[id].visible}}}));
      const a = opacity === undefined ? h("span") : range(`${label} opacity`, v => ctx.onChange({objects:{[id]:{opacity:v}}}));
      const name = h("span", {class:"name"}, label);
      return {el:h("div", {class:"appearance-row object-row", "data-object":rowId}, h("span"), e, name, a), e, a, name, id, isGrid};
    }
    function netRow(name) {
      const c = colorInput(`${name} colour`, v => ctx.onChange({nets:{[name]:{color:[...v, ctx.getState().nets[name]?.color?.[3] ?? 1]}}}));
      const e = eye(`Show net ${name}`, () => ctx.onChange({nets:{[name]:{visible:ctx.getState().nets[name]?.visible === false}}}));
      const b = h("button", {type:"button", class:"name"}, name); b.title = name;
      b.onclick = () => ctx.onChange({selectedNet:ctx.getState().selectedNet === name ? null : name});
      const a = range(`${name} alpha`, v => { const st = ctx.getState(), base = st.nets[name]?.color || [...st.layers[st.activeLayer]?.color.slice(0, 3) || [194, 194, 194], 1]; ctx.onChange({nets:{[name]:{color:[...base.slice(0, 3), v]}}}); });
      return {el:h("div", {class:"appearance-row", "data-net":name}, c, e, b, a), c, e, b, a};
    }
    function fill(map, box, list, make) {   // rebuild only when the row key set changes
      const key = list.map(x => x.name ?? x[0] ?? x).join("\n");
      if (box.dataset.key === key) return false;
      box.dataset.key = key; map.clear(); box.replaceChildren();
      for (const x of list) { const r = make(x); map.set(x.name ?? x[0] ?? x, r); box.append(r.el); }
      return true;
    }
    let live = ctx;
    function sync() {
      const st = live.getState(), reduced = !!live.fallback;
      if (reduced && tab !== "layers") tab = "layers";
      tabEls.forEach((t, i) => { const id = TABS[i][0], on = id === tab; t.hidden = reduced && id !== "layers"; t.setAttribute("aria-selected", on); t.tabIndex = on ? 0 : -1; panels[id].hidden = !on; });
      note.hidden = !reduced; note.textContent = reduced ? (live.note || "Reduced controls: colour, alpha and visibility apply to this view.") : "";
      // bench-t4: label the KiCad layer families without rebuilding live controls on edits.
      if (fill(rows.layers, panels.layers.firstChild, live.layers, layerRow)) {
        let previous;
        for (const l of live.layers) {
          const group = /\.Cu$/.test(l.name) ? "Copper" : /\.(CrtYd|Fab)$/.test(l.name) ? "Courtyard & fabrication" : /^(User\.|Dwgs\.|Cmts\.|Eco)/.test(l.name) ? "User" : "Technical";
          if (group !== previous) rows.layers.get(l.name).el.before(h("h4", {class:"appearance-group"}, group));
          previous = group;
        }
      }
      for (const l of live.layers) {
        const r = rows.layers.get(l.name), s = st.layers[l.name]; if (!r || !s) continue;
        setIf(r.c, "value", hex(s.color)); setIf(r.a, "value", String(Math.round(s.color[3] * 100)));
        r.value.textContent = `${Math.round(s.color[3] * 100)}%`;
        r.e.setAttribute("aria-pressed", String(live.visible(l.name)));
        const active = !reduced && st.activeLayer === l.name; r.act.setAttribute("aria-current", String(active));
        r.el.classList.toggle("off", !live.visible(l.name));
      }
      fill(rows.objects, panels.objects.firstChild, OBJECT_ROWS, objectRow);
      for (const r of rows.objects.values()) {
        const s = r.isGrid ? {visible:st.grid.visible} : st.objects[r.id], why = live.unavailable?.[r.id];
        r.e.setAttribute("aria-pressed", String(!why && s.visible)); r.e.disabled = r.a.disabled = !!why;
        if (r.a.type === "range") setIf(r.a, "value", String(Math.round(st.objects[r.id].opacity * 100)));
        r.el.title = why || ""; r.el.classList.toggle("off", !!why);
      }
      const names = (live.nets || []).filter(n => !filter || n.toLowerCase().includes(filter));
      const shown = names.slice(0, MAX_NET_ROWS);
      fill(rows.nets, netBox, shown.map(name => ({name})), x => netRow(x.name));
      more.textContent = names.length > shown.length ? `${names.length - shown.length} more — narrow the filter` : (live.nets?.length ? "" : "No named nets in this report");
      for (const n of shown) {
        const r = rows.nets.get(n), s = st.nets[n] || {}; if (!r) continue;
        setIf(r.c, "value", hex(s.color || st.layers[st.activeLayer]?.color || [194, 194, 194]));
        setIf(r.a, "value", String(Math.round((s.color?.[3] ?? 1) * 100)));
        r.c.classList.toggle("inherit", !s.color);
        r.e.setAttribute("aria-pressed", String(s.visible !== false)); r.b.setAttribute("aria-pressed", String(st.selectedNet === n));
        r.el.classList.toggle("off", s.visible === false);
      }
      search.disabled = clearNets.disabled = reduced;
      for (const [v, i] of contrast) { i.checked = st.contrast === v; i.disabled = reduced; }
      contrastBox.hidden = reduced; flip.checked = st.flip;
    }
    sync();
    return {cancelPendingImports:() => stopPresets.cancelPending(), update(next) { live = {...ctx, ...next}; sync(); }, dispose() { stopPresets(); root.replaceChildren(); root.classList.remove("appearance"); }};
  }
  configure();
  globalThis.Appearance = {
    OBJECT_ROWS, defaults: KrAppearance.boardDefaults, mount, mountPresets, store: () => current,
    normalize: KrAppearance.normalizeBoard, configure,
    get: () => current.get(), set: state => current.set(state), patch: partial => current.patch(partial),
    import: text => current.import(text), reset: () => current.reset(),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  };
})();
