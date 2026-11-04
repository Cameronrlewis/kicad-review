import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

// Exercise the production helper through the shared explicit test seam.
function cache() {
  const window = {};
  const document = {createElement: () => ({}), head: {appendChild() {}}};
  const module = {exports:{}};
  const source = readFileSync(new URL('./review3d.js', import.meta.url), 'utf8');
  runInNewContext(source, {window, document, DOMException, module});
  assert.equal('parseByDigest' in window.Review3D, false, 'cache helper stays out of the browser API');
  assert.equal(module.exports, window.Review3D.testSeam);
  assert.equal(Object.hasOwn(window.Review3D, 'state'), true);
  assert.equal(window.Review3D.state, null);
  const owner = {parses:new Map(), decodedScenes:[], dead:false, state:{parseCount:0}};
  return {owner, parseByDigest:(digest, bytes, parser) => module.exports.parseByDigest(owner, digest, bytes, parser)};
}

test('BR02 parseByDigest shares equal promises and separates distinct digests', async () => {
  const {owner, parseByDigest} = cache();
  let calls = 0;
  const parser = async bytes => { calls++; return {scene:{bytes}}; };
  const a = parseByDigest('sha-a', new ArrayBuffer(1), parser);
  const b = parseByDigest('sha-a', new ArrayBuffer(2), parser);
  assert.equal(a, b);
  assert.equal(await a, await b);
  await parseByDigest('sha-b', new ArrayBuffer(3), parser);
  assert.equal(calls, 2);
  assert.equal(owner.state.parseCount, 2);
  assert.equal(owner.parses.get('sha-a').refs, 2);
  assert.equal(owner.decodedScenes.length, 2);
});

test('BR02 rejected parse evicts only its matching digest and can retry', async () => {
  const {owner, parseByDigest} = cache();
  let calls = 0;
  const parser = async () => { if (++calls === 1) throw Error('corrupt'); return {scene:{}}; };
  await assert.rejects(parseByDigest('sha-a', new ArrayBuffer(0), parser), /corrupt/);
  assert.equal(owner.parses.has('sha-a'), false);
  await parseByDigest('sha-a', new ArrayBuffer(0), parser);
  assert.equal(calls, 2);
  assert.equal(owner.parses.size, 1);
});

test('BR02 stale rejection cannot evict a replacement parse entry', async () => {
  const {owner, parseByDigest} = cache();
  let reject;
  const pending = parseByDigest('sha-a', new ArrayBuffer(0), () => new Promise((_, r) => reject = r));
  await Promise.resolve();
  const replacement = {promise:Promise.resolve({scene:{}}), refs:1};
  owner.parses.set('sha-a', replacement);
  reject(Error('old parse'));
  await assert.rejects(pending, /old parse/);
  assert.equal(owner.parses.get('sha-a'), replacement);
});

function viewer() {
  const window = {}, controls = new Map();
  for (const key of ['rig', 'bearing', 'exposure', 'exposure-out', 'light-error']) controls.set(`[data-3d-${key}]`, {});
  const bar = {querySelector:key => controls.get(key)};
  const document = {createElement:() => ({}), head:{appendChild() {}}, querySelector:key => key === '#zoombar' ? bar : null};
  runInNewContext(readFileSync(new URL('./three-studio.js', import.meta.url), 'utf8'), {window});
  let fail = false, disposed = 0;
  window.THREE3D = {THREE:{
    DataTexture:class { dispose() { disposed++; } },
    PMREMGenerator:class { fromEquirectangular() { if (fail) throw Error('PMREM failed'); return {texture:{newEnvironment:true}}; } dispose() { disposed++; } }
  }};
  // Expose closure state only inside this VM, never in the production API.
  const source = readFileSync(new URL('./review3d.js', import.meta.url), 'utf8').replace('let active = null, bundle;', 'let active = null, bundle; window.setTestSession = s => active = s;');
  runInNewContext(source, {window, document, DOMException, clearTimeout});
  const lighting = {rig:'bench', bearing:60, exposure:1.35}, previous = {};
  const s = {lighting, state:{lighting, blocks:[], ghosts:[], highlights:[]}, renderer:{toneMappingExposure:1.35}, views:[{scene:{environment:previous},host:{querySelector:()=>null}}], environments:new Map(), roots:[], groups:[], selected:[], hiddenGroups:new Set(), assembled:true, visible:false};
  window.setTestSession(s);
  const events = [];
  window.Review3D.onStateChange = e => events.push(e);
  return {api:window.Review3D, s, previous, controls, events, fail:value => fail = value, disposed:() => disposed};
}

