import test from 'node:test'; import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs'; import {runInNewContext} from 'node:vm';
const window={};
test('BR02 studio samples and normalized bearing',()=>{
  runInNewContext(readFileSync(new URL('./three-studio.js',import.meta.url),'utf8'),{window});
  const S=window.ThreeStudio;
  assert.equal(S.snapBearing(-30),330); assert.equal(S.snapBearing(361),0);
  const p=S.pixels('bench',60);
  assert.equal(p.length,256*128*4);
  assert.ok(p.every(Number.isFinite));
  assert.ok(p.some(v=>v>10)); assert.equal(p[3],1);
  assert.equal(S.PRESETS.bench.exposure,1.35);
});
test('BR02 bright lamps sit above the horizon, not below',()=>{
  runInNewContext(readFileSync(new URL('./three-studio.js',import.meta.url),'utf8'),{window});
  const S=window.ThreeStudio, w=256, h=128, p=S.pixels('bench',60), lum=y=>{let s=0;for(let x=0;x<w;x++)s+=p[((y)*w+x)*4+1];return s/w;};
  // bottom-first rows: row 0 is the nadir, row h-1 the zenith
  const up=Math.max(...Array.from({length:h/2},(_,i)=>lum(h/2+i))), down=Math.max(...Array.from({length:h/2},(_,i)=>lum(i)));
  assert.ok(up>down*2,'top key lamp outshines underlight '+up+' vs '+down);
});
test('BR02 nine versus ten slow rotating frames and two idle seconds',()=>{
  let now=0;const ratios=[],p=window.ThreeStudio.framePolicy(2,()=>now,n=>ratios.push(n));
  for(let i=0;i<9;i++)p.rotating(34);assert.deepEqual(ratios,[]);
  p.rotating(34);assert.deepEqual(ratios,[1.5]);
  p.idle();now=1999;p.poll();assert.deepEqual(ratios,[1.5]);
  now=2000;p.poll();assert.deepEqual(ratios,[1.5,2]);
  for(let i=0;i<9;i++)p.rotating(34);p.rotating(20);p.rotating(34);
  assert.deepEqual(ratios,[1.5,2]);p.dispose();now=9999;p.poll();
  assert.deepEqual(ratios,[1.5,2]);
});
test('BR02 frame policy resets idle on movement, restores once, and respects low caps',()=>{
  let now=0;const ratios=[],p=window.ThreeStudio.framePolicy(2,()=>now,n=>ratios.push(n));
  for(let i=0;i<10;i++)p.rotating(34);
  p.idle();now=1500;p.idle();now=1999;p.poll();assert.deepEqual(ratios,[1.5]);
  p.rotating(33);now=2000;p.poll();assert.deepEqual(ratios,[1.5]);
  p.idle();now=3999;p.poll();assert.deepEqual(ratios,[1.5]);
  now=4000;p.poll();p.poll();assert.deepEqual(ratios,[1.5,2]);
  for(let i=0;i<10;i++)p.rotating(34);p.idle();p.dispose();now=9000;
  p.poll();p.rotating(34);p.idle();assert.deepEqual(ratios,[1.5,2,1.5]);
  for(const cap of [1,1.5]) {
    const low=window.ThreeStudio.framePolicy(cap,()=>now,()=>assert.fail('increased low DPR cap'));
    for(let i=0;i<20;i++)low.rotating(34);low.idle();now+=2000;low.poll();low.dispose();
  }
});

test('BR02 shared lighting normalization follows preset defaults and clamps steps',()=>{
  const S=window.ThreeStudio, plain=v=>JSON.parse(JSON.stringify(v));
  assert.deepEqual(plain(S.normalizeLighting()),{rig:'bench',bearing:60,exposure:1.35});
  assert.deepEqual(plain(S.normalizeLighting({rig:'invalid',bearing:-30,exposure:99})),{rig:'bench',bearing:330,exposure:3});
  assert.deepEqual(plain(S.normalizeLighting({rig:'photo',bearing:44,exposure:.426})),{rig:'photo',bearing:30,exposure:.45});
  assert.equal(S.normalizeLighting({rig:'lowsun',exposure:-2}).exposure,.4);
  assert.equal(S.normalizeLighting({exposure:.475}).exposure,.5);
  const old=S.PRESETS.photo;
  try {
    S.PRESETS.photo={...old,bearing:120,exposure:1.75};
    assert.deepEqual(plain(S.normalizeLighting({rig:'photo',bearing:NaN,exposure:Infinity})),{rig:'photo',bearing:120,exposure:1.75});
  } finally {S.PRESETS.photo=old;}
});
