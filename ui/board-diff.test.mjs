import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const context = vm.createContext({window: {}, console});
vm.runInContext(readFileSync(new URL('./board-diff.js', import.meta.url), 'utf8'), context);
const B = context.window.BoardDiff;
test('aggregate identities never collapse to reference alone', () => {
  const actions = B.actionMap([{id:'c1',action:'modified'}, {id:'c2',action:'removed'}]);
  assert.equal(B.actionFor({changeIds:['c1'],ref:'R1'},actions), 'modified');
  assert.equal(B.actionFor({changeIds:[],ref:'R1'},actions), null);
  assert.equal(B.pickFromHits([{changeIds:['c1']},{changeIds:['c2']}], 'c1').id, 'c2');
  assert.equal(B.pickFromHits([{changeIds:[]}], null), null);
});
test('wipe endpoints and one-sided scenes route to visible revisions', () => {
  const both = {base:{},head:{}};
  for (const [fraction,wipe,side] of [[.2,.5,'base'],[.8,.5,'head'],[0,0,'head'],[1,1,'base'],[.5,.5,'head']])
    assert.equal(B.sidesAt('wipe',fraction,wipe,.5,both).join(','),side);
  assert.equal(B.sidesAt('blend',.5,.5,0,both).join(','),'base');
  assert.equal(B.sidesAt('blend',.5,.5,1,both).join(','),'head');
  assert.equal(B.sidesAt('overlay',.5,.5,.5,{base:null,head:{}}).join(','),'head');
  assert.equal(B.sidesAt('overlay',.5,.5,.5,both).join(','),'head,base');
  assert.equal(B.sidesAt('wipe',.2,.5,.5,{base:null,head:{}}).join(','),'');
});
test('cycling preserves hit order and deduplicates aggregate child identities', () => {
  const first = {changeIds:['c1','c2']}, second = {changeIds:['c1','c3']};
  const hits = [first,second];
  assert.equal(B.pickFromHits(hits,null).object,first);
  assert.equal(B.pickFromHits(hits,'c1').id,'c2');
  assert.equal(B.pickFromHits(hits,'c2').id,'c3');
  assert.equal(B.pickFromHits(hits,'c3').id,'c1');
  assert.equal(B.pickFromHits(hits,'unknown').id,'c1');
  assert.equal(B.pickFromHits([],null),null);
  assert.equal(B.actionFor({changeIds:['missing','c1']},B.actionMap([{id:'c1',action:'added'}])),'added');
});

test('mode weights preserve changes and exact clips', () => {
  assert.equal(B.weights('semantic','head',null,.5),.2);
  assert.equal(B.weights('semantic','head','added',.5),1);
  assert.equal(B.weights('blend','head','added',0),0);
  assert.equal(B.weights('blend','head','added',1),1);
  assert.equal(B.weights('blend','base',null,0),1);
  for (const dpr of [1,2]) for (const wipe of [0,.333,.5,1]) {
    const r=B.clipRects(801*dpr,400*dpr,wipe);
    assert.equal(r.base[2]+r.head[2],801*dpr);
    assert.equal(r.base[2],r.head[0]);
    assert.equal(r.head[0]+r.head[2],801*dpr);
  }
});