test('BR02 comparison clones separate source and action while reusing identical pairs', () => {
  class Color {
    constructor(value) { this.value = value; }
    lerp(c, weight) { this.value = `${this.value}:${c.value}:${weight}`; return this; }
    copy(c) { this.value = c.value; return this; }
  }
  const material = () => ({color:new Color('original'), emissive:new Color('black'), opacity:.72,
    clone() { return {...this, color:new Color(this.color.value), emissive:new Color(this.emissive.value)}; }});
  const window = {THREE3D:{THREE:{Color}}};
  const document = {createElement:() => ({}), head:{appendChild() {}}};
  const source = readFileSync(new URL('./review3d.js', import.meta.url), 'utf8')
    .replace('let active = null, bundle;', 'let active = null, bundle; window.testComparison = (s, root, c) => {active=s; return cloneMaterials(root,c);};');
  runInNewContext(source, {window, document, DOMException,
    getComputedStyle:() => ({getPropertyValue:key => key})});
  const s = {comparisonMaterials:new Map(), materials:new Set()}, shared = material(), other = material();
  const highlight = (original, action) => {
    const mesh = {isMesh:true, material:original};
    return window.testComparison(s, {traverse:fn => fn(mesh)}, {action}).materials[0];
  };
  const clones = ['added', 'removed', 'modified'].map(action => highlight(shared, action));
  assert.equal(new Set(clones).size, 3, 'different actions must not share a tinted clone');
  for (const [i, action] of ['added', 'removed', 'modified'].entries()) {
    assert.equal(clones[i], highlight(shared, action), 'same source/action reuses its clone');
    assert.equal(clones[i].color.value, `original:--${action}:0.7`);
    assert.equal(clones[i].emissive.value, `--${action}`);
    assert.equal(clones[i].opacity, .72);
  }
  assert.notEqual(highlight(other, 'added'), clones[0], 'distinct sources remain separate');
  assert.equal(s.materials.size, 4, 'each clone registered once for disposal');
  assert.equal(shared.color.value, 'original');
  assert.equal(shared.emissive.value, 'black');
});

test('BR02 lighting normalization rejects inherited rig keys', () => {
  const {api} = viewer();
  for (const rig of ['toString', 'constructor', '__proto__']) {
    assert.equal(JSON.stringify(api.normalizeLighting({rig})), '{"rig":"bench","bearing":60,"exposure":1.35}');
  }
});

test('BR02 failed lighting is atomic, announced, and recovers without stale errors', () => {
  const {api, s, previous, controls, events, fail, disposed} = viewer();
  const before = s.lighting;
  fail(true);
  api.setLighting({rig:'photo', bearing:90, exposure:1.2});
  assert.equal(s.lighting, before);
  assert.equal(s.state.lighting, before);
  assert.equal(s.renderer.toneMappingExposure, 1.35);
  assert.equal(s.views[0].scene.environment, previous);
  assert.equal(events.length, 0);
  assert.equal(s.environments.size, 0);
  assert.match(s.state.lightingError, /PMREM failed/);
  assert.match(controls.get('[data-3d-light-error]').textContent, /PMREM failed/);
  assert.equal(controls.get('[data-3d-light-error]').hidden, false);
  assert.equal(controls.get('[data-3d-rig]').value, 'bench');
  assert.equal(disposed(), 2);
  fail(false);
  api.setLighting({rig:'photo', bearing:90, exposure:1.2});
  assert.equal(s.lighting.rig, 'photo');
  assert.equal(s.renderer.toneMappingExposure, 1.2);
  assert.notEqual(s.views[0].scene.environment, previous);
  assert.equal(events.length, 1);
  assert.equal(s.state.lightingError, undefined);
  assert.equal(controls.get('[data-3d-light-error]').hidden, true);
  assert.equal(s.environments.size, 1);
});

