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
