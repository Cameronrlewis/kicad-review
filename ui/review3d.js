"use strict";
/* Lazy 3D board viewer. The three.js bundle remains inert until this view opens. */
window.Review3D = (() => {
  const style = document.createElement("style");
  style.textContent = `.mode-3d [data-poster]{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}.mode-3d [hidden]{display:none!important}.mode-3d .error3d{position:absolute;bottom:16px;left:16px;right:16px;z-index:3;padding:12px;background:var(--surface);color:var(--text);border:1px solid var(--line)}.mode-3d .error3d{overflow-wrap:anywhere;max-height:calc(100% - 32px);overflow:auto;box-sizing:border-box}.mode-3d .error3d button{min-height:32px;cursor:pointer;color:var(--text);background:var(--surface);border:1px solid var(--line);padding:4px 12px}@media(max-width:700px){.mode-3d .error3d button{min-height:44px}}.mode-3d .error3d p{margin:0 0 8px}.mode-3d button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.mode-3d .view3d{min-width:0;position:relative}.mode-3d .view3d.one{grid-column:1/-1}.mode-3d canvas{display:block;width:100%;height:100%}.mode-3d .marker3d,.tip3d{position:absolute;z-index:2;pointer-events:none;transform:translate(-50%,-100%);font:700 13px system-ui,sans-serif;line-height:1;white-space:nowrap;color:var(--text);text-shadow:0 1px 2px var(--paper),1px 0 2px var(--paper),-1px 0 2px var(--paper),0 -1px 2px var(--paper)}.tip3d{text-shadow:none;padding:3px 5px;background:var(--surface);border:1px solid var(--line);border-radius:3px}.loading,.empty3d{position:absolute;inset:0;display:grid;place-items:center;color:var(--muted);margin:0}#modes button[aria-disabled=true]{cursor:not-allowed;opacity:.55}`;
  document.head.appendChild(style);
  let active = null, bundle;
  const gunzip = b64 => new Response(new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))]).stream().pipeThrough(new DecompressionStream("gzip")));
  function guardSession(s, promise, discard = () => {}) {
    return promise.then(value => {
      if (s.dead) { discard(value); throw new DOMException('Viewer closed', 'AbortError'); }
      return value;
    });
  }
  function closeSession(s) {
    if (s.dead) return;
    s.dead = true; s.abort.abort();
    for (const {reject} of s.pending.values()) reject(new DOMException('Viewer closed', 'AbortError'));
    s.pending.clear(); s.worker?.terminate(); s.worker = null;
    for (const url of s.urls) URL.revokeObjectURL(url);
    s.urls.clear(); clearTimeout(s.idleTimer); cancelAnimationFrame(s.raf);
    for (const id of s.animationFrames) cancelAnimationFrame(id);
    s.animationFrames.clear();
    s.pixelSample?.reject(new DOMException('Viewer closed', 'AbortError')); s.pixelSample = null;
    s.resizeObserver?.disconnect(); s.intersectionObserver?.disconnect();
    s.resourceCounts.workers = s.resourceCounts.urls = s.resourceCounts.pending = 0;
  }
  async function loadPartIndex(board, side, s) {
    const id = board.parts3d?.[side]; if (!id) return [];
    try {
      let bytes;
      if (window.REVIEW_DATA.blobs[id]) bytes = await guardSession(s, decode3d({b64:window.REVIEW_DATA.blobs[id]}, s));
      else if (board.assets3d?.[side]?.parts && typeof requestAsset3d === 'function')
        bytes = await requestAsset3d(board.assets3d[side].parts, 'board-parts.json', s);
      else throw Error('3D part index unavailable');
      if (s.dead) return [];
      const {THREE:T} = THREE3D;
      const rows = ThreeParts.validate(JSON.parse(new TextDecoder().decode(bytes)));
      s.indexedSides.add(side);
      return rows.map(p => ({...p,
        bounds:new T.Box3(new T.Vector3(...p.box.slice(0, 3)), new T.Vector3(...p.box.slice(3)))}));
    } catch (error) {
      if (!s.dead && s.state.errorsBySide[side] == null) {
        s.state.errorsBySide[side] = 'Part inspection unavailable: ' + error.message;
        s.partWarn.add(side);
      }
      return [];
    }
  }
  function decode3d(source, s) {
    if (s.dead) return Promise.reject(new DOMException('Viewer closed', 'AbortError'));
    try {
      if (!s.worker) {
        const code = atob(document.querySelector('#three-decode-worker').textContent.trim());
        const url = URL.createObjectURL(new Blob([code], {type:'text/javascript'}));
        s.urls.add(url); s.resourceCounts.urls = s.urls.size;
        let worker;
        const releaseURL = () => {
          if (s.urls.delete(url)) URL.revokeObjectURL(url);
          s.resourceCounts.urls = s.urls.size;
        };
        try { worker = s.worker = new Worker(url); }
        catch (error) { releaseURL(); throw error; }
        s.resourceCounts.workers = 1;
        s.worker.onmessage = ({data}) => {
          const job = s.pending.get(data.id); if (!job) return;
          s.pending.delete(data.id); s.resourceCounts.pending = s.pending.size;
          data.error ? job.reject(Error(data.error)) : job.resolve(data.buffer);
        };
        const failed = event => {
          event.preventDefault();
          if (s.dead || s.worker !== worker) return;
          for (const job of s.pending.values()) job.reject(Error('3D worker failed. Retry.'));
          s.pending.clear(); worker.terminate(); s.worker = null;
          releaseURL();
          s.resourceCounts.pending = s.resourceCounts.workers = 0;
          s.resourceCounts.urls = s.urls.size;
        };
        s.worker.addEventListener('error', failed);
        s.worker.addEventListener('messageerror', failed);
      }
      return new Promise((resolve, reject) => {
        const id = ++s.nextId;
        s.pending.set(id, {resolve, reject}); s.resourceCounts.pending = s.pending.size;
        try { s.worker.postMessage({id, ...source}, source.bytes ? [source.bytes] : []); }
        catch (error) { s.pending.delete(id); s.resourceCounts.pending = s.pending.size; reject(error); }
      });
    } catch (error) { return Promise.reject(error); }
  }
  async function poster3d(side, id, s) {
    if (!id || !window.REVIEW_DATA.blobs[id]) return null;
    // Small stills retain the native stream path; model and vendor bytes use the worker.
    const bytes = await guardSession(s, gunzip(window.REVIEW_DATA.blobs[id]).arrayBuffer());
    const url = URL.createObjectURL(new Blob([bytes], {type:'image/png'}));
    s.urls.add(url); s.resourceCounts.urls = s.urls.size;
    const image = new Image(); image.dataset.poster = side; image.alt = side + ' revision 3D preview';
    image.src = url; await guardSession(s, image.decode()); return image;
  }
  const loadThree = async s => {
    if (window.THREE3D) return window.THREE3D;
    if (!bundle || bundle.session !== s) {
      const entry = bundle = {session:s};
      entry.promise = (async () => {
        const buffer = await guardSession(s, decode3d({b64:document.querySelector('#three-bundle').textContent.trim()}, s));
        const script = document.createElement('script'); script.textContent = new TextDecoder().decode(buffer);
        document.head.appendChild(script);
        if (!window.THREE3D) throw Error('Unable to load the 3D viewer.');
        if (bundle === entry) bundle = null;
        return window.THREE3D;
      })().catch(error => { if (bundle === entry) bundle = null; throw error; });
    }
    return guardSession(s, bundle.promise);
  };
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const bg = () => css(window.KRTheme.get() === 'dark' ? '--bg' : '--paper');
  const tint = action => new window.THREE3D.THREE.Color(css(`--${action}`));
  const materials = o => Array.isArray(o.material) ? o.material : [o.material];
  const free = o => { o.geometry?.dispose(); materials(o).filter(Boolean).forEach(m => { m.map?.dispose(); m.dispose(); }); };
  // One owner for source resources, logical clones, and comparison-only materials.
  function releaseGpu(s) {
    const geometries = s.geometries || new Set(), materials = s.materials || new Set(), textures = s.textures || new Set();
    const environmentTextures = new Set([...s.environments.values()].map(t => t.texture));
    for (const root of [...s.roots, ...s.views.map(v => v.scene), ...(s.decodedScenes || [])]) root?.traverse(n => {
      if (n.geometry) geometries.add(n.geometry);
      for (const m of (Array.isArray(n.material) ? n.material : [n.material]).filter(Boolean)) {
        materials.add(m);
        for (const value of Object.values(m)) if (value?.isTexture && !environmentTextures.has(value)) textures.add(value);
      }
    });
    for (const g of geometries) g.dispose();
    for (const m of materials) m.dispose();
    for (const t of textures) t.dispose();
    for (const target of new Set(s.environments.values())) target.dispose();
    geometries.clear(); materials.clear(); textures.clear(); s.environments.clear();
    s.renderer?.dispose(); s.canvas?.remove();
  }
  function parseByDigest(s, digest, bytes, parser) {
    const existing = s.parses.get(digest);
    if (existing) { existing.refs++; return existing.promise; }
    const entry = {promise:null, scene:null, refs:1};
    entry.promise = Promise.resolve().then(() => { s.state.parseCount++; return parser(bytes); }).then(g => {
      if (s.dead) {
        releaseGpu({roots:[g.scene], views:[], environments:new Map()});
        throw new DOMException('Viewer closed', 'AbortError');
      }
      entry.scene = g.scene; s.decodedScenes.push(g.scene); return g;
    }).catch(error => { if (s.parses.get(digest) === entry) s.parses.delete(digest); throw error; });
    s.parses.set(digest, entry); return entry.promise;
  }
  const sideRoot = (s, side) => s.roots[s.allowedSides.indexOf(side)];
  function dispose() {
    if (!active) return;
    const s = active; closeSession(s); clearInterval(s.themeTimer);
    s.views.forEach(v => { clearTimeout(v.tip); v.controls.dispose(); });
    releaseGpu(s); s.parses.clear(); s.decodedModels.clear(); s.comparisonMaterials.clear(); s.decodedScenes.length = 0;
    s.state.disposed = true; s.state.loading = false;
    s.state.loadingBySide.base = s.state.loadingBySide.head = false;
    s.roots.length = 0;
    s.views.length = 0;
    s.state.roots = [];
    s.state.renderers = []; s.state.cameras = []; s.state.controls = [];
    s.state.nodes = []; s.state.highlights = []; s.state.ghosts = []; s.state.blocks = [];
    active = null;
  }
  function failure(s, side, message) {
    if (s.dead) return;
    s.state.errorsBySide[side] = message; s.partWarn.delete(side);
    const host = s.hostsBySide[side];
    // A partially built view must not hide its fallback on the next frame.
    for (const v of s.views) if (v.host === host) { v.failed = true; v.visible = false; }
    host.querySelector('.loading')?.remove();
    if (s.state.posterBySide[side]) s.state.posterBySide[side].hidden = false;
    let notice = host.querySelector('.error3d');
    if (!notice) { notice = document.createElement('div'); notice.className = 'empty error3d'; notice.setAttribute('role', 'alert'); host.appendChild(notice); }
    notice.replaceChildren();
    const text = document.createElement('p'); text.textContent = ['3D model could not be loaded.', message, s.state.posterErrorsBySide[side]].filter(Boolean).join(' ');
    const retry = document.createElement('button'); retry.dataset['3dRetry'] = ''; retry.textContent = 'Retry 3D';
    retry.onclick = () => { if (!s.dead) void show(s.stage, s.project, s.appState, {single:s.single}); };
    notice.append(text, retry);
  }
  const RIGS = [["bench", "Bench"], ["lowsun", "Low sun"], ["photo", "Photo"]];
  // Defaults and clamping for the light tool; app state and the hash are untrusted.
  function normalizeLighting(v) {
    const S = window.ThreeStudio, rig = Object.hasOwn(S.LIGHT_RIGS, v?.rig) ? v.rig : S.PRESETS.bench.rig, preset = S.PRESETS[rig];
    const bearing = Number.isFinite(v?.bearing) ? S.snapBearing(v.bearing) : preset.bearing;
    const exposure = Number.isFinite(v?.exposure) ? Math.round(Math.min(3, Math.max(.4, v.exposure)) * 20) / 20 : preset.exposure;
    return {rig, bearing, exposure};
  }
  function toolsHtml() {
    const l = active?.lighting || normalizeLighting(), on = active ? active.assembled : true;
    return `<span class="tools3d" role="group" aria-label="3D tools"><button type="button" data-3d-assembled aria-pressed="${on}" title="Show or hide the components">Assembled</button>`
      + `<details class="light3d"><summary title="Studio lighting"><svg class="i" aria-hidden="true"><use href="#kr-i-cube"></use></svg>Light</summary><div class="light-menu">`
      + `<label>Preset<select data-3d-rig>${RIGS.map(([id, n]) => `<option value="${id}"${id === l.rig ? " selected" : ""}>${n}</option>`).join("")}</select></label>`
      + `<label>Light from<select data-3d-bearing>${Array.from({length:12}, (_, i) => i * 30).map(b => `<option value="${b}"${b === l.bearing ? " selected" : ""}>${b}°</option>`).join("")}</select></label>`
      + `<label>Exposure <output data-3d-exposure-out>${l.exposure.toFixed(2)}</output><input type="range" data-3d-exposure aria-label="Exposure" min="0.4" max="3" step="0.05" value="${l.exposure}"></label>`
      + `<span data-3d-light-error role="alert" hidden></span></div></details></span>`;
  }
  function environment(s, {rig, bearing}) {
    const key = `${rig}:${bearing}`;
    let target = s.environments.get(key);
    if (!target) {
      const {THREE} = window.THREE3D, texture = new THREE.DataTexture(window.ThreeStudio.pixels(rig, bearing), 256, 128, THREE.RGBAFormat, THREE.FloatType);
      texture.mapping = THREE.EquirectangularReflectionMapping; texture.colorSpace = THREE.LinearSRGBColorSpace; texture.needsUpdate = true;
      let pmrem;
      try { pmrem = new THREE.PMREMGenerator(s.renderer); target = pmrem.fromEquirectangular(texture); }
      finally { texture.dispose(); pmrem?.dispose(); }
      s.environments.set(key, target);
    }
    return target.texture;
  }
  function setLighting(value) {
    const s = active; if (!s || s.dead) return;
    let l = normalizeLighting(value), failed = false;
    try {
      // Generate first: a failed PMREM must not publish settings the board never received.
      const env = s.renderer ? environment(s, l) : null;
      if (s.renderer) {
        for (const v of s.views) v.scene.environment = env;
        s.renderer.toneMappingExposure = l.exposure;
      }
      s.lighting = s.state.lighting = l;
      delete s.state.lightingError;
    } catch (error) {
      s.state.lightingError = String(error.message || error);
      l = s.lighting; failed = true;
    }
    const bar = document.querySelector("#zoombar");   // keep the tools in step with the state
    if (bar?.querySelector("[data-3d-rig]")) {
      bar.querySelector("[data-3d-rig]").value = l.rig; bar.querySelector("[data-3d-bearing]").value = String(l.bearing);
      bar.querySelector("[data-3d-exposure]").value = String(l.exposure); bar.querySelector("[data-3d-exposure-out]").textContent = l.exposure.toFixed(2);
      const notice = bar.querySelector("[data-3d-light-error]");
      notice.textContent = failed ? `Lighting could not be applied: ${s.state.lightingError}` : ""; notice.hidden = !failed;
    }
    if (failed) return false;
    window.Review3D.onStateChange?.({lighting:l}); render();
    return true;
  }
  function setAssembled(value) {
    const s = active; if (!s || s.dead) return;
    s.assembled = s.state.assembled = !!value;
    document.querySelector("#zoombar [data-3d-assembled]")?.setAttribute("aria-pressed", String(s.assembled));
    if (!s.assembled) { clearPartSelection(); clearPartTooltips(); }
    applyVisibility(); window.Review3D.onStateChange?.({assembled:s.assembled}); render();
  }
  function cameraBar() {
    const bar = document.querySelector("#zoombar"); if (!bar) return;
    bar.innerHTML = `<details class="camera-presets"><summary title="3D camera orientations"><svg class="i" aria-hidden="true"><use href="#kr-i-cube"></use></svg>Camera</summary><div class="camera-menu">${["Top","Bottom","Front","Back","Left","Right","3D","Reset"].map(n => `<button data-3d-camera="${n.toLowerCase()}" title="${n} camera view">${n}</button>`).join("")}</div></details>${toolsHtml()}`;
    const menu = bar.querySelector(".camera-presets"), popup = bar.querySelector(".camera-menu");
    for (const [d, p, w] of [[menu, popup, 180], [bar.querySelector(".light3d"), bar.querySelector(".light-menu"), 240]]) {
      d.ontoggle = () => { const r = d.getBoundingClientRect(); p.style.top = document.querySelector("#toolbar").getBoundingClientRect().bottom + 4 + "px"; p.style.left = Math.max(0, Math.min(r.left, innerWidth - w)) + "px"; };
      d.onkeydown = e => { if (e.key === "Escape") { d.open = false; d.querySelector("summary").focus(); e.stopPropagation(); } };
    }
    bar.querySelector("[data-3d-assembled]").onclick = () => setAssembled(!active?.assembled);
    const light = () => ({rig:bar.querySelector("[data-3d-rig]").value, bearing:+bar.querySelector("[data-3d-bearing]").value, exposure:+bar.querySelector("[data-3d-exposure]").value});
    bar.querySelector("[data-3d-rig]").onchange = e => setLighting({...light(), exposure:window.ThreeStudio.PRESETS[e.target.value].exposure});
    bar.querySelector("[data-3d-bearing]").onchange = () => setLighting(light());
    bar.querySelector("[data-3d-exposure]").oninput = () => setLighting(light());
    bar.querySelectorAll("[data-3d-camera]").forEach(b => b.onclick = () => { frame(b.dataset["3dCamera"]); window.Review3D.onCameraEnd?.(); menu.open = false; menu.querySelector("summary").focus(); });
  }
  function render() {
    const s = active; if (!s || s.dead || s.contextLost || !s.visible || !s.renderer) return;
    const r = s.renderer, outer = s.canvas.getBoundingClientRect();
    r.setScissorTest(false); r.clear(); r.setScissorTest(true);
    const visible = s.views.filter(v => v.visible);
    for (const v of visible) {
      const b = v.host.getBoundingClientRect(); if (!b.width || !b.height) { v.calls = 0; continue; }
      const x = b.left - outer.left, y = outer.bottom - b.bottom;
      v.rect = {x, y, width:b.width, height:b.height};
      r.setViewport(x, y, b.width, b.height); r.setScissor(x, y, b.width, b.height);
      r.clear(true, true, true); r.info.reset(); r.render(v.scene, v.camera); v.calls = r.info.render.calls;
      if (v.sides.some(side => sideRoot(s, side)?.parent === v.scene) && v.calls > 0) {
        s.state.firstFrame = true;
        for (const side of v.sides) if (s.state.posterBySide[side]) s.state.posterBySide[side].hidden = true;
      }
      for (const m of v.labels || []) {
        const p = m.position.clone().project(v.camera), w = v.host.clientWidth, h = v.host.clientHeight;
        m.el.style.display = m.el.hidden || p.z > 1 ? 'none' : 'block';
        m.el.style.left = `${(p.x * .5 + .5) * w}px`; m.el.style.top = `${(-p.y * .5 + .5) * h}px`;
      }
    }
    r.setScissorTest(false);
    s.state.drawCallsByViewport = visible.map(v => v.calls || 0);
    s.state.drawCalls = s.state.drawCallsByViewport.reduce((a, b) => a + b, 0); s.state.drawCount++;
    if (s.pixelSample) {
      const job = s.pixelSample; s.pixelSample = null;
      try {
        const gl = r.getContext(), w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, bytes = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
        let opaquePixels = 0; for (let i = 3; i < bytes.length; i += 4) if (bytes[i] > 32) opaquePixels++;
        job.resolve({opaquePixels});
      } catch (error) { job.reject(error); }
    }
  }
  function sampleFrame() {
    if (!active || active.dead || !active.renderer || active.contextLost) return Promise.reject(Error('No active 3D renderer'));
    return new Promise((resolve, reject) => {
      if (active.pixelSample) return reject(Error('Pixel sample already pending'));
      active.pixelSample = {resolve, reject}; render();
    });
  }
  function animateFrame(s, tick) {
    const id = requestAnimationFrame(now => { s.animationFrames.delete(id); tick(now); });
    s.animationFrames.add(id);
  }
  function setCamera(v, centre, radius, animate) { const { THREE } = window.THREE3D, dir = v.camera.position.clone().sub(v.controls.target).normalize(), vfov = THREE.MathUtils.degToRad(v.camera.fov), hfov = 2 * Math.atan(Math.tan(vfov / 2) * v.camera.aspect), distance = Math.max(radius / Math.sin(Math.min(vfov, hfov) / 2) * 1.25, .02), target = centre.clone(), position = centre.clone().addScaledVector(dir, distance);
    const owner=active, startP=v.camera.position.clone(), startT=v.controls.target.clone(), start=performance.now(), length=animate&&!matchMedia("(prefers-reduced-motion: reduce)").matches?400:0; const tick=now=>{ if(owner.dead)return; const t=length?Math.min(1,(now-start)/length):1, e=1-(1-t)*(1-t); v.camera.position.lerpVectors(startP,position,e); v.controls.target.lerpVectors(startT,target,e); if(!length){v.camera.near=distance/100;v.camera.far=distance*100;} v.camera.updateProjectionMatrix(); v.controls.update(); if(length)render(); if(t<1) animateFrame(owner,tick); }; if(length)animateFrame(owner,tick);else tick(start);
  }
  function frame(direction = "3d") { if (!active?.box) return; const { THREE } = window.THREE3D, b = active.box, c = b.getCenter(new THREE.Vector3()), dirs = { top:[0,1,0], bottom:[0,-1,0], front:[0,0,-1], back:[0,0,1], left:[-1,0,0], right:[1,0,0], "3d":[1,.99,-1], reset:[1,.99,-1] }, d = new THREE.Vector3(...dirs[direction]).normalize(), radius = b.getBoundingSphere(new THREE.Sphere()).radius;
    active.views.forEach(v => { const vfov = THREE.MathUtils.degToRad(v.camera.fov), hfov = 2 * Math.atan(Math.tan(vfov / 2) * v.camera.aspect), distance = radius / Math.sin(Math.min(vfov, hfov) / 2) * 1.08; v.camera.up.set(...((direction === "top" || direction === "bottom") ? [0,0,-1] : [0,1,0])); v.controls._quat.setFromUnitVectors(v.camera.up, new THREE.Vector3(0,1,0)); v.controls._quatInverse.copy(v.controls._quat).invert(); v.camera.position.copy(c).addScaledVector(d, distance); v.controls.target.copy(c); v.camera.near = distance / 100; v.camera.far = distance * 100; v.camera.updateProjectionMatrix(); v.controls.update(); }); render(); }
  function routeRevisionViews() {
    const s = active; if (!s) return;
    const singleSide = s.single || (Boolean(s.appState.phone) && s.mode === 'side');
    if (s.mode === 'side' || s.single) {
      for (const [side, host] of Object.entries(s.hostsBySide)) {
        host.hidden = singleSide && side !== s.revision; host.classList.toggle('one', singleSide);
        let empty = host.querySelector('[data-revision-empty]');
        if (!s.available[side] && !empty) {
          empty = host.querySelector('.empty3d') || document.createElement('p'); empty.className = 'empty3d';
          empty.dataset.revisionEmpty = ''; empty.textContent = 'Board not in this revision'; host.appendChild(empty);
        }
        if (empty) empty.hidden = !!s.available[side];
      }
      for (const v of s.views) v.visible = !v.failed && (!singleSide || v.side === s.revision);
      s.state.visibleSides = singleSide ? [s.revision] : s.allowedSides.filter(side => s.available[side]);
    } else {
      s.state.visibleSides = s.allowedSides.filter(side => s.available[side]);
    }
    s.state.phone = Boolean(s.appState.phone);
  }
  function setRevision(side) {
    const s = active; if (!s || !s.allowedSides.includes(side)) return;
    const changed = s.revision !== side; s.revision = side; s.state.revision = side;
    if (changed) window.Review3D.onStateChange?.({revision:side});
    routeRevisionViews(); resize();
  }
  function resize() {
    const s = active; if (!s || s.dead) return;
    routeRevisionViews(); if (!s.renderer) return;
    const b = s.stage.getBoundingClientRect(); if (!b.width || !b.height) return;
    s.renderer.setSize(b.width, b.height, false);
    for (const v of s.views) {
      const r = v.host.getBoundingClientRect(); v.visible = !v.failed && !v.host.hidden && r.width > 0 && r.height > 0;
      if (v.visible) { v.camera.aspect = r.width / r.height; v.camera.updateProjectionMatrix(); }
    }
    applyMarkerVisibility(); render();
  }
  function boxEdges(size) {
    const {THREE} = window.THREE3D, box = new THREE.BoxGeometry(size.x, size.y, size.z);
    try { return new THREE.EdgesGeometry(box); } finally { box.dispose(); }
  }
  // Selection outline: the part's bounding box in --accent, drawn over everything. ponytail: box, not silhouette; per-mesh edges were an unreadable tangle.
  function outline(scene, node, colour) { const { THREE }=window.THREE3D, b=new THREE.Box3().setFromObject(node), size=b.getSize(new THREE.Vector3()), e=new THREE.LineSegments(boxEdges(size),new THREE.LineBasicMaterial({color:colour,depthTest:false})); e.position.copy(b.getCenter(new THREE.Vector3())); e.renderOrder=10;e.raycast=()=>{}; scene.add(e); return e; }
  function comparisonMaterial(source, role, change) {
    const s = active; let roles = s.comparisonMaterials.get(source);
    if (!roles) { roles = new Map(); s.comparisonMaterials.set(source, roles); }
    if (!roles.has(role)) {
      // Ghosts keep the baseline flat tint, without source lighting or textures, shared across the session.
      if (role === 'ghost') {
        s.ghostMaterial ||= new window.THREE3D.THREE.MeshBasicMaterial({color:tint('removed'), transparent:true, opacity:.45, depthTest:false});
        roles.set(role, s.ghostMaterial); s.materials.add(s.ghostMaterial);
      } else {
        const n = source.clone();
        if (role === 'fade') { n.transparent = true; n.opacity = .12; n.color?.set('#a8a8a8'); }
        else if (change) { const c = tint(change.action); n.color?.lerp(c, .7); if (n.emissive) { n.emissive.copy(c); n.emissiveIntensity = .7; } }
        roles.set(role, n); s.materials.add(n);
      }
    }
    return roles.get(role);
  }
  function cloneMaterials(root, change, fade = false, role = null) {
    const original = [], changed = [];
    root?.traverse(o => {
      if (!o.isMesh) return;
      const before = materials(o), after = before.map(m => comparisonMaterial(m, role || (fade ? 'fade' : 'highlight:' + change.action), change));
      original.push(...before); changed.push(...after); o.material = Array.isArray(o.material) ? after : after[0];
    });
    return {original, materials:changed};
  }
  function recolour() { if(!active)return; const st=window.Review3D.state; st.highlights.forEach(h=>{const c=tint(h.action);h.materials.forEach((m,i)=>{if(m.color)m.color.copy(h.original[i].color).lerp(c,.7);if(m.emissive)m.emissive.copy(c);});});st.ghosts.forEach(g=>g.object.traverse(o=>{if(o.isMesh)materials(o).forEach(m=>m.color.copy(tint("removed")));}));active.selected.forEach(o=>o.material.color.set(css("--accent")));render(); }
  function marker(v,node,change,bounds) { const { THREE }=window.THREE3D,b=bounds||new THREE.Box3().setFromObject(node),position=b.getCenter(new THREE.Vector3()),el=document.createElement("span");position.y=b.max.y+.004;el.className=`marker3d ${change.action}`;el.dataset.ref=change.ref;el.textContent=`${change.action === "added" ? "＋" : change.action === "removed" ? "−" : "≡"} ${change.ref||""}`;el.style.color=`var(--${change.action})`;v.host.appendChild(el);const m={position,el};(v.labels ||= []).push(m); return m; }
  function view(host, roots, side = null) {
    const {THREE, OrbitControls} = window.THREE3D, s = active, scene = new THREE.Scene();
    scene.environment = environment(s, s.lighting); scene.add(...roots);
    const camera = new THREE.PerspectiveCamera(35, 1, .01, 1000), controls = new OrbitControls(camera, host);
    const v = {host, canvas:s.canvas, renderer:s.renderer, camera, scene, controls, side, visible:true,
      sides:side ? [side] : s.allowedSides.filter(side => roots.includes(sideRoot(s, side)))};
    controls.enableDamping = true;
    controls.addEventListener('change', () => {
      if (s.dead || s.syncing) return; s.syncing = true;
      for (const other of s.views) if (other !== v) {
        other.camera.position.copy(camera.position); other.camera.quaternion.copy(camera.quaternion);
        other.controls.target.copy(controls.target); other.camera.near = camera.near; other.camera.far = camera.far;
        other.camera.updateProjectionMatrix(); other.controls.update();
      }
      s.syncing = false; render();
    });
    controls.addEventListener('end', () => window.Review3D.onCameraEnd?.());
    installPartInput(v);
    s.views.push(v); s.state.cameras.push(camera); s.state.controls.push(controls); return v;
  }
  function nearestPart(ray, parts, visible) {
    const {THREE:T} = THREE3D; let best = null, distance = Infinity;
    // ponytail: O(n) until a measured large-board picking bottleneck justifies a spatial index.
    for (const p of parts) {
      if (!visible(p)) continue;
      const point = ray.intersectBox(p.bounds, new T.Vector3()); if (!point) continue;
      const d = point.distanceToSquared(ray.origin); if (d < distance) { best = p; distance = d; }
    }
    return best;
  }
  function visibleNode(n) { for (; n; n = n.parent) if (!n.visible) return false; return true; }
  function visiblePart(p) { return active.assembled !== false && !active.hiddenBodies && !active.hiddenGroups.has(p.side); }
  // One revision-local owner map serves picking, retained-mesh policy and the missing-model list.
  function changeForPart(ref, side) { return active?.changesByRef[side]?.get(ref) || null; }
  function indexedHit(v, event) {
    const {THREE:T} = THREE3D, b = v.host.getBoundingClientRect(), ray = new T.Raycaster();
    ray.setFromCamera(new T.Vector2((event.clientX-b.left)/b.width*2-1, -(event.clientY-b.top)/b.height*2+1), v.camera);
    return active.state.visibleSides.flatMap(side => {
      if (v.side && v.side !== side || !active.indexedSides.has(side)) return [];
      const root = sideRoot(active, side);
      if (!root || root.parent !== v.scene || !visibleNode(root)) return [];
      const parts = active.state.parts[side], changed = active.changesByRef[side];
      const p = nearestPart(ray.ray, parts.filter(p => !p.hasModel || !changed.has(p.ref)), visiblePart);
      const point = p && ray.ray.intersectBox(p.bounds, new T.Vector3());
      const candidates = p ? [{...p, revision:side, distance:point.distanceTo(ray.ray.origin), meshHit:false}] : [];
      root.updateMatrixWorld(true); const meshes = [];
      root.traverse(n => { if (n.isMesh && n.userData.role === 'body' && changed.has(n.userData.ref) && visibleNode(n)) meshes.push(n); });
      for (const hit of ray.intersectObjects(meshes, false)) {
        const part = parts.find(p => p.ref === hit.object.userData.ref);
        if (part && visiblePart(part)) candidates.push({...part, revision:side, distance:hit.distance, meshHit:true});
      }
      return candidates;
    }).sort((a,b) => a.distance-b.distance || Number(b.meshHit)-Number(a.meshHit))[0] || null;
  }
  // Old reports (and a revision with a rejected index) retain node-based input only on that revision.
  function hit(v,e) {
    const {THREE}=THREE3D, r=v.host.getBoundingClientRect(), ray=new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1),v.camera);
    const roots=active.allowedSides.filter(side=>!active.indexedSides.has(side)&&(!v.side||v.side===side))
      .map(side=>sideRoot(active,side)).filter(root=>root?.parent===v.scene);
    const h=ray.intersectObjects(roots,true).find(x=>visibleNode(x.object));
    let n=h?.object;while(n&&!n.userData.noModel&&!active.changes.some(c=>c.ref===n.name))n=n.parent;
    return n;
  }
  function pick(v,e) {
    if(!active)return;
    const p=indexedHit(v,e);
    if(p) {
      const c=changeForPart(p.ref,p.revision);
      if(c)window.Review3D.onPick?.(c.id);
      else { window.Review3D.onPartPick?.({uuid:p.uuid,ref:p.ref,side:p.revision,box:p.box,hasModel:p.hasModel}); focusPart(p.ref,p.revision,false); }
      const b=v.host.getBoundingClientRect();
      tooltip(v,p.ref+(p.hasModel?'':' · no 3D model'),e.clientX-b.left,e.clientY-b.top,1200);
      return;
    }
    const n=hit(v,e);if(!n)return;const c=active.changes.find(x=>x.ref===n.name);
    if(c)window.Review3D.onPick?.(c.id);else hover(v,e);
  }
  function hover(v,e) {
    if(!active)return;
    const p=indexedHit(v,e), n=p?null:hit(v,e), r=v.host.getBoundingClientRect();
    if(p)tooltip(v,p.ref+(p.hasModel?'':' · no 3D model'),e.clientX-r.left,e.clientY-r.top,1200);
    else if(n?.userData.noModel)tooltip(v,`${n.name} · no 3D model`,e.clientX-r.left,e.clientY-r.top,1200);
    else v.host.querySelector('.tip3d')?.remove();
  }
  function installPartInput(v) {
    const options={signal:active.abort.signal}; let down=null;
    v.host.addEventListener('pointerdown',e=>{down=e.button===0?[e.clientX,e.clientY,e.pointerId]:null;},options);
    v.host.addEventListener('pointercancel',()=>{down=null;},options);
    v.host.addEventListener('pointerup',e=>{
      const start=down;down=null;
      if(!start||e.pointerId!==start[2]||Math.hypot(e.clientX-start[0],e.clientY-start[1])>4)return;
      pick(v,e);
    },options);
    v.host.addEventListener('pointermove',e=>{if(!e.buttons)hover(v,e);},options);
  }
  function clearPartTooltips() { for(const v of active.views){clearTimeout(v.tip);v.host.querySelector('.tip3d')?.remove();} }
  function clearPartSelection() {
    active.selected.forEach(o=>{o.removeFromParent();o.traverse(free);});
    active.selected=[];active.state.selected=active.selected;
  }
  function appendPartOutline(ref,side) {
    const s=active,p=s.state.parts[side]?.find(p=>p.ref===ref);
    if(!p||!visiblePart(p))return;
    const {THREE:T}=THREE3D,b=p.bounds,c=b.getCenter(new T.Vector3());
    for(const v of s.views.filter(v=>v.visible&&(!v.side||v.side===side))) {
      const line=new T.LineSegments(boxEdges(b.getSize(new T.Vector3())),new T.LineBasicMaterial({color:css('--accent'),depthTest:false}));
      line.position.copy(c);line.renderOrder=10;line.raycast=()=>{};
      line.ref=ref;line.side=side;line.userData={uuid:p.uuid,revision:side};
      v.scene.add(line);s.selected.push(line);
    }
    return b;
  }
  function focusPart(ref,side,moveCamera=true) {
    if(!active)return;clearPartSelection();const b=appendPartOutline(ref,side);
    if(b&&moveCamera){const {THREE:T}=THREE3D,c=b.getCenter(new T.Vector3());
      active.views.forEach(v=>setCamera(v,c,b.getBoundingSphere(new T.Sphere()).radius,true));}
    render();
  }
  function focusIndexedChange(change,moveCamera=true) {
    clearPartSelection();clearPartTooltips();const {THREE:T}=THREE3D,box=new T.Box3();
    for(const side of active.state.visibleSides) {
      if(side==='base'&&change.action==='added'||side==='head'&&change.action==='removed')continue;
      const ref=ThreeParts.reference(change,side,active.state.parts[side]);
      if(active.indexedSides.has(side)) {
        const b=appendPartOutline(ref,side);if(b) {
          box.union(b);
          const part=active.state.parts[side].find(p=>p.ref===ref);
          if(!part.hasModel)for(const v of active.views.filter(v=>v.visible&&(!v.side||v.side===side)))
            tooltip(v,`${ref} · no 3D model`,v.host.clientWidth/2,v.host.clientHeight/2,0);
        }
      } else if(physicalVisible(ref,side)) {
        const node=sideRoot(active,side)?.getObjectByName(ref);
        for(const v of active.views.filter(v=>v.visible&&(!v.side||v.side===side)&&node?.parent)) {
          const line=outline(v.scene,node,css('--accent'));line.ref=ref;line.side=side;
          line.userData={revision:side,uuid:side==='base'?(change.uuid_before||change.uuid):change.uuid};active.selected.push(line);
          box.union(new T.Box3().setFromObject(node));
          if(node.userData.noModel)tooltip(v,`${ref} · no 3D model`,v.host.clientWidth/2,v.host.clientHeight/2,0);
        }
      }
    }
    if(moveCamera&&!box.isEmpty())active.views.forEach(v=>setCamera(v,box.getCenter(new T.Vector3()),box.getBoundingSphere(new T.Sphere()).radius,true));
    render();
  }
  function tooltip(v,text,x,y,ms){ let el=v.host.querySelector(".tip3d");if(!el){el=document.createElement("span");el.className="tip3d";v.host.appendChild(el);}el.textContent=text;el.style.left=`${x}px`;el.style.top=`${y}px`;clearTimeout(v.tip);if(ms)v.tip=setTimeout(()=>el.remove(),ms); }
  function focus(change, moveCamera=true) { if(!active)return; if(active.indexedSides.size)return focusIndexedChange(change,moveCamera); const side=change.action === "removed" ? "base" : "head", root=sideRoot(active,side), n=root?.getObjectByName(change.ref); if(!n)return; const {THREE}=window.THREE3D,b=new THREE.Box3().setFromObject(n), c=b.getCenter(new THREE.Vector3()), radius=b.getBoundingSphere(new THREE.Sphere()).radius; if(moveCamera)active.views.forEach(v=>setCamera(v,c,radius,true)); active.selected.forEach(x=>{x.removeFromParent();x.traverse(free);}); active.views.forEach(v=>{v.host.querySelector(".tip3d")?.remove();if(n.userData.noModel)tooltip(v,`${n.name} · no 3D model`,v.host.clientWidth/2,v.host.clientHeight/2,0);}); active.selected=active.views.flatMap(v=>{const own=[root,sideRoot(active,side === "head" ? "base" : "head")].map(r=>r?.parent===v.scene&&r?.getObjectByName(change.ref)).find(Boolean);if(!own)return [];const line=outline(v.scene,own,css("--accent"));line.ref=change.ref;line.side=active.allowedSides.find(side=>sideRoot(active,side)?.getObjectByName(change.ref)===own);return [line];}); window.Review3D.state.selected=active.selected; applyVisibility(); render(); }
  function setBlend(value){if(!active?.blend)return;active.blend.value=value;active.blend.base.forEach(m=>{m.transparent=true;m.opacity=1-value;});active.blend.head.forEach(m=>{m.transparent=true;m.opacity=value;});window.Review3D.state.blend=value;render();}
  function toggleBlend(){setBlend(active.blend.value<.5?1:0);}
  // Bare board hides every component: bodies, no-model blocks, change markers and baseline ghosts. No second file.
  function applyBodyVisibility() {
    const s=active;
    for(const root of s.roots)root?.traverse(n=>{
      if(!n.isMesh||n.userData.role!=='body')return;
      const assembled=s.assembled!==false&&!s.hiddenBodies;
      if(n.userData.placeholderSides) {
        n.material.forEach((m,i)=>{m.visible=assembled&&!s.hiddenGroups.has(n.userData.placeholderSides[i]);});
        n.visible=n.material.some(m=>m.visible);
      } else n.visible=assembled&&!s.hiddenGroups.has(n.userData.side);
    });
  }
  function physicalVisible(ref,side) {
    const s=active,p=s.state.parts[side]?.find(p=>p.ref===ref);
    if(p)return visiblePart(p);
    const node=sideRoot(s,side)?.getObjectByName(ref);
    const own=s.groups.filter(({object})=>{for(let n=object;n;n=n.parent)if(n===node)return true;return false;});
    return s.assembled&&!s.hiddenBodies&&!own.some(({groups})=>groups.some(g=>s.hiddenGroups.has(g)));
  }
  function applyVisibility() {
    const s = active; if (!s) return;
    const off = new Set(s.hidden || []); if (!s.assembled) off.add('bodies');
    s.groups.forEach(({object, groups}) => { object.visible = !groups.some(g => off.has(g)); });
    applyBodyVisibility();
    s.state.blocks.forEach(b => { b.object.visible = physicalVisible(b.ref,b.side); });
    applyGhostAndMarkerVisibility();
    s.selected.forEach(o => { o.visible = s.assembled; });
  }
  function applyGhostAndMarkerVisibility() {
    const s=active;
    for(const g of s.state.ghosts) {
      const side=g.side||'base',view=s.views.find(v=>v.side===side)||s.views.find(v=>!v.side);
      const shown=s.mode==='overlay'&&physicalVisible(g.ref,side)&&!!view?.visible;
      if(shown&&g.object.parent!==view.scene)view.scene.add(g.object);
      else if(!shown)g.object.removeFromParent();
      g.object.visible=shown;g.object.traverse(n=>{if(n.isMesh)n.visible=shown;});
    }
    for(const h of s.state.highlights)if(h.marker)h.marker.physicalVisible=physicalVisible(h.ref,h.side);
    applyMarkerVisibility();
  }
  // Resize only changes viewport routing, not the bodies/groups' physical visibility.
  function applyMarkerVisibility() {
    const s=active;
    for(const h of s.state.highlights)if(h.marker)h.marker.el.hidden=h.marker.physicalVisible===false||!s.views.some(v=>v.visible&&(!v.side||v.side===h.side));
  }
  function setHidden(hidden = []) {
    if (!active) return;
    active.hidden = hidden;active.hiddenGroups=new Set(hidden);active.hiddenBodies=active.hiddenGroups.has('bodies');
    if(hidden.some(g=>['bodies','top','bottom'].includes(g))) {
      active.selected=active.selected.filter(o=>{
        if(physicalVisible(o.ref,o.side))return true;
        o.removeFromParent();o.traverse(free);return false;
      });
      active.state.selected=active.selected;clearPartTooltips();
    }
    applyVisibility();window.Review3D.onStateChange?.({hiddenGroups:hidden});render();
  }
  function cameraState() { const v=active?.views[0]; return v ? [...v.camera.position.toArray(), ...v.controls.target.toArray()].map(n => Math.round(n * 10000) / 10) : null; }
  function setCameraState(c) { if (!active || !Array.isArray(c) || c.length !== 6) return; active.views.forEach(v => { v.camera.position.set(c[0]/1000,c[1]/1000,c[2]/1000); v.controls.target.set(c[3]/1000,c[4]/1000,c[5]/1000); v.controls.update(); }); render(); }
  // Layer pivots are arbitrary; every primitive of a component shares its world-box side.
  function classify(root) { const { THREE } = window.THREE3D, [top,bottom]=boardY(active.roots), middle=(top+bottom)/2, sides=new Map(), side=o=>{if(!sides.has(o))sides.set(o,new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3()).y>=middle?"top":"bottom");return sides.get(o);}; root?.traverse(o => { if (!o.isMesh) return; const name = o.name || ""; let groups;
    // GLTFLoader puts multi-primitive node extras on a Group. Inherit only on the logical clone's meshes.
    if(!o.userData.role)for(let parent=o.parent;parent;parent=parent.parent)if(parent.userData.role) {
      const {role,side,ref}=parent.userData;Object.assign(o.userData,{role,side,ref});break;
    }
    if(o.userData.role) {
      const {role,side}=o.userData;
      groups=role==='body'?['bodies',...(['top','bottom'].includes(side)?[side]:[])]:
        role==='mask'||role==='silk'?[role,side]:['board'];
      active.groups.push({object:o,groups});return;
    } if (/silkscreen/i.test(name)) groups = ["silk", side(o)]; else if (/soldermask/i.test(name)) groups = ["mask", side(o)]; else if (/PCB/i.test(name)) groups = ["board"]; else { let p=o; while(p && !/^[A-Z]+\d+$/.test(p.name)) p=p.parent; groups = p && active.refs.has(p.name) ? ["bodies", side(p)] : []; } if(groups.length) active.groups.push({object:o,groups}); }); }
  // Board surfaces come from PCB/silkscreen/soldermask meshes, not the tallest component. ponytail: 90/270 swaps the AABB, other angles keep it as the footprint size.
  function boardY(roots) { const { THREE } = window.THREE3D; let top=-Infinity,bottom=Infinity; roots.forEach(r=>r?.traverse(o=>{ if(o.isMesh&&/PCB|silkscreen|soldermask/i.test(o.name)){ const b=new THREE.Box3().setFromObject(o); top=Math.max(top,b.max.y); bottom=Math.min(bottom,b.min.y); } })); return top>bottom ? [top,bottom] : [.0016,0]; }
  function addNoModelBlocks(roots, rows) { const { THREE } = window.THREE3D, [top,bottom]=boardY(roots), canvas=document.createElement("canvas"); canvas.width=canvas.height=32; const cx=canvas.getContext("2d"); cx.fillStyle="#b4b4b4";cx.fillRect(0,0,32,32);cx.strokeStyle="#5a5a5a";cx.lineWidth=5; for(let x=-32;x<64;x+=16){cx.beginPath();cx.moveTo(x,32);cx.lineTo(x+32,0);cx.stroke();} const texture=new THREE.CanvasTexture(canvas); texture.wrapS=texture.wrapT=THREE.RepeatWrapping; texture.repeat.set(3,3); texture.colorSpace=THREE.SRGBColorSpace; active.textures.add(texture); rows.forEach(row=>{if(!row.pos||!row.box)return; const rot=row.pos[2]||0, swap=Math.round(Math.abs(rot)/90)%2===1, w=(row.box[2]-row.box[0])/1000, d=(row.box[3]-row.box[1])/1000, width=Math.max(.001,swap?d:w), depth=Math.max(.001,swap?w:d), onBottom=(row.layer||"F.Cu").startsWith("B."), sides=row.side==="both"?[0,1]:[row.side==="base"?0:1]; sides.forEach(i=>{if(!roots[i])return;const g=new THREE.Group(), mesh=new THREE.Mesh(new THREE.BoxGeometry(width,.001,depth),new THREE.MeshStandardMaterial({map:texture,color:0xc0c0c0}));g.name=row.ref;g.userData.noModel=true;g.position.set(row.pos[0]/1000,onBottom?bottom-.0005:top+.0005,row.pos[1]/1000);g.rotation.y=rot*Math.PI/180;g.add(mesh);roots[i].add(g);(window.Review3D.state.blocks ||= []).push({ref:row.ref,object:g,side:i ? "head" : "base"});active.refs.add(row.ref);}); }); }

  function placeholderBatch(parts) {
    const {THREE:T}=THREE3D,missing=parts.filter(p=>!p.hasModel);if(!missing.length)return null;
    const positions=[],normals=[],uvs=[],indices=[],groups=[];
    for(const side of ['top','bottom']) {
     const start=indices.length;
     for(const p of missing.filter(p=>p.side===side)) {
      const size=p.bounds.getSize(new T.Vector3()),center=p.bounds.getCenter(new T.Vector3());
      const box=new T.BoxGeometry(size.x,size.y,size.z);box.translate(...center.toArray());
      const offset=positions.length/3;
      positions.push(...box.attributes.position.array);normals.push(...box.attributes.normal.array);
      uvs.push(...box.attributes.uv.array);indices.push(...Array.from(box.index.array,i=>i+offset));box.dispose();
     }
     groups.push({start,count:indices.length-start});
    }
    const g=new T.BufferGeometry();g.setAttribute('position',new T.Float32BufferAttribute(positions,3));
    g.setAttribute('normal',new T.Float32BufferAttribute(normals,3));
    g.setAttribute('uv',new T.Float32BufferAttribute(uvs,2));g.setIndex(indices);
    const tile=document.createElement('canvas');tile.width=tile.height=8;const c=tile.getContext('2d');
    c.fillStyle='#888';c.fillRect(0,0,8,8);c.strokeStyle='#bbb';
    c.beginPath();c.moveTo(0,8);c.lineTo(8,0);c.stroke();
    const map=new T.CanvasTexture(tile);map.wrapS=map.wrapT=T.RepeatWrapping;
    groups.forEach((group,i)=>g.addGroup(group.start,group.count,i));
    const mesh=new T.Mesh(g,['top','bottom'].map(()=>new T.MeshBasicMaterial({map})));
    mesh.userData={role:'body',placeholderSides:['top','bottom']};
    mesh.name='parts:missing';mesh.raycast=()=>{};return mesh;
  }

  async function show(stage, project, appState, {single = false} = {}) {
    window.Review3D.onStateChange?.({partSelection:null});
    dispose();
    const model = project.board.model3d || {}, sides = single ? ['head'] : ['base', 'head'], mode = appState.m;
    const session = active = {
      views:[], roots:[], changes:project.changes.filter(c => c.kind === 'footprint'),
      refs:new Set(), changesByRef:{}, indexedSides:new Set(), hiddenGroups:new Set(), groups:[], selected:[], dead:false, mode, single, allowedSides:sides,
      revision:single ? 'head' : ['base', 'head'].includes(appState.revision) ? appState.revision : 'head',
      abort:new AbortController(), partWarn:new Set(), pending:new Map(), urls:new Set(), worker:null, nextId:0,
      assetId:0, assetNonce:crypto.randomUUID(), animationFrames:new Set(),
      available:Object.fromEntries(sides.map(side => [side, !!(model[side] || project.board.poster3d?.[side] || project.board.assets3d?.[side]?.model || model.errors?.[side])])),
      geometries:new Set(), materials:new Set(), textures:new Set(), environments:new Map(), comparisonMaterials:new Map(),
      parses:new Map(), decodedModels:new Map(), decodedScenes:[],
      assembled:appState.assembled3d !== false, hidden:[], lighting:normalizeLighting(appState.lighting3d), hiddenBodies:false, visible:true, hostsBySide:{}, stage, project, appState
    };
    const state = window.Review3D.state = session.state = {
      roots:session.roots, views:session.views, decodedScenes:session.decodedScenes, disposed:false, firstFrame:false, loading:false,
      revision:session.revision, assembled:session.assembled, lighting:session.lighting, modelDigests:{},
      loadingBySide:{base:false, head:false}, posterBySide:{base:null, head:null}, errorsBySide:{}, posterErrorsBySide:{},
      placeholderMeshBySide:{base:null,head:null}, resourceCounts:{workers:0, urls:0, pending:0}, parts:{base:[], head:[]}, selected:[],
      changedParts:new Set(session.changes.map(c => c.uuid || c.ref)).size,
      renderers:[], cameras:[], controls:[], visibleSides:[], drawCallsByViewport:[], drawCount:0,
      nodes:[], highlights:[], ghosts:[], blocks:[], parseCount:0
    };
    session.resourceCounts = state.resourceCounts;
    for (const side of sides) state.loadingBySide[side] = !!model[side];
    state.loading = Object.values(state.loadingBySide).some(Boolean);
    stage.className = 'mode-3d'; stage.replaceChildren(); cameraBar();
    for (const side of sides) {
      const host = document.createElement('section'); host.className = 'vp view3d' + (single ? ' one' : '');
      host.innerHTML = `<span class="tag">${single ? 'Design' : side === 'head' ? 'Head' : 'Base'}</span>`;
      const status = document.createElement('p'); status.className = model[side] ? 'loading' : 'empty3d';
      status.setAttribute('role', 'status');
      status.textContent = model[side] ? 'Loading 3D board…' : model.errors?.[side] || (session.available[side] ? '3D model unavailable' : 'Board not in this revision');
      host.appendChild(status); stage.appendChild(host); session.hostsBySide[side] = host;
    }
    routeRevisionViews();
    await Promise.all(sides.map(async side => {
      try {
        const image = await poster3d(side, project.board.poster3d?.[side], session);
        if (session.dead) return;
        state.posterBySide[side] = image;
        if (image) session.hostsBySide[side].prepend(image);
      } catch (error) { if (!session.dead && error.name !== 'AbortError') state.posterErrorsBySide[side] = 'Preview unavailable: ' + error.message; }
    }));
    if (session.dead) return;
    let T;
    try { T = await loadThree(session); }
    catch (error) {
      if (!session.dead) {
        for (const side of sides) { state.loadingBySide[side] = false; if (session.available[side]) failure(session, side, error.message); }
        state.loading = false;
      }
      return;
    }
    if (session.dead) return;
    try {
      const renderer = new T.THREE.WebGLRenderer({antialias:true, alpha:true});
      renderer.setClearColor(0, 0); renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      renderer.toneMapping = T.THREE.NeutralToneMapping; renderer.outputColorSpace = T.THREE.SRGBColorSpace; renderer.toneMappingExposure = session.lighting.exposure;
      renderer.autoClear = false; renderer.info.autoReset = false;
      session.renderer = renderer; session.canvas = renderer.domElement; stage.prepend(session.canvas); state.renderers = [renderer];
      session.canvas.addEventListener('webglcontextlost', event => {
        event.preventDefault(); if (session.dead) return;
        session.contextLost = true; state.firstFrame = false; state.loading = false;
        session.pixelSample?.reject(Error('WebGL context lost')); session.pixelSample = null;
        for (const side of sides) { state.loadingBySide[side] = false; if (session.available[side]) failure(session, side, 'WebGL context lost. Retry.'); }
      }, {signal:session.abort.signal});
      session.resizeObserver = new ResizeObserver(resize); session.resizeObserver.observe(stage);
    } catch (error) {
      state.loading = false; state.firstFrame = false;
      for (const side of sides) { state.loadingBySide[side] = false; if (session.available[side]) failure(session, side, 'WebGL unavailable: ' + error.message); }
      return;
    }
    const loadSide = async side => {
      try {
        if (!model[side]) return null;
        const digest = state.modelDigests[side] = project.board.assets3d?.[side]?.model?.digest || model[side];
        if (!session.decodedModels.has(digest)) {
          const pending = guardSession(session, decode3d({b64:window.REVIEW_DATA.blobs[model[side]]}, session));
          session.decodedModels.set(digest, pending);
          pending.catch(() => { if (session.decodedModels.get(digest) === pending) session.decodedModels.delete(digest); });
        }
        const bytes = await session.decodedModels.get(digest);
        const gltf = await parseByDigest(session, digest, bytes, async bytes => {
          const g = await new T.GLTFLoader().setMeshoptDecoder(T.MeshoptDecoder).parseAsync(bytes, '');
          // Rename the immutable source nodes before logical cloning.
          g.scene.traverse(o => {
            const name = g.parser.json.meshes?.[g.parser.associations.get(o)?.meshes]?.name;
            if (o.isMesh && /PCB|silkscreen|soldermask/i.test(name || '')) o.name = name;
          });
          return g;
        });
        if (session.dead) return null;
        let hasGeometry = false;
        gltf.scene.traverse(n => { if (n.isMesh && n.geometry?.getAttribute('position')?.count) hasGeometry = true; });
        if (!hasGeometry) throw Error('No renderable 3D geometry.');
        return gltf.scene.clone(true);
      } catch (error) {
        if (!session.dead) failure(session, side, String(error.message || error));
        return null;
      } finally {
        state.loadingBySide[side] = false; state.loading = Object.values(state.loadingBySide).some(Boolean);
      }
    };
    const [roots, ...parts] = await Promise.all([Promise.all(sides.map(loadSide)), ...sides.map(side => loadPartIndex(project.board, side, session))]);
    if (session.dead) return;
    sides.forEach((side, i) => {
      state.parts[side] = parts[i];
      session.changesByRef[side]=new Map(session.changes
        .filter(c=>side==='base'?c.action!=='added':c.action!=='removed')
        .map(c=>[ThreeParts.reference(c,side,parts[i]),c]));
    });
    session.roots = state.roots = roots;
    const base = single ? null : roots[0], head = roots[sides.indexOf('head')], logicalRoots = [base, head];
    const box = new T.THREE.Box3(); roots.forEach(r => r && box.union(new T.THREE.Box3().setFromObject(r)));
    addNoModelBlocks(logicalRoots.map((root,i)=>session.indexedSides.has(i?'head':'base')?null:root), project.board.no_model || []);
    for(const side of sides)if(session.indexedSides.has(side)&&sideRoot(session,side)) {
      const mesh=placeholderBatch(state.parts[side]);state.placeholderMeshBySide[side]=mesh;
      if(mesh) {
        sideRoot(session,side).add(mesh);session.geometries.add(mesh.geometry);
        for(const m of mesh.material){session.materials.add(m);session.textures.add(m.map);}
      }
    }
    roots.forEach(r => r && box.union(new T.THREE.Box3().setFromObject(r)));
    if (box.isEmpty()) {
      for (const side of sides) if (model[side] && !state.errorsBySide[side]) failure(session, side, 'No renderable 3D geometry.');
      return;
    }
    session.box = state.box = box;
    roots.forEach(r => r?.traverse(n => { if (n.name) { session.refs.add(n.name); state.nodes.push(n.name); } }));
    roots.forEach(classify); state.groups = session.groups;
    const highlight = (side, v) => session.changes.filter(c => side === 'head' ? c.action !== 'removed' : c.action !== 'added').forEach(c => {
      const ref=ThreeParts.reference(c,side,state.parts[side]),n = sideRoot(session, side)?.getObjectByName(ref),p=state.parts[side].find(p=>p.ref===ref);
      if (n||p&&!p.hasModel) { const h = n?cloneMaterials(n, c):{original:[],materials:[]}, m = marker(v, n, {...c,ref},p?.bounds); state.highlights.push({ref, action:c.action, side, original:h.original, materials:h.materials, marker:m}); }
    });
    if (mode === 'side' || single) {
      for (const [i, side] of sides.entries()) {
        try {
          const host = session.hostsBySide[side]; host.querySelector('.loading')?.remove();
          // Empty revisions still own a camera and input host, never a peer model/poster.
          const v = view(host, roots[i] ? [roots[i]] : [], side); if (roots[i]) highlight(side, v);
        } catch (error) { failure(session, side, error.message); }
      }
    } else {
      const side = head ? 'head' : 'base', host = session.hostsBySide[side], otherSide = side === 'head' ? 'base' : 'head';
      try {
        session.hostsBySide[otherSide].hidden = !state.errorsBySide[otherSide] || session.partWarn.has(otherSide);
        host.classList.toggle('one', session.hostsBySide[otherSide].hidden);
        host.querySelector('.tag').textContent = mode === 'overlay' ? 'Base position (red ghost) · Changed now (amber)' : mode === 'semantic' ? 'Changes only' : 'Base ↔ Head';
        const v = view(host, mode === 'blend' ? roots.filter(Boolean) : head ? [head] : base ? [base] : []);
        if (mode === 'overlay') {
          highlight(head ? 'head' : 'base', v);
          session.changes.filter(c => c.action === 'removed' || c.action === 'modified').forEach(c => {
            const ref=ThreeParts.reference(c,'base',state.parts.base),n = base?.getObjectByName(ref);
            if (n) { const g = n.clone(true); cloneMaterials(g, null, false, 'ghost'); v.scene.add(g); state.ghosts.push({ref, side:'base', object:g, translation:n.getWorldPosition(new T.THREE.Vector3()).add(new T.THREE.Vector3(0, .01, 0)).toArray()}); }
          });
        } else if (mode === 'blend') {
          const bm = cloneMaterials(base, null, false, 'blend:base').materials, hm = cloneMaterials(head, null, false, 'blend:head').materials;
          session.blend = {base:[...new Set(bm)], head:[...new Set(hm)], value:appState.blend ?? .5}; setBlend(session.blend.value);
        } else if (mode === 'semantic') {
          const refs = new Set(session.changes.filter(c => c.action !== 'removed').map(c => c.ref)); state.faded = [];
          head?.traverse(n => { if (n.name && !refs.has(n.name) && /^[A-Z]+\d+/.test(n.name)) { const f = cloneMaterials(n, null, true); state.faded.push({ref:n.name, materials:f.materials}); } });
          highlight(head ? 'head' : 'base', v);
        }
      } catch (error) { failure(session, side, error.message); }
    }
    if (!single && model.base && model.head && (model.changed === false || model.base === model.head)) {
      const notice = document.createElement('p'); notice.className = 'no-change-notice'; notice.textContent = 'No 3D changes';
      notice.style.cssText = 'position:absolute;bottom:8px;left:50%;transform:translateX(-50%);z-index:5;background:var(--surface);color:var(--text);padding:6px 12px;border:1px solid var(--line);pointer-events:none'; stage.appendChild(notice);
    }
    for (const side of sides) session.hostsBySide[side].querySelector('.loading')?.remove();
    setHidden(appState.hidden3d); resize(); frame('3d'); if (appState.camera3d) setCameraState(appState.camera3d);
    const signal = session.abort.signal;
    const media = matchMedia('(prefers-color-scheme: dark)'); let signature = [bg(), css('--added'), css('--removed'), css('--modified'), css('--accent')].join('|');
    const theme = () => { const next = [bg(), css('--added'), css('--removed'), css('--modified'), css('--accent')].join('|'); if (signature !== next) { signature = next; recolour(); } };
    document.addEventListener('kr-theme-change', theme, {signal}); media.addEventListener('change', theme, {signal}); session.themeTimer = setInterval(theme, 250);
    if (appState.s) { const c = session.changes.find(c => c.id === appState.s); if (c) focus(c, !appState.camera3d); }
  }
  // Node contracts consume the unchanged helper; the browser API stays private.
  if (typeof module === 'object' && module.exports) module.exports = {parseByDigest};
  return {show,dispose,cameraBar,frame,focus,focusPart,changeForPart,setHidden,setLighting,setAssembled,normalizeLighting,cameraState,setCameraState,setBlend,toggleBlend,resize,setRevision,sampleFrame,session:()=>active,poster3d,state:undefined};
})();
