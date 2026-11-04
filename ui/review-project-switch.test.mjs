import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// Exercise the real review.js navigation functions without booting the report UI.
const source = readFileSync(new URL('./review.js', import.meta.url), 'utf8');
const slice = (from, to) => { const a = source.indexOf(from), b = source.indexOf(to, a); assert.ok(a >= 0 && b > a, from); return source.slice(a, b); };
const viewerIdFn = source.includes('function viewerIdFor(') ? slice('function viewerIdFor(', '\n') + '\n' : '';

function harness() {
  const D = {repo: 'r', projects: [
    {dir: 'p0', board: {layers: [{name: 'F_Cu'}]}, sheets: [], changes: [], checks: []},
    {dir: 'p1', board: {layers: [{name: 'F_Cu'}]}, sheets: [], changes: [], checks: []}]};
  const id = i => JSON.stringify([D.repo, D.projects[i].dir]);
  const log = [];
  let current = id(0);
  const Appearance = {
    configure(_layers, viewerId) { current = viewerId; },
    patch(p) { log.push(['patch', current, p]); },
  };
  const S = {p: 0, v: 'board', m: 'side', t: 'changes'};
  const ctx = vm.createContext({
    D, S, Appearance, location: {pathname: '/x'}, leftTab: 'project', leftCollapsed: false,
    window: {ThreeStudio: {normalizeLighting: x => x, PRESETS: {bench: {}}}},
    proj: () => D.projects[S.p], canon: n => n.replace('_', '.'),
    valid: st => ({p: st.p, v: st.v, layers: st.layers, revision: 'head'}),
    firstChangedView: () => 'board', clearImageSelection() {},
    renderModes() {}, renderPanel() {}, renderInspector() {}, renderZoombar() {},
    renderNav: () => log.push(['renderNav', current]),
    select: () => log.push(['select', current]),
    draw: () => { log.push(['draw', current]); return Promise.resolve(); }, goTo() {},
  });
  vm.runInContext(viewerIdFn + slice('function openProject(', '\n') + '\n' + slice('function applyState(', '\nconst PX'), ctx);
  return {ctx, log, id};
}

test('U2: a link to another project patches that project\'s Appearance store, before any dock render', async () => {
  const {ctx, log, id} = harness();
  await ctx.applyState({p: 1, v: 'board', layers: ['F_Cu']});
  const patch = log.find(e => e[0] === 'patch');
  assert.ok(patch, 'l= patches layer visibility');
  assert.equal(patch[1], id(1), 'l= must reach Project 1, not leak into Project 0');
  for (const e of log) assert.equal(e[1], id(1), `${e[0]} ran against the previous project's store`);
});

test('U2: openProject binds the new project\'s store before mounting the dock', () => {
  const {ctx, log, id} = harness();
  ctx.openProject(1);
  assert.deepEqual(log[0], ['select', id(1)]);
});

const ctxSource = slice('function appearanceCtx()', '\nfunction mountAppearance(');
function appearanceCtx(S, boardView) {
  const scene = {layers: [{name: 'F.Cu', enabled: true}, {name: 'In1.Cu', enabled: true}], nets: [{name: 'GND'}]};
  boardView.scenes ??= [scene, scene];
  const c = vm.createContext({S, boardView, HIDE_LAYERS: /^$/, canon: n => n.replace('_', '.'), layerLabel: n => n,
    proj: () => ({board: {layers: [{name: 'F_Cu'}]}}),
    Appearance: {get: () => ({layers: {'F.Cu': {visible: true}, 'In1.Cu': {visible: true}}})}});
  vm.runInContext(ctxSource + '\nglobalThis.out = appearanceCtx();', c);
  return c.out;
}

test('U2: the Appearance dock offers no WebGL layer or net controls outside the bound board view', () => {
  const board = appearanceCtx({p: 0, v: 'board', m: 'side'}, {project: 0, useGL: true});
  assert.equal(board.fallback, false); assert.deepEqual([...board.nets], ['GND']);
  assert.deepEqual([...board.layers.map(l => l.name)], ['F.Cu', 'In1.Cu']);
  for (const [S, bv] of [[{p: 0, v: '3d', m: 'side'}, {project: 0, useGL: true}], [{p: 1, v: 'board', m: 'side'}, {project: 0, useGL: true}]]) {
    const out = appearanceCtx(S, bv);
    assert.equal(out.fallback, true, JSON.stringify(S)); assert.deepEqual([...out.nets], []);
    assert.deepEqual([...out.layers.map(l => l.name)], ['F.Cu'], 'only the report\'s SVG layers remain');
  }
});

test('U2: entering 3D clears the board scenes and WebGL flag and refreshes the dock', async () => {
  const boardView = {scenes: [{}], useGL: true, project: 0, failed: null};
  const calls = [];
  const el = () => ({dataset: {}, setAttribute() {}, replaceWith() {}});
  const stage = el();
  const c = vm.createContext({
    S: {p: 0, v: '3d', m: 'side'}, D: {projects: [{dir: 'p0'}]}, boardView, location: {pathname: '/x'},
    activeBoardGate: null, $: () => stage, disposeAssets() {}, Appearance: {configure() {}},
    schematicResize: {disconnect() {}}, resetCoordinates() {}, currentView: () => null, proj: () => ({dir: 'p0'}),
    imageSearchState: {context: '0:3d'}, document: {createElement: el}, boardMountState: null, statusText() {},
    renderImageSearch() {}, disposeBoardRenderers: () => calls.push('dispose'), appearanceSchematics: {clear() {}},
    releaseImageStage() {}, refreshAppearance: () => calls.push(['refresh', boardView.scenes, boardView.useGL]),
    window: {REVIEW_DATA: {mode: 'comparison'}, Review3D: {show: async () => calls.push('show')}},
  });
  vm.runInContext(viewerIdFn + slice('let gen = 0;', '\nfunction noChangeNotice('), c);
  await c.draw();
  assert.equal(boardView.scenes, null); assert.equal(boardView.useGL, false);
  assert.ok(calls.some(x => Array.isArray(x) && x[0] === 'refresh' && x[1] === null && x[2] === false), JSON.stringify(calls));
});
