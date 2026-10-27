import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const ctx = {console,setTimeout,clearTimeout,TextEncoder}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(new URL('./image-view.js', import.meta.url), 'utf8'), ctx);
test('only final appearance survives navigation; all URLs released', async () => {
  const jobs=[], revoked=[], made=[];
  const env={create:text=>{made.push(text);return 'blob:'+made.length;}, revoke:u=>revoked.push(u),
    make:()=>{const n={dataset:{},remove(){this.removed=true;},replaceWith(other){this.replaced=other;}};
      n.decode=()=>new Promise(resolve=>jobs.push(resolve)); return n;}};
  const c=ctx.ImageView.controller('<svg><path fill="#009600"/></svg>',{side:'head',layer:'sheet'},env);
  const first=c.setAppearance(new Map([['#009600','#111111']]));
  const second=c.setAppearance(new Map([['#009600','#222222']]));
  jobs[1](); assert.equal(await second,true);
  const current=c.node; jobs[0](); assert.equal(await first,false);
  assert.equal(c.node,current); assert.ok(c.appliedSource.includes('#222222'));
  const third=c.setAppearance(new Map([['#009600','#333333']]));
  c.dispose(); jobs[2](); assert.equal(await third,false);
  assert.equal(c.node,null); assert.equal(new Set(revoked).size,made.length);
  assert.equal(c.source,'<svg><path fill="#009600"/></svg>');
});

function harness() {
  const jobs=[], revoked=[], made=[], nodes=[];
  const env={
    create(text){made.push(text);return 'blob:'+made.length;},
    revoke(url){revoked.push(url);},
    make(){
      const n={dataset:{},isConnected:false,
        remove(){this.removed=true;},replaceWith(other){this.replaced=other;}};
      n.decode=()=>new Promise((resolve,reject)=>jobs.push({resolve,reject}));
      nodes.push(n);return n;
    }
  };
  const c=ctx.ImageView.controller('<svg fill="#009600"/>',{side:'base',layer:'F.Cu'},env);
  return {c,jobs,revoked,made,nodes};
}

test('replace only exact palette fill and stroke paints, without cascading', () => {
  const source=`<svg fill="#009600" stroke='#ABCDEF' style="fill: #009600 !important;stroke:#abcdef">
    <path fill="none" stroke="#123456" data-color="#009600" id="#009600"/>
    <path fill="#009600ff" stroke="#096"/><!-- #009600 -->
  </svg>`;
  const paints=new Map([['#009600','#abcdef'],['#abcdef','#111111']]);
  assert.equal(ctx.ImageView.replacePaints(source,paints), source
    .replace('fill="#009600"','fill="#abcdef"')
    .replace("stroke='#ABCDEF'","stroke='#111111'")
    .replace('fill: #009600','fill: #abcdef')
    .replace('stroke:#abcdef','stroke:#111111'));
  assert.equal(ctx.ImageView.replacePaints(source,new Map()),source);
});

test('keep current image until successful decode, then replace and release it', async () => {
  const {c,jobs,revoked,nodes}=harness();
  assert.equal(c.node,null);assert.equal(c.appliedSource,null);assert.equal(c.generation,0);
  const first=c.setAppearance(new Map()); jobs[0].resolve();assert.equal(await first,true);
  const previous=c.node;previous.isConnected=true;
  assert.equal(previous.decoding,'async');assert.equal(previous.draggable,false);
  assert.equal(previous.alt,'base F.Cu');assert.equal(previous.dataset.side,'base');
  assert.equal(previous.dataset.imageArtwork,'');assert.equal(previous.src,'blob:1');
  const second=c.setAppearance(new Map([['#009600','#222222']]));
  assert.equal(c.node,previous);assert.deepEqual(revoked,[]);
  jobs[1].resolve();assert.equal(await second,true);
  assert.equal(previous.replaced,nodes[1]);assert.equal(c.node,nodes[1]);
  assert.deepEqual(revoked,['blob:1']);assert.equal(c.generation,2);
  c.dispose();c.dispose();assert.deepEqual(revoked,['blob:1','blob:2']);
  assert.equal(await c.setAppearance(new Map()),false);assert.equal(nodes.length,2);
});

test('failed replacement preserves decoded artwork and allows retry from original source', async () => {
  const {c,jobs,revoked,made}=harness();
  const first=c.setAppearance(new Map([['#009600','#111111']]));
  jobs[0].resolve();await first;const previous=c.node, applied=c.appliedSource;
  const second=c.setAppearance(new Map([['#009600','#222222']]));
  const failure=new Error('decode failed');
  const rejected=assert.rejects(second,error=>error===failure);
  jobs[1].reject(failure);await rejected;
  assert.equal(c.node,previous);assert.equal(c.appliedSource,applied);
  assert.deepEqual(revoked,['blob:2']);
  const third=c.setAppearance(new Map([['#009600','#333333']]));
  jobs[2].resolve();assert.equal(await third,true);
  assert.equal(made[2],'<svg fill="#333333"/>');assert.equal(previous.removed,true);
  assert.equal(c.source,'<svg fill="#009600"/>');
  assert.throws(()=>{c.source='changed';},TypeError);c.dispose();
  assert.equal(revoked.length,3);assert.equal(new Set(revoked).size,3);
});

test('resource setup failure releases the allocated URL', async () => {
  const revoked=[], failure=new Error('cannot create image');
  const c=ctx.ImageView.controller('<svg/>',{side:'head',layer:'sheet'},{
    create:()=> 'blob:setup', revoke:url=>revoked.push(url), make(){throw failure;}
  });
  await assert.rejects(c.setAppearance(new Map()),error=>error===failure);
  assert.equal(c.node,null);assert.equal(c.appliedSource,null);
  assert.deepEqual(revoked,['blob:setup']);c.dispose();
  assert.deepEqual(revoked,['blob:setup']);
});

test('stale and disposed decode failures return false and never release URLs twice', async () => {
  const {c,jobs,revoked}=harness();
  const first=c.setAppearance(new Map()), second=c.setAppearance(new Map());
  jobs[0].reject(new Error('stale'));assert.equal(await first,false);
  c.dispose();jobs[1].reject(new Error('disposed'));assert.equal(await second,false);
  assert.equal(c.node,null);assert.deepEqual(revoked,['blob:1','blob:2']);
  assert.equal(c.generation,3);
});
