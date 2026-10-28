import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

// Exercise the production helper without adding a public test-only viewer API.
function cache() {
  const window = {};
  const document = {createElement: () => ({}), head: {appendChild() {}}};
  const module = {exports:{}};
  const source = readFileSync(new URL('./review3d.js', import.meta.url), 'utf8');
  runInNewContext(source, {window, document, DOMException, module});
  assert.equal('parseByDigest' in window.Review3D, false, 'cache helper stays out of the browser API');
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
