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
