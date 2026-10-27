import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url), P=require('./compress3d.cjs');
test('BR02 mask finish and pair-safe cache policy',()=>{
  for(const rgb of [[.7,.02,.01],[.01,.02,.8],[0,0,0],[1,1,1]])
    assert.deepEqual(P.maskRGB(rgb),rgb);
  assert.deepEqual(P.maskRGB([.08,.2,.14]),[.011,.1,.036]);
  assert.deepEqual(P.maskRGB([.0627,.16,.1129]),[.011,.1,.036]);
  assert.deepEqual(P.padStyle('ENEPIG').color,[1,.78,.34,1]);
  assert.deepEqual(P.padStyle('HASL').color,[.5,.5,.5,1]);
  const m={keep:['R12','U3'],finish:'ENIG',footprints:[]};
  const key=P.processorKey(Buffer.from('raw'),m,Buffer.from('v1'));
  assert.equal(key,P.processorKey(Buffer.from('raw'),{...m,keep:['U3','R12']},Buffer.from('v1')));
  for(const changed of [{...m,keep:['R12']},{...m,finish:'HASL'}])
    assert.notEqual(key,P.processorKey(Buffer.from('raw'),changed,Buffer.from('v1')));
  assert.notEqual(key,P.processorKey(Buffer.from('raw'),m,Buffer.from('v2')));
});
