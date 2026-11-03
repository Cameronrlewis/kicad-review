import test from 'node:test';
import assert from 'node:assert/strict';
import {selectContext,viewportPoint,assertRotation,normalizeReadyTiming} from './measure-frame.mjs';
test('BR02 selects the opaque report world, including an OOPIF session',()=>{
  const contexts=new Map([
    ['root:1',{id:1,sessionId:'',auxData:{frameId:'top',isDefault:true}}],
    ['root:2',{id:2,sessionId:'',auxData:{frameId:'report',isDefault:false}}],
    ['child:3',{id:3,sessionId:'child',auxData:{frameId:'report',isDefault:true}}]
  ]);
  assert.deepEqual(selectContext(contexts,'report'),{id:3,sessionId:'child',frameId:'report'});
  assert.throws(()=>selectContext(contexts,'gone'),/BR02 report context unavailable/);
});
test('BR02 translates child CSS coordinates to top viewport, not shared-canvas centre',()=>{
  assert.deepEqual(viewportPoint({x:100,y:100,width:200,height:100},
    [20,60,820,60,820,660,20,660],{width:800,height:600}),{x:220,y:210});
  assert.throws(()=>viewportPoint({x:0,y:0,width:0,height:0},[],{}),/BR02 invisible target/);
});
test('BR02 rejects idle drags even when a renderer exists',()=>{
  const a={camera:[1,2,3,0,0,0],drawCount:10};
  assert.throws(()=>assertRotation(a,{...a,drawCount:20}),/BR02 rotation did not move camera/);
  assert.throws(()=>assertRotation(a,{camera:[2,2,3,0,0,0],drawCount:10}),/BR02 rotation drew no frames/);
  assertRotation(a,{camera:[2,2,3,0,0,0],drawCount:11});
});
test('BR02 normalizes hosted readiness against delayed child navigation and click origin',()=>{
  assert.deepEqual(normalizeReadyTiming({readyMs:2000,topTimeOrigin:10000,childTimeOrigin:11200}),
    {readyMs:3200,navOffsetMs:1200,timingOrigin:'top-navigation'});
  assert.deepEqual(normalizeReadyTiming({readyMs:2000,topTimeOrigin:10000,childTimeOrigin:11200,clickAt:1500}),
    {readyMs:500,navOffsetMs:0,timingOrigin:'report-click'});
  assert.ok(normalizeReadyTiming({readyMs:2000,topTimeOrigin:10000,childTimeOrigin:11200}).readyMs>=3000,
    'BR02 delayed navigation must fail the 3000 ms first-frame gate');
});
