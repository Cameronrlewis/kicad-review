import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const ctx = {console,setTimeout,clearTimeout,TextEncoder}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(new URL('./image-view.js', import.meta.url), 'utf8'), ctx);
test('only final appearance survives navigation; all URLs released', async () => {
  const jobs=[], revoked=[], made=[], nodes=[];
  const env={create:text=>{made.push(text);return 'blob:'+made.length;}, revoke:u=>revoked.push(u),
    make:()=>{const n={dataset:{},remove(){this.removed=true;},removeAttribute(name){if(name==='src')this.src='';},replaceWith(other){this.replaced=other;}}; nodes.push(n);
      n.decode=()=>new Promise(resolve=>jobs.push(resolve)); return n;}};
  const c=ctx.ImageView.controller('<svg><path fill="#009600"/></svg>',{side:'head',layer:'sheet'},env);
  const first=c.setAppearance(new Map([['#009600','#111111']]));
  const second=c.setAppearance(new Map([['#009600','#222222']]));
  jobs[1](); assert.equal(await second,true);
  const current=c.node; jobs[0](); assert.equal(await first,false);
  assert.equal(nodes[0].src,'');
  assert.equal(made.length,2);
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
        remove(){this.removed=true;},replaceWith(other){this.replaced=other;},
        removeAttribute(name){if(name==='src')this.src='';}};
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

const primitive=(shape,size,angle=0)=>({shape,size,angle,center:[0,0]});
const graph=(pads=[],vias=[],tracks=[])=>({pads,vias,tracks});
const copper=(uuid,geometry,layers=['In1.Cu'])=>({uuid,layers,geometry});
const hit=(g,p,l=['In1.Cu'],touch=false,scale=10)=>
  ctx.ImageView.inspectHit(g,p,new Set(l),scale,touch);

test('exact rotated/custom pads, blind via and touch reach',()=>{
  const small={uuid:'small',layers:['In1.Cu'],net:'12',width:1,height:2,
    geometry:{primitive:primitive('rect',[1000,2000],90000)}};
  const large={...small,uuid:'large',width:4,height:4,
    geometry:{primitive:primitive('rect',[4000,4000])}};
  const custom={...small,uuid:'custom',width:4,height:4,geometry:{
    rings:[[[-2000,-2000],[2000,-2000],[0,2000]]],
    drill:{center:[0,0],size:[500,500],angle:0,plated:true}}};
  const via={uuid:'blind',layers:['F.Cu','In1.Cu'],geometry:{primitive:primitive('circle',[1000,1000])}};
  const track={uuid:'arc-piece',layers:['In1.Cu'],net:'12',geometry:{segments:[[4000,0,5000,0,200]]}};
  const g={pads:[large,small],vias:[via],tracks:[track]};
  assert.equal(hit(g,[.8,0]).uuid,'small');assert.equal(hit(g,[.8,0]).net,'12');
  assert.equal(hit(graph([custom]),[0,0]),null);
  assert.equal(hit(graph([],[via]),[0,0],['In2.Cu']),null);
  assert.equal(hit(graph([],[],[track]),[4.5,1.3],['In1.Cu'],true).uuid,'arc-piece');
  assert.equal(hit(graph([],[],[track]),[4.5,1.301],['In1.Cu'],true),null);
  assert.equal(hit(g,[0,0],[]),null);
});

const producer=JSON.parse(fs.readFileSync(new URL('./fixtures/image-pick-records.json',import.meta.url),'utf8'));
const byPin=Object.fromEntries(producer.pads.map(p=>[p.pin,p]));
const hitPad=(pad,p)=>hit(graph([pad]),p,['F.Cu'],false,100);
test('producer copper override must not replace copper',()=>{
  assert.equal(hitPad(byPin['1'],[10,10])?.pin,'1');
  assert.equal(hitPad(byPin['1'],[11.36,10]),null,'mask margin is not copper');
});
for(const [pin,label] of [['2','round'],['3','slotted']]){
  test('producer '+label+' drill excludes copper',()=>{
    assert.equal(hitPad(byPin[pin],[Number(pin)*10,10]),null);
    assert.equal(hitPad(byPin[pin],[Number(pin)*10+.5,10])?.pin,pin);
  });
}
for(const [pin,label] of [['4','line'],['5','arc'],['6','outlined polygon']]){
  test('producer custom stroked '+label+' extends beyond anchor',()=>{
    const pad=byPin[pin],anchor=pad.geometry.primitive.center;
    const seg=pad.geometry.segments.find(s=>Math.hypot((s[0]+s[2])/2-anchor[0],(s[1]+s[3])/2-anchor[1])>2000);
    assert.ok(seg,'custom primitive extends beyond anchor '+pin);
    assert.equal(hitPad(pad,[(seg[0]+seg[2])/2000,(seg[1]+seg[3])/2000])?.pin,pin);
  });
}

test('geometry helpers return signed micrometre boundary distances',()=>{
  const {segmentDistance,polygonDistance,primitiveDistance}=ctx.ImageView;
  assert.equal(segmentDistance([5,3],[0,0],[10,0]),3);
  assert.equal(segmentDistance([13,4],[0,0],[10,0]),5);
  assert.equal(segmentDistance([3,4],[0,0],[0,0]),5);
  const ring=[[-1000,-1000],[1000,-1000],[1000,1000],[-1000,1000]];
  assert.equal(polygonDistance([0,0],ring),-1000);
  assert.equal(polygonDistance([1300,1400],ring),500);
  assert.equal(Math.abs(polygonDistance([1000,0],ring)),0);
  assert.equal(primitiveDistance([0,0],null),Infinity);
  assert.equal(primitiveDistance([0,0],primitive('unknown',[2000,2000])),Infinity);
  assert.equal(primitiveDistance([0,0],primitive('circle',[2000,2000])),-1000);
  assert.equal(primitiveDistance([1500,0],primitive('circle',[2000,2000])),500);
  assert.equal(primitiveDistance([1300,1400],primitive('rect',[2000,2000])),500);
  assert.equal(primitiveDistance([0,0],primitive('oval',[4000,2000])),-1000);
  assert.equal(primitiveDistance([1000,0],primitive('oval',[2000,4000])),0);
  const round={...primitive('roundrect',[2000,2000]),radius:500};
  assert.ok(Math.abs(primitiveDistance([1000,1000],round)-(Math.SQRT2-1)*500)<1e-9);
  assert.equal(primitiveDistance([0,0],{...round,radius:10000}),-1000,'radius clamps to half-size');
  const trap={...primitive('trapezoid',[2000,2000]),delta:[1000,0]};
  assert.equal(Math.abs(primitiveDistance([1000,1500],trap)),0);
  assert.ok(primitiveDistance([-900,900],trap)>0);
  // KiCad positive angles rotate counter-clockwise on a screen whose y points down.
  const rotated={...primitive('rect',[4000,1000],30000),center:[7000,8000]};
  assert.ok(Math.abs(primitiveDistance([7000+1500*Math.cos(Math.PI/6),7250],rotated)+500)<1e-9);
});

test('custom rings are unioned, and only explicit drill geometry removes copper',()=>{
  const pad=copper('union',{rings:[
    [[-2000,-2000],[2000,-2000],[2000,2000],[-2000,2000]],
    [[-500,-500],[500,-500],[500,500],[-500,500]]
  ]});
  assert.equal(hit(graph([pad]),[0,0]),pad,'nested ring is copper, not a hole');
  const drilled={...pad,geometry:{...pad.geometry,
    drill:{center:[0,0],size:[500,1500],angle:90000,plated:true}}};
  assert.equal(hit(graph([drilled]),[.6,0]),null,'rotated slotted drill');
  assert.equal(hit(graph([drilled]),[0,.6]),drilled);
});

test('only visible layer primitives and physical spans participate in picking',()=>{
  const pad=copper('per-layer',{primitive:primitive('rect',[4000,4000]),layerPrimitives:{
    'In1.Cu':primitive('rect',[1000,1000]),
    'F.Cu':primitive('rect',[4000,4000])
  }},['F.Cu','In1.Cu']);
  assert.equal(hit(graph([pad]),[1.5,0]),null);
  assert.equal(hit(graph([pad]),[1.5,0],['F.Cu']),pad);
  assert.equal(hit(graph([pad]),[1.5,0],['In2.Cu']),null);
  assert.equal(hit(graph([pad]),[1.5,0],['F.Cu','In1.Cu']),pad);
  const remoteRing={rings:[[[3000,-500],[4000,-500],[4000,500],[3000,500]]]};
  const custom=copper('custom',{...remoteRing,primitive:primitive('rect',[1000,1000])});
  assert.equal(hit(graph([custom]),[0,0]),custom,'custom anchor is also copper');
  assert.equal(hit(graph([custom]),[3.5,0]),custom,'disjoint custom ring is copper');
});

test('hidden pads, vias and tracks never beat visible copper',()=>{
  const visible=copper('visible',{primitive:primitive('rect',[2000,2000])});
  const hiddenPad={...copper('a-hidden-pad',{primitive:primitive('rect',[1000,1000])}),hidden:true};
  const hiddenVia={...copper('a-hidden-via',{primitive:primitive('circle',[1000,1000])}),hidden:true};
  const hiddenTrack={...copper('a-hidden-track',{segments:[[-1000,0,1000,0,1000]]}),hidden:true};
  const track=copper('visible-track',{segments:[[-1000,0,1000,0,200]]});
  assert.equal(hit(graph([hiddenPad,visible],[hiddenVia],[hiddenTrack]),[0,0]),visible);
  assert.equal(hit(graph([hiddenPad],[hiddenVia],[hiddenTrack,track]),[0,0]),track);
  assert.equal(hit(graph([hiddenPad],[hiddenVia],[hiddenTrack]),[0,0]),null);
});

test('exact copper precedes nearby targets; ties and nearest tracks are deterministic',()=>{
  const pad=copper('pad',{primitive:primitive('rect',[500,500])});
  const via=copper('via',{primitive:primitive('circle',[2000,2000])});
  const track=copper('track',{segments:[[-2000,0,2000,0,1000]]});
  assert.equal(hit(graph([pad],[via],[track]),[0,0]),pad);
  assert.equal(hit(graph([pad],[via],[track]),[.4,0]),via,'exact via beats nearby pad');
  assert.equal(hit(graph([pad],[],[track]),[.4,0]),track,'exact track beats nearby pad');
  assert.equal(hit(graph([pad],[via]),[1.1,0]),via);
  const equal={...pad,uuid:'a-pad'};
  assert.equal(hit(graph([pad,equal]),[0,0]),equal);
  const farther=copper('a-farther',{segments:[[-2000,400,2000,400,200]]});
  const nearer=copper('z-nearer',{segments:[[-2000,600,2000,600,200]]});
  assert.equal(hit(graph([],[],[farther,nearer]),[0,1]),nearer);
  assert.equal(hit(graph([],[],[nearer,{...nearer,uuid:'a-tie'}]),[0,1]).uuid,'a-tie');
});

test('reach uses CSS pixels with a 0.15 mm floor, and rejects invalid camera inputs',()=>{
  const track=copper('track',{segments:[[0,0,1000,0,200]]});
  const g=graph([],[],[track]);
  assert.equal(hit(g,[.5,.7]),track);
  assert.equal(hit(g,[.5,.701]),null);
  assert.equal(hit(g,[.5,.25],['In1.Cu'],false,1000),track);
  assert.equal(hit(g,[.5,.251],['In1.Cu'],true,1000),null);
  for(const scale of [0,-1,NaN,Infinity])assert.equal(hit(g,[0,0],['In1.Cu'],false,scale),null);
  for(const point of [[NaN,0],[0,Infinity],[],[0]])assert.equal(hit(g,point),null);
  assert.equal(hit(graph(),[0,0]),null);
});

test('paint replacement is exact and simultaneous', () => {
  const source = '<svg><path fill="#009600" stroke="#abcdef"/><path style="stroke:#840000;fill:none"/></svg>';
  const out = ctx.ImageView.replacePaints(source, new Map([['#009600','#840000'],['#840000','#123456']]));
  assert.ok(out.includes('fill="#840000" stroke="#abcdef"'));
  assert.ok(out.includes('stroke:#123456;fill:none'));
});

function mountHarness() {
  const jobs=[], made=[], revoked=[];
  ctx.Blob=class {constructor(parts){this.parts=parts;}};
  ctx.URL={createObjectURL(blob){made.push(blob.parts.join(''));return 'blob:'+made.length;},revokeObjectURL(url){revoked.push(url);}};
  ctx.document={createElement(tag){assert.equal(tag,'img');return {dataset:{},remove(){},removeAttribute(){},
    decode:()=>new Promise((resolve,reject)=>jobs.push({resolve,reject}))};}};
  return {jobs,made,revoked};
}
test('mount decodes before returning and disposeAll releases successful and pending mounts', async()=>{
  const {jobs,made,revoked}=mountHarness();
  let returned=false;
  const first=ctx.ImageView.mount('<svg/>',[10,10],{side:'head',layer:'sheet'}).then(c=>{returned=true;return c;});
  assert.equal(returned,false);assert.equal(jobs.length,1);
  jobs[0].resolve();const c=await first;
  assert.equal(c.source,'<svg/>');assert.equal(c.node.dataset.imageArtwork,'');
  const pending=ctx.ImageView.mount('<svg/>',[10,10],{side:'base',layer:'sheet'});
  ctx.ImageView.disposeAll();jobs[1].resolve();const stale=await pending;
  assert.equal(c.node,null);assert.equal(stale.node,null);
  ctx.ImageView.disposeAll();c.dispose();stale.dispose();
  assert.equal(made.length,2);assert.deepEqual(revoked,['blob:1','blob:2']);
});
test('failed initial mount releases its URL and is removed from global ownership', async()=>{
  const {jobs,revoked}=mountHarness();
  const failure=new Error('decode unavailable'),pending=ctx.ImageView.mount('<svg/>',[10,10],{side:'head',layer:'sheet'});
  const rejected=assert.rejects(pending,error=>error===failure);jobs[0].reject(failure);await rejected;
  assert.deepEqual(revoked,['blob:1']);ctx.ImageView.disposeAll();assert.deepEqual(revoked,['blob:1']);
});

test('board original RGB only, once per source; custom paint and alpha retained',()=>{
  const src='<svg><path fill="#f00" stroke="rgb(255, 0, 0)" opacity=".4"/><path style="fill:#FF0000!important;stroke:#abcdef"/><path fill="none"/></svg>';
  const out=ctx.ImageView.layerPaints(src,[255,0,0],[18,52,86]);
  assert.equal((out.match(/#123456/g)||[]).length,3);
  assert.ok(out.includes('stroke:#abcdef')); assert.ok(out.includes('opacity=".4"'));
  assert.ok(out.includes('!important')); assert.ok(out.includes('fill="none"'));
  assert.ok(src.includes('#f00'));
});

test('layer adapter applies imported RGB to original, never to prior rewrite',async()=>{
  const wrapper={style:{},hidden:false,replaceChildren(n){this.child=n;}};
  const revoked=[], env={create:s=>s,revoke:u=>revoked.push(u),make:()=>({dataset:{},decode:async()=>{},remove(){}})};
  const a=ctx.ImageView.boardLayer('<svg><path fill="#ff0000"/><path fill="#abcdef"/></svg>',[255,0,0],wrapper,{side:'head',layer:'F.Cu'},env);
  await a.setAppearance({color:[1,2,3,.5],opacity:.5});
  await a.setAppearance({color:[4,5,6,1],opacity:1});
  assert.ok(a.controller.appliedSource.includes('#040506'));
  assert.ok(a.controller.appliedSource.includes('#abcdef'));
  assert.equal(wrapper.style.opacity,'1'); a.dispose(); assert.equal(revoked.length,2);
});

test('layer hide between controller decode and adapter continuation never remounts stale artwork',async()=>{
  const jobs=[],revoked=[],wrapper={style:{},replaceChildren(n){this.child=n;}};
  const adapter=ctx.ImageView.boardLayer('<svg fill="#ff0000"/>',[255,0,0],wrapper,{side:'head',layer:'F.Cu'},{
    create:()=> 'blob:race',revoke:u=>revoked.push(u),make:()=>({dataset:{},remove(){},decode:()=>new Promise(resolve=>jobs.push(resolve))})
  });
  const look={color:[18,52,86,1],opacity:1},change=adapter.controller.setAppearance.bind(adapter.controller);
  adapter.controller.setAppearance=async paints=>{
    const ok=await change(paints);
    await adapter.setAppearance({...look,visible:false});
    return ok;
  };
  const pending=adapter.setAppearance(look);jobs[0]();
  assert.equal(await pending,false);
  assert.equal(wrapper.child,undefined);assert.equal(adapter.controller.node,null);
  assert.deepEqual(revoked,['blob:race']);adapter.dispose();
});

test('layer adapter keeps alpha and visibility on wrapper through delayed replacement and disposal',async()=>{
  const jobs=[],revoked=[],wrapper={style:{},hidden:false,replaceChildren(n){this.child=n;}};
  const adapter=ctx.ImageView.boardLayer('<svg fill="#F00" opacity=".4"/>',[255,0,0],wrapper,{side:'base',layer:'F.Cu'},{
    create:s=>s,revoke:u=>revoked.push(u),make:()=>({dataset:{},remove(){},decode:()=>new Promise(resolve=>jobs.push(resolve))})
  });
  const hidden=adapter.setAppearance({color:[18,52,86,.5],opacity:.5,visible:false});
  assert.equal(jobs.length,0,'hidden layer must not allocate or decode an image');
  assert.equal(await hidden,true);
  assert.equal(wrapper.style.opacity,'0.25');assert.equal(wrapper.hidden,true);
  const first=adapter.setAppearance({color:[18,52,86,.5],opacity:.5,visible:true});
  assert.equal(await adapter.setAppearance({color:[18,52,86,.5],opacity:.5,visible:false}),true);
  assert.equal(adapter.controller.node,null);
  assert.equal(revoked.length,1,'hiding releases pending URL immediately');
  const second=adapter.setAppearance({color:[65,43,21,1],opacity:1,visible:true});
  jobs[1]();assert.equal(await second,true);const current=wrapper.child;
  jobs[0]();assert.equal(await first,false);assert.equal(wrapper.child,current);
  assert.equal(wrapper.hidden,false);assert.equal(wrapper.style.opacity,'1');
  assert.ok(adapter.controller.appliedSource.includes('opacity=".4"'));
  assert.equal(await adapter.setAppearance({color:[1,2,3,1],opacity:1,visible:false}),true);
  assert.equal(adapter.controller.node,null);assert.equal(wrapper.child,undefined);
  const third=adapter.setAppearance({color:[1,2,3,1],opacity:1});adapter.dispose();
  jobs[2]();assert.equal(await third,false);assert.equal(new Set(revoked).size,3);
  assert.equal(await adapter.setAppearance({color:[1,2,3,1],opacity:1}),false);
});