for (const indexed of [true, false]) test(`BR02 hiding one physical side preserves its visible peer (${indexed ? 'indexed' : 'legacy'})`, () => {
  const {api, s, events} = viewer();
  s.state.parts = {head:indexed ? [{ref:'bottom-part', side:'bottom'}] : []};
  s.allowedSides = ['base', 'head'];
  const node = {};
  if (!indexed) {
    s.roots = [null, {getObjectByName:() => node, traverse() {}}];
    s.groups = [{object:{parent:node}, groups:['bodies', 'bottom']}];
  }
  let detached = 0, disposed = 0;
  const line = {ref:'bottom-part', side:'head', removeFromParent() { detached++; }, traverse(free) {
    free({geometry:{dispose() { disposed++; }}});
  }};
  s.selected.push(line);
  api.setHidden(['top']);
  assert.equal(s.selected.length, 1);
  assert.equal(s.selected[0], line);
  assert.equal(detached, 0);
  api.setHidden(['bottom']);
  assert.equal(s.selected.length, 0);
  assert.equal(s.state.selected, s.selected);
  assert.equal(detached, 1);
  assert.equal(disposed, 1);
  assert.equal(events.at(-1).hiddenGroups[0], 'bottom');
});

test('BR02 resize reuses physical marker visibility without indexed or legacy body scans', () => {
  const {api, s} = viewer();
  const host = {getBoundingClientRect:() => ({width:960, height:500})};
  s.appState = {}; s.single = true; s.mode = 'side'; s.revision = 'head';
  s.allowedSides = ['base', 'head']; s.available = {base:true, head:true};
  s.hostsBySide = Object.fromEntries(s.allowedSides.map(side => [side, {...host, querySelector:() => null, classList:{toggle() {}}}]));
  s.stage = host; s.renderer.setSize = () => {};
  s.views = [{side:'head', host:s.hostsBySide.head, camera:{updateProjectionMatrix() {}}}];
  s.groups = {forEach() { throw Error('resize scanned legacy groups'); }};
  s.state.parts = {head:{find() { throw Error('resize scanned indexed parts'); }}};
  const marker = {el:{}, physicalVisible:false};
  s.state.highlights = [{ref:'hidden-part', side:'head', marker}];
  api.resize();
  assert.equal(marker.el.hidden, true);
  marker.physicalVisible = true;
  api.resize();
  assert.equal(marker.el.hidden, false);
  api.setRevision('base');
  assert.equal(marker.el.hidden, true, 'routing hides the peer marker without recomputing physical visibility');
});

test('BR02 bare board releases independent outlines without resurrecting hidden selection', () => {
  const {api, s} = viewer();
  let detached = 0, geometries = 0, materials = 0;
  s.selected.push({removeFromParent() { detached++; }, traverse(free) {
    free({geometry:{dispose() { geometries++; }},material:{dispose() { materials++; }}});
  }});
  api.setAssembled(false);
  assert.equal(s.selected.length, 0);
  assert.equal(s.state.selected, s.selected);
  assert.equal(detached, 1);
  assert.equal(geometries, 1);
  assert.equal(materials, 1);
  api.setAssembled(true);
  assert.equal(s.selected.length, 0);
  assert.equal(s.assembled, true);
});


test('BR02 GPU release force-loses each retired renderer before disposal', () => {
  const window = {}, module = {exports:{}};
  runInNewContext(readFileSync(new URL('./review3d.js', import.meta.url), 'utf8'), {
    window, module, document:{createElement:()=>({}), head:{appendChild(){}}}
  });
  let live = 0;
  for (let i=0;i<20;i++) {
    live++;
    const order=[];
    module.exports.releaseGpu({roots:[],views:[],environments:new Map(),renderer:{
      forceContextLoss(){live--;order.push('lose');}, dispose(){order.push('dispose');}
    }});
    assert.deepEqual(order,['lose','dispose']);
    assert.equal(live,0);
  }
});


