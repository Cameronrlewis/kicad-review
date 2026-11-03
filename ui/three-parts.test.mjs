import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const window={};
test('BR02 rejects corrupt and duplicate world indexes without repairing identity',()=>{
  runInNewContext(readFileSync(new URL('./three-parts.js',import.meta.url),'utf8'),{window});
  const p={uuid:'u',ref:'J1',side:'bottom',box:[0,0,0,1,2,3],hasModel:true,reason:null};
  assert.equal(window.ThreeParts.validate([p])[0].ref,'J1');
  for(const bad of [null,{},[p,p],[{...p,box:[0,0,0,-1,1,1]}],
    [{...p,box:[0,0,0,NaN,1,1]}],[{...p,side:'base'}],
    [{...p,hasModel:'yes'}],[{...p,uuid:''}]])
    assert.throws(()=>window.ThreeParts.validate(bad),/Invalid 3D part index/);
  assert.deepEqual(p.box,[0,0,0,1,2,3]);
  const renamed={uuid:'u',ref:'J12'};
  assert.equal(window.ThreeParts.reference(renamed,'base',[p]),'J1');
  assert.equal(window.ThreeParts.reference(renamed,'head',[{...p,ref:'J12'}]),'J12');
  assert.equal(window.ThreeParts.reference({uuid:'new',uuid_before:'u',ref:'J12'},'base',[p]),'J1');
});
