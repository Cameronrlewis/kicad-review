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

test('U6: without a part-index UUID match the base reference comes from the Reference change tuple', () => {
  const w={};runInNewContext(readFileSync(new URL('./three-parts.js',import.meta.url),'utf8'),{window:w});
  const renamed={uuid:'u',ref:'J12',action:'modified',changes:[['position','(1, 1)','(2, 1)'],['reference','J1','J12']]};
  assert.equal(w.ThreeParts.revisionRef(renamed,'base'),'J1');
  assert.equal(w.ThreeParts.revisionRef(renamed,'head'),'J12');
  assert.equal(w.ThreeParts.revisionRef({ref:'R3',changes:[['value','1k','2k']]},'base'),'R3');
  assert.equal(w.ThreeParts.revisionRef({ref:'R4',action:'removed'},'base'),'R4');
  // Highlighting and ghost creation resolve through reference(); an old report has no part rows.
  assert.equal(w.ThreeParts.reference(renamed,'base',[]),'J1');
  assert.equal(w.ThreeParts.reference(renamed,'head',[]),'J12');
});