test('BR02 hover raycasts coalesce to the latest event and cancel on teardown', () => {
  const listeners = {}, frames = new Map(), controller = new AbortController();
  const window = {hovers:[]}, owner = {abort:controller};
  let id=0;
  const source=readFileSync(new URL('./review3d.js',import.meta.url),'utf8')
    .replace('let active = null, bundle;', 'let active = window.owner, bundle;')
    .replace('function hover(v,e) {', 'function hover(v,e) { window.hovers.push(e); return;')
    .replace('const testSeam = {', 'const testSeam = {installPartInput,');
  window.owner=owner;
  runInNewContext(source,{window,document:{createElement:()=>({}),head:{appendChild(){}}},
    requestAnimationFrame:fn=>{frames.set(++id,fn);return id;},cancelAnimationFrame:id=>frames.delete(id)});
  window.Review3D.testSeam.installPartInput({host:{addEventListener:(name,fn)=>listeners[name]=fn}});
  for(let x=0;x<30;x++)listeners.pointermove({clientX:x,buttons:0});
  assert.equal(frames.size,1);assert.equal(window.hovers.length,0);
  [...frames.values()][0]();frames.clear();
  assert.equal(window.hovers.length,1);assert.equal(window.hovers[0].clientX,29);
  listeners.pointermove({clientX:30,buttons:0});
  listeners.pointerdown({button:0,clientX:30,clientY:0,pointerId:1});
  assert.equal(frames.size,0,'queued hover must not erase a subsequent click tooltip');
  listeners.pointermove({clientX:31,buttons:0});controller.abort();owner.dead=true;
  assert.equal(frames.size,0);assert.equal(window.hovers.length,1);
});


test('BR02 single renderer rejects a comparison fixture instead of skipping',async()=>{
  const {CHECKS}=await import('./checks.mjs');
  const expr=CHECKS.find(c=>c[0]==='BR02 single renderer head only')[2];
  const result=await runInNewContext(`(async()=>{${expr}})()`,{
    proj:()=>({board:{parts3d:{}}}),Review3D:{state:{}},REVIEW_DATA:{mode:'comparison'}
  });
  assert.equal(result,'fixture is not single mode');
});

test('BR02 3D view normalizes wipe mode to side in valid and select', () => {
  const reviewSource = readFileSync(new URL('./review.js', import.meta.url), 'utf8');
  const validFn = reviewSource.slice(reviewSource.indexOf('function valid(st) {'), reviewSource.indexOf('function applyState('));
  const selectFn = reviewSource.slice(reviewSource.indexOf('function select(view) {'), reviewSource.indexOf('function decodeState('));

  const validCtx = {
    D: { projects: [{ board: { layers: [], model3d: { head: 'head-id' } }, sheets: [], changes: [], checks: [] }] },
    boardAvailable: () => true,
    modelAvailable: () => true,
    MODES: { side: true, overlay: true, wipe: true, blend: true, semantic: true },
    GROUPS3D: [],
    LIGHT_RIGS3D: [],
    window: { ThreeStudio: { normalizeLighting: x => x } }
  };
  runInNewContext(validFn, validCtx);
  const normalized = validCtx.valid({ v: '3d', m: 'wipe' });
  assert.equal(normalized.v, '3d');
  assert.equal(normalized.m, 'side');

  const S = { v: 'board', m: 'wipe' };
  const selectCtx = {
    S,
    clearImageSelection: () => {},
    renderInspector: () => {},
    tabsChange: () => false,
    stopPlacing: () => {},
    renderModes: () => {},
    renderNav: () => {},
    renderPanel: () => {},
    renderZoombar: () => {},
    draw: () => {},
    saveHash: () => {}
  };
  runInNewContext(selectFn, selectCtx);
  selectCtx.select('3d');
  assert.equal(S.v, '3d');
  assert.equal(S.m, 'side');
});

