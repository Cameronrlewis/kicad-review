"use strict";
/* Lazy 3D board viewer. The three.js bundle is inert compressed text until this view opens. */
window.Review3D = (() => {
  const style = document.createElement("style"); style.textContent = `.mode-3d{background:var(--line)}.mode-3d .view3d{background:var(--paper);min-width:0}@media (prefers-color-scheme:dark){.mode-3d .view3d{background:var(--bg)}}.mode-3d canvas{display:block;width:100%;height:100%}.loading,.empty3d{position:absolute;inset:0;display:grid;place-items:center;color:var(--muted);margin:0}#modes button[aria-disabled=true]{cursor:not-allowed;opacity:.55}`; document.head.appendChild(style);
  let active = null, bundle;
  const decode = async id => {
    const bin = Uint8Array.from(atob(window.REVIEW_DATA.blobs[id]), c => c.charCodeAt(0));
    return new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
  };
  const loadThree = async () => {
    if (window.THREE3D) return window.THREE3D;
    if (!bundle) bundle = (async () => {
      const text = document.querySelector("#three-bundle").textContent.trim();
      const bytes = Uint8Array.from(atob(text), c => c.charCodeAt(0));
      const code = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
      const script = document.createElement("script"); script.textContent = code; document.head.appendChild(script);
      return window.THREE3D;
    })();
    return bundle;
  };
  // Page theme wins: dark follows --bg, light uses the --paper neutral. Read on every show and on theme change.
  const bg = () => getComputedStyle(document.documentElement).getPropertyValue(matchMedia("(prefers-color-scheme: dark)").matches ? "--bg" : "--paper").trim() || "#f5f4ef";
  const disposeObject = root => root?.traverse(o => { if (o.geometry) o.geometry.dispose(); const m = o.material; (Array.isArray(m) ? m : [m]).filter(Boolean).forEach(x => x.dispose()); });
  function dispose() {
    if (!active) return;
    active.dead = true; active.abort?.abort();
    for (const v of active.views) { v.controls?.dispose(); v.renderer?.dispose(); disposeObject(v.model); v.canvas?.remove(); }
    active.disposed = true; window.Review3D.state = { disposed: true, disposeCount: (window.Review3D.state?.disposeCount || 0) + 1 };
    active = null;
  }
  function cameraBar() {
    const bar = document.querySelector("#zoombar"); if (!bar) return;
    bar.innerHTML = `<span class="muted">Camera</span>${["Top", "Bottom", "Front", "Back", "Left", "Right", "3D", "Reset"].map(n => `<button data-3d-camera="${n.toLowerCase()}">${n}</button>`).join("")}`;
    bar.querySelectorAll("[data-3d-camera]").forEach(b => b.onclick = () => frame(b.dataset["3dCamera"]));
  }
  function frame(direction = "3d") {
    if (!active?.box) return;
    const { THREE } = window.THREE3D, b = active.box, c = b.getCenter(new THREE.Vector3());
    // KiCad GLB is Y-up: X runs left/right and +Z runs down a 2D board view.
    const dirs = { top:[0,1,0], bottom:[0,-1,0], front:[0,0,-1], back:[0,0,1], left:[-1,0,0], right:[1,0,0], "3d":[1,.99,-1], reset:[1,.99,-1] };
    const d = new THREE.Vector3(...dirs[direction]).normalize();
    const radius = b.getBoundingSphere(new THREE.Sphere()).radius;
    active.views.forEach(v => {
      const vfov = THREE.MathUtils.degToRad(v.camera.fov), hfov = 2 * Math.atan(Math.tan(vfov / 2) * v.camera.aspect);
      const distance = radius / Math.sin(Math.min(vfov, hfov) / 2) * 1.08; // per-pane fit, including tall parts
      // Top/bottom: GLB +Z points down the screen like the 2D board. Everything else: world up, so the board reads as a floor.
      if (direction === "top" || direction === "bottom") v.camera.up.set(0, 0, -1); else v.camera.up.set(0, 1, 0);
      // OrbitControls bakes `up` in at construction; re-derive it so orbiting after a preset does not flip.
      v.controls._quat.setFromUnitVectors(v.camera.up, new THREE.Vector3(0, 1, 0)); v.controls._quatInverse.copy(v.controls._quat).invert();
      v.camera.position.copy(c).addScaledVector(d, distance); v.controls.target.copy(c);
      v.camera.near = distance / 100; v.camera.far = distance * 100; v.camera.updateProjectionMatrix(); v.controls.update();
    });
    render();
  }
  function render() { active?.views.forEach(v => v.renderer.render(v.scene, v.camera)); }
  function resize() { if (!active) return; for (const v of active.views) { const r = v.host.getBoundingClientRect(); v.renderer.setSize(r.width, r.height, false); v.camera.aspect = r.width / Math.max(r.height, 1); v.camera.updateProjectionMatrix(); } render(); }
  async function show(stage, project) {
    dispose();
    const model = project.board.model3d || {}, sides = ["base", "head"], session = active = { views: [], dead: false, disposed: false, start: performance.now() };
    window.Review3D.state = { disposed: false, disposeCount: window.Review3D.state?.disposeCount || 0, nodes: [], cameras: [] };
    stage.className = "mode-3d"; stage.innerHTML = `<p class="loading">Loading 3D board…</p>`;
    cameraBar();
    const T = await loadThree(); if (session.dead) return;
    stage.innerHTML = "";
    const models = await Promise.all(sides.map(async side => {
      if (!model[side]) return null;
      const buf = await decode(model[side]); if (session.dead) return null;
      return await new Promise((resolve, reject) => new T.GLTFLoader().parse(buf, "", resolve, reject));
    }));
    if (session.dead) return;
    const box = new T.THREE.Box3();
    models.forEach(g => { if (g) box.union(new T.THREE.Box3().setFromObject(g.scene)); });
    if (box.isEmpty()) { stage.innerHTML = '<p class="empty">No 3D board model was exported.</p>'; return; }
    session.box = box; window.Review3D.state.box = box;
    models.forEach((g, i) => {
      const side = sides[i], host = document.createElement("section"); host.className = "vp view3d";
      host.innerHTML = `<span class="tag">${side === "base" ? "Base" : "Head"}</span>`;
      stage.appendChild(host);
      if (!g) { host.innerHTML += '<p class="empty3d">Board not in this revision</p>'; return; }
      const renderer = new T.THREE.WebGLRenderer({ antialias: true }); renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.setClearColor(bg());
      const camera = new T.THREE.PerspectiveCamera(35, 1, .01, 1000), scene = new T.THREE.Scene();
      scene.add(new T.THREE.HemisphereLight(0xffffff, 0x334455, 2)); const light = new T.THREE.DirectionalLight(0xffffff, 3); light.position.set(1, -1, 2); scene.add(light, g.scene);
      host.appendChild(renderer.domElement);
      const controls = new T.OrbitControls(camera, renderer.domElement); controls.enableDamping = true; controls.addEventListener("change", () => { if (session.syncing) return; session.syncing = true; session.views.forEach(q => { if (q === view) return; q.camera.position.copy(camera.position); q.controls.target.copy(controls.target); q.controls.update(); }); session.syncing = false; render(); });
      const view = { host, canvas: renderer.domElement, renderer, camera, scene, controls, model: g.scene }; session.views.push(view);
      g.scene.traverse(n => { if (n.name) window.Review3D.state.nodes.push(n.name); });
    });
    resize(); frame("3d");
    window.Review3D.state.cameras = session.views.map(v => v.camera); window.Review3D.state.controls = session.views.map(v => v.controls);
    await new Promise(requestAnimationFrame); // timing means a composited frame containing both parsed models
    window.Review3D.state.firstFrameMs = performance.now() - session.start; window.Review3D.state.firstFrame = true;
    const signal = (session.abort = new AbortController()).signal;
    window.addEventListener("resize", resize, { signal });
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { session.views.forEach(v => v.renderer.setClearColor(bg())); render(); }, { signal });
  }
  return { show, dispose, cameraBar, frame, get state() { return window.__review3dState; }, set state(v) { window.__review3dState = v; } };
})();
