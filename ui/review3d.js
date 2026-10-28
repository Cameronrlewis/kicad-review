"use strict";
/* Lazy 3D board viewer. The three.js bundle remains inert until this view opens. */
window.Review3D = (() => {
  const style = document.createElement("style");
  style.textContent = `.mode-3d [data-poster]{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}.mode-3d [hidden]{display:none!important}.mode-3d .error3d{position:absolute;bottom:16px;left:16px;right:16px;z-index:3;padding:12px;background:var(--surface);color:var(--text);border:1px solid var(--line)}.mode-3d .error3d{overflow-wrap:anywhere;max-height:calc(100% - 32px);overflow:auto;box-sizing:border-box}.mode-3d .error3d button{min-height:32px;cursor:pointer;color:var(--text);background:var(--surface);border:1px solid var(--line);padding:4px 12px}@media(max-width:700px){.mode-3d .error3d button{min-height:44px}}.mode-3d .error3d p{margin:0 0 8px}.mode-3d button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.mode-3d{background:var(--line)}.mode-3d .view3d{background:var(--paper);min-width:0;position:relative}.mode-3d .view3d.one{grid-column:1/-1}.mode-3d canvas{display:block;width:100%;height:100%}.mode-3d .marker3d,.tip3d{position:absolute;z-index:2;pointer-events:none;transform:translate(-50%,-100%);font:700 13px system-ui,sans-serif;line-height:1;white-space:nowrap;color:var(--text);text-shadow:0 1px 2px var(--paper),1px 0 2px var(--paper),-1px 0 2px var(--paper),0 -1px 2px var(--paper)}.tip3d{text-shadow:none;padding:3px 5px;background:var(--surface);border:1px solid var(--line);border-radius:3px}.loading,.empty3d{position:absolute;inset:0;display:grid;place-items:center;color:var(--muted);margin:0}#modes button[aria-disabled=true]{cursor:not-allowed;opacity:.55}`;
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
    s.resizeObserver?.disconnect(); s.intersectionObserver?.disconnect();
    s.resourceCounts.workers = s.resourceCounts.urls = s.resourceCounts.pending = 0;
  }
  function decode3d(source, s) {
    if (s.dead) return Promise.reject(new DOMException('Viewer closed', 'AbortError'));
    try {
      if (!s.worker) {
        const code = atob(document.querySelector('#three-decode-worker').textContent.trim());
        const url = URL.createObjectURL(new Blob([code], {type:'text/javascript'}));
        s.urls.add(url); s.resourceCounts.urls = s.urls.size;
        s.worker = new Worker(url); s.resourceCounts.workers = 1;
        s.worker.onmessage = ({data}) => {
          const job = s.pending.get(data.id); if (!job) return;
          s.pending.delete(data.id); s.resourceCounts.pending = s.pending.size;
          data.error ? job.reject(Error(data.error)) : job.resolve(data.buffer);
        };
        const failed = event => {
          event.preventDefault();
          for (const job of s.pending.values()) job.reject(Error('3D worker failed. Retry.'));
          s.pending.clear(); s.worker?.terminate(); s.worker = null;
          s.resourceCounts.pending = s.resourceCounts.workers = 0;
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
  function dispose() {
    if (!active) return;
    const s = active; closeSession(s); clearInterval(s.themeTimer);
    s.views.forEach(v => { v.controls.dispose(); v.renderer.dispose(); v.canvas.remove(); });
    [...s.roots, ...s.views.map(v => v.scene)].forEach(r => r?.traverse(free));
    s.state.disposed = true; s.state.loading = false;
    s.state.loadingBySide.base = s.state.loadingBySide.head = false;
    active = null;
  }
  function failure(s, side, message) {
    if (s.dead) return;
    s.state.errorsBySide[side] = message;
    const host = s.hostsBySide[side]; host.hidden = false;
    host.querySelector('.loading')?.remove();
    if (s.state.posterBySide[side]) s.state.posterBySide[side].hidden = false;
    let notice = host.querySelector('.error3d');
    if (!notice) { notice = document.createElement('div'); notice.className = 'empty error3d'; notice.setAttribute('role', 'alert'); host.appendChild(notice); }
    notice.replaceChildren();
    const text = document.createElement('p'); text.textContent = '3D model could not be loaded. ' + message;
    const retry = document.createElement('button'); retry.dataset['3dRetry'] = ''; retry.textContent = 'Retry 3D';
    retry.onclick = () => { if (!s.dead) void show(s.stage, s.project, s.appState); };
    notice.append(text, retry);
  }
  function cameraBar() {
    const bar = document.querySelector("#zoombar"); if (!bar) return;
    bar.innerHTML = `<details class="camera-presets"><summary title="3D camera orientations"><svg class="i" aria-hidden="true"><use href="#kr-i-cube"></use></svg>Camera</summary><div class="camera-menu">${["Top","Bottom","Front","Back","Left","Right","3D","Reset"].map(n => `<button data-3d-camera="${n.toLowerCase()}" title="${n} camera view">${n}</button>`).join("")}</div></details>`;
    const menu = bar.querySelector("details"), popup = bar.querySelector(".camera-menu");
    menu.ontoggle = () => { const r = bar.getBoundingClientRect(); popup.style.top = document.querySelector("#toolbar").getBoundingClientRect().bottom + 4 + "px"; popup.style.left = Math.min(r.left, innerWidth - 180) + "px"; };
    menu.onkeydown = e => { if (e.key === "Escape") { menu.open = false; menu.querySelector("summary").focus(); e.stopPropagation(); } };
    bar.querySelectorAll("[data-3d-camera]").forEach(b => b.onclick = () => { frame(b.dataset["3dCamera"]); window.Review3D.onCameraEnd?.(); menu.open = false; menu.querySelector("summary").focus(); });
  }
  function render() { if (!active || active.dead || active.contextLost) return; active.views.forEach(v => { v.renderer.render(v.scene, v.camera);
    if (v.scene.children.some(root => active.roots.includes(root))) {
      active.state.firstFrame = true;
      for (const side of v.sides) if (active.state.posterBySide[side]) active.state.posterBySide[side].hidden = true;
    } (v.labels || []).forEach(m => { const p = m.position.clone().project(v.camera), w = v.canvas.clientWidth, h = v.canvas.clientHeight; m.el.style.display = p.z > 1 ? "none" : "block"; m.el.style.left = `${(p.x * .5 + .5) * w}px`; m.el.style.top = `${(-p.y * .5 + .5) * h}px`; }); }); }
  function setCamera(v, centre, radius, animate) { const { THREE } = window.THREE3D, dir = v.camera.position.clone().sub(v.controls.target).normalize(), vfov = THREE.MathUtils.degToRad(v.camera.fov), hfov = 2 * Math.atan(Math.tan(vfov / 2) * v.camera.aspect), distance = Math.max(radius / Math.sin(Math.min(vfov, hfov) / 2) * 1.25, .02), target = centre.clone(), position = centre.clone().addScaledVector(dir, distance);
    const owner=active, startP=v.camera.position.clone(), startT=v.controls.target.clone(), start=performance.now(), length=animate&&!matchMedia("(prefers-reduced-motion: reduce)").matches?400:0; const tick=now=>{ if(owner.dead)return; const t=length?Math.min(1,(now-start)/length):1, e=1-(1-t)*(1-t); v.camera.position.lerpVectors(startP,position,e); v.controls.target.lerpVectors(startT,target,e); if(!length){v.camera.near=distance/100;v.camera.far=distance*100;} v.camera.updateProjectionMatrix(); v.controls.update(); if(length)render(); if(t<1) requestAnimationFrame(tick); }; if(length)requestAnimationFrame(tick);else tick(start);
  }
  function frame(direction = "3d") { if (!active?.box) return; const { THREE } = window.THREE3D, b = active.box, c = b.getCenter(new THREE.Vector3()), dirs = { top:[0,1,0], bottom:[0,-1,0], front:[0,0,-1], back:[0,0,1], left:[-1,0,0], right:[1,0,0], "3d":[1,.99,-1], reset:[1,.99,-1] }, d = new THREE.Vector3(...dirs[direction]).normalize(), radius = b.getBoundingSphere(new THREE.Sphere()).radius;
    active.views.forEach(v => { const vfov = THREE.MathUtils.degToRad(v.camera.fov), hfov = 2 * Math.atan(Math.tan(vfov / 2) * v.camera.aspect), distance = radius / Math.sin(Math.min(vfov, hfov) / 2) * 1.08; v.camera.up.set(...((direction === "top" || direction === "bottom") ? [0,0,-1] : [0,1,0])); v.controls._quat.setFromUnitVectors(v.camera.up, new THREE.Vector3(0,1,0)); v.controls._quatInverse.copy(v.controls._quat).invert(); v.camera.position.copy(c).addScaledVector(d, distance); v.controls.target.copy(c); v.camera.near = distance / 100; v.camera.far = distance * 100; v.camera.updateProjectionMatrix(); v.controls.update(); }); render(); }
  function resize() { active?.views.forEach(v => { const r=v.host.getBoundingClientRect(); v.renderer.setSize(r.width,r.height,false); v.camera.aspect=r.width/Math.max(r.height,1); v.camera.updateProjectionMatrix(); }); render(); }
  // Selection outline: the part's bounding box in --accent, drawn over everything. ponytail: box, not silhouette; per-mesh edges were an unreadable tangle.
  function outline(scene, node, colour) { const { THREE }=window.THREE3D, b=new THREE.Box3().setFromObject(node), size=b.getSize(new THREE.Vector3()), e=new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(size.x,size.y,size.z)),new THREE.LineBasicMaterial({color:colour,depthTest:false})); e.position.copy(b.getCenter(new THREE.Vector3())); e.renderOrder=10;e.raycast=()=>{}; scene.add(e); return e; }
  function cloneMaterials(root, change, fade=false) { const original=[], changed=[]; root?.traverse(o=>{ if(!o.isMesh)return; const before=materials(o); const after=before.map(m=>{const n=m.clone(); if(fade){n.transparent=true;n.opacity=.12;n.color?.set("#a8a8a8");}else{const c=tint(change.action);n.color?.lerp(c,.7);if(n.emissive){n.emissive.copy(c);n.emissiveIntensity=.7;}}return n;});original.push(...before);changed.push(...after);o.material=Array.isArray(o.material)?after:after[0];}); return {original,materials:changed}; }
  function recolour() { if(!active)return; const st=window.Review3D.state; active.views.forEach(v=>v.renderer.setClearColor(bg()));st.highlights.forEach(h=>{const c=tint(h.action);h.materials.forEach((m,i)=>{if(m.color)m.color.copy(h.original[i].color).lerp(c,.7);if(m.emissive)m.emissive.copy(c);});});st.ghosts.forEach(g=>g.object.traverse(o=>{if(o.isMesh)materials(o).forEach(m=>m.color.copy(tint("removed")));}));active.selected.forEach(o=>o.material.color.set(css("--accent")));render(); }
  function marker(v,node,change) { const { THREE }=window.THREE3D,b=new THREE.Box3().setFromObject(node),position=b.getCenter(new THREE.Vector3()),el=document.createElement("span");position.y=b.max.y+.004;el.className=`marker3d ${change.action}`;el.dataset.ref=change.ref;el.textContent=`${change.action === "added" ? "＋" : change.action === "removed" ? "−" : "≡"} ${change.ref||""}`;el.style.color=`var(--${change.action})`;v.host.appendChild(el);const m={position,el};(v.labels ||= []).push(m); return m; }
  function view(host, roots) { const { THREE,OrbitControls }=window.THREE3D,renderer=new THREE.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.setClearColor(bg());const camera=new THREE.PerspectiveCamera(35,1,.01,1000),scene=new THREE.Scene();scene.add(new THREE.HemisphereLight(0xffffff,0x334455,2));const light=new THREE.DirectionalLight(0xffffff,3);light.position.set(1,-1,2);scene.add(light,...roots);host.appendChild(renderer.domElement);const controls=new OrbitControls(camera,renderer.domElement),v={host,canvas:renderer.domElement,renderer,camera,scene,controls};controls.enableDamping=true;controls.addEventListener("change",()=>{if(active.syncing)return;active.syncing=true;active.views.forEach(q=>{if(q!==v){q.camera.position.copy(camera.position);q.controls.target.copy(controls.target);q.controls.update();}});active.syncing=false;render();});controls.addEventListener("end",()=>window.Review3D.onCameraEnd?.()); renderer.domElement.addEventListener("pointerup",e=>pick(v,e));renderer.domElement.addEventListener("pointermove",e=>{if(!e.buttons)hover(v,e);});v.sides = roots.map(r => active.roots.indexOf(r) === 0 ? 'base' : 'head');
    const owner = active;
    renderer.domElement.addEventListener('webglcontextlost', event => {
      event.preventDefault(); if (owner.dead) return;
      owner.contextLost = true; owner.state.firstFrame = false; owner.state.loading = false;
      for (const side of ['base', 'head']) {
        owner.state.loadingBySide[side] = false;
        if (owner.available[side]) failure(owner, side, 'WebGL context lost. Retry.');
      }
    }, {signal:owner.abort.signal});
    active.views.push(v);return v; }
  function hit(v,e) { const {THREE}=window.THREE3D,r=v.canvas.getBoundingClientRect(),ray=new THREE.Raycaster();ray.setFromCamera(new THREE.Vector2((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1),v.camera);const h=ray.intersectObjects(v.scene.children,true).find(x=>x.object.visible);let n=h?.object;while(n&&!n.userData.noModel&&!active.changes.some(c=>c.ref===n.name))n=n.parent;return n; }
  function pick(v,e) { if(!active)return; const n=hit(v,e);if(!n)return;const c=active.changes.find(x=>x.ref===n.name);if(c)window.Review3D.onPick?.(c.id);else hover(v,e); }
  function hover(v,e) { if(!active)return; const n=hit(v,e);if(n?.userData.noModel){const r=v.host.getBoundingClientRect();tooltip(v,`${n.name} · no 3D model`,e.clientX-r.left,e.clientY-r.top,1200);} }
  function tooltip(v,text,x,y,ms){ let el=v.host.querySelector(".tip3d");if(!el){el=document.createElement("span");el.className="tip3d";v.host.appendChild(el);}el.textContent=text;el.style.left=`${x}px`;el.style.top=`${y}px`;clearTimeout(v.tip);if(ms)v.tip=setTimeout(()=>el.remove(),ms); }
  function focus(change, moveCamera=true) { if(!active)return; const side=change.action === "removed" ? "base" : "head", root=active.roots[side === "head" ? 1 : 0], n=root?.getObjectByName(change.ref); if(!n)return; const {THREE}=window.THREE3D,b=new THREE.Box3().setFromObject(n), c=b.getCenter(new THREE.Vector3()), radius=b.getBoundingSphere(new THREE.Sphere()).radius; if(moveCamera)active.views.forEach(v=>setCamera(v,c,radius,true)); active.selected.forEach(x=>{x.removeFromParent();x.traverse(free);}); active.views.forEach(v=>{v.host.querySelector(".tip3d")?.remove();if(n.userData.noModel)tooltip(v,`${n.name} · no 3D model`,v.host.clientWidth/2,v.host.clientHeight/2,0);}); active.selected=active.views.flatMap(v=>{const own=[root,active.roots[side === "head" ? 0 : 1]].map(r=>r?.parent===v.scene&&r?.getObjectByName(change.ref)).find(Boolean);return own?[outline(v.scene,own,css("--accent"))]:[];}); window.Review3D.state.selected=active.selected; render(); }
  function setBlend(value){if(!active?.blend)return;active.blend.value=value;active.blend.base.forEach(m=>{m.transparent=true;m.opacity=1-value;});active.blend.head.forEach(m=>{m.transparent=true;m.opacity=value;});window.Review3D.state.blend=value;render();}
  function toggleBlend(){setBlend(active.blend.value<.5?1:0);}
  function setHidden(hidden = []) { if (!active) return; const off = new Set(hidden); active.groups.forEach(({object, groups}) => { object.visible = !groups.some(g => off.has(g)); }); render(); }
  function cameraState() { const v=active?.views[0]; return v ? [...v.camera.position.toArray(), ...v.controls.target.toArray()].map(n => Math.round(n * 10000) / 10) : null; }
  function setCameraState(c) { if (!active || !Array.isArray(c) || c.length !== 6) return; active.views.forEach(v => { v.camera.position.set(c[0]/1000,c[1]/1000,c[2]/1000); v.controls.target.set(c[3]/1000,c[4]/1000,c[5]/1000); v.controls.update(); }); render(); }
  // Layer pivots are arbitrary; every primitive of a component shares its world-box side.
  function classify(root) { const { THREE } = window.THREE3D, [top,bottom]=boardY(active.roots), middle=(top+bottom)/2, sides=new Map(), side=o=>{if(!sides.has(o))sides.set(o,new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3()).y>=middle?"top":"bottom");return sides.get(o);}; root?.traverse(o => { if (!o.isMesh) return; const name = o.name || ""; let groups; if (/silkscreen/i.test(name)) groups = ["silk", side(o)]; else if (/soldermask/i.test(name)) groups = ["mask", side(o)]; else if (/PCB/i.test(name)) groups = ["board"]; else { let p=o; while(p && !/^[A-Z]+\d+$/.test(p.name)) p=p.parent; groups = p && active.refs.has(p.name) ? ["bodies", side(p)] : []; } if(groups.length) active.groups.push({object:o,groups}); }); }
  // Board surfaces come from PCB/silkscreen/soldermask meshes, not the tallest component. ponytail: 90/270 swaps the AABB, other angles keep it as the footprint size.
  function boardY(roots) { const { THREE } = window.THREE3D; let top=-Infinity,bottom=Infinity; roots.forEach(r=>r?.traverse(o=>{ if(o.isMesh&&/PCB|silkscreen|soldermask/i.test(o.name)){ const b=new THREE.Box3().setFromObject(o); top=Math.max(top,b.max.y); bottom=Math.min(bottom,b.min.y); } })); return top>bottom ? [top,bottom] : [.0016,0]; }
  function addNoModelBlocks(roots, rows) { const { THREE } = window.THREE3D, [top,bottom]=boardY(roots), canvas=document.createElement("canvas"); canvas.width=canvas.height=32; const cx=canvas.getContext("2d"); cx.fillStyle="#b4b4b4";cx.fillRect(0,0,32,32);cx.strokeStyle="#5a5a5a";cx.lineWidth=5; for(let x=-32;x<64;x+=16){cx.beginPath();cx.moveTo(x,32);cx.lineTo(x+32,0);cx.stroke();} const texture=new THREE.CanvasTexture(canvas); texture.wrapS=texture.wrapT=THREE.RepeatWrapping; texture.repeat.set(3,3); texture.colorSpace=THREE.SRGBColorSpace; rows.forEach(row=>{if(!row.pos||!row.box)return; const rot=row.pos[2]||0, swap=Math.round(Math.abs(rot)/90)%2===1, w=(row.box[2]-row.box[0])/1000, d=(row.box[3]-row.box[1])/1000, width=Math.max(.001,swap?d:w), depth=Math.max(.001,swap?w:d), onBottom=(row.layer||"F.Cu").startsWith("B."), sides=row.side==="both"?[0,1]:[row.side==="base"?0:1]; sides.forEach(i=>{if(!roots[i])return;const g=new THREE.Group(), mesh=new THREE.Mesh(new THREE.BoxGeometry(width,.001,depth),new THREE.MeshStandardMaterial({map:texture,color:0xc0c0c0}));g.name=row.ref;g.userData.noModel=true;g.position.set(row.pos[0]/1000,onBottom?bottom-.0005:top+.0005,row.pos[1]/1000);g.rotation.y=rot*Math.PI/180;g.add(mesh);roots[i].add(g);(window.Review3D.state.blocks ||= []).push({ref:row.ref,object:g,side:i ? "head" : "base"});active.refs.add(row.ref);}); }); }
  async function show(stage, project, appState) {
    dispose();
    const model = project.board.model3d || {}, sides = ['base', 'head'], mode = appState.m;
    const session = active = {
      views:[], roots:[], changes:project.changes.filter(c => c.kind === 'footprint'),
      refs:new Set(), groups:[], selected:[], dead:false, mode,
      abort:new AbortController(), pending:new Map(), urls:new Set(), worker:null, nextId:0,
      assetId:0, assetNonce:crypto.randomUUID(),
      available:Object.fromEntries(sides.map(side => [side, !!(model[side] || project.board.poster3d?.[side] || project.board.assets3d?.[side]?.model || model.errors?.[side])])),
      geometries:new Set(), materials:new Set(), textures:new Set(), environments:new Map(),
      assembled:true, hiddenBodies:false, visible:true, hostsBySide:{}, stage, project, appState
    };
    const state = window.Review3D.state = session.state = {
      roots:session.roots, disposed:false, firstFrame:false, loading:false,
      loadingBySide:{base:false, head:false}, posterBySide:{base:null, head:null}, errorsBySide:{},
      resourceCounts:{workers:0, urls:0, pending:0}, parts:{base:[], head:[]}, selected:[],
      changedParts:new Set(session.changes.map(c => c.uuid || c.ref)).size,
      renderers:[], cameras:[], visibleSides:[], drawCallsByViewport:[], drawCount:0,
      nodes:[], highlights:[], ghosts:[], blocks:[], parseCount:0
    };
    session.resourceCounts = state.resourceCounts;
    for (const side of sides) state.loadingBySide[side] = !!model[side];
    state.loading = Object.values(state.loadingBySide).some(Boolean);
    stage.className = 'mode-3d'; stage.replaceChildren(); cameraBar();
    for (const side of sides) {
      const host = document.createElement('section'); host.className = 'vp view3d';
      host.innerHTML = `<span class="tag">${side === 'head' ? 'Head' : 'Base'}</span>`;
      const status = document.createElement('p'); status.className = model[side] ? 'loading' : 'empty3d';
      status.setAttribute('role', 'status');
      status.textContent = model[side] ? 'Loading 3D board…' : model.errors?.[side] || (session.available[side] ? '3D model unavailable' : 'Board not in this revision');
      host.appendChild(status); stage.appendChild(host); session.hostsBySide[side] = host;
    }
    await Promise.all(sides.map(async side => {
      try {
        const image = await poster3d(side, project.board.poster3d?.[side], session);
        if (session.dead) return;
        state.posterBySide[side] = image;
        if (image) session.hostsBySide[side].prepend(image);
      } catch (error) { if (!session.dead && error.name !== 'AbortError') state.errorsBySide[side] = 'Preview unavailable: ' + error.message; }
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
    const loadSide = async side => {
      state.loadingBySide[side] = !!model[side];
      state.loading = Object.values(state.loadingBySide).some(Boolean);
      try {
        if (!model[side]) return null;
        const bytes = await guardSession(session, decode3d({b64:window.REVIEW_DATA.blobs[model[side]]}, session));
        state.parseCount++;
        const gltf = await guardSession(session, new T.GLTFLoader().setMeshoptDecoder(T.MeshoptDecoder).parseAsync(bytes, ''), g => g.scene.traverse(free));
        let hasGeometry = false;
        gltf.scene.traverse(node => { if (node.isMesh && node.geometry?.getAttribute('position')?.count) hasGeometry = true; });
        if (!hasGeometry) { gltf.scene.traverse(free); throw Error('No renderable 3D geometry.'); }
        return gltf;
      } catch (error) {
        if (!session.dead) failure(session, side, String(error.message || error));
        return null;
      } finally {
        state.loadingBySide[side] = false; state.loading = Object.values(state.loadingBySide).some(Boolean);
      }
    };
    const models = await Promise.all(sides.map(loadSide));
    if (session.dead) { models.forEach(g => g?.scene.traverse(free)); return; }
    models.forEach(g=>g?.scene.traverse(o=>{const name=g.parser.json.meshes?.[g.parser.associations.get(o)?.meshes]?.name;if(o.isMesh&&/PCB|silkscreen|soldermask/i.test(name||""))o.name=name;}));const roots=models.map(g=>g?.scene||null);session.roots=roots;window.Review3D.state.roots=roots;const box=new T.THREE.Box3();roots.forEach(r=>r&&box.union(new T.THREE.Box3().setFromObject(r)));addNoModelBlocks(roots,project.board.no_model || []); roots.forEach(r=>r&&box.union(new T.THREE.Box3().setFromObject(r)));if(box.isEmpty()){
      sides.forEach(side => { if (model[side] && !state.errorsBySide[side]) failure(session, side, 'No renderable 3D geometry.'); });
      return;
    }session.box=box;window.Review3D.state.box=box;roots.forEach(r=>r?.traverse(n=>{if(n.name){session.refs.add(n.name);window.Review3D.state.nodes.push(n.name);}})); roots.forEach(classify); window.Review3D.state.groups=session.groups; const highlight=(side,v)=>session.changes.filter(c=>side==="head"?c.action!=="removed":c.action!=="added").forEach(c=>{const n=roots[side==="head"?1:0]?.getObjectByName(c.ref);if(n){const h=cloneMaterials(n,c), m=marker(v,n,c);window.Review3D.state.highlights.push({ref:c.ref,action:c.action,side,original:h.original,materials:h.materials,marker:m});}});if(mode === 'side') {
      roots.forEach((r, i) => {
        const side = sides[i], host = session.hostsBySide[side];
        host.querySelector('.loading')?.remove();
        if (r) {
          try { const v = view(host, [r]); highlight(side, v); }
          catch (error) { failure(session, side, error.message); }
        }
      });
    } else {
      try {
      const side = roots[1] ? 'head' : 'base', host = session.hostsBySide[side];
      const otherSide = side === 'head' ? 'base' : 'head';
      session.hostsBySide[otherSide].hidden = !state.errorsBySide[otherSide];
      host.classList.toggle('one', session.hostsBySide[otherSide].hidden);
      host.querySelector('.tag').textContent = mode === 'overlay' ? 'Base position (red ghost) · Changed now (amber)' : mode === 'semantic' ? 'Changes only' : 'Base ↔ Head';
      host.querySelector('.loading')?.remove();
      const head=roots[1],base=roots[0],v=view(host,mode==="blend"?roots.filter(Boolean):head?[head]:base?[base]:[]);if(mode==="overlay"){highlight(head?"head":"base",v);session.changes.filter(c=>c.action==="removed"||c.action==="modified").forEach(c=>{const n=base?.getObjectByName(c.ref);if(n){const g=n.clone(true);g.traverse(o=>{if(o.isMesh)o.material=new T.THREE.MeshBasicMaterial({color:tint("removed"),transparent:true,opacity:.45,depthTest:false});});v.scene.add(g);window.Review3D.state.ghosts.push({ref:c.ref,object:g,translation:n.getWorldPosition(new T.THREE.Vector3()).add(new T.THREE.Vector3(0,.01,0)).toArray()});}});}else if(mode==="blend"){const bm=[],hm=[];base?.traverse(o=>o.isMesh&&bm.push(...materials(o)));head?.traverse(o=>o.isMesh&&hm.push(...materials(o)));session.blend={base:bm,head:hm,value:appState.blend??.5};setBlend(session.blend.value);}else if(mode==="semantic"){const refs=new Set(session.changes.filter(c=>c.action!=="removed").map(c=>c.ref));window.Review3D.state.faded=[];head?.traverse(n=>{if(n.name&&!refs.has(n.name)&&/^[A-Z]+\d+/.test(n.name)){const f=cloneMaterials(n,null,true);window.Review3D.state.faded.push({ref:n.name,materials:f.materials});}});highlight(head?"head":"base",v);}
      } catch (error) { sides.forEach(side => { session.hostsBySide[side].hidden = false; if(session.available[side]) failure(session, side, error.message); }); }
    }
    if (model.base && model.head && (model.changed === false || model.base === model.head)) {
      const notice=document.createElement("p");notice.className="no-change-notice";notice.textContent="No 3D changes";
      notice.style.cssText="position:absolute;bottom:8px;left:50%;transform:translateX(-50%);z-index:5;background:var(--surface);color:var(--text);padding:6px 12px;border:1px solid var(--line);pointer-events:none";stage.appendChild(notice);
    }
    for (const side of sides) session.hostsBySide[side].querySelector('.loading')?.remove();
    state.visibleSides = session.views.flatMap(v => v.sides);
    setHidden(appState.hidden3d); resize();frame("3d"); if (appState.camera3d) setCameraState(appState.camera3d); window.Review3D.state.cameras=session.views.map(v=>v.camera);window.Review3D.state.renderers=session.views.map(v=>v.renderer);window.Review3D.state.controls=session.views.map(v=>v.controls);const signal=session.abort.signal;window.addEventListener("resize",resize,{signal});const media=matchMedia('(prefers-color-scheme: dark)');let signature=[bg(),css('--added'),css('--removed'),css('--modified'),css('--accent')].join('|');const theme=()=>{const next=[bg(),css('--added'),css('--removed'),css('--modified'),css('--accent')].join('|');if(signature!==next){signature=next;recolour();}};document.addEventListener('kr-theme-change',theme,{signal});media.addEventListener('change',theme,{signal});session.themeTimer=setInterval(theme,250); if(appState.s){const c=session.changes.find(c=>c.id===appState.s);if(c)focus(c,!appState.camera3d);}}
  return {show,dispose,cameraBar,frame,focus,setHidden,cameraState,setCameraState,setBlend,toggleBlend,state:undefined};
})();