class V3 {
  constructor(x=0,y=0,z=0){this.x=x;this.y=y;this.z=z;}
  clone(){return new V3(this.x,this.y,this.z);} copy(v){this.x=v.x;this.y=v.y;this.z=v.z;return this;}
  sub(v){this.x-=v.x;this.y-=v.y;this.z-=v.z;return this;}
  normalize(){const l=Math.hypot(this.x,this.y,this.z)||1;this.x/=l;this.y/=l;this.z/=l;return this;}
  addScaledVector(v,s){this.x+=v.x*s;this.y+=v.y*s;this.z+=v.z*s;return this;}
  lerpVectors(a,b,t){this.x=a.x+(b.x-a.x)*t;this.y=a.y+(b.y-a.y)*t;this.z=a.z+(b.z-a.z)*t;return this;}
}
function cameraHarness(reducedMotion) {
  const window = {THREE3D:{THREE:{MathUtils:{degToRad:d=>d*Math.PI/180}}}};
  const source = readFileSync(new URL('./review3d.js', import.meta.url), 'utf8')
    .replace('let active = null, bundle;', 'let active = null, bundle; window.setTestSession = s => active = s;')
    .replace('const testSeam = {', 'const testSeam = {setCamera,');
  runInNewContext(source, {window, document:{createElement:() => ({}), head:{appendChild() {}}}, performance, matchMedia:() => ({matches:reducedMotion})});
  const frames = [], ends = [];
  const s = {dead:false, animationFrames:{add:fn => frames.push(fn)}, invalidate() {}};
  window.setTestSession(s);
  window.Review3D.onCameraEnd = () => ends.push(window.Review3D.testSeam);
  const v = {camera:{position:new V3(0,0,1), fov:45, aspect:1, near:1, far:2, updateProjectionMatrix() {}}, controls:{target:new V3(), update() {}}};
  return {setCamera:window.Review3D.testSeam.setCamera, v, frames, ends};
}

test('U5: animated 3D focus sets near/far for the destination before animating and reports the final camera', () => {
  const {setCamera, v, frames, ends} = cameraHarness(false);
  setCamera(v, new V3(), .001, true);
  const distance = .02;   // the minimum focus distance for a tiny part
  assert.ok(Math.abs(v.camera.near - distance / 100) < 1e-12, `near ${v.camera.near} would clip the focused part`);
  assert.ok(Math.abs(v.camera.far - distance * 100) < 1e-12);
  assert.equal(frames.length, 1); assert.equal(ends.length, 0);
  frames[0](performance.now() + 1000);
  assert.ok(Math.abs(v.camera.position.z - distance) < 1e-12);
  assert.equal(ends.length, 1, 'the URL must record the post-focus camera');
});

test('U5: an immediate 3D focus also reports the final camera once', () => {
  const {setCamera, v, frames, ends} = cameraHarness(true);
  setCamera(v, new V3(), .001, true);
  assert.equal(frames.length, 0); assert.equal(ends.length, 1);
  assert.ok(Math.abs(v.camera.near - .0002) < 1e-12);
});

test('U5: Review3D.clearSelection drops the outline and tooltips without a new session', () => {
  const {api, s} = viewer();
  let detached = 0, tips = 0;
  s.selected.push({removeFromParent() { detached++; }, traverse(free) { free({}); }});
  s.state.selected = s.selected; s.invalidate = () => {};
  s.views[0].host.querySelector = () => ({remove() { tips++; }});
  assert.equal(typeof api.clearSelection, 'function');
  api.clearSelection();
  assert.equal(detached, 1); assert.equal(tips, 1);
  assert.equal(s.selected.length, 0); assert.equal(s.state.selected, s.selected);
});

function escapeHarness(S, selected = []) {
  const source = readFileSync(new URL('./review.js', import.meta.url), 'utf8');
  const from = source.indexOf('document.addEventListener("keydown", e => {\n  if (e.key === "Escape" && $("#shortcuts").open)');
  const handler = source.slice(from, source.indexOf('\nfunction positionLink(', from));
  const calls = [];
  let listener;
  const ctx = {S, THREADS_ON:false, $:() => ({open:false}), boardKey:() => false,
    document:{addEventListener:(_, fn) => listener = fn},
    stopPlacing:() => calls.push('stopPlacing'), markSelected:() => { S.part3d = null; calls.push('markSelected'); },
    draw:() => calls.push('draw'), saveHash:() => calls.push('saveHash'),
    window:{Review3D:{state:{selected}, clearSelection:() => calls.push('clearSelection')}}};
  runInNewContext(handler, ctx);
  listener({key:'Escape', target:{closest:() => null}, preventDefault() {}, ctrlKey:false, metaKey:false, altKey:false, shiftKey:false});
  return calls;
}

test('U5: Escape in 3D with nothing selected does not rebuild the 3D session', () => {
  assert.deepEqual(escapeHarness({v:'3d', s:null, part3d:null, placing:false}), []);
});

