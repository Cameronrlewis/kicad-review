// Pure helpers for ui/measure3d.mjs: CDP context choice, child-to-top coordinates, rotation and timing guards.
export function selectContext(contexts,frameId) {
  const c=[...contexts.values()].find(c=>c.auxData?.frameId===frameId&&c.auxData.isDefault);
  if(!c) throw Error('BR02 report context unavailable');
  return {id:c.id,sessionId:c.sessionId||'',frameId};
}
export function viewportPoint(r,q,v) {
  if(!(r.width>0&&r.height>0&&v.width>0&&v.height>0)||q.length!==8)
    throw Error('BR02 invisible target');
  if(Math.abs(q[1]-q[3])>.5||Math.abs(q[0]-q[6])>.5)
    throw Error('BR02 transformed wrapper needs explicit coordinate mapping');
  return {x:q[0]+(r.x+r.width/2)*(q[2]-q[0])/v.width,
          y:q[1]+(r.y+r.height/2)*(q[7]-q[1])/v.height};
}
export function normalizeReadyTiming({readyMs,childTimeOrigin,topTimeOrigin,clickAt=null}) {
  if(!Number.isFinite(readyMs))return null;
  if(clickAt!==null)return {readyMs:readyMs-clickAt,navOffsetMs:0,timingOrigin:'report-click'};
  const navOffsetMs=childTimeOrigin-topTimeOrigin;
  return {readyMs:readyMs+navOffsetMs,navOffsetMs,timingOrigin:'top-navigation'};
}
export function assertRotation(a,b) {
  if(!a.camera.some((x,i)=>Math.abs(x-b.camera[i])>1e-7))
    throw Error('BR02 rotation did not move camera');
  if(!(b.drawCount>a.drawCount)) throw Error('BR02 rotation drew no frames');
}
