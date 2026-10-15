// [name, url hash, body of an async function that returns true when the check passes]
export const CHECKS = [
  ["SCH6 exact paints stay schematic-only and preserve raster source", "", `
    const id = '__sch6_palette_probe__';
    const source = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10" style="stroke:#A90000"><path d="M0 0H10V10H0Z" style="fill:#009600!important;stroke:none"/></svg>';
    cache[id] = source;
    const view = {kind:'sheet', size:[10,10], layers:[{name:'probe', svg:{base:id,head:id}}]};
    try {
      const sheet = await stack('head', view);
      const svg = sheet.querySelector('svg'), path = svg.querySelector('path');
      if (svg.style.stroke !== 'var(--sch-ink-a90000, #a90000)'
        || path.style.getPropertyPriority('fill') !== 'important'
        || !path.getAttribute('style').includes('var(--sch-ink-009600')) return false;
      const themed = svg.outerHTML; themeSchematic(svg);
      if (svg.outerHTML !== themed) return false;
      document.documentElement.style.setProperty('--sch-ink-009600', '#135724');
      for (const kind of ['board','lib']) {
        const other = await stack('head', {...view, kind});
        if (other.querySelector('svg').outerHTML.includes('--sch-ink-')) return false;
      }
      const pixels = await raster('head', view, 10, 10);
      return await svgText(id) === source && pixels[0] === 0 && pixels[1] === 150
        && pixels[2] === 0 && pixels[3] === 255
        && schematicPaint('#A90000') === schematicPaint('#a90000')
        && schematicPaint('#F5F4EF') === '#F5F4EF';
    } finally {
      delete cache[id]; document.documentElement.style.removeProperty('--sch-ink-009600');
    }
  `],
["SCH6 exact paints preserve opacity unknown colours and geometry", "", `
  const host = document.createElement('div');
  host.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g style="stroke:#009600;fill:none;stroke-opacity:.4"><path d="M1 1L9 9" fill="#FFFFC2"/><text opacity="0" stroke-opacity="0">Hidden</text></g><path fill="#123456" stroke="none"/><path style="fill:rgb(0,150,0);stroke:#009601"/></svg>';
  const svg = host.firstChild, before = svg.querySelector('path').getAttribute('d');
  document.body.append(host);
  try {
    themeSchematic(svg);
    const g = svg.querySelector('g'), unknown = svg.querySelectorAll('path')[1];
    document.documentElement.style.setProperty('--sch-ink-009600', '#135724');
    const first = getComputedStyle(svg.querySelector('path')).stroke;
    document.documentElement.style.setProperty('--sch-ink-009600', '#246813');
    const second = getComputedStyle(svg.querySelector('path')).stroke;
    return first === 'rgb(19, 87, 36)' && second === 'rgb(36, 104, 19)'
      && g.style.fill === 'none' && g.style.strokeOpacity === '0.4'
      && svg.querySelector('text').getAttribute('opacity') === '0'
      && unknown.getAttribute('fill') === '#123456'
      && unknown.getAttribute('stroke') === 'none'
      && svg.querySelector('path').getAttribute('d') === before
      && schematicPaint('rgb(0,150,0)') === 'rgb(0,150,0)'
      && schematicPaint('#009601') === '#009601'
      && schematicPaint('#009600') === schematicPaint('#009600'.toLowerCase());
  } finally {
    document.documentElement.style.removeProperty('--sch-ink-009600'); host.remove();
  }
`],

  ["Stage 1 dock tabs remain readable and reachable at 1600", "", `
    const P=proj();
    P.parts ||= {lines:[],supplier:{skipped:true}};
    const line=P.parts.lines[0] || {problems:[]}; P.parts.lines=Array(999).fill(line);
    S.threads=[]; S.issues=[]; renderPanel();
    const panel=document.querySelector('#panel').getBoundingClientRect();
    const tabs=[...document.querySelectorAll('#panel [role=tab]')];
    if(tabs.length!==4) return 'missing tabs';
    for(const b of tabs) {
      const r=b.getBoundingClientRect();
      if(r.left<panel.left || r.right>panel.right+.5 || b.scrollWidth>b.clientWidth+1) return b.textContent;
    }
    const checks=tabs.find(t=>t.dataset.tab==='checks'); checks.focus();
    checks.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}));
    const last=document.querySelector('#panel [data-tab="threads"]');
    const good=document.activeElement===last && last.getAttribute('aria-selected')==='true';
    return good && document.documentElement.scrollWidth<=innerWidth || 'keyboard/overflow';`],
  ["Stage 1 X Y map each pane and reset outside drawing", "v=board", `
    await draw(); setT({x:-12.125,y:34.375,z:8});
    const viewports=[...document.querySelectorAll('#stage .vp')];
    if(viewports.length!==2) return 'side fixture';
    for(const vp of viewports) {
      const r=vp.getBoundingClientRect();
      updateCoordinates(vp,{clientX:r.left+r.width/2+10,clientY:r.top+r.height/2-6});
      if(document.querySelector('[data-coordinate=x]').textContent!=='-10.875' ||
         document.querySelector('[data-coordinate=y]').textContent!=='33.625') return 'mapping';
    }
    const hash=location.hash; resetCoordinates();
    if(document.querySelector('[data-coordinate=x]').textContent!=='—') return 'stale';
    await draw();
    return document.querySelector('[data-coordinate=y]').textContent==='—' && location.hash===hash;`],
["Stage 1 dark default ignores OS and tokens resolve", "", `
  const root = document.documentElement; root.removeAttribute('data-theme');
  const c = getComputedStyle(root), b = getComputedStyle(document.body);
  return c.colorScheme === 'dark' && b.backgroundColor === 'rgb(20, 23, 28)'
    && c.getPropertyValue('--btn-h').trim() === '24px'
    && c.getPropertyValue('--tab-h').trim() === '28px'
    && c.getPropertyValue('--toolbar-h').trim() === '32px'
    && c.getPropertyValue('--space-2').trim() === '8px';`],
["Stage 1 both token themes pass text contrast", "", `
  const root = document.documentElement, old = root.getAttribute('data-theme');
  const probe = document.createElement('span'); document.body.append(probe);
  const lum = s => { const rgb = s.match(/[\\d.]+/g).slice(0,3).map(Number).map(v => {v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;}); return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722; };
  const ratio = (a,b) => (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
  try {
    for (const theme of ['dark','light']) {
      root.dataset.theme = theme;
      for (const surface of ['bg','surface','surface-2','surface-3']) {
        probe.style.backgroundColor = 'var(--'+surface+')';
        for (const text of ['text','muted','accent','added','removed','modified','waived']) {
          probe.style.color = 'var(--'+text+')'; const s = getComputedStyle(probe);
          if (ratio(lum(s.color),lum(s.backgroundColor)) < 4.5) return theme+': '+text+' on '+surface;
        }
      }
      probe.style.backgroundColor = 'var(--accent-fill)'; probe.style.color = 'var(--on-accent)';
      let s = getComputedStyle(probe); if (ratio(lum(s.color),lum(s.backgroundColor)) < 4.5) return 'primary';
      probe.style.color = 'var(--line-strong)'; probe.style.backgroundColor = 'var(--surface)';
      s = getComputedStyle(probe); if (ratio(lum(s.color),lum(s.backgroundColor)) < 3) return 'control border';
    }
    return true;
  } finally { probe.remove(); if(old === null) root.removeAttribute('data-theme'); else root.dataset.theme=old; }`],
  ["board uniform retained primitives and drill pixels", "", `
    if (!window.BoardGL) return "missing BoardGL";
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "position:fixed;left:300px;top:180px;width:800px;height:500px;z-index:9999";
    canvas.setAttribute("aria-label", "Synthetic retained PCB tracks and via drill holes");
    document.body.append(canvas);
    const scene = {version:1,units:"um",complete:true,warnings:[],bounds:[0,0,8000,5000],
      layers:[{id:0,name:"F.Cu",type:"signal",enabled:true},{id:2,name:"B.Cu",type:"signal",enabled:true}],
      nets:[{id:0,name:""},{id:900001,name:"GND"}],objects:[
        {kind:"track",uuid:"track",changeUuid:"track",layers:["F.Cu"],net:900001,category:"tracks",side:null,hidden:false,box:[750,750,6250,1250],geometry:{segments:[[1000,1000,6000,1000,500]]}},
        {kind:"track",uuid:"disc",changeUuid:"disc",layers:["F.Cu"],net:0,category:"tracks",side:null,hidden:false,box:[6500,500,7500,1500],geometry:{segments:[[7000,1000,7000,1000,1000]]}},
        {kind:"via",uuid:"via",changeUuid:"via",layers:["F.Cu","B.Cu"],net:900001,category:"vias",side:null,hidden:false,box:[2500,2500,3500,3500],geometry:{primitive:{shape:"circle",center:[3000,3000],size:[1000,1000],angle:0},drill:{center:[3000,3000],size:[500,500],angle:0,plated:true}}},
        {kind:"pad",uuid:"slot",changeUuid:"fp",layers:["F.Cu","B.Cu"],net:900001,category:"pads",side:"back",hidden:false,box:[4500,2500,5500,3500],geometry:{primitive:{shape:"circle",center:[5000,3000],size:[1000,1000],angle:0},drill:{center:[5000,3000],size:[700,300],angle:0,plated:true}}}
      ]};
    const failures = [];
    const r = BoardGL.create(canvas,{scene,onFailure:e=>failures.push(e.message)});
    if (!r) return "WebGL2/stencil unavailable: " + failures;
    r.setCamera({x:4,y:2.5,z:100,width:800,height:500,dpr:1});
    const gl = canvas.getContext("webgl2"), pixel = (x,y) => {const p=new Uint8Array(4);gl.readPixels(Math.round(x*100),Math.round(500-y*100),1,1,gl.RGBA,gl.UNSIGNED_BYTE,p);return Array.from(p).slice(0,3);};
    const equal = (p,q) => p.every((v,i)=>Math.abs(v-q[i])<=2);
    const bg = [0,16,35], copper = [200,52,52];
    const state = {activeLayer:"F.Cu",layers:{"F.Cu":{color:[200,52,52,1],visible:true}},objects:{tracks:{opacity:1}},nets:{}};
    r.setAppearance(state); r.draw();
    const uploads = r.stats.uploads;
    const initial=[pixel(3,1),pixel(.85,1),pixel(.7,1),pixel(7,1),pixel(3,3),pixel(3.4,3),pixel(3.275,3),pixel(5.2,3)];
    if (!initial.every((p,i)=>equal(p,[copper,copper,bg,copper,bg,copper,[236,236,236],bg][i]))) return "initial pixels " + JSON.stringify(initial);
    r.draw();
    state.layers["F.Cu"].color = [20,220,80,.8]; state.objects.tracks.opacity = .5;
    r.setAppearance(state); r.draw();
    if (!equal(pixel(3,1),[8,98,53]) || r.stats.uploads!==uploads) return "uniform update uploaded or wrong RGB " + pixel(3,1);
    state.objects.tracks.opacity=1; state.layers["F.Cu"].color=[200,52,52,1];
    state.nets.GND={color:[40,100,240,.5]}; r.setAppearance(state); r.draw();
    if (!equal(pixel(3,1),[20,58,138])) return "net override alpha " + pixel(3,1);
    state.nets.GND={visible:false}; r.setAppearance(state); r.draw();
    if (!equal(pixel(3,1),bg) || !equal(pixel(3.4,3),bg)) return "hidden net";
    state.nets={}; state.selectedNet="GND"; r.setAppearance(state); r.draw();
    if (!equal(pixel(7,1),copper)) return "net zero was dimmed";
    state.objects.backFootprints={visible:false}; r.setAppearance(state); r.draw();
    if (!equal(pixel(5,3),bg) || !equal(pixel(5.4,3),bg)) return "footprint side gate";
    state.flip=true; r.setAppearance(state); r.draw();
    if (!equal(pixel(1,1.4),copper)) return "appearance flip";
    state.flip=false; state.layers["F.Cu"].visible=false; r.setAppearance(state); r.draw();
    if (!equal(pixel(3,1),bg)) return "layer eye";
    state.layers["F.Cu"].visible=true; r.setAppearance(state);
    r.setCamera({x:3,y:1,z:120,width:800,height:500,dpr:1}); r.draw();
    if (!equal(r.readPixel(400,250).slice(0,3),copper)) return "retained camera";
    r.setCamera({x:4,y:2.5,z:100,width:800,height:500,dpr:1});
    if (r.stats.uploads!==uploads || gl.getError()!==gl.NO_ERROR || failures.length) return "GPU errors/uploads";
    state.objects.backFootprints={visible:true}; state.selectedNet=null;
    r.setAppearance(state); r.draw();
    window.__boardSynthetic = {renderer:r,canvas};
    return true;`],
  ["Libraries compare modes, used-by jumps and escaped panel", "", `
    const P = proj(), sheet = P.sheets.find(s => s.svg); if (!sheet) return "skip";
    P.objects = [{kind: "symbol", ref: "U1", lib: "Parts:X", sheet: sheet.path, pos: [10, 10], side: "head"}];
    P.libraries = [{lib: "Parts", item: "X", kind: "symbol", status: "modified", file: "f", size: sheet.size, svg: sheet.svg,
      pins_diff: [{pin: "<img>", change: "type", before: "<b>old</b>", after: "new"}], used_by: ["U1"], warnings: ["<script>bad</script>"]}];
    S.t = "checks"; select("lib:0");
    for (const m of ["side", "overlay", "wipe", "blend", "semantic"]) { S.m = m; await draw(); if (!document.querySelector("#stage .stack .layer")) return m; }
    if (document.querySelector("#panel .lib-info img, #panel .lib-info script, #panel .lib-info td b") || !document.querySelector("#panel .lib-info")?.textContent.includes("<b>old</b>")) return "unescaped";
    document.querySelector("#panel [data-lib-object]").click(); await new Promise(r => setTimeout(r, 400));
    if (S.v !== "sheet:" + sheet.path || document.querySelector("#panel .lib-info")) return "used-by did not leave library";
    const row = P.changes.find(r => viewOf(r) && currentView(viewOf(r))); if (!row) return "no changed object";
    select("lib:0"); await goTo(row.id);
    if (document.querySelector("#panel .lib-info")) return "stale library panel after change selection";
    P.objects[0].sheet = "/missing"; select("lib:0");
    return !document.querySelector("#panel [data-lib-object]") && document.querySelector("#panel .lib-info").textContent.includes("U1") || "dead used-by button";`],

  ["Libraries changed items are listed, drawn and explained", "", `
    const P = proj(), sheet = P.sheets.find(s => s.svg); if (!sheet) return "skip";
    P.libraries = [{ lib: "Parts", item: "SOT23", kind: "footprint", status: "modified", file: "Parts.pretty/SOT23.kicad_mod", size: sheet.size, svg: sheet.svg,
                     pins_diff: [{ pin: "3", change: "removed", before: "smd rect (2, 0) 0.6×1", after: null }], used_by: ["U1", "U3"], warnings: ["⚠ pad 3 removed while U1, U3 use SOT23"] },
                   { lib: "Parts", item: "<b>X</b>", kind: "symbol", status: "added", file: "Parts.kicad_sym", svg: { base: null, head: null }, pins_diff: [], used_by: [], warnings: [], note: "no drawing" }];
    renderNav();
    const items = [...document.querySelectorAll('#nav [data-view^="lib:"]')];
    items[0].click(); await new Promise(r => setTimeout(r, 400));
    const info = document.querySelector("#panel .lib-info")?.textContent || "";
    const drew = !!document.querySelector("#stage .stack.head .layer");
    return items.length === 2 && items[1].textContent.includes("<b>X</b>") && !document.querySelector("#nav b") && drew && info.includes("pad 3") && info.includes("U1, U3") && info.includes("⚠")
      || JSON.stringify({n: items.length, drew, info});`],
  ["Libraries views survive address round trip and missing drawings", "", `
    const P = proj(), sheet = P.sheets.find(s => s.svg); if (!sheet) return "skip";
    P.libraries = [{ lib: "Parts", item: "SOT23", kind: "footprint", status: "modified", file: "f", size: sheet.size, svg: sheet.svg, pins_diff: [], used_by: [], warnings: [] },
                   { lib: "Parts", item: "LDO", kind: "symbol", status: "added", file: "f", svg: { base: null, head: null }, pins_diff: [], used_by: [], warnings: [], note: "no drawing" }];
    renderNav();
    applyState(decodeState("#p=" + S.p + "&v=lib:1")); await new Promise(r => setTimeout(r, 300));
    return S.v === "lib:1" && document.querySelector("#stage .empty") !== null || JSON.stringify({v: S.v});`],

  ["mode activation retains keyboard focus", "", `
    const b = document.querySelector('#modes [data-mode="overlay"]'); b.focus(); b.click();
    return document.activeElement === document.querySelector('#modes [data-mode="overlay"]') || document.activeElement.tagName;`],
  ...['[data-tab="checks"]', 'select.kind', '[data-check-scope="all"]'].map(selector => [`panel activation retains keyboard focus on ${selector}`, selector.includes("data-check-") ? "p=1&t=checks" : "p=1", `
    const selector = '${selector}', b = document.querySelector("#panel " + selector); b.focus();
    if (b.matches("select")) { b.value = b.options[1].value; b.dispatchEvent(new Event("change")); } else b.click();
    return document.activeElement === document.querySelector("#panel " + selector) || document.activeElement.tagName;`]),
  ["show-all activation retains keyboard focus when its button disappears", "p=1&t=checks", `
    S.checks.error = S.checks.warning = false; renderPanel();
    const b = document.querySelector("#panel .show-all"); b.focus(); b.click();
    return document.activeElement === document.querySelector('#panel [data-check-scope="all"]') && document.querySelectorAll("#panel .viol").length > 0 || document.activeElement.tagName;`],
  ...["pasted", "hashchange"].map(path => [`${path} selection-only address opens its drawing`, "", `
    const row = proj().changes.find(r => r.where?.board && rowBox(r, "head")); if (!row) return "skip";
    await new Promise(r => setTimeout(r, 400));
    const hash = "#p=0&s=" + row.id;
    if ("${path}" === "pasted") { const input = document.querySelector("#zoombar .goto"); input.value = hash; input.dispatchEvent(new Event("change")); }
    else location.hash = hash;
    const until = performance.now() + 5000, box = rowBox(row, "head");
    while ((S.v !== "board" || S.x == null || Math.abs(S.x - (box[0] + box[2]) / 2) >= .01) && performance.now() < until) await new Promise(r => setTimeout(r, 50));
    return S.v === "board" && S.s === row.id && Math.abs(S.x - (box[0] + box[2]) / 2) < .01 && !!document.querySelector("#stage .marker.sel") || JSON.stringify({view:S.v, selection:S.s, x:S.x});`]),
  ["pasted selection address preserves an explicit position", "", `
    const row = proj().changes.find(r => r.where?.board && rowBox(r, "head")); if (!row) return "skip";
    applyGoTo("#p=0&v=board&s=" + row.id + "&x=10&y=20&z=5");
    await new Promise(r => setTimeout(r, 800));
    return S.x === 10 && S.y === 20 && S.z === 5 && S.s === row.id;`],
  ["reloading a saved sheet address keeps its explicit view", "", `
    const P = proj(), row = P.changes.find(r => r.where?.sheet && rowBox(r, "head"));
    await goTo(row.id);
    const sheet = P.sheets.find(s => s.path === row.where.sheet);
    P.sheets.push({...sheet, path:"/second/", name:"Second sheet", status:"unchanged", svg:null}); renderNav();
    document.querySelector('#nav [data-view="sheet:/second/"]').click();
    await new Promise(r => setTimeout(r, 400));
    const saved = location.hash; S.v = null; S.s = null;
    history.replaceState(null, "", saved); await start();
    return S.v === "sheet:/second/" && S.s === row.id || JSON.stringify({saved, view:S.v, selection:S.s});`],
  ["unchanged sheet selection saves the address", "", `
    const sheet = proj().sheets.find(s => s.status === "unchanged" && !s.svg); if (!sheet) return "skip";
    await new Promise(r => setTimeout(r, 400));
    document.querySelector('#nav [data-view="sheet:' + sheet.path + '"]').click();
    await new Promise(r => setTimeout(r, 400));
    return new URLSearchParams(location.hash.slice(1)).get("v") === "sheet:" + sheet.path || location.hash;`],
  ["unchanged project selection saves the address", "", `
    const i = D.projects.findIndex(p => !p.board.changed && p.sheets.length && p.sheets.every(s => !s.svg)); if (i < 0) return "skip";
    await new Promise(r => setTimeout(r, 400));
    const select = document.querySelector("#proj"); select.value = i; select.dispatchEvent(new Event("change"));
    await new Promise(r => setTimeout(r, 400));
    return new URLSearchParams(location.hash.slice(1)).get("p") === String(i) || location.hash;`],
  ["3D base-only models mark removals in overlay and changes only", "v=3d", `
    if (!REVIEW_DATA.projects[0].board.model3d) return "skip";
    const p = REVIEW_DATA.projects[0], stage = document.querySelector("#stage"), project = {...p, board:{...p.board, model3d:{...p.board.model3d, head:null}}, changes:[{...p.changes.find(c => c.ref === "J2"), action:"removed"}]};
    const facts = [];
    for (const m of ["overlay", "semantic"]) {
      await Review3D.show(stage, project, {...S, m, s:null});
      const h = Review3D.state.highlights.find(h => h.ref === "J2" && h.side === "base" && h.action === "removed");
      facts.push(!!h && h.marker.el.textContent.includes("− J2") && h.materials.some((material, i) => material !== h.original[i]));
    }
    return facts.every(Boolean) || JSON.stringify(facts);`],
  ["3D cancelled GLB loads dispose parsed resources", "v=3d", `
    if (!REVIEW_DATA.projects[0].board.model3d) return "skip";
    const p = REVIEW_DATA.projects[0], stage = document.querySelector("#stage"), loader = THREE3D.GLTFLoader.prototype, parse = loader.parseAsync, resources = new Set(), disposed = new Set();
    let release, parsed = 0;
    const gate = new Promise(r => release = r);
    loader.parseAsync = async function(...args) {
      const g = await parse.apply(this, args);
      g.scene.traverse(o => [o.geometry, ...[o.material].flat().filter(Boolean).flatMap(m => [m, m.map])].filter(Boolean).forEach(r => {
        if (!resources.has(r)) r.addEventListener("dispose", () => disposed.add(r)); resources.add(r);
      }));
      parsed++; await gate; return g;
    };
    try {
      const cancelled = Review3D.show(stage, p, {...S, s:null});
      while (parsed < Object.values(p.board.model3d).filter(Boolean).length) await new Promise(r => setTimeout(r, 20));
      await Review3D.show(stage, {...p, board:{...p.board, model3d:{}, no_model:[]}}, {...S, m:"overlay", s:null});
      release(); await cancelled;
      return resources.size > 0 && disposed.size === resources.size || JSON.stringify({parsed, resources:resources.size, disposed:disposed.size});
    } finally { release(); loader.parseAsync = parse; }
  `],
  ["3D cleanup frees replaced outlines and scene resources", "v=3d&m=overlay", `
    if (!REVIEW_DATA.projects[0].board.model3d) return "skip";
    const p = REVIEW_DATA.projects[0], change = p.changes.find(c => c.ref === "J2"), seen = {}, watch = (name, resource) => { seen[name] = false; resource?.addEventListener("dispose", () => { seen[name] = true; }); };
    Review3D.focus(change);
    const st = Review3D.state, old = st.selected[0];
    watch("replaced geometry", old.geometry); watch("replaced material", old.material);
    Review3D.focus(change);
    const replaced = seen["replaced geometry"] && seen["replaced material"];
    watch("outline geometry", st.selected[0].geometry); watch("outline material", st.selected[0].material);
    let ghost, base, block;
    st.ghosts[0].object.traverse(o => { if (o.isMesh) ghost = o.material; });
    st.roots[0].traverse(o => { if (o.isMesh) base = o.geometry; });
    st.blocks[0].object.traverse(o => { if (o.isMesh) block = o.material.map; });
    watch("ghost material", ghost); watch("detached base geometry", base); watch("placeholder texture", block);
    Review3D.dispose();
    return replaced && Object.values(seen).every(Boolean) || JSON.stringify({replaced, ...seen});`],
  ["3D camera animation stops with its owning session", "v=3d", `
    if (!REVIEW_DATA.projects[0].board.model3d) return "skip";
    const p = REVIEW_DATA.projects[0], stage = document.querySelector("#stage"), change = p.changes.find(c => c.ref === "J2"), raf = window.requestAnimationFrame;
    const facts = [];
    for (const reopen of [false, true]) {
      await Review3D.show(stage, p, {...S, s:null});
      const st = Review3D.state, ticks = []; let updates = 0;
      st.controls.forEach(c => { const update = c.update; c.update = (...a) => { updates++; return update.apply(c, a); }; });
      window.requestAnimationFrame = tick => { ticks.push(tick); return 1; };
      Review3D.focus(change); window.requestAnimationFrame = raf;
      Review3D.dispose();
      if (reopen) await Review3D.show(stage, p, {...S, s:null});
      const camera = Review3D.cameraState(); let error = false;
      try { ticks.forEach(tick => tick(performance.now() + 500)); } catch { error = true; }
      facts.push(ticks.length > 0 && !error && updates === 0 && JSON.stringify(camera) === JSON.stringify(Review3D.cameraState()));
    }
    return facts.every(Boolean) || JSON.stringify(facts);`],
  ["3D bad model data settles and keeps the valid side", "v=3d", `
    if (!REVIEW_DATA.projects[0].board.model3d) return "skip";
    const p = REVIEW_DATA.projects[0], stage = document.querySelector("#stage"), good = p.board.model3d.head;
    const gzip = async text => btoa(String.fromCharCode(...new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer())));
    const bad = [btoa("not gzip"), await gzip("not GLB")];
    const facts = [];
    for (const blob of bad) for (const both of [false, true]) for (const side of ["base", "head"]) {
      REVIEW_DATA.blobs.__bad3d = blob;
      const project = {...p, board:{...p.board, no_model:[], model3d:{base:both || side === "base" ? "__bad3d" : good, head:both || side === "head" ? "__bad3d" : good}}};
      const result = await Promise.race([Review3D.show(stage, project, {...S, s:null}).then(() => "done"), new Promise(r => setTimeout(() => r("pending"), 3000))]);
      facts.push(result === "done" && !stage.querySelector(".loading") && stage.textContent.includes("3D model could not be loaded") && !stage.textContent.includes("Board not in this revision") && !stage.textContent.includes("No 3D board model was exported") && (both ? !!stage.querySelector(".empty") : !!Review3D.state.roots[side === "base" ? 1 : 0] && !Review3D.state.roots[side === "base" ? 0 : 1]));
      Review3D.dispose();
    }
    return facts.every(Boolean) || JSON.stringify(facts);`],
  ["3D bundle failure leaves Loading", "", `
    if (!REVIEW_DATA.projects[0].board.model3d) return "skip";
    document.querySelector("#three-bundle").textContent = btoa("not gzip");
    const stage = document.querySelector("#stage");
    const result = await Promise.race([Review3D.show(stage, REVIEW_DATA.projects[0], {...S, s:null}).then(() => "done", () => "rejected"), new Promise(r => setTimeout(() => r("pending"), 3000))]);
    return result === "done" && !stage.querySelector(".loading") && !!stage.textContent.trim() || result;`],
  ...["side", "overlay"].map(mode => [mode === "side" ? "3D theme switch recolours in place" : "3D theme switch recolours overlay ghosts in place", `v=3d&m=${mode}&s=c2`, `
    if (!REVIEW_DATA.projects[0].board.model3d) return "skip";
    while (!window.Review3D?.state?.firstFrame) await new Promise(r => setTimeout(r, 50));
    await new Promise(r => setTimeout(r, 800));
    const st = Review3D.state, {THREE} = THREE3D, h = st.highlights.find(x => x.ref === "J2" && x.side === "head"), before = {camera:st.cameras.map(c => c.position.toArray()), parses:st.parseCount, highlight:h.materials[0].color.getHexString(), outline:st.selected[0].material.color.getHexString(), clear:st.renderers[0].getClearColor(new THREE.Color()).getHexString()}, dark = KRTheme.get() === "light";
    await new Promise(r => { window.__themeFlipped = r; window.__flipTheme(dark ? "dark" : "light"); });
    const until = performance.now() + 3000;
    while (st.renderers[0].getClearColor(new THREE.Color()).getHexString() === before.clear && performance.now() < until) await new Promise(r => setTimeout(r, 25));
    const css = getComputedStyle(document.documentElement), token = n => new THREE.Color(css.getPropertyValue(n).trim()), facts = {
      clear:st.renderers.every(r => r.getClearColor(new THREE.Color()).equals(token(dark ? "--bg" : "--paper"))),
      highlight:h.materials.every((m,i) => m.color.equals(h.original[i].color.clone().lerp(token("--modified"), .7)) && (!m.emissive || m.emissive.equals(token("--modified")))),
      outline:st.selected.every(o => o.material.color.equals(token("--accent"))),
      changed:before.highlight !== h.materials[0].color.getHexString() && before.outline !== st.selected[0].material.color.getHexString() && before.clear !== st.renderers[0].getClearColor(new THREE.Color()).getHexString(),
      camera:JSON.stringify(before.camera) === JSON.stringify(st.cameras.map(c => c.position.toArray())), parses:before.parses === st.parseCount && st.parseCount === 2, selection:S.s === "c2", same:st === Review3D.state,
      marker:getComputedStyle(h.marker.el).color === (() => { const e=document.createElement("span");e.style.color="var(--modified)";document.body.append(e);const c=getComputedStyle(e).color;e.remove();return c; })(),
      ghosts:true
    };
    if ("${mode}" === "overlay") st.ghosts.forEach(g => g.object.traverse(o => { if (o.isMesh && !o.material.color.equals(token("--removed"))) facts.ghosts=false; }));
    return Object.values(facts).every(Boolean) || JSON.stringify(facts);`]),

  ["3D navigator appears only for opted-in data", "", `
    return !!REVIEW_DATA.projects[0].board.model3d === !!document.querySelector('#nav [data-view="3d"]');`],
  ["3D loads GLBs with named component nodes", "v=3d", `
    if (!REVIEW_DATA.projects[0].board.model3d) return "skip";
    await new Promise(r => setTimeout(r, 5000));
    const n = window.Review3D.state.nodes || [];
    return document.querySelectorAll('#stage canvas').length >= 2 && n.includes("J2") && n.includes("C20");`],
  ["3D camera buttons change the camera", "v=3d", `
    if (!REVIEW_DATA.projects[0].board.model3d) return "skip";
    await new Promise(r => setTimeout(r, 5000));
    const a = window.Review3D.state.cameras[0].position.toArray().join(","); document.querySelector('[data-3d-camera="top"]').click();
    return a !== window.Review3D.state.cameras[0].position.toArray().join(",");`],
  ["3D preset uses world-up and sits above the board", "v=3d", `
    if (!REVIEW_DATA.projects[0].board.model3d) return "skip";
    await new Promise(r => setTimeout(r, 5000));
    document.querySelector('[data-3d-camera="top"]').click(); document.querySelector('[data-3d-camera="3d"]').click();
    const d = window.Review3D.state;
    return d.cameras.every(c => c.up.x === 0 && c.up.y === 1 && c.up.z === 0 && c.position.y > d.box.max.y);`],
  ["3D camera movement is linked and leaving disposes", "v=3d", `
    if (!REVIEW_DATA.projects[0].board.model3d) return "skip";
    await new Promise(r => setTimeout(r, 5000));
    const d = window.Review3D.state, r = window.__3dInputResult;
    const delta = (p, q) => Math.hypot(...p.map((v, i) => v - q[i]));
    const linked = r && delta(r.after[0], r.before[0]) > .001 && delta(r.after[0], r.after[1]) < .001;
    await select("board"); return linked && window.Review3D.state.disposed === true;`],
  ["3D changed footprints use cloned highlight materials", "v=3d&m=side", `
    if (!REVIEW_DATA.projects[0].board.model3d) return "skip";
    await new Promise(r => setTimeout(r, 5000));
    const h = window.Review3D.state.highlights || [], refs = new Set(h.map(x => x.ref));
    return ["J2", "C20"].every(ref => refs.has(ref) && h.some(x => x.ref === ref && x.materials.some((m, i) => m !== x.original[i])));`],
  ["3D glyph marker labels are visible over their canvas", "v=3d&m=side", `
    if (!REVIEW_DATA.projects[0].board.model3d) return "skip";
    await new Promise(r => setTimeout(r, 5000));
    const l = document.querySelector('.marker3d[data-ref="J2"]'), c = l?.parentElement.querySelector("canvas"), a = l?.getBoundingClientRect(), b = c?.getBoundingClientRect();
    return !!l && l.textContent.includes("≡ J2") && a.left >= b.left && a.right <= b.right && a.top >= b.top && a.bottom <= b.bottom;`],
  ["3D Overlay shows old-position ghosts", "v=3d&m=overlay", `
    if (!REVIEW_DATA.projects[0].board.model3d) return "skip";
    await new Promise(r => setTimeout(r, 5000));
    const d = window.Review3D.state, g = d.ghosts.find(x => x.ref === "J2"), h = d.highlights.find(x => x.ref === "J2" && x.side === "head");
    return !!g && !!h && Math.hypot(...g.translation.map((v, i) => v - h.marker.position.toArray()[i])) > .001;`],
  ["3D Blend slider and B switch cross-fade without moving camera", "v=3d&m=blend", `
    if (!REVIEW_DATA.projects[0].board.model3d) return "skip";
    await new Promise(r => setTimeout(r, 5000));
    const d = window.Review3D.state, r = document.querySelector("#modes input[type=range]"); r.value = 20; r.dispatchEvent(new Event("input"));
    const faded = d.blend === .2, p = d.cameras[0].position.toArray(); document.dispatchEvent(new KeyboardEvent("keydown", { key:"b" }));
    return faded && d.blend === 1 && p.join(",") === d.cameras[0].position.toArray().join(",");`],
  ["3D Changes only fades unchanged components and disables Wipe", "v=3d&m=semantic", `
    if (!REVIEW_DATA.projects[0].board.model3d) return "skip";
    await new Promise(r => setTimeout(r, 5000));
    const u = (window.Review3D.state.faded || []).find(x => x.ref === "U4"), faded = u?.materials.some(m => m.opacity === .12);
    return !!faded && document.querySelector('[data-mode="wipe"]').getAttribute("aria-disabled") === "true";`],
  ["loads sample", "", `return REVIEW_DATA.version === 1 && document.querySelector("#nav") !== null;`],
  ["header shows repo, revisions, review link and verdict", "", `
    const h = document.querySelector("#hdr").textContent;
    return h.includes("kicad-review-test") && h.includes(REVIEW_DATA.head.slice(0, 7))
      && document.querySelector('#hdr a[href$="/pull/2"]') !== null && /failing|passing/.test(h);`],
  ["navigator lists every project, sheet and board with counts", "", `
    let boards = 0, ok = true;
    for (let i = 0; i < REVIEW_DATA.projects.length; i++) {
      openProject(i);
      const items = [...document.querySelectorAll("#nav [data-view]")];
      boards += items.filter(e => e.dataset.view === "board").length;
      ok = ok && items.length === REVIEW_DATA.projects[i].sheets.length + 1 && items.every(e => e.querySelector(".counts"));
    }
    return REVIEW_DATA.projects.length === 2 && boards === 2 && ok;`],
  ["unchanged sheet still reachable", "", `
    const sheet = proj().sheets.find(s => s.status === "unchanged"); if (!sheet) return "skip";
    const u = document.querySelector('#nav [data-view="sheet:' + sheet.path + '"]');
    return !!u && !u.hasAttribute("aria-disabled");`],
  ["added project with no base renders without errors", "p=0", `return S.p === 0 && document.querySelector("#nav").textContent.includes("added");`],
  ["address picks project and view; bad values fall back", "p=9&v=sheet:/nope/&x=abc", `
    return S.p === 0 && S.v !== "sheet:/nope/" && Number.isFinite(S.x);`],
  ["sheet draws base and head, side by side", "p=1", `
    await new Promise(r => setTimeout(r, 800));
    return document.querySelectorAll("#stage .vp").length === 2 && document.querySelectorAll("#stage svg").length >= 2;`],
  ["wheel zoom keeps both panes in step", "", `
    await new Promise(r => setTimeout(r, 800));
    const vp = document.querySelector("#stage .vp"), before = S.z;
    vp.dispatchEvent(new WheelEvent("wheel", { deltaY: -300, clientX: 400, clientY: 400, bubbles: true, cancelable: true }));
    await new Promise(r => requestAnimationFrame(r));
    const t = [...document.querySelectorAll("#stage .world")].map(w => w.style.transform);
    return t.length === 2 && t[0] === t[1] && S.z > 0 && S.z !== before;`],
  ["will-change only during a gesture", "", `
    await new Promise(r => setTimeout(r, 800));
    const w = document.querySelector("#stage .world");
    document.querySelector("#stage .vp").dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }));
    const during = getComputedStyle(w).willChange; await new Promise(r => setTimeout(r, 300));
    return during === "transform" && getComputedStyle(w).willChange === "auto";`],
  ["dense board pans at 60 fps", "v=board", `
    if (!REVIEW_DATA.projects[0].name.startsWith("vme")) return "skip";   // only meaningful on the dense page (default layers)
    await new Promise(r => setTimeout(r, 3000));
    const t = []; let last = performance.now();
    for (let f = 0; f < 120; f++) { await new Promise(r => requestAnimationFrame(r)); const n = performance.now(); t.push(n - last); last = n;
      gesture(); setT({ x: S.x + 0.3, z: S.z * (f < 60 ? 1.02 : 1 / 1.02) }); }
    t.sort((a, b) => a - b); console.log("p95", t[114]); return t[114] <= 20;`],
  ["hash without p keeps its other params", "v=board", `return S.p === 0 && S.v === "board";`],
  ["fit frames all drawn content in every pane", "p=1&v=board", `
    await new Promise(r => setTimeout(r, 2500));
    const bad = [];
    for (const vp of document.querySelectorAll("#stage .vp")) {
      const R = vp.getBoundingClientRect();
      for (const l of vp.querySelectorAll(".layer")) {
        let u = null;
        for (const g of l.querySelectorAll("svg > g")) { const r = g.getBoundingClientRect(); if (!r.width && !r.height) continue;
          u = u ? [Math.min(u[0], r.left), Math.min(u[1], r.top), Math.max(u[2], r.right), Math.max(u[3], r.bottom)] : [r.left, r.top, r.right, r.bottom]; }
        if (u && (u[0] < R.left - 1 || u[1] < R.top - 1 || u[2] > R.right + 1 || u[3] > R.bottom + 1)) bad.push(l.dataset.layer + " " + u.map(Math.round) + " in " + [R.left, R.top, R.right, R.bottom].map(Math.round));
      }
    }
    return bad.length ? bad.slice(0, 3).join(" ; ") : document.querySelectorAll("#stage .layer").length > 0;`],
  ...["side", "overlay", "wipe", "blend", "semantic"].map(m => [`mode ${m} draws`, `m=${m}`, `
    await new Promise(r => setTimeout(r, 800));
    return S.m === "${m}" && document.querySelector("#stage").classList.contains("mode-${m}")
      && document.querySelector('#modes [aria-pressed="true"]').dataset.mode === "${m}"
      && [...document.querySelectorAll('#stage svg path, #stage svg line, #stage svg rect, #stage svg circle, #stage svg polyline, #stage svg polygon, #stage svg text')].some(e => { const r = e.getBoundingClientRect(); return (r.width > 0 || r.height > 0) && getComputedStyle(e).visibility === 'visible'; });`]),
  ["wipe divider exposes its current keyboard position", "m=wipe", `
    await new Promise(r => setTimeout(r, 800));
    const d = document.querySelector('#stage .divider[role="slider"]'), before = S.wipe;
    const initial = d.getAttribute("aria-valuenow") === String(Math.round(S.wipe * 100)); d.focus();
    d.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    return initial && S.wipe > before && d.getAttribute("aria-valuenow") === String(Math.round(S.wipe * 100)) || JSON.stringify({initial, before, wipe:S.wipe, value:d.getAttribute("aria-valuenow")});`],
  ["wipe divider follows drag", "m=wipe", `
    await new Promise(r => setTimeout(r, 800));
    const d = document.querySelector("#stage .divider"), r = d.parentElement.getBoundingClientRect();
    d.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientX: r.left + r.width / 2 }));
    d.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: r.left + r.width * 0.25 }));
    d.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
    return Math.abs(S.wipe - 0.25) < 0.02 && d.getAttribute("aria-valuenow") === String(Math.round(S.wipe * 100));`],
  ["blend slider sets head opacity", "m=blend", `
    await new Promise(r => setTimeout(r, 800));
    const s = document.querySelector("#modes input[type=range]"); s.value = 20; s.dispatchEvent(new Event("input"));
    return getComputedStyle(document.querySelector("#stage .stack.head")).opacity === "0.2";`],
  ["added project draws its one side in every mode", "p=0&m=overlay", `
    await new Promise(r => setTimeout(r, 800)); return document.querySelectorAll("#stage .stack.head svg").length > 0;`],
  ["layer list grouped, changed layers marked", "p=1&v=board", `
    await new Promise(r => setTimeout(r, 800));
    const L = document.querySelector("#layers");
    return ["Top", "Bottom"].every(g => L.textContent.includes(g))
      && L.querySelectorAll('[data-changed="true"] .mark').length === REVIEW_DATA.projects[1].board.layers.filter(l => l.changed).length;`],
  ["toggling a layer removes it from the drawing", "p=1&v=board", `
    await new Promise(r => setTimeout(r, 800));
    const cb = document.querySelector('#layers input[data-layer="F_Cu"]'); cb.click();
    await new Promise(r => setTimeout(r, 800));
    return !document.querySelector('#stage .layer[data-layer="F_Cu"]') && !S.layers.includes("F_Cu");`],
  ["layer list hidden for sheets", "", `return document.querySelector("#layers").children.length === 0;`],
  ["hitTest picks the smallest containing box, cycles on repeat", "", `
    const rows = [{ id: "a", box: [0, 0, 10, 10] }, { id: "b", box: [4, 4, 6, 6] }, { id: "c", box: [20, 20, 30, 30] }];
    return hitTest(rows, 5, 5)?.id === "b" && hitTest(rows, 5, 5, rows[1])?.id === "a" && hitTest(rows, 50, 50) === null
      && hitTest(rows, 10.4, 5)?.id === "a";`],
  ["filters by kind and by action", "", `
    const total = document.querySelectorAll("#panel .card").length;
    document.querySelector('#panel .chip-filter[data-action="added"]').click();
    const noAdded = [...document.querySelectorAll("#panel .card")].every(c => c.dataset.action !== "added");
    const kinds = document.querySelector("#panel select.kind"); kinds.value = "symbol"; kinds.dispatchEvent(new Event("change"));
    return total > 0 && noAdded && [...document.querySelectorAll("#panel .card")].every(c => c.dataset.kind === "symbol");`],
  ["modified card shows every changed property old and new", "p=1", `
    const r = REVIEW_DATA.projects[1].changes.find(r => r.action === "modified");
    const card = document.querySelector('#panel .card[data-id="' + r.id + '"]');
    return r.changes.every(([k, a, b]) => card.textContent.includes(k) && card.textContent.includes(String(a ?? "—")) && card.textContent.includes(String(b ?? "—")));`],
  ["selecting a row zooms to it and highlights it", "p=1", `
    const r = REVIEW_DATA.projects[1].changes.find(r => r.kind === "footprint" && r.action === "modified");
    document.querySelector('#panel .card[data-id="' + r.id + '"]').click();
    const ready = () => S.s === r.id && S.v === "board" && S.x != null && Math.abs(S.x - (r.box[0] + r.box[2]) / 2) < 0.01
      && document.querySelector("#stage .marker.sel") !== null
      && document.querySelector('#panel .card[data-id="' + r.id + '"]').getAttribute("aria-selected") === "true", until = performance.now() + 5000;
    while (!ready() && performance.now() < until) await new Promise(res => setTimeout(res, 50));
    return ready();`],
  ["clicking the drawing selects the row", "p=1&v=board", `
    await new Promise(res => setTimeout(res, 1200));
    const r = REVIEW_DATA.projects[1].changes.find(r => r.kind === "footprint" && r.action === "modified");
    zoomTo(r.box); await new Promise(res => requestAnimationFrame(res));
    const vp = document.querySelector("#stage .vp"), b = vp.getBoundingClientRect();
    pickAt(vp, { clientX: b.left + b.width / 2, clientY: b.top + b.height / 2 });
    return S.s === r.id && document.querySelector('#panel .card[aria-selected="true"]')?.dataset.id === r.id;`],
  ["markers differ by more than colour", "p=1&v=board&m=semantic", `
    await new Promise(res => setTimeout(res, 1200));
    const m = [...document.querySelectorAll("#stage .marker")];
    const styles = new Set(m.map(e => getComputedStyle(e).borderStyle + "|" + e.dataset.glyph));
    return m.length > 0 && m.every(e => e.dataset.glyph) && styles.size === new Set(m.map(e => e.dataset.action)).size;`],
  ["reused sheet: two navigator entries, separate counts", "p=1", `
    const P = REVIEW_DATA.projects[1], s0 = P.sheets[0];
    P.sheets.push({ ...s0, path: "/copy/", name: "Copy of " + s0.name, parent: s0.path });
    P.changes.push({ action: "added", kind: "symbol", ref: "R99", where: { sheet: "/copy/" }, pos: [10, 10, 0], box: null, props: { Value: "1k" }, id: "cx1" });
    renderNav();
    const a = document.querySelector('#nav [data-view="sheet:/"]'), b = document.querySelector('#nav [data-view="sheet:/copy/"]');
    const n = e => e.querySelector(".chip.added").textContent;
    return a && b && n(b) === "＋1" && n(a) !== n(b) && document.querySelectorAll('#nav [data-view^="sheet:"]').length === 2;`],
  ["panel scrolls instead of stretching the page", "p=1", `
    await new Promise(res => setTimeout(res, 1200));
    const cards = document.querySelector("#panel .cards"), one = cards.innerHTML;
    cards.innerHTML = one.repeat(150);
    const p = document.querySelector("#panel"), vp = document.querySelector("#stage .vp");
    return document.documentElement.scrollHeight <= innerHeight + 1 && p.scrollHeight > p.clientHeight && vp.clientHeight <= innerHeight;`],
  ["search keeps caret and raw text while typing", "p=1", `
    const q = document.querySelector("#panel .q"); q.focus();
    for (const t of ["R", "R1", "R12"]) { q.value = t; q.dispatchEvent(new Event("input")); }
    const cs = [...document.querySelectorAll("#panel .card")];
    return document.querySelector("#panel .q") === q && q.value === "R12" && cs.length > 0 && cs.every(c => c.textContent.includes("R12"));`],
  ["filter chips and tabs show their state", "p=1", `
    const chip = document.querySelector('#panel .chip-filter[data-action="added"]'), on = getComputedStyle(chip);
    const onBg = on.backgroundColor, onDeco = on.textDecorationLine;
    chip.click();
    const off = getComputedStyle(document.querySelector('#panel .chip-filter[data-action="added"]'));
    const tab = getComputedStyle(document.querySelector('#panel [role=tab][aria-selected="true"]')), t2 = getComputedStyle(document.querySelector('#panel [role=tab][aria-selected="false"]'));
    return off.backgroundColor !== onBg && off.textDecorationLine !== onDeco && tab.backgroundColor !== t2.backgroundColor;`],
  ["clicking the Base pane selects the moved row at its old place", "p=1&v=board", `
    await new Promise(res => setTimeout(res, 1200));
    const r = REVIEW_DATA.projects[1].changes.find(r => r.kind === "footprint" && r.action === "modified");
    const o = r.pos_before; zoomTo([o[0] - 3, o[1] - 1, o[0] - 0, o[1] + 1], 1);   // centre = 1.5 mm left of the old centre: inside the Base box, outside the Head box
     await new Promise(res => requestAnimationFrame(res));
    const vp = document.querySelector("#stage .vp.board"), b = vp.getBoundingClientRect();
    pickAt(vp, { clientX: b.left + b.width / 2, clientY: b.top + b.height / 2 });
    return S.s === r.id;`],
  ["checks summary rows show every count", "p=1&t=checks", `
    const P = REVIEW_DATA.projects[1], rows = [...document.querySelectorAll("#panel .checks-summary .check")];
    return rows.length === 4 && P.checks.every(c => { const t = rows.find(r => r.dataset.checkSummary === c.name)?.textContent || "";
      return t.includes(c.title) && t.includes(c.errors + " errors") && t.includes(c.warnings + " warnings") && t.includes(c.new_errors + c.new_warnings ? "+" + (c.new_errors + c.new_warnings) + " new" : ""); });`],
  ["checks summary status and title do not intersect in a 300px panel", "p=1&t=checks", `
    const app = document.querySelector("#app"), prior = app.style.gridTemplateColumns;
    app.style.gridTemplateColumns = "220px minmax(0, 1fr) 300px";
    const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const rows = [...document.querySelectorAll("#panel .checks-summary .check")];
    const ok = document.querySelector("#panel").getBoundingClientRect().width === 300 && rows.length > 0 && rows.every(row => {
      const status = row.querySelector(".check-status"), title = row.querySelector(".check-title");
      return !overlaps(status.getBoundingClientRect(), title.getBoundingClientRect());
    });
    app.style.gridTemplateColumns = prior; return ok;`],
  ["checks summary marks turned-off checks not run", "p=1&t=checks", `
    const keep = REVIEW_DATA.settings.checks.drc; REVIEW_DATA.settings.checks.drc = "off"; renderPanel();
    const row = document.querySelector('#panel .check-not-run[data-check-summary="drc"]'), ok = row && row.textContent.includes("— not run") && row.textContent.includes("turned off in kicad-review.toml");
    REVIEW_DATA.settings.checks.drc = keep; renderPanel(); return !!ok;`],
  ["checks scope and severity chips use non-struck segmented controls", "p=1&t=checks", `
    const scope = document.querySelector('[data-check-scope="new"]'), all = document.querySelector('[data-check-scope="all"]'), severity = document.querySelector('[data-check-severity="error"]');
    const plain = getComputedStyle(all), toggle = getComputedStyle(severity);
    return scope.classList.contains("check-chip") && all.classList.contains("check-chip") && severity.classList.contains("check-chip")
      && plain.textDecorationLine === "none" && toggle.textDecorationLine === "none" && plain.borderStyle === "solid";`],
  ["passing checks with baseline findings say no new errors", "p=1&t=checks", `
    const c = REVIEW_DATA.projects[1].checks.find(c => c.errors > 0); if (!c) return "skip";
    const old = [REVIEW_DATA.settings.fail_on, c.status, c.new_errors];
    REVIEW_DATA.settings.fail_on = "new"; c.status = "pass"; c.new_errors = 0; renderPanel();
    const row = document.querySelector('[data-check-summary="' + c.name + '"]');
    const ok = row.querySelector(".check-status").textContent.includes("passing") && row.querySelector(".check-status-detail").textContent.includes("no new errors");
    [REVIEW_DATA.settings.fail_on, c.status, c.new_errors] = old; renderPanel(); return ok;`],
  ["checks scope chips default to new and switch to all", "p=1&t=checks", `
    const newChip = document.querySelector('[data-check-scope="new"]'), allChip = document.querySelector('[data-check-scope="all"]');
    const onlyNew = newChip.getAttribute("aria-pressed") === "true" && [...document.querySelectorAll("#panel .viol")].every(v => v.dataset.new === "true");
    allChip.click(); return onlyNew && document.querySelector('[data-check-scope="all"]').getAttribute("aria-pressed") === "true" && document.querySelectorAll('#panel .viol[data-new="false"]').length > 0;`],
  ["checks violations group by rule with new groups open first", "p=1&t=checks", `
    document.querySelector('[data-check-scope="all"]').click();
    const groups = [...document.querySelectorAll("#panel .check-group")], keys = new Set(groups.map(g => g.querySelector(".rule").textContent));
    const expected = new Set(REVIEW_DATA.projects[1].checks.flatMap(c => c.violations.map(v => c.name + "\\0" + v.type)));
    const newGroups = groups.filter(g => g.querySelector('.viol[data-new="true"]'));
    return groups.length >= keys.size && groups.length === expected.size && newGroups.every(g => g.open) && groups.slice(0, newGroups.length).every(g => g.querySelector('.viol[data-new="true"]'));`],
  ["clicking a located violation selects it and moves the drawing", "p=1&t=checks", `
    S.v = "board"; await draw(); S.checks.scope = "all"; renderPanel();
    const v = REVIEW_DATA.projects[1].checks.flatMap(c => c.violations).find(v => v.where?.board && v.pos), el = document.querySelector('#panel .viol[data-id="' + v.id + '"]'); el.click();
    await new Promise(r => setTimeout(r, 1200));
    return S.s === v.id && Math.abs(S.x - (v.box ? (v.box[0] + v.box[2]) / 2 : v.pos[0])) < .01 && document.querySelector('#panel .viol[data-id="' + v.id + '"]').getAttribute("aria-selected") === "true";`],
  ["j steps through rendered checks violations", "p=1&t=checks", `
    S.v = "board"; await draw(); S.checks.scope = "all"; renderPanel(); S.s = null;
    const ids = [...document.querySelectorAll('#panel .viol[data-id]:not([aria-disabled])')].map(v => v.dataset.id);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "j" })); await new Promise(r => setTimeout(r, 900));
    return ids.length > 1 && S.s === ids[0];`],
  ["violation without position is listed and does not move", "p=1&t=checks", `
    S.checks.scope = "all"; const v = REVIEW_DATA.projects[1].checks[0].violations[0], old = [v.pos, v.box]; v.pos = null; v.box = null; renderPanel();
    const el = document.querySelector('#panel .viol[data-id="' + v.id + '"]'), before = [S.v, S.x, S.y]; el.click(); await new Promise(r => setTimeout(r, 300));
    const ok = el.textContent.includes("no location") && el.getAttribute("aria-disabled") === "true" && S.v === before[0] && S.x === before[1] && S.s !== v.id;
    [v.pos, v.box] = old; renderPanel(); return ok;`],
  ["violation on an unrendered sheet has no location", "p=1&t=checks", `
    S.checks.scope = "all"; const P = REVIEW_DATA.projects[1], sh = P.sheets[0], old = [sh.status, sh.svg]; sh.status = "unchanged"; sh.svg = null;
    const v = P.checks.flatMap(c => c.violations).find(v => v.pos && v.where?.sheet === sh.path); renderPanel();
    const el = document.querySelector('#panel .viol[data-id="' + v.id + '"]'), ok = el.textContent.includes("no location") && el.getAttribute("aria-disabled") === "true";
    [sh.status, sh.svg] = old; renderPanel(); return ok;`],
  ["state round-trips through the address", "", `
    const s = { p: 1, v: "board", m: "wipe", x: 158.8, y: 78.2, z: 12, s: "c5", t: "checks", layers: ["F_Cu", "Edge_Cuts"] };
    const back = decodeState(encodeState(s));
    return Object.keys(s).every(k => JSON.stringify(back[k]) === JSON.stringify(s[k]));`],
  ["address opens the exact spot", "p=1&v=board&m=overlay&x=158.8&y=78.2&z=12", `
    await new Promise(r => setTimeout(r, 1200));
    return S.p === 1 && S.v === "board" && S.m === "overlay" && S.x === 158.8 && S.z === 12;`],
  ["stale or malformed address falls back to first change", "p=9&v=sheet:/nope/&x=abc&s=c99999", `
    await new Promise(r => setTimeout(r, 1200));
    return S.p === 0 && S.v !== "sheet:/nope/" && Number.isFinite(S.x) && document.querySelectorAll("#stage svg").length > 0;`],
  ["j and k step through changes in list order", "p=1", `
    const ids = [...document.querySelectorAll("#panel .card")].map(c => c.dataset.id);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "j" })); await new Promise(r => setTimeout(r, 900));
    const a = S.s; document.dispatchEvent(new KeyboardEvent("keydown", { key: "j" })); await new Promise(r => setTimeout(r, 900));
    const b = S.s; document.dispatchEvent(new KeyboardEvent("keydown", { key: "k" })); await new Promise(r => setTimeout(r, 900));
    return a === ids[0] && b === ids[1] && S.s === ids[0];`],
  ["keys ignored while typing in search", "p=1", `
    const q = document.querySelector("#panel .q"); q.focus();
    q.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
    return S.s === null;`],
  ["copy link carries review link and fragment; go-to applies a pasted line", "p=1&v=board&x=10&y=20&z=5", `
    await new Promise(r => setTimeout(r, 800));
    const l = positionLink();
    applyGoTo("see " + REVIEW_DATA.links.review + " #p=1&v=board&x=158.8&y=78.2&z=12");
    await new Promise(r => setTimeout(r, 800));
    return l.includes(REVIEW_DATA.links.review) && l.includes("#p=1&v=board") && S.x === 158.8;`],
  ["copy link falls back to a selected readonly field when clipboard fails", "p=1&v=board", `
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const ok = [undefined, { writeText: () => Promise.reject(new Error("denied")) }];
    for (const stub of ok) {
      Object.defineProperty(navigator, "clipboard", { value: stub, configurable: true });
      document.querySelector("#zoombar [data-act=copy]").click(); await sleep(100);
      const f = document.querySelector("#zoombar input[readonly]");
      if (!f || f.value !== positionLink() || document.activeElement !== f || f.selectionStart !== 0 || f.selectionEnd !== f.value.length) return "bad " + (f && f.value);
      f.remove();
    }
    return true;`],
  ["copy link shows Copied when clipboard works", "p=1&v=board", `
    Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.resolve() }, configurable: true });
    const b = document.querySelector("#zoombar [data-act=copy]"); b.click();
    await new Promise(r => setTimeout(r, 100));
    const during = b.textContent;
    await new Promise(r => setTimeout(r, 1700));
    return during.includes("Copied") && b.textContent === "Copy link";`],
  ["theme follows the system and keeps text contrast", "", `
    const lum = c => { const [r, g, b] = c.match(/\\d+/g).map(Number).map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return .2126 * r + .7152 * g + .0722 * b; };
    const start = KRTheme.get(), seen = [], res = {};
    try {
      for (const theme of ["dark", "light"]) {
        KRTheme.set(theme, {persist:false});
        const cs = getComputedStyle(document.body), a = lum(cs.color), b = lum(cs.backgroundColor);
        const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
        res[theme] = {ratio, b, attr:document.documentElement.dataset.theme};
        if (!(ratio >= 4.5 && (theme === "dark" ? b < 0.05 : b > 0.8) && KRTheme.get() === theme)) return JSON.stringify(res);
      }
      document.addEventListener("kr-theme-change", e => seen.push(e.detail));
      KRTheme.set("dark", {persist:false});
      const btn = document.querySelector("[data-theme-toggle]");
      return seen[0] === "dark" && !!btn && btn.getAttribute("aria-pressed") === "true" || JSON.stringify({seen, res});
    } finally { KRTheme.set(start, {persist:false}); }`],
  ["drawing background is KiCad's in both themes", "", `
    await new Promise(r => setTimeout(r, 800));
    return getComputedStyle(document.querySelector("#stage .vp.sheet")).backgroundColor === "rgb(245, 244, 239)";`],
  ["unchanged board: address, violation click and start-up do not throw", "p=1", `
    const P = REVIEW_DATA.projects[1]; P.board = { changed: false, layers: [], status: "modified" };
    const bv = P.checks.flatMap(c => c.violations).find(v => v.where?.board && v.pos);
    await applyState(decodeState("#p=1&v=board"));
    const addr = S.v !== "board";
    S.t = "checks"; renderPanel();
    const el = document.querySelector('#panel .viol[data-id="' + bv.id + '"]');
    const noLoc = el.textContent.includes("no location") && el.getAttribute("aria-disabled") === "true";
    el.click(); await new Promise(r => setTimeout(r, 300));
    S.v = "board"; await draw(); const empty = !!document.querySelector("#stage .empty");
    window.reviewReady = false; history.replaceState(null, "", "#p=1&v=board&s=" + bv.id);
    await start();
    return (addr && noLoc && empty && window.reviewReady === true) || JSON.stringify({ addr, noLoc, empty, ready: window.reviewReady });`],
  ["change cards: long keys and values stay inside their cells", "p=0", `
    const P = REVIEW_DATA.projects[0], long = "Footprint_Library_With_A_Long_Name:SOME_VERY_LONG_FOOTPRINT_NAME_WITHOUT_ANY_BREAKS_0123456789";
    P.changes.unshift({ action: "modified", kind: "footprint", ref: "U1", where: { board: true }, pos: null, box: null, id: "cx2",
                        changes: [["net_settings.classes.Default.diff_pair_via_gap", long, long + "_B"]] },
                      { action: "added", kind: "design rules", ref: "x.kicad_pro", where: null, pos: null, box: null, id: "cx3",
                        props: { "net_settings.classes.Default.diff_pair_via_gap": "0.25", footprint: long } });
    renderPanel();
    const hit = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
    const bad = [];
    for (const id of ["cx2", "cx3"]) {
      const c = document.querySelector('#panel .card[data-id="' + id + '"]');
      if (c.scrollWidth > c.clientWidth) bad.push(id + " scroll " + c.scrollWidth + ">" + c.clientWidth);
      for (const p of c.querySelectorAll(".prop")) { const r = [...p.children].map(e => e.getBoundingClientRect());
        for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) if (hit(r[i], r[j])) bad.push(id + " overlap " + i + "/" + j); }
    }
    return bad.length ? bad.join("; ") : true;`],
  ["added footprint card shows its footprint and layer", "p=0", `
    const r = REVIEW_DATA.projects[0].changes.find(r => r.kind === "footprint" && r.action === "added" && r.props.layer);
    const t = document.querySelector('#panel .card[data-id="' + r.id + '"]').textContent;
    return t.includes(r.props.footprint) && t.includes(r.props.layer) && /\\+\\d+ more/.test(t) && !t.includes("Datasheet");`],
  ["address with selection and position keeps the position", "p=1&v=board&x=150&y=100&z=8&s=c600", `
    await new Promise(r => setTimeout(r, 1200));
    return (S.x === 150 && S.y === 100 && S.z === 8 && S.s === "c600" && document.querySelector("#stage .marker.sel") !== null) || JSON.stringify([S.x, S.z, S.s]);`],
  ["address with only a selection zooms to it", "p=1&s=c600", `
    await new Promise(r => setTimeout(r, 1200));
    const r = REVIEW_DATA.projects[1].changes.find(r => r.id === "c600");
    return (S.v === "board" && Math.abs(S.x - (r.box[0] + r.box[2]) / 2) < 0.01) || JSON.stringify([S.v, S.x]);`],
  ["overlay legend names its colours in words", "p=1&v=board&m=overlay", `
    await new Promise(r => setTimeout(r, 800));
    const t = document.querySelector("#stage .tag"), sw = [...t.querySelectorAll(".sw")].map(e => getComputedStyle(e).backgroundColor);
    return t.textContent.includes("red") && t.textContent.includes("green") && sw.length === 3 && new Set(sw).size === 3;`],
  ["wheel before the first fit does not blank the drawing", "p=1&v=board", `
    await new Promise(r => setTimeout(r, 800));
    S.z = null;
    document.querySelector("#stage .vp").dispatchEvent(new WheelEvent("wheel", { deltaY: -300, clientX: 400, clientY: 400, bubbles: true, cancelable: true }));
    await draw();
    return (Number.isFinite(S.z) && S.z > 0 && Number.isFinite(S.x)) || JSON.stringify([S.x, S.z]);`],
  ["unknown layer in the address draws the default layers", "p=1&v=board&l=Nope", `
    await new Promise(r => setTimeout(r, 800));
    return S.layers === null && document.querySelectorAll("#stage .layer").length > 0;`],
  ["removed project draws its Base in every mode", "p=0", `
    const P = REVIEW_DATA.projects[0]; P.status = "removed"; P.board.status = "removed";
    for (const s of P.sheets) { s.status = "removed"; s.svg = { base: s.svg.head, head: null }; }
    for (const l of P.board.layers) l.svg = { base: l.svg.head, head: null };
    const bad = [];
    for (const v of [P.sheets[0] && "sheet:" + P.sheets[0].path, "board"]) for (const m of Object.keys(MODE_NAMES)) {
      S.m = m; S.v = v; S.x = S.y = S.z = null; await draw();
      const vis = [...document.querySelectorAll("#stage .stack.base svg")].some(e => e.getBoundingClientRect().width > 0);
      if (!vis) bad.push(v + " " + m);
    }
    return bad.length ? bad.join(", ") : true;`],
  ["truncated navigator names carry the full name as a tooltip", "p=1", `
    REVIEW_DATA.projects[1].sheets[0].name = 'A "quoted" <very> long sheet name that will not fit the navigator width at all'; renderNav();
    const ns = [...document.querySelectorAll("#nav .tree .name")];
    return ns.length === 2 && ns[0].title.startsWith(REVIEW_DATA.projects[1].sheets[0].name) && ns.every(n => n.title && n.textContent.endsWith(n.title));`],
  ["mode switch updates the address", "p=1&v=board", `
    await new Promise(r => setTimeout(r, 800));
    document.querySelector('#modes [data-mode="overlay"]').click();
    await new Promise(r => setTimeout(r, 1200));
    return location.hash.includes("m=overlay") || location.hash;`],
  ["clicking the drawing records the selection in the address", "p=1&v=board", `
    await new Promise(r => setTimeout(r, 1200));
    const r = REVIEW_DATA.projects[1].changes.find(r => r.kind === "footprint" && r.action === "modified");
    zoomTo(r.box); await new Promise(res => setTimeout(res, 300));
    const vp = document.querySelector("#stage .vp"), b = vp.getBoundingClientRect();
    pickAt(vp, { clientX: b.left + b.width / 2, clientY: b.top + b.height / 2 });
    await new Promise(res => setTimeout(res, 1200));
    return location.hash.includes("s=" + r.id) || location.hash;`],
  ["inherited object keys are not modes", "p=1&v=board&m=toString", `
    await new Promise(r => setTimeout(r, 800));
    return (S.m === "side" && document.querySelectorAll("#stage .vp").length === 2) || S.m;`],
  ["all layers off survives the address round trip", "p=1&v=board", `
    await new Promise(r => setTimeout(r, 800));
    const back = valid(decodeState(encodeState({ ...S, layers: [] })));
    return Array.isArray(back.layers) && back.layers.length === 0 || JSON.stringify(back.layers);`],
  ["arrow keys on a focused card do not step or block scrolling", "p=1", `
    const c = document.querySelector("#panel .card"); c.focus();
    const e = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    c.dispatchEvent(e); await new Promise(r => setTimeout(r, 300));
    return (S.s === null && !e.defaultPrevented) || JSON.stringify([S.s, e.defaultPrevented]);`],
  ["selecting a row does not rebuild the panel", "p=1", `
    const list = document.querySelector("#panel .cards"), id = document.querySelector("#panel .card").dataset.id;
    goTo(id); await new Promise(r => setTimeout(r, 1500));
    return (list.isConnected && document.querySelector('#panel .card[data-id="' + id + '"]').getAttribute("aria-selected") === "true") || "rebuilt";`],
  ["a cancelled wipe drag stops tracking", "p=1&v=board&m=wipe", `
    await new Promise(r => setTimeout(r, 800));
    const d = document.querySelector("#stage .divider"), r = d.parentElement.getBoundingClientRect();
    d.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientX: r.left + r.width / 2 }));
    d.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 1 }));
    d.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: r.left + r.width * 0.1 }));
    return Math.abs(S.wipe - 0.5) < 0.02 || S.wipe;`],
  ["a capped change list says so", "p=1", `
    const p = REVIEW_DATA.projects[1], keep = p.changes;
    p.changes = Array.from({ length: 1600 }, (_, i) => ({ ...keep[0], id: "x" + i }));
    renderPanel(); const t = document.querySelector("#panel .cards").textContent; p.changes = keep; renderPanel();
    return t.includes("showing 1500 of 1600") || t.slice(-80);`],
  ["generated ids and enums are escaped in markup", "p=1", `
    const p = REVIEW_DATA.projects[1], r = p.changes[0], old = r.id; r.id = 'c"><b id=inj>';
    renderPanel(); const bad = !!document.querySelector("#inj"); r.id = old; renderPanel();
    return !bad || "injected";`],
  ["changes-only mode marks every located change, wires included", "p=0&v=sheet:/&m=semantic", `
    await new Promise(res => setTimeout(res, 1200));
    const want = proj().changes.filter(r => onView(r, S.v) && rowBox(r, "head")), w = document.querySelector("#stage .world");
    const n = w.querySelectorAll(".marker").length;
    return (want.some(r => r.kind === "wire") && n === want.length) || \`\${n} markers for \${want.length} changes\`;`],
  ["arrow keys step after a click on the drawing", "p=1", `
    document.activeElement?.blur(); S.s = null;  // a click on the drawing (a plain div) leaves focus on the body
    document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await new Promise(res => setTimeout(res, 300));
    return S.s !== null || "no step; focus on " + document.activeElement.tagName;`],
  ["3D fallback blocks and panel list cover missing models", "v=3d", `
    if (!REVIEW_DATA.projects[0].board.model3d) return "skip";
    await new Promise(r => setTimeout(r, 500));
    const d = REVIEW_DATA.projects[0].board.no_model || [];
    return d.length === 3 && ["D1", "L1", "U3"].every(ref => d.some(x => x.ref === ref && x.pos?.length === 3 && x.box?.length === 4)) && document.querySelectorAll("[data-no-model]").length === 3;`],
  ["3D visibility controls hide silkscreen", "v=3d", `
    if (!REVIEW_DATA.projects[0].board.model3d) return "skip";
    await new Promise(r => setTimeout(r, 500));
    const cb = document.querySelector('[data-3d-group="silk"]'); if (!cb) return false; cb.click();
    return (S.hidden3d || []).includes("silk");`],
  ["3D visibility classifies geometry on both board sides", "v=3d", `
    if (!REVIEW_DATA.projects[0].board.model3d) return "skip";
    while (!Review3D.state.firstFrame) await new Promise(r => setTimeout(r, 50));
    const st = Review3D.state, {THREE} = THREE3D, bad = [], layers = [];
    st.roots.forEach((root, i) => {
      if (!root) return;
      const meshes = []; root.traverse(o => { if (o.isMesh) meshes.push(o); });
      const pcb = meshes.filter(o => /PCB/i.test(o.name)), box = new THREE.Box3(); pcb.forEach(o => box.union(new THREE.Box3().setFromObject(o)));
      const middle = box.getCenter(new THREE.Vector3()).y, groups = o => st.groups.find(g => g.object === o)?.groups || [];
      for (const [pattern, group] of [[/silkscreen/i, "silk"], [/soldermask/i, "mask"]]) {
        const found = meshes.filter(o => pattern.test(o.name));
        for (const side of ["top", "bottom"]) if (new Set(found.filter(o => groups(o).includes(side)).map(o => group === "silk" ? o.parent : o)).size !== 1) bad.push(i + " " + group + " " + side);
        found.forEach(o => { const side = new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3()).y > middle ? "top" : "bottom"; layers.push({object:o, side}); if (groups(o).join(",") !== [group, side].join(",")) bad.push(i + " " + group + " geometry " + side); });
      }
      if (!pcb.length || pcb.some(o => groups(o).join(",") !== "board")) bad.push(i + " PCB groups");
      const j2 = root.getObjectByName("J2"), parts = [];
      root.traverse(o => { if (/^[A-Z]+\\d+$/.test(o.name)) parts.push(o); });
      for (const part of parts.filter(o => o === j2 || new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3()).y < middle)) {
        const side = part === j2 ? "top" : "bottom"; let count = 0;
        part.traverse(o => { if (o.isMesh) { count++; if (groups(o).join(",") !== "bodies," + side) bad.push(i + " " + part.name + " " + side); } });
        if (!count) bad.push(i + " missing meshes " + part.name);
      }
      if (!j2) bad.push(i + " missing J2");
    });
    document.querySelector('[data-3d-group="bottom"]').click();
    layers.forEach(({object, side}) => { if (object.visible !== (side === "top")) bad.push("bottom toggle " + object.name + " " + side); });
    return bad.length ? bad.join("; ") : true;`],
  ["3D address records camera and hidden groups", "v=3d", `
    if (!REVIEW_DATA.projects[0].board.model3d) return "skip";
    await new Promise(r => setTimeout(r, 500)); S.camera3d = window.Review3D.cameraState(); S.hidden3d=["silk"]; const q=decodeState(encodeState());
    return q.camera3d?.length === 6 && q.hidden3d?.[0] === "silk";`],
  ["3D saved selection address keeps its camera and draws outlines", "v=3d&m=side", `
    if (!REVIEW_DATA.projects[0].board.model3d) return "skip";
    while (!Review3D.state.firstFrame) await new Promise(r => setTimeout(r, 50));
    document.querySelector('[data-3d-camera="top"]').click();
    const camera = Review3D.cameraState(), row = proj().changes.find(r => r.ref === "J2");
    const saved = "#" + encodeState({...S, s:row.id, camera3d:camera, x:null, y:null, z:null});
    history.replaceState(null, "", saved); S.s = null; S.camera3d = null; await start();
    await new Promise(r => setTimeout(r, 700));
    const actual = Review3D.cameraState(), st = Review3D.state, {THREE} = THREE3D;
    const outlined = st.selected?.length === 2 && st.selected.every((o, i) => o.position.distanceTo(new THREE.Box3().setFromObject(st.roots[i].getObjectByName(row.ref)).getCenter(new THREE.Vector3())) < 1e-4);
    return S.s === row.id && outlined && camera.every((n, i) => Math.abs(n - actual[i]) < .2) || JSON.stringify({saved, camera, actual, outlined, selection:S.s});
  `],
  ["3D change card keeps 3D and frames J2", "v=3d", `
    if (!REVIEW_DATA.projects[0].board.model3d) return "skip";
    while (!window.Review3D.state.firstFrame) await new Promise(r => setTimeout(r, 50));
    document.querySelector('#panel [data-id="c2"]').click(); await new Promise(r => setTimeout(r, 600));
    const { THREE } = window.THREE3D, st = window.Review3D.state, n = (() => { let f; st.roots[1].traverse(o => { if (!f && o.name === "J2") f = o; }); return f; })(),
      c = new THREE.Box3().setFromObject(n).getCenter(new THREE.Vector3()).project(st.cameras[0]);
    return (S.v === "3d" && location.hash.includes("v=3d") && S.s === "c2" && Math.abs(c.x) < .15 && Math.abs(c.y) < .15) || JSON.stringify({v:S.v,hash:location.hash,s:S.s,x:c.x,y:c.y});`],
  ["3D selection outline in each pane wraps that pane's own J2", "v=3d&m=side", `
    if (!REVIEW_DATA.projects[0].board.model3d) return "skip";
    while (!window.Review3D.state.firstFrame) await new Promise(r => setTimeout(r, 50));
    document.querySelector('#panel [data-id="c2"]').click(); await new Promise(r => setTimeout(r, 600));
    const { THREE } = window.THREE3D, st = window.Review3D.state, sel = st.selected || [];
    const j2 = r => { let f; r.traverse(o => { if (!f && o.name === "J2") f = o; }); return new THREE.Box3().setFromObject(f).getCenter(new THREE.Vector3()); };
    return sel.length === 2 && [0, 1].every(i => sel[i].position.distanceTo(j2(st.roots[i])) < 1e-4);`],
  ["3D no-model U3 block sits on the board, overlaps its footprint and is not hidden by silkscreen", "v=3d", `
    if (!REVIEW_DATA.projects[0].board.model3d) return "skip";
    while (!window.Review3D.state.firstFrame) await new Promise(r => setTimeout(r, 50));
    const { THREE } = window.THREE3D, st = window.Review3D.state, row = REVIEW_DATA.projects[0].board.no_model.find(x => x.ref === "U3"), blk = st.blocks.filter(b => b.ref === "U3");
    if (!blk.length) return "no U3 block";
    const fp = new THREE.Box3(new THREE.Vector3(row.box[0] / 1000, -1, row.box[1] / 1000), new THREE.Vector3(row.box[2] / 1000, 1, row.box[3] / 1000));
    for (const b of blk) {
      const root = st.roots[b.side === "head" ? 1 : 0]; let top = -Infinity;
      root.traverse(o => { if (o.isMesh && /PCB|silkscreen|soldermask/i.test(o.name)) top = Math.max(top, new THREE.Box3().setFromObject(o).max.y); });
      b.object.updateWorldMatrix(true, true); const w = new THREE.Box3().setFromObject(b.object), ctr = w.getCenter(new THREE.Vector3());
      if (!w.intersectsBox(fp)) return "no overlap " + JSON.stringify([w.min, w.max]);
      if (w.min.y < top - 1e-9 || w.min.y > top + 1e-4) return "not resting on board top " + w.min.y + " vs " + top;
      if (Math.abs(w.max.y - w.min.y - .001) > 1e-6) return "not 1 mm tall";
      const ray = new THREE.Raycaster(new THREE.Vector3(ctr.x, w.max.y + .01, ctr.z), new THREE.Vector3(0, -1, 0)), h = ray.intersectObject(root, true)[0];
      let a = h?.object; while (a && a !== b.object) a = a.parent;
      if (!a) return "first hit from above is " + h?.object.name;
    }
    return true;`],
  ["3D no-model list item frames its block and labels it", "v=3d", `
    if (!REVIEW_DATA.projects[0].board.model3d) return "skip";
    while (!window.Review3D.state.firstFrame) await new Promise(r => setTimeout(r, 50));
    document.querySelector('[data-no-model="U3"]').click(); await new Promise(r => setTimeout(r, 600));
    const { THREE } = window.THREE3D, st = window.Review3D.state, b = st.blocks.find(x => x.ref === "U3" && x.side === "head"), c = new THREE.Box3().setFromObject(b.object).getCenter(new THREE.Vector3()).project(st.cameras[0]);
    return Math.abs(c.x) < .15 && Math.abs(c.y) < .15 && /no 3D model/.test(document.querySelector(".tip3d")?.textContent || "");`],
  ["3D canvas click via mouse input selects J2 row", "v=3d", `
    if (!REVIEW_DATA.projects[0].board.model3d) return "skip";
    return S.s === "c2" && S.v === "3d";`],
  ["Interfaces check shows coverage", "p=1&t=checks", `
    proj().checks.push({ name: "interfaces", title: "Interfaces", level: "informational", status: "pass", errors: 0, warnings: 0, new_errors: 0, new_warnings: 0, fixed: 0, violations: [],
      coverage: { detected: { "I2C nets": 2 }, protected: [3, 5] } });
    renderPanel();
    const t = document.querySelector("#panel .check-coverage")?.textContent || "";
    return t.includes("I2C nets 2") && t.includes("3 of 5 connector signal pins") || t;`],
  ["Reports without an interfaces check show no Interfaces row", "t=checks", `
    if (!proj().checks || proj().checks.some(c => c.name === "interfaces")) return "skip";
    return ![...document.querySelectorAll("#panel .check-title")].some(e => e.textContent === "Interfaces") || "interfaces row shown";`],
  ["Release check shows its package", "p=1&t=checks", `
    const P = proj(); P.checks.push({ name: "release", title: "Release package", level: "informational", status: "pass", errors: 0, warnings: 0, new_errors: 0, new_warnings: 0, fixed: 0, violations: [],
      package: { files: [{ path: "b-review-jlcpcb-gerbers.zip", bytes: 20480 }, { path: "b-review-jlcpcb-bom.csv", bytes: 300 }], sha256: "ab".repeat(32) } });
    renderPanel();
    const t = document.querySelector("#panel .package")?.textContent || "";
    return t.includes("2 files") && t.includes("abababab") && t.includes("gerbers.zip") || t;`],
  ["Reports without a release check show no Release package row", "t=checks", `
    if (!proj().checks || proj().checks.some(c => c.name === "release")) return "skip";
    return ![...document.querySelectorAll("#panel .check-title")].some(e => e.textContent === "Release package") || "release row shown";`],
  ["BOM coverage and field changes render in the Parts tab", "", `
    const P = proj(); P.parts = P.parts || { lines: [], changes: [], supplier: null };
    P.parts.coverage = { base: { Value: [4, 4], Footprint: [4, 4], LCSC: [3, 4], MPN: [1, 4], Manufacturer: [0, 4], Datasheet: [2, 4], "Datasheet (critical)": [1, 2], "Order ready": [3, 4] },
                         head: { Value: [5, 5], Footprint: [5, 5], LCSC: [4, 5], MPN: [3, 5], Manufacturer: [0, 5], Datasheet: [2, 5], "Datasheet (critical)": [1, 3], "Order ready": [4, 5] } };
    P.parts.field_changes = [{ refs: ["R1", "R2"], field: "MPN", before: null, after: "<i>ERJ</i>" }];
    P.parts.dnp_mismatch = ["C9"];
    S.t = "parts"; renderPanel();
    const cov = document.querySelector("#panel .bom-coverage")?.textContent || "", fc = document.querySelector("#panel .field-changes")?.textContent || "";
    return cov.includes("incomplete: Manufacturer") && cov.includes("MPN") && cov.includes("3 / 5") && cov.includes("+2") && cov.includes("Order ready") && fc.includes("R1, R2") && fc.includes("<i>ERJ</i>")
      && !document.querySelector("#panel .field-changes i") && document.querySelector("#panel .dnp-mismatch")?.textContent.includes("C9") || JSON.stringify({cov, fc});`],
  ["Inventory lists every part, searchable, with change badges", "", `
    const P = proj(), row = P.changes.find(r => r.where?.board && rowBox(r, "head") && r.kind === "footprint"); if (!row) return "skip";
    const b = rowBox(row, "head");
    P.objects = [{ uuid: "u1", kind: "footprint", ref: row.ref, value: "1k", footprint: "R_0402", side: "head", pos: [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2, 0], box: b, layer: "F.Cu" },
                 { uuid: "u2", kind: "footprint", ref: "ZZ9", value: '<b>"x"</b>', footprint: "SOT23", side: "head", pos: [1, 1, 0], box: null, layer: "B.Cu" }];
    S.t = "changes"; S.filter.all = true; renderPanel();
    const rows = document.querySelectorAll("#panel .inv-row"), first = [...rows].find(r => r.textContent.includes(row.ref));
    const q = document.querySelector("#panel .q"); q.value = "zz9"; q.dispatchEvent(new Event("input"));
    const after = document.querySelectorAll("#panel .inv-row");
    return rows.length === 2 && first.textContent.includes(row.action) && after.length === 1 && after[0].textContent.includes('<b>"x"</b>') && !document.querySelector("#panel .inv-row b") || JSON.stringify({n: rows.length, after: after.length});`],
  ["Inventory removed part is listed and zooms", "", `
    const P = proj(), row = P.changes.find(r => r.where?.board && rowBox(r, "head")); if (!row) return "skip";
    const b = rowBox(row, "head");
    P.objects = [{ uuid: "u3", kind: "footprint", ref: "GONE1", value: "x", footprint: "y", side: "base", pos: [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2, 0], box: b, layer: "F.Cu" }];
    S.filter.all = true; S.filter.q = ""; renderPanel();
    const r = document.querySelector("#panel .inv-row"); if (!r.textContent.includes("removed")) return "no removed badge";
    await goToObject(0);
    return S.v === "board" && Math.abs(S.x - (b[0] + b[2]) / 2) < 0.01 || JSON.stringify({v: S.v, x: S.x});`],
  ["Inventory caps long lists", "", `
    const P = proj(); P.objects = Array.from({ length: 1600 }, (_, i) => ({ uuid: "u" + i, kind: "footprint", ref: "R" + i, value: "1k", footprint: "f", side: "head", pos: [i, 0, 0], box: null, layer: "F.Cu" }));
    S.filter.all = true; S.filter.q = ""; renderPanel();
    return document.querySelectorAll("#panel .inv-row").length === 1500 && document.querySelector("#panel .cards").textContent.includes("showing 1500 of 1600") || "no cap";`],
  ["Inventory follows project", "", `
    if (D.projects.length < 2) return "skip";
    D.projects[0].objects = [{ uuid: "a", kind: "symbol", ref: "PA1", side: "head", pos: [0, 0], box: null, sheet: "/" }];
    D.projects[1].objects = [{ uuid: "b", kind: "symbol", ref: "PB1", side: "head", pos: [0, 0], box: null, sheet: "/" }];
    S.filter.all = true; openProject(1);
    return document.querySelector("#panel .cards").textContent.includes("PB1") && !document.querySelector("#panel .cards").textContent.includes("PA1") || "wrong project";`],
  ["Inventory badges follow side and search covers layer", "", `
    const P = proj(); P.changes = [{ kind: "footprint", ref: "Q1", action: "added", where: { board: true } }, { kind: "footprint", ref: "Q1", action: "removed", where: { board: true } }];
    P.objects = [{ uuid: "b", kind: "footprint", ref: "Q1", side: "base", pos: [0, 0, 0], box: null, layer: "F.Cu" }, { uuid: "h", kind: "footprint", ref: "Q1", side: "head", pos: [0, 0, 0], box: null, layer: "B.Cu" }];
    S.t = "changes"; S.filter.all = true; S.filter.q = ""; renderPanel();
    const rows = [...document.querySelectorAll("#panel .inv-row")].map(r => r.textContent);
    const q = document.querySelector("#panel .q"); q.value = "b.cu"; q.dispatchEvent(new Event("input"));
    const n = document.querySelectorAll("#panel .inv-row").length;
    return rows[0].includes("removed") && rows[1].includes("added") && n === 1 || JSON.stringify({ rows, n });`],
  ["Parts fixture sorts problems and greys stale stock", "", `
  if (REVIEW_DATA.repo !== 'example/parts') return 'skip';
  document.querySelector('[data-tab=parts]').click();
  const rows = [...document.querySelectorAll('#panel .parts-row')];
  if (rows.length !== REVIEW_DATA.projects[0].parts.lines.length || !rows[0].classList.contains('problem')) return 'rows';
  if (!document.querySelector('.parts-age.stale') || rows.some(r => !r.querySelector('.parts-stock.stale') || r.querySelector('.parts-stock').textContent.includes('✔'))
    || !rows.some(r => r.querySelector('.parts-stock').textContent.includes('(stale)'))) return 'stale';
  if (document.querySelector('.parts-table img') || [...document.querySelectorAll('.parts-table a')].some(a => !/^https?:/.test(a.href) || a.rel !== 'noopener noreferrer' || a.target !== '_blank')) return 'escaping';
  document.querySelector('[data-parts-filter=problems]').click();
  if (document.querySelectorAll('.parts-row').length !== 2 || document.querySelector('.parts-table').textContent.includes('U5')) return 'problems filter';
  document.querySelector('[data-parts-filter=changed]').click();
  if (document.querySelectorAll('.parts-row').length !== 1) return 'changed filter';
  S.partsFilter.problems = false; renderPanel();
  const moved = [...document.querySelectorAll('.parts-row')].find(r => r.textContent.includes('R7'));
  if (moved.children[1].textContent !== 'R7' || !moved.textContent.includes('10k → 4.7k')) return 'changed refs only';
  S.partsFilter.changed = false; renderPanel();
  const line = [...document.querySelectorAll('.parts-row')].find(r => r.textContent.includes('R7'));
  if (!line.classList.contains('changed') || line.children[1].textContent !== 'R6, R7' || line.querySelector('strong').textContent !== 'R7'
    || !line.textContent.includes('10k → 4.7k (R7)') || document.querySelectorAll('.parts-row.changed').length !== 2) return 'changed marking';
  REVIEW_DATA.projects[0].parts.supplier = null; renderPanel();
  if (document.querySelector('.parts-age, .parts-attribution, .parts-lookup-error') || [...document.querySelectorAll('.parts-stock')].some(c => c.textContent !== '—')) return 'no lookup';
  if (valid({t:'parts'}).t !== 'parts') return 'hash';
  const parts = REVIEW_DATA.projects[0].parts;
  if (document.querySelector('[data-tab=parts]').textContent !== 'Parts 5 · 2 ⚠') return 'blocking count';
  parts.supplier = {error:'503'}; renderPanel();
  const unavailable = document.querySelector('.parts-row.unavailable .parts-stock').textContent;
  if (!unavailable.includes('unavailable') || !document.querySelector('.parts-lookup-error')?.textContent.includes('503') || document.querySelector('.parts-table img')) return 'failed lookup';
  parts.supplier = {fetched_at:'invalid <timestamp>'}; renderPanel();
  if (!document.querySelector('.parts-age.stale') || document.querySelector('.parts-age').textContent.includes('NaN')
      || [...document.querySelectorAll('.parts-stock')].some(c => !c.classList.contains('stale') || c.textContent.includes('✔'))) return 'invalid timestamp';
  const savedProblems = parts.lines.map(l => l.problems);
  parts.lines.forEach(l => l.problems = ['missing_mpn', 'unavailable']); renderPanel();
  if (document.querySelector('[data-tab=parts]').textContent !== 'Parts 5') return 'zero blocking count';
  parts.lines.forEach((l, i) => l.problems = savedProblems[i]);
  parts.supplier = {fetched_at: new Date(Date.now() - 2 * 36e5).toISOString()}; renderPanel();
  if (![...document.querySelectorAll('.parts-stock')].some(c => c.textContent.includes('✔')) || document.querySelector('.parts-stock.stale')) return 'fresh';
  parts.changes.push({action:'removed',refs:['R8'],before:{...parts.lines[0],refs:['R8']},after:null}); renderPanel();
  if (document.querySelectorAll('.parts-row').length !== 6 || !document.querySelector('.parts-table').textContent.includes('R8')) return 'removed';
  parts.changes.push({action:'footprint',refs:['R1'],before:{...parts.lines[0],footprint:'R_0402'},after:parts.lines[0]}); renderPanel();
  if (!document.querySelector('.parts-footprint')?.textContent.includes('R_0402 → R_0603')) return 'footprint change';
  delete REVIEW_DATA.projects[0].parts; renderPanel();
  return !document.querySelector('[data-tab=parts]') && S.t === 'changes';
`],
  ["DigiKey column shows stock, price, time and attribution", "", `
    const p = REVIEW_DATA.projects[0], old = p.parts;
    const line = (ref, supplier, mpn = ref) => ({refs:[ref], key:ref, value:ref, footprint:'F', lcsc:'C1', mpn, datasheet:null, problems:[], supplier});
    p.parts = {lines:[line('U1',{status:'ok',quantity:1234,unit_price:9,breaks:[[1,1.5]],product_status:'Active <img src=x>',url:'https://www.digikey.ca/en/products/x'}),
      line('U2',{status:'out_of_stock',quantity:0,unit_price:2}), line('U3',{status:'ambiguous',matches:2,unit_price:99}),
      line('R1',null,null)],changes:[],supplier:{name:'DigiKey',currency:'USD',fetched_at:new Date().toISOString(),error:null,skipped:null,not_looked_up:{no_mpn:54,invalid_mpn:1,run_limit:2}}};
    S.t='parts'; S.partsFilter={problems:false,changed:false}; renderPanel();
    const cells = () => [...document.querySelectorAll('.parts-stock')];
    if (![...document.querySelectorAll('.parts-table th')].some(x=>x.textContent==='DigiKey')) return 'header';
    if (!cells()[0].textContent.includes('✔ 1234') || !cells()[0].textContent.includes('$1.50') || !cells()[0].querySelector('a')?.href.startsWith('https://www.digikey.ca/')) return 'stock or price';
    if (!cells()[0].textContent.includes('Active <img src=x>') || cells()[0].querySelector('img')) return 'product status escaping';
    if (cells()[0].querySelector('a').rel!=='noopener noreferrer' || !document.querySelector('.parts-age').textContent.includes('DigiKey data as of') || !document.querySelector('.parts-attribution').textContent.includes('Stock and price from DigiKey')) return 'attribution';
    if (!document.querySelector('.parts-not-looked-up').textContent.includes('54 parts not looked up: no MPN') || document.querySelector('#panel').textContent.includes('JLCPCB')) return 'coverage';
    if (!cells()[2].textContent.includes('several matches') || cells()[2].textContent.includes('99')) return 'ambiguous';
    p.parts.supplier.error='1 lookups failed (last: HTTP 500)'; renderPanel();
    if (!cells()[0].textContent.includes('✔ 1234') || !document.querySelector('.parts-lookup-error')) return 'partial failure blanks successful data';
    p.parts.lines[0].supplier.url='https://www.digikey.com@evil.com/x'; renderPanel();
    if (cells()[0].querySelector('a')) return 'unsafe link';
    p.parts.lines[0].supplier.url='https://www.digikey.evil.com/x'; renderPanel();
    if (cells()[0].querySelector('a')) return 'unsafe host';
    p.parts.supplier.fetched_at=new Date(Date.now()-25*36e5).toISOString(); renderPanel();
    if (cells().some(x=>x.textContent.includes('✔') || x.textContent.includes('in stock')) || !cells()[0].textContent.includes('(stale)')) return 'stale';
    p.parts.supplier.fetched_at=new Date().toISOString(); p.parts.supplier.currency='CAD'; renderPanel();
    if (!cells()[0].textContent.includes('CA$1.50')) return 'currency';
    p.parts.supplier.skipped='no credentials (forked pull request or secrets not set)'; renderPanel();
    if (!document.querySelector('.parts-age').textContent.includes('DigiKey lookup skipped: no credentials') || cells().some(x=>x.textContent.includes('✔'))) return 'skipped';
    p.parts.supplier.skipped=null; p.parts.lines[0].supplier={status:'unavailable',mpn:'<img src=x onerror=alert(1)>'}; renderPanel();
    if (!cells()[0].textContent.includes('unavailable') || document.querySelector('.parts-table img')) return 'unavailable';
    p.parts.supplier=null; renderPanel();
    if (cells().some(x=>x.textContent!=='—') || document.querySelector('.parts-age, .parts-attribution, .parts-lookup-error')) return 'disabled supplier UI';
    p.parts=old; return true;
  `],
  ["Parts report matches head BOM line count", "t=parts", `
  const parts = REVIEW_DATA.projects[S.p].parts;
  if (!parts || REVIEW_DATA.repo === 'example/parts') return 'skip';
  document.querySelector('[data-tab=parts]').click();
  return document.querySelector('[data-tab=parts]').textContent === 'Parts ' + parts.lines.length + (partsProblemCount(parts) ? ' · ' + partsProblemCount(parts) + ' ⚠' : '')
    && document.querySelectorAll('.parts-row').length === parts.lines.length
    && (!REVIEW_DATA.projects[S.p].name.includes('Thermal_Camera') || parts.lines.length === 29)
    && !document.querySelector('.parts-age, .parts-attribution, .parts-lookup-error');
`],
  ["Readiness ready message blockMerge is false when unframed", "", `
    return !THREADS_ON && typeof readyMessage === "function" && readyMessage().blockMerge === false && readyMessage().kicadReviewReady === true || "ready message";`],
  ["Threads arrival preserves the drawing during the first right-click", "v=board", `
    const vp = document.querySelector("#stage .vp"), world = vp.querySelector(".world");
    const rect = vp.getBoundingClientRect(), event = new MouseEvent("contextmenu", {bubbles:true, cancelable:true, clientX:rect.left + rect.width / 2, clientY:rect.top + rect.height / 2});
    const saved = parent.postMessage, enabled = THREADS_ON, sent = [];
    parent.postMessage = data => sent.push(data);
    THREADS_ON = true;
    try {
      vp.dispatchEvent(new PointerEvent("pointerdown", {button:2, bubbles:true}));
      acceptThreads([]);
      await new Promise(r => setTimeout(r, 100));
      if (!vp.isConnected || vp.querySelector(".world") !== world) return "thread arrival replaced right-click target";
      vp.dispatchEvent(event);
      return event.defaultPrevented && sent.length === 1 && !!sent[0].kicadReviewPin?.file || JSON.stringify(sent);
    } finally { parent.postMessage = saved; THREADS_ON = enabled; }
  `],
  ["Threads anchorAt pins an object and falls back to a point", "", `
    const P = proj(), row = P.changes.find(r => r.where?.board && rowBox(r, "head")); if (!row) return "skip";
    await goTo(row.id); const b = rowBox(row, "head"), cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
    P.objects = [{ uuid: "u-1", kind: "footprint", ref: "RX1", value: "1k", side: "head", pos: [cx, cy, 0], box: b, layer: "F.Cu" }];
    const a = anchorAt(cx, cy, "head"), pt = anchorAt(b[2] + 500, b[3] + 500, "head");
    return a.target === "object" && a.uuid === "u-1" && a.ref === "RX1" && a.file.endsWith(P.name + ".kicad_pcb") && a.commit === D.head
      && a.v === 1 && a.severity === "comment" && pt.target === "point" && pt.uuid === null && pt.x === round3(b[2] + 500) || JSON.stringify({a, pt});`],
  ["Threads anchorAt uses the sub-sheet file", "", `
    const P = proj(), sheet = P.sheets.find(s => s.status !== "unchanged" && s.svg); if (!sheet) return "skip";
    S.v = "sheet:" + sheet.path; S.x = S.y = S.z = null; renderNav(); await draw();
    const a = anchorAt(1, 1, "head");
    return a.sheet === sheet.path && a.file === (P.dir ? P.dir + "/" : "") + sheet.file || JSON.stringify(a);`],
  ["Threads resolveAnchor follows UUID, then reference, and flags moves", "", `
    const P = proj(); P.objects = [{ uuid: "u-2", kind: "footprint", ref: "R9", side: "head", pos: [10, 10, 0], box: [9, 9, 11, 11], layer: "F.Cu", pos_before: [5, 5, 0] }];
    const base = { v: 1, project: P.dir, file: "x.kicad_pcb", sheet: null, layer: "F.Cu", target: "object", kind: "footprint", side: "head", commit: "0ld1234", severity: "comment" };
    const byUuid = resolveAnchor({ ...base, uuid: "u-2", ref: "R9", x: 10, y: 10 });
    const byRef = resolveAnchor({ ...base, uuid: "gone", ref: "R9", x: 3, y: 3 });
    return byUuid.view === "board" && byUuid.side === "head" && byUuid.pos[0] === 10 && !byUuid.notes.some(n => n.startsWith("moved"))
      && byRef.pos[0] === 10 && byRef.notes.some(n => n.startsWith("moved since 0ld1234"))
      && byUuid.notes.includes("pinned on 0ld1234, viewing " + D.head.slice(0, 7)) || JSON.stringify({byUuid, byRef});`],
  ["Threads resolveAnchor removed object pins base", "", `
    const P = proj(); P.objects = [{ uuid: "u-3", kind: "footprint", ref: "C4", side: "base", pos: [7, 7, 0], box: [6, 6, 8, 8], layer: "F.Cu" }];
    const r = resolveAnchor({ v: 1, project: P.dir, file: "x.kicad_pcb", sheet: null, layer: "F.Cu", target: "object", uuid: "u-3", kind: "footprint", ref: "C4", x: 7, y: 7, side: "head", commit: D.head, severity: "comment" });
    const gone = resolveAnchor({ v: 1, project: P.dir, file: "x.kicad_pcb", sheet: null, layer: null, target: "object", uuid: "nope", kind: "footprint", ref: "C99", x: 1, y: 1, side: "head", commit: D.head, severity: "comment" });
    return r.side === "base" && r.notes.includes("C4 was removed in this change") && typeof gone.detached === "string" || JSON.stringify({r, gone});`],
  ["Threads resolveAnchor point flags a changed area", "", `
    const P = proj(), row = P.changes.find(r => r.where?.board && r.box); if (!row) return "skip";
    const x = (row.box[0] + row.box[2]) / 2, y = (row.box[1] + row.box[3]) / 2;
    const pt = { v: 1, project: P.dir, file: "x.kicad_pcb", sheet: null, layer: null, target: "point", uuid: null, kind: null, ref: null, x, y, side: "head", severity: "comment" };
    const old = resolveAnchor({ ...pt, commit: "0ld1234" }), same = resolveAnchor({ ...pt, commit: D.head }), base = resolveAnchor({ ...pt, commit: D.base });
    P.changes = [{ where: { board: true }, pos: [50, 50, 0], pos_before: [5, 5, 0] }];
    const before = resolveAnchor({ ...pt, x: 5, y: 5, commit: "0ld1234" }), after = resolveAnchor({ ...pt, x: 50, y: 50, commit: "0ld1234" });
    P.changes = [{ where: { sheet: "/other/" }, pos_before: [5, 5, 0] }];
    const otherView = resolveAnchor({ ...pt, x: 5, y: 5, commit: "0ld1234" });
    return old.notes.includes("this area changed since 0ld1234") && !same.notes.some(n => n.startsWith("this area"))
      && !base.notes.some(n => n.startsWith("this area")) && before.notes.includes("this area changed since 0ld1234")
      && after.notes.includes("this area changed since 0ld1234") && !otherView.notes.some(n => n.startsWith("this area")) || JSON.stringify({old, same, base, before, after, otherView});`],
  ["Threads anchorAt rejects a missing sheet file", "", `
    S.v = "sheet:/nope/";
    const a = anchorAt(1, 1, "head");
    return a === null || JSON.stringify(a);`],
  ["Threads resolveAnchor prioritizes UUID before reference", "", `
    const P = proj();
    P.objects = [
      { uuid: "u-a", kind: "footprint", ref: "R9", side: "head", pos: [1, 1, 0], layer: "F.Cu" },
      { uuid: "u-b", kind: "footprint", ref: "R9", side: "head", pos: [20, 1, 0], layer: "F.Cu" }
    ];
    const a = { v: 1, project: P.dir, file: "x.kicad_pcb", sheet: null, layer: "F.Cu", target: "object", kind: "footprint", ref: "R9", x: 20, y: 1, side: "head", commit: D.head, severity: "comment" };
    const uuid = resolveAnchor({ ...a, uuid: "u-b" }), ref = resolveAnchor({ ...a, uuid: "unknown" });
    return uuid.pos[0] === 20 && ref.pos[0] === 1 || JSON.stringify({uuid, ref});`],
  ["Threads anchorAt base uses previous position and excludes additions", "", `
    if (D.base == null) return "skip";
    const P = proj(); S.v = "board";
    P.objects = [
      { uuid: "moved", kind: "footprint", ref: "R1", side: "head", pos: [50, 50, 0], pos_before: [5, 5, 0], box: [49, 49, 51, 51], layer: "F.Cu" },
      { uuid: "added", kind: "footprint", ref: "R2", side: "head", pos: [20, 20, 0], box: [19, 19, 21, 21], layer: "F.Cu", added: true }
    ];
    const moved = anchorAt(5, 5, "base"), added = anchorAt(20, 20, "base"), headPosition = anchorAt(50, 50, "base");
    return moved.target === "object" && moved.uuid === "moved" && moved.x === 5 && moved.y === 5 && moved.side === "base" && moved.commit === D.base
      && added.target === "point" && added.uuid === null && added.side === "base" && added.commit === D.base
      && headPosition.target === "point" || JSON.stringify({moved, added, headPosition});`],
  ["Threads resolveAnchor reference prefers the same sheet then any", "", `
    const P = proj();
    const objects = [
      { uuid: "u-a", kind: "symbol", ref: "R1", side: "head", pos: [1, 1, 0], sheet: "/a/" },
      { uuid: "u-b", kind: "symbol", ref: "R1", side: "head", pos: [20, 1, 0], sheet: "/b/" }
    ];
    const a = { v: 1, project: P.dir, file: "b.kicad_sch", sheet: "/b/", layer: null, target: "object", uuid: "unknown", kind: "symbol", ref: "R1", x: 20, y: 1, side: "head", commit: D.head, severity: "comment" };
    P.objects = objects;
    const head = resolveAnchor(a), any = resolveAnchor({ ...a, sheet: "/missing/" });
    P.objects = objects.map(o => ({ ...o, side: "base" }));
    const base = resolveAnchor(a), baseAny = resolveAnchor({ ...a, sheet: "/missing/" }), baseUuid = resolveAnchor({ ...a, uuid: "u-b" });
    return head.view === "sheet:/b/" && head.pos[0] === 20 && any.view === "sheet:/a/"
      && base.view === "sheet:/b/" && base.side === "base" && baseAny.view === "sheet:/a/" && baseUuid.pos[0] === 20 || JSON.stringify({head, any, base, baseAny, baseUuid});`],
  ["Threads tab and pins appear only with thread data", "", `
    const P = proj(), row = P.changes.find(r => r.where?.board && rowBox(r, "head")); if (!row) return "skip";
    if (document.querySelector('#panel [data-tab="threads"]')) return "tab shown offline";
    const b = rowBox(row, "head"), x = (b[0] + b[2]) / 2, y = (b[1] + b[3]) / 2;
    P.objects = [{ uuid: "u-5", kind: "footprint", ref: "Q1", side: "head", pos: [x, y, 0], box: b, layer: "F.Cu" }];
    acceptThreads([{ id: "T1", resolved: false, anchor: { v: 1, project: P.dir, file: "f.kicad_pcb", sheet: null, layer: "F.Cu", target: "object", uuid: "u-5", kind: "footprint", ref: "Q1", x, y, side: "head", commit: D.head, severity: "blocking" }, comments: [{ author: "alice", body: "<img src=x onerror=alert(1)> too close", createdAt: "2026-10-12T10:00:00Z" }] },
                   { id: "T2", resolved: true, anchor: { v: 1, project: P.dir, file: "f.kicad_pcb", sheet: null, layer: null, target: "point", uuid: null, kind: null, ref: null, x, y, side: "head", commit: D.head, severity: "comment" }, comments: [] }]);
    S.t = "threads"; renderPanel(); await goTo(row.id);
    const tab = document.querySelector('#panel [data-tab="threads"]'), cards = document.querySelectorAll("#panel .thread-card");
    const pins = document.querySelectorAll("#stage .pin");
    return !!tab && /^Threads 1$/.test(tab.textContent.trim()) && cards.length === 1 && cards[0].textContent.includes("Blocking") && !document.querySelector("#panel img")
      && pins.length >= 1 && [...pins].every(p => p.classList.contains("pin-blocking") && p.getAttribute("aria-label").includes("Q1")) || JSON.stringify({tab: !!tab, cards: cards.length, pins: pins.length});`],
  ["Threads resolved filter and detached group", "", `
    const P = proj(); P.objects = [];
    acceptThreads([{ id: "T3", resolved: true, anchor: { v: 1, project: P.dir, file: "f", sheet: null, layer: null, target: "point", uuid: null, kind: null, ref: null, x: 1, y: 1, side: "head", commit: D.head, severity: "comment" }, comments: [] },
                   { id: "T4", resolved: false, anchor: { v: 1, project: P.dir, file: "f", sheet: null, layer: null, target: "object", uuid: "zz", kind: "footprint", ref: "U99", x: 1, y: 1, side: "head", commit: D.head, severity: "comment" }, comments: [] }]);
    S.t = "threads"; S.threadFilter.status = "resolved"; renderPanel();
    const resolved = document.querySelectorAll("#panel .thread-card").length;
    S.threadFilter.status = "open"; renderPanel();
    const detached = document.querySelector("#panel .threads-detached")?.textContent || "";
    return resolved === 1 && detached.includes("U99") || JSON.stringify({resolved, detached});`],
  ["Threads messages from a non-parent window are ignored", "", `
    S.threads = null; renderPanel();
    window.dispatchEvent(new MessageEvent("message", { source: window, data: { kicadReviewThreads: [] } }));
    await new Promise(r => setTimeout(r, 50));
    if (S.threads !== null || document.querySelector('#panel [data-tab="threads"]')) return "accepted offline";
    const ignored = handleParentMessage({ source: {}, data: { kicadReviewThreads: [] } }, true);
    if (ignored !== false || S.threads !== null) return "accepted non-parent";
    const accepted = handleParentMessage({ source: parent, data: { kicadReviewThreads: [] } }, true);
    return accepted === true && Array.isArray(S.threads) && S.threads.length === 0 || "rejected parent";`],
  ["Threads j and k step through thread cards", "", `
    const P = proj(), row = P.changes.find(r => r.where?.board && rowBox(r, "head")); if (!row) return "skip";
    await goTo(row.id);
    const b = rowBox(row, "head"), x = (b[0] + b[2]) / 2, y = (b[1] + b[3]) / 2;
    P.objects = [0, 1].map(i => ({ uuid: "step-u-" + i, kind: "footprint", ref: "Q" + (i + 1), side: "head", pos: [x + i * 10, y, 0], box: [x + i * 10 - 1, y - 1, x + i * 10 + 1, y + 1], layer: "F.Cu" }));
    acceptThreads(P.objects.map((o, i) => ({ id: "step-T" + i, resolved: false, anchor: { v: 1, project: P.dir, file: viewFile(P, "board"), sheet: null, layer: o.layer, target: "object", uuid: o.uuid, kind: o.kind, ref: o.ref, x: o.pos[0], y: o.pos[1], side: "head", commit: D.head, severity: "comment" }, comments: [] })));
    S.t = "threads"; renderPanel(); await draw();
    const ids = [...document.querySelectorAll("#panel .thread-card[data-thread]")].map(e => e.dataset.thread);
    if (ids.length !== 2) return "expected two cards";
    openThread(ids[0]);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "j" }));
    const afterJ = S.thread;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k" }));
    return afterJ === ids[1] && S.thread === ids[0] || JSON.stringify({ ids, afterJ, afterK: S.thread });`],
  ["Threads placement resets on Escape and view selection", "", `
    S.placing = true; document.body.classList.add("placing");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    const escapeCleared = !S.placing && !document.body.classList.contains("placing");
    S.placing = true; document.body.classList.add("placing");
    select(firstChangedView(proj()));
    return escapeCleared && !S.placing && !document.body.classList.contains("placing") || "placement stayed active";`],
  ["Threads opening a blank drawing keeps the current view", "", `
    const P = proj(), view = S.v;
    acceptThreads([{ id: "blank-T", resolved: false, anchor: { v: 1, project: P.dir, file: "missing.kicad_sch", sheet: "/missing/", layer: null, target: "point", uuid: null, kind: null, ref: null, x: 1, y: 1, side: "head", commit: D.head, severity: "comment" }, comments: [] }]);
    S.t = "threads"; renderPanel(); await openThread("blank-T");
    return S.v === view && S.thread === "blank-T" && document.querySelector("#panel .thread-card")?.textContent.includes("its drawing did not change in this review") || JSON.stringify({view, current: S.v, thread: S.thread, text: document.querySelector("#panel .thread-card")?.textContent});`],
  ["Threads severity select and cards retain focus", "", `
    const P = proj();
    acceptThreads([{ id: 'focus-"T', resolved: false, anchor: { v: 1, project: P.dir, file: "f.kicad_pcb", sheet: null, layer: null, target: "point", uuid: null, kind: null, ref: null, x: 1, y: 1, side: "head", commit: D.head, severity: "comment" }, comments: [] }]);
    S.t = "threads"; renderPanel();
    const select = document.querySelector("#panel select.thread-severity");
    select.focus(); select.value = "comment"; select.dispatchEvent(new Event("change")); renderPanel();
    const severityFocused = document.activeElement === document.querySelector("#panel select.thread-severity");
    document.querySelector("#panel .thread-card").focus(); renderPanel();
    return severityFocused && document.activeElement === document.querySelector("#panel .thread-card") || JSON.stringify({severityFocused, active: document.activeElement.className});`],
  ["Threads saved tab opens when thread data arrives", "", `
    S.t = "threads"; S.threads = null; renderPanel();
    const waiting = S.t === "changes" && S.wantThreads === true;
    acceptThreads([]);
    return waiting && S.t === "threads" && !S.wantThreads || JSON.stringify({waiting, tab: S.t, want: S.wantThreads});`],
  ["Threads hash tab survives reload before data arrives", "t=threads", `
    const waiting = S.t === "changes" && S.wantThreads === true;
    acceptThreads([]);
    return waiting && S.t === "threads" && !S.wantThreads || JSON.stringify({waiting, tab: S.t, want: S.wantThreads});`],
  ["Threads tab click cancels deferred tab selection", "", `
    S.t = "threads"; S.threads = null; renderPanel();
    document.querySelector('#panel [data-tab="checks"]').click();
    acceptThreads([]);
    return S.t === "checks" && !S.wantThreads || JSON.stringify({tab: S.t, want: S.wantThreads});`],
  ["Threads opening another drawable view clears placement", "", `
    const P = proj(), row = P.changes.find(r => r.where?.board && rowBox(r, "head")); if (!row || !currentView("board")) return "skip";
    const b = rowBox(row, "head"), x = (b[0] + b[2]) / 2, y = (b[1] + b[3]) / 2;
    acceptThreads([{ id: "placing-T", resolved: false, anchor: { v: 1, project: P.dir, file: viewFile(P, "board"), sheet: null, layer: null, target: "point", uuid: null, kind: null, ref: null, x, y, side: "head", commit: D.head, severity: "comment" }, comments: [] }]);
    S.v = "sheet:/missing/"; S.t = "threads"; renderPanel();
    S.placing = true; document.body.classList.add("placing");
    await openThread("placing-T");
    return S.v === "board" && !S.placing && !document.body.classList.contains("placing") || JSON.stringify({view: S.v, placing: S.placing, crosshair: document.body.classList.contains("placing")});`],
  ["Threads invalid ids cannot drop valid threads or run conversions", "", `
    const anchor = { v: 1, project: proj().dir, file: "f.kicad_pcb", sheet: null, layer: null, target: "point", uuid: null, kind: null, ref: null, x: 1, y: 1, side: "head", commit: D.head, severity: "comment" };
    const thread = id => ({ id, resolved: false, anchor, comments: [] });
    acceptThreads([thread({ toString: 1 }), thread("ok1")]);
    if (S.threads.length !== 1 || S.threads[0].id !== "ok1") return "bad id dropped valid thread";
    let converted = false;
    const objectId = { toString() { converted = true; return "x"; } };
    if (![1, null, new String("x"), objectId].every(id => !validThread(thread(id))) || !validThread(thread("x")) || converted) return "incorrect id validation";
    const throwing = { get id() { throw new Error("bad thread"); } };
    acceptThreads([throwing, thread("ok1")]);
    return S.threads.length === 1 && S.threads[0].id === "ok1" || "validation error dropped valid thread";`],
  ["Issues issue pins reuse re-anchoring", "", `
    const P = proj(), row = P.changes.find(r => r.where?.board && rowBox(r, "head")); if (!row) return "skip";
    const b = rowBox(row, "head"), x = (b[0] + b[2]) / 2, y = (b[1] + b[3]) / 2;
    P.objects = [{ uuid: "u-9", kind: "footprint", ref: "Q7", side: "base", pos: [x, y, 0], box: b, layer: "F.Cu" }];
    S.threads = []; acceptIssues([{ number: 12, title: "Q7 heat", url: "https://github.com/o/r/issues/12", state: "open",
      anchor: { v: 1, project: P.dir, file: "f.kicad_pcb", sheet: null, layer: "F.Cu", target: "object", uuid: "u-9", kind: "footprint", ref: "Q7", x, y, side: "head", commit: D.head, severity: "comment" } }]);
    await goTo(row.id);
    const pins = [...document.querySelectorAll("#stage .pin-issue")];
    S.t = "threads"; renderPanel();
    return pins.length === 1 && pins[0].textContent === "#12" && !!pins[0].closest(".world").querySelector(".stack.base")
      && document.querySelector("#panel .issues-group")?.textContent.includes("#12 Q7 heat") || JSON.stringify({pins: pins.length});`],
  ["Issues unlocated findings cannot become issues", "p=1&t=checks", `
    const vs = (proj().checks || []).flatMap(c => c.violations); if (!vs.length) return "skip";
    S.threads = []; S.issues = []; S.checks.scope = "all"; renderPanel();
    const located = vs.find(v => v.pos), unlocated = vs.find(v => !v.pos);
    return (!located || !!findingAnchor(located)) && (!unlocated || findingAnchor(unlocated) === null)
      && (!unlocated || !document.querySelector('#panel [data-issue-for="' + unlocated.id + '"]')) || "wrong";`],

  ["Issues forged and opted-out messages are ignored", "", `
    S.issues = null;
    const wrong = handleParentMessage({ source: {}, data: { kicadReviewIssues: [] } }, false, true);
    const off = handleParentMessage({ source: parent, data: { kicadReviewIssues: [] } }, false, false);
    if (wrong || off || S.issues !== null) return "accepted forbidden message";
    const ok = handleParentMessage({ source: parent, data: { kicadReviewIssues: [] } }, false, true);
    return ok && Array.isArray(S.issues) || "rejected opted-in parent";`],
  ["Issues invalid links and numbers never become cards or pins", "", `
    const anchor = { v: 1, project: proj().dir, file: "f.kicad_pcb", target: "point", sheet: null, x: 1, y: 1, side: "head", commit: D.head };
    const issue = { number: 12, title: "<img src=x onerror=alert(1)>", url: "https://github.com/o/r/issues/12", anchor, state: "open" };
    acceptIssues([{ ...issue, url: "javascript:alert(1)" }, { ...issue, number: -1 }, { ...issue, url: "https://evil.example/o/r/issues/12" }, { ...issue, state: "closed" }, issue]);
    S.t = "threads"; renderPanel();
    return S.issues.length === 1 && !document.querySelector("#panel img") && document.querySelector("#panel .issues-group")?.textContent.includes("<img") || "unsafe issues";`],
  ["Issues actions are opt-in and finding points remain valid", "p=1&t=checks", `
    const checks = proj().checks || []; if (!checks.some(c => c.violations.length)) return "skip";
    const vs = allViolations();
    S.checks.scope = "all"; ISSUES_ON = false; renderPanel(); const before = document.querySelector("#panel").innerHTML;
    S.issues = null; renderPanel();
    if (document.querySelector("#panel [data-issue-for]") || document.querySelector("#panel").innerHTML !== before) return "off changed checks";
    const located = vs.find(v => findingAnchor(v)); if (!located) return "skip";
    ISSUES_ON = true; renderPanel();
    const a = findingAnchor(located), button = document.querySelector('#panel [data-issue-for="' + CSS.escape(located.id) + '"]');
    return !!button && a.target === "point" && a.file.endsWith(".kicad_sch") && a.side === "head" && findingAnchor({ ...located, pos: null }) === null && findingAnchor({ ...located, pos: [NaN, 1] }) === null || "finding action missing";`],
  ["Issues duplicate findings cannot create another issue", "p=1&t=checks", `
    const checks = proj().checks || []; if (!checks.some(c => c.violations.length)) return "skip";
    const v = allViolations().find(v => findingAnchor(v)); if (!v) return "skip";
    const a = findingAnchor(v); ISSUES_ON = true; S.checks.scope = "all"; S.issues = []; renderPanel();
    const selector = '#panel [data-issue-for="' + CSS.escape(v.id) + '"]';
    if (!document.querySelector(selector)) return "initial action missing";
    acceptIssues([{ number: 88, title: "Already tracked", url: "https://github.com/o/r/issues/88", state: "open", anchor: a }]);
    if (document.querySelector(selector)) return "duplicate action still shown";
    acceptIssues([{ number: 88, title: "Other file", url: "https://github.com/o/r/issues/88", state: "open", anchor: { ...a, file: "other.kicad_sch" } }]);
    return !!document.querySelector(selector) || "different location blocked";`],
  ["Waivers hide waived findings behind a chip and tag them", "p=1&t=checks", `
    const P = proj(), c = (P.checks || []).find(c => c.violations.length); if (!c) return "skip";
    const v = c.violations[0]; v.waiver_key = "w-abcdefabcdef"; v.waived = { reason: "intended <b>x</b>", by: "ann", until: "2026-12-31", ref: null };
    c.waived = 1; S.checks.scope = "all"; renderPanel();
    const hidden = !document.querySelector('#panel .viol[data-id="' + v.id + '"]'), chip = document.querySelector('#panel [data-check-waived]');
    chip.focus(); chip.click();
    const focused = document.activeElement.matches("[data-check-waived]"), summary = document.querySelector("#panel .check-counts").textContent;
    const shown = document.querySelector('#panel .viol[data-id="' + v.id + '"]');
    return focused && summary.includes("1 waived") && hidden && chip.textContent.includes("Waived 1") && !!shown && shown.textContent.includes("WAIVED") && shown.textContent.includes("intended <b>x</b>")
      && !document.querySelector("#panel .viol b") || JSON.stringify({hidden, chip: chip?.textContent, shown: shown?.textContent});`],
  ["Waivers offer a copyable TOML entry for an unwaived finding", "p=1&t=checks", `
    const P = proj(), c = (P.checks || []).find(c => ["erc", "drc", "parity"].includes(c.name) && c.violations.length); if (!c) return "skip";
    const v = c.violations.find(x => !x.waived); v.waiver_key = "w-0123456789ab"; S.checks.scope = "all"; renderPanel();
    const b = document.querySelector('#panel [data-waive="' + v.id + '"]'); b.closest('details').open = true; b.focus(); b.click();
    const pre = document.querySelector("#panel .waiver-snippet")?.textContent || "";
    const button = document.activeElement;
    return button.matches('[data-waive]') && button.getAttribute('aria-label') === 'Waive ' + (v.items.join(' · ') || v.description)
      && document.querySelector("#panel .waiver-help").textContent.includes("on the pull request's target branch")
      && document.getElementById(button.getAttribute('aria-controls'))?.textContent === pre && pre.includes('check = "' + c.name + '"') && pre.includes('match = "w-0123456789ab"') && pre.includes("until = ") && pre.includes("[[waiver]]") || pre;`],
  ["Waivers show no waive button without keys", "p=1&t=checks", `
    proj().checks.forEach(c => c.violations.forEach(v => { delete v.waiver_key; delete v.waived; })); S.checks.scope = "all"; renderPanel();
    return !document.querySelector("#panel [data-waive]") && !document.querySelector("#panel [data-check-waived]") || "shown";`],

  ["Waivers show-all reveals an only-waived change", "p=1&t=checks", `
    const c = (proj().checks || []).find(c => c.violations.length); if (!c) return "skip";
    proj().checks.forEach(c => c.violations.forEach(v => { v.new = true; v.waived = { reason: "intentional", by: "ann" }; }));
    S.checks.scope = null; renderPanel();
    const scope = document.querySelector('[data-check-scope="all"]').getAttribute("aria-pressed");
    document.querySelector("#panel .show-all").click();
    return scope === "true" && S.checks.waived && !!document.querySelector("#panel .viol .waived-reason") || "not revealed";`],
  ["Waivers snippets preserve quoted keys and remove comment controls", "p=1&t=checks", `
    const key = 'w-"\\\\b\\\\f\\n\\r\\t' + String.fromCharCode(0, 8, 12, 31, 127);
    const text = waiverSnippet({waiver_key:key, description:'x\\r\\n' + String.fromCharCode(0, 127) + '<b>x</b>'}, 'erc');
    const match = text.split("\\n").find(l => l.startsWith("match = ")).slice(8);
    return JSON.parse(match) === key && !/[\\u0000-\\u0008\\u000b-\\u001f\\u007f]/.test(text) && text.includes('# x  ') || text;`],
  ["SCH6 hierarchy page order boundaries legacy and escaped labels", "", `
    const p = proj(), source = p.sheets.find(s => s.svg);
    if (!source) throw Error('fixture needs a schematic');
    p.sheets = [
      {...source, path:'/', parent:null, name:'Root', page:'1'},
      {...source, path:'/ten/', parent:'/', name:'Ten', page:'10'},
      {...source, path:'/two/', parent:'/', name:'<b>Two</b>', page:'2'},
      {...source, path:'/two/sub/', parent:'/two/', name:'Sub', page:'3'},
      {...source, path:'/a10/', parent:'/', name:'A10', page:'A10'},
      {...source, path:'/a2/', parent:'/', name:'A2', page:'A2'},
      {...source, path:'/old/', parent:'/', name:'Legacy', page:undefined}
    ];
    S.v = 'sheet:/two/sub/'; renderNav();
    const text = document.querySelector('#nav').textContent;
    if (!text.includes('<b>Two</b> (page 2)') || document.querySelector('#nav .name b')) return 'label escaping';
    if (orderedSheets().map(s=>sheetNumber(s)).join(',') !== '1,2,3,7,10,A2,A10') return 'page order';
    navigateSheet('parent'); if (S.v !== 'sheet:/two/') return 'parent';
    navigateSheet(-1); if (S.v !== 'sheet:/') return 'previous';
    navigateSheet(-1); if (S.v !== 'sheet:/') return 'first boundary';
    S.v = 'sheet:/a10/'; renderNav(); navigateSheet(1);
    if (S.v !== 'sheet:/a10/') return 'last boundary';
    const ten=p.sheets.find(s=>s.path==='/ten/'), two=p.sheets.find(s=>s.path==='/two/');
    ten.page='2';
    if(compareSheetPages(ten,two)>=0) return 'duplicate-page traversal tie';
    const row = document.querySelector('#nav [data-view="sheet:/a10/"]');
    return row?.getAttribute('aria-current') === 'true'
      && parseInt(getComputedStyle(row.querySelector('.name')).fontWeight) >= 600
      && text.includes('Legacy (page 7)') || 'active/legacy';
  `],
  ["SCH6 sheet keys leave editors and board keys alone", "", `
    const p=proj(), source=p.sheets.find(s=>s.svg);
    p.sheets=[{...source,path:'/',parent:null,page:'1'},
              {...source,path:'/c/',parent:'/',page:'2'}];
    S.v='sheet:/'; renderNav();
    const key=(target,key,extra={})=>target.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...extra}));
    key(document.body,'PageDown'); if(S.v!=='sheet:/c/') return 'next key';
    key(document.body,'ArrowUp',{altKey:true}); if(S.v!=='sheet:/') return 'parent key';
    const input=document.createElement('div'); input.contentEditable='true'; document.body.append(input);
    key(input,'PageDown'); input.remove(); if(S.v!=='sheet:/') return 'editor stolen';
    S.v='board'; const old=S.v; key(document.body,'ArrowUp',{altKey:true});
    return S.v===old || 'board changed';
  `],
  ["board scene stale decode does not replace current view", "v=board&x=10&y=20&z=5", `
    const old = loadBoardScene;
    let release;
    loadBoardScene = async key => { await new Promise(r => release = r); return old(key); };
    const a = draw();
    const sheet = proj().sheets.find(s => s.svg);
    if (!sheet) { loadBoardScene = old; release?.(); await a; return "skip"; }
    S.v = "sheet:" + sheet.path; const b = draw(); release?.();
    await Promise.all([a, b]); loadBoardScene = old;
    return S.v.startsWith("sheet:") && !document.querySelector(".board-gl");`],
  ["board scene loader decodes cached scenes and rejects bad blobs", "v=board", `
    const gz = async text => { const buf = await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer(); return btoa(String.fromCharCode(...new Uint8Array(buf))); };
    D.blobs.sceneOk = await gz(JSON.stringify({version: 1, units: "um", complete: true, warnings: [], bounds: [0, 0, 1, 1], layers: [], nets: [{id: 0, name: ""}], objects: []}));
    D.blobs.sceneBad = await gz("{not json");
    D.blobs.sceneShape = await gz('{"version":2}');
    const fails = [];
    for (const k of ["sceneBad", "sceneShape"]) { try { await loadBoardScene(k); } catch { fails.push(k); } }
    const scene = await loadBoardScene("sceneOk");
    return scene.version === 1 && await loadBoardScene("sceneOk") === scene && fails.length === 2
      && !boardSceneCache.has("sceneBad") && !boardSceneCache.has("sceneShape") && await loadBoardScene(null) === null || "loader";`],
  ["board rings holes islands and DPR", "", `
    if (!window.BoardGL) return "missing BoardGL";
    const R = (...a) => a.map(([x0,y0,x1,y1]) => [[x0,y0],[x1,y0],[x1,y1],[x0,y1]]);
    const [outer, hole, island] = R([0,0,10000,10000],[2000,2000,8000,8000],[12000,0,14000,2000]);
    const concave = [[0,0],[10000,0],[10000,10000],[6000,10000],[6000,5000],[4000,5000],[4000,10000],[0,10000]];
    const zone = (uuid, rings, box) => ({kind:"zone",uuid,changeUuid:uuid,layers:["F.Cu"],net:0,category:"zones",side:null,hidden:false,box:box||[0,0,14000,10000],geometry:{rings}});
    const mk = objects => ({version:1,units:"um",complete:true,warnings:[],bounds:[0,0,14000,10000],layers:[{id:0,name:"F.Cu",type:"signal",enabled:true}],nets:[{id:0,name:""}],objects});
    const bg = [0,16,35], copper = [200,52,52], equal = (p,q) => p.slice(0,3).every((v,i)=>Math.abs(v-q[i])<=2);
    const state = {activeLayer:"F.Cu",layers:{"F.Cu":{color:[200,52,52,1],visible:true}},objects:{zones:{opacity:1}},nets:{}};
    const reversed = [...hole].reverse();
    const cases = [["plain",[outer,hole,island]],["reversed hole",[outer,reversed,island]],["repeated closing point",[[...outer,outer[0]],hole,island]]];
    const failures = [], canvas = document.createElement("canvas");
    canvas.style.cssText = "position:fixed;left:300px;top:180px;width:400px;height:300px;z-index:9999";
    document.body.append(canvas);
    try {
      for (const dpr of [1,2]) for (const [name, rings] of cases) {
        const r = BoardGL.create(canvas,{scene:mk([zone("z",rings)]),onFailure:e=>failures.push(e.message)});
        if (!r) return "WebGL2/stencil unavailable: " + failures;
        const cam = {x:7,y:5,z:20,width:400,height:300,dpr,flip:false};
        r.setAppearance(state); r.setCamera(cam); r.draw();
        const at = (wx,wy) => { const [sx,sy] = BoardGL.worldToScreen([wx,wy],cam); return r.readPixel(Math.round(sx*dpr), Math.round(300*dpr-sy*dpr)); };
        const got = [at(1,1),at(5,5),at(13,1),at(11,1)];
        if (![copper,bg,copper,bg].every((c,i)=>equal(got[i],c))) return name+" dpr"+dpr+" "+JSON.stringify(got);
        r.dispose();
      }
      // concave outer: the notch between x 4..6, y 5..10 stays empty; two overlapping zones keep separate parity.
      let r = BoardGL.create(canvas,{scene:mk([zone("c",[concave],[0,0,10000,10000])]),onFailure:e=>failures.push(e.message)});
      let cam = {x:7,y:5,z:20,width:400,height:300,dpr:1,flip:false};
      r.setAppearance(state); r.setCamera(cam); r.draw();
      let at = (wx,wy) => { const [sx,sy] = BoardGL.worldToScreen([wx,wy],cam); return r.readPixel(Math.round(sx), Math.round(300-sy)); };
      if (!equal(at(1,8),copper) || !equal(at(5,8),bg) || !equal(at(5,2),copper) || !equal(at(8,8),copper)) return "concave bridge " + JSON.stringify([at(1,8),at(5,8),at(5,2),at(8,8)]);
      r.dispose();
      r = BoardGL.create(canvas,{scene:mk([zone("a",[outer],[0,0,10000,10000]),zone("b",[R([4000,4000,12000,9000])[0]],[4000,4000,12000,9000])]),onFailure:e=>failures.push(e.message)});
      r.setAppearance(state); r.setCamera(cam); r.draw();
      at = (wx,wy) => { const [sx,sy] = BoardGL.worldToScreen([wx,wy],cam); return r.readPixel(Math.round(sx), Math.round(300-sy)); };
      if (!equal(at(6,6),copper) || !equal(at(11,6),copper) || !equal(at(1,1),copper) || !equal(at(11,2),bg)) return "overlapping zones " + JSON.stringify([at(6,6),at(11,6),at(1,1),at(11,2)]);
      // grid: dot at a 0.5 mm intersection, none between; off leaves the board unchanged.
      r.dispose();
      r = BoardGL.create(canvas,{scene:mk([]),onFailure:e=>failures.push(e.message)});
      r.setCamera({x:7,y:5,z:40,width:400,height:300,dpr:1,flip:false});
      const gstate = {...state, grid:{visible:true,size:.5}}; r.setAppearance(gstate); r.draw();
      const dot = r.readPixel(200+Math.round((7.5-7)*40),300-(150+Math.round((5.5-5)*40))), gap = r.readPixel(200+Math.round(.25*40),300-(150+Math.round(.25*40)));
      if (equal(dot,bg) || !equal(gap,bg)) return "grid dot/gap " + JSON.stringify([dot,gap]);
      r.setAppearance({...state}); r.draw();
      if (!equal(r.readPixel(200,150),bg)) return "grid off";
      r.dispose(); r.dispose();
      return failures.length ? failures.join() : true;
    } finally { canvas.remove(); }`],
  ["Stage 1 icon references resolve in-file in both themes", "", `
  const old=KRTheme.get();
  try {
    for(const theme of ['dark','light']) {
      KRTheme.set(theme);
      for(const use of document.querySelectorAll('button use')) {
        if(!document.querySelector(use.getAttribute('href'))) return 'unresolved '+use.getAttribute('href');
      }
      const b=document.querySelector('#zoombar [data-z="1.25"]');
      const icons=[...b.querySelectorAll('svg')].filter(s=>getComputedStyle(s).display!=='none');
      if(icons.length!==1 || !icons[0].querySelector('use').getAttribute('href').endsWith(theme)) return 'palette';
      const box=icons[0].getBBox(); if(!box.width || !box.height) return 'empty icon';
      if(!b.getAttribute('aria-label') || !b.title) return 'unlabeled';
    }
    return true;
  } finally { KRTheme.set(old); }`],
  ["Stage 1 offline asset closure and shell proof", "v=board", `
  const external=[...document.querySelectorAll('script[src],link[rel=stylesheet][href],use[href]')]
    .filter(el=>!(el.getAttribute('href')||'').startsWith('#'));
  const embedded=!document.querySelector('script[src="review.js"]');
  if(embedded && external.length) return external.map(el=>el.outerHTML).join(' ');
  if(!document.querySelector('[data-theme-toggle]') || !document.querySelector('#statusbar')) return 'missing shell';
  const old=KRTheme.get();
  KRTheme.set('light'); const light=getComputedStyle(document.body).backgroundColor;
  KRTheme.set('dark'); const dark=getComputedStyle(document.body).backgroundColor;
  KRTheme.set(old);
  return light==='rgb(228, 232, 237)' && dark==='rgb(20, 23, 28)';`],
  ["board WebGL cameras fallback and context loss", "v=board&x=10&y=20&z=5", `
    const p = proj(); if (!p.board?.changed) return "skip";
    const gz = async text => { const buf = await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer(); return btoa(String.fromCharCode(...new Uint8Array(buf))); };
    const scene = {version:1,units:"um",complete:true,warnings:[{uuid:"u<img src=x onerror=alert(1)>",kind:"track",reason:"r"}],bounds:[0,0,8000,5000],layers:[{id:0,name:"F.Cu",type:"signal",enabled:true}],nets:[{id:0,name:""}],
      objects:[{kind:"track",uuid:"t",changeUuid:"t",layers:["F.Cu"],net:0,category:"tracks",side:null,hidden:false,box:[750,750,6250,1250],geometry:{segments:[[1000,1000,6000,1000,500]]}}]};
    D.blobs.glA = await gz(JSON.stringify(scene)); D.blobs.glB = await gz(JSON.stringify(scene));
    const saved = p.board.geometry;
    try {
      p.board.geometry = {base:"glA", head:"glB"}; boardView.failed = null; S.m = "side"; S.v = "board"; await draw();
      if (boardView.renderers.length !== 2) return "expected two supported revision canvases";
      if (document.querySelectorAll(".vp > .board-gl").length !== 2 || document.querySelector(".stack .layer")) return "canvases not in viewports";
      if (document.querySelector(".board-diag img") || !document.querySelector(".board-diag pre").textContent.includes("<img")) return "diagnostics not literal text";
      const first = boardView.renderers[0]; await draw();
      if (boardView.renderers[0] !== first || first.stats.disposed) return "renderer not retained across draw";
      setT({x:12,y:22,z:6});
      if (boardView.renderers.some(r => r.stats.disposed)) return "disposed current scene";
      const canvas = document.querySelector(".board-gl");
      canvas.dispatchEvent(new Event("webglcontextlost",{cancelable:true}));
      await new Promise(r => setTimeout(r,100));
      if (document.querySelector(".board-gl") || !document.querySelector(".stack .layer")) return "no SVG fallback";
      if (!document.querySelector("#statusbar .status-message").textContent.includes("WebGL unavailable")) return "no status note";
      return S.x === 12 && S.y === 22 && S.z === 6 || "camera lost " + [S.x,S.y,S.z];
    } finally { p.board.geometry = saved; boardView.failed = null; boardView.note = null; S.m = "side"; }`],
  ["board WebGL missing context, bad scenes, added-only and SVG modes", "v=board", `
    const p = proj(); if (!p.board?.changed) return "skip";
    const gz = async text => { const buf = await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer(); return btoa(String.fromCharCode(...new Uint8Array(buf))); };
    const scene = c => ({version:1,units:"um",complete:c,warnings:[],bounds:[0,0,8000,5000],layers:[{id:0,name:"F.Cu",type:"signal",enabled:true}],nets:[{id:0,name:""}],objects:[]});
    D.blobs.glOk = await gz(JSON.stringify(scene(true))); D.blobs.glPart = await gz(JSON.stringify(scene(false))); D.blobs.glBad = await gz("{nope");
    const saved = p.board.geometry, create = BoardGL.create, status = () => document.querySelector("#statusbar .status-message").textContent;
    const svgOk = () => !!document.querySelector(".stack .layer") && !document.querySelector(".board-gl");
    try {
      S.v = "board"; S.m = "side";
      delete p.board.geometry;
      for (const m of ["side","overlay","wipe","blend","semantic"]) { S.m = m; await draw(); if (!svgOk()) return "no geometry " + m; }
      S.m = "side"; p.board.geometry = {base:"glOk", head:"glOk"};
      BoardGL.create = () => null; boardView.failed = null; await draw();
      if (!svgOk() || !status().includes("WebGL unavailable")) return "missing WebGL2 " + status();
      BoardGL.create = create; boardView.failed = null;
      for (const [key, g] of [["corrupt", {base:"glBad", head:"glOk"}], ["incomplete", {base:"glOk", head:"glPart"}]]) {
        p.board.geometry = g; await draw();
        if (!svgOk() || !status().includes("Geometry unsupported")) return key + " " + status();
      }
      for (const g of [{base:null, head:"glOk"}, {base:"glOk", head:null}]) {
        p.board.geometry = g; await draw();
        if (boardView.renderers.length !== 1 || document.querySelectorAll(".vp .tag")[g.base ? 1 : 0].textContent.indexOf("not present") < 0) return "one-sided " + JSON.stringify(g);
      }
      for (const m of ["overlay","wipe","blend","semantic"]) { p.board.geometry = {base:"glOk", head:"glOk"}; S.m = m; await draw(); if (!svgOk() || boardView.renderers.length) return "mode " + m; }
      return true;
    } finally { BoardGL.create = create; p.board.geometry = saved; boardView.failed = null; boardView.note = null; S.m = "side"; }`],
  ["board flip adapters mirror camera, overlays and pointer", "v=board&x=10&y=20&z=5", `
    const p = proj(); if (!p.board?.changed) return "skip";
    S.v = "board"; S.m = "side"; await draw();
    const vp0 = document.querySelector("#stage .vp"), r0 = vp0.getBoundingClientRect(), e = {clientX: r0.left + r0.width / 2 + 100, clientY: r0.top + r0.height / 2 + 50};
    const plain = toWorld(vp0, e);
    Appearance.patch({flip:true});
    try {
      await new Promise(r => setTimeout(r, 50));
      const vp = document.querySelector("#stage .vp"), r = vp.getBoundingClientRect(), flipped = toWorld(vp, e);
      if (Math.abs(flipped[0] - (S.x - (plain[0] - S.x))) > 1e-6 || flipped[1] !== plain[1]) return "inverse " + [plain, flipped];
      const back = BoardGL.worldToScreen(flipped, {x:S.x,y:S.y,z:S.z,width:r.width,height:r.height,flip:true});
      if (Math.abs(back[0] - (e.clientX - r.left)) > 1e-6) return "forward";
      const w = document.querySelector("#stage .world");
      if (!w.style.transform.includes("scale(-") || !vp.classList.contains("flip")) return "world not mirrored " + w.style.transform;
      if (S.x !== 10 || S.y !== 20 || S.z !== 5) return "flip changed the camera";
      if (location.hash.includes("flip")) return "flip leaked into the hash";
    } finally { Appearance.patch({flip:false}); }
    await new Promise(r => setTimeout(r, 100));
    return !document.querySelector("#stage .world").style.transform.includes("scale(-");`],
  ["board Appearance store get patch subscribe reset and validation", "", `
    const A = window.Appearance, before = JSON.stringify(A.get());
    let calls = 0; const off = A.subscribe(() => calls++);
    try {
      A.patch({contrast:"dim", grid:{visible:true,size:2}, layers:{"F.Cu":{color:[1,2,3,.5],opacity:.4}}});
      const s = A.get();
      if (s.contrast !== "dim" || !s.grid.visible || s.grid.size !== 2 || s.layers["F.Cu"].opacity !== .4 || s.layers["F.Cu"].color[3] !== .5 || calls !== 1) return "patch";
      A.patch({contrast:"bad", flip:"yes", grid:{size:-1}, layers:{"F.Cu":{opacity:NaN,color:[1,2,3]},"__proto__":{visible:false},"Nope":{visible:false}}, objects:{tracks:{opacity:9}}, nets:{"__proto__":{visible:false},"<img>":{visible:false}}});
      const t = A.get();
      if (t.contrast !== "dim" || t.flip !== false || t.grid.size !== 2 || t.layers["F.Cu"].opacity !== .4 || t.layers.Nope || t.objects.tracks.opacity !== 1 || ({}).visible !== undefined || !t.nets["<img>"]) return "validation " + JSON.stringify(t.layers["F.Cu"]);
      if (JSON.parse(localStorage.getItem("kr.appearance.v1")).contrast !== "dim") return "not persisted";
      const throwing = Storage.prototype.setItem; Storage.prototype.setItem = () => { throw new Error("blocked"); };
      try { A.patch({contrast:"hide"}); } finally { Storage.prototype.setItem = throwing; }
      if (A.get().contrast !== "hide") return "blocked storage";
      A.reset();
      return JSON.stringify(A.get()) === before && A.defaults(["F.Cu"]).objects.zones.opacity === .6 && A.normalize(null).contrast === "normal" && calls === 4 || "reset " + calls;
    } finally { off(); A.reset(); }`],
  ["board layer paint preserves custom colours and store snapshots", "v=board", `
    const d=document.createElement('div'); d.innerHTML='<svg><path fill="none" stroke="rgb(200,52,52)" style="opacity:.3"/><path fill="#123456" stroke="#c83434"/></svg>';
    recolorLayer(d,{color:[1,2,3,1],opacity:.5},KicadColors.layers['F.Cu']);
    const [a,b]=d.querySelectorAll('path');
    if(a.getAttribute('fill')!=='none' || a.getAttribute('stroke')!=='#010203' || a.style.opacity!=='.3' && a.style.opacity!=='0.3') return 'layer paint';
    if(b.getAttribute('fill')!=='#123456' || b.getAttribute('stroke')!=='#010203') return 'custom paint overwritten';
    const look=Appearance.get(), old=look.flip; look.flip=!old;
    if(Appearance.get().flip!==old) { Appearance.patch({flip:old}); return 'mutable snapshot'; }
    return true;`],
  ["Fit board keeps a finite shared camera", "v=board", `
    S.v='board'; S.m='side'; await draw(); fit();
    return Number.isFinite(S.x) && Number.isFinite(S.y) && Number.isFinite(S.z) && S.z>0;`],
  ["Wipe Blend board SVG respect Appearance layer eyes", "v=board", `
    const before=Appearance.get();
    try {
      for(const m of ['wipe','blend']) {
        S.v='board'; S.m=m; await draw();
        const layer=document.querySelector('.stack .layer'); if(!layer) return 'no SVG '+m;
        const name=canon(layer.dataset.layer);
        Appearance.patch({layers:{[name]:{visible:false}}}); await draw();
        if([...document.querySelectorAll('.stack .layer')].some(l=>canon(l.dataset.layer)===name)) return 'eye ignored '+m;
        Appearance.patch({layers:{[name]:before.layers[name]}});
      }
      return true;
    } finally { Appearance.patch(before); }`],
  ["board keys units grid contrast and editing focus", "v=board", `
    Appearance.reset(); const key=(key,extra={})=>document.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...extra}));
    const before=S.z; key('F1'); if(S.z<before*1.3) return 'F1 zoom'; key('F2');
    key('h'); if(Appearance.get().contrast!=='dim') return 'H dim'; key('h'); if(Appearance.get().contrast!=='hide') return 'H hide'; key('h');
    key('PageDown'); if(Appearance.get().activeLayer!=='B.Cu') return 'bottom'; key('PageUp'); if(Appearance.get().activeLayer!=='F.Cu') return 'top';
    key('u',{ctrlKey:true}); if(Appearance.get().units!=='mil') return 'units';
    Appearance.patch({grid:{size:1.27}}); const g=Appearance.get().grid.size; key('n'); key('N',{shiftKey:true}); if(Math.abs(Appearance.get().grid.size-g)>1e-9) return 'grid inverse';
    const input=document.querySelector('#zoombar .goto'); input.focus(); input.dispatchEvent(new KeyboardEvent('keydown',{key:'h',bubbles:true})); if(Appearance.get().contrast!=='normal') return 'editing'; input.blur();
    const z=S.z; key('+',{ctrlKey:true,shiftKey:true}); if(S.z<z*1.3) return 'ctrl shift zoom';
    const copy=new KeyboardEvent('keydown',{key:'c',ctrlKey:true,bubbles:true,cancelable:true}); document.dispatchEvent(copy); if(copy.defaultPrevented) return 'copy consumed';
    key('?'); if(!document.querySelector('#shortcuts[open]')) return 'sheet'; document.querySelector('#shortcuts').close(); Appearance.reset(); return true;`],
  ["board pointer cancellation flip status and wheel anchor", "v=board", `
    const vp=document.querySelector('#stage .vp'), r=vp.getBoundingClientRect();
    const event=(type,x,y,button=0)=>vp.dispatchEvent(new PointerEvent(type,{clientX:x,clientY:y,button,pointerId:1,bubbles:true}));
    for(const button of [0,1,2]) { setT({x:10,y:20,z:8}); event('pointerdown',r.left+40,r.top+40,button); event('pointermove',r.left+80,r.top+40,button); event('pointercancel',r.left+80,r.top+40,button); if(S.x!==5) return 'pan '+button; event('pointermove',r.left+100,r.top+40,button); if(S.x!==5) return 'cancel '+button; }
    Appearance.patch({flip:true}); await new Promise(r=>setTimeout(r,100)); const v=document.querySelector('#stage .vp'), q=v.getBoundingClientRect(), e={clientX:q.left+q.width/2+16,clientY:q.top+q.height/2};
    setT({x:10,y:20,z:8}); updateCoordinates(v,e); if(toWorld(v,e)[0]!==8 || document.querySelector('[data-coordinate=x]').textContent!=='8.000') return 'flip coordinate';
    for(const z of [.1,8,50000]) for(const deltaMode of [0,1,2]) for(const deltaY of [-100000,100000]) {
      setT({x:10,y:20,z}); const wheel=new WheelEvent('wheel',{...e,deltaY,deltaMode,cancelable:true}), before=toWorld(v,wheel); v.dispatchEvent(wheel); const after=toWorld(v,wheel);
      if(S.z<.1||S.z>50000||Math.hypot(before[0]-after[0],before[1]-after[1])>.001) return 'anchor '+JSON.stringify({z,deltaMode,deltaY,before,after,actual:S.z});
    }
    Appearance.reset(); return true;`],
  ["board status units keys and pin round trip", "v=board", `
    Appearance.reset(); await new Promise(r=>setTimeout(r,80)); let vp=document.querySelector('#stage .vp'), r=vp.getBoundingClientRect();
    setT({x:25.4,y:50.8,z:8}); const e={clientX:r.left+r.width/2,clientY:r.top+r.height/2}; updateCoordinates(vp,e);
    Appearance.patch({units:'mil'}); await new Promise(r=>setTimeout(r,80)); if(document.querySelector('[data-coordinate=x]').textContent!=='1000.000') return 'mil';
    Appearance.patch({units:'in'}); await new Promise(r=>setTimeout(r,80)); if(document.querySelector('[data-coordinate=y]').textContent!=='2.000') return 'in';
    Appearance.patch({units:'mm'}); await new Promise(r=>setTimeout(r,80)); vp=document.querySelector('#stage .vp'); const key=(key,extra={})=>document.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...extra}));
    key('{'); if(Math.abs(Appearance.get().layers['F.Cu'].opacity-.9)>1e-9) return 'opacity'; key('}');
    updateCoordinates(vp,{clientX:e.clientX+16,clientY:e.clientY}); const point=boardCursor.world.slice(), z=S.z; key('F4'); if(S.x!==point[0]||S.y!==point[1]||S.z!==z) return 'F4';
    const old=proposePin, on=THREADS_ON; let pins=[]; proposePin=(v,event)=>pins.push(toWorld(v,event)); THREADS_ON=true;
    try {
      const pointer=(type,x,button=2)=>vp.dispatchEvent(new PointerEvent(type,{clientX:x,clientY:e.clientY,button,pointerId:2,bubbles:true}));
      pointer('pointerdown',e.clientX); pointer('pointerup',e.clientX+2); vp.dispatchEvent(new MouseEvent('contextmenu',{clientX:e.clientX+2,clientY:e.clientY,cancelable:true})); if(pins.length!==1) return 'right pin';
      const p=pins[0], screen=BoardGL.worldToScreen(p,{...boardCamera(vp),width:r.width,height:r.height}); if(Math.abs(screen[0]-(Math.trunc(e.clientX+2)-r.left))>1e-6) return 'pin roundtrip';
      pointer('pointerdown',e.clientX); vp.dispatchEvent(new MouseEvent('contextmenu',{clientX:e.clientX,clientY:e.clientY,cancelable:true})); if(pins.length!==1) return 'early context pinned'; pointer('pointermove',e.clientX+40); pointer('pointerup',e.clientX+40); vp.dispatchEvent(new MouseEvent('contextmenu',{clientX:e.clientX+40,clientY:e.clientY,cancelable:true})); if(pins.length!==1) return 'drag pinned';
      pointer('pointerdown',e.clientX); pointer('lostpointercapture',e.clientX); const x=S.x; pointer('pointermove',e.clientX+40); if(S.x!==x) return 'lost capture';
    } finally { proposePin=old; THREADS_ON=on; }
    const tiny=document.createElement('div'); document.body.append(tiny); const before={x:S.x,y:S.y,z:S.z}; zoomBoardAt(tiny,0,0,2); tiny.remove(); if(S.z!==before.z||S.x!==before.x) return 'zero size';
    document.querySelector('#zoombar [data-act=fit]').focus(); const focus=document.activeElement; key('?'); document.querySelector('#shortcuts').close(); if(document.activeElement!==focus) return 'focus restore';
    Appearance.reset(); return true;`],
  ["board navigation Thermal evidence", "v=board", `
    Appearance.reset(); Appearance.patch({grid:{visible:true,size:1}}); await new Promise(r=>setTimeout(r,150)); fit();
    const vp=document.querySelector('#stage .vp'), r=vp.getBoundingClientRect(); deltaAnchor=[S.x,S.y]; updateCoordinates(vp,{clientX:r.left+r.width*.6,clientY:r.top+r.height*.6});
    return document.querySelector('[data-coordinate=x]').textContent!=='—' && document.querySelector('[data-grid]').textContent==='1.000';`],
  ["board shortcut sheet Thermal evidence", "v=board", `
    Appearance.patch({grid:{visible:true,size:1},units:'mm'}); await new Promise(r=>setTimeout(r,150)); fit();
    const vp=document.querySelector('#stage .vp'), r=vp.getBoundingClientRect(); deltaAnchor=[S.x,S.y]; updateCoordinates(vp,{clientX:r.left+r.width*.6,clientY:r.top+r.height*.6}); showShortcuts(); return document.querySelector('#shortcuts').open;`],
];