test('U5: Escape in 3D clears a real selection without draw()', () => {
  for (const [S, selected] of [[{v:'3d', s:'c1', part3d:null}, [{}]], [{v:'3d', s:null, part3d:{ref:'R1'}}, [{}]]]) {
    const calls = escapeHarness(S, selected);
    assert.ok(!calls.includes('draw'), calls.join());
    assert.ok(calls.includes('clearSelection') && calls.includes('saveHash'), calls.join());
    assert.equal(S.s, null); assert.equal(S.part3d, null);
  }
  assert.ok(escapeHarness({v:'board', s:'c1'}).includes('draw'), '2D Escape keeps its redraw');
});

class Node3 {
  constructor(name, parent) { this.name=name; this.children=[]; this.userData={}; this.visible=true; this.parent=null; if(parent)parent.add(this); }
  add(c) { c.parent=this; this.children.push(c); return this; }
  getObjectByName(n) { if(this.name===n)return this; for(const c of this.children){const r=c.getObjectByName(n);if(r)return r;} }
  traverse(fn) { fn(this); this.children.forEach(c=>c.traverse(fn)); }
}
function fallbackHarness() {
  const window = {outlined:[]}, picks = [];
  const source = readFileSync(new URL('./review3d.js', import.meta.url), 'utf8')
    .replace('let active = null, bundle;', 'let active = null, bundle; window.setTestSession = s => active = s;')
    .replace('function outline(scene, node, colour) {', 'function outline(scene, node, colour) { window.outlined.push(node); return {node}; ')
    .replace('const testSeam = {', 'const testSeam = {pick,');
  const sceneBase = new Node3('scene-base'), sceneHead = new Node3('scene-head');
  const base = new Node3('base', sceneBase), head = new Node3('head', sceneHead);
  const j1 = new Node3('J1', base), mesh = new Node3('', j1); new Node3('J12', head);
  window.THREE3D = {THREE:{Raycaster:class { setFromCamera() {} intersectObjects(roots) { return roots.includes(base) ? [{object:mesh}] : []; } }, Vector2:class {},
    Box3:class { setFromObject() { return this; } getCenter(v) { return v; } getBoundingSphere(s) { return s; } }, Vector3:class {}, Sphere:class { radius=1; }}};
  runInNewContext(readFileSync(new URL('./three-parts.js', import.meta.url), 'utf8'), {window});
  runInNewContext(source, {window, THREE3D:window.THREE3D, ThreeParts:window.ThreeParts, document:{createElement:() => ({}), head:{appendChild() {}}, documentElement:{}},
    getComputedStyle:() => ({getPropertyValue:() => ''}), clearTimeout});
  const change = {id:'c1', action:'modified', ref:'J12', uuid:'u', changes:[['reference','J1','J12']]};
  const host = {getBoundingClientRect:() => ({left:0, top:0, width:1, height:1}), querySelector:() => null};
  const views = [{side:'base', scene:sceneBase, host, visible:true}, {side:'head', scene:sceneHead, host, visible:true}];
  const s = {roots:[base, head], allowedSides:['base','head'], indexedSides:new Set(), changes:[change], views, selected:[], groups:[],
    hiddenGroups:new Set(), assembled:true, mode:'side', invalidate() {},
    state:{visibleSides:['base','head'], parts:{base:[], head:[]}, blocks:[], ghosts:[], highlights:[], selected:[]}};
  window.setTestSession(s); window.Review3D.state = s.state;
  window.Review3D.onPick = id => picks.push(id);
  return {api:window.Review3D, views, picks, window, s, change, j1};
}

test('U6: fallback picking finds a renamed footprint in base by its base reference', () => {
  const {api, views, picks} = fallbackHarness();
  api.testSeam.pick(views[0], {clientX:0, clientY:0});
  assert.deepEqual(picks, ['c1'], 'clicking J1 in base must select the J1 -> J12 change');
});

test('U6: fallback focus outlines the renamed footprint in the base view too', () => {
  const {api, window, change, j1, s} = fallbackHarness();
  api.focus(change, false);
  assert.ok(window.outlined.includes(j1), 'base view must outline J1');
  assert.ok(s.selected.some(l => l.side === 'base'), 'the base outline is attributed to the base revision');
});
