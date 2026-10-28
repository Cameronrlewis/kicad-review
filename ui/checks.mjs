const BOARD_POINT_PROBE = `
    const occupied=({id,layer}={})=>{
      for(const pane of boardDiff.panes) for(const [side,scene] of Object.entries(pane.scenes)) {
        if(!scene) continue;
        pane.renderer.setScene(scene,side);
        for(const object of scene.objects.filter(o=>(!id||o.changeIds?.includes(id))&&(!layer||o.layers.length===1&&o.layers[0]===layer))) {
          const [x0,y0,x1,y1]=object.box.map(v=>v/1000);
          for(const fx of [.5,.25,.75,.125,.875]) for(const fy of [.5,.25,.75,.125,.875]) {
            const q=pane.renderer.project([x0+(x1-x0)*fx,y0+(y1-y0)*fy]);
            if(pane.renderer.hitTest(q).some(o=>o===object)) {
              const r=pane.vp.getBoundingClientRect();
              boardDiff.render(); return {pane,object,screen:q,event:{clientX:r.left+q[0],clientY:r.top+q[1]}};
            }
          }
        }
      }
      boardDiff.render(); return null;
    };
`;

const BOARD_LIFECYCLE_FIXTURE = `
    const scene={version:1,units:'um',complete:true,warnings:[],bounds:[0,0,10000,10000],
      layers:[{id:0,name:'F.Cu',type:'signal',enabled:true}],nets:[{id:0,name:''}],
      objects:[{kind:'track',uuid:'lifecycle',changeUuid:'lifecycle',layers:['F.Cu'],net:0,category:'tracks',side:null,hidden:false,
        box:[1000,1000,9000,3000],geometry:{segments:[[2000,2000,8000,2000,1000]]}}]};
    const bytes=new Uint8Array(await new Response(new Blob([JSON.stringify(scene)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    D.blobs.lifecycle=btoa(String.fromCharCode(...bytes));
    proj().board.geometry={base:'lifecycle',head:'lifecycle'};
    boardView.failed=null; Object.assign(S,{v:'board',m:'overlay',x:5,y:5,z:20});
    await draw();
`;

const MARK_STYLE_FIXTURE = `
    // The template may lack retained board data; enable the real toolbar against a retained fixture.
    const object={kind:'pad',uuid:'style',changeIds:['c0'],layers:['F.Cu'],net:0,category:'pads',side:'front',hidden:false,
      box:[2000,2000,6000,6000],geometry:{primitive:{shape:'circle',center:[4000,4000],size:[4000,4000],angle:0}}};
    const scene={version:1,units:'um',complete:true,warnings:[],bounds:[0,0,10000,10000],layers:[{id:0,name:'F.Cu',type:'signal',enabled:true}],nets:[{id:0,name:''}],objects:[object]};
    disposeBoardRenderers(); const stage=document.querySelector('#stage'); stage.replaceChildren();
    S.m='overlay'; S.x=5; S.y=5; S.z=40;
    boardDiff=BoardDiff.mount({stage,scenes:{base:scene,head:scene},changes:[{id:'c0',action:'added'}],state:S,appearance:glAppearance});
    boardView.scenes=[scene,scene]; boardView.useGL=true; boardView.panes=boardDiff.panes; boardView.renderers=boardDiff.panes.map(p=>p.renderer);
    for(const p of boardDiff.panes) trackAppearanceBoard(p.renderer,p.canvas);
    syncMarkStyles();
`;
// Mesh-miss setup runs once, before real CDP input; assertions never mutate the scene.
export const BR02_MESH_MISS_PREPARE = `
 if(!proj().board.parts3d)return null;
 const st=Review3D.state,{THREE:T}=THREE3D,v=st.views.find(v=>v.visible&&(!v.side||v.side==='head'));
 if(!v)return 'missing head viewport';
 const root=st.roots[1],changed=st.parts.head.find(p=>p.ref==='R12'),unchanged=st.parts.head.find(p=>p.ref==='R2');
 root.traverse(n=>{if(n.isMesh)n.visible=false});
 const center=unchanged.bounds.getCenter(new T.Vector3());
 v.controls.target.copy(center);v.camera.position.copy(center).add(new T.Vector3(0,.1,0));
 v.camera.up.set(0,0,-1);v.camera.lookAt(center);v.camera.updateMatrixWorld(true);
 changed.bounds=unchanged.bounds.clone().expandByScalar(.001);
 // Triangle is inside the overlapping changed AABB but away from the centre ray.
 const size=unchanged.bounds.getSize(new T.Vector3()),x=center.x+size.x*.4,z=center.z;
 const g=new T.BufferGeometry().setAttribute('position',new T.Float32BufferAttribute([
   x,center.y+.001,z,x+size.x*.05,center.y+.001,z,x,center.y+.001,z+size.z*.05],3));
 const mesh=new T.Mesh(g,new T.MeshBasicMaterial({side:T.DoubleSide}));
 mesh.userData={role:'body',side:changed.side,ref:'R12'};root.add(mesh);window.__br02MeshMissMesh=mesh;
 // Named \`BR02 processed mesh miss\` branch in ui/check.mjs sends a real CDP mouse press/release here.
`;

// [name, url hash, body of an async function that returns true when the check passes]
export const CHECKS = [
["BR02 processed unchanged focus and missing batch", "v=3d&m=side", `
 if(!proj().board.parts3d)return 'skip';
 const st=Review3D.state,p=st.parts.head.find(p=>p.ref==='R2');
 if(!p?.hasModel)return 'missing unchanged R2 index';
 if(st.roots[1].getObjectByName('R2'))return 'unchanged part was not merged';
 Review3D.focusPart('R2','head',false);
 if(!Review3D.state.selected.length)return 'unchanged focus has no outline';
 for(const side of ['base','head']) {
   const missing=st.parts[side].filter(p=>!p.hasModel),mesh=st.placeholderMeshBySide[side];
   if(missing.length&&(!mesh?.isMesh||mesh.geometry.index.count!==missing.length*36))
     return 'missing models not in one indexed box batch';
 }
 return true;
`],
["BR02 processed bare parts cannot be picked", "v=3d&m=side", `
 if(!proj().board.parts3d)return 'skip';
 Review3D.setAssembled(false);
 Review3D.focusPart('R2','head',false);
 if(Review3D.state.selected.length)return 'hidden body remains selectable';
 Review3D.setAssembled(true);Review3D.focusPart('R2','head',false);
 return Review3D.state.selected.length>0||'assembled focus failed';
`],

...[...['R2','J1','U3','U4'].flatMap(ref=>['base','head'].map(side=>[ref,side])),['R1','base'],['R12','head']].map(([ref,side])=>[
 'BR02 processed pointer '+side+' '+ref,'v=3d&m=side',`
 if(!proj().board.parts3d)return 'skip';
 const side=${JSON.stringify(side)},ref=${JSON.stringify(ref)},st=Review3D.state;
 Review3D.setRevision(side);
 const v=st.views.find(v=>v.visible&&(!v.side||v.side===side));if(!v)return 'missing own viewport';
 const p=st.parts[side].find(p=>p.ref===ref),{THREE:T}=THREE3D;
 if(!p)return 'missing indexed target';
 const point=p.bounds.getCenter(new T.Vector3());v.camera.updateMatrixWorld(true);point.project(v.camera);
 const b=v.host.getBoundingClientRect(),xy={clientX:b.left+(point.x+1)*b.width/2,
   clientY:b.top+(1-point.y)*b.height/2,bubbles:true,pointerId:1,pointerType:'mouse'};
 if(Math.abs(point.x)>1||Math.abs(point.y)>1)return 'target outside viewport';
 // ui/check.mjs named BR02 processed pointer preparation computes these projected host coordinates before this assertion body runs.
 if(window.__br02PointerResult?.side!==side||window.__br02PointerResult?.ref!==ref)return 'CDP pointer input was not prepared';
 const changed=proj().changes.find(c=>c.kind==='footprint'&&(c.uuid===p.uuid||c.uuid_before===p.uuid));
 if(changed) {
   if(S.s!==changed.id)return 'changed footprint bypassed change selection: '+JSON.stringify({expected:changed.id,selected:S.s,part:S.part3d?.uuid});
   if(!Review3D.state.selected.some(x=>x.ref===ref&&x.side===side))return 'changed footprint did not select its revision-local outline';
   if(S.part3d)return 'changed selection incorrectly entered part inspector';
 } else {
   if(S.part3d?.uuid!==p.uuid||S.part3d?.side!==side)return 'indexed pointer selected wrong UUID/revision';
   const inspector=document.querySelector('[data-part3d-inspector]');
   if(!inspector||![ref,p.uuid,side].every(x=>inspector.textContent.includes(x)))return 'inspector identity missing';
 }
 if(!v.host.querySelector('.tip3d')?.textContent.includes(ref))return 'indexed hover absent';
 for(const hidden of [[p.side],['bodies']]) {
   Review3D.setHidden(hidden);
   if(v.host.querySelector('.tip3d'))return 'hidden body tooltip remains visible';
   const mesh=st.placeholderMeshBySide[side];
   if(mesh&&hidden[0]===p.side) {
     const own=mesh.userData.placeholderSides.indexOf(p.side),other=1-own;
     if(mesh.material[own].visible||!mesh.material[other].visible)return 'placeholder side visibility not independent';
   }
   Review3D.setAssembled(false);Review3D.setAssembled(true);
   if(Review3D.state.selected.length)return 'assembly reset hidden selection';Review3D.setHidden([]);
 }
 Review3D.setAssembled(false);
 if(Review3D.state.selected.length)return 'bare board retained outlines';
 Review3D.setAssembled(true);return true;
 `]),

["BR02 processed overlapping box misses changed mesh", "v=3d&m=side", `
 if(!proj().board.parts3d)return 'skip';
 const unchanged=Review3D.state.parts.head.find(p=>p.ref==='R2');
 if(!window.__br02MeshMissMesh?.visible)return 'mesh-miss triangle hidden or not prepared';
 if(!window.__br02MeshMissInput)return 'CDP mesh-miss input was not prepared';
 return S.part3d?.uuid===unchanged.uuid||'changed AABB stole mesh-miss ray';
`],
["BR02 processed moved renamed own pane outlines", "v=3d&m=side", `
 if(!proj().board.parts3d)return 'skip';
 const c=proj().changes.find(c=>c.kind==='footprint'&&c.ref==='R12');if(!c)return 'renamed change absent';
 Review3D.focus(c,false);const st=Review3D.state;
 for(const side of st.visibleSides) {
   const p=st.parts[side].find(p=>p.uuid===(side==='base'?(c.uuid_before||c.uuid):c.uuid));
   const outlines=st.selected.filter(o=>o.userData.revision===side);
   if(outlines.length!==1||outlines[0].userData.uuid!==p.uuid)return 'lost revision-local outline';
   const b=new THREE3D.THREE.Box3().setFromObject(outlines[0]);
   if(b.min.distanceTo(p.bounds.min)>1e-6||b.max.distanceTo(p.bounds.max)>1e-6)return 'outline uses other revision box';
 }
 return S.phone||st.selected.length===2||'changed focus cleared base outline';
`],

  ["BR02 processed missing list keeps revision identity", "v=3d&m=side", `
    if(!proj().board.parts3d)return 'skip';
    for(const side of ['base','head']) {
      Review3D.setRevision(side);
      document.querySelector('[data-no-model="U3"]').click();
      const c=proj().changes.find(c=>c.ref==='U3');
      if(S.s!==c.id||S.part3d)return 'changed missing part bypassed change selection';
      const st=Review3D.state,p=st.parts[side].find(p=>p.ref==='U3');
      if(!st.selected.some(o=>o.userData.uuid===p.uuid&&o.side===side))return 'changed missing list lost own revision';
      document.querySelector('[data-no-model="U4"]').click();
      if(S.s||S.part3d?.side!==side||S.part3d?.ref!=='U4')return 'unchanged missing list fabricated a change';
    }
    return true;
  `],
  ["BR02 processed rejected peer index retains own focus", "v=3d&m=side", `
    if(!proj().board.parts3d)return 'skip';
    const p=structuredClone(proj()),expected=Review3D.state.parts.head.find(p=>p.ref==='R12').bounds.clone();
    p.board.parts3d.head='br02-invalid-index';REVIEW_DATA.blobs['br02-invalid-index']='not base64!';
    await Review3D.show(document.querySelector('#stage'),p,S);
    const c=p.changes.find(c=>c.ref==='R12');Review3D.focus(c,false);
    const st=Review3D.state;
    if(!st.errorsBySide.head)return 'invalid index not diagnosed';
    const own=st.selected.find(o=>o.side==='head');
    if(!own&&st.visibleSides.includes('head'))return 'valid peer suppressed legacy own focus';
    if(own) {
      const box=new THREE3D.THREE.Box3().setFromObject(own);
      if(box.min.distanceTo(expected.min)>1e-6||box.max.distanceTo(expected.max)>1e-6)return 'rejected index borrowed peer bounds';
    }
    return true;
  `],
  ...['bare','bodies','own side','other side','redraw'].map(action=>[
    'BR02 processed inspector visibility '+action,'v=3d&m=side', `
    if(!proj().board.parts3d)return 'skip';
    const part=Review3D.state.parts.head.find(p=>p.ref==='U4');
    Review3D.setRevision('head');Review3D.onPartPick({...part,side:'head'});Review3D.focusPart(part.ref,'head',false);
    if('${action}'==='bare')Review3D.setAssembled(false);
    if('${action}'==='bodies')Review3D.setHidden(['bodies']);
    if('${action}'==='own side')Review3D.setHidden([part.side]);
    if('${action}'==='other side')Review3D.setHidden([part.side==='top'?'bottom':'top']);
    if('${action}'==='redraw'){S.m='overlay';await draw();}
    const selected=Review3D.state.selected,inspector=document.querySelector('[data-part3d-inspector]');
    if('${action}'==='other side')return selected.length>0&&S.part3d?.uuid===part.uuid&&!!inspector||'visible opposite-side selection cleared';
    return !selected.length&&!S.part3d&&!inspector||'invisible part retained inspector or outline';
  `]),
  ["BR02 processed change ownership uses revision-local references", "v=3d&m=side", `
    if(!proj().board.parts3d)return 'skip';
    const p=structuredClone(proj()),parts=Review3D.state.parts;
    p.changes.push({id:'added-u4',kind:'footprint',action:'added',ref:'U4',uuid:parts.head.find(p=>p.ref==='U4').uuid},
      {id:'removed-r2',kind:'footprint',action:'removed',ref:'R2',uuid:parts.base.find(p=>p.ref==='R2').uuid});
    await Review3D.show(document.querySelector('#stage'),p,S);
    for(const [ref,side,id] of [['R1','base','c1'],['R12','head','c1'],['R12','base',null],['R1','head',null],
      ['U4','head','added-u4'],['U4','base',null],['R2','base','removed-r2'],['R2','head',null]]) {
      if((Review3D.changeForPart(ref,side)?.id||null)!==id)return 'wrong change owner: '+side+' '+ref;
    }
    return true;
  `],
  ["BR02 processed indexed missing focus tooltip", "v=3d&m=side", `
    if(!proj().board.parts3d)return 'skip';
    const change=proj().changes.find(c=>c.ref==='U3');Review3D.focus(change,false);
    for(const side of Review3D.state.visibleSides) {
      const v=Review3D.state.views.find(v=>v.visible&&(!v.side||v.side===side));
      if(!v.host.querySelector('.tip3d')?.textContent.includes('U3 · no 3D model'))return 'indexed missing focus lost tooltip';
    }
    Review3D.setAssembled(false);
    return !document.querySelector('.tip3d')||'hidden missing focus retained tooltip';
  `],
  ["BR02 processed resize does not rescan body visibility", "v=3d&m=side", `
    if(!proj().board.parts3d)return 'skip';
    let visits=0;const st=Review3D.state,restore=[];
    for(const root of st.roots.filter(Boolean)) {
      const traverse=root.traverse;restore.push(()=>root.traverse=traverse);
      root.traverse=function(...args){visits++;return traverse.apply(this,args)};
    }
    try {Review3D.resize();return visits===0||'resize rescanned body groups';}
    finally {restore.forEach(f=>f());}
  `],
  ["BR02 processed inspector identity is text and clears on navigation", "v=3d&m=side", `
    if(!proj().board.parts3d)return 'skip';
    const part=Review3D.state.parts.head.find(p=>p.ref==='R2');
    const ref='<img src=x onerror=alert(1)>';
    Review3D.onPartPick({...part,ref,side:'head'});
    const inspector=document.querySelector('[data-part3d-inspector]');
    if(inspector.querySelector('img')||!inspector.textContent.includes(ref))return 'index text interpreted as markup';
    const expected=part.box.map(n=>round3(n*1000));
    if(!inspector.textContent.includes('X bounds (mm)')||!inspector.textContent.includes(expected[0]+' … '+expected[3]))return 'world bounds not shown in board mm';
    await goTo(proj().changes[0].id);
    if(S.part3d||document.querySelector('[data-part3d-inspector]'))return 'changed selection retained part identity';
    Review3D.onPartPick({...part,side:'head'});
    await applyState({...S,s:proj().changes[0].id});
    if(S.part3d||document.querySelector('[data-part3d-inspector]'))return '3D hash navigation retained stale part identity';
    Review3D.onPartPick({...part,side:'head'});S.v='board';await draw();
    return !S.part3d&&!document.querySelector('[data-part3d-inspector]')||'navigation retained stale 3D identity';
  `],
  ["BR02 processed phone chrome and tools stay reachable", "v=3d&m=side", `
    if(!proj().board.parts3d)return 'skip';
    if(innerWidth>700)return true;
    const inside=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight};
    if(document.documentElement.scrollWidth>innerWidth)return 'phone shell overflow';
    const toolbar=document.querySelector('#toolbar');
    if(toolbar.scrollHeight>toolbar.clientHeight)return 'phone wrapped toolbar controls clipped';
    const status=document.querySelector('#statusbar');
    if(status.scrollHeight>status.clientHeight)return 'phone status controls clipped';
    for(const menu of document.querySelectorAll('.report-chrome details')) {
      const summary=menu.querySelector('summary');summary.focus();
      if(!inside(summary)||document.activeElement!==summary)return 'phone header action unreachable';
      menu.open=true;
      if(!inside(menu.querySelector('.bench-popover')))return 'phone header popup outside viewport';
      menu.open=false;
    }
    for(const control of document.querySelectorAll('#zoombar [data-3d-assembled],#zoombar .light3d summary')) {
      control.focus();control.scrollIntoView({block:'nearest',inline:'nearest'});
      if(!inside(control)||control.getBoundingClientRect().height<44||document.activeElement!==control)return 'phone 3D tool unreachable';
    }
    return document.documentElement.scrollWidth<=innerWidth||'phone tool focus caused page overflow';
  `],
  ["BR02 processed inspector whole screen", "v=3d&m=side", `
    if(!proj().board.parts3d)return 'skip';
    const st=Review3D.state,part=st.parts.head.find(p=>p.ref==='R2'),widthBefore=document.documentElement.scrollWidth;
    Review3D.setRevision('head');Review3D.onPartPick({...part,side:'head'});Review3D.focusPart(part.ref,'head',false);
    // The shared shell belongs to 05: record its existing overflow, reject any added by this inspector.
    // Fix-round acceptance also requires the whole shell to fit; no baseline overflow exemption.
    console.log('BOARD_PROOF part inspector '+JSON.stringify({width:innerWidth,before:widthBefore,after:document.documentElement.scrollWidth}));
    if(document.documentElement.scrollWidth>innerWidth)return 'part inspector whole screen overflow';
    const inspector=document.querySelector('[data-part3d-inspector]'),r=inspector.getBoundingClientRect();
    if(r.left<0||r.right>innerWidth||r.bottom>innerHeight||inspector.scrollWidth>inspector.clientWidth)return 'part inspector outside screen';
    const toggle=document.querySelector('#insp-toggle');toggle.focus();
    return document.activeElement===toggle&&inspector.textContent.includes(part.uuid)||'part identity or keyboard focus absent';
  `],
  ["SCH6 exact paints stay schematic-only and preserve raster source", "", `
    const id = '__sch6_palette_probe__';
    const source = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10" style="stroke:#A90000"><path d="M0 0H10V10H0Z" style="fill:#009600!important;stroke:none"/></svg>';
    cache[id] = source;
    const view = {kind:'sheet', size:[10,10], layers:[{name:'probe', svg:{base:id,head:id}}]};
    try {
      const sheet = await stack('head', view);
      const svg = sheet.querySelector('svg'), path = svg.querySelector('path');
      if (svg.style.stroke !== 'var(--sch-ink-a90000, #a90000)'
        || path.style.getPropertyPriority('fill') !== 'important'
        || !path.getAttribute('style').includes('var(--sch-ink-009600')) return false;
      const themed = svg.outerHTML; themeSchematic(svg);
      if (svg.outerHTML !== themed) return false;
      document.documentElement.style.setProperty('--sch-ink-009600', '#135724');
      for (const kind of ['board','lib']) {
        const other = await stack('head', {...view, kind});
        if (other.querySelector('svg').outerHTML.includes('--sch-ink-')) return false;
      }
      const pixels = await raster('head', view, 10, 10);
      return await svgText(id) === source && pixels[0] === 0 && pixels[1] === 150
        && pixels[2] === 0 && pixels[3] === 255
        && schematicPaint('#A90000') === schematicPaint('#a90000')
        && schematicPaint('#F5F4EF') === '#F5F4EF';
    } finally {
      delete cache[id]; document.documentElement.style.removeProperty('--sch-ink-009600');
    }
  `],
["SCH6 exact paints preserve opacity unknown colours and geometry", "", `
  const host = document.createElement('div');
  host.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g style="stroke:#009600;fill:none;stroke-opacity:.4"><path d="M1 1L9 9" fill="#FFFFC2"/><text opacity="0" stroke-opacity="0">Hidden</text></g><path fill="#123456" stroke="none"/><path style="fill:rgb(0,150,0);stroke:#009601"/></svg>';
  const svg = host.firstChild, before = svg.querySelector('path').getAttribute('d');
  document.body.append(host);
  try {
    themeSchematic(svg);
    const g = svg.querySelector('g'), unknown = svg.querySelectorAll('path')[1];
    document.documentElement.style.setProperty('--sch-ink-009600', '#135724');
    const first = getComputedStyle(svg.querySelector('path')).stroke;
    document.documentElement.style.setProperty('--sch-ink-009600', '#246813');
    const second = getComputedStyle(svg.querySelector('path')).stroke;
    return first === 'rgb(19, 87, 36)' && second === 'rgb(36, 104, 19)'
      && g.style.fill === 'none' && g.style.strokeOpacity === '0.4'
      && svg.querySelector('text').getAttribute('opacity') === '0'
      && unknown.getAttribute('fill') === '#123456'
      && unknown.getAttribute('stroke') === 'none'
      && svg.querySelector('path').getAttribute('d') === before
      && schematicPaint('rgb(0,150,0)') === 'rgb(0,150,0)'
      && schematicPaint('#009601') === '#009601'
      && schematicPaint('#009600') === schematicPaint('#009600'.toLowerCase());
  } finally {
    document.documentElement.style.removeProperty('--sch-ink-009600'); host.remove();
  }
`],

  ["Stage 1 dock tabs remain readable and reachable at 1600", "", `
    const P=proj();
    P.parts ||= {lines:[],supplier:{skipped:true}};
    const line=P.parts.lines[0] || {problems:[]}; P.parts.lines=Array(999).fill(line);
    S.threads=[]; S.issues=[]; renderPanel();
    const panel=document.querySelector('#panel').getBoundingClientRect();
    const tabs=[...document.querySelectorAll('#panel [role=tab]')];
    if(tabs.length!==4) return 'missing tabs';
    for(const b of tabs) {
      const r=b.getBoundingClientRect();
      if(r.left<panel.left || r.right>panel.right+.5 || b.scrollWidth>b.clientWidth+1) return b.textContent;
    }
    const checks=tabs.find(t=>t.dataset.tab==='checks'); checks.focus();
    checks.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}));
    const last=document.querySelector('#panel [data-tab="threads"]');
    const good=document.activeElement===last && last.getAttribute('aria-selected')==='true';
    return good && document.documentElement.scrollWidth<=innerWidth || 'keyboard/overflow';`],
  ["Stage 1 X Y map each pane and reset outside drawing", "v=board", `
    await draw(); setT({x:-12.125,y:34.375,z:8});
    const viewports=[...document.querySelectorAll('#stage .vp')];
    if(viewports.length!==2) return 'side fixture';
    for(const vp of viewports) {
      const r=vp.getBoundingClientRect();
      updateCoordinates(vp,{clientX:r.left+r.width/2+10,clientY:r.top+r.height/2-6});
      if(document.querySelector('[data-coordinate=x]').textContent!=='-10.875' ||
         document.querySelector('[data-coordinate=y]').textContent!=='33.625') return 'mapping';
    }
    const hash=location.hash; resetCoordinates();
    // Bench: leaving the drawing keeps the last reading, greyed as off canvas.
    if(!document.querySelector('.status-coordinates.off-canvas')) return 'stale';
    await draw();
    return location.hash===hash;`],
["Stage 1 dark default ignores OS and tokens resolve", "", `
  const root = document.documentElement; root.removeAttribute('data-theme');
  const c = getComputedStyle(root), b = getComputedStyle(document.body);
  return c.colorScheme === 'dark' && b.backgroundColor === 'rgb(10, 12, 14)'
    && c.getPropertyValue('--btn-h').trim() === '24px'
    && c.getPropertyValue('--tab-h').trim() === '28px'
    && c.getPropertyValue('--toolbar-h').trim() === '36px'
    && c.getPropertyValue('--space-2').trim() === '8px';`],
["Stage 1 both token themes pass text contrast", "", `
  const root = document.documentElement, old = root.getAttribute('data-theme');
  const probe = document.createElement('span'); document.body.append(probe);
  const lum = s => { const rgb = s.match(/[\\d.]+/g).slice(0,3).map(Number).map(v => {v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;}); return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722; };
  const ratio = (a,b) => (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
  try {
    for (const theme of ['dark','light']) {
      root.dataset.theme = theme;
      for (const surface of ['bg','surface','surface-2','surface-3']) {
        probe.style.backgroundColor = 'var(--'+surface+')';
        for (const text of ['text','muted','accent','added','removed','modified','waived']) {
          probe.style.color = 'var(--'+text+')'; const s = getComputedStyle(probe);
          if (ratio(lum(s.color),lum(s.backgroundColor)) < 4.5) return theme+': '+text+' on '+surface;
        }
      }
      probe.style.backgroundColor = 'var(--accent-fill)'; probe.style.color = 'var(--on-accent)';
      let s = getComputedStyle(probe); if (ratio(lum(s.color),lum(s.backgroundColor)) < 4.5) return 'primary';
      probe.style.color = 'var(--line-strong)'; probe.style.backgroundColor = 'var(--surface)';
      s = getComputedStyle(probe); if (ratio(lum(s.color),lum(s.backgroundColor)) < 3) return 'control border';
    }
    return true;
  } finally { probe.remove(); if(old === null) root.removeAttribute('data-theme'); else root.dataset.theme=old; }`],
  ["board uniform retained primitives and drill pixels", "", `
    if (!window.BoardGL) return "missing BoardGL";
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "position:fixed;left:300px;top:180px;width:800px;height:500px;z-index:9999";
    canvas.setAttribute("aria-label", "Synthetic retained PCB tracks and via drill holes");
    document.body.append(canvas);
    const scene = {version:1,units:"um",complete:true,warnings:[],bounds:[0,0,8000,5000],
      layers:[{id:0,name:"F.Cu",type:"signal",enabled:true},{id:2,name:"B.Cu",type:"signal",enabled:true}],
      nets:[{id:0,name:""},{id:900001,name:"GND"}],objects:[
        {kind:"track",uuid:"track",changeUuid:"track",layers:["F.Cu"],net:900001,category:"tracks",side:null,hidden:false,box:[750,750,6250,1250],geometry:{segments:[[1000,1000,6000,1000,500]]}},
        {kind:"track",uuid:"disc",changeUuid:"disc",layers:["F.Cu"],net:0,category:"tracks",side:null,hidden:false,box:[6500,500,7500,1500],geometry:{segments:[[7000,1000,7000,1000,1000]]}},
        {kind:"via",uuid:"via",changeUuid:"via",layers:["F.Cu","B.Cu"],net:900001,category:"vias",side:null,hidden:false,box:[2500,2500,3500,3500],geometry:{primitive:{shape:"circle",center:[3000,3000],size:[1000,1000],angle:0},drill:{center:[3000,3000],size:[500,500],angle:0,plated:true}}},
        {kind:"pad",uuid:"slot",changeUuid:"fp",layers:["F.Cu","B.Cu"],net:900001,category:"pads",side:"back",hidden:false,box:[4500,2500,5500,3500],geometry:{primitive:{shape:"circle",center:[5000,3000],size:[1000,1000],angle:0},drill:{center:[5000,3000],size:[700,300],angle:0,plated:true}}}
      ]};
    const failures = [];
    const r = BoardGL.create(canvas,{scene,onFailure:e=>failures.push(e.message)});
    if (!r) return "WebGL2/stencil unavailable: " + failures;
    r.setCamera({x:4,y:2.5,z:100,width:800,height:500,dpr:1});
    const gl = canvas.getContext("webgl2"), pixel = (x,y) => {const p=new Uint8Array(4);gl.readPixels(Math.round(x*100),Math.round(500-y*100),1,1,gl.RGBA,gl.UNSIGNED_BYTE,p);return Array.from(p).slice(0,3);};
    const equal = (p,q) => p.every((v,i)=>Math.abs(v-q[i])<=2);
    const bg = [0,16,35], copper = [200,52,52];
    const state = {activeLayer:"F.Cu",layers:{"F.Cu":{color:[200,52,52,1],visible:true}},objects:{tracks:{opacity:1}},nets:{}};
    r.setAppearance(state); r.draw();
    const uploads = r.stats.uploads;
    const initial=[pixel(3,1),pixel(.85,1),pixel(.7,1),pixel(7,1),pixel(3,3),pixel(3.4,3),pixel(3.275,3),pixel(5.2,3)];
    if (!initial.every((p,i)=>equal(p,[copper,copper,bg,copper,bg,copper,[236,236,236],bg][i]))) return "initial pixels " + JSON.stringify(initial);
    r.draw();
    state.layers["F.Cu"].color = [20,220,80,.8]; state.objects.tracks.opacity = .5;
    r.setAppearance(state); r.draw();
    if (!equal(pixel(3,1),[8,98,53]) || r.stats.uploads!==uploads) return "uniform update uploaded or wrong RGB " + pixel(3,1);
    state.objects.tracks.opacity=1; state.layers["F.Cu"].color=[200,52,52,1];
    state.nets.GND={color:[40,100,240,.5]}; r.setAppearance(state); r.draw();
    if (!equal(pixel(3,1),[20,58,138])) return "net override alpha " + pixel(3,1);
    state.nets.GND={visible:false}; r.setAppearance(state); r.draw();
    if (!equal(pixel(3,1),bg) || !equal(pixel(3.4,3),bg)) return "hidden net";
    state.nets={}; state.selectedNet="GND"; r.setAppearance(state); r.draw();
    if (!equal(pixel(7,1),copper)) return "net zero was dimmed";
    state.objects.backFootprints={visible:false}; r.setAppearance(state); r.draw();
    if (!equal(pixel(5,3),bg) || !equal(pixel(5.4,3),bg)) return "footprint side gate";
    state.flip=true; r.setAppearance(state); r.draw();
    if (!equal(pixel(1,1.4),copper)) return "appearance flip";
    state.flip=false; state.layers["F.Cu"].visible=false; r.setAppearance(state); r.draw();
    if (!equal(pixel(3,1),bg)) return "layer eye";
    state.layers["F.Cu"].visible=true; r.setAppearance(state);
    r.setCamera({x:3,y:1,z:120,width:800,height:500,dpr:1}); r.draw();
    if (!equal(r.readPixel(400,250).slice(0,3),copper)) return "retained camera";
    r.setCamera({x:4,y:2.5,z:100,width:800,height:500,dpr:1});
    if (r.stats.uploads!==uploads || gl.getError()!==gl.NO_ERROR || failures.length) return "GPU errors/uploads";
    state.objects.backFootprints={visible:true}; state.selectedNet=null;
    r.setAppearance(state); r.draw();
    window.__boardSynthetic = {renderer:r,canvas};
    return true;`],
  ["Libraries compare modes, used-by jumps and escaped panel", "", `
    const P = proj(), sheet = P.sheets.find(s => s.svg); if (!sheet) return "skip";
    P.objects = [{kind: "symbol", ref: "U1", lib: "Parts:X", sheet: sheet.path, pos: [10, 10], side: "head"}];
    P.libraries = [{lib: "Parts", item: "X", kind: "symbol", status: "modified", file: "f", size: sheet.size, svg: sheet.svg,
      pins_diff: [{pin: "<img>", change: "type", before: "<b>old</b>", after: "new"}], used_by: ["U1"], warnings: ["<script>bad</script>"]}];
    S.t = "checks"; select("lib:0");
    for (const m of ["side", "overlay", "wipe", "blend", "semantic"]) { S.m = m; await draw(); if (!document.querySelector("#stage .stack .layer")) return m; }
    if (document.querySelector("#panel .lib-info img, #panel .lib-info script, #panel .lib-info td b") || !document.querySelector("#panel .lib-info")?.textContent.includes("<b>old</b>")) return "unescaped";
    document.querySelector("#panel [data-lib-object]").click(); await new Promise(r => setTimeout(r, 400));
    if (S.v !== "sheet:" + sheet.path || document.querySelector("#panel .lib-info")) return "used-by did not leave library";
    const row = P.changes.find(r => viewOf(r) && currentView(viewOf(r))); if (!row) return "no changed object";
    select("lib:0"); await goTo(row.id);
    if (document.querySelector("#panel .lib-info")) return "stale library panel after change selection";
    P.objects[0].sheet = "/missing"; select("lib:0");
    return !document.querySelector("#panel [data-lib-object]") && document.querySelector("#panel .lib-info").textContent.includes("U1") || "dead used-by button";`],

  ["Libraries changed items are listed, drawn and explained", "", `
    const P = proj(), sheet = P.sheets.find(s => s.svg); if (!sheet) return "skip";
    P.libraries = [{ lib: "Parts", item: "SOT23", kind: "footprint", status: "modified", file: "Parts.pretty/SOT23.kicad_mod", size: sheet.size, svg: sheet.svg,
                     pins_diff: [{ pin: "3", change: "removed", before: "smd rect (2, 0) 0.6×1", after: null }], used_by: ["U1", "U3"], warnings: ["⚠ pad 3 removed while U1, U3 use SOT23"] },
                   { lib: "Parts", item: "<b>X</b>", kind: "symbol", status: "added", file: "Parts.kicad_sym", svg: { base: null, head: null }, pins_diff: [], used_by: [], warnings: [], note: "no drawing" }];
    renderNav();
    const items = [...document.querySelectorAll('#nav [data-view^="lib:"]')];
    items[0].click(); await new Promise(r => setTimeout(r, 400));
    const info = document.querySelector("#panel .lib-info")?.textContent || "";
    const drew = !!document.querySelector("#stage .stack.head .layer");
    return items.length === 2 && items[1].textContent.includes("<b>X</b>") && !document.querySelector("#nav b") && drew && info.includes("pad 3") && info.includes("U1, U3") && info.includes("⚠")
      || JSON.stringify({n: items.length, drew, info});`],
  ["Libraries views survive address round trip and missing drawings", "", `
    const P = proj(), sheet = P.sheets.find(s => s.svg); if (!sheet) return "skip";
    P.libraries = [{ lib: "Parts", item: "SOT23", kind: "footprint", status: "modified", file: "f", size: sheet.size, svg: sheet.svg, pins_diff: [], used_by: [], warnings: [] },
                   { lib: "Parts", item: "LDO", kind: "symbol", status: "added", file: "f", svg: { base: null, head: null }, pins_diff: [], used_by: [], warnings: [], note: "no drawing" }];
    renderNav();
    applyState(decodeState("#p=" + S.p + "&v=lib:1")); await new Promise(r => setTimeout(r, 300));
    return S.v === "lib:1" && document.querySelector("#stage .empty") !== null || JSON.stringify({v: S.v});`],

  ["mode activation retains keyboard focus", "", `
    const b = document.querySelector('#modes [data-mode="overlay"]'); b.focus(); b.click();
    return document.activeElement === document.querySelector('#modes [data-mode="overlay"]') || document.activeElement.tagName;`],
  ...['[data-tab="checks"]', 'select.kind', '[data-check-scope="all"]'].map(selector => [`panel activation retains keyboard focus on ${selector}`, selector.includes("data-check-") ? "p=1&t=checks" : "p=1", `
    const selector = '${selector}', b = document.querySelector("#panel " + selector); b.focus();
    if (b.matches("select")) { b.value = b.options[1].value; b.dispatchEvent(new Event("change")); } else b.click();
    return document.activeElement === document.querySelector("#panel " + selector) || document.activeElement.tagName;`]),
  ["show-all activation retains keyboard focus when its button disappears", "p=1&t=checks", `
    S.checks.error = S.checks.warning = false; renderPanel();
    const b = document.querySelector("#panel .show-all"); b.focus(); b.click();
    return document.activeElement === document.querySelector('#panel [data-check-scope="all"]') && document.querySelectorAll("#panel .viol").length > 0 || document.activeElement.tagName;`],
  ...["pasted", "hashchange"].map(path => [`${path} selection-only address opens its drawing`, "", `
    const row = proj().changes.find(r => r.where?.board && rowBox(r, "head")); if (!row) return "skip";
    await new Promise(r => setTimeout(r, 400));
    const hash = "#p=0&s=" + row.id;
    if ("${path}" === "pasted") { const input = document.querySelector("#report-review-bar .goto"); input.value = hash; input.dispatchEvent(new Event("change")); }
    else location.hash = hash;
    const until = performance.now() + 5000, box = rowBox(row, "head");
    while ((S.v !== "board" || S.x == null || Math.abs(S.x - (box[0] + box[2]) / 2) >= .01) && performance.now() < until) await new Promise(r => setTimeout(r, 50));
    return S.v === "board" && S.s === row.id && Math.abs(S.x - (box[0] + box[2]) / 2) < .01 && !!document.querySelector("#stage .marker.sel") || JSON.stringify({view:S.v, selection:S.s, x:S.x});`]),
  ["pasted selection address preserves an explicit position", "", `
    const row = proj().changes.find(r => r.where?.board && rowBox(r, "head")); if (!row) return "skip";
    applyGoTo("#p=0&v=board&s=" + row.id + "&x=10&y=20&z=5");
    await new Promise(r => setTimeout(r, 800));
    return S.x === 10 && S.y === 20 && S.z === 5 && S.s === row.id;`],
  ["reloading a saved sheet address keeps its explicit view", "", `
    const P = proj(), row = P.changes.find(r => r.where?.sheet && rowBox(r, "head"));
    await goTo(row.id);
    const sheet = P.sheets.find(s => s.path === row.where.sheet);
    P.sheets.push({...sheet, path:"/second/", name:"Second sheet", status:"unchanged", svg:null}); renderNav();
    document.querySelector('#nav [data-view="sheet:/second/"]').click();
    await new Promise(r => setTimeout(r, 400));
    const saved = location.hash; S.v = null; S.s = null;
    history.replaceState(null, "", saved); await start();
    return S.v === "sheet:/second/" && S.s === row.id || JSON.stringify({saved, view:S.v, selection:S.s});`],
  ["unchanged sheet selection saves the address", "", `
    const sheet = proj().sheets.find(s => s.status === "unchanged" && !s.svg); if (!sheet) return "skip";
    await new Promise(r => setTimeout(r, 400));
    document.querySelector('#nav [data-view="sheet:' + sheet.path + '"]').click();
    await new Promise(r => setTimeout(r, 400));
    return new URLSearchParams(location.hash.slice(1)).get("v") === "sheet:" + sheet.path || location.hash;`],
  ["unchanged project selection saves the address", "", `
    const i = D.projects.findIndex(p => !p.board.changed && p.sheets.length && p.sheets.every(s => !s.svg)); if (i < 0) return "skip";
    await new Promise(r => setTimeout(r, 400));
    const select = document.querySelector("#proj"); select.value = i; select.dispatchEvent(new Event("change"));
    await new Promise(r => setTimeout(r, 400));
    return new URLSearchParams(location.hash.slice(1)).get("p") === String(i) || location.hash;`],
  ["3D base-only models mark removals in overlay and changes only", "v=3d", `
    if (!REVIEW_DATA.projects[0].board.model3d) return "skip";
    const p = REVIEW_DATA.projects[0], stage = document.querySelector("#stage"), project = {...p, board:{...p.board, model3d:{...p.board.model3d, head:null}}, changes:[{...p.changes.find(c => c.ref === "J2"), action:"removed"}]};
    const facts = [];
    for (const m of ["overlay", "semantic"]) {
      await Review3D.show(stage, project, {...S, m, s:null});
      const h = Review3D.state.highlights.find(h => h.ref === "J2" && h.side === "base" && h.action === "removed");
      facts.push(!!h && h.marker.el.textContent.includes("− J2") && h.materials.some((material, i) => material !== h.original[i]));
    }
    return facts.every(Boolean) || JSON.stringify(facts);`],
  ["3D cancelled GLB loads dispose parsed resources", "v=3d", `
    if (!REVIEW_DATA.projects[0].board.model3d) return "skip";
    const p = REVIEW_DATA.projects[0], stage = document.querySelector("#stage"), loader = THREE3D.GLTFLoader.prototype, parse = loader.parseAsync, resources = new Set(), disposed = new Set();
    let release, parsed = 0;
    const gate = new Promise(r => release = r);
    loader.parseAsync = async function(...args) {
      const g = await parse.apply(this, args);
      g.scene.traverse(o => [o.geometry, ...[o.material].flat().filter(Boolean).flatMap(m => [m, m.map])].filter(Boolean).forEach(r => {
        if (!resources.has(r)) r.addEventListener("dispose", () => disposed.add(r)); resources.add(r);
      }));
      parsed++; await gate; return g;
    };
    try {
      const cancelled = Review3D.show(stage, p, {...S, s:null});
      while (parsed < new Set(['base','head'].filter(side=>p.board.model3d[side]).map(side=>p.board.assets3d?.[side]?.model?.digest||p.board.model3d[side])).size) await new Promise(r => setTimeout(r, 20));
      await Review3D.show(stage, {...p, board:{...p.board, model3d:{}, no_model:[]}}, {...S, m:"overlay", s:null});
      release(); await cancelled;
      return resources.size > 0 && disposed.size === resources.size || JSON.stringify({parsed, resources:resources.size, disposed:disposed.size});
    } finally { release(); loader.parseAsync = parse; }
  `],
  ["3D cleanup frees replaced outlines and scene resources", "v=3d&m=overlay", `
    if (!REVIEW_DATA.projects[0].board.model3d) return "skip";
    const p = REVIEW_DATA.projects[0], change = p.changes.find(c => c.ref === "J2"), seen = {}, watch = (name, resource) => { seen[name] = false; resource?.addEventListener("dispose", () => { seen[name] = true; }); };
    Review3D.focus(change);
    const st = Review3D.state, old = st.selected[0];
    watch("replaced geometry", old.geometry); watch("replaced material", old.material);
    Review3D.focus(change);
    const replaced = seen["replaced geometry"] && seen["replaced material"];
    watch("outline geometry", st.selected[0].geometry); watch("outline material", st.selected[0].material);
    let ghost, base, block;
    st.ghosts[0].object.traverse(o => { if (o.isMesh) ghost = o.material; });
    st.roots[0].traverse(o => { if (o.isMesh) base = o.geometry; });
    st.blocks[0].object.traverse(o => { if (o.isMesh) block = o.material.map; });
    watch("ghost material", ghost); watch("detached base geometry", base); watch("placeholder texture", block);
    Review3D.dispose();
    return replaced && Object.values(seen).every(Boolean) || JSON.stringify({replaced, ...seen});`],
  ["3D camera animation stops with its owning session", "v=3d", `
    if (!REVIEW_DATA.projects[0].board.model3d) return "skip";
    const p = REVIEW_DATA.projects[0], stage = document.querySelector("#stage"), change = p.changes.find(c => c.ref === "J2"), raf = window.requestAnimationFrame;
    const facts = [];
    for (const reopen of [false, true]) {
      await Review3D.show(stage, p, {...S, s:null});
      const st = Review3D.state, ticks = []; let updates = 0;
      st.controls.forEach(c => { const update = c.update; c.update = (...a) => { updates++; return update.apply(c, a); }; });
      window.requestAnimationFrame = tick => { ticks.push(tick); return 1; };
      Review3D.focus(change); window.requestAnimationFrame = raf;
      Review3D.dispose();
      if (reopen) await Review3D.show(stage, p, {...S, s:null});
      const camera = Review3D.cameraState(); let error = false;
      try { ticks.forEach(tick => tick(performance.now() + 500)); } catch { error = true; }
      facts.push(ticks.length > 0 && !error && updates === 0 && JSON.stringify(camera) === JSON.stringify(Review3D.cameraState()));
    }
    return facts.every(Boolean) || JSON.stringify(facts);`],
  ...["worker-start","worker-postMessage-throws","worker-messageerror","worker-error","corrupt-model","context-loss","late-parse"].map(fault=>[
 "BR02 processed session fault "+fault,"v=3d&m=side",`
 if(!proj().board.parts3d)return 'skip';
 const fault=${JSON.stringify(fault)}, p=structuredClone(proj()), stage=document.querySelector('#stage');
 const NativeWorker=window.Worker, Loader=window.THREE3D.GLTFLoader;
 const parse=Loader.prototype.parseAsync;let release;
 const createURL=URL.createObjectURL,revokeURL=URL.revokeObjectURL,liveURLs=new Set();
 URL.createObjectURL=function(...args){const url=createURL.apply(this,args);liveURLs.add(url);return url;};
 URL.revokeObjectURL=function(url){liveURLs.delete(url);return revokeURL.call(this,url);};
 try {
   if(fault==='worker-start')window.Worker=class {constructor(){throw Error('BR02 injected worker failure')}};
   if(fault==='worker-postMessage-throws')window.Worker=class {
     constructor(...args){const worker=new NativeWorker(...args);worker.postMessage=()=>{throw Error('BR02 injected postMessage failure')};return worker;}
   };
   if(fault==='worker-error'||fault==='worker-messageerror')window.Worker=class {
     constructor(...args){const worker=new NativeWorker(...args);
       queueMicrotask(()=>worker.dispatchEvent(new Event(fault==='worker-error'?'error':'messageerror')));
       return worker;}
   };
   if(fault==='corrupt-model') {
     p.board.model3d.head='br02-corrupt';REVIEW_DATA.blobs['br02-corrupt']='not base64!';
   }
   if(fault==='late-parse') {
     let first=true;
     Loader.prototype.parseAsync=async function(...args) {
       const model=await parse.apply(this,args);
       if(first){first=false;await new Promise(r=>release=r)}return model;
     };
     const old=Review3D.show(stage,p,S);
     for(let i=0;i<200&&!release;i++)await new Promise(r=>setTimeout(r,10));
     if(!release)return 'injected parse was never reached';
     Review3D.dispose();Loader.prototype.parseAsync=parse;
     await Review3D.show(stage,p,S);const current=Review3D.state, canvases=[...stage.querySelectorAll('canvas')];
     // Assert ownership, not a per-side renderer count: shared rendering uses the same contract.
     const ownedCanvases=new Set(current.renderers.map(renderer=>renderer.domElement));
     if(!current.firstFrame||!canvases.length||canvases.length!==ownedCanvases.size||canvases.some(canvas=>!ownedCanvases.has(canvas)))return 'new session canvas ownership mismatch';
     release();await old;
     if(Review3D.state!==current)return 'late parse replaced newer session';
     const settledCanvases=[...stage.querySelectorAll('canvas')];
     if(settledCanvases.length!==canvases.length||settledCanvases.some((canvas,i)=>canvas!==canvases[i]))return 'late parse resurrected canvas';
     if(current.loading)return 'new session still loading';
     Review3D.dispose();
     return Object.values(current.resourceCounts).every(n=>n===0)||'late parse session leaked owned resources';
   }
   await Review3D.show(stage,p,S);
   if(fault==='context-loss') {
     const canvas=document.querySelector('#stage canvas');if(!canvas)return 'no model canvas';
     canvas.dispatchEvent(new Event('webglcontextlost',{cancelable:true}));
   }
   const st=Review3D.state;
   if(fault==='worker-postMessage-throws'&&st.resourceCounts.pending!==0)return 'postMessage leaked pending job';
   if(['worker-start','worker-error','worker-messageerror'].includes(fault)&&
      (st.resourceCounts.urls!==liveURLs.size||liveURLs.size!==2))return 'failed worker retained blob URL: '+JSON.stringify({counts:st.resourceCounts,live:liveURLs.size});
   if(st.loading)return 'failure left loading unsettled';
   if(!st.errorsBySide.head)return 'head error not recorded';
   if(fault!=='corrupt-model'&&st.firstFrame)return 'failure reported a genuine first frame';
   if(!document.querySelector('#stage [data-poster="head"]:not([hidden])'))return 'head poster lost';
   if(fault==='corrupt-model'&&!st.roots[0])return 'valid base lost';
   if(!document.querySelector('#stage [data-3d-retry]'))return 'no accessible retry';
   if(fault==='worker-start'||fault==='context-loss') {
     window.Worker=NativeWorker;
     const oldCanvas=stage.querySelector('canvas');
     stage.querySelector('[data-3d-retry]').click();
     for(let i=0;i<300&&!Review3D.state.firstFrame;i++)await new Promise(r=>setTimeout(r,10));
     if(!Review3D.state.firstFrame)return 'retry did not restore model';
     if(fault==='context-loss'&&stage.querySelector('canvas')===oldCanvas)return 'retry kept lost context';
   }
   Review3D.dispose();
   const counts=Review3D.state.resourceCounts;
   return counts.workers===0&&counts.urls===0&&counts.pending===0||'session leaked owned resources';
 } finally {
   release?.();window.Worker=NativeWorker;Loader.prototype.parseAsync=parse;
   delete REVIEW_DATA.blobs['br02-corrupt'];
   Review3D.dispose();URL.createObjectURL=createURL;URL.revokeObjectURL=revokeURL;
 }
 `]),
  ["BR02 processed poster errors preserve model and explain missing fallback", "v=3d&m=side", `
    if(!proj().board.parts3d)return 'skip';
    const p=structuredClone(proj()),stage=document.querySelector('#stage');
    REVIEW_DATA.blobs['br02-bad-poster']='not base64!';
    try {
      p.board.poster3d.head='br02-bad-poster';
      await Review3D.show(stage,p,S);
      const st=Review3D.state;
      if(!st.posterErrorsBySide.head||st.posterBySide.head||st.errorsBySide.head||!st.firstFrame||!st.roots[1])return 'poster failure killed usable model or lost diagnostic';
      p.board.model3d.head='br02-bad-poster';
      await Review3D.show(stage,p,S);
      const current=Review3D.state,notice=[...stage.querySelectorAll('.error3d')].find(n=>n.textContent.includes(current.posterErrorsBySide.head));
      if(!notice||!notice.querySelector('[data-3d-retry]')||!current.roots[0]||current.loading)return 'missing poster fallback not explained';
      return true;
    } finally { Review3D.dispose();delete REVIEW_DATA.blobs['br02-bad-poster']; }
  `],
  ["BR02 processed corrupt part index keeps the model and warns for its side", "v=3d&m=side", `
    if(!proj().board.parts3d)return 'skip';
    const p=structuredClone(proj()),stage=document.querySelector('#stage');
    try {
      await Review3D.show(stage,p,S);
      const ok=Review3D.state.parts;
      if(!ok.base.length||!ok.head.length||!ok.head.every(x=>x.bounds?.isBox3&&!x.bounds.isEmpty()))return 'valid indexes not installed with bounds';
      if(Object.keys(Review3D.state.errorsBySide).length)return 'valid indexes warned';
      Review3D.dispose();
      p.board.parts3d={...p.board.parts3d,head:'br02-corrupt'};REVIEW_DATA.blobs['br02-corrupt']='not base64!';
      await Review3D.show(stage,p,S);
      const st=Review3D.state;
      if(st.parts.head.length!==0)return 'corrupt index installed parts';
      if(st.firstFrame!==true)return 'corrupt optional index killed the model';
      const head=st.roots[1],view=st.views.find(v=>v.side==='head');
      let renderable=false;head?.traverse(n=>{if(n.isMesh&&n.visible&&n.geometry?.getAttribute('position')?.count)renderable=true;});
      if(!head||!renderable||!view||!view.visible||view.failed||view.host.hidden||!view.scene.getObjectById(head.id)||!(view.calls>0))return 'corrupt index lost renderable Head view';
      if(st.errorsBySide.base)return 'corrupt Head index warned for Base';
      if(!/Part inspection unavailable/.test(st.errorsBySide.head||''))return 'no side-specific warning';
      return true;
    } finally { Review3D.dispose();delete REVIEW_DATA.blobs['br02-corrupt']; }
  `],
  ...['model-first','index-first'].map(order=>[
    'BR02 processed model and index failure order '+order, 'v=3d&m=side', `
    if(!proj().board.parts3d)return 'skip';
    const NativeWorker=window.Worker,stage=document.querySelector('#stage'),gates={};
    const wait=async predicate=>{for(let i=0;i<300&&!predicate();i++)await new Promise(r=>setTimeout(r,10));if(!predicate())throw Error('failure gate timeout');};
    let opening;
    try {
      window.Worker=class extends NativeWorker {
        postMessage(data,...args) {
          if(data.b64==='br02-model-failure'||data.b64==='br02-index-failure') {
            gates[data.b64]=()=>this.onmessage({data:{id:data.id,error:data.b64}});return;
          }
          return super.postMessage(data,...args);
        }
      };
      REVIEW_DATA.blobs['br02-model-failure']='br02-model-failure';
      REVIEW_DATA.blobs['br02-index-failure']='br02-index-failure';
      for(const mode of ['overlay','blend','semantic']) {
        const p=structuredClone(proj());
        p.board.model3d.head='br02-model-failure';p.board.parts3d.head='br02-index-failure';
        delete gates['br02-model-failure'];delete gates['br02-index-failure'];
        opening=Review3D.show(stage,p,{...S,m:mode,revision:'head'});
        await wait(()=>gates['br02-model-failure']&&gates['br02-index-failure']);
        const first='${order}'==='model-first'?'br02-model-failure':'br02-index-failure';
        gates[first]();
        await wait(()=>Review3D.state.errorsBySide.head);
        if(first==='br02-index-failure'&&!/^Part inspection unavailable:/.test(Review3D.state.errorsBySide.head))return 'index did not fail first';
        if(first==='br02-model-failure'&&Review3D.state.errorsBySide.head!=='br02-model-failure')return 'model did not fail first';
        gates[first==='br02-model-failure'?'br02-index-failure':'br02-model-failure']();
        await opening;opening=null;
        const st=Review3D.state,poster=st.posterBySide.head,host=poster?.closest('.view3d'),notice=host?.querySelector('.error3d');
        if(st.errorsBySide.head!=='br02-model-failure'||st.errorsBySide.base)return mode+': model diagnostic replaced or Base warned';
        if(!st.roots[0]||st.roots[1]||!st.firstFrame||st.loading||st.parts.head.length)return mode+': valid Base or settled state lost';
        if(!host||host.hidden||getComputedStyle(host).display==='none'||poster.hidden||!notice?.textContent.includes('br02-model-failure')||!notice.querySelector('[data-3d-retry]'))return mode+': failed Head fallback hidden';
        Review3D.dispose();
      }
      return true;
    } finally {
      Object.values(gates).forEach(release=>release());if(opening)await opening;
      Review3D.dispose();window.Worker=NativeWorker;
      delete REVIEW_DATA.blobs['br02-model-failure'];delete REVIEW_DATA.blobs['br02-index-failure'];
    }
  `]),
  ["BR02 processed loading aggregates outstanding sides", "v=3d&m=side", `
 if(!proj().board.parts3d)return 'skip';
 const Loader=THREE3D.GLTFLoader,original=Loader.prototype.parseAsync,releases=[];
 let opening;
 try {
   Loader.prototype.parseAsync=async function(...args){await new Promise(r=>releases.push(r));return original.apply(this,args);};
   opening=Review3D.show(document.querySelector('#stage'),proj(),S);
   for(let i=0;i<300&&releases.length<2;i++)await new Promise(r=>setTimeout(r,10));
   const st=Review3D.state;
   if(releases.length!==2)return 'both revision parse gates not reached';
   if(st.firstFrame||!['base','head'].every(side=>st.posterBySide[side]&&!st.posterBySide[side].hidden))return 'poster missing before a real model frame';
   if(st.changedParts!==new Set(proj().changes.filter(c=>c.kind==='footprint').map(c=>c.uuid||c.ref)).size)return 'changed footprint identity count incorrect';
   if(!st.loadingBySide.base||!st.loadingBySide.head||!st.loading)return 'aggregate loading false while requests outstanding';
   releases.shift()();
   for(let i=0;i<300&&st.loadingBySide.base&&st.loadingBySide.head;i++)await new Promise(r=>setTimeout(r,10));
   if(!st.loading||!Object.values(st.loadingBySide).some(Boolean)||Object.values(st.loadingBySide).every(Boolean))return 'aggregate did not retain the outstanding side';
   releases.shift()();await opening;
   return !st.loading&&!st.loadingBySide.base&&!st.loadingBySide.head||'aggregate failed to settle';
 } finally {
   Loader.prototype.parseAsync=original;releases.forEach(r=>r());if(opening)await opening;
 }
`],
  ["BR02 processed empty model cannot fake a first frame", "v=3d&m=side", `
    if(!proj().board.parts3d)return 'skip';
    const p=structuredClone(proj());
    const data=JSON.stringify({asset:{version:'2.0'},scenes:[{nodes:[]}],scene:0,nodes:[]});
    const bytes=new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    REVIEW_DATA.blobs['br02-empty']=btoa(String.fromCharCode(...bytes));
    try {
      p.board.model3d.base=p.board.model3d.head='br02-empty';
      await Review3D.show(document.querySelector('#stage'),p,S);
      const st=Review3D.state;
      return !st.firstFrame&&!st.loading&&['base','head'].every(side=>st.posterBySide[side]&&!st.posterBySide[side].hidden&&st.errorsBySide[side])||'empty model/placeholder reported first frame';
    } finally {delete REVIEW_DATA.blobs['br02-empty'];Review3D.dispose();}
  `],
  ["BR02 processed WebGL unavailable retains posters", "v=3d&m=side", `
    if(!proj().board.parts3d)return 'skip';
    const proto=HTMLCanvasElement.prototype, get=proto.getContext;
    try {
      proto.getContext=function(type,...args){return /webgl/.test(type)?null:get.call(this,type,...args)};
      await Review3D.show(document.querySelector('#stage'),proj(),S);
      const st=Review3D.state;
      return !st.loading&&!st.firstFrame&&['base','head'].every(side=>st.posterBySide[side]&&!st.posterBySide[side].hidden&&st.errorsBySide[side])&&!!document.querySelector('[data-3d-retry]')||'WebGL fallback lost poster/state';
    } finally {proto.getContext=get;Review3D.dispose();}
  `],
  ["BR02 processed absent revision never borrows poster", "v=3d&m=side", `
    if(!proj().board.parts3d)return 'skip';
    const p=structuredClone(proj());delete p.board.model3d.head;delete p.board.poster3d.head;
    delete p.board.parts3d.head;delete p.board.assets3d;
    await Review3D.show(document.querySelector('#stage'),p,S);
    const hosts=document.querySelectorAll('#stage .view3d'),st=Review3D.state;
    if(st.loading||st.roots[1]||!st.roots[0]||!hosts[1].textContent.includes('Board not in this revision')||hosts[1].querySelector('img'))return 'absent revision borrowed model/poster';
    if(S.phone) {
      // Plan Global Constraints / Dependencies on 05: Side keeps the requested revision,
      // including its explicit empty state. The spec's Base/Head switch reaches Base;
      // an absent Head must never silently draw Base or count it as Head's first frame.
      if(st.firstFrame||hosts[1].hidden||!hosts[0].hidden||st.visibleSides.join()!=='head')return 'absent requested Head drew the Base revision';
      Review3D.setRevision('base');await Review3D.sampleFrame();
      if(hosts[0].hidden||!hosts[1].hidden||st.visibleSides.join()!=='base')return 'available Base could not be reached';
    }
    return st.firstFrame&&st.posterBySide.base.hidden||'available Base never drew a genuine frame';
  `],
  ["BR02 processed cancelled vendor decode cannot revive session", "", `
    if(!proj().board.parts3d)return 'skip';
    const NativeWorker=window.Worker;let blocked=false,opening;
    try {
      window.Worker=class {constructor(...args){const worker=new NativeWorker(...args);worker.postMessage=()=>{blocked=true};return worker;}};
      opening=Review3D.show(document.querySelector('#stage'),proj(),{...S,m:'side'});
      for(let i=0;i<300&&!blocked;i++)await new Promise(r=>setTimeout(r,10));
      const old=Review3D.state;
      if(!blocked||old.resourceCounts.pending!==1)return 'vendor decode was not gated';
      Review3D.dispose();window.Worker=NativeWorker;
      await Review3D.show(document.querySelector('#stage'),proj(),{...S,m:'side'});
      const current=Review3D.state;await opening;
      return Review3D.state===current&&current.firstFrame&&!current.loading&&Object.values(old.resourceCounts).every(n=>n===0)||'cancelled vendor decode revived/leaked session';
    } finally {window.Worker=NativeWorker;Review3D.dispose();if(opening)await opening;}
  `],
  ["BR02 processed bundle failure retries without cached rejection", "", `
    if(!proj().board.parts3d)return 'skip';
    const tag=document.querySelector('#three-bundle'),source=tag.textContent;
    try {
      tag.textContent=btoa('not gzip');
      await Review3D.show(document.querySelector('#stage'),proj(),{...S,m:'side'});
      const st=Review3D.state;
      if(st.loading||st.firstFrame||!st.posterBySide.head||st.posterBySide.head.hidden)return 'bundle failure lost fallback';
      tag.textContent=source;document.querySelector('[data-3d-retry]').click();
      for(let i=0;i<300&&!Review3D.state.firstFrame;i++)await new Promise(r=>setTimeout(r,10));
      return Review3D.state.firstFrame&&!Review3D.state.loading||'bundle rejection was cached';
    } finally {tag.textContent=source;Review3D.dispose();}
  `],
  ...['worker-start','context-loss'].map(fault=>[
    'BR02 processed fallback whole screen '+fault,'v=3d&m=side', `
    if(!proj().board.parts3d)return 'skip';
    // The shared shell is owned by 05; require the whole viewport to fit.
    const Worker=window.Worker;
    try {
      if('${fault}'==='worker-start')window.Worker=class {constructor(){throw Error('3D worker unavailable. Retry.')}};
      await Review3D.show(document.querySelector('#stage'),proj(),S);
      if('${fault}'==='context-loss')document.querySelector('#stage canvas').dispatchEvent(new Event('webglcontextlost',{cancelable:true}));
      const button=[...document.querySelectorAll('[data-3d-retry]')].find(b=>b.getClientRects().length);button?.focus();
      const rect=button?.getBoundingClientRect();
      return document.documentElement.scrollWidth<=innerWidth&&rect&&rect.width>0&&rect.left>=0&&rect.right<=innerWidth&&rect.top>=0&&rect.bottom<=innerHeight&&document.activeElement===button&&!!document.querySelector('[role="alert"]')||JSON.stringify({scrollWidth:document.documentElement.scrollWidth,width:innerWidth,height:innerHeight,rect:rect?.toJSON(),focused:document.activeElement===button,alert:!!document.querySelector('[role="alert"]'),overflow:[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>innerWidth+1).slice(0,12).map(e=>({tag:e.tagName,id:e.id,class:e.className,right:e.getBoundingClientRect().right}))});
    } finally {window.Worker=Worker;}
  `]),
  ["3D bad model data settles and keeps the valid side", "v=3d", `
    if (!REVIEW_DATA.projects[0].board.model3d) return "skip";
    const p = REVIEW_DATA.projects[0], stage = document.querySelector("#stage"), good = p.board.model3d.head;
    const gzip = async text => btoa(String.fromCharCode(...new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer())));
    const bad = [btoa("not gzip"), await gzip("not GLB")];
    const facts = [];
    for (const blob of bad) for (const both of [false, true]) for (const side of ["base", "head"]) {
      REVIEW_DATA.blobs.__bad3d = blob;
      const project = {...p, board:{...p.board, no_model:[], model3d:{base:both || side === "base" ? "__bad3d" : good, head:both || side === "head" ? "__bad3d" : good}}};
      const result = await Promise.race([Review3D.show(stage, project, {...S, s:null}).then(() => "done"), new Promise(r => setTimeout(() => r("pending"), 3000))]);
      facts.push(result === "done" && !stage.querySelector(".loading") && stage.textContent.includes("3D model could not be loaded") && !stage.textContent.includes("Board not in this revision") && !stage.textContent.includes("No 3D board model was exported") && (both ? !!stage.querySelector(".empty") : !!Review3D.state.roots[side === "base" ? 1 : 0] && !Review3D.state.roots[side === "base" ? 0 : 1]));
      Review3D.dispose();
    }
    return facts.every(Boolean) || JSON.stringify(facts);`],
  ["3D bundle failure leaves Loading", "", `
    if (!REVIEW_DATA.projects[0].board.model3d) return "skip";
    document.querySelector("#three-bundle").textContent = btoa("not gzip");
    const stage = document.querySelector("#stage");
    const result = await Promise.race([Review3D.show(stage, REVIEW_DATA.projects[0], {...S, s:null}).then(() => "done", () => "rejected"), new Promise(r => setTimeout(() => r("pending"), 3000))]);
    return result === "done" && !stage.querySelector(".loading") && !!stage.textContent.trim() || result;`],
  ...["side", "overlay"].map(mode => [mode === "side" ? "3D theme switch recolours in place" : "3D theme switch recolours overlay ghosts in place", `v=3d&m=${mode}&s=c2`, `
    if (!REVIEW_DATA.projects[0].board.model3d) return "skip";
    while (!window.Review3D?.state?.firstFrame) await new Promise(r => setTimeout(r, 50));
    await new Promise(r => setTimeout(r, 800));
    const st = Review3D.state, {THREE} = THREE3D, h = st.highlights.find(x => x.ref === "J2" && x.side === "head"), before = {camera:st.cameras.map(c => c.position.toArray()), parses:st.parseCount, highlight:h.materials[0].color.getHexString(), outline:st.selected[0].material.color.getHexString(), clear:getComputedStyle(document.querySelector('#stage')).backgroundColor}, dark = KRTheme.get() === "light";
    await new Promise(r => { window.__themeFlipped = r; window.__flipTheme(dark ? "dark" : "light"); });
    const until = performance.now() + 3000;
    while (getComputedStyle(document.querySelector('#stage')).backgroundColor === before.clear && performance.now() < until) await new Promise(r => setTimeout(r, 25));
    const css = getComputedStyle(document.documentElement), token = n => new THREE.Color(css.getPropertyValue(n).trim()), facts = {
      clear:st.renderers.every(r => r.getClearAlpha() === 0) && new THREE.Color(getComputedStyle(document.querySelector("#stage")).backgroundColor).equals(token(dark ? "--bg" : "--paper")),
      highlight:h.materials.every((m,i) => m.color.equals(h.original[i].color.clone().lerp(token("--modified"), .7)) && (!m.emissive || m.emissive.equals(token("--modified")))),
      outline:st.selected.every(o => o.material.color.equals(token("--accent"))),
      changed:before.highlight !== h.materials[0].color.getHexString() && before.outline !== st.selected[0].material.color.getHexString() && before.clear !== getComputedStyle(document.querySelector("#stage")).backgroundColor,
      camera:JSON.stringify(before.camera) === JSON.stringify(st.cameras.map(c => c.position.toArray())), parses:before.parses === st.parseCount && st.parseCount === new Set(Object.values(st.modelDigests)).size, selection:S.s === "c2", same:st === Review3D.state,
      marker:getComputedStyle(h.marker.el).color === (() => { const e=document.createElement("span");e.style.color="var(--modified)";document.body.append(e);const c=getComputedStyle(e).color;e.remove();return c; })(),
      ghosts:true
    };
    if ("${mode}" === "overlay") st.ghosts.forEach(g => g.object.traverse(o => { if (o.isMesh && !o.material.color.equals(token("--removed"))) facts.ghosts=false; }));
    return Object.values(facts).every(Boolean) || JSON.stringify(facts);`]),

  ["3D navigator appears only for opted-in data", "", `
    return !!REVIEW_DATA.projects[0].board.model3d === !!document.querySelector('#nav [data-view="3d"]');`],
  ["3D loads GLBs with named component nodes", "v=3d", `
    if (!REVIEW_DATA.projects[0].board.model3d) return "skip";
    await new Promise(r => setTimeout(r, 5000));
    const n = window.Review3D.state.nodes || [];
    return document.querySelectorAll('#stage canvas').length === 1 && window.Review3D.state.roots.filter(Boolean).length === 2 && n.includes("J2") && n.includes("C20");`],
  ["3D camera buttons change the camera", "v=3d", `
    if (!REVIEW_DATA.projects[0].board.model3d) return "skip";
    await new Promise(r => setTimeout(r, 5000));
    const a = window.Review3D.state.cameras[0].position.toArray().join(","); document.querySelector('[data-3d-camera="top"]').click();
    return a !== window.Review3D.state.cameras[0].position.toArray().join(",");`],
  ["3D preset uses world-up and sits above the board", "v=3d", `
    if (!REVIEW_DATA.projects[0].board.model3d) return "skip";
    await new Promise(r => setTimeout(r, 5000));
    document.querySelector('[data-3d-camera="top"]').click(); document.querySelector('[data-3d-camera="3d"]').click();
    const d = window.Review3D.state;
    return d.cameras.every(c => c.up.x === 0 && c.up.y === 1 && c.up.z === 0 && c.position.y > d.box.max.y);`],
  ["3D camera movement is linked and leaving disposes", "v=3d", `
    if (!REVIEW_DATA.projects[0].board.model3d) return "skip";
    await new Promise(r => setTimeout(r, 5000));
    const d = window.Review3D.state, r = window.__3dInputResult;
    const delta = (p, q) => Math.hypot(...p.map((v, i) => v - q[i]));
    const linked = r && delta(r.after[0], r.before[0]) > .001 && delta(r.after[0], r.after[1]) < .001;
    await select("board"); return linked && window.Review3D.state.disposed === true;`],
  ["3D changed footprints use cloned highlight materials", "v=3d&m=side", `
    if (!REVIEW_DATA.projects[0].board.model3d) return "skip";
    await new Promise(r => setTimeout(r, 5000));
    const h = window.Review3D.state.highlights || [], refs = new Set(h.map(x => x.ref));
    return ["J2", "C20"].every(ref => refs.has(ref) && h.some(x => x.ref === ref && x.materials.some((m, i) => m !== x.original[i])));`],
  ["3D glyph marker labels are visible over their canvas", "v=3d&m=side", `
    if (!REVIEW_DATA.projects[0].board.model3d) return "skip";
    await new Promise(r => setTimeout(r, 5000));
    const l = document.querySelector('.marker3d[data-ref="J2"]'), c = l?.closest(".view3d"), a = l?.getBoundingClientRect(), b = c?.getBoundingClientRect();
    return !!l && l.textContent.includes("≡ J2") && a.left >= b.left && a.right <= b.right && a.top >= b.top && a.bottom <= b.bottom;`],
  ["3D Overlay shows old-position ghosts", "v=3d&m=overlay", `
    if (!REVIEW_DATA.projects[0].board.model3d) return "skip";
    await new Promise(r => setTimeout(r, 5000));
    const d = window.Review3D.state, g = d.ghosts.find(x => x.ref === "J2"), h = d.highlights.find(x => x.ref === "J2" && x.side === "head");
    if(!g||!h)return 'ghost or head marker absent';
    const base=d.roots[0].getObjectByName('J2'),head=d.roots[1].getObjectByName('J2');
    d.roots.forEach(r=>r.updateMatrixWorld(true));g.object.updateMatrixWorld(true);
    const same=base.matrixWorld.elements.every((v,i)=>Math.abs(v-g.object.matrixWorld.elements[i])<1e-7);
    const box=new THREE3D.THREE.Box3().setFromObject(head),position=box.getCenter(new THREE3D.THREE.Vector3());position.y=box.max.y+.004;
    return same&&position.distanceTo(h.marker.position)<1e-7||'ghost offset or head marker moved';`],
  ["3D Blend slider and B switch cross-fade without moving camera", "v=3d&m=blend", `
    if (!REVIEW_DATA.projects[0].board.model3d) return "skip";
    await new Promise(r => setTimeout(r, 5000));
    const d = window.Review3D.state, r = document.querySelector("#modes input[type=range]"); r.value = 20; r.dispatchEvent(new Event("input"));
    const faded = d.blend === .2, p = d.cameras[0].position.toArray(); document.dispatchEvent(new KeyboardEvent("keydown", { key:"b" }));
    return faded && d.blend === 1 && p.join(",") === d.cameras[0].position.toArray().join(",");`],
  ["3D Changes only fades unchanged components and disables Wipe", "v=3d&m=semantic", `
    if (!REVIEW_DATA.projects[0].board.model3d) return "skip";
    await new Promise(r => setTimeout(r, 5000));
    const u = window.Review3D.state.roots[1]?.getObjectByName('U4'), m=[];
    u?.traverse(n=>{if(n.isMesh)m.push(...[n.material].flat());});const faded=m.length&&m.every(m=>m.opacity===.12);
    return !!faded && document.querySelector('[data-mode="wipe"]').getAttribute("aria-disabled") === "true";`],
  ["loads sample", "", `return REVIEW_DATA.version === 1 && document.querySelector("#nav") !== null;`],
  ["header shows repo, revisions, review link and verdict", "", `
    // Bench: breadcrumb in the header, revisions and PR link in the review bar, verdict in the header readout.
    const h = document.querySelector(".report-chrome").textContent;
    return h.includes("kicad-review-test") && h.includes(REVIEW_DATA.head.slice(0, 7))
      && document.querySelector('.report-chrome a[href$="/pull/2"]') !== null && /failing|passing|needs work/i.test(h);`],
  ["navigator lists every project, sheet and board with counts", "", `
    let boards = 0, ok = true;
    for (let i = 0; i < REVIEW_DATA.projects.length; i++) {
      openProject(i);
      const items = [...document.querySelectorAll("#nav [data-view]")];
      boards += items.filter(e => e.dataset.view === "board").length;
      ok = ok && items.length === REVIEW_DATA.projects[i].sheets.length + 1 && items.every(e => e.querySelector(".counts"));
    }
    return REVIEW_DATA.projects.length === 2 && boards === 2 && ok;`],
  ["unchanged sheet still reachable", "", `
    const sheet = proj().sheets.find(s => s.status === "unchanged"); if (!sheet) return "skip";
    const u = document.querySelector('#nav [data-view="sheet:' + sheet.path + '"]');
    return !!u && !u.hasAttribute("aria-disabled");`],
  ["added project with no base renders without errors", "p=0", `return S.p === 0 && document.querySelector("#nav").textContent.includes("added");`],
  ["address picks project and view; bad values fall back", "p=9&v=sheet:/nope/&x=abc", `
    return S.p === 0 && S.v !== "sheet:/nope/" && Number.isFinite(S.x);`],
  ["sheet draws base and head, side by side", "p=1", `
    await new Promise(r => setTimeout(r, 800));
    return document.querySelectorAll("#stage .vp").length === 2 && document.querySelectorAll("#stage svg").length >= 2;`],
  ["wheel zoom keeps both panes in step", "", `
    await new Promise(r => setTimeout(r, 800));
    const vp = document.querySelector("#stage .vp"), before = S.z;
    vp.dispatchEvent(new WheelEvent("wheel", { deltaY: -300, clientX: 400, clientY: 400, bubbles: true, cancelable: true }));
    await new Promise(r => requestAnimationFrame(r));
    const t = [...document.querySelectorAll("#stage .world")].map(w => w.style.transform);
    return t.length === 2 && t[0] === t[1] && S.z > 0 && S.z !== before;`],
  ["will-change only during a gesture", "", `
    await new Promise(r => setTimeout(r, 800));
    const w = document.querySelector("#stage .world");
    document.querySelector("#stage .vp").dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }));
    const during = getComputedStyle(w).willChange; await new Promise(r => setTimeout(r, 300));
    return during === "transform" && getComputedStyle(w).willChange === "auto";`],
  ["dense board pans at 60 fps", "v=board", `
    if (!REVIEW_DATA.projects[0].name.startsWith("vme")) return "skip";   // only meaningful on the dense page (default layers)
    await new Promise(r => setTimeout(r, 3000));
    const t = []; let last = performance.now();
    for (let f = 0; f < 120; f++) { await new Promise(r => requestAnimationFrame(r)); const n = performance.now(); t.push(n - last); last = n;
      gesture(); setT({ x: S.x + 0.3, z: S.z * (f < 60 ? 1.02 : 1 / 1.02) }); }
    t.sort((a, b) => a - b); console.log("p95", t[114]); return t[114] <= 20;`],
  ["hash without p keeps its other params", "v=board", `return S.p === 0 && S.v === "board";`],
  ["fit frames all drawn content in every pane", "p=1&v=board", `
    await new Promise(r => setTimeout(r, 2500));
    const bad = [];
    if(boardDiff) {
      return boardDiff.panes.every(p=>Object.values(p.scenes).filter(scene=>scene?.objects.length).every(scene=>{
        const [x0,y0,x1,y1]=scene.bounds.map(n=>n/1000);
        return [[x0,y0],[x1,y0],[x0,y1],[x1,y1]].map(q=>p.renderer.project(q))
          .every(([x,y])=>x>=-1&&y>=-1&&x<=p.vp.clientWidth+1&&y<=p.vp.clientHeight+1);
      }) && (Object.values(p.scenes).every(scene=>!scene?.objects.length) || p.renderer.stats.uploads>0));
    }
    for (const vp of document.querySelectorAll("#stage .vp")) {
      const R = vp.getBoundingClientRect();
      for (const l of vp.querySelectorAll(".layer")) {
        let u = null;
        for (const g of l.querySelectorAll("svg > g")) { const r = g.getBoundingClientRect(); if (!r.width && !r.height) continue;
          u = u ? [Math.min(u[0], r.left), Math.min(u[1], r.top), Math.max(u[2], r.right), Math.max(u[3], r.bottom)] : [r.left, r.top, r.right, r.bottom]; }
        if (u && (u[0] < R.left - 1 || u[1] < R.top - 1 || u[2] > R.right + 1 || u[3] > R.bottom + 1)) bad.push(l.dataset.layer + " " + u.map(Math.round) + " in " + [R.left, R.top, R.right, R.bottom].map(Math.round));
      }
    }
    return bad.length ? bad.slice(0, 3).join(" ; ") : document.querySelectorAll("#stage .layer").length > 0;`],
  ...["side", "overlay", "wipe", "blend", "semantic"].map(m => [`mode ${m} draws`, `m=${m}`, `
    await new Promise(r => setTimeout(r, 800));
    return S.m === "${m}" && document.querySelector("#stage").classList.contains("mode-${m}")
      && document.querySelector('#modes [aria-pressed="true"]').dataset.mode === "${m}"
      && (typeof boardDiff!=='undefined' && boardDiff ? boardDiff.panes.every((p,i)=>p.canvas.width>0&&p.canvas.height>0&&p.renderer.stats.draws>0&&boardDiff.readPixel(i,10,10).length===4)
        : [...document.querySelectorAll('#stage svg path, #stage svg line, #stage svg rect, #stage svg circle, #stage svg polyline, #stage svg polygon, #stage svg text')].some(e => { const r = e.getBoundingClientRect(); return (r.width > 0 || r.height > 0) && getComputedStyle(e).visibility === 'visible'; }));`]),
  ["wipe divider exposes its current keyboard position", "m=wipe", `
    await new Promise(r => setTimeout(r, 800));
    const d = document.querySelector('#stage .divider[role="slider"]'), before = S.wipe;
    const initial = d.getAttribute("aria-valuenow") === String(Math.round(S.wipe * 100)); d.focus();
    d.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    return initial && S.wipe > before && d.getAttribute("aria-valuenow") === String(Math.round(S.wipe * 100)) || JSON.stringify({initial, before, wipe:S.wipe, value:d.getAttribute("aria-valuenow")});`],
  ["wipe divider follows drag", "m=wipe", `
    await new Promise(r => setTimeout(r, 800));
    const d = document.querySelector("#stage .divider"), r = d.parentElement.getBoundingClientRect();
    d.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientX: r.left + r.width / 2 }));
    d.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: r.left + r.width * 0.25 }));
    d.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
    return Math.abs(S.wipe - 0.25) < 0.02 && d.getAttribute("aria-valuenow") === String(Math.round(S.wipe * 100));`],
  ["wipe hides base on the head side", "m=wipe", `
    await new Promise(r => setTimeout(r, 800));
    const vp = document.querySelector('#stage .vp'), r = vp.getBoundingClientRect();
    const hits = (fx, side) => { let n = 0; for (let fy = .1; fy < .95; fy += .05) n += document.elementsFromPoint(r.left + r.width*fx, r.top + r.height*fy).filter(e => e.closest('.stack.' + side)).length; return n; };
    S.wipe = .5; apply();
    const baseRight = hits(.75, 'base'), headLeft = hits(.25, 'head'), baseLeft = hits(.25, 'base'), headRight = hits(.75, 'head');
    return baseRight === 0 && headLeft === 0 && baseLeft > 0 && headRight > 0 || JSON.stringify({baseRight, headLeft, baseLeft, headRight});`],
  ["wipe at the ends shows one revision", "m=wipe", `
    await new Promise(r => setTimeout(r, 800));
    const vp = document.querySelector('#stage .vp'), r = vp.getBoundingClientRect();
    const at = (side) => document.elementsFromPoint(r.left + r.width*.5, r.top + r.height*.5).some(e => e.closest('.stack.' + side));
    S.wipe = 0; apply(); const base0 = at('base'), head0 = at('head');
    S.wipe = 1; apply(); const base1 = at('base'), head1 = at('head');
    S.wipe = .5; apply();
    return !base0 && head0 && base1 && !head1 || JSON.stringify({base0, head0, base1, head1});`],
  ["wipe with one revision empty still shows the other", "p=1&m=wipe", `
    await new Promise(r => setTimeout(r, 800));
    const vp = document.querySelector('#stage .vp'), r = vp.getBoundingClientRect();
    const at = (left, side) => { let hit = false; for (let fx = left ? .05 : .55; fx < (left ? .5 : .95); fx += .025) for (let fy = .1; fy < .95; fy += .025) hit ||= document.elementsFromPoint(r.left + r.width*fx, r.top + r.height*fy).some(e => e.closest('.stack.' + side + ' .layer')); return hit; };
    for (const empty of ['base', 'head']) {
      const stack = vp.querySelector('.stack.' + empty), children = [...stack.childNodes];
      try {
        stack.replaceChildren(); S.wipe = .5; apply();
        const baseLeft = at(true, 'base'), baseRight = at(false, 'base'), headLeft = at(true, 'head'), headRight = at(false, 'head');
        if (baseLeft !== (empty === 'head') || headRight !== (empty === 'base') || baseRight || headLeft) return JSON.stringify({empty, baseLeft, baseRight, headLeft, headRight});
      } finally { stack.replaceChildren(...children); apply(); }
    }
    return true;`],
  ["wipe fractional split uses one whole-pixel boundary", "m=wipe", `
    await new Promise(r => setTimeout(r, 800));
    const vp = document.querySelector('#stage .vp'), head = vp.querySelector('.stack.head'), base = vp.querySelector('.stack.base');
    const width = parseFloat(head.style.width), k = S.z / PX;
    try {
      for (const fraction of [.371, .629]) {
        S.wipe = fraction; apply();
        const u = (fraction * vp.clientWidth - (vp.clientWidth / 2 - S.x * S.z)) / k;
        const expected = Math.max(0, Math.min(width, Math.round(u)));
        const inset = stack => stack.style.clipPath.slice(6, -1).split(/ +/).map(parseFloat);
        const h = inset(head), b = inset(base);
        if (Math.abs(h[3] - expected) > .001 || Math.abs(width - b[1] - expected) > .001) return JSON.stringify({u, expected, head:h, base:b});
      }
      return true;
    } finally { S.wipe = .5; apply(); }`],
  ["wipe clip is removed when leaving wipe", "m=wipe", `
    await new Promise(r => setTimeout(r, 800));
    try {
      for (const mode of ['blend', 'overlay']) {
        S.m = mode; await draw();
        if (document.querySelector('#stage').classList.contains('mode-wipe')) return 'still mode-wipe: ' + mode;
        apply();
        const clips = [...document.querySelectorAll('#stage .stack')].map(s => s.style.clipPath).filter(Boolean);
        if (clips.length) return mode + ': ' + JSON.stringify(clips);
        S.m = 'wipe'; await draw();
      }
      return true;
    } finally { S.m = 'wipe'; await draw(); }`],
  ["flipped board wipe hides base on the head side", "p=1&v=board&m=wipe", `
    await new Promise(r => setTimeout(r, 800));
    Appearance.patch({flip:true});
    await new Promise(r => setTimeout(r, 800));
    boardFallback('check');
    await new Promise(r => setTimeout(r, 800));
    if (!document.querySelector('#stage .stack.base')) { Appearance.patch({flip:false}); return 'skip'; }
    const vp = document.querySelector('#stage .vp'), r = vp.getBoundingClientRect();
    S.wipe = .5; apply();
    const at = (fx, side) => { let n = 0; for (let fy = .1; fy < .95; fy += .05) n += document.elementsFromPoint(r.left + r.width*fx, r.top + r.height*fy).filter(e => e.closest('.stack.' + side)).length; return n; };
    // Mirroring reverses stack coordinates, not the screen-space Base/Head sides.
    const out = {baseHeadSide: at(.75, 'base'), headBaseSide: at(.25, 'head'), baseOwnSide: at(.25, 'base'), headOwnSide: at(.75, 'head')};
    Appearance.patch({flip:false});
    return out.baseHeadSide === 0 && out.headBaseSide === 0 && out.baseOwnSide > 0 && out.headOwnSide > 0 || JSON.stringify(out);`],
  ["blend slider sets head opacity", "m=blend", `
    await new Promise(r => setTimeout(r, 800));
    const s = document.querySelector("#modes input[type=range]"); s.value = 20; s.dispatchEvent(new Event("input"));
    if(boardDiff) {
      boardDiff.render();
      const gl=boardDiff.panes[0].renderer.gl;
      const alpha=gl.getUniform(boardDiff.panes[0].program,gl.getUniformLocation(boardDiff.panes[0].program,'headAlpha'));
      return S.blend===.2 && Math.abs(alpha-.2)<1e-6 && boardDiff.readPixel(0,10,10).length===4;
    }
    return getComputedStyle(document.querySelector("#stage .stack.head")).opacity === "0.2";`],
  ["added project draws its one side in every mode", "p=0&m=overlay", `
    await new Promise(r => setTimeout(r, 800)); return document.querySelectorAll("#stage .stack.head svg").length > 0;`],
  ["layer list grouped, changed layers marked", "p=1&v=board&t=appearance", `
    await new Promise(r => setTimeout(r, 800));
    const L = document.querySelector("#appearance-root");
    const want = REVIEW_DATA.projects[1].board.layers, n = L?.querySelectorAll("[data-layer]").length, m = L?.querySelectorAll("[data-layer] .mark").length;
    return !!L && n >= want.length && m === want.filter(l => l.changed).length && document.querySelector("#layers").children.length === 0 || JSON.stringify([!!L, n, want.length, m, want.filter(l => l.changed).length, S.t, S.v]);`],
  ["toggling a layer removes it from the drawing", "p=1&v=board&t=appearance", `
    await new Promise(r => setTimeout(r, 800));
    ${BOARD_POINT_PROBE}
    const point=boardDiff?occupied({layer:'F.Cu'}):null;
    if(boardDiff && !point) return 'no visible F.Cu geometry to test';
    const cb = document.querySelector('#appearance-root [data-layer="F.Cu"] .eye-btn'); cb.click();
    await new Promise(r => setTimeout(r, 800));
    if(point) {
      const {pane,object,screen}=point;
      if(pane.renderer.hitTest(screen).some(o=>o===object)) return 'hidden layer remains hittable';
      pane.renderer.draw({mask:true,filter:o=>o===object});
      const pixel=boardDiff.readPixel(boardDiff.panes.indexOf(pane),...screen); boardDiff.render();
      if(pixel[0]>0) return 'hidden layer still draws geometry';
    }
    return !document.querySelector('#stage .layer[data-layer="F_Cu"]') && !S.layers.includes("F_Cu") && location.hash.includes("l=");`],
  ["layer list hidden for sheets", "", `return document.querySelector("#layers").children.length === 0;`],
  ["hitTest picks the smallest containing box, cycles on repeat", "", `
    const rows = [{ id: "a", box: [0, 0, 10, 10] }, { id: "b", box: [4, 4, 6, 6] }, { id: "c", box: [20, 20, 30, 30] }];
    return hitTest(rows, 5, 5)?.id === "b" && hitTest(rows, 5, 5, rows[1])?.id === "a" && hitTest(rows, 50, 50) === null
      && hitTest(rows, 10.4, 5)?.id === "a";`],
  ["filters by kind and by action", "", `
    const total = document.querySelectorAll("#panel .card").length;
    document.querySelector('#panel .chip-filter[data-action="added"]').click();
    const noAdded = [...document.querySelectorAll("#panel .card")].every(c => c.dataset.action !== "added");
    const kinds = document.querySelector("#panel select.kind"); kinds.value = "symbol"; kinds.dispatchEvent(new Event("change"));
    return total > 0 && noAdded && [...document.querySelectorAll("#panel .card")].every(c => c.dataset.kind === "symbol");`],
  ["modified card shows every changed property old and new", "p=1", `
    const r = REVIEW_DATA.projects[1].changes.find(r => r.action === "modified");
    // Bench: the old → new values live in the bottom inspector for the selected card.
    document.querySelector('#panel .card[data-id="' + r.id + '"]')?.click?.(); await new Promise(res => setTimeout(res, 1500));
    const text = document.querySelector('#inspector')?.textContent || "";
    return r.changes.every(([k, a, b]) => text.includes(k) && text.includes(String(a ?? "—")) && text.includes(String(b ?? "—")));`],
  ["selecting a row zooms to it and highlights it", "p=1", `
    const p=D.projects.findIndex(p=>p.changes.some(r=>r.kind==='footprint'&&r.action==='modified'&&r.box));
    if(p<0) return 'fixture requires a modified footprint';
    await applyState({p,v:'board',t:'changes'});
    const r = proj().changes.find(r => r.kind === "footprint" && r.action === "modified" && r.box);
    const box=boardDiff?.bounds(r.id,'head')||r.box;
    document.querySelector('#panel .card[data-id="' + r.id + '"]').click();
    const ready = () => S.s === r.id && S.v === "board" && S.x != null && Math.abs(S.x - (box[0] + box[2]) / 2) < 0.01
      && (boardDiff ? document.querySelector('#stage .board-mark-label[data-id="'+r.id+'"]') !== null : document.querySelector("#stage .marker.sel") !== null)
      && document.querySelector('#panel .card[data-id="' + r.id + '"]').getAttribute("aria-selected") === "true", until = performance.now() + 5000;
    while (!ready() && performance.now() < until) await new Promise(res => setTimeout(res, 50));
    return ready() || JSON.stringify({selected:S.s,x:S.x,box:boardDiff?.bounds(r.id,'head'),labels:[...document.querySelectorAll('.board-mark-label')].map(e=>e.dataset.id),color:boardDiff?.panes.map(p=>p.renderer.gl.getUniform(p.markProgram,p.renderer.gl.getUniformLocation(p.markProgram,'markColor')))});`],
  ["clicking the drawing selects the row", "p=1&v=board", `
    await new Promise(res => setTimeout(res, 1200));
    const r = proj().changes.find(r => r.kind === "footprint" && r.action === "modified");
    zoomTo(boardDiff?.bounds(r.id,'head') || r.box); await new Promise(res => requestAnimationFrame(res));
    ${BOARD_POINT_PROBE}
    if(boardDiff) {
      const point=occupied({id:r.id}); if(!point) return 'no occupied change geometry';
      pickAt(point.pane.vp,point.event);
      return S.s===r.id && document.querySelector('#panel .card[aria-selected="true"]')?.dataset.id===r.id;
    }
    const vp = document.querySelector("#stage .vp"), b = vp.getBoundingClientRect();
    pickAt(vp, { clientX: b.left + b.width / 2, clientY: b.top + b.height / 2 });
    return S.s === r.id && document.querySelector('#panel .card[aria-selected="true"]')?.dataset.id === r.id;`],
  ["markers differ by more than colour", "p=1&v=board&m=semantic", `
    await new Promise(res => setTimeout(res, 1200));
    if(boardDiff) {
      const marks=[...document.querySelectorAll('.board-mark-label')];
      return marks.length>0 && marks.every(e=>{
        const style=BoardMarks.styles[e.dataset.action];
        return e.dataset.glyph===style.glyph && e.dataset.dash===style.dash && e.textContent.includes(style.word);
      }) && new Set(marks.map(e=>e.dataset.action)).size===new Set(proj().changes.filter(r=>r.where?.board).map(r=>r.action)).size;
    }
    const m = [...document.querySelectorAll("#stage .marker")];
    const styles = new Set(m.map(e => getComputedStyle(e).borderStyle + "|" + e.dataset.glyph));
    return m.length > 0 && m.every(e => e.dataset.glyph) && styles.size === new Set(m.map(e => e.dataset.action)).size;`],
  ["reused sheet: two navigator entries, separate counts", "p=1", `
    const P = REVIEW_DATA.projects[1], s0 = P.sheets[0];
    P.sheets.push({ ...s0, path: "/copy/", name: "Copy of " + s0.name, parent: s0.path });
    P.changes.push({ action: "added", kind: "symbol", ref: "R99", where: { sheet: "/copy/" }, pos: [10, 10, 0], box: null, props: { Value: "1k" }, id: "cx1" });
    renderNav();
    const a = document.querySelector('#nav [data-view="sheet:/"]'), b = document.querySelector('#nav [data-view="sheet:/copy/"]');
    const n = e => e.querySelector(".chip.added").textContent;
    return a && b && n(b).replace(/\\s/g, "") === "+1" && n(a) !== n(b) && document.querySelectorAll('#nav [data-view^="sheet:"]').length === 2;`],
  ["panel scrolls instead of stretching the page", "p=1", `
    await new Promise(res => setTimeout(res, 1200));
    const cards = document.querySelector("#panel .cards"), one = cards.innerHTML;
    cards.innerHTML = one.repeat(150);
    const p = document.querySelector("#panel-body"), vp = document.querySelector("#stage .vp");
    return document.documentElement.scrollHeight <= innerHeight + 1 && p.scrollHeight > p.clientHeight && vp.clientHeight <= innerHeight;`],
  ["search keeps caret and raw text while typing", "p=1", `
    const q = document.querySelector("#panel .q"); q.focus();
    for (const t of ["R", "R1", "R12"]) { q.value = t; q.dispatchEvent(new Event("input")); }
    const cs = [...document.querySelectorAll("#panel .card")];
    return document.querySelector("#panel .q") === q && q.value === "R12" && cs.length > 0 && cs.every(c => c.textContent.includes("R12"));`],
  ["filter chips and tabs show their state", "p=1", `
    const chip = document.querySelector('#panel .chip-filter[data-action="added"]'), on = getComputedStyle(chip);
    const onBg = on.backgroundColor, onDeco = on.textDecorationLine;
    chip.click();
    const off = getComputedStyle(document.querySelector('#panel .chip-filter[data-action="added"]'));
    const tab = getComputedStyle(document.querySelector('#panel [role=tab][aria-selected="true"]')), t2 = getComputedStyle(document.querySelector('#panel [role=tab][aria-selected="false"]'));
    // Bench: an off chip loses its tint and gets a dashed border (no strike-through).
    return off.backgroundColor !== onBg && off.borderStyle !== on.borderStyle && tab.backgroundColor !== t2.backgroundColor;`],
  ["clicking the Base pane selects the moved row at its old place", "p=1&v=board", `
    await new Promise(res => setTimeout(res, 1200));
    const r = REVIEW_DATA.projects[1].changes.find(r => r.kind === "footprint" && r.action === "modified");
    const o = r.pos_before; zoomTo([o[0] - 3, o[1] - 1, o[0] - 0, o[1] + 1], 1);   // centre = 1.5 mm left of the old centre: inside the Base box, outside the Head box
     await new Promise(res => requestAnimationFrame(res));
    const vp = document.querySelector("#stage .vp.board"), b = vp.getBoundingClientRect();
    pickAt(vp, { clientX: b.left + b.width / 2, clientY: b.top + b.height / 2 });
    return S.s === r.id;`],
  ["checks summary rows show every count", "p=1&t=checks", `
    const P = REVIEW_DATA.projects[1], rows = [...document.querySelectorAll("#panel .checks-summary .check")];
    return rows.length === 4 && P.checks.every(c => { const t = rows.find(r => r.dataset.checkSummary === c.name)?.textContent || "";
      return t.includes(c.title) && t.includes(c.errors + " errors") && t.includes(c.warnings + " warnings") && t.includes(c.new_errors + c.new_warnings ? "+" + (c.new_errors + c.new_warnings) + " new" : ""); });`],
  ["checks summary status and title do not intersect in a 300px panel", "p=1&t=checks", `
    const app = document.querySelector("#app"), prior = app.style.gridTemplateColumns;
    app.style.gridTemplateColumns = "220px minmax(0, 1fr) 300px";
    const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const rows = [...document.querySelectorAll("#panel .checks-summary .check")];
    const ok = document.querySelector("#panel").getBoundingClientRect().width === 300 && rows.length > 0 && rows.every(row => {
      const status = row.querySelector(".check-status"), title = row.querySelector(".check-title");
      return !overlaps(status.getBoundingClientRect(), title.getBoundingClientRect());
    });
    app.style.gridTemplateColumns = prior; return ok;`],
  ["checks summary marks turned-off checks not run", "p=1&t=checks", `
    const keep = REVIEW_DATA.settings.checks.drc; REVIEW_DATA.settings.checks.drc = "off"; renderPanel();
    const row = document.querySelector('#panel .check-not-run[data-check-summary="drc"]'), ok = row && row.textContent.includes("— not run") && row.textContent.includes("turned off in kicad-review.toml");
    REVIEW_DATA.settings.checks.drc = keep; renderPanel(); return !!ok;`],
  ["checks scope and severity chips use non-struck segmented controls", "p=1&t=checks", `
    const scope = document.querySelector('[data-check-scope="new"]'), all = document.querySelector('[data-check-scope="all"]'), severity = document.querySelector('[data-check-severity="error"]');
    const plain = getComputedStyle(all), toggle = getComputedStyle(severity);
    return scope.classList.contains("check-chip") && all.classList.contains("check-chip") && severity.classList.contains("check-chip")
      && plain.textDecorationLine === "none" && toggle.textDecorationLine === "none" && plain.borderStyle === "solid";`],
  ["passing checks with baseline findings say no new errors", "p=1&t=checks", `
    const c = REVIEW_DATA.projects[1].checks.find(c => c.errors > 0); if (!c) return "skip";
    const old = [REVIEW_DATA.settings.fail_on, c.status, c.new_errors];
    REVIEW_DATA.settings.fail_on = "new"; c.status = "pass"; c.new_errors = 0; renderPanel();
    const row = document.querySelector('[data-check-summary="' + c.name + '"]');
    const ok = row.querySelector(".check-status").textContent.includes("passing") && row.querySelector(".check-status-detail").textContent.includes("no new errors");
    [REVIEW_DATA.settings.fail_on, c.status, c.new_errors] = old; renderPanel(); return ok;`],
  ["checks scope chips default to new and switch to all", "p=1&t=checks", `
    const newChip = document.querySelector('[data-check-scope="new"]'), allChip = document.querySelector('[data-check-scope="all"]');
    const onlyNew = newChip.getAttribute("aria-pressed") === "true" && [...document.querySelectorAll("#panel .viol")].every(v => v.dataset.new === "true");
    allChip.click(); return onlyNew && document.querySelector('[data-check-scope="all"]').getAttribute("aria-pressed") === "true" && document.querySelectorAll('#panel .viol[data-new="false"]').length > 0;`],
  ["checks violations group by rule with new groups open first", "p=1&t=checks", `
    document.querySelector('[data-check-scope="all"]').click();
    const groups = [...document.querySelectorAll("#panel .check-group")], keys = new Set(groups.map(g => g.querySelector(".rule").textContent));
    const expected = new Set(REVIEW_DATA.projects[1].checks.flatMap(c => c.violations.map(v => c.name + "\\0" + v.type)));
    const newGroups = groups.filter(g => g.querySelector('.viol[data-new="true"]'));
    return groups.length >= keys.size && groups.length === expected.size && newGroups.every(g => g.open) && groups.slice(0, newGroups.length).every(g => g.querySelector('.viol[data-new="true"]'));`],
  ["clicking a located violation selects it and moves the drawing", "p=1&t=checks", `
    S.v = "board"; await draw(); S.checks.scope = "all"; renderPanel();
    const v = REVIEW_DATA.projects[1].checks.flatMap(c => c.violations).find(v => v.where?.board && v.pos), el = document.querySelector('#panel .viol[data-id="' + v.id + '"]'); el.click();
    await new Promise(r => setTimeout(r, 1200));
    return S.s === v.id && Math.abs(S.x - (v.box ? (v.box[0] + v.box[2]) / 2 : v.pos[0])) < .01 && document.querySelector('#panel .viol[data-id="' + v.id + '"]').getAttribute("aria-selected") === "true";`],
  ["j steps through rendered checks violations", "p=1&t=checks", `
    S.v = "board"; await draw(); S.checks.scope = "all"; renderPanel(); S.s = null;
    const ids = [...document.querySelectorAll('#panel .viol[data-id]:not([aria-disabled])')].map(v => v.dataset.id);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "j" })); await new Promise(r => setTimeout(r, 900));
    return ids.length > 1 && S.s === ids[0];`],
  ["violation without position is listed and does not move", "p=1&t=checks", `
    S.checks.scope = "all"; const v = REVIEW_DATA.projects[1].checks[0].violations[0], old = [v.pos, v.box]; v.pos = null; v.box = null; renderPanel();
    const el = document.querySelector('#panel .viol[data-id="' + v.id + '"]'), before = [S.v, S.x, S.y]; el.click(); await new Promise(r => setTimeout(r, 300));
    const ok = el.textContent.includes("no location") && el.getAttribute("aria-disabled") === "true" && S.v === before[0] && S.x === before[1];   // it may be inspected, but never moves the view
    [v.pos, v.box] = old; renderPanel(); return ok;`],
  ["violation on an unrendered sheet has no location", "p=1&t=checks", `
    S.checks.scope = "all"; const P = REVIEW_DATA.projects[1], sh = P.sheets[0], old = [sh.status, sh.svg]; sh.status = "unchanged"; sh.svg = null;
    const v = P.checks.flatMap(c => c.violations).find(v => v.pos && v.where?.sheet === sh.path); renderPanel();
    const el = document.querySelector('#panel .viol[data-id="' + v.id + '"]'), ok = el.textContent.includes("no location") && el.getAttribute("aria-disabled") === "true";
    [sh.status, sh.svg] = old; renderPanel(); return ok;`],
  ["state round-trips through the address", "", `
    const s = { p: 1, v: "board", m: "wipe", x: 158.8, y: 78.2, z: 12, s: "c5", t: "checks", layers: ["F_Cu", "Edge_Cuts"] };
    const back = decodeState(encodeState(s));
    return Object.keys(s).every(k => JSON.stringify(back[k]) === JSON.stringify(s[k]));`],
  ["address opens the exact spot", "p=1&v=board&m=overlay&x=158.8&y=78.2&z=12", `
    await new Promise(r => setTimeout(r, 1200));
    return S.p === 1 && S.v === "board" && S.m === "overlay" && S.x === 158.8 && S.z === 12;`],
  ["stale or malformed address falls back to first change", "p=9&v=sheet:/nope/&x=abc&s=c99999", `
    await new Promise(r => setTimeout(r, 1200));
    return S.p === 0 && S.v !== "sheet:/nope/" && Number.isFinite(S.x) && document.querySelectorAll("#stage svg").length > 0;`],
  ["j and k step through changes in list order", "p=1", `
    const ids = [...document.querySelectorAll("#panel .card")].map(c => c.dataset.id);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "j" })); await new Promise(r => setTimeout(r, 900));
    const a = S.s; document.dispatchEvent(new KeyboardEvent("keydown", { key: "j" })); await new Promise(r => setTimeout(r, 900));
    const b = S.s; document.dispatchEvent(new KeyboardEvent("keydown", { key: "k" })); await new Promise(r => setTimeout(r, 900));
    return a === ids[0] && b === ids[1] && S.s === ids[0];`],
  ["keys ignored while typing in search", "p=1", `
    const q = document.querySelector("#panel .q"); q.focus();
    q.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
    return S.s === null;`],
  ["copy link carries review link and fragment; go-to applies a pasted line", "p=1&v=board&x=10&y=20&z=5", `
    await new Promise(r => setTimeout(r, 800));
    const l = positionLink();
    applyGoTo("see " + REVIEW_DATA.links.review + " #p=1&v=board&x=158.8&y=78.2&z=12");
    await new Promise(r => setTimeout(r, 800));
    return l.includes(REVIEW_DATA.links.review) && l.includes("#p=1&v=board") && S.x === 158.8;`],
  ["copy link falls back to a selected readonly field when clipboard fails", "p=1&v=board", `
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const ok = [undefined, { writeText: () => Promise.reject(new Error("denied")) }];
    for (const stub of ok) {
      Object.defineProperty(navigator, "clipboard", { value: stub, configurable: true });
      document.querySelector("#report-review-bar [data-act=copy]").click(); await sleep(100);
      const f = document.querySelector("#report-review-bar input[readonly]");
      if (!f || f.value !== positionLink() || document.activeElement !== f || f.selectionStart !== 0 || f.selectionEnd !== f.value.length) return "bad " + (f && f.value);
      const rect = f.getBoundingClientRect(); if (rect.top < 0 || rect.bottom > innerHeight || rect.right > innerWidth || rect.width < 100) return "clipped copy fallback";
      f.remove();
    }
    return true;`],
  ["copy link shows Copied when clipboard works", "p=1&v=board", `
    Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.resolve() }, configurable: true });
    const b = document.querySelector("#report-review-bar [data-act=copy]"); b.click();
    await new Promise(r => setTimeout(r, 100));
    const during = b.textContent;
    await new Promise(r => setTimeout(r, 1700));
    return during.includes("Copied") && b.textContent === "Copy link";`],
  ["theme follows the system and keeps text contrast", "", `
    const lum = c => { const [r, g, b] = c.match(/\\d+/g).map(Number).map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return .2126 * r + .7152 * g + .0722 * b; };
    const start = KRTheme.get(), seen = [], res = {};
    try {
      for (const theme of ["dark", "light"]) {
        KRTheme.set(theme, {persist:false});
        const cs = getComputedStyle(document.body), a = lum(cs.color), b = lum(cs.backgroundColor);
        const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
        res[theme] = {ratio, b, attr:document.documentElement.dataset.theme};
        if (!(ratio >= 4.5 && (theme === "dark" ? b < 0.05 : b > 0.5) && KRTheme.get() === theme)) return JSON.stringify(res);
      }
      document.addEventListener("kr-theme-change", e => seen.push(e.detail));
      KRTheme.set("dark", {persist:false});
      const btn = document.querySelector('[data-theme-set=dark]');
      return seen[0] === "dark" && !!btn && btn.getAttribute("aria-pressed") === "true" || JSON.stringify({seen, res});
    } finally { KRTheme.set(start, {persist:false}); }`],
  ["drawing background is KiCad's in both themes", "", `
    await new Promise(r => setTimeout(r, 800));
    return getComputedStyle(document.querySelector("#stage .vp.sheet")).backgroundColor === "rgb(245, 244, 239)";`],
  ["unchanged board: address, violation click and start-up do not throw", "p=1", `
    const P = REVIEW_DATA.projects[1]; P.board = { changed: false, layers: [], status: "modified" };
    const bv = P.checks.flatMap(c => c.violations).find(v => v.where?.board && v.pos);
    await applyState(decodeState("#p=1&v=board"));
    const addr = S.v !== "board";
    S.t = "checks"; renderPanel();
    const el = document.querySelector('#panel .viol[data-id="' + bv.id + '"]');
    const noLoc = el.textContent.includes("no location") && el.getAttribute("aria-disabled") === "true";
    el.click(); await new Promise(r => setTimeout(r, 300));
    S.v = "board"; await draw(); const empty = !!document.querySelector("#stage .empty");
    window.reviewReady = false; history.replaceState(null, "", "#p=1&v=board&s=" + bv.id);
    await start();
    return (addr && noLoc && empty && window.reviewReady === true) || JSON.stringify({ addr, noLoc, empty, ready: window.reviewReady });`],
  ["change cards: long keys and values stay inside their cells", "p=0", `
    const P = REVIEW_DATA.projects[0], long = "Footprint_Library_With_A_Long_Name:SOME_VERY_LONG_FOOTPRINT_NAME_WITHOUT_ANY_BREAKS_0123456789";
    P.changes.unshift({ action: "modified", kind: "footprint", ref: "U1", where: { board: true }, pos: null, box: null, id: "cx2",
                        changes: [["net_settings.classes.Default.diff_pair_via_gap", long, long + "_B"]] },
                      { action: "added", kind: "design rules", ref: "x.kicad_pro", where: null, pos: null, box: null, id: "cx3",
                        props: { "net_settings.classes.Default.diff_pair_via_gap": "0.25", footprint: long } });
    renderPanel();
    const hit = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
    const bad = [];
    for (const id of ["cx2", "cx3"]) {
      const c = document.querySelector('#panel .card[data-id="' + id + '"]');
      if (c.scrollWidth > c.clientWidth) bad.push(id + " scroll " + c.scrollWidth + ">" + c.clientWidth);
      for (const p of c.querySelectorAll(".prop")) { const r = [...p.children].map(e => e.getBoundingClientRect());
        for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) if (hit(r[i], r[j])) bad.push(id + " overlap " + i + "/" + j); }
    }
    return bad.length ? bad.join("; ") : true;`],
  ["added footprint card shows its footprint and layer", "p=0", `
    const r = REVIEW_DATA.projects[0].changes.find(r => r.kind === "footprint" && r.action === "added" && r.props.layer);
    // Bench: property dumps moved from the card to the bottom inspector.
    document.querySelector('#panel .card[data-id="' + r.id + '"]').click(); await new Promise(res => setTimeout(res, 1500));
    const t = document.querySelector('#inspector').textContent;
    return t.includes(r.props.footprint) && t.includes(r.props.layer);`],
  ["address with selection and position keeps the position", "p=1&v=board&x=150&y=100&z=8&s=c600", `
    await new Promise(r => setTimeout(r, 1200));
    return (S.x === 150 && S.y === 100 && S.z === 8 && S.s === "c600" && document.querySelector("#stage .marker.sel") !== null) || JSON.stringify([S.x, S.z, S.s]);`],
  ["address with only a selection zooms to it", "p=1&s=c600", `
    await new Promise(r => setTimeout(r, 1200));
    const r = REVIEW_DATA.projects[1].changes.find(r => r.id === "c600");
    return (S.v === "board" && Math.abs(S.x - (r.box[0] + r.box[2]) / 2) < 0.01) || JSON.stringify([S.v, S.x]);`],
  ["overlay legend names its colours in words", "p=1&v=board&m=overlay", `
    await new Promise(r => setTimeout(r, 800));
    const t = document.querySelector("#stage .tag"), sw = [...t.querySelectorAll(".sw")].map(e => getComputedStyle(e).backgroundColor);
    return t.textContent.includes("red") && t.textContent.includes("green") && sw.length === 3 && new Set(sw).size === 3;`],
  ["wheel before the first fit does not blank the drawing", "p=1&v=board", `
    await new Promise(r => setTimeout(r, 800));
    S.z = null;
    document.querySelector("#stage .vp").dispatchEvent(new WheelEvent("wheel", { deltaY: -300, clientX: 400, clientY: 400, bubbles: true, cancelable: true }));
    await draw();
    return (Number.isFinite(S.z) && S.z > 0 && Number.isFinite(S.x)) || JSON.stringify([S.x, S.z]);`],
  ["unknown layer in the address draws the default layers", "p=1&v=board&l=Nope", `
    await new Promise(r => setTimeout(r, 800));
    return S.layers === null && document.querySelectorAll("#stage .layer").length > 0;`],
  ["removed project draws its Base in every mode", "p=0", `
    const P = REVIEW_DATA.projects[0]; P.status = "removed"; P.board.status = "removed";
    for (const s of P.sheets) { s.status = "removed"; s.svg = { base: s.svg.head, head: null }; }
    for (const l of P.board.layers) l.svg = { base: l.svg.head, head: null };
    const bad = [];
    for (const v of [P.sheets[0] && "sheet:" + P.sheets[0].path, "board"]) for (const m of Object.keys(MODE_NAMES)) {
      S.m = m; S.v = v; S.x = S.y = S.z = null; await draw();
      const vis = [...document.querySelectorAll("#stage .stack.base svg")].some(e => e.getBoundingClientRect().width > 0);
      if (!vis) bad.push(v + " " + m);
    }
    return bad.length ? bad.join(", ") : true;`],
  ["truncated navigator names carry the full name as a tooltip", "p=1", `
    REVIEW_DATA.projects[1].sheets[0].name = 'A "quoted" <very> long sheet name that will not fit the navigator width at all'; renderNav();
    const ns = [...document.querySelectorAll("#nav .tree .name")];
    return ns.length === 2 && ns[0].title.startsWith(REVIEW_DATA.projects[1].sheets[0].name) && ns.every(n => n.title && n.textContent.endsWith(n.title));`],
  ["mode switch updates the address", "p=1&v=board", `
    await new Promise(r => setTimeout(r, 800));
    document.querySelector('#modes [data-mode="overlay"]').click();
    await new Promise(r => setTimeout(r, 1200));
    return location.hash.includes("m=overlay") || location.hash;`],
  ["clicking the drawing records the selection in the address", "p=1&v=board", `
    await new Promise(r => setTimeout(r, 1200));
    const r = proj().changes.find(r => r.kind === "footprint" && r.action === "modified");
    zoomTo(boardDiff?.bounds(r.id,'head') || r.box); await new Promise(res => setTimeout(res, 300));
    ${BOARD_POINT_PROBE}
    if(boardDiff) {
      const point=occupied({id:r.id}); if(!point) return 'no occupied change geometry';
      pickAt(point.pane.vp,point.event);
    } else {
      const vp = document.querySelector("#stage .vp"), b = vp.getBoundingClientRect();
      pickAt(vp, { clientX: b.left + b.width / 2, clientY: b.top + b.height / 2 });
    }
    await new Promise(res => setTimeout(res, 1200));
    return location.hash.includes("s=" + r.id) || location.hash;`],
  ["inherited object keys are not modes", "p=1&v=board&m=toString", `
    await new Promise(r => setTimeout(r, 800));
    return (S.m === "side" && document.querySelectorAll("#stage .vp").length === 2) || S.m;`],
  ["all layers off survives the address round trip", "p=1&v=board", `
    await new Promise(r => setTimeout(r, 800));
    const back = valid(decodeState(encodeState({ ...S, layers: [] })));
    return Array.isArray(back.layers) && back.layers.length === 0 || JSON.stringify(back.layers);`],
  ["arrow keys on a focused card do not step or block scrolling", "p=1", `
    const c = document.querySelector("#panel .card"); c.focus();
    const e = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    c.dispatchEvent(e); await new Promise(r => setTimeout(r, 300));
    return (S.s === null && !e.defaultPrevented) || JSON.stringify([S.s, e.defaultPrevented]);`],
  ["selecting a row does not rebuild the panel", "p=1", `
    const row=proj().changes.find(r=>onView(r,S.v)&&rowBox(r,'head'));
    if(!row) return 'fixture requires a change on the current view';
    const list = document.querySelector("#panel .cards"), id = row.id;
    await goTo(id);
    return (list.isConnected && document.querySelector('#panel .card[data-id="' + id + '"]').getAttribute("aria-selected") === "true") || "rebuilt";`],
  ["a cancelled wipe drag stops tracking", "p=1&v=board&m=wipe", `
    await new Promise(r => setTimeout(r, 800));
    const d = document.querySelector("#stage .divider"), r = d.parentElement.getBoundingClientRect();
    d.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientX: r.left + r.width / 2 }));
    d.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 1 }));
    d.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: r.left + r.width * 0.1 }));
    return Math.abs(S.wipe - 0.5) < 0.02 || S.wipe;`],
  ["a capped change list says so", "p=1", `
    const p = REVIEW_DATA.projects[1], keep = p.changes;
    p.changes = Array.from({ length: 1600 }, (_, i) => ({ ...keep[0], id: "x" + i }));
    renderPanel(); const t = document.querySelector("#panel .cards").textContent; p.changes = keep; renderPanel();
    return t.includes("showing 1500 of 1600") || t.slice(-80);`],
  ["generated ids and enums are escaped in markup", "p=1", `
    const p = REVIEW_DATA.projects[1], r = p.changes[0], old = r.id; r.id = 'c"><b id=inj>';
    renderPanel(); const bad = !!document.querySelector("#inj"); r.id = old; renderPanel();
    return !bad || "injected";`],
  ["changes-only mode marks every located change, wires included", "p=0&v=sheet:/&m=semantic", `
    await new Promise(res => setTimeout(res, 1200));
    const want = proj().changes.filter(r => onView(r, S.v) && rowBox(r, "head")), w = document.querySelector("#stage .world");
    const n = w.querySelectorAll(".marker").length;
    return (want.some(r => r.kind === "wire") && n === want.length) || \`\${n} markers for \${want.length} changes\`;`],
  ["arrow keys step after a click on the drawing", "p=1", `
    document.activeElement?.blur(); S.s = null;  // a click on the drawing (a plain div) leaves focus on the body
    document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await new Promise(res => setTimeout(res, 300));
    return S.s !== null || "no step; focus on " + document.activeElement.tagName;`],
  ["3D fallback blocks and panel list cover missing models", "v=3d", `
    if (!REVIEW_DATA.projects[0].board.model3d) return "skip";
    await new Promise(r => setTimeout(r, 500));
    const d = REVIEW_DATA.projects[0].board.no_model || [];
    return d.length === 3 && ["D1", "L1", "U3"].every(ref => d.some(x => x.ref === ref && x.pos?.length === 3 && x.box?.length === 4)) && document.querySelectorAll("[data-no-model]").length === 3;`],
  ["3D visibility controls hide silkscreen", "v=3d", `
    if (!REVIEW_DATA.projects[0].board.model3d) return "skip";
    await new Promise(r => setTimeout(r, 500));
    const cb = document.querySelector('[data-3d-group="silk"]'); if (!cb) return false; cb.click();
    return (S.hidden3d || []).includes("silk");`],
  ["3D visibility classifies geometry on both board sides", "v=3d", `
    if (!REVIEW_DATA.projects[0].board.model3d) return "skip";
    while (!Review3D.state.firstFrame) await new Promise(r => setTimeout(r, 50));
    const st = Review3D.state, {THREE} = THREE3D, bad = [], layers = [];
    st.roots.forEach((root, i) => {
      if (!root) return;
      const meshes = []; root.traverse(o => { if (o.isMesh) meshes.push(o); });
      const pcb = meshes.filter(o => /PCB/i.test(o.name)), box = new THREE.Box3(); pcb.forEach(o => box.union(new THREE.Box3().setFromObject(o)));
      const middle = box.getCenter(new THREE.Vector3()).y, groups = o => st.groups.find(g => g.object === o)?.groups || [];
      for (const [pattern, group] of [[/silkscreen/i, "silk"], [/soldermask/i, "mask"]]) {
        const found = meshes.filter(o => pattern.test(o.name));
        for (const side of ["top", "bottom"]) if (new Set(found.filter(o => groups(o).includes(side)).map(o => group === "silk" ? o.parent : o)).size !== 1) bad.push(i + " " + group + " " + side);
        found.forEach(o => { const side = new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3()).y > middle ? "top" : "bottom"; layers.push({object:o, side}); if (groups(o).join(",") !== [group, side].join(",")) bad.push(i + " " + group + " geometry " + side); });
      }
      if (!pcb.length || pcb.some(o => groups(o).join(",") !== "board")) bad.push(i + " PCB groups");
      const j2 = root.getObjectByName("J2"), parts = [];
      root.traverse(o => { if (/^[A-Z]+\\d+$/.test(o.name)) parts.push(o); });
      for (const part of parts.filter(o => o === j2 || new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3()).y < middle)) {
        const side = part === j2 ? "top" : "bottom"; let count = 0;
        part.traverse(o => { if (o.isMesh) { count++; if (groups(o).join(",") !== "bodies," + side) bad.push(i + " " + part.name + " " + side); } });
        if (!count) bad.push(i + " missing meshes " + part.name);
      }
      if (!j2) bad.push(i + " missing J2");
    });
    document.querySelector('[data-3d-group="bottom"]').click();
    layers.forEach(({object, side}) => { if (object.visible !== (side === "top")) bad.push("bottom toggle " + object.name + " " + side); });
    return bad.length ? bad.join("; ") : true;`],
  ["3D address records camera and hidden groups", "v=3d", `
    if (!REVIEW_DATA.projects[0].board.model3d) return "skip";
    await new Promise(r => setTimeout(r, 500)); S.camera3d = window.Review3D.cameraState(); S.hidden3d=["silk"]; const q=decodeState(encodeState());
    return q.camera3d?.length === 6 && q.hidden3d?.[0] === "silk";`],
  ["3D saved selection address keeps its camera and draws outlines", "v=3d&m=side", `
    if (!REVIEW_DATA.projects[0].board.model3d) return "skip";
    while (!Review3D.state.firstFrame) await new Promise(r => setTimeout(r, 50));
    document.querySelector('[data-3d-camera="top"]').click();
    const camera = Review3D.cameraState(), row = proj().changes.find(r => r.ref === "J2");
    const saved = "#" + encodeState({...S, s:row.id, camera3d:camera, x:null, y:null, z:null});
    history.replaceState(null, "", saved); S.s = null; S.camera3d = null; await start();
    await new Promise(r => setTimeout(r, 700));
    const actual = Review3D.cameraState(), st = Review3D.state, {THREE} = THREE3D;
    const outlined = st.selected?.length === st.visibleSides.length && st.selected.every(o => o.position.distanceTo(new THREE.Box3().setFromObject(st.roots[o.side==='base'?0:1].getObjectByName(row.ref)).getCenter(new THREE.Vector3())) < 1e-4);
    return S.s === row.id && outlined && camera.every((n, i) => Math.abs(n - actual[i]) < .2) || JSON.stringify({saved, camera, actual, outlined, selection:S.s});
  `],
  ["3D change card keeps 3D and frames J2", "v=3d", `
    if (!REVIEW_DATA.projects[0].board.model3d) return "skip";
    while (!window.Review3D.state.firstFrame) await new Promise(r => setTimeout(r, 50));
    document.querySelector('#panel [data-id="c2"]').click(); await new Promise(r => setTimeout(r, 600));
    const { THREE } = window.THREE3D, st = window.Review3D.state, n = (() => { let f; st.roots[1].traverse(o => { if (!f && o.name === "J2") f = o; }); return f; })(),
      c = new THREE.Box3().setFromObject(n).getCenter(new THREE.Vector3()).project(st.cameras[0]);
    return (S.v === "3d" && location.hash.includes("v=3d") && S.s === "c2" && Math.abs(c.x) < .15 && Math.abs(c.y) < .15) || JSON.stringify({v:S.v,hash:location.hash,s:S.s,x:c.x,y:c.y});`],
  ["3D selection outline in each pane wraps that pane's own J2", "v=3d&m=side", `
    if (!REVIEW_DATA.projects[0].board.model3d) return "skip";
    while (!window.Review3D.state.firstFrame) await new Promise(r => setTimeout(r, 50));
    document.querySelector('#panel [data-id="c2"]').click(); await new Promise(r => setTimeout(r, 600));
    const { THREE } = window.THREE3D, st = window.Review3D.state, sel = st.selected || [];
    const j2 = r => { let f; r.traverse(o => { if (!f && o.name === "J2") f = o; }); return new THREE.Box3().setFromObject(f).getCenter(new THREE.Vector3()); };
    return sel.length === st.visibleSides.length && sel.every(o => o.position.distanceTo(j2(st.roots[o.side==='base'?0:1])) < 1e-4);`],
  ["3D no-model U3 block sits on the board, overlaps its footprint and is not hidden by silkscreen", "v=3d", `
    if (!REVIEW_DATA.projects[0].board.model3d) return "skip";
    while (!window.Review3D.state.firstFrame) await new Promise(r => setTimeout(r, 50));
    const { THREE } = window.THREE3D, st = window.Review3D.state, row = REVIEW_DATA.projects[0].board.no_model.find(x => x.ref === "U3"), blk = st.blocks.filter(b => b.ref === "U3");
    if (!blk.length) return "no U3 block";
    const fp = new THREE.Box3(new THREE.Vector3(row.box[0] / 1000, -1, row.box[1] / 1000), new THREE.Vector3(row.box[2] / 1000, 1, row.box[3] / 1000));
    for (const b of blk) {
      const root = st.roots[b.side === "head" ? 1 : 0]; let top = -Infinity;
      root.traverse(o => { if (o.isMesh && /PCB|silkscreen|soldermask/i.test(o.name)) top = Math.max(top, new THREE.Box3().setFromObject(o).max.y); });
      b.object.updateWorldMatrix(true, true); const w = new THREE.Box3().setFromObject(b.object), ctr = w.getCenter(new THREE.Vector3());
      if (!w.intersectsBox(fp)) return "no overlap " + JSON.stringify([w.min, w.max]);
      if (w.min.y < top - 1e-9 || w.min.y > top + 1e-4) return "not resting on board top " + w.min.y + " vs " + top;
      if (Math.abs(w.max.y - w.min.y - .001) > 1e-6) return "not 1 mm tall";
      const ray = new THREE.Raycaster(new THREE.Vector3(ctr.x, w.max.y + .01, ctr.z), new THREE.Vector3(0, -1, 0)), h = ray.intersectObject(root, true)[0];
      let a = h?.object; while (a && a !== b.object) a = a.parent;
      if (!a) return "first hit from above is " + h?.object.name;
    }
    return true;`],
  ["3D no-model list item frames its block and labels it", "v=3d", `
    if (!REVIEW_DATA.projects[0].board.model3d) return "skip";
    while (!window.Review3D.state.firstFrame) await new Promise(r => setTimeout(r, 50));
    document.querySelector('[data-no-model="U3"]').click(); await new Promise(r => setTimeout(r, 600));
    const { THREE } = window.THREE3D, st = window.Review3D.state, b = st.blocks.find(x => x.ref === "U3" && x.side === "head"), c = new THREE.Box3().setFromObject(b.object).getCenter(new THREE.Vector3()).project(st.cameras[0]);
    return Math.abs(c.x) < .15 && Math.abs(c.y) < .15 && /no 3D model/.test(document.querySelector(".tip3d")?.textContent || "");`],
  ["3D canvas click via mouse input selects J2 row", "v=3d", `
    if (!REVIEW_DATA.projects[0].board.model3d) return "skip";
    return S.s === "c2" && S.v === "3d";`],
  ["Interfaces check shows coverage", "p=1&t=checks", `
    proj().checks.push({ name: "interfaces", title: "Interfaces", level: "informational", status: "pass", errors: 0, warnings: 0, new_errors: 0, new_warnings: 0, fixed: 0, violations: [],
      coverage: { detected: { "I2C nets": 2 }, protected: [3, 5] } });
    renderPanel();
    const t = document.querySelector("#panel .check-coverage")?.textContent || "";
    return t.includes("I2C nets 2") && t.includes("3 of 5 connector signal pins") || t;`],
  ["Reports without an interfaces check show no Interfaces row", "t=checks", `
    if (!proj().checks || proj().checks.some(c => c.name === "interfaces")) return "skip";
    return ![...document.querySelectorAll("#panel .check-title")].some(e => e.textContent === "Interfaces") || "interfaces row shown";`],
  ["Release check shows its package", "p=1&t=checks", `
    const P = proj(); P.checks.push({ name: "release", title: "Release package", level: "informational", status: "pass", errors: 0, warnings: 0, new_errors: 0, new_warnings: 0, fixed: 0, violations: [],
      package: { files: [{ path: "b-review-jlcpcb-gerbers.zip", bytes: 20480 }, { path: "b-review-jlcpcb-bom.csv", bytes: 300 }], sha256: "ab".repeat(32) } });
    renderPanel();
    const t = document.querySelector("#panel .package")?.textContent || "";
    return t.includes("2 files") && t.includes("abababab") && t.includes("gerbers.zip") || t;`],
  ["Reports without a release check show no Release package row", "t=checks", `
    if (!proj().checks || proj().checks.some(c => c.name === "release")) return "skip";
    return ![...document.querySelectorAll("#panel .check-title")].some(e => e.textContent === "Release package") || "release row shown";`],
  ["BOM coverage and field changes render in the Parts tab", "", `
    const P = proj(); P.parts = P.parts || { lines: [], changes: [], supplier: null };
    P.parts.coverage = { base: { Value: [4, 4], Footprint: [4, 4], LCSC: [3, 4], MPN: [1, 4], Manufacturer: [0, 4], Datasheet: [2, 4], "Datasheet (critical)": [1, 2], "Order ready": [3, 4] },
                         head: { Value: [5, 5], Footprint: [5, 5], LCSC: [4, 5], MPN: [3, 5], Manufacturer: [0, 5], Datasheet: [2, 5], "Datasheet (critical)": [1, 3], "Order ready": [4, 5] } };
    P.parts.field_changes = [{ refs: ["R1", "R2"], field: "MPN", before: null, after: "<i>ERJ</i>" }];
    P.parts.dnp_mismatch = ["C9"];
    S.t = "parts"; renderPanel();
    const cov = document.querySelector("#panel .bom-coverage")?.textContent || "", fc = document.querySelector("#panel .field-changes")?.textContent || "";
    return cov.includes("incomplete: Manufacturer") && cov.includes("MPN") && cov.includes("3 / 5") && cov.includes("+2") && cov.includes("Order ready") && fc.includes("R1, R2") && fc.includes("<i>ERJ</i>")
      && !document.querySelector("#panel .field-changes i") && document.querySelector("#panel .dnp-mismatch")?.textContent.includes("C9") || JSON.stringify({cov, fc});`],
  ["Inventory lists every part, searchable, with change badges", "", `
    const P = proj(), row = P.changes.find(r => r.where?.board && rowBox(r, "head") && r.kind === "footprint"); if (!row) return "skip";
    const b = rowBox(row, "head");
    P.objects = [{ uuid: "u1", kind: "footprint", ref: row.ref, value: "1k", footprint: "R_0402", side: "head", pos: [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2, 0], box: b, layer: "F.Cu" },
                 { uuid: "u2", kind: "footprint", ref: "ZZ9", value: '<b>"x"</b>', footprint: "SOT23", side: "head", pos: [1, 1, 0], box: null, layer: "B.Cu" }];
    S.t = "changes"; S.filter.all = true; renderPanel();
    const rows = document.querySelectorAll("#panel .inv-row"), first = [...rows].find(r => r.textContent.includes(row.ref));
    const q = document.querySelector("#panel .q"); q.value = "zz9"; q.dispatchEvent(new Event("input"));
    const after = document.querySelectorAll("#panel .inv-row");
    return rows.length === 2 && first.textContent.includes(row.action) && after.length === 1 && after[0].textContent.includes('<b>"x"</b>') && !document.querySelector("#panel .inv-row b") || JSON.stringify({n: rows.length, after: after.length});`],
  ["Inventory removed part is listed and zooms", "", `
    const P = proj(), row = P.changes.find(r => r.where?.board && rowBox(r, "head")); if (!row) return "skip";
    const b = rowBox(row, "head");
    P.objects = [{ uuid: "u3", kind: "footprint", ref: "GONE1", value: "x", footprint: "y", side: "base", pos: [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2, 0], box: b, layer: "F.Cu" }];
    S.filter.all = true; S.filter.q = ""; renderPanel();
    const r = document.querySelector("#panel .inv-row"); if (!r.textContent.includes("removed")) return "no removed badge";
    await goToObject(0);
    return S.v === "board" && Math.abs(S.x - (b[0] + b[2]) / 2) < 0.01 || JSON.stringify({v: S.v, x: S.x});`],
  ["Inventory caps long lists", "", `
    const P = proj(); P.objects = Array.from({ length: 1600 }, (_, i) => ({ uuid: "u" + i, kind: "footprint", ref: "R" + i, value: "1k", footprint: "f", side: "head", pos: [i, 0, 0], box: null, layer: "F.Cu" }));
    S.filter.all = true; S.filter.q = ""; renderPanel();
    return document.querySelectorAll("#panel .inv-row").length === 1500 && document.querySelector("#panel .cards").textContent.includes("showing 1500 of 1600") || "no cap";`],
  ["Inventory follows project", "", `
    if (D.projects.length < 2) return "skip";
    D.projects[0].objects = [{ uuid: "a", kind: "symbol", ref: "PA1", side: "head", pos: [0, 0], box: null, sheet: "/" }];
    D.projects[1].objects = [{ uuid: "b", kind: "symbol", ref: "PB1", side: "head", pos: [0, 0], box: null, sheet: "/" }];
    S.filter.all = true; openProject(1);
    return document.querySelector("#panel .cards").textContent.includes("PB1") && !document.querySelector("#panel .cards").textContent.includes("PA1") || "wrong project";`],
  ["Inventory badges follow side and search covers layer", "", `
    const P = proj(); P.changes = [{ kind: "footprint", ref: "Q1", action: "added", where: { board: true } }, { kind: "footprint", ref: "Q1", action: "removed", where: { board: true } }];
    P.objects = [{ uuid: "b", kind: "footprint", ref: "Q1", side: "base", pos: [0, 0, 0], box: null, layer: "F.Cu" }, { uuid: "h", kind: "footprint", ref: "Q1", side: "head", pos: [0, 0, 0], box: null, layer: "B.Cu" }];
    S.t = "changes"; S.filter.all = true; S.filter.q = ""; renderPanel();
    const rows = [...document.querySelectorAll("#panel .inv-row")].map(r => r.textContent);
    const q = document.querySelector("#panel .q"); q.value = "b.cu"; q.dispatchEvent(new Event("input"));
    const n = document.querySelectorAll("#panel .inv-row").length;
    return rows[0].includes("removed") && rows[1].includes("added") && n === 1 || JSON.stringify({ rows, n });`],
  ["Parts fixture sorts problems and greys stale stock", "", `
  if (REVIEW_DATA.repo !== 'example/parts') return 'skip';
  document.querySelector('[data-tab=parts]').click();
  const rows = [...document.querySelectorAll('#panel .parts-row')];
  if (rows.length !== REVIEW_DATA.projects[0].parts.lines.length || !rows[0].classList.contains('problem')) return 'rows';
  if (!document.querySelector('.parts-age.stale') || rows.some(r => !r.querySelector('.parts-stock.stale') || r.querySelector('.parts-stock').textContent.includes('✔'))
    || !rows.some(r => r.querySelector('.parts-stock').textContent.includes('(stale)'))) return 'stale';
  if (document.querySelector('.parts-table img') || [...document.querySelectorAll('.parts-table a')].some(a => !/^https?:/.test(a.href) || a.rel !== 'noopener noreferrer' || a.target !== '_blank')) return 'escaping';
  document.querySelector('[data-parts-filter=problems]').click();
  if (document.querySelectorAll('.parts-row').length !== 2 || document.querySelector('.parts-table').textContent.includes('U5')) return 'problems filter';
  document.querySelector('[data-parts-filter=changed]').click();
  if (document.querySelectorAll('.parts-row').length !== 1) return 'changed filter';
  S.partsFilter.problems = false; renderPanel();
  const moved = [...document.querySelectorAll('.parts-row')].find(r => r.textContent.includes('R7'));
  if (moved.children[1].textContent !== 'R7' || !moved.textContent.includes('10k → 4.7k')) return 'changed refs only';
  S.partsFilter.changed = false; renderPanel();
  const line = [...document.querySelectorAll('.parts-row')].find(r => r.textContent.includes('R7'));
  if (!line.classList.contains('changed') || line.children[1].textContent !== 'R6, R7' || line.querySelector('strong').textContent !== 'R7'
    || !line.textContent.includes('10k → 4.7k (R7)') || document.querySelectorAll('.parts-row.changed').length !== 2) return 'changed marking';
  REVIEW_DATA.projects[0].parts.supplier = null; renderPanel();
  if (document.querySelector('.parts-age, .parts-attribution, .parts-lookup-error') || [...document.querySelectorAll('.parts-stock')].some(c => c.textContent !== '—')) return 'no lookup';
  if (valid({t:'parts'}).t !== 'parts') return 'hash';
  const parts = REVIEW_DATA.projects[0].parts;
  if (document.querySelector('[data-tab=parts]').textContent !== 'Parts 5 · 2 ⚠') return 'blocking count';
  parts.supplier = {error:'503'}; renderPanel();
  const unavailable = document.querySelector('.parts-row.unavailable .parts-stock').textContent;
  if (!unavailable.includes('unavailable') || !document.querySelector('.parts-lookup-error')?.textContent.includes('503') || document.querySelector('.parts-table img')) return 'failed lookup';
  parts.supplier = {fetched_at:'invalid <timestamp>'}; renderPanel();
  if (!document.querySelector('.parts-age.stale') || document.querySelector('.parts-age').textContent.includes('NaN')
      || [...document.querySelectorAll('.parts-stock')].some(c => !c.classList.contains('stale') || c.textContent.includes('✔'))) return 'invalid timestamp';
  const savedProblems = parts.lines.map(l => l.problems);
  parts.lines.forEach(l => l.problems = ['missing_mpn', 'unavailable']); renderPanel();
  if (document.querySelector('[data-tab=parts]').textContent !== 'Parts 5') return 'zero blocking count';
  parts.lines.forEach((l, i) => l.problems = savedProblems[i]);
  parts.supplier = {fetched_at: new Date(Date.now() - 2 * 36e5).toISOString()}; renderPanel();
  if (![...document.querySelectorAll('.parts-stock')].some(c => c.textContent.includes('✔')) || document.querySelector('.parts-stock.stale')) return 'fresh';
  parts.changes.push({action:'removed',refs:['R8'],before:{...parts.lines[0],refs:['R8']},after:null}); renderPanel();
  if (document.querySelectorAll('.parts-row').length !== 6 || !document.querySelector('.parts-table').textContent.includes('R8')) return 'removed';
  parts.changes.push({action:'footprint',refs:['R1'],before:{...parts.lines[0],footprint:'R_0402'},after:parts.lines[0]}); renderPanel();
  if (!document.querySelector('.parts-footprint')?.textContent.includes('R_0402 → R_0603')) return 'footprint change';
  delete REVIEW_DATA.projects[0].parts; renderPanel();
  return document.querySelector('[data-tab=parts]').disabled && S.t === 'changes';
`],
  ["DigiKey column shows stock, price, time and attribution", "", `
    const p = REVIEW_DATA.projects[0], old = p.parts;
    const line = (ref, supplier, mpn = ref) => ({refs:[ref], key:ref, value:ref, footprint:'F', lcsc:'C1', mpn, datasheet:null, problems:[], supplier});
    p.parts = {lines:[line('U1',{status:'ok',quantity:1234,unit_price:9,breaks:[[1,1.5]],product_status:'Active <img src=x>',url:'https://www.digikey.ca/en/products/x'}),
      line('U2',{status:'out_of_stock',quantity:0,unit_price:2}), line('U3',{status:'ambiguous',matches:2,unit_price:99}),
      line('R1',null,null)],changes:[],supplier:{name:'DigiKey',currency:'USD',fetched_at:new Date().toISOString(),error:null,skipped:null,not_looked_up:{no_mpn:54,invalid_mpn:1,run_limit:2}}};
    S.t='parts'; S.partsFilter={problems:false,changed:false}; renderPanel();
    const cells = () => [...document.querySelectorAll('.parts-stock')];
    if (![...document.querySelectorAll('.parts-table th')].some(x=>x.textContent==='DigiKey')) return 'header';
    if (!cells()[0].textContent.includes('✔ 1234') || !cells()[0].textContent.includes('$1.50') || !cells()[0].querySelector('a')?.href.startsWith('https://www.digikey.ca/')) return 'stock or price';
    if (!cells()[0].textContent.includes('Active <img src=x>') || cells()[0].querySelector('img')) return 'product status escaping';
    if (cells()[0].querySelector('a').rel!=='noopener noreferrer' || !document.querySelector('.parts-age').textContent.includes('DigiKey data as of') || !document.querySelector('.parts-attribution').textContent.includes('Stock and price from DigiKey')) return 'attribution';
    if (!document.querySelector('.parts-not-looked-up').textContent.includes('54 parts not looked up: no MPN') || document.querySelector('#panel').textContent.includes('JLCPCB')) return 'coverage';
    if (!cells()[2].textContent.includes('several matches') || cells()[2].textContent.includes('99')) return 'ambiguous';
    p.parts.supplier.error='1 lookups failed (last: HTTP 500)'; renderPanel();
    if (!cells()[0].textContent.includes('✔ 1234') || !document.querySelector('.parts-lookup-error')) return 'partial failure blanks successful data';
    p.parts.lines[0].supplier.url='https://www.digikey.com@evil.com/x'; renderPanel();
    if (cells()[0].querySelector('a')) return 'unsafe link';
    p.parts.lines[0].supplier.url='https://www.digikey.evil.com/x'; renderPanel();
    if (cells()[0].querySelector('a')) return 'unsafe host';
    p.parts.supplier.fetched_at=new Date(Date.now()-25*36e5).toISOString(); renderPanel();
    if (cells().some(x=>x.textContent.includes('✔') || x.textContent.includes('in stock')) || !cells()[0].textContent.includes('(stale)')) return 'stale';
    p.parts.supplier.fetched_at=new Date().toISOString(); p.parts.supplier.currency='CAD'; renderPanel();
    if (!cells()[0].textContent.includes('CA$1.50')) return 'currency';
    p.parts.supplier.skipped='no credentials (forked pull request or secrets not set)'; renderPanel();
    if (!document.querySelector('.parts-age').textContent.includes('DigiKey lookup skipped: no credentials') || cells().some(x=>x.textContent.includes('✔'))) return 'skipped';
    p.parts.supplier.skipped=null; p.parts.lines[0].supplier={status:'unavailable',mpn:'<img src=x onerror=alert(1)>'}; renderPanel();
    if (!cells()[0].textContent.includes('unavailable') || document.querySelector('.parts-table img')) return 'unavailable';
    p.parts.supplier=null; renderPanel();
    if (cells().some(x=>x.textContent!=='—') || document.querySelector('.parts-age, .parts-attribution, .parts-lookup-error')) return 'disabled supplier UI';
    p.parts=old; return true;
  `],
  ["Parts report matches head BOM line count", "t=parts", `
  const parts = REVIEW_DATA.projects[S.p].parts;
  if (!parts || REVIEW_DATA.repo === 'example/parts') return 'skip';
  document.querySelector('[data-tab=parts]').click();
  return document.querySelector('[data-tab=parts]').textContent === 'Parts ' + parts.lines.length + (partsProblemCount(parts) ? ' · ' + partsProblemCount(parts) + ' ⚠' : '')
    && document.querySelectorAll('.parts-row').length === parts.lines.length
    && (!REVIEW_DATA.projects[S.p].name.includes('Thermal_Camera') || parts.lines.length === 29)
    && !document.querySelector('.parts-age, .parts-attribution, .parts-lookup-error');
`],
  ["Readiness ready message blockMerge is false when unframed", "", `
    return !THREADS_ON && typeof readyMessage === "function" && readyMessage().blockMerge === false && readyMessage().kicadReviewReady === true || "ready message";`],
  ["Threads arrival preserves the drawing during the first right-click", "v=board", `
    const vp = document.querySelector("#stage .vp"), world = vp.querySelector(".world");
    const rect = vp.getBoundingClientRect(), event = new MouseEvent("contextmenu", {bubbles:true, cancelable:true, clientX:rect.left + rect.width / 2, clientY:rect.top + rect.height / 2});
    const saved = parent.postMessage, enabled = THREADS_ON, sent = [];
    parent.postMessage = data => sent.push(data);
    THREADS_ON = true;
    try {
      vp.dispatchEvent(new PointerEvent("pointerdown", {button:2, bubbles:true}));
      acceptThreads([]);
      await new Promise(r => setTimeout(r, 100));
      if (!vp.isConnected || vp.querySelector(".world") !== world) return "thread arrival replaced right-click target";
      vp.dispatchEvent(event);   // Bench: right-click opens the canvas menu; Comment here places the pin
      vp.dispatchEvent(new PointerEvent("pointerup", {button:2, bubbles:true}));
      vp.dispatchEvent(new PointerEvent("pointerup", {button:2,bubbles:true,clientX:event.clientX,clientY:event.clientY}));
      [...document.querySelectorAll('.bench-context button')].find(b => b.textContent === 'Comment here')?.click();
      return event.defaultPrevented && sent.length === 1 && !!sent[0].kicadReviewPin?.file || JSON.stringify(sent);
    } finally { parent.postMessage = saved; THREADS_ON = enabled; }
  `],
  ["Threads anchorAt pins an object and falls back to a point", "", `
    const P = proj(), row = P.changes.find(r => r.where?.board && rowBox(r, "head")); if (!row) return "skip";
    await goTo(row.id); const b = rowBox(row, "head"), cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
    P.objects = [{ uuid: "u-1", kind: "footprint", ref: "RX1", value: "1k", side: "head", pos: [cx, cy, 0], box: b, layer: "F.Cu" }];
    const a = anchorAt(cx, cy, "head"), pt = anchorAt(b[2] + 500, b[3] + 500, "head");
    return a.target === "object" && a.uuid === "u-1" && a.ref === "RX1" && a.file.endsWith(P.name + ".kicad_pcb") && a.commit === D.head
      && a.v === 1 && a.severity === "comment" && pt.target === "point" && pt.uuid === null && pt.x === round3(b[2] + 500) || JSON.stringify({a, pt});`],
  ["Threads anchorAt uses the sub-sheet file", "", `
    const P = proj(), sheet = P.sheets.find(s => s.status !== "unchanged" && s.svg); if (!sheet) return "skip";
    S.v = "sheet:" + sheet.path; S.x = S.y = S.z = null; renderNav(); await draw();
    const a = anchorAt(1, 1, "head");
    return a.sheet === sheet.path && a.file === (P.dir ? P.dir + "/" : "") + sheet.file || JSON.stringify(a);`],
  ["Threads resolveAnchor follows UUID, then reference, and flags moves", "", `
    const P = proj(); P.objects = [{ uuid: "u-2", kind: "footprint", ref: "R9", side: "head", pos: [10, 10, 0], box: [9, 9, 11, 11], layer: "F.Cu", pos_before: [5, 5, 0] }];
    const base = { v: 1, project: P.dir, file: "x.kicad_pcb", sheet: null, layer: "F.Cu", target: "object", kind: "footprint", side: "head", commit: "0ld1234", severity: "comment" };
    const byUuid = resolveAnchor({ ...base, uuid: "u-2", ref: "R9", x: 10, y: 10 });
    const byRef = resolveAnchor({ ...base, uuid: "gone", ref: "R9", x: 3, y: 3 });
    return byUuid.view === "board" && byUuid.side === "head" && byUuid.pos[0] === 10 && !byUuid.notes.some(n => n.startsWith("moved"))
      && byRef.pos[0] === 10 && byRef.notes.some(n => n.startsWith("moved since 0ld1234"))
      && byUuid.notes.includes("pinned on 0ld1234, viewing " + D.head.slice(0, 7)) || JSON.stringify({byUuid, byRef});`],
  ["Threads resolveAnchor removed object pins base", "", `
    const P = proj(); P.objects = [{ uuid: "u-3", kind: "footprint", ref: "C4", side: "base", pos: [7, 7, 0], box: [6, 6, 8, 8], layer: "F.Cu" }];
    const r = resolveAnchor({ v: 1, project: P.dir, file: "x.kicad_pcb", sheet: null, layer: "F.Cu", target: "object", uuid: "u-3", kind: "footprint", ref: "C4", x: 7, y: 7, side: "head", commit: D.head, severity: "comment" });
    const gone = resolveAnchor({ v: 1, project: P.dir, file: "x.kicad_pcb", sheet: null, layer: null, target: "object", uuid: "nope", kind: "footprint", ref: "C99", x: 1, y: 1, side: "head", commit: D.head, severity: "comment" });
    return r.side === "base" && r.notes.includes("C4 was removed in this change") && typeof gone.detached === "string" || JSON.stringify({r, gone});`],
  ["Threads resolveAnchor point flags a changed area", "", `
    const P = proj(), row = P.changes.find(r => r.where?.board && r.box); if (!row) return "skip";
    const x = (row.box[0] + row.box[2]) / 2, y = (row.box[1] + row.box[3]) / 2;
    const pt = { v: 1, project: P.dir, file: "x.kicad_pcb", sheet: null, layer: null, target: "point", uuid: null, kind: null, ref: null, x, y, side: "head", severity: "comment" };
    const old = resolveAnchor({ ...pt, commit: "0ld1234" }), same = resolveAnchor({ ...pt, commit: D.head }), base = resolveAnchor({ ...pt, commit: D.base });
    P.changes = [{ where: { board: true }, pos: [50, 50, 0], pos_before: [5, 5, 0] }];
    const before = resolveAnchor({ ...pt, x: 5, y: 5, commit: "0ld1234" }), after = resolveAnchor({ ...pt, x: 50, y: 50, commit: "0ld1234" });
    P.changes = [{ where: { sheet: "/other/" }, pos_before: [5, 5, 0] }];
    const otherView = resolveAnchor({ ...pt, x: 5, y: 5, commit: "0ld1234" });
    return old.notes.includes("this area changed since 0ld1234") && !same.notes.some(n => n.startsWith("this area"))
      && !base.notes.some(n => n.startsWith("this area")) && before.notes.includes("this area changed since 0ld1234")
      && after.notes.includes("this area changed since 0ld1234") && !otherView.notes.some(n => n.startsWith("this area")) || JSON.stringify({old, same, base, before, after, otherView});`],
  ["Threads anchorAt rejects a missing sheet file", "", `
    S.v = "sheet:/nope/";
    const a = anchorAt(1, 1, "head");
    return a === null || JSON.stringify(a);`],
  ["Threads resolveAnchor prioritizes UUID before reference", "", `
    const P = proj();
    P.objects = [
      { uuid: "u-a", kind: "footprint", ref: "R9", side: "head", pos: [1, 1, 0], layer: "F.Cu" },
      { uuid: "u-b", kind: "footprint", ref: "R9", side: "head", pos: [20, 1, 0], layer: "F.Cu" }
    ];
    const a = { v: 1, project: P.dir, file: "x.kicad_pcb", sheet: null, layer: "F.Cu", target: "object", kind: "footprint", ref: "R9", x: 20, y: 1, side: "head", commit: D.head, severity: "comment" };
    const uuid = resolveAnchor({ ...a, uuid: "u-b" }), ref = resolveAnchor({ ...a, uuid: "unknown" });
    return uuid.pos[0] === 20 && ref.pos[0] === 1 || JSON.stringify({uuid, ref});`],
  ["Threads anchorAt base uses previous position and excludes additions", "", `
    if (D.base == null) return "skip";
    const P = proj(); S.v = "board";
    P.objects = [
      { uuid: "moved", kind: "footprint", ref: "R1", side: "head", pos: [50, 50, 0], pos_before: [5, 5, 0], box: [49, 49, 51, 51], layer: "F.Cu" },
      { uuid: "added", kind: "footprint", ref: "R2", side: "head", pos: [20, 20, 0], box: [19, 19, 21, 21], layer: "F.Cu", added: true }
    ];
    const moved = anchorAt(5, 5, "base"), added = anchorAt(20, 20, "base"), headPosition = anchorAt(50, 50, "base");
    return moved.target === "object" && moved.uuid === "moved" && moved.x === 5 && moved.y === 5 && moved.side === "base" && moved.commit === D.base
      && added.target === "point" && added.uuid === null && added.side === "base" && added.commit === D.base
      && headPosition.target === "point" || JSON.stringify({moved, added, headPosition});`],
  ["Threads resolveAnchor reference prefers the same sheet then any", "", `
    const P = proj();
    const objects = [
      { uuid: "u-a", kind: "symbol", ref: "R1", side: "head", pos: [1, 1, 0], sheet: "/a/" },
      { uuid: "u-b", kind: "symbol", ref: "R1", side: "head", pos: [20, 1, 0], sheet: "/b/" }
    ];
    const a = { v: 1, project: P.dir, file: "b.kicad_sch", sheet: "/b/", layer: null, target: "object", uuid: "unknown", kind: "symbol", ref: "R1", x: 20, y: 1, side: "head", commit: D.head, severity: "comment" };
    P.objects = objects;
    const head = resolveAnchor(a), any = resolveAnchor({ ...a, sheet: "/missing/" });
    P.objects = objects.map(o => ({ ...o, side: "base" }));
    const base = resolveAnchor(a), baseAny = resolveAnchor({ ...a, sheet: "/missing/" }), baseUuid = resolveAnchor({ ...a, uuid: "u-b" });
    return head.view === "sheet:/b/" && head.pos[0] === 20 && any.view === "sheet:/a/"
      && base.view === "sheet:/b/" && base.side === "base" && baseAny.view === "sheet:/a/" && baseUuid.pos[0] === 20 || JSON.stringify({head, any, base, baseAny, baseUuid});`],
  ["Threads tab and pins appear only with thread data", "", `
    const P = proj(), row = P.changes.find(r => r.where?.board && rowBox(r, "head")); if (!row) return "skip";
    if (!document.querySelector('#panel [data-tab="threads"]').disabled) return "tab enabled offline";
    const b = rowBox(row, "head"), x = (b[0] + b[2]) / 2, y = (b[1] + b[3]) / 2;
    P.objects = [{ uuid: "u-5", kind: "footprint", ref: "Q1", side: "head", pos: [x, y, 0], box: b, layer: "F.Cu" }];
    acceptThreads([{ id: "T1", resolved: false, anchor: { v: 1, project: P.dir, file: "f.kicad_pcb", sheet: null, layer: "F.Cu", target: "object", uuid: "u-5", kind: "footprint", ref: "Q1", x, y, side: "head", commit: D.head, severity: "blocking" }, comments: [{ author: "alice", body: "<img src=x onerror=alert(1)> too close", createdAt: "2026-10-12T10:00:00Z" }] },
                   { id: "T2", resolved: true, anchor: { v: 1, project: P.dir, file: "f.kicad_pcb", sheet: null, layer: null, target: "point", uuid: null, kind: null, ref: null, x, y, side: "head", commit: D.head, severity: "comment" }, comments: [] }]);
    S.t = "threads"; renderPanel(); await goTo(row.id);
    const tab = document.querySelector('#panel [data-tab="threads"]'), cards = document.querySelectorAll("#panel .thread-card");
    const pins = document.querySelectorAll("#stage .pin");
    return !!tab && /^Threads 1$/.test(tab.textContent.trim()) && cards.length === 1 && cards[0].textContent.includes("Blocking") && !document.querySelector("#panel img")
      && pins.length >= 1 && [...pins].every(p => p.classList.contains("pin-blocking") && p.getAttribute("aria-label").includes("Q1")) || JSON.stringify({tab: !!tab, cards: cards.length, pins: pins.length});`],
  ["Threads resolved filter and detached group", "", `
    const P = proj(); P.objects = [];
    acceptThreads([{ id: "T3", resolved: true, anchor: { v: 1, project: P.dir, file: "f", sheet: null, layer: null, target: "point", uuid: null, kind: null, ref: null, x: 1, y: 1, side: "head", commit: D.head, severity: "comment" }, comments: [] },
                   { id: "T4", resolved: false, anchor: { v: 1, project: P.dir, file: "f", sheet: null, layer: null, target: "object", uuid: "zz", kind: "footprint", ref: "U99", x: 1, y: 1, side: "head", commit: D.head, severity: "comment" }, comments: [] }]);
    S.t = "threads"; S.threadFilter.status = "resolved"; renderPanel();
    const resolved = document.querySelectorAll("#panel .thread-card").length;
    S.threadFilter.status = "open"; renderPanel();
    const detached = document.querySelector("#panel .threads-detached")?.textContent || "";
    return resolved === 1 && detached.includes("U99") || JSON.stringify({resolved, detached});`],
  ["Threads messages from a non-parent window are ignored", "", `
    S.threads = null; renderPanel();
    window.dispatchEvent(new MessageEvent("message", { source: window, data: { kicadReviewThreads: [] } }));
    await new Promise(r => setTimeout(r, 50));
    if (S.threads !== null || !document.querySelector('#panel [data-tab="threads"]').disabled) return "accepted offline";
    const ignored = handleParentMessage({ source: {}, data: { kicadReviewThreads: [] } }, true);
    if (ignored !== false || S.threads !== null) return "accepted non-parent";
    const accepted = handleParentMessage({ source: parent, data: { kicadReviewThreads: [] } }, true);
    return accepted === true && Array.isArray(S.threads) && S.threads.length === 0 || "rejected parent";`],
  ["Threads j and k step through thread cards", "", `
    const P = proj(), row = P.changes.find(r => r.where?.board && rowBox(r, "head")); if (!row) return "skip";
    await goTo(row.id);
    const b = rowBox(row, "head"), x = (b[0] + b[2]) / 2, y = (b[1] + b[3]) / 2;
    P.objects = [0, 1].map(i => ({ uuid: "step-u-" + i, kind: "footprint", ref: "Q" + (i + 1), side: "head", pos: [x + i * 10, y, 0], box: [x + i * 10 - 1, y - 1, x + i * 10 + 1, y + 1], layer: "F.Cu" }));
    acceptThreads(P.objects.map((o, i) => ({ id: "step-T" + i, resolved: false, anchor: { v: 1, project: P.dir, file: viewFile(P, "board"), sheet: null, layer: o.layer, target: "object", uuid: o.uuid, kind: o.kind, ref: o.ref, x: o.pos[0], y: o.pos[1], side: "head", commit: D.head, severity: "comment" }, comments: [] })));
    S.t = "threads"; renderPanel(); await draw();
    const ids = [...document.querySelectorAll("#panel .thread-card[data-thread]")].map(e => e.dataset.thread);
    if (ids.length !== 2) return "expected two cards";
    openThread(ids[0]);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "j" }));
    const afterJ = S.thread;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k" }));
    return afterJ === ids[1] && S.thread === ids[0] || JSON.stringify({ ids, afterJ, afterK: S.thread });`],
  ["Threads placement resets on Escape and view selection", "", `
    S.placing = true; document.body.classList.add("placing");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    const escapeCleared = !S.placing && !document.body.classList.contains("placing");
    S.placing = true; document.body.classList.add("placing");
    select(firstChangedView(proj()));
    return escapeCleared && !S.placing && !document.body.classList.contains("placing") || "placement stayed active";`],
  ["Threads opening a blank drawing keeps the current view", "", `
    const P = proj(), view = S.v;
    acceptThreads([{ id: "blank-T", resolved: false, anchor: { v: 1, project: P.dir, file: "missing.kicad_sch", sheet: "/missing/", layer: null, target: "point", uuid: null, kind: null, ref: null, x: 1, y: 1, side: "head", commit: D.head, severity: "comment" }, comments: [] }]);
    S.t = "threads"; renderPanel(); await openThread("blank-T");
    return S.v === view && S.thread === "blank-T" && document.querySelector("#panel .thread-card")?.textContent.includes("its drawing is unavailable in this review") || JSON.stringify({view, current: S.v, thread: S.thread, text: document.querySelector("#panel .thread-card")?.textContent});`],
  ["Threads severity select and cards retain focus", "", `
    const P = proj();
    acceptThreads([{ id: 'focus-"T', resolved: false, anchor: { v: 1, project: P.dir, file: "f.kicad_pcb", sheet: null, layer: null, target: "point", uuid: null, kind: null, ref: null, x: 1, y: 1, side: "head", commit: D.head, severity: "comment" }, comments: [] }]);
    S.t = "threads"; renderPanel();
    const select = document.querySelector("#panel select.thread-severity");
    select.focus(); select.value = "comment"; select.dispatchEvent(new Event("change")); renderPanel();
    const severityFocused = document.activeElement === document.querySelector("#panel select.thread-severity");
    document.querySelector("#panel .thread-card").focus(); renderPanel();
    return severityFocused && document.activeElement === document.querySelector("#panel .thread-card") || JSON.stringify({severityFocused, active: document.activeElement.className});`],
  ["Threads saved tab opens when thread data arrives", "", `
    S.t = "threads"; S.threads = null; renderPanel();
    const waiting = S.t === "changes" && S.wantThreads === true;
    acceptThreads([]);
    return waiting && S.t === "threads" && !S.wantThreads || JSON.stringify({waiting, tab: S.t, want: S.wantThreads});`],
  ["Threads hash tab survives reload before data arrives", "t=threads", `
    const waiting = S.t === "changes" && S.wantThreads === true;
    acceptThreads([]);
    return waiting && S.t === "threads" && !S.wantThreads || JSON.stringify({waiting, tab: S.t, want: S.wantThreads});`],
  ["Threads tab click cancels deferred tab selection", "", `
    S.t = "threads"; S.threads = null; renderPanel();
    document.querySelector('#panel [data-tab="checks"]').click();
    acceptThreads([]);
    return S.t === "checks" && !S.wantThreads || JSON.stringify({tab: S.t, want: S.wantThreads});`],
  ["Threads opening another drawable view clears placement", "", `
    const P = proj(), row = P.changes.find(r => r.where?.board && rowBox(r, "head")); if (!row || !currentView("board")) return "skip";
    const b = rowBox(row, "head"), x = (b[0] + b[2]) / 2, y = (b[1] + b[3]) / 2;
    acceptThreads([{ id: "placing-T", resolved: false, anchor: { v: 1, project: P.dir, file: viewFile(P, "board"), sheet: null, layer: null, target: "point", uuid: null, kind: null, ref: null, x, y, side: "head", commit: D.head, severity: "comment" }, comments: [] }]);
    S.v = "sheet:/missing/"; S.t = "threads"; renderPanel();
    S.placing = true; document.body.classList.add("placing");
    await openThread("placing-T");
    return S.v === "board" && !S.placing && !document.body.classList.contains("placing") || JSON.stringify({view: S.v, placing: S.placing, crosshair: document.body.classList.contains("placing")});`],
  ["Threads invalid ids cannot drop valid threads or run conversions", "", `
    const anchor = { v: 1, project: proj().dir, file: "f.kicad_pcb", sheet: null, layer: null, target: "point", uuid: null, kind: null, ref: null, x: 1, y: 1, side: "head", commit: D.head, severity: "comment" };
    const thread = id => ({ id, resolved: false, anchor, comments: [] });
    acceptThreads([thread({ toString: 1 }), thread("ok1")]);
    if (S.threads.length !== 1 || S.threads[0].id !== "ok1") return "bad id dropped valid thread";
    let converted = false;
    const objectId = { toString() { converted = true; return "x"; } };
    if (![1, null, new String("x"), objectId].every(id => !validThread(thread(id))) || !validThread(thread("x")) || converted) return "incorrect id validation";
    const throwing = { get id() { throw new Error("bad thread"); } };
    acceptThreads([throwing, thread("ok1")]);
    return S.threads.length === 1 && S.threads[0].id === "ok1" || "validation error dropped valid thread";`],
  ["Issues issue pins reuse re-anchoring", "", `
    const P = proj(), row = P.changes.find(r => r.where?.board && rowBox(r, "head")); if (!row) return "skip";
    const b = rowBox(row, "head"), x = (b[0] + b[2]) / 2, y = (b[1] + b[3]) / 2;
    P.objects = [{ uuid: "u-9", kind: "footprint", ref: "Q7", side: "base", pos: [x, y, 0], box: b, layer: "F.Cu" }];
    S.threads = []; acceptIssues([{ number: 12, title: "Q7 heat", url: "https://github.com/o/r/issues/12", state: "open",
      anchor: { v: 1, project: P.dir, file: "f.kicad_pcb", sheet: null, layer: "F.Cu", target: "object", uuid: "u-9", kind: "footprint", ref: "Q7", x, y, side: "head", commit: D.head, severity: "comment" } }]);
    await goTo(row.id);
    const pins = [...document.querySelectorAll("#stage .pin-issue")];
    S.t = "threads"; renderPanel();
    return pins.length === 1 && pins[0].textContent === "#12" && !!pins[0].closest(".world").querySelector(".stack.base")
      && document.querySelector("#panel .issues-group")?.textContent.includes("#12 Q7 heat") || JSON.stringify({pins: pins.length});`],
  ["Issues unlocated findings cannot become issues", "p=1&t=checks", `
    const vs = (proj().checks || []).flatMap(c => c.violations); if (!vs.length) return "skip";
    S.threads = []; S.issues = []; S.checks.scope = "all"; renderPanel();
    const located = vs.find(v => v.pos), unlocated = vs.find(v => !v.pos);
    return (!located || !!findingAnchor(located)) && (!unlocated || findingAnchor(unlocated) === null)
      && (!unlocated || !document.querySelector('#panel [data-issue-for="' + unlocated.id + '"]')) || "wrong";`],

  ["Issues forged and opted-out messages are ignored", "", `
    S.issues = null;
    const wrong = handleParentMessage({ source: {}, data: { kicadReviewIssues: [] } }, false, true);
    const off = handleParentMessage({ source: parent, data: { kicadReviewIssues: [] } }, false, false);
    if (wrong || off || S.issues !== null) return "accepted forbidden message";
    const ok = handleParentMessage({ source: parent, data: { kicadReviewIssues: [] } }, false, true);
    return ok && Array.isArray(S.issues) || "rejected opted-in parent";`],
  ["Issues invalid links and numbers never become cards or pins", "", `
    const anchor = { v: 1, project: proj().dir, file: "f.kicad_pcb", target: "point", sheet: null, x: 1, y: 1, side: "head", commit: D.head };
    const issue = { number: 12, title: "<img src=x onerror=alert(1)>", url: "https://github.com/o/r/issues/12", anchor, state: "open" };
    acceptIssues([{ ...issue, url: "javascript:alert(1)" }, { ...issue, number: -1 }, { ...issue, url: "https://evil.example/o/r/issues/12" }, { ...issue, state: "closed" }, issue]);
    S.t = "threads"; renderPanel();
    return S.issues.length === 1 && !document.querySelector("#panel img") && document.querySelector("#panel .issues-group")?.textContent.includes("<img") || "unsafe issues";`],
  ["Issues actions are opt-in and finding points remain valid", "p=1&t=checks", `
    const checks = proj().checks || []; if (!checks.some(c => c.violations.length)) return "skip";
    const vs = allViolations();
    S.checks.scope = "all"; ISSUES_ON = false; renderPanel(); const before = document.querySelector("#panel").innerHTML;
    S.issues = null; renderPanel();
    if (document.querySelector("#panel [data-issue-for]") || document.querySelector("#panel").innerHTML !== before) return "off changed checks";
    const located = vs.find(v => findingAnchor(v)); if (!located) return "skip";
    ISSUES_ON = true; renderPanel();
    const a = findingAnchor(located), button = document.querySelector('#panel [data-issue-for="' + CSS.escape(located.id) + '"]');
    return !!button && a.target === "point" && a.file.endsWith(".kicad_sch") && a.side === "head" && findingAnchor({ ...located, pos: null }) === null && findingAnchor({ ...located, pos: [NaN, 1] }) === null || "finding action missing";`],
  ["Issues duplicate findings cannot create another issue", "p=1&t=checks", `
    const checks = proj().checks || []; if (!checks.some(c => c.violations.length)) return "skip";
    const v = allViolations().find(v => findingAnchor(v)); if (!v) return "skip";
    const a = findingAnchor(v); ISSUES_ON = true; S.checks.scope = "all"; S.issues = []; renderPanel();
    const selector = '#panel [data-issue-for="' + CSS.escape(v.id) + '"]';
    if (!document.querySelector(selector)) return "initial action missing";
    acceptIssues([{ number: 88, title: "Already tracked", url: "https://github.com/o/r/issues/88", state: "open", anchor: a }]);
    if (document.querySelector(selector)) return "duplicate action still shown";
    acceptIssues([{ number: 88, title: "Other file", url: "https://github.com/o/r/issues/88", state: "open", anchor: { ...a, file: "other.kicad_sch" } }]);
    return !!document.querySelector(selector) || "different location blocked";`],
  ["Waivers hide waived findings behind a chip and tag them", "p=1&t=checks", `
    const P = proj(), c = (P.checks || []).find(c => c.violations.length); if (!c) return "skip";
    const v = c.violations[0]; v.waiver_key = "w-abcdefabcdef"; v.waived = { reason: "intended <b>x</b>", by: "ann", until: "2026-12-31", ref: null };
    c.waived = 1; S.checks.scope = "all"; renderPanel();
    const hidden = !document.querySelector('#panel .viol[data-id="' + v.id + '"]'), chip = document.querySelector('#panel [data-check-waived]');
    chip.focus(); chip.click();
    const focused = document.activeElement.matches("[data-check-waived]"), summary = document.querySelector("#panel .check-counts").textContent;
    const shown = document.querySelector('#panel .viol[data-id="' + v.id + '"]');
    return focused && summary.includes("1 waived") && hidden && chip.textContent.includes("Waived 1") && !!shown && shown.textContent.includes("WAIVED") && shown.textContent.includes("intended <b>x</b>")
      && !document.querySelector("#panel .viol b") || JSON.stringify({hidden, chip: chip?.textContent, shown: shown?.textContent});`],
  ["Waivers offer a copyable TOML entry for an unwaived finding", "p=1&t=checks", `
    const P = proj(), c = (P.checks || []).find(c => ["erc", "drc", "parity"].includes(c.name) && c.violations.length); if (!c) return "skip";
    const v = c.violations.find(x => !x.waived); v.waiver_key = "w-0123456789ab"; S.checks.scope = "all"; renderPanel();
    const b = document.querySelector('#panel [data-waive="' + v.id + '"]'); b.closest('details').open = true; b.focus(); b.click();
    const pre = document.querySelector("#panel .waiver-snippet")?.textContent || "";
    const button = document.activeElement;
    return button.matches('[data-waive]') && button.getAttribute('aria-label') === 'Waive ' + (v.items.join(' · ') || v.description)
      && document.querySelector("#panel .waiver-help").textContent.includes("on the pull request's target branch")
      && document.getElementById(button.getAttribute('aria-controls'))?.textContent === pre && pre.includes('check = "' + c.name + '"') && pre.includes('match = "w-0123456789ab"') && pre.includes("until = ") && pre.includes("[[waiver]]") || pre;`],
  ["Waivers show no waive button without keys", "p=1&t=checks", `
    proj().checks.forEach(c => c.violations.forEach(v => { delete v.waiver_key; delete v.waived; })); S.checks.scope = "all"; renderPanel();
    return !document.querySelector("#panel [data-waive]") && !document.querySelector("#panel [data-check-waived]") || "shown";`],

  ["Waivers show-all reveals an only-waived change", "p=1&t=checks", `
    const c = (proj().checks || []).find(c => c.violations.length); if (!c) return "skip";
    proj().checks.forEach(c => c.violations.forEach(v => { v.new = true; v.waived = { reason: "intentional", by: "ann" }; }));
    S.checks.scope = null; renderPanel();
    const scope = document.querySelector('[data-check-scope="all"]').getAttribute("aria-pressed");
    document.querySelector("#panel .show-all").click();
    return scope === "true" && S.checks.waived && !!document.querySelector("#panel .viol .waived-reason") || "not revealed";`],
  ["Waivers snippets preserve quoted keys and remove comment controls", "p=1&t=checks", `
    const key = 'w-"\\\\b\\\\f\\n\\r\\t' + String.fromCharCode(0, 8, 12, 31, 127);
    const text = waiverSnippet({waiver_key:key, description:'x\\r\\n' + String.fromCharCode(0, 127) + '<b>x</b>'}, 'erc');
    const match = text.split("\\n").find(l => l.startsWith("match = ")).slice(8);
    return JSON.parse(match) === key && !/[\\u0000-\\u0008\\u000b-\\u001f\\u007f]/.test(text) && text.includes('# x  ') || text;`],
  ["SCH6 hierarchy page order boundaries legacy and escaped labels", "", `
    const p = proj(), source = p.sheets.find(s => s.svg);
    if (!source) throw Error('fixture needs a schematic');
    p.sheets = [
      {...source, path:'/', parent:null, name:'Root', page:'1'},
      {...source, path:'/ten/', parent:'/', name:'Ten', page:'10'},
      {...source, path:'/two/', parent:'/', name:'<b>Two</b>', page:'2'},
      {...source, path:'/two/sub/', parent:'/two/', name:'Sub', page:'3'},
      {...source, path:'/a10/', parent:'/', name:'A10', page:'A10'},
      {...source, path:'/a2/', parent:'/', name:'A2', page:'A2'},
      {...source, path:'/old/', parent:'/', name:'Legacy', page:undefined}
    ];
    S.v = 'sheet:/two/sub/'; renderNav();
    const text = document.querySelector('#nav').textContent;
    if (!text.includes('<b>Two</b> (page 2)') || document.querySelector('#nav .name b')) return 'label escaping';
    if (orderedSheets().map(s=>sheetNumber(s)).join(',') !== '1,2,3,7,10,A2,A10') return 'page order';
    navigateSheet('parent'); if (S.v !== 'sheet:/two/') return 'parent';
    navigateSheet(-1); if (S.v !== 'sheet:/') return 'previous';
    navigateSheet(-1); if (S.v !== 'sheet:/') return 'first boundary';
    S.v = 'sheet:/a10/'; renderNav(); navigateSheet(1);
    if (S.v !== 'sheet:/a10/') return 'last boundary';
    const ten=p.sheets.find(s=>s.path==='/ten/'), two=p.sheets.find(s=>s.path==='/two/');
    ten.page='2';
    if(compareSheetPages(ten,two)>=0) return 'duplicate-page traversal tie';
    const row = document.querySelector('#nav [data-view="sheet:/a10/"]');
    return row?.getAttribute('aria-current') === 'true'
      && parseInt(getComputedStyle(row.querySelector('.name')).fontWeight) >= 600
      && text.includes('Legacy (page 7)') || 'active/legacy';
  `],
  ["SCH6 sheet keys leave editors and board keys alone", "", `
    const p=proj(), source=p.sheets.find(s=>s.svg);
    p.sheets=[{...source,path:'/',parent:null,page:'1'},
              {...source,path:'/c/',parent:'/',page:'2'}];
    S.v='sheet:/'; renderNav();
    const key=(target,key,extra={})=>target.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...extra}));
    key(document.body,'PageDown'); if(S.v!=='sheet:/c/') return 'next key';
    key(document.body,'ArrowUp',{altKey:true}); if(S.v!=='sheet:/') return 'parent key';
    const input=document.createElement('div'); input.contentEditable='true'; document.body.append(input);
    key(input,'PageDown'); input.remove(); if(S.v!=='sheet:/') return 'editor stolen';
    S.v='board'; const old=S.v; key(document.body,'ArrowUp',{altKey:true});
    return S.v===old || 'board changed';
  `],
  ["board scene stale decode does not replace current view", "v=board&x=10&y=20&z=5", `
    const geometryProject=D.projects.findIndex(p=>p.board.geometry?.base && p.board.geometry?.head);
    if(geometryProject>=0) {S.p=geometryProject; await draw();}
    const old = loadBoardScene;
    let release; const blocked = new Promise(r => release = r);
    loadBoardScene = async key => { await blocked; return old(key); };
    const a = draw();
    const sheet = proj().sheets.find(s => s.svg);
    if (!sheet) { loadBoardScene = old; release?.(); await a; return "skip"; }
    S.v = "sheet:" + sheet.path; const b = draw(); release?.();
    await Promise.all([a, b]); loadBoardScene = old;
    return S.v.startsWith("sheet:") && !document.querySelector(".board-gl");`],
  ["board scene loader decodes cached scenes and rejects bad blobs", "v=board", `
    const gz = async text => { const buf = await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer(); return btoa(String.fromCharCode(...new Uint8Array(buf))); };
    D.blobs.sceneOk = await gz(JSON.stringify({version: 1, units: "um", complete: true, warnings: [], bounds: [0, 0, 1, 1], layers: [], nets: [{id: 0, name: ""}], objects: []}));
    D.blobs.sceneBad = await gz("{not json");
    D.blobs.sceneShape = await gz('{"version":2}');
    const fails = [];
    for (const k of ["sceneBad", "sceneShape"]) { try { await loadBoardScene(k); } catch { fails.push(k); } }
    const scene = await loadBoardScene("sceneOk");
    return scene.version === 1 && await loadBoardScene("sceneOk") === scene && fails.length === 2
      && !boardSceneCache.has("sceneBad") && !boardSceneCache.has("sceneShape") && await loadBoardScene(null) === null || "loader";`],
  ["board rings holes islands and DPR", "", `
    if (!window.BoardGL) return "missing BoardGL";
    const R = (...a) => a.map(([x0,y0,x1,y1]) => [[x0,y0],[x1,y0],[x1,y1],[x0,y1]]);
    const [outer, hole, island] = R([0,0,10000,10000],[2000,2000,8000,8000],[12000,0,14000,2000]);
    const concave = [[0,0],[10000,0],[10000,10000],[6000,10000],[6000,5000],[4000,5000],[4000,10000],[0,10000]];
    const zone = (uuid, rings, box) => ({kind:"zone",uuid,changeUuid:uuid,layers:["F.Cu"],net:0,category:"zones",side:null,hidden:false,box:box||[0,0,14000,10000],geometry:{rings}});
    const mk = objects => ({version:1,units:"um",complete:true,warnings:[],bounds:[0,0,14000,10000],layers:[{id:0,name:"F.Cu",type:"signal",enabled:true}],nets:[{id:0,name:""}],objects});
    const bg = [0,16,35], copper = [200,52,52], equal = (p,q) => p.slice(0,3).every((v,i)=>Math.abs(v-q[i])<=2);
    const state = {activeLayer:"F.Cu",layers:{"F.Cu":{color:[200,52,52,1],visible:true}},objects:{zones:{opacity:1}},nets:{}};
    const reversed = [...hole].reverse();
    const cases = [["plain",[outer,hole,island]],["reversed hole",[outer,reversed,island]],["repeated closing point",[[...outer,outer[0]],hole,island]]];
    const failures = [], canvas = document.createElement("canvas");
    canvas.style.cssText = "position:fixed;left:300px;top:180px;width:400px;height:300px;z-index:9999";
    document.body.append(canvas);
    try {
      for (const dpr of [1,2]) for (const [name, rings] of cases) {
        const r = BoardGL.create(canvas,{scene:mk([zone("z",rings)]),onFailure:e=>failures.push(e.message)});
        if (!r) return "WebGL2/stencil unavailable: " + failures;
        const cam = {x:7,y:5,z:20,width:400,height:300,dpr,flip:false};
        r.setAppearance(state); r.setCamera(cam); r.draw();
        const at = (wx,wy) => { const [sx,sy] = BoardGL.worldToScreen([wx,wy],cam); return r.readPixel(Math.round(sx*dpr), Math.round(300*dpr-sy*dpr)); };
        const got = [at(1,1),at(5,5),at(13,1),at(11,1)];
        if (![copper,bg,copper,bg].every((c,i)=>equal(got[i],c))) return name+" dpr"+dpr+" "+JSON.stringify(got);
        r.dispose();
      }
      // concave outer: the notch between x 4..6, y 5..10 stays empty; two overlapping zones keep separate parity.
      let r = BoardGL.create(canvas,{scene:mk([zone("c",[concave],[0,0,10000,10000])]),onFailure:e=>failures.push(e.message)});
      let cam = {x:7,y:5,z:20,width:400,height:300,dpr:1,flip:false};
      r.setAppearance(state); r.setCamera(cam); r.draw();
      let at = (wx,wy) => { const [sx,sy] = BoardGL.worldToScreen([wx,wy],cam); return r.readPixel(Math.round(sx), Math.round(300-sy)); };
      if (!equal(at(1,8),copper) || !equal(at(5,8),bg) || !equal(at(5,2),copper) || !equal(at(8,8),copper)) return "concave bridge " + JSON.stringify([at(1,8),at(5,8),at(5,2),at(8,8)]);
      r.dispose();
      r = BoardGL.create(canvas,{scene:mk([zone("a",[outer],[0,0,10000,10000]),zone("b",[R([4000,4000,12000,9000])[0]],[4000,4000,12000,9000])]),onFailure:e=>failures.push(e.message)});
      r.setAppearance(state); r.setCamera(cam); r.draw();
      at = (wx,wy) => { const [sx,sy] = BoardGL.worldToScreen([wx,wy],cam); return r.readPixel(Math.round(sx), Math.round(300-sy)); };
      if (!equal(at(6,6),copper) || !equal(at(11,6),copper) || !equal(at(1,1),copper) || !equal(at(11,2),bg)) return "overlapping zones " + JSON.stringify([at(6,6),at(11,6),at(1,1),at(11,2)]);
      // grid: dot at a 0.5 mm intersection, none between; off leaves the board unchanged.
      r.dispose();
      r = BoardGL.create(canvas,{scene:mk([]),onFailure:e=>failures.push(e.message)});
      r.setCamera({x:7,y:5,z:40,width:400,height:300,dpr:1,flip:false});
      const gstate = {...state, grid:{visible:true,size:.5}}; r.setAppearance(gstate); r.draw();
      const dot = r.readPixel(200+Math.round((7.5-7)*40),300-(150+Math.round((5.5-5)*40))), gap = r.readPixel(200+Math.round(.25*40),300-(150+Math.round(.25*40)));
      if (equal(dot,bg) || !equal(gap,bg)) return "grid dot/gap " + JSON.stringify([dot,gap]);
      r.setAppearance({...state}); r.draw();
      if (!equal(r.readPixel(200,150),bg)) return "grid off";
      r.dispose(); r.dispose();
      return failures.length ? failures.join() : true;
    } finally { canvas.remove(); }`],
  ["Stage 1 icon references resolve in-file in both themes", "", `
  const old=KRTheme.get();
  try {
    for(const theme of ['dark','light']) {
      KRTheme.set(theme);
      for(const use of document.querySelectorAll('button use')) {
        if(!document.querySelector(use.getAttribute('href'))) return 'unresolved '+use.getAttribute('href');
      }
      const b=document.querySelector('#zoombar [data-z="1.25"]');
      const icons=[...b.querySelectorAll('svg')].filter(s=>getComputedStyle(s).display!=='none');
      // Bench toolbar icons are one currentColor symbol that follows the theme's text colour.
      if(icons.length!==1) return 'palette';
      const box=icons[0].getBBox(); if(!box.width || !box.height) return 'empty icon';
      if(!b.getAttribute('aria-label') || !b.title) return 'unlabeled';
    }
    return true;
  } finally { KRTheme.set(old); }`],
  ["Stage 1 offline asset closure and shell proof", "v=board", `
  const external=[...document.querySelectorAll('script[src],link[rel=stylesheet][href],use[href]')]
    .filter(el=>!(el.getAttribute('href')||'').startsWith('#'));
  const embedded=!document.querySelector('script[src="review.js"]');
  if(embedded && external.length) return external.map(el=>el.outerHTML).join(' ');
  if(!document.querySelector('[data-theme-set]') || !document.querySelector('#statusbar')) return 'missing shell';
  const old=KRTheme.get();
  KRTheme.set('light'); const light=getComputedStyle(document.body).backgroundColor;
  KRTheme.set('dark'); const dark=getComputedStyle(document.body).backgroundColor;
  KRTheme.set(old);
  return light==='rgb(207, 212, 216)' && dark==='rgb(10, 12, 14)';`],
  ["board WebGL cameras fallback and context loss", "v=board&x=10&y=20&z=5", `
    const p = proj(); if (!p.board?.changed) return "skip";
    const gz = async text => { const buf = await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer(); return btoa(String.fromCharCode(...new Uint8Array(buf))); };
    const scene = {version:1,units:"um",complete:true,warnings:[{uuid:"u<img src=x onerror=alert(1)>",kind:"track",reason:"r"}],bounds:[0,0,8000,5000],layers:[{id:0,name:"F.Cu",type:"signal",enabled:true}],nets:[{id:0,name:""}],
      objects:[{kind:"track",uuid:"t",changeUuid:"t",layers:["F.Cu"],net:0,category:"tracks",side:null,hidden:false,box:[750,750,6250,1250],geometry:{segments:[[1000,1000,6000,1000,500]]}}]};
    D.blobs.glA = await gz(JSON.stringify(scene)); D.blobs.glB = await gz(JSON.stringify(scene));
    const saved = p.board.geometry;
    try {
      p.board.geometry = {base:"glA", head:"glB"}; boardView.failed = null; S.m = "side"; S.v = "board"; await draw();
      if (boardView.renderers.length !== 2) return "expected two supported revision canvases";
      if (document.querySelectorAll(".vp > .board-gl").length !== 2 || document.querySelector(".stack .layer")) return "canvases not in viewports";
      if (document.querySelector(".board-diag img") || !document.querySelector(".board-diag pre").textContent.includes("<img")) return "diagnostics not literal text";
      const first = boardView.renderers[0]; await draw();
      if (boardView.renderers[0] !== first || first.stats.disposed) return "renderer not retained across draw";
      setT({x:12,y:22,z:6});
      if (boardView.renderers.some(r => r.stats.disposed)) return "disposed current scene";
      const canvas = document.querySelector(".board-gl");
      canvas.dispatchEvent(new Event("webglcontextlost",{cancelable:true}));
      for(let i=0;i<100 && !document.querySelector("#stage .stack .layer");i++) await new Promise(r=>setTimeout(r,50));
      if (document.querySelector(".board-gl") || !document.querySelector(".stack .layer")) return "no SVG fallback";
      if (!document.querySelector("#statusbar .status-message").textContent.includes("WebGL unavailable")) return "no status note";
      return S.x === 12 && S.y === 22 && S.z === 6 || "camera lost " + [S.x,S.y,S.z];
    } finally { p.board.geometry = saved; boardView.failed = null; boardView.note = null; S.m = "side"; }`],
  ["board WebGL missing context, bad scenes, added-only and SVG modes", "v=board", `
    const p = proj(); if (!p.board?.changed) return "skip";
    const gz = async text => { const buf = await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer(); return btoa(String.fromCharCode(...new Uint8Array(buf))); };
    const scene = c => ({version:1,units:"um",complete:c,warnings:[],bounds:[0,0,8000,5000],layers:[{id:0,name:"F.Cu",type:"signal",enabled:true}],nets:[{id:0,name:""}],objects:[]});
    D.blobs.glOk = await gz(JSON.stringify(scene(true))); D.blobs.glPart = await gz(JSON.stringify(scene(false))); D.blobs.glBad = await gz("{nope");
    const saved = p.board.geometry, create = BoardGL.create, status = () => document.querySelector("#statusbar .status-message").textContent;
    const svgOk = () => !!document.querySelector(".stack .layer") && !document.querySelector(".board-gl");
    try {
      S.v = "board"; S.m = "side";
      delete p.board.geometry;
      for (const m of ["side","overlay","wipe","blend","semantic"]) { S.m = m; await draw(); if (!svgOk()) return "no geometry " + m; }
      S.m = "side"; p.board.geometry = {base:"glOk", head:"glOk"};
      BoardGL.create = () => null; boardView.failed = null; await draw();
      if (!svgOk() || !status().includes("WebGL unavailable")) return "missing WebGL2 " + status();
      BoardGL.create = create; boardView.failed = null;
      for (const [key, g] of [["corrupt", {base:"glBad", head:"glOk"}], ["incomplete", {base:"glOk", head:"glPart"}]]) {
        p.board.geometry = g; await draw();
        if (!svgOk() || !status().includes("Geometry unsupported")) return key + " " + status();
      }
      for (const g of [{base:null, head:"glOk"}, {base:"glOk", head:null}]) {
        p.board.geometry = g; await draw();
        if (boardView.renderers.length !== 2 || document.querySelectorAll(".vp .tag")[g.base ? 1 : 0].textContent.indexOf("not present") < 0) return "one-sided " + JSON.stringify(g);
      }
      for (const m of ["overlay","wipe","blend","semantic"]) { p.board.geometry = {base:"glOk", head:"glOk"}; S.m = m; await draw(); if (svgOk() || boardView.renderers.length !== 1 || !boardDiff) return "mode " + m; }
      return true;
    } finally { BoardGL.create = create; p.board.geometry = saved; boardView.failed = null; boardView.note = null; S.m = "side"; }`],
  ["board flip adapters mirror camera, overlays and pointer", "v=board&x=10&y=20&z=5", `
    const p = proj(); if (!p.board?.changed) return "skip";
    const geometry=p.board.geometry; delete p.board.geometry;
    try {
    S.v = "board"; S.m = "side"; await draw();
    const vp0 = document.querySelector("#stage .vp"), r0 = vp0.getBoundingClientRect(), e = {clientX: r0.left + r0.width / 2 + 100, clientY: r0.top + r0.height / 2 + 50};
    const plain = toWorld(vp0, e);
    Appearance.patch({flip:true});
    try {
      await new Promise(r => setTimeout(r, 50));
      const vp = document.querySelector("#stage .vp"), r = vp.getBoundingClientRect(), flipped = toWorld(vp, e);
      if (Math.abs(flipped[0] - (S.x - (plain[0] - S.x))) > 1e-6 || flipped[1] !== plain[1]) return "inverse " + [plain, flipped];
      const back = BoardGL.worldToScreen(flipped, {x:S.x,y:S.y,z:S.z,width:r.width,height:r.height,flip:true});
      if (Math.abs(back[0] - (e.clientX - r.left)) > 1e-6) return "forward";
      const w = document.querySelector("#stage .world");
      if (!w.style.transform.includes("scale(-") || !vp.classList.contains("flip")) return "world not mirrored " + w.style.transform;
      if (S.x !== 10 || S.y !== 20 || S.z !== 5) return "flip changed the camera";
      if (location.hash.includes("flip")) return "flip leaked into the hash";
    } finally { Appearance.patch({flip:false}); }
    await new Promise(r => setTimeout(r, 100));
    return !document.querySelector("#stage .world").style.transform.includes("scale(-");
    } finally {p.board.geometry=geometry;} `],
  ["board Appearance store get patch subscribe reset and validation", "", `
    const A = window.Appearance, before = JSON.stringify(A.get());
    let calls = 0; const off = A.subscribe(() => calls++);
    try {
      A.patch({contrast:"dim", grid:{visible:true,size:2}, layers:{"F.Cu":{color:[1,2,3,.5],opacity:.4}}});
      const s = A.get();
      if (s.contrast !== "dim" || !s.grid.visible || s.grid.size !== 2 || s.layers["F.Cu"].opacity !== .4 || s.layers["F.Cu"].color[3] !== .5 || calls !== 1) return "patch";
      A.patch({contrast:"bad", flip:"yes", grid:{size:-1}, layers:{"F.Cu":{opacity:NaN,color:[1,2,3]},"__proto__":{visible:false},"Nope":{visible:false}}, objects:{tracks:{opacity:9}}, nets:{"__proto__":{visible:false},"<img>":{visible:false}}});
      const t = A.get();
      if (t.contrast !== "dim" || t.flip !== false || t.grid.size !== 2 || t.layers["F.Cu"].opacity !== .4 || t.layers.Nope || t.objects.tracks.opacity !== 1 || ({}).visible !== undefined || !t.nets["<img>"]) return "validation " + JSON.stringify(t.layers["F.Cu"]);
      if (!Object.values(JSON.parse(localStorage.getItem("kr.appearance.v1")).viewers).some(s=>s.contrast === "dim")) return "not persisted";
      const throwing = Storage.prototype.setItem; Storage.prototype.setItem = () => { throw new Error("blocked"); };
      try { A.patch({contrast:"hide"}); } finally { Storage.prototype.setItem = throwing; }
      if (A.get().contrast !== "hide") return "blocked storage";
      A.reset();
      return JSON.stringify(A.get()) === before && A.defaults(["F.Cu"]).objects.zones.opacity === .6 && A.normalize(null).contrast === "normal" && calls === 4 || "reset " + calls;
    } finally { off(); A.reset(); }`],
  ["board layer paint preserves custom colours and store snapshots", "v=board", `
    const d=document.createElement('div'); d.innerHTML='<svg><path fill="none" stroke="rgb(200,52,52)" style="opacity:.3"/><path fill="#123456" stroke="#c83434"/></svg>';
    recolorLayer(d,{color:[1,2,3,1],opacity:.5},KicadColors.layers['F.Cu']);
    const [a,b]=d.querySelectorAll('path');
    if(a.getAttribute('fill')!=='none' || a.getAttribute('stroke')!=='#010203' || a.style.opacity!=='.3' && a.style.opacity!=='0.3') return 'layer paint';
    if(b.getAttribute('fill')!=='#123456' || b.getAttribute('stroke')!=='#010203') return 'custom paint overwritten';
    const look=Appearance.get(), old=look.flip; look.flip=!old;
    if(Appearance.get().flip!==old) { Appearance.patch({flip:old}); return 'mutable snapshot'; }
    return true;`],
  ["Fit board keeps a finite shared camera", "v=board", `
    S.v='board'; S.m='side'; await draw(); fit();
    return Number.isFinite(S.x) && Number.isFinite(S.y) && Number.isFinite(S.z) && S.z>0;`],
  ["Wipe Blend board SVG respect Appearance layer eyes", "v=board", `
    const before=Appearance.get(), geometry=proj().board.geometry; delete proj().board.geometry;
    try {
      for(const m of ['wipe','blend']) {
        S.v='board'; S.m=m; await draw();
        const layer=document.querySelector('.stack .layer'); if(!layer) return 'no SVG '+m;
        const name=canon(layer.dataset.layer);
        Appearance.patch({layers:{[name]:{visible:false}}}); await draw();
        if([...document.querySelectorAll('.stack .layer')].some(l=>canon(l.dataset.layer)===name)) return 'eye ignored '+m;
        Appearance.patch({layers:{[name]:before.layers[name]}});
      }
      return true;
    } finally { proj().board.geometry=geometry; Appearance.patch(before); }`],
  ["Themes share colours across board and lazy schematic", "v=board", `
    const geometryProject=D.projects.findIndex(p=>p.board.geometry?.base && p.board.geometry?.head);
    if(geometryProject<0) return 'skip';
    S.p=geometryProject; S.x=S.y=S.z=null; await draw();
    await new Promise(r=>setTimeout(r,250));
    const store=appearanceStore(), before=store.get(), hash=location.hash;
    const original=WebGL2RenderingContext.prototype.bufferData, sub=WebGL2RenderingContext.prototype.bufferSubData;
    let uploads=0;
    try {
      if(store!==Appearance) return 'second store';
      await draw();
      if(!appearanceBoards.size) return 'no live board';
      WebGL2RenderingContext.prototype.bufferData=function(...args){uploads++;return original.apply(this,args)};
      WebGL2RenderingContext.prototype.bufferSubData=function(...args){uploads++;return sub.apply(this,args)};
      store.import(JSON.stringify({meta:{version:5},board:{background:'#fafafa',copper:{f:'rgba(1,2,3,.5)'}},schematic:{background:'#fff',wire:'#123456'}}));
      store.patch({layerOpacity:{'F.Cu':.4},objectOpacity:{zones:.2}});
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      for(const board of appearanceBoards) {
        if(board.appearance.colors['board.copper.f'][0]!==1/255) return 'board stale';
        if(Math.abs(board.layerRGBA('F.Cu','zones','')[3]-.04)>1e-8) return 'alpha multiplied twice';
      }
      store.reset(); store.import(JSON.stringify({meta:{version:5},schematic:{wire:'#123456'}}));
      if(uploads) return 'theme uploaded geometry '+uploads;
      WebGL2RenderingContext.prototype.bufferData=original; WebGL2RenderingContext.prototype.bufferSubData=sub;
      const sheet=proj().sheets.find(s=>s.svg); if(!sheet) return 'fixture needs schematic';
      S.v='sheet:'+sheet.path; await draw();
      if(!appearanceSchematics.size||appearanceBoards.size) return 'stale lifecycle';
      for(const svg of appearanceSchematics) if(!svg.style.getPropertyValue('--sch-ink-009600').includes('18,52,86')) return 'wire stale';
      store.patch({colors:{'schematic.wire':[1,0,0,1]}});
      for(const svg of appearanceSchematics) if(!svg.style.getPropertyValue('--sch-ink-009600').includes('255,0,0')) return 'mounted wire stale';
      S.v='board'; await draw();
      if(appearanceSchematics.size || !appearanceBoards.size) return 'stale schematic after board mount';
      return location.hash===hash || 'appearance changed deep link';
    } finally {
      WebGL2RenderingContext.prototype.bufferData=original; WebGL2RenderingContext.prototype.bufferSubData=sub;
      store.set(before);
    }`],
  ["Themes fallback modes and context recovery retain snapshot", "v=board", `
    const geometryProject=D.projects.findIndex(p=>p.board.geometry?.base && p.board.geometry?.head);
    if(geometryProject<0) return 'skip';
    S.p=geometryProject; S.x=S.y=S.z=null; await draw();
    const store=appearanceStore(), before=store.get();
    try {
      store.import(JSON.stringify({meta:{version:5},board:{background:'#121a24',copper:{f:'rgba(1,2,3,.5)'}}}));
      store.patch({layerOpacity:{'F.Cu':.4}});
      for(const mode of ['side','overlay','wipe','blend','semantic']) {
        S.m=mode; await draw();
        if(!appearanceBoards.size) return 'fixture needs supported geometry '+mode;
        for(const board of appearanceBoards) {
          if(board.appearance.colors['board.copper.f'][0]!==1/255) return 'compositor stale '+mode;
          if(Math.abs(board.layerRGBA('F.Cu','zones','')[3]-.2*store.get().objectOpacity.zones)>1e-8) return 'compositor alpha '+mode;
        }
        boardView.failed=S.p; await draw();
        if(appearanceBoards.size) return 'stale board in fallback '+mode;
        const layers=[...document.querySelectorAll('.stack .layer')].filter(l=>canon(l.dataset.layer)==='F.Cu');
        if(!layers.length || layers.some(l=>Math.abs(Number(l.style.opacity)-.2)>1e-8)) return 'fallback alpha '+mode;
        if(!layers.some(l=>l.innerHTML.includes('#010203'))) return 'fallback RGB '+mode;
        boardView.failed=null;
      }
      S.m='side'; await draw();
      const canvas=document.querySelector('.board-gl');
      canvas.dispatchEvent(new Event('webglcontextlost',{cancelable:true}));
      for(let i=0;i<100 && !document.querySelector('#stage .stack .layer');i++) await new Promise(r=>setTimeout(r,50));
      if(appearanceBoards.size || !document.querySelector('.stack .layer')) return 'context loss cleanup';
      canvas.dispatchEvent(new Event('webglcontextrestored'));
      for(let i=0;i<100 && !appearanceBoards.size;i++) await new Promise(r=>setTimeout(r,50));
      if(!appearanceBoards.size) return 'no recovered renderer';
      for(const board of appearanceBoards) if(board.appearance.colors['board.copper.f'][3]!==.5) return 'recovered stale';
      const create=BoardGL.create;
      try {
        disposeBoardRenderers(); BoardGL.create=()=>null; boardView.failed=null; await draw();
        if(appearanceBoards.size || !document.querySelector('.stack .layer')) return 'forced fallback failed';
        const copper=[...document.querySelectorAll('.stack .layer')].filter(l=>canon(l.dataset.layer)==='F.Cu');
        if(!copper.some(l=>l.innerHTML.includes('#010203')) || copper.some(l=>Math.abs(Number(l.style.opacity)-.2)>1e-8)) return 'forced fallback stale';
      } finally {BoardGL.create=create; boardView.failed=null;}
      await draw();
      return true;
    } finally {store.set(before); S.m='side';}
  `],
  ["Themes board snapshot", "v=board", `
    const geometryProject=D.projects.findIndex(p=>p.board.geometry?.base && p.board.geometry?.head);
    if(geometryProject<0) return 'skip';
    S.p=geometryProject; S.x=S.y=S.z=null; await draw();
    S.v='board'; S.m='side'; await draw();
    return appearanceBoards.size===2 || 'fixture needs both live revisions';
  `],
  ["Themes schematic snapshot", "v=board", `
    const geometryProject=D.projects.findIndex(p=>p.board.geometry?.base && p.board.geometry?.head);
    if(geometryProject<0) return 'skip';
    S.p=geometryProject; S.x=S.y=S.z=null; await draw();
    const sheet=proj().sheets.find(s=>s.svg); if(!sheet) return 'fixture needs schematic';
    S.v='sheet:'+sheet.path; S.m='side'; await draw();
    return appearanceSchematics.size===2 && !appearanceBoards.size || 'incorrect mounted resources';
  `],
  ["Themes actual uniforms multiply alpha once and upload no geometry", "", `
    const canvas=document.createElement('canvas');
    canvas.style.cssText='position:fixed;width:200px;height:200px;left:0;top:0'; document.body.append(canvas);
    const scene={version:1,units:'um',complete:true,warnings:[],bounds:[0,0,2000,2000],
      layers:[{id:0,name:'F.Cu',type:'signal',enabled:true}],nets:[{id:1,name:'N'}],
      objects:[{kind:'track',uuid:'t',changeUuid:'t',layers:['F.Cu'],net:1,category:'tracks',side:null,hidden:false,box:[0,500,2000,1500],geometry:{segments:[[0,1000,2000,1000,1000]]}}]};
    const r=BoardGL.create(canvas,{scene}); if(!r) {canvas.remove();return 'WebGL unavailable';}
    try {
      const state=KrAppearance.defaults(); state.colors['board.background']=[0,0,0,1];
      state.colors['board.copper.f']=[1,0,0,.5]; state.layerOpacity['F.Cu']=.4; state.objectOpacity.tracks=.2;
      r.setCamera({x:1,y:1,z:100,width:200,height:200,dpr:1});
      r.setAppearance(KrAppearance.resolve(state)); r.draw(); const uploads=r.stats.uploads;
      const close=(a,b)=>a.every((v,i)=>Math.abs(v-b[i])<=1);
      if(!close(r.readPixel(100,100).slice(0,3),[10,0,0])) return 'layer/object alpha '+r.readPixel(100,100);
      state.netColors.N=[0,1,0,.5]; r.setAppearance(KrAppearance.resolve(state)); r.draw();
      if(!close(r.readPixel(100,100).slice(0,3),[0,10,0])) return 'net alpha squared '+r.readPixel(100,100);
      r.draw({filter:()=>true});
      if(!close(r.readPixel(100,100).slice(0,3),[0,10,0])) return 'filtered net alpha squared '+r.readPixel(100,100);
      r.draw({filter:()=>true,override:(object,normal)=>normal});
      if(!close(r.readPixel(100,100).slice(0,3),[0,10,0])) return 'override net alpha squared '+r.readPixel(100,100);
      state.netColors.N[3]=0; r.setAppearance(KrAppearance.resolve(state)); r.draw();
      if(!close(r.readPixel(100,100).slice(0,3),[0,0,0])) return 'zero-alpha net ignored';
      return r.stats.uploads===uploads || 'theme uploaded geometry';
    } finally {r.dispose();canvas.remove();}
  `],
  ["board geometry contract", "v=board", `
    const panel = document.createElement('section');
    panel.style.cssText = 'position:fixed;inset:100px 350px auto;z-index:9999;padding:20px;background:var(--bg);color:var(--text);border:1px solid currentColor';
    const title = document.createElement('h2'); title.textContent = 'Retained geometry picking contract';
    const caption = document.createElement('p');
    caption.textContent = 'Pad / parent c1: hole (10,10) misses; annulus (11.5,10) hits; empty corner (8,8) misses. Zone hole also misses.';
    const canvas = document.createElement('canvas'); canvas.style.cssText = 'width:600px;height:360px';
    panel.append(title, caption, canvas); document.body.append(panel);
    const object = (uuid, kind, geometry, box, changeIds=['c1']) => ({uuid, changeUuid:'parent', kind, geometry, box, changeIds, parentKey:'parent', ref:'U1', layers:['F.Cu'],net:0,category:kind==='zone'?'zones':'pads',side:'front',hidden:false});
    const pad = object('pad','pad',{primitive:{shape:'circle',center:[10000,10000],size:[4000,4000],angle:0},drill:{center:[10000,10000],size:[2000,2000],angle:0}},[8000,8000,12000,12000]);
    const zone = object('zone','zone',{rings:[[[14000,8000],[18000,8000],[18000,12000],[14000,12000]],[[15000,9000],[17000,9000],[17000,11000],[15000,11000]]]},[14000,8000,18000,12000],['c2']);
    const parent = object('parent','footprint',{},[7000,7000,13000,13000]);
    const scene = {version:1,units:'um',complete:true,warnings:[],bounds:[6000,6000,20000,14000],layers:[{id:0,name:'F.Cu',type:'signal',enabled:true}],nets:[{id:0,name:''}],objects:[parent,pad,zone]};
    const renderer = BoardGL.create(canvas,{scene}); if (!renderer) return 'no WebGL2';
    const camera = {x:13,y:10,z:40,width:600,height:360,dpr:1};
    let appearance = {layers:{'F.Cu':{visible:true,opacity:1}},objects:{},nets:{},grid:{visible:true,size:1}};
    renderer.setCamera(camera); renderer.setAppearance(appearance); renderer.draw();
    try {
      const hits = point => renderer.hitTest(renderer.worldToScreen(point));
      if (hits([10,10]).length || hits([8,8]).length) return 'hole or empty footprint bbox hit';
      const annulus = hits([11.5,10]);
      if (annulus.length!==1 || annulus[0].uuid!=='pad' || annulus[0].changeIds.join(',')!=='c1') return 'missing child / parent identity';
      if (hits([16,10]).length || hits([14.5,10])[0]?.uuid!=='zone') return 'zone hole parity';
      const uploads = renderer.stats.uploads;
      renderer.setAppearance({...appearance,layers:{'F.Cu':{opacity:.5}}});
      let normal;
      renderer.draw({filter:o=>o.uuid==='pad',override:(o,style)=>{normal ??= style;return style;}});
      if (Math.abs(normal.opacity-.5)>1e-9) return 'callback multiplies layer opacity twice';
      renderer.setAppearance({...appearance,activeLayer:'B.Cu',contrast:'dim'});
      let drawnStyle, maskStyle;
      renderer.draw({filter:o=>o.uuid==='pad',override:(o,style)=>{drawnStyle ??= style;return style;}});
      renderer.draw({mask:true,filter:o=>o.uuid==='pad',override:(o,style)=>{maskStyle ??= style;return style;}});
      if (JSON.stringify(drawnStyle)!==JSON.stringify(maskStyle)) return 'mask changes effective normal style';
      renderer.setAppearance(appearance);
      renderer.draw({mask:true,filter:o=>o.uuid==='pad',override:()=>({color:[1,1,1],opacity:1})});
      let [sx,sy] = renderer.worldToScreen([11.5,10]);
      if (renderer.readPixel(Math.floor(sx),359-Math.floor(sy))[0]<240) return 'mask override';
      [sx,sy] = renderer.worldToScreen([10,10]);
      if (renderer.readPixel(Math.floor(sx),359-Math.floor(sy))[0]>0) return 'mask includes drill';
      for (const state of [
        {...appearance,layers:{'F.Cu':{visible:false}}},
        {...appearance,layers:{'F.Cu':{opacity:0}}},
        {...appearance,layers:{'F.Cu':{color:[200,52,52,0]}}},
        {...appearance,objects:{pads:{opacity:0}}},
        {...appearance,nets:{'':{color:[200,52,52,0]}}},
        {...appearance,objects:{pads:{visible:false}}},
        {...appearance,nets:{'':{visible:false}}}
      ]) {
        renderer.setAppearance(state);
        if (hits([11.5,10]).length) return 'invisible geometry hit';
        renderer.draw({mask:true,filter:o=>o.uuid==='pad',override:()=>({color:[1,1,1],opacity:1})});
        [sx,sy] = renderer.worldToScreen([11.5,10]);
        if (renderer.readPixel(Math.floor(sx),359-Math.floor(sy))[0]) return 'override resurrected hidden geometry';
      }
      renderer.setAppearance({...appearance,flip:true});
      const point=[11.5,10], back=renderer.screenToWorld(renderer.worldToScreen(point));
      if (Math.abs(back[0]-point[0])>1e-9 || hits(point)[0]?.uuid!=='pad') return 'flip projection';
      renderer.setAppearance(appearance); renderer.draw();
      if (renderer.stats.uploads!==uploads) return 'contract rebuilt buffers';
      caption.textContent += ' All assertions passed. Hidden layers, objects, nets, zero opacity and flip verified.';
      // Preserve the verified fixture for --shot after releasing its GL resources.
      const snapshot = document.createElement('canvas');
      snapshot.width = canvas.width; snapshot.height = canvas.height; snapshot.style.cssText = canvas.style.cssText;
      snapshot.getContext('2d').drawImage(canvas,0,0); canvas.replaceWith(snapshot);
      return true;
    } finally { renderer.dispose(); }`],
  ["board composite pixels clips group alpha and lifecycle", "v=board&m=overlay", `
    const stage=document.createElement('main'); stage.style.cssText='position:fixed;left:0;top:0;width:801px;height:400px;display:flex;z-index:9999'; document.body.append(stage);
    const pad=(x,id)=>({uuid:id,changeUuid:id,kind:'pad',changeIds:id==='same'?[]:[id],layers:['F.Cu'],net:0,category:'pads',side:'front',hidden:false,box:[x-2000,8000,x+2000,12000],geometry:{primitive:{shape:'circle',center:[x,10000],size:[4000,4000],angle:0}}});
    const scene=objects=>({version:1,units:'um',complete:true,warnings:[],bounds:[0,0,50000,20000],layers:[{id:0,name:'F.Cu',type:'signal',enabled:true}],nets:[{id:0,name:''}],objects});
    const scenes={base:scene([pad(10000,'old'),pad(30000,'same')]),head:scene([pad(20000,'new'),pad(20000,'new'),pad(30000,'same')])};
    const state={m:'overlay',x:25,y:10,z:12,wipe:.5,blend:.5};
    const look={layers:{'F.Cu':{visible:true,color:[200,100,40,1],opacity:1}},objects:{},nets:{},grid:{visible:false},background:[0,16,35,1]};
    let c;
    const near=(a,b)=>a.every((v,i)=>Math.abs(v-b[i])<=3);
    try {
      c=BoardDiff.mount({stage,scenes,changes:[{id:'old',action:'removed'},{id:'new',action:'added'}],state,appearance:()=>look,onLost:e=>{throw e}});
      const rgb=p=>Array.from(c.readPixel(0,...c.panes[0].renderer.project(p))).slice(0,3);
      c.render();
      for(const [point,color] of [[[10,10],[255,64,64]],[[20,10],[64,255,64]],[[30,10],[64,64,16]],[[40,10],[255,255,255]]]) if(!near(rgb(point),color)) return 'overlay '+point+': '+rgb(point);
      const uploads=c.panes[0].renderer.stats.uploads;
      state.m='wipe';
      for(const wipe of [0,.5,1]) {state.wipe=wipe;c.render();const a=rgb([10,10]),b=rgb([20,10]);if(!near(a,wipe===0?[0,16,35]:[200,100,40])||!near(b,wipe===1||wipe===.5?[0,16,35]:[200,100,40])) return 'wipe '+wipe+' '+a+' '+b;}
      state.wipe=.5;state.x=10;c.render();if(!near(rgb([20,10]),[200,100,40]))return 'wipe boundary moved with camera';state.x=25;
      state.m='blend';state.blend=0;c.render();if(!near(rgb([20,10]),[0,16,35]))return 'blend zero';
      state.blend=1;c.render();if(!near(rgb([20,10]),[200,100,40]))return 'blend one';
      // Duplicate coincident head geometry must still receive group alpha only once.
      // Head buffer contains coincident geometry; alpha belongs to the complete revision.
      state.blend=.2;c.render();if(!near(rgb([20,10]),[40,33,36]))return 'group alpha .2 '+rgb([20,10]);
      state.blend=.5;c.render();if(!near(rgb([20,10]),[100,58,38]))return 'group alpha '+rgb([20,10]);
      state.m='semantic';c.render();if(!near(rgb([10,10]),[200,100,40])||!near(rgb([20,10]),[200,100,40]))return 'semantic changes';
      if(!near(rgb([30,10]),[40,33,36]))return 'semantic context '+rgb([30,10]);
      for(let n=0;n<50;n++){state.m=['overlay','wipe','blend','semantic'][n%4];state.x=25+n/100;c.render();}
      if(c.panes[0].renderer.stats.uploads!==uploads)return 'camera/mode rebuilt scene buffers';
      for(let n=0;n<10;n++){stage.style.width=(801+n)+'px';c.render();if(c.panes[0].targets[0].width!==Math.round((801+n)*(devicePixelRatio||1)))return 'resize target';}
      c.dispose();c.dispose();if(!c.panes[0].renderer.stats.disposed)return 'not disposed';
      stage.replaceChildren();state.m='overlay';c=BoardDiff.mount({stage,scenes:{base:null,head:null},changes:[],state,appearance:()=>look});c.render();
      if(!near(rgb([40,10]),[255,255,255]))return 'empty overlay';
      state.m='wipe';c.render();if(!near(rgb([40,10]),[0,16,35]))return 'empty wipe';
      return true;
    } finally {c?.dispose();stage.remove();}
  `],
  ...['side','overlay','wipe','blend','semantic'].map(mode=>['board Thermal mode proof '+mode,'v=board&m='+mode,`
    const p=D.projects.findIndex(p=>p.name==='Thermal_Camera');
    if(p<0 || !D.projects[p].board.geometry?.base || !D.projects[p].board.geometry?.head) return 'skip';
    await applyState({p,v:'board',m:'${mode}'});
    if(!boardDiff || boardDiff.panes.length!==('${mode}'==='side'?2:1)) return 'missing compositor';
    if('${mode}'==='semantic') {
      const renderer=boardDiff.panes[0].renderer, draw=renderer.draw, calls=[];
      renderer.draw=function(options){if(!options.mask) calls.push(options);return draw.call(this,options);};
      try {boardDiff.render();} finally {renderer.draw=draw;}
      let changed=0,context=0;
      for(const scene of boardView.scenes) for(const o of scene.objects) {
        const expected=proj().changes.filter(r=>r.where?.board && r.uuid && (r.uuid===o.changeUuid || r.uuid_before===o.changeUuid));
        if(JSON.stringify(o.changeIds)!==JSON.stringify(expected.map(r=>r.id))) return 'wrong Thermal change IDs '+o.uuid;
        if(expected.length) changed++; else context++;
      }
      if(!changed || !context || calls.length!==3) return 'missing changed/context draws '+JSON.stringify({changed,context,calls:calls.length});
      for(const options of calls) {
        const contextPass=!!options.override;
        for(const scene of boardView.scenes) for(const o of scene.objects) {
          if(options.filter(o)!==(contextPass?!o.changeIds.length:!!o.changeIds.length)) return 'incorrect semantic mask '+o.uuid;
          if(contextPass && options.override(o,{opacity:1}).opacity!==.2) return 'undimmed context';
        }
      }
    }
    return boardDiff.panes.every(p=>p.renderer.stats.uploads>0 && !p.renderer.stats.disposed);
  `]),
  ["board keys units grid contrast and editing focus", "v=board", `
    Appearance.reset(); const key=(key,extra={})=>document.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...extra}));
    const before=S.z; key('F1'); if(S.z<before*1.3) return 'F1 zoom'; key('F2');
    key('h'); if(Appearance.get().contrast!=='dim') return 'H dim'; key('h'); if(Appearance.get().contrast!=='hide') return 'H hide'; key('h');
    key('PageDown'); if(Appearance.get().activeLayer!=='B.Cu') return 'bottom'; key('PageUp'); if(Appearance.get().activeLayer!=='F.Cu') return 'top';
    key('u',{ctrlKey:true}); if(Appearance.get().units!=='mil') return 'units';
    Appearance.patch({grid:{size:1.27}}); const g=Appearance.get().grid.size; key('n'); key('N',{shiftKey:true}); if(Math.abs(Appearance.get().grid.size-g)>1e-9) return 'grid inverse';
    const input=document.querySelector('#report-review-bar .goto'); input.closest('details').open=true; input.focus(); input.dispatchEvent(new KeyboardEvent('keydown',{key:'h',bubbles:true})); if(Appearance.get().contrast!=='normal') return 'editing'; input.blur();
    const z=S.z; key('+',{ctrlKey:true,shiftKey:true}); if(S.z<z*1.3) return 'ctrl shift zoom';
    const copy=new KeyboardEvent('keydown',{key:'c',ctrlKey:true,bubbles:true,cancelable:true}); document.dispatchEvent(copy); if(copy.defaultPrevented) return 'copy consumed';
    key('?'); if(!document.querySelector('#shortcuts[open]')) return 'sheet'; document.querySelector('#shortcuts').close(); Appearance.reset(); return true;`],
  ["board pointer cancellation flip status and wheel anchor", "v=board", `
    const vp=document.querySelector('#stage .vp'), r=vp.getBoundingClientRect();
    const event=(type,x,y,button=0)=>vp.dispatchEvent(new PointerEvent(type,{clientX:x,clientY:y,button,pointerId:1,bubbles:true}));
    for(const button of [0,1,2]) { setT({x:10,y:20,z:8}); event('pointerdown',r.left+40,r.top+40,button); event('pointermove',r.left+80,r.top+40,button); event('pointercancel',r.left+80,r.top+40,button); if(S.x!==5) return 'pan '+button; event('pointermove',r.left+100,r.top+40,button); if(S.x!==5) return 'cancel '+button; }
    Appearance.patch({flip:true}); await new Promise(r=>setTimeout(r,100)); const v=document.querySelector('#stage .vp'), q=v.getBoundingClientRect(), e={clientX:q.left+q.width/2+16,clientY:q.top+q.height/2};
    setT({x:10,y:20,z:8}); updateCoordinates(v,e); if(toWorld(v,e)[0]!==8 || document.querySelector('[data-coordinate=x]').textContent!=='8.000') return 'flip coordinate';
    for(const z of [.1,8,50000]) for(const deltaMode of [0,1,2]) for(const deltaY of [-100000,100000]) {
      setT({x:10,y:20,z}); const wheel=new WheelEvent('wheel',{...e,deltaY,deltaMode,cancelable:true}), before=toWorld(v,wheel); v.dispatchEvent(wheel); const after=toWorld(v,wheel);
      if(S.z<.1||S.z>50000||Math.hypot(before[0]-after[0],before[1]-after[1])>.001) return 'anchor '+JSON.stringify({z,deltaMode,deltaY,before,after,actual:S.z});
    }
    Appearance.reset(); return true;`],
  ["board status units keys and pin round trip", "v=board", `
    Appearance.reset(); await new Promise(r=>setTimeout(r,80)); let vp=document.querySelector('#stage .vp'), r=vp.getBoundingClientRect();
    setT({x:25.4,y:50.8,z:8}); const e={clientX:r.left+r.width/2,clientY:r.top+r.height/2}; updateCoordinates(vp,e);
    Appearance.patch({units:'mil'}); await new Promise(r=>setTimeout(r,80)); if(document.querySelector('[data-coordinate=x]').textContent!=='1000.000') return 'mil';
    Appearance.patch({units:'in'}); await new Promise(r=>setTimeout(r,80)); if(document.querySelector('[data-coordinate=y]').textContent!=='2.000') return 'in';
    Appearance.patch({units:'mm'}); await new Promise(r=>setTimeout(r,80)); vp=document.querySelector('#stage .vp'); const key=(key,extra={})=>document.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...extra}));
    key('{'); if(Math.abs(Appearance.get().layers['F.Cu'].opacity-.9)>1e-9) return 'opacity'; key('}');
    updateCoordinates(vp,{clientX:e.clientX+16,clientY:e.clientY}); const point=boardCursor.world.slice(), z=S.z; key('F4'); if(S.x!==point[0]||S.y!==point[1]||S.z!==z) return 'F4';
    const old=proposePin, on=THREADS_ON; let pins=[]; proposePin=(v,event)=>pins.push(toWorld(v,event)); THREADS_ON=true;
    try {
      const pointer=(type,x,button=2)=>vp.dispatchEvent(new PointerEvent(type,{clientX:x,clientY:e.clientY,button,pointerId:2,bubbles:true}));
      pointer('pointerdown',e.clientX); pointer('pointerup',e.clientX+2); vp.dispatchEvent(new MouseEvent('contextmenu',{clientX:e.clientX+2,clientY:e.clientY,cancelable:true})); [...document.querySelectorAll('.bench-context button')].find(b=>b.textContent==='Comment here')?.click(); if(pins.length!==1) return 'right pin';
      const p=pins[0], screen=BoardGL.worldToScreen(p,{...boardCamera(vp),width:r.width,height:r.height}); if(Math.abs(screen[0]-(Math.trunc(e.clientX+2)-r.left))>1e-6) return 'pin roundtrip';
      pointer('pointerdown',e.clientX); vp.dispatchEvent(new MouseEvent('contextmenu',{clientX:e.clientX,clientY:e.clientY,cancelable:true})); closeBenchMenu(); if(pins.length!==1) return 'early context pinned'; pointer('pointermove',e.clientX+40); pointer('pointerup',e.clientX+40); vp.dispatchEvent(new MouseEvent('contextmenu',{clientX:e.clientX+40,clientY:e.clientY,cancelable:true})); closeBenchMenu(); if(pins.length!==1) return 'drag pinned';
      pointer('pointerdown',e.clientX); pointer('lostpointercapture',e.clientX); const x=S.x; pointer('pointermove',e.clientX+40); if(S.x!==x) return 'lost capture';
    } finally { proposePin=old; THREADS_ON=on; }
    const tiny=document.createElement('div'); document.body.append(tiny); const before={x:S.x,y:S.y,z:S.z}; zoomBoardAt(tiny,0,0,2); tiny.remove(); if(S.z!==before.z||S.x!==before.x) return 'zero size';
    document.querySelector('#zoombar [data-act=fit]').focus(); const focus=document.activeElement; key('?'); document.querySelector('#shortcuts').close(); if(document.activeElement!==focus) return 'focus restore';
    Appearance.reset(); return true;`],
  ["board navigation Thermal evidence", "v=board", `
    Appearance.reset(); Appearance.patch({grid:{visible:true}}); await new Promise(r=>setTimeout(r,150)); fit();
    const vp=document.querySelector('#stage .vp'), r=vp.getBoundingClientRect(); deltaAnchor=[S.x,S.y]; updateCoordinates(vp,{clientX:r.left+r.width*.6,clientY:r.top+r.height*.6});
    return document.querySelector('[data-coordinate=x]').textContent!=='—' && document.querySelector('[data-grid]').textContent==='0.500';`],
  ["board shortcut sheet Thermal evidence", "v=board", `
    Appearance.reset(); Appearance.patch({grid:{visible:true},units:'mm'}); await new Promise(r=>setTimeout(r,150)); fit();
    const vp=document.querySelector('#stage .vp'), r=vp.getBoundingClientRect(); deltaAnchor=[S.x,S.y]; updateCoordinates(vp,{clientX:r.left+r.width*.6,clientY:r.top+r.height*.6}); showShortcuts(); return document.querySelector('#shortcuts').open;`],
["SCH6 physical grid negative camera units DPR and viewport coordinates", "", `
  const sheet=proj().sheets.find(s=>s.svg); S.v='sheet:'+sheet.path; S.m='side'; await draw();
  S.x=-2.54; S.y=5.08; S.z=10; S.units='mm'; S.grid=true; apply();
  for(const vp of document.querySelectorAll('#stage .vp.sheet')) {
    const r=vp.getBoundingClientRect();
    const p=schematicPoint(vp,{clientX:r.left+r.width/2+25.4,clientY:r.top+r.height/2-12.7});
    if(Math.abs(p.x)>1e-8 || Math.abs(p.y-3.81)>1e-8) return JSON.stringify(p);
    const canvas=vp.querySelector('.sch-grid');
    if(!canvas || canvas.width!==Math.round(vp.clientWidth*devicePixelRatio)
      || canvas.compareDocumentPosition(vp.querySelector('.world'))!==Node.DOCUMENT_POSITION_FOLLOWING) return 'canvas geometry/order';
  }
  const a=schematicGridPlan(100,100); if(Math.abs(a.step-12.7)>1e-8) return a;
  S.z=.001; const tiny=schematicGridPlan(1920,1080);
  if(tiny.step<4 || !Number.isFinite(tiny.x) || Math.ceil(1920/tiny.step)*Math.ceil(1080/tiny.step)>140000) return 'unbounded';
  S.z=10; const before=[S.x,S.y,S.z];
  schematicCursor={x:25.4,y:-1.27}; updateSchematicStatus();
  if(!document.querySelector('[data-sch-coordinates]').textContent.includes('25.400')) return 'mm';
  document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'u',ctrlKey:true,bubbles:true,cancelable:true}));
  return S.units==='mil' && document.querySelector('[data-sch-coordinates]').textContent.includes('1000.000')
    && document.querySelector('[data-sch-grid]').textContent.includes('50')
    && JSON.stringify(before)===JSON.stringify([S.x,S.y,S.z]);
`],
  ["SCH6 physical grid resize toggle theme and keyboard lifecycle", "", `
    S.v='sheet:'+proj().sheets.find(s=>s.svg).path; S.m='side'; await draw();
    S.x=-123.45; S.y=987.65; S.z=10; S.grid=true; S.units='mm'; apply();
    const vp=document.querySelector('#stage .vp.sheet'), canvas=vp.querySelector('.sch-grid');
    const alpha=()=>canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data.some((v,i)=>i%4===3&&v);
    if(!alpha() || canvas.closest('.stack') || canvas.getAttribute('aria-hidden')!=='true') return 'grid ink/layer';
    S.grid=false; apply(); if(alpha() || !/grid ?off/i.test(document.querySelector('[data-sch-grid]').textContent)) return 'off';
    S.grid=true; const oldDpr=Object.getOwnPropertyDescriptor(window,'devicePixelRatio');
    try {
      Object.defineProperty(window,'devicePixelRatio',{configurable:true,value:2}); apply();
      if(canvas.width!==Math.round(vp.clientWidth*2)||canvas.height!==Math.round(vp.clientHeight*2)) return 'DPR';
    } finally { if(oldDpr) Object.defineProperty(window,'devicePixelRatio',oldDpr); else delete window.devicePixelRatio; }
    const plan=schematicGridPlan(7680,4320);
    if(Math.ceil(7680/plan.step)*Math.ceil(4320/plan.step)>140000 || Math.abs(plan.step/(1.27*S.z)-Math.round(plan.step/(1.27*S.z)))>1e-8) return 'budget/lattice';
    vp.style.width='320px'; await new Promise(r=>setTimeout(r,100));
    if(canvas.width!==Math.round(vp.clientWidth*devicePixelRatio)) return 'resize';
    const matrix=new DOMMatrix(vp.querySelector('.world').style.transform);
    if(Math.abs(matrix.e-(vp.clientWidth/2-S.x*S.z))>1e-6) return 'resize camera';
    const r=vp.getBoundingClientRect(); vp.dispatchEvent(new PointerEvent('pointermove',{clientX:r.left+r.width/2,clientY:r.top+r.height/2}));
    await new Promise(requestAnimationFrame); if(document.querySelector('[data-coordinate=x]').textContent!=='-123.450') return 'pointer';
    const camera=encodeState(), units=S.units, key=target=>target.dispatchEvent(new KeyboardEvent('keydown',{key:'u',ctrlKey:true,bubbles:true,cancelable:true}));
    const input=document.createElement('input');document.body.append(input); key(input); input.remove();
    const dialog=document.querySelector('#shortcuts'); dialog.showModal(); key(dialog); dialog.close();
    if(S.units!==units) return 'editor/dialog'; key(document.body);
    if(S.units!=='mil'||encodeState()!==camera) return 'units camera/hash';
    document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'n',bubbles:true}));
    if(document.querySelector('[data-sch-grid]').textContent.toLowerCase().replace(/ +/g,' ').trim()!=='grid 50.000') return 'fixed schematic lattice';
    KRTheme.set(KRTheme.get()==='dark'?'light':'dark'); if(!alpha()) return 'theme';
    vp.dispatchEvent(new PointerEvent('pointerleave')); if(schematicCursor!==null||!document.querySelector('.status-coordinates.off-canvas')) return 'leave';   // Bench keeps the last reading greyed
    const oldCanvas=canvas; await draw(); if(oldCanvas.isConnected||schematicCursor!==null) return 'draw lifecycle';
    S.v='board'; await draw(); if(document.querySelector('.sch-grid,[data-sch-coordinates],[data-sch-grid]')) return 'schematic only';
    return true;`],
  ["SCH6 grid Thermal evidence fit", "", `
    S.v='sheet:'+proj().sheets.find(s=>s.svg).path; S.m='side'; S.units='mm'; S.grid=true; await draw(); fit();
    const vp=document.querySelector('#stage .vp'), r=vp.getBoundingClientRect(); deltaAnchor=[S.x,S.y];
    updateCoordinates(vp,{clientX:r.left+r.width*.6,clientY:r.top+r.height*.6}); return !!vp.querySelector('.sch-grid');`],
  ["SCH6 grid Thermal evidence close", "", `
    S.v='sheet:'+proj().sheets.find(s=>s.svg).path; S.m='side'; S.units='mil'; S.grid=true; await draw(); fit(); S.z=10; apply();
    const vp=document.querySelector('#stage .vp'), r=vp.getBoundingClientRect(); deltaAnchor=[S.x,S.y];
    updateCoordinates(vp,{clientX:r.left+r.width*.6,clientY:r.top+r.height*.6}); return !!vp.querySelector('.sch-grid');`],
  ["chrome docks preserve space at 1600px", "", `
  document.documentElement.style.width = "1600px"; document.body.style.width = "1600px";
  renderPanel();
  const app = document.querySelector("#app"), stage = document.querySelector("#stage");
  const tabs = [...document.querySelectorAll("#panel-tabs [data-tab]")];
  const bounds = document.querySelector("#panel-tabs")?.getBoundingClientRect();
  return app.getBoundingClientRect().width <= 1600 && stage.clientWidth >= 600 &&
    tabs.map(t => t.dataset.tab).join(",") === "changes,checks,parts,threads" &&
    tabs.every(t => { const r=t.getBoundingClientRect(); return r.left >= bounds.left && r.right <= bounds.right + 1; })
    || "dock tabs clipped or canvas squeezed";`],
  ["chrome absent Parts and Threads stay explained", "", `
  delete proj().parts; S.threads = null; S.issues = null; S.t = "changes";
  renderPanel();
  return ["parts", "threads"].every(name => {
    const b = document.querySelector('#panel [data-tab="' + name + '"]');
    return b?.disabled && !!b.title;
  }) && document.querySelector("#panel-body") !== null;`],
  ["chrome navigator escapes long project and sheet names", "", `
  proj().name = "<img src=x onerror=alert(1)>" + "Long".repeat(40);
  proj().sheets[0].name = "<script>bad</script>" + "Long".repeat(40);
  renderNav();
  const nav = document.querySelector("#nav");
  return !nav.querySelector("img,script") && nav.scrollWidth <= nav.clientWidth + 1
    && !!nav.querySelector("#proj") && !!nav.querySelector("[data-view]");`],
  ["board appearance native controls and no uploads", "v=board", `
    const p = proj(); if (!p.board?.changed) return "skip";
    const gz = async text => { const buf = await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer(); return btoa(String.fromCharCode(...new Uint8Array(buf))); };
    const evil = "<img src=x onerror=window.__pwn=1>";
    const lay = (id, name) => ({id, name, type:"signal", enabled:true});
    const scene = {version:1,units:"um",complete:true,warnings:[],bounds:[0,0,8000,5000],layers:[lay(0,"F.Cu"),lay(1,"B.Cu"),lay(2,"Edge.Cuts")],nets:[{id:0,name:""},{id:1,name:"GND"},{id:2,name:evil}],
      objects:[{kind:"track",uuid:"t",changeUuid:"t",layers:["F.Cu"],net:1,category:"tracks",side:null,hidden:false,box:[750,750,6250,1250],geometry:{segments:[[1000,1000,6000,1000,500]]}}]};
    D.blobs.apA = await gz(JSON.stringify(scene)); D.blobs.apB = await gz(JSON.stringify(scene));
    const saved = p.board.geometry, tick = ms => new Promise(r => setTimeout(r, ms));
    const fire = (el, type) => el.dispatchEvent(new Event(type, {bubbles:true}));
    try {
      localStorage.removeItem("kr.appearance.v1"); Appearance.reset();
      p.board.geometry = {base:"apA", head:"apB"}; boardView.failed = null; S.m = "side"; S.v = "board"; S.t = "appearance"; renderPanel(); await draw(); await tick(50);
      if (!boardView.renderers.length) return "no GL renderer";
      const root = document.querySelector("#appearance-root");
      if (!root || root.querySelectorAll("[role=tab]").length !== 3 || !root.querySelector("[role=tabpanel]:not([hidden]) .appearance-row")) return "no Layers tab";
      if (root.querySelector("[aria-current=true]")?.textContent !== "F.Cu") return "active layer not marked";
      const uploads = () => boardView.renderers.map(r => r.stats.uploads).join();
      const base = uploads();
      root.querySelector('[data-ap-tab="objects"]').click();
      const slider = root.querySelector('[data-object="tracks"] input[type=range]'); slider.focus(); slider.value = "25"; fire(slider, "input");
      if (boardAppearance().objects.tracks.opacity !== .25 || document.activeElement !== slider) return "tracks opacity / focus " + boardAppearance().objects.tracks.opacity;
      if (!root.querySelector('[data-object="images"]').title.includes("Not present")) return "unavailable row not explained";
      root.querySelector('[data-ap-tab="layers"]').click();
      const eye = root.querySelector('[data-layer="B.Cu"] .eye-btn'); eye.click();
      if (boardAppearance().layers["B.Cu"].visible !== false || S.layers.includes("B_Cu")) return "layer eye not synced";
      if (root.querySelector('[data-layer="B.Cu"] .eye-btn').getAttribute("aria-pressed") !== "false") return "eye state";
      root.querySelector('[data-layer="B.Cu"] .name').click();
      if (boardAppearance().activeLayer !== "B.Cu" || root.querySelector("[aria-current=true]").textContent !== "B.Cu") return "active layer";
      const radio = v => { const r = root.querySelector('input[name=ap-contrast][value=' + v + ']'); r.checked = true; fire(r, "change"); };
      radio("dim"); const dim = BoardGL.layerFactor("F.Cu", boardAppearance()), edge = BoardGL.layerFactor("Edge.Cuts", boardAppearance());
      radio("hide"); const hid = BoardGL.layerFactor("F.Cu", boardAppearance());
      if (dim !== .2 || edge !== .3 || hid !== 0) return "contrast factors " + [dim, edge, hid];
      radio("normal");
      root.querySelector('[data-ap-tab="nets"]').click();
      const filter = root.querySelector(".net-filter"); filter.value = "<img"; fire(filter, "input");
      const row = root.querySelector('[data-net]');
      if (!row || row.dataset.net !== evil || row.querySelector(".name").textContent !== evil || root.querySelector("img") || window.__pwn) return "hostile net name not literal " + JSON.stringify([!!row, row?.dataset.net, row?.querySelector(".name")?.textContent, !!root.querySelector("img"), window.__pwn, root.querySelectorAll("[data-net]").length]);
      row.querySelector(".name").click();
      if (boardAppearance().selectedNet !== evil || root.querySelector('[data-net] .name').getAttribute("aria-pressed") !== "true") return "net highlight";
      row.querySelector(".name").click(); if (boardAppearance().selectedNet !== null) return "highlight not cleared";
      const color = row.querySelector("input[type=color]"); color.value = "#2864f0"; fire(color, "input");
      root.querySelector('[data-net] .eye-btn').click();
      const net = boardAppearance().nets[evil]; if (!net || net.color[2] !== 240 || net.visible !== false) return "net colour/visibility " + JSON.stringify(net);
      if (uploads() !== base) return "geometry uploaded on appearance change " + base + " -> " + uploads();
      const env = JSON.parse(localStorage.getItem("kr.appearance.v1")), persisted = Object.values(env.viewers)[0];
      if (!persisted || persisted.objects.tracks.opacity !== .25 || persisted.contrast !== "normal" || persisted.nets[evil]?.visible !== false) return "not persisted";
      localStorage.setItem("kr.appearance.v1", "{broken"); if (KrAppearance.createStore({viewerId:"x"}).get().contrast !== "normal") return "malformed JSON";
      const get = Storage.prototype.getItem; Storage.prototype.getItem = () => { throw new Error("blocked"); };
      try { if (KrAppearance.createStore({viewerId:"x"}).get().objects.tracks.opacity !== 1) return "blocked storage"; } finally { Storage.prototype.getItem = get; }
      return true;
    } finally { p.board.geometry = saved; boardView.failed = null; boardView.note = null; S.t = "changes"; S.layers = null; localStorage.removeItem("kr.appearance.v1"); Appearance.reset(); renderPanel(); }`],
  ["Themes compositor resolved background", "v=board", `
    const stage=document.createElement('main'); stage.style.cssText='position:fixed;left:0;top:0;width:400px;height:200px;display:flex;z-index:9999'; document.body.append(stage);
    const state={m:'wipe',x:0,y:0,z:10,wipe:.5,blend:.5};
    const look=KrAppearance.resolve(KrAppearance.defaults()); look.boardBackground=[.2,.4,.6,1]; look.grid.visible=false;
    const c=BoardDiff.mount({stage,scenes:{base:null,head:null},changes:[],state,appearance:()=>look});
    try {
      c.render();
      const pixel=Array.from(c.readPixel(0,100,100));
      if(pixel.some((v,i)=>Math.abs(v-[51,102,153,255][i])>1)) return 'resolved background '+pixel;
      return true;
    } finally {c.dispose();stage.remove();}
  `],
  ["board marks geometry pixels and CSS widths", "v=board", `
    const stage=document.createElement('main');
    stage.style.cssText='position:fixed;left:0;top:0;width:800px;height:600px;display:flex;z-index:9999'; document.body.append(stage);
    const object=(id,x,y,action)=>({kind:'pad',uuid:id,changeUuid:id,ref:id,changeIds:action?[id]:[],layers:['F.Cu'],net:0,category:'pads',side:'front',hidden:false,
      box:[x-2000,y-2000,x+2000,y+2000],geometry:{primitive:{shape:'circle',center:[x,y],size:[4000,4000],angle:0},drill:{center:[x,y],size:[2000,2000],angle:0}}});
    const scene={version:1,units:'um',complete:true,warnings:[],bounds:[0,0,16000,12000],layers:[{id:0,name:'F.Cu',type:'signal',enabled:true}],nets:[{id:0,name:''}],
      objects:[object('a',4000,4000,'added'),object('u',12000,4000),object('r',12000,8000,'removed'),object('m',4000,8000,'modified')]};
    const changes=[{id:'a',action:'added'},{id:'r',action:'removed'},{id:'m',action:'modified'}];
    const state={m:'wipe',x:8,y:6,z:50,wipe:1,blend:.5};
    const look=KrAppearance.resolve(KrAppearance.defaults()); look.grid.visible=false;
    let lost=null;
    const c=BoardDiff.mount({stage,scenes:{base:scene,head:scene},changes,state,appearance:()=>look,onLost:e=>lost=e.message});
    const descriptor=Object.getOwnPropertyDescriptor(window,'devicePixelRatio');
    const near=(a,b,t=3)=>a.slice(0,3).every((v,i)=>Math.abs(v-b[i])<=t);
    try {
      const pane=c.panes[0], read=(x,y)=>Array.from(c.readPixel(0,x,y));
      const project=p=>pane.renderer.project(p);
      for (const dpr of [1,2]) for (const z of [5,50]) {
        Object.defineProperty(window,'devicePixelRatio',{configurable:true,value:dpr}); state.z=z; look.markStyle='outline'; c.render();
        if(lost) return 'mark render failed '+lost;
        const a=project([4,4]),u=project([12,4]);
        const fill=read(u[0]+1.5*z,u[1]), kept=read(a[0]+1.5*z,a[1]);
        if(!near(fill,kept)) return 'outline changed KiCad fill '+JSON.stringify({z,dpr,fill,kept});
        const color=BoardMarks.pickColor('added',look.boardBackground.slice(0,3).map(v=>v*255));
        // Exact radial section through exterior and drill boundary: dark halo then colour core.
        for (const radius of [z,2*z]) {
          const samples=[]; for(let i=-2*dpr;i<=2*dpr;i++) samples.push(read(a[0]+radius+i/dpr,a[1]));
          const core=samples.filter(p=>near(p,color)).length;
          const dark=samples.filter(p=>near(p,BoardMarks.pickHalo(color),4)).length;
          if(Math.abs(core-2*dpr)>1 || Math.abs(dark-2*dpr)>1) return 'CSS widths '+JSON.stringify({z,dpr,radius,core,dark,samples,a,width:pane.canvas.width,height:pane.canvas.height,css:[pane.vp.clientWidth,pane.vp.clientHeight]});
        }
      }
      Object.defineProperty(window,'devicePixelRatio',{configurable:true,value:1}); state.z=50;
      look.markStyle='recolour'; c.render();
      const a=project([4,4]), u=project([12,4]), r=project([12,8]);
      const expected=BoardMarks.pickColor('added',look.boardBackground.slice(0,3).map(v=>v*255));
      if(!near(read(a[0]+75,a[1]),expected)) return 'added not recoloured '+read(a[0]+75,a[1]);
      if(near(read(u[0]+75,u[1]),expected)) return 'unchanged neighbour recoloured';
      const pixels=Array.from({length:8},(_,i)=>read(r[0]+70+i,r[1]));
      const luma=p=>p[0]+p[1]+p[2];
      if(Math.max(...pixels.map(luma))-Math.min(...pixels.map(luma))<50) return 'removed hatch absent '+JSON.stringify(pixels);
      for(const action of ['added','removed','modified']) {
        const label=pane.hud.querySelector('.board-mark-label.'+action);
        if(!label || !label.textContent.includes(BoardMarks.styles[action].word) || label.dataset.dash!==BoardMarks.styles[action].dash) return 'missing visible word / glyph / dash '+action;
      }
      const uploads=c.panes.map(p=>p.renderer.stats.uploads).join();
      for(const mode of ['overlay','wipe','blend']) {state.m=mode; state.wipe=.5; c.render(); if(lost) return lost;}
      for(const bg of [[0,1,0,1],[.49,.49,.49,1]]) {
        look.boardBackground=bg; state.m='wipe'; state.wipe=1; c.render();
        const color=BoardMarks.pickColor('added',bg.slice(0,3).map(v=>v*255));
        if(!near(read(a[0]+75,a[1]),color)) return 'imported-background palette';
        if(pane.markHud.querySelector('.board-mark-key.added').style.getPropertyValue('--mark-color')!=='rgb('+color.join(',')+')') return 'legend palette differs';
      }
      delete look.colors['board.via_hole'];
      state.m='overlay'; c.render();
      if(!near(read(a[0],a[1]),[255,255,255])) return 'overlay recolour drill background '+read(a[0],a[1]);
      if(!near(read(a[0]+75,a[1]),BoardMarks.pickColor('added',[255,255,255]))) return 'overlay palette not white';
      state.s='a'; c.render();
      if(!pane.markHud.querySelector('.board-mark-label.added')) return 'selection erased action glyph';
      if(c.panes.map(p=>p.renderer.stats.uploads).join()!==uploads) return 'mark changes uploaded geometry';
      return true;
    } finally { if(descriptor) Object.defineProperty(window,'devicePixelRatio',descriptor); else delete window.devicePixelRatio; c.dispose(); stage.remove(); }
  `],
  ...['outline','recolour'].map(style=>['board marks Thermal proof '+style,'v=board&m=side',`
    const p=D.projects.findIndex(p=>p.name==='Thermal_Camera');
    if(p<0 || !D.projects[p].board.geometry?.base || !D.projects[p].board.geometry?.head) return 'skip';
    await applyState({p,v:'board',m:'side',x:158.5,y:75.4,z:65});
    Appearance.patch({markStyle:'${style}'}); boardDiff.render();
    if(boardView.note || !boardDiff || boardDiff.panes.length!==2) return 'no retained geometry';
    const expected=proj().changes.filter(c=>c.where?.board);
    for(const row of expected) {
      const sides=row.action==='modified'?['base','head']:[row.action==='removed'?'base':'head'];
      for(const side of sides) {
        const pane=boardDiff.panes.find(p=>p.sides.includes(side));
        const label=pane.markHud.querySelector('[data-id="'+row.id+'"]');
        if(!label || !label.textContent.includes(BoardMarks.styles[row.action].word)) return 'missing '+side+' '+row.action+' label';
      }
    }
    return true;
  `]),
  ["board mark style preserves appearance and focus", "v=board", `
    const button=document.querySelector('[data-mark-style="recolour"]');
    if(!button) return 'mark controls missing';
    ${MARK_STYLE_FIXTURE}
    Appearance.patch({layers:{'F.Cu':{opacity:.42}},nets:{GND:{visible:false}},objects:{zones:{opacity:.27}}});
    const pick=a=>JSON.stringify({layers:a.layers,nets:a.nets,objects:a.objects,colors:a.colors,layerOpacity:a.layerOpacity});
    const before=pick(Appearance.get()), uploads=boardView.renderers.map(r=>r.stats.uploads).join(',');
    button.focus();button.click();
    if(Appearance.get().markStyle!=='recolour'||document.activeElement!==button||pick(Appearance.get())!==before) return 'state or focus lost';
    if(boardView.renderers.map(r=>r.stats.uploads).join(',')!==uploads) return 'geometry uploaded';
    const raw=JSON.parse(localStorage.getItem('kr.appearance.v1'));
    if(!Object.values(raw.viewers).some(v=>v.markStyle==='recolour')) return 'not persisted';
    button.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}));
    if(Appearance.get().markStyle!=='outline'||document.activeElement.dataset.markStyle!=='outline') return 'keyboard Home';
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
    if(Appearance.get().markStyle!=='recolour'||document.activeElement!==button||button.getAttribute('aria-checked')!=='true') return 'keyboard Arrow';
    Appearance.import(JSON.stringify({meta:{version:5},board:{background:'#001023'}}));
    if(Appearance.get().markStyle!=='recolour') return 'theme import reset marks';
    Appearance.reset(); if(Appearance.get().markStyle!=='outline') return 'reset';
    button.click(); return true;
  `],
  ["board mark style survives reload and project changes", "v=board", `
    ${MARK_STYLE_FIXTURE}
    Appearance.patch({markStyle:'recolour',layerOpacity:{'F.Cu':.31},netColors:{GND:[.2,.3,.4,1]}});
    const first=JSON.stringify([D.repo||location.pathname,proj().dir]);
    Appearance.configure([], 'mark-style-second-project');
    Appearance.patch({colors:{'board.copper.f':[.4,.5,.6,1]},objectOpacity:{zones:.23}});
    Appearance.patch({markStyle:'recolour'});
    if(Appearance.get().objectOpacity.zones!==.23||Appearance.get().colors['board.copper.f'][0]!==.4) return 'second project lost settings';
    Appearance.configure([],first);
    return Appearance.get().layerOpacity['F.Cu']===.31 && Appearance.get().markStyle==='recolour';
  `, {afterReload:`
    const a=Appearance.get();
    if(a.markStyle!=='recolour'||a.layerOpacity['F.Cu']!==.31||a.netColors.GND?.[0]!==.2) return 'reload lost settings'+(()=>{try{const s=localStorage.getItem('kr.appearance.v1');return ' storage '+(s?s.length:'none')+' viewers '+(s?Object.keys(JSON.parse(s).viewers||{}).join('|').slice(0,300):'')+' total '+Object.keys(localStorage).reduce((n,k)=>n+(localStorage.getItem(k)||'').length,0)+' path '+location.pathname}catch(e){return ' storage error '+e.message}})();
    return document.querySelector('[data-mark-style="recolour"]').getAttribute('aria-checked')==='true';
  `}],
  ["board mark style blocked storage works from startup", "v=board", `
    ${MARK_STYLE_FIXTURE}
    if(Appearance.get().markStyle!=='outline') return 'blocked default';
    const b=document.querySelector('[data-mark-style="recolour"]'); b.focus();b.click();
    return Appearance.get().markStyle==='recolour' && document.activeElement===b;
  `, {beforeStartup:`
    Storage.prototype.getItem=Storage.prototype.setItem=function(){throw new DOMException('Blocked','SecurityError')};
  `}],
  ["board mark style corrupt JSON recovers on startup", "v=board", `
    localStorage.setItem('kr.appearance.v1','{'); return true;
  `, {afterReload:`
    if(Appearance.get().markStyle!=='outline') return 'corrupt default';
    ${MARK_STYLE_FIXTURE}
    document.querySelector('[data-mark-style="recolour"]').click();
    return Appearance.get().markStyle==='recolour';
  `}],
  ["board mark style unknown stored value preserves valid preferences", "v=board", `
    Appearance.patch({markStyle:'recolour',layerOpacity:{'F.Cu':.37},objectOpacity:{zones:.24},netColors:{GND:[.2,.3,.4,1]}});
    const raw=JSON.parse(localStorage.getItem('kr.appearance.v1'));
    for(const value of Object.values(raw.viewers)) value.markStyle='rainbow';
    localStorage.setItem('kr.appearance.v1',JSON.stringify(raw));return true;
  `, {afterReload:`
    const a=Appearance.get();
    if(a.markStyle!=='outline'||a.layerOpacity['F.Cu']!==.37||a.objectOpacity.zones!==.24||a.netColors.GND?.[0]!==.2) return 'invalid mark style discarded preferences '+JSON.stringify({m:a.markStyle,l:a.layerOpacity?.['F.Cu'],z:a.objectOpacity?.zones,n:a.netColors?.GND})+(()=>{try{const s=localStorage.getItem('kr.appearance.v1');return ' storage '+(s?s.length:'none')+' viewers '+(s?Object.keys(JSON.parse(s).viewers||{}).join('|').slice(0,300):'')+' total '+Object.keys(localStorage).reduce((n,k)=>n+(localStorage.getItem(k)||'').length,0)+' path '+location.pathname}catch(e){return ' storage error '+e.message}})();
    ${MARK_STYLE_FIXTURE}
    document.querySelector('[data-mark-style="recolour"]').click();
    return Appearance.get().markStyle==='recolour';
  `}],
  ...['outline','recolour'].map(style=>['board mark style toolbar proof '+style,'v=board&m=side',`
    const p=D.projects.findIndex(p=>p.name==='Thermal_Camera');
    if(p>=0 && D.projects[p].board.geometry?.base && D.projects[p].board.geometry?.head) {
      await applyState({p,v:'board',m:'side',x:158.5,y:75.4,z:65});
    } else { ${MARK_STYLE_FIXTURE} }
    Appearance.patch({markStyle:'${style}'});
    return document.querySelector('[data-mark-style="${style}"]').getAttribute('aria-checked')==='true';
  `]),

  ["board fps two revisions pan zoom", "v=board&m=side", `
    if (!globalThis.__CHECK_PERF) return "skip";
    disposeBoardRenderers();
    const start = performance.now(); S.v="board"; S.m="side"; await draw(); fit();
    const firstDrawCpuMs = performance.now()-start;
    if (!boardView.useGL || boardView.renderers.length!==2) return "requires two WebGL revision renderers";
    boardView.renderers.forEach(r=>r.gl.finish());
    const firstDrawMs = performance.now()-start;
    const [base,head]=boardView.scenes||[];
    if (!base?.complete || !head?.complete) return "missing or unsupported revision scene";
    const kinds=s=>Object.fromEntries(["track","via","pad"].map(k=>[k,s.objects.filter(o=>o.kind===k).length]));
    if ([base,head].some(s=>Object.values(kinds(s)).some(n=>n===0))) return "requires two populated track/via/pad scenes";
    const original={x:S.x,y:S.y,z:S.z}, runs=[];
    try {
      for (let run=0;run<3;run++) {
        const renderers=[...boardView.renderers], before=renderers.map(r=>({...r.stats}));
        const intervals=[], cpu=[]; let previous=0, frames=0;
        await new Promise(resolve=>{
          const start=performance.now();
          const tick=now=>{
            const elapsed=now-start, t=performance.now();
            setT({x:original.x+Math.sin(elapsed/160)*2,y:original.y+Math.cos(elapsed/180)*2,z:original.z*(1+.12*Math.sin(elapsed/230))});
            if(elapsed>1000) { cpu.push(performance.now()-t); if(previous) intervals.push(now-previous); previous=now; frames++; }
            if(elapsed<6000) requestAnimationFrame(tick); else resolve();
          }; requestAnimationFrame(tick);
        });
        const fps=intervals.length/(intervals.reduce((a,b)=>a+b,0)/1000);
        const sorted=[...intervals].sort((a,b)=>a-b);
        const uploads=renderers.map((r,i)=>r.stats.uploads-before[i].uploads);
        const textureUploads=renderers.map((r,i)=>r.stats.textureUploads-before[i].textureUploads);
        const draws=renderers.map((r,i)=>r.stats.draws-before[i].draws);
        runs.push({fps,frames,p95:sorted[Math.floor(sorted.length*.95)],drawCpuMs:cpu.reduce((a,b)=>a+b,0)/cpu.length,uploads,textureUploads,draws});
      }
      const diagnostic=performance.now(); setT(original); boardView.renderers.forEach(r=>r.gl.finish());
      const finishBoundedMs=performance.now()-diagnostic;
      const glErrors=boardView.renderers.map(r=>r.gl.getError());
      const fps=runs.map(r=>r.fps).sort((a,b)=>a-b);
      const evidence={runs,median:fps[1],min:fps[0],firstDrawMs,firstDrawCpuMs,pageReadyMs:start,finishBoundedMs,base:kinds(base),head:kinds(head),viewport:[innerWidth,innerHeight],dpr:devicePixelRatio,chrome:navigator.userAgent,glErrors};
      console.log("BOARD_FPS "+JSON.stringify(evidence));
      return runs.every(r=>r.fps>=50 && r.uploads.every(n=>n===0) && r.textureUploads.every(n=>n===0) && r.draws.every(n=>n>r.frames)) && glErrors.every(n=>n===0) || JSON.stringify(evidence);
    } finally { setT(original); }
  `],
  ...["Layers Normal","Objects","Nets","Dim","Hide","Flip","active B.Cu"].map(state=>[
    "board proof "+state, "v=board&m=side&t=appearance", `
      if (!proj().board.geometry) return window.__CHECK_PERF ? "requires generated geometry" : "skip";
      S.v="board"; S.m="side"; S.t="appearance"; S.layers=null; await draw();
      Appearance.reset(); Appearance.patch({grid:{visible:true}}); fit(); renderPanel();
      if(!boardView.useGL || boardView.renderers.length!==2) return "requires two live WebGL scenes";
      if(boardAppearance().grid.size!==.5) return "KiCad PCB default grid must be 0.5 mm (app_settings.cpp default index 15)";
      const state=${JSON.stringify(state)}, root=document.querySelector('#appearance-root');
      if(!root) return "Appearance missing";
      const tab=state==="Objects"?"objects":state==="Nets"?"nets":"layers";
      root.querySelector('[data-ap-tab="'+tab+'"]').click();
      if(state==="Dim" || state==="Hide") { const radio=root.querySelector('[name=ap-contrast][value='+state.toLowerCase()+']'); radio.checked=true; radio.dispatchEvent(new Event('change')); }
      if(state==="Flip") root.querySelector('.appearance-options input[type=checkbox]').click();
      if(state==="active B.Cu") {
        const scene=boardView.scenes[0];
        if(!scene.layers.some(l=>l.name==='B.Cu')) return "B.Cu absent";
        // Actual front/back track intersections, not an active-row-only proof.
        const segments=layer=>scene.objects.filter(o=>o.kind==='track' && o.layers.includes(layer)).flatMap(o=>o.geometry.segments);
        const cross=(a,b)=>a[0]*b[1]-a[1]*b[0], points=[];
        for(const a of segments('F.Cu')) for(const b of segments('B.Cu')) {
          const u=[a[2]-a[0],a[3]-a[1]],v=[b[2]-b[0],b[3]-b[1]],w=[b[0]-a[0],b[1]-a[1]],d=cross(u,v);
          if(!d) continue; const t=cross(w,v)/d,q=cross(w,u)/d;
          if(t>.05 && t<.95 && q>.05 && q<.95) points.push([a[0]+t*u[0],a[1]+t*u[1]]);
        }
        if(!points.length) return "no real crossing tracks in fixture";
        const sample=()=>points.map(p=>{const vp=boardView.panes[0].vp,xy=BoardGL.worldToScreen(p.map(n=>n/1000),boardCamera(vp));return Array.from(boardDiff.readPixel(0,...xy));});
        const before=sample(); root.querySelector('[data-layer="B.Cu"] .name').click();
        const after=sample();
        if(!after.some((p,i)=>p.some((v,j)=>j<3 && Math.abs(v-before[i][j])>5))) return "active B.Cu did not change real crossing-track pixels";
        console.log('BOARD_PROOF '+JSON.stringify({crossings:points.length,changed:after.filter((p,i)=>p.some((v,j)=>j<3&&Math.abs(v-before[i][j])>5)).length}));
      }
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      const a=boardAppearance(), active=state==='active B.Cu'?'B.Cu':'F.Cu';
      return root.querySelector('[data-ap-tab="'+tab+'"]').getAttribute('aria-selected')==='true'
        && root.querySelector('[aria-current=true]')?.textContent===active
        && a.contrast===(state==='Dim'?'dim':state==='Hide'?'hide':'normal')
        && a.flip===(state==='Flip')
        && root.querySelector('.appearance-options input[type=checkbox]').checked===a.flip
        && (tab!=='objects' || root.querySelector('[data-object=zones] input[type=range]').value==='60')
        && (tab!=='nets' || root.querySelectorAll('[data-net]').length>0)
        && root.querySelector('[name=ap-contrast]:checked').value===a.contrast
        && boardView.renderers.every(r=>r.stats.draws>0 && !r.stats.disposed)
        && [...document.querySelectorAll('#stage canvas')].length===2;
    `
  ]),
  ["board side camera retains textures and buffers", "v=board&m=side", `
    const P=proj(), saved=P.board.geometry;
    const scene={version:1,units:'um',complete:true,warnings:[],bounds:[0,0,1000,1000],layers:[{id:0,name:'F.Cu',type:'signal',enabled:true}],nets:[{id:0,name:''}],objects:[]};
    const key='__retained_side_proof__';cache[key]=JSON.stringify(scene);P.board.geometry={base:key,head:key};
    try {
      S.v='board';S.m='side';await draw();fit();
      if(boardView.renderers.length!==2) return 'two retained renderers required';
      const before=boardView.renderers.map(r=>({renderer:r,textures:r.stats.textureUploads,buffers:r.stats.uploads}));
      for(let n=0;n<5;n++) setT({x:S.x+.1});
      return boardView.renderers.every((r,i)=>r===before[i].renderer && r.stats.textureUploads===before[i].textures && r.stats.uploads===before[i].buffers) || 'camera replaced renderer or reuploaded textures or buffers';
    } finally {P.board.geometry=saved;delete cache[key];}
  `],
  ["board comparison cameras retain revision net textures", "v=board&m=side", `
    const P=proj(), saved=P.board.geometry, keys=['__camera_base__','__camera_head__'];
    if(!saved) {
      for(const [i,key] of keys.entries()) cache[key]=JSON.stringify({version:1,units:'um',complete:true,warnings:[],bounds:[0,0,4000,4000],
        layers:[{id:0,name:'F.Cu',type:'signal',enabled:true}],nets:[{id:0,name:''},{id:1,name:i?'VCC':'GND'}],
        objects:[{kind:'track',uuid:key,changeUuid:key,ref:'',layers:['F.Cu'],net:1,category:'tracks',side:null,hidden:false,
          box:[0,0,4000,1000],geometry:{segments:[[500,500,3500,500,500]]}}]});
      P.board.geometry={base:keys[0],head:keys[1]};
    }
    try { for(const mode of ['side','overlay','wipe','blend','semantic']) {
      S.v='board';S.m=mode;await draw();fit();
      Appearance.patch({netColors:{GND:[.2,.4,.6,1]}});boardDiff.render();
      const before=boardDiff.panes.map(p=>({renderer:p.renderer,targets:[...p.targets],textures:p.renderer.stats.textureUploads,buffers:p.renderer.stats.uploads}));
      for(let n=0;n<5;n++) setT({x:S.x+.1,y:S.y-.1,z:S.z*1.01});
      if(!boardDiff.panes.every((p,i)=>p.renderer===before[i].renderer
        &&p.targets.every((t,j)=>t===before[i].targets[j])
        &&p.renderer.stats.textureUploads===before[i].textures&&p.renderer.stats.uploads===before[i].buffers)) return mode+' camera uploaded or replaced resources';
      Appearance.patch({netColors:{GND:[.6,.4,.2,1]}});boardDiff.render();
      if(!boardDiff.panes.every((p,i)=>p.renderer.stats.textureUploads>before[i].textures)) return mode+' net appearance did not invalidate textures';
    }
    return true;
    } finally {P.board.geometry=saved;for(const key of keys) delete cache[key];}
  `],
  ["board offline generated controls selection links and fallback", "v=board&m=side&t=appearance", `
    if(!proj().board.geometry) return 'skip';
    S.v='board';S.m='side';S.t='appearance';await draw();Appearance.reset();fit();renderPanel();
    if(!boardView.useGL || boardView.renderers.length!==2) return 'two revision canvases missing offline';
    const root=document.querySelector('#appearance-root');root.querySelector('[data-ap-tab=objects]').click();
    const range=root.querySelector('[data-object=tracks] input[type=range]');range.value='75';range.dispatchEvent(new Event('input'));
    if(boardAppearance().objects.tracks.opacity!==.75) return 'offline controls failed';
    const row=proj().changes.find(c=>c.where?.board && viewOf(c));
    if(!row) return 'requires an actual board change for selection-link proof';
    await goTo(row.id);
    if(S.s!==row.id || decodeState(encodeState()).s!==row.id) return 'selection link lost';
    const create=BoardGL.create;
    try {
      disposeBoardRenderers();BoardGL.create=()=>null;boardView.failed=null;await draw();
      if(boardView.useGL || !document.querySelector('#stage .world svg') || !boardView.note) return 'authoritative SVG fallback missing offline';
      console.log('BOARD_PROOF '+JSON.stringify({offline:true,selection:row.id,fallback:true}));
      return true;
    } finally {BoardGL.create=create;boardView.failed=null;}
  `],
  ["Themes marks classic board","v=board",`
    const p=D.projects.findIndex(p=>p.board.geometry?.base && p.board.geometry?.head);
    if(p<0) return 'skip';   // needs a fixture with both geometry revisions (run with --page)
    S.p=p; S.v='board'; S.x=S.y=S.z=null; await draw();
    Appearance.import(JSON.stringify({"meta": {"version": 5, "name": "Classic reference subset"}, "board": {"background": "rgb(0, 0, 0)", "copper": {"f": "rgb(132, 0, 0)", "b": "rgb(0, 132, 0)", "in1": "rgb(132, 132, 0)"}}, "schematic": {"background": "rgb(255, 255, 255)", "wire": "rgb(0, 132, 0)", "component_outline": "rgb(132, 0, 0)", "component_body": "rgb(255, 255, 194)"}}));
    const sheet=proj().sheets.find(s=>s.svg); if(!sheet) return 'no schematic';
    S.v="board"==='board'?'board':'sheet:'+sheet.path;
    const changed=proj().changes.find(r=>onView(r,S.v)); S.s=changed?.id||null;
    for(const style of ['outline','recolour']) for(const mode of ['side','overlay','wipe','blend','semantic']) {
      S.m=mode; S.blend=.15; S.wipe=.5; Appearance.patch({markStyle:style}); await draw();
      const palette=KrAppearance.resolve(Appearance.get()).marks["board"];
      for(const [action,mark] of Object.entries(palette)) {
        const legend=document.querySelector('#stage '+("board"==='board'?'.board-mark-key':'.diff-mark-legend > span')+'[data-action="'+action+'"]');
        if(!legend||!legend.textContent.includes(mark.word)||legend.dataset.glyph!==mark.glyph||legend.dataset.dash!==BoardMarks.styles[action].dash) return mode+':missing semantics '+action;
      }
      if("board"==='board') {
        if(!boardDiff) return 'board compositor missing';
        for(const label of document.querySelectorAll('.board-mark-label')) {
          if(getComputedStyle(label.closest('.board-mark-group')).opacity!=='1') return 'blended mark';
          if(!label.getAttribute('aria-label')?.includes(BoardMarks.styles[label.dataset.action].word)) return 'missing accessible word';
        }
      } else {
        const markers=[...document.querySelectorAll('.marker:not(.sel)')];
        if(!markers.length) return 'no schematic markers';
        for(const m of markers) {
          const action=m.dataset.action, mark=palette[action]; if(!mark) continue;
          const css=getComputedStyle(m), rgb=css.borderColor.match(/[0-9.]+/g).slice(0,3).map(Number);
          if(!rgb.every((v,i)=>Math.abs(v-mark.color[i]*255)<1)) return 'schematic palette mismatch '+action;
          if(m.dataset.glyph!==mark.glyph||m.dataset.dash!==BoardMarks.styles[action].dash||!m.getAttribute('aria-label').includes(mark.word)) return 'schematic semantics '+action;
        }
      }
    }
    S.m='side'; Appearance.patch({markStyle:'outline'});
    if(changed) {
      const b=rowBox(changed,'head');
      if(b) { S.x=(b[0]+b[2])/2; S.y=(b[1]+b[3])/2; S.z=S.v==='board'?65:18; }
    }
    await draw();
    const visible=[...document.querySelectorAll('#stage .marker:not(.sel),#stage .board-mark-label')].some(m=>{
      const r=m.getBoundingClientRect(),vp=m.closest('.vp').getBoundingClientRect();
      return r.left<vp.right&&r.right>vp.left&&r.top<vp.bottom&&r.bottom>vp.top;
    });
    return visible || 'no visible mark in screenshot';
`],
  ["Themes marks classic schematic","v=board",`
    const p=D.projects.findIndex(p=>p.sheets.some(s=>s.svg));
    if(p<0) return 'fixture needs a rendered schematic';
    S.p=p; S.v='board'; S.x=S.y=S.z=null; await draw();
    Appearance.import(JSON.stringify({"meta": {"version": 5, "name": "Classic reference subset"}, "board": {"background": "rgb(0, 0, 0)", "copper": {"f": "rgb(132, 0, 0)", "b": "rgb(0, 132, 0)", "in1": "rgb(132, 132, 0)"}}, "schematic": {"background": "rgb(255, 255, 255)", "wire": "rgb(0, 132, 0)", "component_outline": "rgb(132, 0, 0)", "component_body": "rgb(255, 255, 194)"}}));
    const sheet=proj().sheets.find(s=>s.svg); if(!sheet) return 'no schematic';
    S.v="schematic"==='board'?'board':'sheet:'+sheet.path;
    const changed=proj().changes.find(r=>onView(r,S.v)); S.s=changed?.id||null;
    for(const style of ['outline','recolour']) for(const mode of ['side','overlay','wipe','blend','semantic']) {
      S.m=mode; S.blend=.15; S.wipe=.5; Appearance.patch({markStyle:style}); await draw();
      const palette=KrAppearance.resolve(Appearance.get()).marks["schematic"];
      for(const [action,mark] of Object.entries(palette)) {
        const legend=document.querySelector('#stage '+("schematic"==='board'?'.board-mark-key':'.diff-mark-legend > span')+'[data-action="'+action+'"]');
        if(!legend||!legend.textContent.includes(mark.word)||legend.dataset.glyph!==mark.glyph||legend.dataset.dash!==BoardMarks.styles[action].dash) return mode+':missing semantics '+action;
      }
      if("schematic"==='board') {
        if(!boardDiff) return 'board compositor missing';
        for(const label of document.querySelectorAll('.board-mark-label')) {
          if(getComputedStyle(label.closest('.board-mark-group')).opacity!=='1') return 'blended mark';
          if(!label.getAttribute('aria-label')?.includes(BoardMarks.styles[label.dataset.action].word)) return 'missing accessible word';
        }
      } else {
        const markers=[...document.querySelectorAll('.vp.sheet .marker')];
        if(!markers.length) return 'no schematic markers';
        for(const m of markers) {
          const action=m.dataset.action, mark=palette[action]; if(!mark) continue;
          const css=getComputedStyle(m), rgb=css.borderColor.match(/[0-9.]+/g).slice(0,3).map(Number);
          if(!rgb.every((v,i)=>Math.abs(v-mark.color[i]*255)<1)) return 'schematic palette mismatch '+action;
          if(m.dataset.glyph!==mark.glyph||m.dataset.dash!==BoardMarks.styles[action].dash||!m.getAttribute('aria-label').includes(mark.word)) return 'schematic semantics '+action;
        }
      }
    }
    S.m='side'; Appearance.patch({markStyle:'outline'});
    if(changed) {
      const b=rowBox(changed,'head');
      if(b) { S.x=(b[0]+b[2])/2; S.y=(b[1]+b[3])/2; S.z=S.v==='board'?65:18; }
    }
    await draw();
    const visible=[...document.querySelectorAll('#stage .vp.sheet .marker,#stage .board-mark-label')].some(m=>{
      const r=m.getBoundingClientRect(),vp=m.closest('.vp').getBoundingClientRect();
      return r.left<vp.right&&r.right>vp.left&&r.top<vp.bottom&&r.bottom>vp.top;
    });
    return visible || 'no visible mark in screenshot';
`],
  ["Themes marks extreme-light board","v=board",`
    const p=D.projects.findIndex(p=>p.board.geometry?.base && p.board.geometry?.head);
    if(p<0) return 'skip';   // needs a fixture with both geometry revisions (run with --page)
    S.p=p; S.v='board'; S.x=S.y=S.z=null; await draw();
    Appearance.import(JSON.stringify({"meta": {"version": 5, "name": "Extreme light contrast stress"}, "board": {"background": "rgba(255, 255, 255, 0.98)", "copper": {"f": "#ffffff", "b": "#fffffe", "in30": "rgba(255, 255, 255, 0)"}, "grid": "#ffffff", "f_silks": "#ffffff"}, "schematic": {"background": "#ffffff", "wire": "#ffffff", "component_outline": "#ffffff", "component_body": "#ffffff", "worksheet": "#ffffff"}}));
    const sheet=proj().sheets.find(s=>s.svg); if(!sheet) return 'no schematic';
    S.v="board"==='board'?'board':'sheet:'+sheet.path;
    const changed=proj().changes.find(r=>onView(r,S.v)); S.s=changed?.id||null;
    for(const style of ['outline','recolour']) for(const mode of ['side','overlay','wipe','blend','semantic']) {
      S.m=mode; S.blend=.15; S.wipe=.5; Appearance.patch({markStyle:style}); await draw();
      const palette=KrAppearance.resolve(Appearance.get()).marks["board"];
      for(const [action,mark] of Object.entries(palette)) {
        const legend=document.querySelector('#stage '+("board"==='board'?'.board-mark-key':'.diff-mark-legend > span')+'[data-action="'+action+'"]');
        if(!legend||!legend.textContent.includes(mark.word)||legend.dataset.glyph!==mark.glyph||legend.dataset.dash!==BoardMarks.styles[action].dash) return mode+':missing semantics '+action;
      }
      if("board"==='board') {
        if(!boardDiff) return 'board compositor missing';
        for(const label of document.querySelectorAll('.board-mark-label')) {
          if(getComputedStyle(label.closest('.board-mark-group')).opacity!=='1') return 'blended mark';
          if(!label.getAttribute('aria-label')?.includes(BoardMarks.styles[label.dataset.action].word)) return 'missing accessible word';
        }
      } else {
        const markers=[...document.querySelectorAll('.marker:not(.sel)')];
        if(!markers.length) return 'no schematic markers';
        for(const m of markers) {
          const action=m.dataset.action, mark=palette[action]; if(!mark) continue;
          const css=getComputedStyle(m), rgb=css.borderColor.match(/[0-9.]+/g).slice(0,3).map(Number);
          if(!rgb.every((v,i)=>Math.abs(v-mark.color[i]*255)<1)) return 'schematic palette mismatch '+action;
          if(m.dataset.glyph!==mark.glyph||m.dataset.dash!==BoardMarks.styles[action].dash||!m.getAttribute('aria-label').includes(mark.word)) return 'schematic semantics '+action;
        }
      }
    }
    S.m='side'; Appearance.patch({markStyle:'outline'});
    if(changed) {
      const b=rowBox(changed,'head');
      if(b) { S.x=(b[0]+b[2])/2; S.y=(b[1]+b[3])/2; S.z=S.v==='board'?65:18; }
    }
    await draw();
    const visible=[...document.querySelectorAll('#stage .marker:not(.sel),#stage .board-mark-label')].some(m=>{
      const r=m.getBoundingClientRect(),vp=m.closest('.vp').getBoundingClientRect();
      return r.left<vp.right&&r.right>vp.left&&r.top<vp.bottom&&r.bottom>vp.top;
    });
    return visible || 'no visible mark in screenshot';
`],
  ["Themes marks extreme-light schematic","v=board",`
    const p=D.projects.findIndex(p=>p.sheets.some(s=>s.svg));
    if(p<0) return 'fixture needs a rendered schematic';
    S.p=p; S.v='board'; S.x=S.y=S.z=null; await draw();
    Appearance.import(JSON.stringify({"meta": {"version": 5, "name": "Extreme light contrast stress"}, "board": {"background": "rgba(255, 255, 255, 0.98)", "copper": {"f": "#ffffff", "b": "#fffffe", "in30": "rgba(255, 255, 255, 0)"}, "grid": "#ffffff", "f_silks": "#ffffff"}, "schematic": {"background": "#ffffff", "wire": "#ffffff", "component_outline": "#ffffff", "component_body": "#ffffff", "worksheet": "#ffffff"}}));
    const sheet=proj().sheets.find(s=>s.svg); if(!sheet) return 'no schematic';
    S.v="schematic"==='board'?'board':'sheet:'+sheet.path;
    const changed=proj().changes.find(r=>onView(r,S.v)); S.s=changed?.id||null;
    for(const style of ['outline','recolour']) for(const mode of ['side','overlay','wipe','blend','semantic']) {
      S.m=mode; S.blend=.15; S.wipe=.5; Appearance.patch({markStyle:style}); await draw();
      const palette=KrAppearance.resolve(Appearance.get()).marks["schematic"];
      for(const [action,mark] of Object.entries(palette)) {
        const legend=document.querySelector('#stage '+("schematic"==='board'?'.board-mark-key':'.diff-mark-legend > span')+'[data-action="'+action+'"]');
        if(!legend||!legend.textContent.includes(mark.word)||legend.dataset.glyph!==mark.glyph||legend.dataset.dash!==BoardMarks.styles[action].dash) return mode+':missing semantics '+action;
      }
      if("schematic"==='board') {
        if(!boardDiff) return 'board compositor missing';
        for(const label of document.querySelectorAll('.board-mark-label')) {
          if(getComputedStyle(label.closest('.board-mark-group')).opacity!=='1') return 'blended mark';
          if(!label.getAttribute('aria-label')?.includes(BoardMarks.styles[label.dataset.action].word)) return 'missing accessible word';
        }
      } else {
        const markers=[...document.querySelectorAll('.vp.sheet .marker')];
        if(!markers.length) return 'no schematic markers';
        for(const m of markers) {
          const action=m.dataset.action, mark=palette[action]; if(!mark) continue;
          const css=getComputedStyle(m), rgb=css.borderColor.match(/[0-9.]+/g).slice(0,3).map(Number);
          if(!rgb.every((v,i)=>Math.abs(v-mark.color[i]*255)<1)) return 'schematic palette mismatch '+action;
          if(m.dataset.glyph!==mark.glyph||m.dataset.dash!==BoardMarks.styles[action].dash||!m.getAttribute('aria-label').includes(mark.word)) return 'schematic semantics '+action;
        }
      }
    }
    S.m='side'; Appearance.patch({markStyle:'outline'});
    if(changed) {
      const b=rowBox(changed,'head');
      if(b) { S.x=(b[0]+b[2])/2; S.y=(b[1]+b[3])/2; S.z=S.v==='board'?65:18; }
    }
    await draw();
    const visible=[...document.querySelectorAll('#stage .vp.sheet .marker,#stage .board-mark-label')].some(m=>{
      const r=m.getBoundingClientRect(),vp=m.closest('.vp').getBoundingClientRect();
      return r.left<vp.right&&r.right>vp.left&&r.top<vp.bottom&&r.bottom>vp.top;
    });
    return visible || 'no visible mark in screenshot';
`],
  ["Themes invalid file applies nothing and same file can retry", "v=board&t=appearance", `
  const store=appearanceStore(), original=store.get(), raw=localStorage.getItem('kr.appearance.v1');
  const input=document.querySelector('[data-appearance-file]');
  if(!input) return 'file input missing';
  const error=document.querySelector('[data-appearance-error]');
  async function choose(text,name='theme.json') {
    const transfer=new DataTransfer();
    transfer.items.add(new File([text],name,{type:'application/json'}));
    input.files=transfer.files; input.dispatchEvent(new Event('change',{bubbles:true}));
    await new Promise(r=>setTimeout(r,100));
  }
  try {
    await choose(JSON.stringify({meta:{version:5},board:{background:'#fff',copper:{f:'bad'}}}));
    if(JSON.stringify(store.get())!==JSON.stringify(original)) return 'partly applied';
    if(localStorage.getItem('kr.appearance.v1')!==raw) return 'wrote invalid theme';
    if(error.hidden||!error.textContent.includes('board.copper.f')) return 'missing inline error';
    await choose(JSON.stringify({meta:{version:5},board:{background:'#fff'}}));
    if(!error.textContent.startsWith('Imported')||store.get().colors['board.background'][0]!==1) return 'retry failed';
    document.querySelector('[data-appearance-reset]').click();
    return JSON.stringify(store.get())===JSON.stringify(KrAppearance.defaults()) || 'reset differs';
  } finally {store.set(original);}
`],
  ["Themes import shows theme name", "v=board&t=appearance", `
  const store=appearanceStore(), original=store.get(), raw=localStorage.getItem('kr.appearance.v1');
  const input=document.querySelector('[data-appearance-file]');
  if(!input) return 'file input missing';
  const error=document.querySelector('[data-appearance-error]');
  async function choose(text,name='theme.json') {
    const transfer=new DataTransfer();
    transfer.items.add(new File([text],name,{type:'application/json'}));
    input.files=transfer.files; input.dispatchEvent(new Event('change',{bubbles:true}));
    await new Promise(r=>setTimeout(r,100));
  }
  try {
    await choose(JSON.stringify({meta:{version:5,name:'Classic <b>x</b>'},board:{background:'#000'}}));
    if(error.hidden||error.textContent!=='Imported theme: Classic <b>x</b>'||error.querySelector('b')) return 'bad success text: '+error.textContent;
    return true;
  } finally {store.set(original);}
`],
  ["Themes late reads cannot overwrite reset, newer file or project switch", "v=board&t=appearance", `
  const store=appearanceStore(), before=store.get(), orig=File.prototype.text, pending=[];
  File.prototype.text=function(){return new Promise(resolve=>pending.push(resolve))};
  const input=()=>document.querySelector('[data-appearance-file]');
  const tick=()=>new Promise(r=>setTimeout(r,0));
  const choose=()=>{
    const data=new DataTransfer(); data.items.add(new File(['x'],'same.json'));
    input().files=data.files; input().dispatchEvent(new Event('change',{bubbles:true}));
  };
  const payload=color=>JSON.stringify({meta:{version:5},board:{background:color}});
  try {
    choose(); choose();
    pending[1](payload('#ffffff')); await tick();
    pending[0](payload('#000000')); await tick();
    if(store.get().colors['board.background'][0]!==1) return 'older file won';
    choose(); document.querySelector('[data-appearance-reset]').click();
    pending[2](payload('#ffffff')); await tick();
    if(JSON.stringify(store.get())!==JSON.stringify(KrAppearance.defaults())) return 'late read defeated reset';
    choose(); renderPanel();
    pending[3](payload('#ffffff')); await tick();
    return JSON.stringify(store.get())===JSON.stringify(KrAppearance.defaults()) || 'late read survived panel teardown';
  } finally {File.prototype.text=orig;store.set(before)}
`],
  ["status click origin gives dx dy dist, pan keeps it, view change drops it", "v=board", `
    await draw(); setT({x:100,y:200,z:10});
    const vp=()=>document.querySelector('#stage .vp'), at=(t,dx,dy,b=0)=>{const r=vp().getBoundingClientRect(); vp().dispatchEvent(new PointerEvent(t,{bubbles:true,pointerId:1,button:b,clientX:r.left+r.width/2+dx,clientY:r.top+r.height/2+dy}));};
    const raf=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    at('pointerdown',0,0); at('pointerup',0,0); at('pointermove',30,40); await raf();
    const t=n=>document.querySelector('[data-coordinate='+n+']').textContent;
    if(t('dx')!=='3.000'||t('dy')!=='4.000'||t('dist')!=='5.000') return 'click '+t('dx')+t('dy')+t('dist');
    at('pointerdown',50,50); at('pointermove',90,90); at('pointerup',90,90); at('pointermove',90,90); await raf();
    if(t('dx')==='0.000') return 'pan dropped origin';
    S.v='sheet:/not-in-report'; await draw(); await raf();
    return t('x')==='off canvas' && t('dx')==='0.000' && !/NaN|Infinity/.test(document.querySelector('#statusbar').textContent);`],
  ["status change counter matches visible change rows", "", `
    const row=proj().changes.find(r=>viewOf(r)&&currentView(viewOf(r))); if(!row) return 'skip';
    await goTo(row.id); await new Promise(r=>requestAnimationFrame(r));
    const rows=[...document.querySelectorAll('#panel .card[data-id]')], i=rows.findIndex(e=>e.dataset.id===S.s);
    return document.querySelector('[data-change]').textContent===(i+1)+'/'+rows.length;`],
  ["shortcut sheet button and question mark open, Escape closes keeping selection and focus", "", `
    const before=S.s, opener=document.querySelector('#shortcuts-open'); opener.focus();
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'?',bubbles:true}));
    const d=document.querySelector('#shortcuts'); if(!d.open||!d.contains(document.activeElement)) return 'not open/focused';
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
    if(d.open||S.s!==before) return 'escape';
    const editor=document.createElement('div'); editor.contentEditable='true'; document.body.append(editor); editor.focus();
    editor.dispatchEvent(new KeyboardEvent('keydown',{key:'?',bubbles:true})); const ignored=!d.open; editor.remove();
    opener.click(); const ok=d.open; d.close();
    const txt=d.textContent; return ignored && ok && ['Ctrl+U','N / Shift+N','j / k','PageUp','F1','Esc','?'].every(k=>txt.includes(k));`],
  ["board geometry pick links row and pins exact annulus", "v=board&m=overlay", `
    boardDiff?.dispose(); document.querySelector('#stage').replaceChildren();
    const object=(uuid,ids)=>({uuid,changeUuid:uuid,kind:'pad',ref:uuid,changeIds:ids,box:[8000,8000,12000,12000],
      geometry:{primitive:{shape:'circle',center:[10000,10000],size:[4000,4000],angle:0},drill:{center:[10000,10000],size:[2000,2000],angle:0}},
      layers:['F.Cu'],net:0,category:'pads',side:'front',hidden:false});
    const scene=objects=>({version:1,units:'um',complete:true,warnings:[],bounds:[6000,6000,14000,14000],layers:[{id:0,name:'F.Cu',type:'signal',enabled:true}],nets:[{id:0,name:''}],objects});
    const scenes={base:scene([object('removed',['p5-base'])]),head:scene([object('head',['p5-head']),object('unchanged',[])])};
    proj().changes.push(...['base','head'].map(side=>({id:'p5-'+side,kind:'pad',ref:side,action:side==='base'?'removed':'added',where:{board:true}})));
    Object.assign(S,{x:10,y:10,z:45,s:null,m:'overlay'}); renderPanel();
    let look=glAppearance(); boardDiff=BoardDiff.mount({stage:document.querySelector('#stage'),scenes,changes:proj().changes,state:S,appearance:()=>look,attachPanZoom});
    boardDiff.scenes=scenes; boardDiff.render();
    const pane=boardDiff.panes[0], rect=pane.vp.getBoundingClientRect(), eventAt=p=>{const q=pane.renderer.project(p);return {clientX:rect.left+q[0],clientY:rect.top+q[1]};};
    const e=eventAt([11.5,10]);
    if(boardDiff.pick(pane.vp,eventAt([10,10]),null) || boardDiff.pick(pane.vp,eventAt([8,8]),null)) return 'hole or bbox false hit';
    pickAt(pane.vp,e);
    if(S.s!=='p5-head' || document.querySelector('#panel [aria-selected="true"][data-id]')?.dataset.id!==S.s) return 'geometry selection did not link row';
    pickAt(pane.vp,e); if(S.s!=='p5-base') return 'overlap did not cycle';
    if(!boardDiff.hits(pane.vp,e).some(h=>h.object.uuid==='unchanged')) return 'unchanged object cannot anchor';
    const saved=parent.postMessage, proposed=[]; parent.postMessage=data=>proposed.push(data.kicadReviewPin);
    try { proposePin(pane.vp,eventAt([10,10])); } finally { parent.postMessage=saved; }
    if(proposed[0]?.target!=='point' || proposed[0].x!==10 || proposed[0].y!==10) return 'hole did not produce mm point anchor';
    const hit=boardDiff.hits(pane.vp,e)[0], a=geometryAnchor(hit);
    if(a.target!=='object' || a.uuid!=='head') return 'geometry anchor identity';
    const hole=boardDiff.point(pane.vp,eventAt([10,10])); if(hole.side!=='head') return 'primary side';
    S.m='blend'; S.blend=0; boardDiff.render(); if(boardDiff.pick(pane.vp,e,null)?.side!=='base') return 'transparent head hit';
    S.m='wipe'; S.wipe=.6; boardDiff.render(); if(boardDiff.point(pane.vp,e).side!=='base') return 'wipe base routing';
    S.wipe=.4; boardDiff.render(); if(boardDiff.point(pane.vp,e).side!=='head') return 'wipe head routing';
    look={...look,nets:{'':{visible:false}}}; boardDiff.render();
    if(boardDiff.pick(pane.vp,e,null)) return 'hidden net hit';
    look={...look,nets:{},layers:{...look.layers,'F.Cu':{visible:false,opacity:0}}}; boardDiff.render();
    if(boardDiff.pick(pane.vp,e,null)) return 'hidden layer hit';
    look=glAppearance(); S.m='overlay'; S.s='p5-head'; markSelected(); boardDiff.render();
    return true;
  `],
  ["board geometry mouse input selects and pin Thermal", "v=board&m=side", `
    if(window.__boardInputDone) {
      if(S.s!==window.__boardInput.id) return 'native pointer failed selection';
      if(window.__boardPins.length<2 || window.__boardPins.some(a=>a.target!=='object' || !a.uuid)) return 'right click / placing did not anchor geometry';
      const anchor=window.__boardPins[0], resolved=resolveAnchor(JSON.parse(JSON.stringify(anchor)));
      if(resolved.detached) return resolved.detached;
      const controller=boardDiff; boardDiff=null;
      try { if(resolveAnchor(anchor).detached) return 'geometry anchor depends on mounted board'; } finally { boardDiff=controller; }
      acceptThreads([{id:'thermal-geometry',resolved:false,anchor,comments:[{body:'Geometry anchored on Thermal board',author:'Review',created_at:'2026-10-15'}]}]);
      drawPins();
      if(!document.querySelector('#stage .pin[data-thread="thermal-geometry"]')) return 'retained pin absent';
      return true;
    }
    const p=D.projects.findIndex(p=>p.name==='Thermal_Camera');
    if(p<0 || !D.projects[p].board.geometry?.head) return 'skip';
    await applyState({p,v:'board',m:'side',x:158.5,y:78.2,z:65});
    const row=proj().changes.find(c=>c.where?.board); await goTo(row.id);
    const pane=boardDiff.panes.find(p=>p.sides.includes('head')), r=pane.vp.getBoundingClientRect();
    let event;
    for(const object of pane.scenes.head.objects.filter(o=>o.changeIds.includes(row.id) && o.pickable!==false)) {
      const b=BoardDiff.objectBounds(object); if(!b) continue;
      for(const u of [.25,.5,.75]) for(const v of [.25,.5,.75]) {
        const q=pane.renderer.project([b[0]+(b[2]-b[0])*u,b[1]+(b[3]-b[1])*v]);
        const e={clientX:r.left+q[0],clientY:r.top+q[1]};
        if(boardDiff.pick(pane.vp,e,null)?.id===row.id) {event=e;break;}
      }
      if(event) break;
    }
    if(!event) return 'no visible Thermal changed geometry';
    THREADS_ON=true; window.__boardPins=[]; addEventListener('message',e=>{if(e.data?.kicadReviewPin) window.__boardPins.push(e.data.kicadReviewPin);});
    window.__boardInput={x:event.clientX,y:event.clientY,id:row.id,camera:{x:S.x,y:S.y,z:S.z}}; S.s=null; markSelected(); boardDiff.render();
    return true;
  `],
  ["board geometry selection Thermal proof", "v=board&m=side", `
    const p=D.projects.findIndex(p=>p.name==='Thermal_Camera');
    if(p<0 || !D.projects[p].board.geometry?.head) return 'skip';
    await applyState({p,v:'board',m:'side',x:158.5,y:78.2,z:65});
    const row=proj().changes.find(c=>c.where?.board); await goTo(row.id);
    if(S.s!==row.id || !boardDiff.bounds(row.id,'head')) return 'row did not frame geometry';
    setT({x:158.5,y:77.5,z:55}); return true;
  `],
  ["board geometry pin flipped Wipe Thermal", "v=board&m=wipe", `
    const p=D.projects.findIndex(p=>p.name==='Thermal_Camera');
    if(p<0 || !D.projects[p].board.geometry?.head) return 'skip';
    await applyState({p,v:'board',m:'wipe',x:158.5,y:77.5,z:55});
    Appearance.patch({flip:true}); await draw();
    const pane=boardDiff.panes[0], row=proj().changes.find(c=>c.where?.board && c.action==='removed');
    if(!row) return 'fixture needs removed geometry';
    const object=pane.scenes.base.objects.find(o=>o.changeIds.includes(row.id) && o.pickable!==false && o.kind!=='footprint');
    if(!object) return 'fixture needs removed leaf';
    const anchor=geometryAnchor({object,side:'base',point:[158.5,77.5]});
    const restored=JSON.parse(JSON.stringify(anchor)), resolved=resolveAnchor(restored);
    if(resolved.detached || resolved.side!=='base') return 'removed geometry failed re-anchor';
    const controller=boardDiff; boardDiff=null;
    try { if(resolveAnchor(restored).detached) return 'removed leaf anchor depends on mounted board'; }
    finally { boardDiff=controller; }
    S.s=row.id; S.wipe=1; apply();
    acceptThreads([{id:'thermal-removed',resolved:false,anchor:restored,comments:[]}]);
    let pin=pane.hud.querySelector('.pin'); if(!pin) return 'removed pin absent';
    const q=pane.renderer.project(resolved.pos);
    if(Math.abs(parseFloat(pin.style.left)-q[0])>.1 || Math.abs(parseFloat(pin.style.top)-q[1])>.1) return 'flipped DPR pin projection';
    S.wipe=0; apply(); if(pane.hud.querySelector('.pin')) return 'base pin visible on head Wipe';
    S.wipe=1; apply();
    const e=(()=>{const r=pane.vp.getBoundingClientRect();return{clientX:r.left+q[0],clientY:r.top+q[1]};})();
    const point=boardDiff.point(pane.vp,e);
    if(Math.hypot(point.point[0]-resolved.pos[0],point.point[1]-resolved.pos[1])>1e-7 || point.side!=='base') return 'flipped inverse';
    const layers=Appearance.get().layers;
    Appearance.patch({layers:{[anchor.layer]:{...layers[anchor.layer],visible:false}}}); await draw(); drawPins();
    if(document.querySelector('#stage .pin')) return 'hidden layer pin remains';
    Appearance.patch({layers:{[anchor.layer]:layers[anchor.layer]}}); await draw(); drawPins();
    return !!document.querySelector('#stage .pin') || 'pin did not recover';
  `],
  ["board geometry moved selection and revision pin lifecycle", "v=board&m=side", `
    Appearance.reset();
    boardDiff?.dispose(); document.querySelector('#stage').replaceChildren();
    const object=(uuid,x,ids=[])=>({uuid,changeUuid:uuid,kind:'pad',ref:null,changeIds:ids,box:[x-1000,9000,x+1000,11000],
      geometry:{primitive:{shape:'circle',center:[x,10000],size:[2000,2000],angle:0}},
      layers:['F.Cu'],net:0,category:'pads',side:'front',hidden:false});
    const scene=objects=>({version:1,units:'um',complete:true,warnings:[],bounds:[0,0,24000,20000],
      layers:[{id:0,name:'F.Cu',type:'signal',enabled:true}],nets:[{id:0,name:''}],objects});
    const scenes={base:scene([object('p5-moved',6000,['p5-move']),object('p5-unchanged',12000)]),
      head:scene([object('p5-moved',18000,['p5-move']),object('p5-unchanged',12000),object('p5-added',21000,['p5-add'])])};
    // Anchor resolution consults decoded revisions before the mounted compositor.
    // Keep this synthetic fixture independent of an already-decoded real report.
    proj().board.geometry={base:'p5-synthetic-base',head:'p5-synthetic-head'};
    for(const side of ['base','head']) decodedBoardScenes.set(proj().board.geometry[side],scenes[side]);
    proj().changes.push({id:'p5-move',kind:'pad',action:'modified',where:{board:true}},
      {id:'p5-add',kind:'pad',action:'added',where:{board:true}});
    Object.assign(S,{x:12,y:10,z:20,s:null,m:'side'}); renderPanel();
    boardDiff=BoardDiff.mount({stage:document.querySelector('#stage'),scenes,changes:proj().changes,state:S,appearance:glAppearance,attachPanZoom});
    boardDiff.scenes=scenes; boardDiff.render();
    const eventAt=(pane,p)=>{const r=pane.vp.getBoundingClientRect(),q=pane.renderer.project(p);return{clientX:r.left+q[0],clientY:r.top+q[1]};};
    const uploads=boardDiff.panes.map(p=>p.renderer.stats.uploads);
    for(const [side,x] of [['base',6],['head',18]]) {
      const pane=boardDiff.panes.find(p=>p.sides.includes(side)), hit=boardDiff.pick(pane.vp,eventAt(pane,[x,10]),null);
      if(hit?.id!=='p5-move' || hit.side!==side) return 'moved '+side+' hit';
      pickAt(pane.vp,eventAt(pane,[x,10])); if(S.s!=='p5-move') return 'moved row selection';
    }
    if(boardDiff.panes.some((p,i)=>p.renderer.stats.uploads!==uploads[i])) return 'selection rebuilt scene buffers';
    const anchor=object=>geometryAnchor({object,side:'head',point:[12,10]});
    (proj().objects ||= []).push({uuid:'p5-rotated',kind:'footprint',ref:'p5-R',side:'head',pos:[12,10,90],pos_before:[12,10,0]});
    const rotated={...anchor(scenes.head.objects[1]),uuid:'p5-rotated',kind:'footprint',ref:'p5-R'};
    acceptThreads([...['p5-moved','p5-unchanged','p5-added'].map((uuid,i)=>({id:'p5-thread-'+i,resolved:false,
      anchor:anchor(scenes.head.objects.find(o=>o.uuid===uuid)),comments:[]})),
      {id:'p5-rotation',resolved:false,anchor:rotated,comments:[]}]);
    const pins=(pane,id)=>[...pane.hud.querySelectorAll('.pin')].filter(p=>p.dataset.thread===id);
    const base=boardDiff.panes[0],head=boardDiff.panes[1];
    if(pins(base,'p5-thread-0').length!==1 || pins(head,'p5-thread-0').length!==1) return 'moved pins missing';
    for(const [pane,x] of [[base,6],[head,18]]) {
      const p=pins(pane,'p5-thread-0')[0], q=pane.renderer.project([x,10]);
      if(Math.abs(parseFloat(p.style.left)-q[0])>.1) return 'moved before/head projection';
    }
    if(pins(base,'p5-thread-1').length!==1 || pins(head,'p5-thread-1').length!==1 || pins(base,'p5-thread-2').length) return 'unchanged/added Side policy';
    const movedAnchor=S.threads[0].anchor;
    S.m='overlay'; boardDiff.dispose(); document.querySelector('#stage').replaceChildren();
    boardDiff=BoardDiff.mount({stage:document.querySelector('#stage'),scenes,changes:proj().changes,state:S,appearance:glAppearance,attachPanZoom});
    boardDiff.scenes=scenes; apply();
    const pane=boardDiff.panes[0];
    if(pins(pane,'p5-thread-0').length!==2 || pins(pane,'p5-thread-1').length!==1) return 'overlay pin deduplication';
    if(pins(pane,'p5-rotation').length!==1) return 'rotation-only pins must deduplicate at the same XY';
    S.m='blend'; S.blend=0; apply();
    if(pins(pane,'p5-thread-2').length || pins(pane,'p5-thread-0').length!==1) return 'zero head alpha pins';
    S.m='wipe'; S.wipe=.5; apply();
    if(pins(pane,'p5-thread-0').length!==2) return 'moved pins on both Wipe sides';
    const unchanged=geometryAnchor({object:scenes.head.objects[1],side:'head',point:[12,10]});
    if(unchanged.uuid!=='p5-unchanged' || unchanged.target!=='object') return 'unchanged leaf identity';
    scenes.head.objects.splice(0,1); scenes.base.objects.splice(0,1); S.t='threads'; drawPins(); renderPanel();
    return !pins(pane,'p5-thread-0').length && !!document.querySelector('#panel .threads-detached')
      && !!resolveAnchor(movedAnchor).detached || 'detached thread lost';
  `],
  ["board address preserves inactive 3D keys and explicit selection camera", "", `
    const row=proj().changes.find(c=>c.where?.board);
    const q=new URLSearchParams('p=0&v=board&m=wipe&x=10&y=20&z=5&t=changes&l=F_Cu&c=1,2,3,4,5,6&h=silk');
    q.set('s',row.id);
    await applyState(decodeState(q.toString()));
    if(S.x!==10 || S.y!==20 || S.z!==5 || S.s!==row.id) return 'explicit camera recentered';
    const back=new URLSearchParams(encodeState());
    for(const [key,value] of q) if(key!=='t' && back.get(key)!==value) return 'lost address key '+key;
    await applyState({...decodeState(q.toString()),m:'semantic'});
    return S.m==='semantic' && document.querySelector('#modes [data-mode="semantic"]').textContent.includes('Changes only');`],
  ["SCH6 comparison modes preserve selection paper grid and one-sided revisions", "", `
    const p=proj(), sheet=p.sheets.find(s=>s.svg);
    S.v='sheet:'+sheet.path; S.grid=true;
    const row=p.changes.find(r=>onView(r,S.v)&&rowBox(r,'head'));
    if(!row) return 'sample needs schematic change';
    for(const mode of ['side','overlay','wipe','blend','semantic']) {
      S.m=mode; S.s=row.id; await draw(); fit();
      if(!document.querySelector('#stage .vp.sheet .layer svg')) return mode+' SVG';
      if(!document.querySelector('#stage .marker.sel')) return mode+' selection';
      if(getComputedStyle(document.querySelector('#stage .vp.sheet')).backgroundColor!=='rgb(245, 244, 239)') return mode+' paper';
      if(!document.querySelector('#stage .sch-grid')) return mode+' grid';
      if(S.x!==sheet.size[0]/2 || S.y!==sheet.size[1]/2) return mode+' full-page fit';
      const hash=encodeState(); await applyState(decodeState('#'+hash));
      if(S.s!==row.id||S.v!=='sheet:'+sheet.path) return mode+' address';
    }
    const svg={...sheet.svg};
    try { for(const missing of ['base','head']) {
      sheet.svg={base:svg.base||svg.head,head:svg.head||svg.base,[missing]:null};
      for(const mode of ['side','overlay','wipe','blend','semantic']) {
        S.m=mode; await draw();
        const stack=document.querySelector('#stage .stack.'+(missing==='base'?'head':'base'));
        if(!stack?.querySelector('svg')||getComputedStyle(stack).display==='none') return mode+' '+missing+' hid survivor';
        if(!document.querySelector('#stage .marker.sel')||!document.querySelector('#stage .sch-grid')) return mode+' '+missing+' lost selection/grid';
      }
    }} finally {sheet.svg=svg;}
    return true;
  `],
  ["SCH6 source raster is independent of active schematic palette", "", `
    const sheet=proj().sheets.find(s=>s.svg); S.v='sheet:'+sheet.path;
    const view=currentView(), a=await raster('head',view,200,150);
    document.documentElement.style.setProperty('--sch-ink-009600','#ff00ff');
    try {const b=await raster('head',view,200,150);return a.some(v=>v!==0)&&a.every((v,i)=>v===b[i]);}
    finally {document.documentElement.style.removeProperty('--sch-ink-009600');}
  `],
  ["SCH6 marks retain action cues selection and live Appearance styles", "", `
    const p=proj(), sheet=p.sheets.find(s=>s.svg); S.v='sheet:'+sheet.path; S.m='side';
    p.changes=['added','removed','modified'].map((action,i)=>({id:'sch6-'+i,action,kind:i===2?'wire':'symbol',ref:'U'+i,where:{sheet:sheet.path},pos:[20+10*i,20],box:[18+10*i,18,22+10*i,22]}));
    S.s='sch6-1'; await draw();
    for(const style of ['outline','recolour']) {
      Appearance.patch({markStyle:style});
      for(const [action,glyph,line] of [['added','+','solid'],['removed','−','dashed'],['modified','~','dotted']]) {
        const m=document.querySelector('#stage .marker.'+action), css=m&&getComputedStyle(m);
        if(!m||m.dataset.glyph!==glyph||!m.getAttribute('aria-label')?.includes(BoardMarks.styles[action].word)||m.dataset.dash!==BoardMarks.styles[action].dash||css.borderTopStyle!==line) return style+' '+action+' cues';
        if(m.dataset.markStyle!==style||!m.querySelector('.sch-mark-label')?.textContent.includes(BoardMarks.styles[action].word)) return style+' '+action+' word/style';
        if(css.pointerEvents!=='none') return 'marker intercepts pins';
        if(style==='recolour'&&css.backgroundColor==='rgba(0, 0, 0, 0)'&&css.backgroundImage==='none') return action+' no tint';
      }
      for(const w of document.querySelectorAll('#stage .world')) if(w.querySelectorAll('.marker.sel').length!==1||w.querySelectorAll('.marker.removed').length!==1) return 'duplicate selection';
      const button=document.querySelector('button[data-mark-style="recolour"]');
      if(button.disabled||!button.title.includes('no object IDs')) return 'schematic mark control';
    }
    return true;
  `],
  ["SCH6 sheet pins selection linking and rapid draws preserve addresses", "", `
    const p=proj(), sheet=p.sheets.find(s=>s.svg), v='sheet:'+sheet.path;
    const row=p.changes.find(r=>r.where?.sheet===sheet.path&&rowBox(r,'head'));
    if(!row) return 'sheet change required';
    await goTo(row.id);
    if(S.v!==v||S.s!==row.id) return 'list linking';
    const b=rowBox(row,'head'), x=(b[0]+b[2])/2, y=(b[1]+b[3])/2;
    const anchor={v:1,project:p.dir,file:(p.dir?p.dir+'/':'')+sheet.file,sheet:sheet.path,layer:null,target:'point',uuid:null,kind:null,ref:null,x,y,side:'head',commit:D.head,severity:'comment'};
    S.threads=[{id:'sch6-pin',resolved:false,anchor,comments:[]}];
    for(const mode of ['side','overlay','wipe','blend','semantic']) {
      S.m=mode; await draw();
      const pin=document.querySelector('#stage .pin[data-thread="sch6-pin"]');
      if(!pin||getComputedStyle(pin).pointerEvents==='none'||resolveAnchor(anchor).view!==v) return mode+' pin';
      const vp=pin.closest('.vp'), r=vp.getBoundingClientRect();
      const cx=r.left+r.width/2+(x-S.x)*S.z, cy=r.top+r.height/2+(y-S.y)*S.z;
      S.s=null; pickAt(vp,{clientX:cx,clientY:cy}); await draw();
      if(S.s!==row.id) return mode+' picking';
      const hash=encodeState(); await applyState(decodeState('#'+hash));
      if(S.s!==row.id||S.v!==v||!document.querySelector('.marker.sel')) return mode+' hash';
    }
    const pending=[];
    for(const mode of ['side','overlay','wipe','blend','semantic']) {S.m=mode; pending.push(draw());}
    await Promise.all(pending);
    return document.querySelector('#stage').classList.contains('mode-semantic')&&!!document.querySelector('#stage .pin[data-thread="sch6-pin"]');
  `],
  ...['side','overlay','wipe','blend','semantic'].map(mode=>['SCH6 Thermal schematic mode proof '+mode,'',`
    const index=D.projects.findIndex(p=>p.name==='Thermal_Camera');
    if(index<0) return 'skip';
    S.p=index;
    const sheet=proj().sheets.find(s=>s.svg&&proj().changes.some(r=>r.where?.sheet===s.path&&rowBox(r,'head')));
    if(!sheet) return 'Thermal real schematic change required';
    S.v='sheet:'+sheet.path; S.m='${mode}'; S.s=proj().changes.find(r=>r.where?.sheet===sheet.path&&rowBox(r,'head')).id;
    S.grid=true; Appearance.patch({markStyle:'recolour'}); renderNav(); renderModes(); renderPanel(); await draw(); fit();
    return !!document.querySelector('#stage .vp.sheet svg')&&!!document.querySelector('#stage .marker.sel');
  `]),
  ["SCH6 removed-only schematic fixture preserves region cues in every mode", "", `
    const p=proj(), sheet=p.sheets.find(s=>s.svg?.base||s.svg?.head);
    if(!sheet) return 'schematic required';
    S.v='sheet:'+sheet.path; S.grid=true;
    // A removed-sheet fixture, not a claim that the Thermal value edit removed this sheet.
    sheet.svg={base:sheet.svg.base||sheet.svg.head,head:null};
    p.changes=[{id:'sch6-removed-sheet',action:'removed',kind:'sheet',ref:sheet.name,
      where:{sheet:sheet.path},box:[0,0,...sheet.size]}];
    S.s='sch6-removed-sheet'; Appearance.patch({markStyle:'recolour'});
    for(const mode of ['side','overlay','wipe','blend','semantic']) {
      S.m=mode; renderNav(); renderModes(); renderPanel(); await draw(); fit();
      const stack=document.querySelector('#stage .stack.base'), mark=document.querySelector('#stage .marker.sel.removed');
      if(!stack?.querySelector('svg')||getComputedStyle(stack).display==='none') return mode+' survivor';
      const semantic=BoardMarks.styles.removed;
      if(!mark||mark.dataset.glyph!==semantic.glyph||getComputedStyle(mark).borderTopStyle!==semantic.dash
        ||!mark.querySelector('.sch-mark-label')?.textContent.includes(semantic.word)
        ||mark.dataset.label!==semantic.glyph+' '+semantic.word
        ||getComputedStyle(mark,'::after').content!==JSON.stringify(mark.dataset.label)) return mode+' removed cues';
    }
    return true;
  `],
  ["SCH6 rapid theme mode and sheet changes preserve selected findings", "", `
    const p=proj(), sheet=p.sheets.find(s=>s.svg), svg=sheet.svg, theme=KRTheme.get();
    const other={...sheet,path:'/__sch6_other__/'};
    p.sheets.push(other);
    p.checks.push({title:'SCH6',violations:[{id:'sch6-finding',kind:'symbol',ref:'U1',
      where:{sheet:sheet.path},pos:[20,20]}]});
    sheet.svg={base:null,head:svg.head||svg.base};
    try {
      const pending=[];
      for(const [i,mode] of ['side','overlay','wipe','blend','semantic'].entries()) {
        KRTheme.set(i%2?'light':'dark');
        S.v='sheet:'+(i%2?other.path:sheet.path); S.m=mode; S.s='sch6-finding';
        pending.push(draw());
      }
      await Promise.all(pending);
      const stage=document.querySelector('#stage'), m=stage.querySelector('.marker.sel.violation');
      return stage.classList.contains('mode-semantic')&&!!stage.querySelector('.stack.head svg')
        &&!!m&&m.dataset.glyph==='!'&&m.getAttribute('aria-label')==='finding U1'
        &&getComputedStyle(stage.querySelector('.vp.sheet')).backgroundColor==='rgb(245, 244, 239)';
    } finally {sheet.svg=svg; p.sheets.pop(); p.checks.pop(); KRTheme.set(theme);}
  `],
  ["chrome toolbar modes keep legacy IDs and radio focus", "", `
  const bs = [...document.querySelectorAll('#modes [data-mode]')];
  if (bs.map(b => b.textContent.trim()).join('|') !== 'Side|Overlay|Wipe|Blend|Changes only') return 'labels';
  if (bs.filter(b => b.tabIndex === 0).length !== 1) return 'roving';
  const overlay = bs.find(b => b.dataset.mode === 'overlay'); overlay.focus(); overlay.click();
  const o2 = document.querySelector('#modes [data-mode=overlay]'); o2.focus();
  o2.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowRight', bubbles:true}));
  const a = document.activeElement;
  return S.m === 'wipe' && a.dataset.mode === 'wipe' && a.getAttribute('aria-checked') === 'true'
    && document.querySelector('#toolbar #zoombar') !== null
    && !document.querySelector('#zoombar').textContent.includes('j / k')
    && document.querySelector('#report-review-bar .goto').getAttribute('aria-label') === 'Go to saved review position'
    && /^(\u2013|\\d+) \\/ \\d+$/.test(document.querySelector('#change-count').textContent)
    && !!document.querySelector('[data-mark-style]');`],
  ["chrome toolbar change counter follows step", "", `
  const n = document.querySelectorAll('#panel .card[data-id]').length;
  if (!n) return 'no cards';
  if (document.querySelector('#change-count').textContent.split(' / ')[1] !== String(n)) return 'total ' + document.querySelector('#change-count').textContent;
  document.querySelector('#change-nav [data-step="1"]').click();
  await new Promise(r => setTimeout(r, 50));
  return /^\\d+ \\/ /.test(document.querySelector('#change-count').textContent) || document.querySelector('#change-count').textContent;`],
  ["board context loss retains state and requires explicit retry", "v=board", `
    const realGeometry=!!proj().board.geometry;
    if(!realGeometry) { ${BOARD_LIFECYCLE_FIXTURE} }
    else {S.m='overlay';await draw();fit();}
    setT({});   // a placed camera: live Fit would otherwise re-centre when the fallback changes the layout
    renderModes();
    if(!boardDiff) return 'missing compositor';
    S.s=proj().changes.find(c=>c.where?.board)?.id || null; S.layers=['F_Cu'];
    const before=JSON.stringify([S.x,S.y,S.z,S.s,S.m,S.layers]), old=boardDiff;
    const ext=old.panes[0].renderer.gl.getExtension('WEBGL_lose_context');
    if(!ext) throw Error('WebGL context-loss extension unavailable');
    ext.loseContext();
    for(let n=0;n<100 && !document.querySelector('#stage .stack svg');n++) await new Promise(r=>setTimeout(r,25));
    if(boardDiff || !document.querySelector('#stage .stack svg') || !old.panes.every(p=>p.renderer.stats.disposed)) return 'context loss did not dispose and fall back';
    if(JSON.stringify([S.x,S.y,S.z,S.s,S.m,S.layers])!==before) return 'state lost';
    if(!/WebGL.*SVG/.test(document.querySelector('#statusbar .status-message').textContent)) return 'missing fallback notice';
    for(let n=0;n<3;n++) await draw();
    if(boardDiff || boardView.failed!==S.p) return 'lost context remounted without retry';
    return true;
  `],
  ["board stale failure cannot replace newer project", "v=board", `
    const mount=BoardDiff.mount; let stale;
    BoardDiff.mount=options=>{ stale=options.onLost; return mount(options); };
    try { ${BOARD_LIFECYCLE_FIXTURE} } finally { BoardDiff.mount=mount; }
    if(!boardDiff || !stale) return 'missing live board';
    const old=boardDiff;
    const next=structuredClone(proj()); next.dir+='-lifecycle'; next.name+=' lifecycle'; D.projects.push(next);
    S.p=D.projects.length-1; await draw();
    const current=boardDiff;
    if(!current || current===old || !old.panes.every(p=>p.renderer.stats.disposed)) return 'project did not replace old controller';
    stale(Error('late old-project context loss'));
    await new Promise(r=>setTimeout(r,100));
    return boardDiff===current && boardView.failed!==S.p && current.panes.every(p=>!p.renderer.stats.disposed)
      || 'stale callback destroyed current board';
  `],
  ["board startup without WebGL2 keeps SVG modes and state", "v=board&x=5&y=5&z=20", `
    ${BOARD_LIFECYCLE_FIXTURE}
    for(const mode of ['side','overlay','wipe','blend','semantic']) {
      S.m=mode; await draw();
      if(boardDiff || !document.querySelector('#stage .stack svg')) return 'no SVG '+mode;
      if(S.x!==5 || S.y!==5 || S.z!==20) return 'camera lost '+mode;
    }
    return window.__webglAcquisitions>0 && /WebGL.*SVG/.test(document.querySelector('#statusbar .status-message').textContent);
  `, {beforeStartup:`window.__webglAcquisitions=0; const getContext=HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext=function(type,...args){if(type==='webgl2'){window.__webglAcquisitions++;return null;}return getContext.call(this,type,...args);};`}],
  ["board mode lifecycle releases GPU contexts and pending work", "v=board", `
    ${BOARD_LIFECYCLE_FIXTURE}
    for(let n=0;n<50;n++) {
      const old=boardDiff, resources=old.panes.map(p=>({gl:p.renderer.gl,program:p.program,markProgram:p.markProgram,vao:p.vao,targets:[...(p.targets||[])]}));
      S.m=['side','overlay','wipe','blend','semantic'][n%5]; await draw();
      if(!boardDiff || boardDiff===old) return 'mode did not replace controller '+n;
      for(const r of resources) {
        if(r.gl.isProgram(r.program) || r.gl.isProgram(r.markProgram) || r.gl.isVertexArray(r.vao)
          || r.targets.some(t=>r.gl.isTexture(t.texture)||r.gl.isFramebuffer(t.framebuffer)||r.gl.isRenderbuffer(t.stencil))) return 'GPU resources retained '+n;
        if(!r.gl.isContextLost()) return 'disposed WebGL context still active '+n;
      }
      const draws=old.panes.map(p=>p.renderer.stats.draws);
      old.render(); await new Promise(r=>requestAnimationFrame(r));
      if(old.panes.some((p,i)=>p.renderer.stats.draws!==draws[i])) return 'disposed render scheduled '+n;
      if(!boardDiff.panes.every(p=>p.canvas.isConnected&&!p.renderer.stats.disposed)) return 'active scene disposed '+n;
    }
    return true;
  `],
  ["board rapid project decode keeps only latest generation", "v=board", `
    ${BOARD_LIFECYCLE_FIXTURE}
    const original=loadBoardScene, old=boardDiff, first=S.p;
    const next=structuredClone(proj()); next.dir+='-rapid'; next.name+=' rapid'; D.projects.push(next);
    const latest=D.projects.length-1;
    let release, pending=true;
    loadBoardScene=async key=>{if(pending){pending=false;await new Promise(r=>release=r);}return original(key);};
    try {
      const stale=draw(); S.p=latest; await draw(); const current=boardDiff;
      release(); await stale;
      return S.p===latest && boardDiff===current && current!==old && current.project===latest
        && old.panes.every(p=>p.renderer.stats.disposed) && document.querySelectorAll('#stage canvas.board-gl').length===current.panes.length
        || 'stale decode replaced current project';
    } finally {loadBoardScene=original;release?.();}
  `],
  ["board offline all modes and both mark styles draw content", "v=board", `
    if(!proj().board.geometry) return 'skip';
    Appearance.patch({grid:{visible:false}});
    for(const markStyle of ['outline','recolour']) for(const mode of ['side','overlay','wipe','blend','semantic']) {
      Appearance.patch({markStyle}); S.m=mode; await draw(); fit();
      if(!boardDiff || boardDiff.panes.length!==(mode==='side'?2:1)) return 'missing geometry '+mode;
      const background=mode==='overlay'?[255,255,255]:[0,16,35];
      for(let i=0;i<boardDiff.panes.length;i++) {
        const pane=boardDiff.panes[i], gl=pane.renderer.gl;
        const pixels=new Uint8Array(pane.canvas.width*pane.canvas.height*4);
        gl.bindFramebuffer(gl.FRAMEBUFFER,null); gl.readPixels(0,0,pane.canvas.width,pane.canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
        let content=0;
        for(let n=0;n<pixels.length;n+=4) if(background.some((c,j)=>Math.abs(pixels[n+j]-c)>10)) content++;
        const populated=Object.values(pane.scenes).some(scene=>scene?.objects.length);
        if(populated ? content<100 : content!==0) return 'wrong content pixels '+mode+' '+markStyle+' '+i;
      }
    }
    return true;
  `],
  ["board stale decode failure cannot mark newer project", "v=board", `
    ${BOARD_LIFECYCLE_FIXTURE}
    const original=loadBoardScene;
    const next=structuredClone(proj()); next.dir+='-decode-error'; next.name+=' decode error'; D.projects.push(next);
    let release, pending=true;
    loadBoardScene=async key=>{if(pending){pending=false;await new Promise(r=>release=r);throw Error('stale decode failure');}return original(key);};
    try {
      const stale=draw(); S.p=D.projects.length-1; await draw(); const current=boardDiff;
      release(); await stale;
      return boardDiff===current && boardView.note===null && boardView.failed!==S.p
        || 'stale decode failure changed newer project status';
    } finally {loadBoardScene=original;release?.();}
  `],
  ["board fresh project restores after real context loss", "v=board&m=semantic", `
    if(!proj().board.geometry) { ${BOARD_LIFECYCLE_FIXTURE} }
    S.m='semantic'; await draw(); fit();
    const before=JSON.stringify([S.x,S.y,S.z,S.s,S.m]), old=boardDiff;
    if(!old) return 'no initial geometry';
    const ext=old.panes[0].renderer.gl.getExtension('WEBGL_lose_context');
    if(!ext) throw Error('WebGL context-loss extension unavailable');
    ext.loseContext();
    for(let n=0;n<100&&!document.querySelector('#stage .stack svg');n++) await new Promise(r=>setTimeout(r,25));
    if(boardDiff || !document.querySelector('#stage .stack svg')) return 'did not fall back';
    const next=structuredClone(proj()); next.dir+='-restored'; next.name+=' restored'; D.projects.push(next);
    S.p=D.projects.length-1; await draw();
    return !!boardDiff && boardDiff!==old && boardView.failed===null && old.panes.every(p=>p.renderer.stats.disposed)
      && boardDiff.panes.every(p=>p.renderer.stats.uploads>0&&!p.renderer.gl.isContextLost())
      && JSON.stringify([S.x,S.y,S.z,S.s,S.m])===before || 'fresh project did not restore state';
  `],
  ["board target allocation failure uses SVG without state loss", "v=board", `
    ${BOARD_LIFECYCLE_FIXTURE}
    const old=boardDiff, pane=old.panes[0], gl=pane.renderer.gl, create=gl.createTexture;
    const before=JSON.stringify([S.x,S.y,S.z,S.s,S.m]);
    try {
      pane.targets[0].width=-1; gl.createTexture=()=>null; old.render();
      for(let n=0;n<100&&!document.querySelector('#stage .stack svg');n++) await new Promise(r=>setTimeout(r,25));
      return !boardDiff && !!document.querySelector('#stage .stack svg') && boardView.failed===S.p
        && old.panes.every(p=>p.renderer.stats.disposed) && JSON.stringify([S.x,S.y,S.z,S.s,S.m])===before
        || 'allocation failure did not preserve SVG state';
    } finally {gl.createTexture=create;}
  `],
  ["SCH6 proof framed page", "v=sheet:/&m=side", `
    await draw(); fit();
    await new Promise(resolve => requestAnimationFrame(resolve));
    const svg=document.querySelector('#stage .vp.sheet .layer svg');
    return !!svg && svg.querySelectorAll('path').length>100 && currentView().kind==='sheet'
      && svg.getBoundingClientRect().width>0;
  `],
  ["SCH6 proof live palette status and comparison controls", "v=sheet:/&m=side", `
    await draw(); fit();
    const svg=document.querySelector('#stage .vp.sheet .layer svg');
    const wire=[...svg.querySelectorAll('[style]')].find(e=>e.style.stroke.includes('--sch-ink-009600'));
    const frame=[...svg.querySelectorAll('[style]')].find(e=>e.style.stroke.includes('--sch-ink-840000'));
    if(!wire||!frame) return 'KiCad wire/frame paints required';
    const root=svg, original=root.style.getPropertyValue('--sch-ink-009600');
    const frameColour=getComputedStyle(frame).stroke;
    try {
      root.style.setProperty('--sch-ink-009600','#135724');
      if(getComputedStyle(wire).stroke!=='rgb(19, 87, 36)'||getComputedStyle(frame).stroke!==frameColour)
        return 'loaded SVG palette';
    } finally {
      if(original) root.style.setProperty('--sch-ink-009600',original);
      else root.style.removeProperty('--sch-ink-009600');
    }
    for(const vp of document.querySelectorAll('#stage .vp.sheet')) {
      const r=vp.getBoundingClientRect();
      updateCoordinates(vp,{clientX:r.left+r.width/2,clientY:r.top+r.height/2});
      for(const e of document.querySelectorAll('[data-coordinate]')) {
        const b=e.getBoundingClientRect(); if(b.left<0||b.right>innerWidth||b.bottom>innerHeight) return 'clipped coordinates';
      }
    }
    S.m='wipe'; renderModes(); await draw();
    const divider=document.querySelector('#stage .divider');
    divider.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}));
    if(S.wipe!==1||divider.getAttribute('aria-valuenow')!=='100') return 'wipe control';
    S.m='blend'; renderModes(); await draw();
    const slider=document.querySelector('#modes input[type=range]'); slider.value='25'; slider.dispatchEvent(new Event('input'));
    if(S.blend!==.25||document.querySelector('#stage .stack.head').style.opacity!=='0.25') return 'blend control';
    S.m='side'; S.grid=true; renderModes(); await draw(); fit();
    const address=encodeState({...S,x:-12.345,y:67.89,z:10,s:'sch6-proof',t:'checks',
      layers:['F.Cu'],camera3d:[1,2,3,4,5,6],hidden3d:['tracks']});
    const query=new URLSearchParams(address);
    if(['p','v','m','x','y','z','s','t','l','c','h'].some(key=>!query.has(key))
      ||encodeState(decodeState('#'+address))!==address) return 'complete address round trip';
    return true;
  `],

  ["Themes reload seed", "v=board&m=side", `
    const p=D.projects.findIndex(p=>p.board.geometry?.base&&p.board.geometry?.head);
    if(p<0)return 'skip';   // needs a fixture with both geometry revisions (run with --page)
    await applyState({p,v:'board',m:'side'});
    const store=appearanceStore(), next=store.get();
    next.colors['board.copper.f']=[.12,.34,.56,.78];
    next.colors['schematic.wire']=[18/255,52/255,86/255,1];
    next.layerOpacity['F.Cu']=.37;next.objectOpacity.zones=.29;
    next.markStyle='recolour';store.set(next);return true;
  `],
  ...['board','schematic'].map(type=>['Themes proof '+type,'v=board&m=side',`
    const p=D.projects.findIndex(p=>p.board.geometry?.base&&p.board.geometry?.head);
    if(p<0)return 'skip';   // needs a fixture with both geometry revisions (run with --page)
    await applyState({p,v:'board',m:'side'});
    const sheet=proj().sheets.find(s=>s.svg);
    if('${type}'==='schematic'&&!sheet)return 'fixture needs schematic';
    S.v='${type}'==='board'?'board':'sheet:'+sheet.path;
    S.s=null;S.x=S.y=S.z=null;
    const store=appearanceStore();
    // Family runs also exercise defaults. Screenshot runs always supply a fixture.
    if(typeof window.__appearanceFixtureText==='string')store.import(window.__appearanceFixtureText);
    else store.reset();
    store.patch({markStyle:window.__appearanceMarkStyle||'outline'});
    await draw();fit();renderNav();renderModes();
    const changed=proj().changes.find(r=>onView(r,S.v)&&rowBox(r,'head'));
    if(!changed)return 'fixture needs actual changed objects';
    const b=rowBox(changed,'head');
    setT({x:(b[0]+b[2])/2,y:(b[1]+b[3])/2,z:'${type}'==='board'?65:18});
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    const resolved=KrAppearance.resolve(store.get()), bg=resolved['${type}'==='board'?'boardBackground':'schematicBackground'];
    const marks=resolved.marks['${type}'];
    for(const [action,mark] of Object.entries(marks)) {
      if(mark.color[3]!==1||mark.halo[3]!==1||KrAppearance.contrast(mark.color,bg)<3)return 'low contrast '+action;
      const legend=document.querySelector('#stage '+('${type}'==='board'?'.board-mark-key':'.diff-mark-legend > span')+'[data-action="'+action+'"]');
      if(!legend||!legend.textContent.includes(mark.word)||legend.dataset.glyph!==mark.glyph||legend.dataset.dash!==BoardMarks.styles[action].dash)return 'missing legend '+action;
      const box=legend.getBoundingClientRect();if(box.left<0||box.right>innerWidth||box.bottom>innerHeight)return 'clipped legend '+action;
    }
    const visible=[...document.querySelectorAll('#stage .marker:not(.sel),#stage .board-mark-label')].some(m=>{
      const r=m.getBoundingClientRect(),vp=m.closest('.vp').getBoundingClientRect();
      return r.width>0&&r.height>0&&r.left<vp.right&&r.right>vp.left&&r.top<vp.bottom&&r.bottom>vp.top;
    });
    return visible||'no visible actual change mark';
  `]),
  ["Themes invalid import error panel proof", "v=board&t=appearance", `
    const input=document.querySelector('[data-appearance-file]'),store=appearanceStore(),before=JSON.stringify(store.get());
    const transfer=new DataTransfer();transfer.items.add(new File(['{"meta":{"version":5},"board":{"background":"url(bad)"}}'],'invalid.json',{type:'application/json'}));
    input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
    await new Promise(r=>setTimeout(r,100));
    const error=document.querySelector('[data-appearance-error]');
    return !error.hidden&&error.textContent.includes('board.background')&&JSON.stringify(store.get())===before||'missing atomic inline error';
  `],
  ["Themes blocked storage import reset and chrome toggle", "v=board&t=appearance", `
    const store=appearanceStore();
    store.import(JSON.stringify({meta:{version:5},board:{background:'#ffffff'}}));
    if(store.get().colors['board.background'][0]!==1)return 'blocked import';
    store.reset();if(JSON.stringify(store.get())!==JSON.stringify(KrAppearance.defaults()))return 'blocked reset';
    const toggle=document.querySelector('[data-theme-set='+(KRTheme.get()==='dark'?'light':'dark')+']'),before=KRTheme.get(),palette=JSON.stringify(store.get().colors);
    toggle.closest('details').open=true; toggle.focus();toggle.click();
    return KRTheme.get()!==before&&document.activeElement===toggle&&JSON.stringify(store.get().colors)===palette;
  `,{beforeStartup:`Storage.prototype.getItem=Storage.prototype.setItem=function(){throw new DOMException('Blocked','SecurityError')};`}],
  ["SCH6 single selected change retains themed action cues", "", `
    const p=proj(), saved=p.changes, sheet=p.sheets.find(s=>s.svg);
    const snapshot=Appearance.get();
    try {
      S.v='sheet:'+sheet.path;
      p.changes=[{id:'single-sch-mark',action:'modified',kind:'symbol',ref:'R7',where:{sheet:sheet.path},pos:[20,20],box:[18,18,22,22]}];
      S.s='single-sch-mark';
      for(const mode of ['side','overlay','wipe','blend','semantic']) {
        S.m=mode; await draw();
        for(const markStyle of ['outline','recolour']) {
          Appearance.patch({markStyle,colors:{'schematic.background':[1,1,1,1]}});
          const worlds=[...document.querySelectorAll('#stage .vp.sheet .world')];
          if(!worlds.length) return mode+' no schematic worlds';
          for(const world of worlds) {
            const marks=world.querySelectorAll('.marker');
            if(marks.length!==1) return mode+' selected change must have exactly one marker';
            const m=marks[0], semantic=BoardMarks.styles.modified;
            if(!m.classList.contains('sel')||m.dataset.action!=='modified') return mode+' selected action';
            if(m.dataset.glyph!==semantic.glyph||m.dataset.dash!==semantic.dash
              ||m.dataset.label!==semantic.glyph+' '+semantic.word
              ||getComputedStyle(m,'::after').content!==JSON.stringify(m.dataset.label)) return mode+' action cues';
            if(m.getAttribute('aria-label')!=='Modified R7'||m.querySelector('.sch-mark-label')?.textContent!=='Modified R7') return mode+' semantic word';
            const color=KrAppearance.resolve(Appearance.get()).marks.schematic.modified.color;
            const rgb=getComputedStyle(m).borderTopColor.match(/[0-9.]+/g).slice(0,3).map(Number);
            if(!rgb.every((v,i)=>Math.abs(v-color[i]*255)<1)) return mode+' live palette';
          }
        }
      }
      return true;
    } finally {p.changes=saved; Appearance.patch(snapshot);}
  `],
  ["chrome browser proof Thermal_Camera", "", `
  const i=D.projects.findIndex(p=>p.name==='Thermal_Camera');
  if(i<0) return 'Thermal_Camera fixture required';
  await applyState({p:i,v:'board',m:'side'}); fit(); updateStatus();
  const vp=document.querySelector('#stage .vp'), r=vp.getBoundingClientRect();
  vp.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:r.left+r.width/2+12,clientY:r.top+r.height/2+8}));
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  document.documentElement.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  return !!document.querySelector('#toolbar #zoombar') && !!document.querySelector('#panel-tabs')
    && ['x','y'].every(axis=> /^-?\\d+\\.\\d+$/.test(document.querySelector('#statusbar [data-coordinate='+axis+']').textContent))
    && (boardView.useGL ? boardDiff?.panes.length===2 && document.querySelectorAll('#stage canvas').length===2
      : !document.querySelector('#stage canvas') && !!document.querySelector('#stage svg'));`],
  ["chrome offline controls preserve SVG modes links theme and modal", "p=1&v=board", `
  for (const mode of ['side','overlay','wipe','blend','semantic']) {
    await applyState({p:1,v:'board',m:mode}); fit();
    if (S.m!==mode || !document.querySelector('#stage svg')) return 'mode '+mode;
  }
  const theme=KRTheme.get(); document.querySelector('[data-theme-set='+(theme==='dark'?'light':'dark')+']').click();
  if (KRTheme.get()===theme) return 'theme switch'; KRTheme.set(theme);
  Object.defineProperty(navigator,'clipboard',{value:undefined,configurable:true});
  document.querySelector('#report-review-bar [data-act=copy]').click();
  await new Promise(r=>setTimeout(r,100));
  const field=document.querySelector('#report-review-bar input[readonly]');
  if(!field || field.value!==positionLink() || document.activeElement!==field) return 'copy fallback';
  field.remove();
  const row=proj().changes.find(r=>viewOf(r)==='board');
  if(!row) return 'board change fixture required'; await goTo(row.id);
  const threads=THREADS_ON; THREADS_ON=true;
  document.dispatchEvent(new KeyboardEvent('keydown',{key:'c',bubbles:true}));
  if(!S.placing) return 'pin placement did not start';
  const selected=S.s, opener=document.querySelector('#shortcuts-open'); opener.focus(); opener.click();
  const dialog=document.querySelector('#shortcuts');
  if(!dialog.open || !dialog.contains(document.activeElement)) return 'modal focus';
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
  if(dialog.open || S.s!==selected || !S.placing || document.activeElement!==opener) return 'modal close';
  THREADS_ON=threads; S.placing=false; document.body.classList.remove('placing');
  // The page's own files may come from the local check server.
  return !performance.getEntriesByType('resource').some(e=>/^https?:/.test(e.name)&&!e.name.startsWith(location.origin+'/'));`],
  ["chrome status zoom is normalized against SVG camera scale", "p=1&v=board", `
  setT({x:100,y:100,z:8}); updateStatus();
  return document.querySelector('#statusbar [data-zoom]').textContent === '200%'
    || 'zoom should be S.z / PX as a percentage, got '+document.querySelector('#statusbar [data-zoom]').textContent;`],
  ["chrome overlay docks use opaque themed surfaces", "p=1&v=board", `
  const nav=getComputedStyle(document.querySelector('#nav')).backgroundColor;
  const panel=getComputedStyle(document.querySelector('#panel')).backgroundColor;
  return nav === panel && panel !== 'rgba(0, 0, 0, 0)' || 'dock surfaces: '+nav+' / '+panel;`],
  ["chrome desktop density matches the CAD shell contract", "p=1&v=board", `
  const height=selector=>document.querySelector(selector).getBoundingClientRect().height;
  const header=height('.report-head');
  return header===36 && height('#toolbar')===34
    && height('#statusbar')===24 && height('.account summary')===24
    && height('#modes [data-mode]')===24 && height('#panel-tabs [role=tab]')===28
    || 'chrome heights '+JSON.stringify({header,toolbar:height('#toolbar'),status:height('#statusbar')});`],
  ["board Thermal proof", "v=board", `
    const i=D.projects.findIndex(p=>p.name==='Thermal_Camera');
    if(i<0 || !D.projects[i].board?.geometry?.base || !D.projects[i].board?.geometry?.head)
      return 'skip';   // Thermal_Camera report with two geometry revisions only
    S.p=i; S.v='board'; S.s=null; renderNav(); renderPanel(); await draw(); fit();
    document.querySelectorAll('.thread time').forEach(e=>e.style.visibility='hidden');
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    return !!boardDiff && boardDiff.panes.length>0 && boardView.useGL;
  `],
  ["board Thermal vision proof", "v=board&m=semantic", `
    const i=D.projects.findIndex(p=>p.name==='Thermal_Camera');
    if(i<0 || !D.projects[i].board?.geometry?.base || !D.projects[i].board?.geometry?.head)
      return 'skip';   // Thermal_Camera report only
    await applyState({p:i,v:'board',m:'semantic',s:null});
    const rows=proj().changes.filter(c=>c.where?.board);
    if(!['added','removed','modified'].every(action=>rows.some(c=>c.action===action)))
      throw Error('Three-action Thermal_Camera fixture required for vision proof');
    const boxes=rows.flatMap(c=>['base','head'].map(side=>boardDiff.bounds(c.id,side))).filter(Boolean);
    const b=[Math.min(...boxes.map(b=>b[0])),Math.min(...boxes.map(b=>b[1])),Math.max(...boxes.map(b=>b[2])),Math.max(...boxes.map(b=>b[3]))];
    const vp=boardDiff.panes[0].vp;
    S.s=rows.find(c=>c.action==='modified').id;
    renderPanel(); setT({x:(b[0]+b[2])/2,y:(b[1]+b[3])/2,z:Math.min(vp.clientWidth/Math.max(10,b[2]-b[0]+6),vp.clientHeight/Math.max(10,b[3]-b[1]+6))});
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    for(const [action,glyph,dash,word] of [['added','+','solid','Added'],['removed','−','dashed','Removed'],['modified','~','dotted','Modified']]) {
      const labels=[...document.querySelectorAll('#stage .board-mark-label.'+action)];
      if(!labels.some(e=>e.dataset.glyph===glyph && e.dataset.dash===dash && getComputedStyle(e).borderTopStyle===dash && e.textContent===glyph+' '+word)) return 'missing action encoding '+action;
    }
    return !!document.querySelector('#panel [data-id="'+S.s+'"][aria-selected="true"]');
  `],
  ...['outline','recolour'].flatMap(style=>['side','overlay','wipe','blend','semantic'].map(mode=>[
    'board diff fps '+style+' '+mode, 'v=board', `
      if(!window.__CHECK_PERF) return 'skip';
      if(!proj().board?.geometry?.base || !proj().board?.geometry?.head) throw Error('Two geometry revisions required');
      await applyState({v:'board',m:'${mode}',s:null});
      Appearance.patch({markStyle:'${style}'}); fit(); boardDiff.render();
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      if(!boardView.useGL || !boardDiff?.panes.length) return 'WebGL compositor required';
      if(!['base','head'].every(side=>boardDiff.panes.some(p=>p.scenes[side]?.objects?.length))) return 'Two populated retained revisions required';
      const renderers=boardDiff.panes.map(p=>p.renderer), before=renderers.map(r=>({...r.stats}));
      const original={x:S.x,y:S.y,z:S.z}, counts={bufferData:0,bufferSubData:0,createTexture:0,createFramebuffer:0,createRenderbuffer:0,createBuffer:0,contexts:0};
      const proto=WebGL2RenderingContext.prototype, saved={};
      for(const name of Object.keys(counts).filter(n=>n!=='contexts')) {
        saved[name]=proto[name]; proto[name]=function(...args){counts[name]++;return saved[name].apply(this,args)};
      }
      const getContext=HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext=function(type,...args){if(type==='webgl2')counts.contexts++;return getContext.call(this,type,...args)};
      const intervals=[]; let last=0, frames=0;
      try {
        await new Promise(resolve=>{
          const start=performance.now();
          const tick=now=>{
            const elapsed=now-start;
            setT({x:original.x+Math.sin(elapsed/160)*2,y:original.y+Math.cos(elapsed/180)*2,z:original.z*(1+.12*Math.sin(elapsed/230))});
            if(elapsed>=1000){if(last)intervals.push(now-last);last=now;frames++;}
            if(elapsed<4100)requestAnimationFrame(tick);else resolve();
          };requestAnimationFrame(tick);
        });
        renderers.forEach(r=>r.gl.finish());
        const sorted=[...intervals].sort((a,b)=>a-b), fps=1000/(intervals.reduce((a,b)=>a+b,0)/intervals.length);
        const draws=renderers.map((r,i)=>r.stats.draws-before[i].draws), uploads=renderers.map((r,i)=>r.stats.uploads-before[i].uploads);
        const gl=renderers[0].gl, ext=gl.getExtension('WEBGL_debug_renderer_info');
        const evidence={project:proj().name,theme:KRTheme.get(),mode:'${mode}',style:'${style}',fps,median:sorted[Math.floor(sorted.length*.5)],p95:sorted[Math.floor(sorted.length*.95)],frames,duration:intervals.reduce((a,b)=>a+b,0),draws,uploads,counts,renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),glErrors:renderers.map(r=>r.gl.getError()),revisions:boardDiff.panes.map(p=>p.sides)};
        console.log('BOARD_FPS '+JSON.stringify(evidence));
        return fps>=50 && evidence.duration>=3000 && uploads.every(n=>n===0) && draws.every(n=>n>=frames) && Object.values(counts).every(n=>n===0) && evidence.glErrors.every(n=>n===0) || JSON.stringify(evidence);
      } finally {
        for(const [name,fn] of Object.entries(saved)) proto[name]=fn;
        HTMLCanvasElement.prototype.getContext=getContext;setT(original);
      }
    `])),
  ["review: concurrent drawing decodes share one gzip stream", "", `
    const id=Object.keys(D.blobs).find(k=>!(k in cache)); if(!id) return 'skip';
    const Real=window.DecompressionStream; let made=0;
    window.DecompressionStream=class extends Real { constructor(...a){ super(...a); made++; } };
    try { const [a,b]=await Promise.all([svgText(id),svgText(id)]); return a===b && made===1 || 'decoded '+made+' times'; }
    finally { window.DecompressionStream=Real; }`],
  ["review: overlay legend is built from text nodes", "v=board&m=overlay", `
    await draw(); await new Promise(r=>requestAnimationFrame(r));
    const label=[...document.querySelectorAll('#stage .vp > .tag')].find(e=>(e.textContent||'').includes('Base (red)'));
    if(!label) return 'skip';
    return label.querySelectorAll('i.sw').length===3 && label.textContent.includes('Head (green)') && label.textContent.includes('both (black)');`],
  ...['top','flipped','active In1.Cu'].map(view=>[
    'vf-order synthetic 4-layer '+view, 'v=board', `
      const panel=document.createElement('section');
      panel.style.cssText='position:fixed;inset:100px 350px auto;z-index:9999;padding:20px;background:var(--bg);color:var(--text)';
      const title=document.createElement('h2'); title.textContent='Synthetic 4-layer: ${view}';
      const caption=document.createElement('p'); caption.textContent='Left: F.Cu / In2.Cu. Right: B.Cu / In1.Cu. Centre: all copper. Opaque tracks.';
      const canvas=document.createElement('canvas'); canvas.style.cssText='width:800px;height:400px'; panel.append(title,caption,canvas);document.body.append(panel);
      // Deliberately scrambled file layer enums (KiCad 10 B.Cu=2, In1.Cu=4).
      const names=['In2.Cu','B.Cu','F.Cu','In1.Cu'];
      const ids={'F.Cu':0,'B.Cu':2,'In1.Cu':4,'In2.Cu':6};
      const track=(layer,x0,x1,y=5000)=>({uuid:layer+y,changeUuid:layer+y,kind:'track',layers:[layer],net:0,category:'tracks',side:null,hidden:false,
        box:[x0,y-1000,x1,y+1000],geometry:{segments:[[x0,y,x1,y,2000]]}});
      const scene={version:1,units:'um',complete:true,warnings:[],bounds:[0,0,20000,10000],
        layers:names.map(name=>({id:ids[name],name,type:'signal',enabled:true})),nets:[{id:0,name:''}],
        objects:[track('F.Cu',2000,12000),track('In2.Cu',2000,12000),track('B.Cu',8000,18000),track('In1.Cu',8000,18000)]};
      const r=BoardGL.create(canvas,{scene,manual:true});if(!r)throw Error('WebGL2 required');
      r.setCamera({x:10,y:5,z:40,width:800,height:400,dpr:1});
      const state={layers:Object.fromEntries(names.map(n=>[n,{visible:true,opacity:1}])),objects:{},nets:{},activeLayer:${JSON.stringify(view==='active In1.Cu'?'In1.Cu':null)},flip:${view==='flipped'}};
      const close=(a,b)=>a.slice(0,3).every((v,i)=>Math.abs(v-b[i])<=1);
      r.setAppearance(state);r.draw();
      const expected=${JSON.stringify(view==='flipped'?'B.Cu':view==='active In1.Cu'?'In1.Cu':'F.Cu')};
      const pixel=r.readPixel(400,200), color=KicadColors.layers[expected];
      if(!close(pixel,color))throw Error('centre expected '+expected+' '+color+' got '+pixel);
      const q=r.worldToScreen([${view==='flipped'?15:5},5]);
      const edge=r.readPixel(Math.floor(q[0]),399-Math.floor(q[1]));
      const edgeLayer=${JSON.stringify(view==='flipped'?'B.Cu':'F.Cu')};
      if(!close(edge,KicadColors.layers[edgeLayer]))throw Error('unpromoted overlap expected '+edgeLayer+' got '+edge);
      if(r.hitTest(r.worldToScreen([10,5]))[0]?.layers[0]!==expected)throw Error('picking disagrees with visible layer');
      r.draw();console.log('BOARD_PROOF '+JSON.stringify({task:'vf-order',view:${JSON.stringify(view)},expected,pixel:[...pixel],theme:KRTheme.get()}));return true;
    `]),
  ["vf-order technical layers", "v=board", `
    const canvas=document.createElement('canvas');canvas.style.cssText='width:200px;height:200px';document.body.append(canvas);
    const names=['F.Cu','F.SilkS'];
    const scene={version:1,units:'um',complete:true,warnings:[],bounds:[0,0,2000,2000],layers:names.map((name,id)=>({id,name,type:'signal',enabled:true})),nets:[{id:0,name:''}],
      objects:names.map(layer=>({kind:'track',uuid:layer,changeUuid:layer,layers:[layer],net:0,category:'tracks',side:null,hidden:false,box:[0,500,2000,1500],geometry:{segments:[[0,1000,2000,1000,1000]]}}))};
    const r=BoardGL.create(canvas,{scene,manual:true});if(!r)throw Error('WebGL2 required');
    try {r.setCamera({x:1,y:1,z:100,width:200,height:200,dpr:1});r.setAppearance({activeLayer:null});r.draw();
      const p=r.readPixel(100,100),expected=KicadColors.layers['F.SilkS'];
      if(!p.slice(0,3).every((v,i)=>Math.abs(v-expected[i])<=1))throw Error('expected front silkscreen above F.Cu, got '+p);return true;
    }finally{r.dispose();canvas.remove();}
  `],
  ["vf-order 2/4/6-layer stack pixels and active restoration", "v=board", `
    const canvas=document.createElement('canvas');canvas.style.cssText='width:200px;height:200px';document.body.append(canvas);
    const r=BoardGL.create(canvas,{manual:true});if(!r)throw Error('WebGL2 required');
    r.setCamera({x:1,y:1,z:100,width:200,height:200,dpr:1});
    let assertions=0;
    try {
      for(const count of [2,4,6]) for(const metadata of [false,true]) {
        const copper=['F.Cu',...Array.from({length:count-2},(_,i)=>'In'+(i+1)+'.Cu'),'B.Cu'];
        if(metadata && count>2) [copper[1],copper[2]]=[copper[2],copper[1]];
        const front=['F.Mask','F.SilkS','F.Paste','F.Adhes','F.CrtYd','F.Fab'], back=['B.Mask','B.SilkS','B.Paste','B.Adhes','B.CrtYd','B.Fab'];
        const names=['Dwgs.User','Edge.Cuts','User.1',...front,...copper,...back];
        const scene={version:1,units:'um',complete:true,warnings:[],bounds:[0,0,2000,2000],layers:[...names].reverse().map((name,id)=>({id,name,type:'signal',enabled:true})),nets:[{id:0,name:''}],
          objects:names.map(layer=>({kind:'track',uuid:layer,changeUuid:layer,layers:[layer],net:0,category:'tracks',side:null,hidden:false,box:[0,500,2000,1500],geometry:{segments:[[0,1000,2000,1000,1000]]}}))};
        if(metadata)scene.copperStack=copper;
        const saved=JSON.stringify(scene);r.setScene(scene);
        for(const flip of [false,true]) {
          const order=['Dwgs.User','Edge.Cuts','User.1',...(flip?[...front,...copper,...back].reverse():[...front,...copper,...back])];
          const layers=Object.fromEntries(names.map(n=>[n,{visible:true,color:[...KicadColors.layers[n].slice(0,3),1],opacity:1}]));
          const state={layers,activeLayer:null,flip,contrast:'normal'};
          const check=expected=>{
            r.setAppearance(state);r.draw();const pixel=r.readPixel(100,100),color=KicadColors.layers[expected];assertions++;
            if(!pixel.slice(0,3).every((v,i)=>Math.abs(v-color[i])<=1))throw Error(count+' layers metadata='+metadata+' flip='+flip+' expected '+expected+' got '+pixel);
            if(r.hitTest(r.worldToScreen([1,1]))[0]?.layers[0]!==expected)throw Error('visible/pick order mismatch '+expected);
          };
          // Peel top layers off; every remaining layer must retain its order.
          for(const expected of order) {
            check(expected);
            for(const active of copper.filter(n=>layers[n].visible)) {state.activeLayer=active;check(active);}
            state.activeLayer=null;check(expected);layers[expected].visible=false;
          }
        }
        if(JSON.stringify(scene)!==saved)throw Error('rendering mutated physical stack');
      }
      console.log('BOARD_PROOF '+JSON.stringify({task:'vf-order',pixelAssertions:assertions,stacks:[2,4,6],themes:KRTheme.get()}));return true;
    }finally{r.dispose();canvas.remove();}
  `],
  ["vf-order Appearance active-layer pixel integration", "v=board", `
    const names=['F.Cu','In1.Cu','In2.Cu','B.Cu'];
    const scene={version:1,units:'um',complete:true,warnings:[],bounds:[0,0,20000,10000],copperStack:names,
      layers:names.map((name,id)=>({id,name,type:'signal',enabled:true})),nets:[{id:0,name:''}],
      objects:names.map(layer=>({kind:'track',uuid:layer,changeUuid:layer,layers:[layer],net:0,category:'tracks',side:null,hidden:false,box:[2000,4000,18000,6000],geometry:{segments:[[2000,5000,18000,5000,2000]]}}))};
    const bytes=new Uint8Array(await new Response(new Blob([JSON.stringify(scene)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    D.blobs.vforder=btoa(String.fromCharCode(...bytes));proj().board.geometry={base:'vforder',head:'vforder'};
    boardView.failed=null;Appearance.reset();Object.assign(S,{v:'board',m:'side',t:'appearance',x:10,y:5,z:30});renderPanel();await draw();
    const uploads=boardView.renderers.map(r=>r.stats.uploads).join(),saved=JSON.stringify(scene);
    const check=expected=>{
      for(const r of boardView.renderers){r.draw();const q=r.worldToScreen([10,5]),p=r.readPixel(Math.floor(q[0]*devicePixelRatio),r.gl.canvas.height-1-Math.floor(q[1]*devicePixelRatio));
        if(!p.slice(0,3).every((v,i)=>Math.abs(v-KicadColors.layers[expected][i])<=1))throw Error('Appearance expected '+expected+' got '+p);}
    };
    check('F.Cu');
    for(const active of ['In1.Cu','In2.Cu','B.Cu','F.Cu']){
      const button=document.querySelector('#appearance-root [data-layer="'+active+'"] .name');if(!button)throw Error('missing Layers tab button '+active);button.click();
      if(Appearance.get().activeLayer!==active)throw Error('active layer did not change');check(active);
    }
    Appearance.patch({activeLayer:null,flip:true});check('B.Cu');
    Appearance.patch({activeLayer:'In1.Cu'});check('In1.Cu');
    Appearance.patch({activeLayer:null,flip:false});check('F.Cu');
    return boardView.renderers.length===2 && uploads===boardView.renderers.map(r=>r.stats.uploads).join() && JSON.stringify(scene)===saved;
  `],
  ['bench-t7 status and menus', 'v=board', `return (async()=>{
    select('board'); await draw();
    const vp=document.querySelector('#stage .vp'),r=vp.getBoundingClientRect();
    updateCoordinates(vp,{clientX:r.left+r.width/2,clientY:r.top+r.height/2});
    const x=document.querySelector('[data-coordinate=x]');
    if(!Number.isFinite(Number(x.textContent)))throw Error('missing coordinate');
    let writes=0;const observer=new MutationObserver(ms=>writes+=ms.length);observer.observe(document.querySelector('#statusbar'),{childList:true,subtree:true});
    updateStatus();updateStatus();await Promise.resolve();observer.disconnect();if(writes)throw Error('unchanged readouts rewritten');
    const before=x.textContent;resetCoordinates();if(x.textContent!==before||!x.closest('.off-canvas'))throw Error('last coordinate lost');
    const units=document.querySelector('#status-units');units.value='mil';units.dispatchEvent(new Event('change'));if(Appearance.get().units!=='mil')throw Error('units menu disconnected');
    canvasMenu(vp,{clientX:r.left+50,clientY:r.top+50});
    if(document.querySelectorAll('.bench-context [role=menuitem]').length!==6)throw Error('missing canvas actions');
    if(document.activeElement.textContent!=='Zoom to here')throw Error('menu not focused');
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));if(document.activeElement.textContent!=='Copy coordinates')throw Error('menu arrow navigation');
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));if(document.querySelector('.bench-context')||document.activeElement!==vp)throw Error('menu escape focus');
    if(!Appearance.get().layers[Appearance.get().activeLayer]) Appearance.patch({activeLayer:Object.keys(Appearance.get().layers)[0]});
    const snapshot=Appearance.get(),layer=snapshot.activeLayer;
    canvasMenu(vp,{clientX:r.left+50,clientY:r.top+50});document.querySelectorAll('.bench-context button')[4].click();if(Appearance.get().layers[layer].visible)throw Error('hide layer action');
    canvasMenu(vp,{clientX:r.left+50,clientY:r.top+50});document.querySelectorAll('.bench-context button')[5].click();if(Object.entries(Appearance.get().layers).some(([name,state])=>state.visible!==(name===layer)))throw Error('solo layer action');Appearance.patch(snapshot);
    const row=document.querySelector('#panel .card[data-id]')||document.querySelector('#nav [data-view]');row.focus();row.dispatchEvent(new KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true}));
    if(!document.querySelector('.bench-context'))throw Error('keyboard row menu missing');closeBenchMenu();
    showShortcuts();if(document.querySelectorAll('#shortcuts section').length!==3)throw Error('help groups missing');document.querySelector('#shortcuts [data-close]').click();
    const btn=document.querySelector('#shortcuts-open');btn.blur();btn.focus();btn.dispatchEvent(new FocusEvent('focusin',{bubbles:true}));await new Promise(r=>setTimeout(r,500));if(document.querySelector('#bench-tooltip').hidden)throw Error('tooltip missing '+btn.outerHTML+' active '+document.activeElement.outerHTML);btn.blur();
    Appearance.patch({units:'mm'});resetCoordinates();return true;
  })()`],
  ['bench-t7 proof 1440', 'v=board', `return (async()=>{select('board');await draw();resetCoordinates();return document.querySelector('#statusbar').scrollWidth<=innerWidth;})()`],
  ['bench-t7 proof 1920', 'v=board', `return (async()=>{select('board');await draw();resetCoordinates();return document.querySelector('#statusbar').scrollWidth<=innerWidth;})()`],
  ['bench-t7 help proof', 'v=board', `showShortcuts();return true;`],
  ['bench-t7 context proof', 'v=board', `const vp=document.querySelector('#stage .vp'),r=vp.getBoundingClientRect();canvasMenu(vp,{clientX:r.left+100,clientY:r.top+160});return true;`],
  // bench-t6
  ["bench-t6 inspector selection and complete diffs", "p=1&v=board", `
    const row=proj().changes.find(r=>r.where?.board); if(!row) throw Error('missing board row');
    row.props={...row.props,customField:'<script>unsafe</script>',net:'GND'};
    row.changes=[...(row.changes||[]),['Value','old-value','new-value']];
    const tabs=document.querySelector('#panel-tabs'), panel=document.querySelector('#panel-body');
    await goTo(row.id);
    const text=document.querySelector('#inspector').textContent;
    if(!text.includes('old-value')||!text.includes('new-value')||!text.includes('<script>unsafe</script>'))return text;
    if(!document.querySelector('#inspector del')||document.querySelector('#inspector script'))return 'diff/escaping';
    if(document.querySelector('#panel-tabs')!==tabs||document.querySelector('#panel-body')!==panel)return 'right dock rebuilt';
    if(document.querySelectorAll('.insp-module').length!==4)return 'modules';
    const finding=allViolations()[0]; if(finding){await goTo(finding.id);if(!document.querySelector('#inspector').textContent.includes(finding.description))return 'finding missing';}
    S.s=null;S.io=null;S.ig=null;renderInspector();
    return document.querySelector('.insp-empty')!==null;
  `],
  ["bench-t6 inspector inventory fields and splitter persistence", "p=1&v=board", `
    proj().objects=[...(proj().objects||[]),{kind:'footprint',ref:'INSPECT_TEST',uuid:'inspector-test',pos:[10,20,90],value:'4.7k',footprint:'R_0402',customFlag:false}];
    proj().parts={...(proj().parts||{}),lines:[{refs:['INSPECT_TEST'],mpn:'TEST-MPN',dnp:false}]};
    const panel=document.querySelector('#panel-body');
    await goToObject(proj().objects.length-1);
    const text=document.querySelector('#inspector').textContent;
    if(!text.includes('TEST-MPN')||!text.includes('customFlag')||!text.includes('false')||!text.includes('90'))return text;
    if(document.querySelector('#panel-body')!==panel)return 'inventory rebuilt right dock';
    const split=document.querySelector('#insp-split'),before=inspectorHeight;
    split.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}));
    if(inspectorHeight!==before+16)return 'resize';
    document.querySelector('#insp-toggle').click();
    if(!document.querySelector('#insp-body').hidden||!JSON.parse(localStorage.getItem('kr.inspector')).closed)return 'collapse persistence';
    document.querySelector('#insp-toggle').click();
    return !document.querySelector('#insp-body').hidden && !JSON.parse(localStorage.getItem('kr.inspector')).closed;
  `],
  ["bench-t6 inspector proof", "p=0&v=board&s=c1", `
    if(innerWidth===1440){document.documentElement.style.height='900px';document.body.style.height='900px';}
    inspectorClosed=false;inspectorHeight=176;inspectorLayout();
    await goTo(proj().changes.find(r=>r.where?.board)?.id);
    return document.querySelector('#inspector').getBoundingClientRect().height===176 && document.documentElement.scrollWidth<=innerWidth;
  `],
  ["bench-t6 inspector persists after reload", "v=board", `
    inspectorHeight=224;inspectorClosed=true;inspectorLayout();persistInspector();renderInspector();
    return document.querySelector('#insp-body').hidden;
  `, {afterReload:`return inspectorHeight===224 && inspectorClosed && document.querySelector('#insp-body').hidden;`}],
  ["bench-t6 inspector source snapshots and geometry", "p=1&v=board", `
    const row=proj().changes.find(r=>r.where?.board);if(!row)return 'fixture';
    row.before={fields:{MPN:'base-part'},dnp:true};row.after={fields:{MPN:'head-part'},dnp:false};
    await goTo(row.id);
    let data=inspectorProperties();
    if(data.base['fields.MPN']!=='base-part'||data.head['fields.MPN']!=='head-part'||data.head.dnp!==false)return 'snapshots';
    S.s=null;S.io=null;S.ig={side:'head',object:{uuid:'leaf-test',kind:'track',layers:['F.Cu'],net:7,geometry:{segments:[[1000,2000,3000,4000]]},hidden:false}};
    const panel=document.querySelector('#panel-body');renderInspector();
    const text=document.querySelector('#inspector').textContent;
    if(!text.includes('leaf-test')||!text.includes('segments')||!text.includes('false'))return text;
    return document.querySelector('#panel-body')===panel;
  `],
  ["bench toolbar groups fit without cut-off", "p=1&v=board", `
  const t=document.querySelector('#toolbar');
  const caps=[...t.querySelectorAll(':scope > .tb-grp > .cap')].map(e=>e.textContent).join('|');
  if(caps!=='View|Change|Zoom|Marks') return 'groups '+caps;
  if(t.querySelector('[data-theme-toggle], [data-act=copy], .goto')) return 'moved controls still in toolbar';
  if(t.querySelectorAll('.tb-grp').length<5 || t.querySelectorAll('svg.i use').length<14) return 'icons';
  if(![...t.querySelectorAll('button')].every(b=>b.title||b.getAttribute('aria-label'))) return 'tooltips';
  if(innerWidth>=1400 && t.scrollWidth>t.clientWidth) return 'overflow '+t.scrollWidth+'>'+t.clientWidth;
  const r=t.getBoundingClientRect(); if([...t.querySelectorAll('button')].some(b=>b.getBoundingClientRect().right>r.right+1)) return 'cut off';
  for(const mode of ['side','overlay','wipe','blend','semantic']) {
    t.querySelector('[data-mode='+mode+']').click();
    if(innerWidth>=1400 && t.scrollWidth>t.clientWidth) return mode+' overflow '+t.scrollWidth+'>'+t.clientWidth;
  }
  t.querySelector('[data-mode=side]').click(); fit();
  const d=t.querySelector('[data-dock=nav]'); d.click(); const off=document.querySelector('#nav').classList.contains('left-collapsed'); d.click();
  return (innerWidth<900 || off && !document.querySelector('#nav').classList.contains('left-collapsed')) || 'dock toggle';`],
  ["bench toolbar 3D camera presets fit all modes", "v=3d", `
    if (!window.Review3D) return 'skip';
    const t=document.querySelector('#toolbar'), started=performance.now();
    const trace=phase=>{if(window.__CHECK_PERF)console.log('BOARD_PROOF toolbar '+phase+' '+(performance.now()-started).toFixed(1)+'ms firstFrame='+!!Review3D.state?.firstFrame);};
    trace('start');
    for(const mode of ['side','overlay','blend','semantic']) {
      S.m=mode;renderModes();renderZoombar();
      trace(mode);
      if(innerWidth>=1400 && t.scrollWidth>t.clientWidth) return mode+' overflow '+t.scrollWidth+'>'+t.clientWidth;
    }
    const menu=t.querySelector('.camera-presets'); menu.open=true;
    await new Promise(r=>setTimeout(r,50));
    const popup=menu.querySelector('.camera-menu').getBoundingClientRect();
    if(popup.top<t.getBoundingClientRect().bottom || popup.right>innerWidth) return 'clipped camera menu';
    trace('before-camera');menu.querySelector('[data-3d-camera=top]').click();trace('after-camera');
    return !menu.open && document.activeElement===menu.querySelector('summary');`],
  ["bench-t2 single offline chrome and framed suppression", "#v=board", `
    const visible = selector => [...document.querySelectorAll(selector)].filter(n => n.getBoundingClientRect().height > 0);
    if (visible('.report-head').length !== 1 || visible('#report-review-bar').length !== 1) throw Error('duplicate or missing chrome');
    if (document.querySelector('[data-theme-toggle]')) throw Error('duplicate Theme toggle');
    if (document.querySelectorAll('[data-theme-set]').length !== 3) throw Error('missing theme choices');
    if (document.querySelector('#zoombar [data-act=copy], #zoombar .goto')) throw Error('overflow controls still in toolbar');
    document.documentElement.dataset.benchCheckTheme = KRTheme.get();
    const menu = document.querySelector('.account'); menu.open = true;
    const target = document.querySelector('[data-theme-set=light]'), box = target.getBoundingClientRect();
    if (document.elementFromPoint(box.left+box.width/2,box.top+box.height/2) !== target) throw Error('theme menu clipped or covered');
    document.querySelector('[data-theme-set=light]').click();
    if (KRTheme.get() !== 'light') throw Error('light choice failed');
    document.querySelector('[data-theme-set=system]').click();
    if (KRTheme.mode() !== 'system') throw Error('system choice failed');
    document.querySelector('[data-theme-set=dark]').click();
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));
    if (menu.open) throw Error('Escape did not close menu');
    KRTheme.set(document.documentElement.dataset.benchCheckTheme || 'dark');
    if (document.documentElement.scrollWidth > innerWidth) throw Error('horizontal overflow');
    const frame = document.createElement('iframe'); frame.setAttribute('sandbox','allow-scripts');
    const result = new Promise((resolve,reject) => {
      const timer = setTimeout(()=>reject(Error('framed chrome check timed out')),15000);
      const receive = event => { if(event.source !== frame.contentWindow || !event.data?.benchChrome) return;
        clearTimeout(timer); removeEventListener('message',receive); resolve(event.data.benchChrome); };
      addEventListener('message',receive);
    });
    if(document.querySelector('link[rel=stylesheet][href="review.css"]')) return 'skip';   // the framed copy needs the single-file report (CI runs it with --page)
    frame.srcdoc = document.documentElement.outerHTML + '<script>addEventListener("load",()=>parent.postMessage({benchChrome:[getComputedStyle(document.querySelector(".report-chrome")).display,getComputedStyle(document.querySelector("#toolbar")).display]},"*"))<\/script>';
    frame.style.cssText='position:fixed;width:800px;height:600px;left:-2000px'; document.body.append(frame);
    const rows = await result; frame.remove();
    if(rows[0] !== 'none' || rows[1] === 'none') throw Error('framed report duplicated chrome or hid toolbar '+rows);
    return true;
  `],
  ["bench-t5 right dock resize collapse wide and table", "t=checks", `
    const panel=document.getElementById('panel'), app=document.getElementById('app'), splitter=document.getElementById('right-splitter');
    splitter.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}));
    if (panel.getBoundingClientRect().width !== 700 || localStorage.getItem('kr.rightDockWidth') !== '700') return 'resize persistence';
    document.querySelector('[data-panel-wide]').click();
    if (panel.getBoundingClientRect().width !== 360) return 'restore narrow';
    document.querySelector('[data-panel-table]').click();
    if (!app.classList.contains('right-table') || panel.getBoundingClientRect().right > innerWidth || panel.getBoundingClientRect().width < innerWidth / 2) return 'table geometry';
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    if (app.classList.contains('right-table') || document.activeElement !== document.querySelector('[data-panel-table]')) return 'escape';
    document.querySelector('[data-panel-close]').click();
    if (!app.classList.contains('right-collapsed') || panel.getBoundingClientRect().width) return 'collapse';
    document.querySelector('[data-dock=panel]').click();
    return !app.classList.contains('right-collapsed') && panel.getBoundingClientRect().width === 360;
  `],
  ["bench-t5 compact references tags and narrow columns", "", `
    const p=proj(); p.parts={lines:[{refs:['C1','C2','C3','C4','C5','C20'],value:'100nF',mpn:'',lcsc:'',problems:['missing_lcsc','missing_mpn']}],changes:[],supplier:null};
    S.t='parts'; resizeRightDock(360); renderPanel();
    const row=document.querySelector('.parts-row'), refs=row.querySelector('.parts-refs');
    if(refs.textContent!=='C1–C5, C20' || refs.title!=='C1, C2, C3, C4, C5, C20') return 'ranges';
    const tags=[...row.querySelectorAll('.problem-tag')];
    if(tags.map(t=>t.textContent).join()!=='LCSC,MPN' || tags.some(t=>!t.title)) return 'tags';
    if(row.offsetHeight>35 || getComputedStyle(row.children[4]).display!=='none') return 'narrow';
    document.querySelector('[data-panel-wide]').click();
    if(getComputedStyle(document.querySelector('.parts-row').children[4]).display==='none') return 'wide columns';
    document.querySelector('[data-panel-table]').click();
    document.querySelector('[data-panel-table]').click();
    if(document.getElementById('app').classList.contains('right-table')) return 'close table';
    document.querySelector('[data-panel-close]').click();
    const stage=document.getElementById('stage').getBoundingClientRect();
    return stage.right===innerWidth && document.documentElement.scrollWidth===innerWidth;
  `],
  ["bench-t5 changes and checks search sort group", "p=1&t=checks", `
    const search=document.querySelector('[data-list-search=checks]');search.value='no-such-finding-123';search.dispatchEvent(new Event('input'));
    if(document.querySelectorAll('.viol').length) return 'checks search';
    document.querySelector('[data-list-search=checks]').value='';document.querySelector('[data-list-search=checks]').dispatchEvent(new Event('input'));
    const group=document.querySelector('[data-list-group=checks]'); group.value='severity'; group.dispatchEvent(new Event('change'));
    if(S.checks.group!=='severity') return 'checks grouping';
    S.t='changes';renderPanel();
    const sort=document.querySelector('[data-list-sort=changes]');sort.value='reference';sort.dispatchEvent(new Event('change'));
    const cg=document.querySelector('[data-list-group=changes]');cg.value='kind';cg.dispatchEvent(new Event('change'));
    const q=document.querySelector('[data-list-search=changes]');q.value='no-such-change-123';q.dispatchEvent(new Event('input'));
    return S.filter.sort==='reference' && S.filter.group==='kind' && !document.querySelectorAll('.card').length;
  `],
  ["bench-t5 proof parts wide", "v=board&m=overlay&t=parts", `
    if(!proj().parts) return 'skip';
    resizeRightDock(700); renderPanel(); fit();
    return document.querySelector('.parts-table') && document.documentElement.scrollWidth===innerWidth;
  `],
  ["bench-t5 proof checks", "v=board&m=overlay&t=checks", `
    resizeRightDock(360);renderPanel(); fit();
    return document.documentElement.scrollWidth===innerWidth;
  `],

  ["bench-t5 persisted dock width survives reload", "", `
    resizeRightDock(480); return localStorage.getItem('kr.rightDockWidth')==='480';
  `, {afterReload:`return document.getElementById('panel').getBoundingClientRect().width===480 && document.getElementById('right-splitter').getAttribute('aria-valuenow')==='480';`}],

  ["bench-t5 full checks table retains findings", "p=1&t=checks", `
    const count=document.querySelectorAll('.viol').length;
    document.querySelector('[data-panel-table]').click();
    if(!document.querySelector('.checks-table') || document.querySelectorAll('.checks-table tbody tr').length!==count || document.querySelectorAll('.checks-table .viol').length!==count) return 'table rows';
    document.querySelector('[data-panel-table]').click();
    return !document.querySelector('.checks-table') && document.querySelectorAll('.viol').length===count;
  `],
  ["bench-t5 proof parts narrow", "v=board&m=overlay&t=parts", `
    if(!proj().parts) return 'skip'; resizeRightDock(360);renderPanel(); fit();
    return document.querySelector('.parts-table').getBoundingClientRect().right<=innerWidth;
  `],
  ["bench-t5 table-view proof checks", "v=board&m=overlay&t=checks", `
    resizeRightDock(360);renderPanel();document.querySelector('[data-panel-table]').click();
    return !!document.querySelector('.checks-table');
  `],

  // bench-t4: left module regression checks (append-only).
  ["bench-t4 Project tree wraps names and searches sorts filters", "", `
    const p=proj(), original=p.sheets.find(s=>s.svg); if(!original)return 'skip';
    p.sheets=[{...original,path:'/',parent:null,name:'Root_project.kicad_sch',page:'1',status:'modified'},
      {...original,path:'/z/',parent:'/',name:'Z_child_long_schematic_name.kicad_sch',page:'2',status:'added'},
      {...original,path:'/a/',parent:'/',name:'A_child.kicad_sch',page:'3',status:'unchanged'}];
    S.t='changes'; leftTab='project'; renderNav();
    const q=s=>document.querySelector(s), fire=e=>e.dispatchEvent(new Event('change',{bubbles:true}));
    const name=q('#nav [data-view="sheet:/z/"] .name');
    if(name.title!=='Z_child_long_schematic_name.kicad_sch (page 2)' || getComputedStyle(name).whiteSpace!=='normal')return 'full name';
    if(!q('#nav [data-view="sheet:/z/"]').style.getPropertyValue('--depth'))return 'hierarchy';
    if(q('#nav .chip.modified').textContent.trim()[0]!=='~' || getComputedStyle(q('#nav .chip.removed')).borderTopStyle!=='dashed' || getComputedStyle(q('#nav .chip.modified')).borderRadius==='0px')return 'shape glyph';
    q('#project-sort').value='name';fire(q('#project-sort'));
    if([...document.querySelectorAll('#nav [data-view^="sheet:"]')].map(b=>b.dataset.view).join()!=='sheet:/,sheet:/a/,sheet:/z/')return 'sort';
    q('#project-filter').value='added';fire(q('#project-filter'));
    if(q('#nav [data-view="sheet:/a/"]') || !q('#nav [data-view="sheet:/z/"]'))return 'filter';
    q('#project-search').value='no such sheet';q('#project-search').dispatchEvent(new Event('input',{bubbles:true}));
    if(q('#nav [data-view^="sheet:"]') || document.activeElement.id!=='project-search')return 'search focus';
    return true;
  `],
  ["bench-t4 Appearance belongs left and leaves review tabs available", "v=board&t=appearance", `
    const q=s=>document.querySelector(s);
    if(!q('#nav #appearance-root') || q('#panel #appearance-root') || q('#panel [data-tab="appearance"]'))return 'location';
    if(q('#left-tab-appearance').getAttribute('aria-selected')!=='true' || q('#nav').classList.contains('left-collapsed'))return 'deep link';
    if(!q('#appearance-root .appearance-group'))return 'groups';
    q('#panel [data-tab="checks"]').click();
    if(!q('#nav #appearance-root') || q('#panel [data-tab="checks"]').getAttribute('aria-selected')!=='true')return 'independent tabs';
    q('#left-tab-project').click(); await new Promise(r=>setTimeout(r,250));
    if(q('#appearance-root') || !q('#project-search') || !location.hash.includes('t=checks'))return 'project switch';
    q('#left-tab-appearance').click(); await new Promise(r=>setTimeout(r,250));
    if(!q('#nav #appearance-root') || !location.hash.includes('t=appearance'))return 'appearance link';
    return !q('#nav').scrollWidth || q('#nav').scrollWidth<=q('#nav').clientWidth+1;
  `],
  ["bench-t4 left splitter collapse storage and keyboard", "", `
    const q=s=>document.querySelector(s); setDock('nav',true);
    const grip=q('#nav [role=separator]'), key=k=>grip.dispatchEvent(new KeyboardEvent('keydown',{key:k,bubbles:true,cancelable:true}));
    key('End');if(grip.getAttribute('aria-valuenow')!=='520')return 'max';
    key('Home');key('ArrowRight');
    if(JSON.parse(localStorage.getItem('kr.bench.left')).width!==230 || q('#nav').getBoundingClientRect().width!==230)return 'width persistence';
    const get=Storage.prototype.getItem,set=Storage.prototype.setItem;
    try { Storage.prototype.getItem=()=>{throw Error('blocked')}; Storage.prototype.setItem=()=>{throw Error('blocked')}; key('ArrowRight');q('#nav .left-collapse').click(); }
    finally {Storage.prototype.getItem=get;Storage.prototype.setItem=set;}
    if(!q('#nav').classList.contains('left-collapsed') || q('[data-dock="nav"]').getAttribute('aria-expanded')!=='false')return 'collapse';
    q('[data-dock="nav"]').click();
    if(q('#nav').getBoundingClientRect().width!==240 || q('[data-dock="nav"]').getAttribute('aria-expanded')!=='true')return 'restore';
    return document.documentElement.scrollWidth<=innerWidth;
  `],
  ["bench-t4 Project screenshot proof", "v=board&m=overlay", `
    setDock('nav',true); leftWidth=262; syncLeftDock();
    document.querySelector('#left-tab-project').click();
    await new Promise(r=>setTimeout(r,400));
    return document.querySelector('#nav').getBoundingClientRect().width===262 && document.documentElement.scrollWidth<=innerWidth;
  `],
  ["bench-t4 Appearance screenshot proof", "v=board&m=overlay&t=appearance", `
    setDock('nav',true); leftWidth=262; syncLeftDock();
    return !!document.querySelector('#nav #appearance-root') && document.documentElement.scrollWidth<=innerWidth;
  `],
  ["bench-t4 saved left dock restores on startup", "", `
    const toggle=document.querySelector('[data-dock="nav"]');
    if(!leftCollapsed || leftWidth!==337 || getComputedStyle(document.querySelector('#nav')).display!=='none')return 'stored state';
    toggle.click();
    return document.querySelector('#nav').getBoundingClientRect().width===337;
  `, {beforeStartup:`try {localStorage.setItem('kr.bench.left',JSON.stringify({width:337,collapsed:true}));} catch {}`}],
  ["bench-t4 blocked storage permits startup and deep link", "v=board&t=appearance", `
    return !!document.querySelector('#nav #appearance-root') && leftWidth===262 && !leftCollapsed;
  `, {beforeStartup:`Storage.prototype.getItem=Storage.prototype.setItem=()=>{throw new DOMException('Blocked','SecurityError')};`}],
  ["vf-opacity synthetic layer union UI persistence and marks", "v=board&t=appearance", `
    const names=['F.Cu','In1.Cu','In2.Cu','B.Cu'];
    const track=(id,layer,x0,x1,width=2000)=>({kind:'track',uuid:id,changeUuid:id,changeIds:layer==='In2.Cu'?['opacity-change']:[],layers:[layer],net:0,category:'tracks',side:null,hidden:false,
      box:[x0,5000-width/2,x1,5000+width/2],geometry:{segments:[[x0,5000,x1,5000,width]]}});
    const scene={version:1,units:'um',complete:true,warnings:[],bounds:[0,0,20000,10000],copperStack:names,
      layers:names.map((name,id)=>({id,name,type:'signal',enabled:true})),nets:[{id:0,name:''}],
      objects:[track('back','B.Cu',1000,19000,4000),track('inner','In1.Cu',1000,19000,4000),track('single','In2.Cu',2000,14000),track('overlap','In2.Cu',10000,18000)]};
    cache.vfopacity=JSON.stringify(scene);proj().board.geometry={base:'vfopacity',head:'vfopacity'};
    boardView.failed=null;Appearance.reset();Object.assign(S,{v:'board',m:'side',t:'appearance',x:10,y:5,z:40});renderPanel();await draw();
    Appearance.patch({activeLayer:'In2.Cu'});
    const row=document.querySelector('#appearance-root [data-layer="In2.Cu"]');if(!row)throw Error('missing In2.Cu row');
    const color=row.querySelector('input[type=color]'),slider=row.querySelector('input[type=range]');
    color.value='#ff69b4';color.dispatchEvent(new Event('input'));slider.value='50';slider.dispatchEvent(new Event('input'));
    const pixel=(r,x,y=5)=>{r.draw();const q=r.worldToScreen([x,y]);return r.readPixel(Math.floor(q[0]*devicePixelRatio),r.gl.canvas.height-1-Math.floor(q[1]*devicePixelRatio));};
    const close=(a,b)=>a.slice(0,3).every((v,i)=>Math.abs(v-b[i])<=2);
    const expected=[255,105,180].map((v,i)=>(v+KicadColors.layers['In1.Cu'][i])/2);
    const evidence=[];
    for(const r of boardView.renderers){const single=pixel(r,6),overlap=pixel(r,12);evidence.push({single,overlap,expected});
      if(!close(single,expected))throw Error('pink must blend with In1.Cu: '+JSON.stringify(evidence));
      if(!close(single,overlap))throw Error('per-layer opacity double darkens overlap: '+JSON.stringify(evidence));}
    // The layer pass must span batches and stencil fills, not just coincident capsules.
    for(const kind of ['pad','graphic'])for(const r of boardView.renderers){
      const variant=structuredClone(scene);
      for(const o of variant.objects.filter(o=>o.layers[0]==='In2.Cu')){
        const [x0,y0,x1,y1]=o.box;o.kind=kind;o.category=kind==='pad'?'pads':'filledShapes';
        o.geometry=kind==='pad'?{primitive:{shape:'rect',center:[(x0+x1)/2,5000],size:[x1-x0,2000],angle:0}}:
          {rings:[[[x0,y0],[x1,y0],[x1,y1],[x0,y1]]]};
      }
      r.setScene(variant);const single=pixel(r,6),overlap=pixel(r,12);
      if(!close(single,expected)||!close(single,overlap))throw Error(kind+' union '+single+' / '+overlap);
      if(r.gl.getError()!==r.gl.NO_ERROR)throw Error(kind+' layer-pass GL error');
      r.setScene(scene);
    }
    if(Appearance.get().layerOpacity['In2.Cu']!==.5)throw Error('Layers slider must edit canonical layerOpacity');
    if(slider.getAttribute('aria-label')!=='In2.Cu opacity')throw Error('opacity slider accessible name');
    for(const name of names){const r=document.querySelector('#appearance-root [data-layer="'+name+'"]');if(!r?.querySelector('input[type=color]')||!r?.querySelector('input[type=range]'))throw Error('missing layer controls '+name);}
    for(const r of document.querySelectorAll('#appearance-root [data-layer]')){const a=r.querySelector('input[type=range]');if(!a||a.min!=='0'||a.max!=='100'||getComputedStyle(a).opacity!=='1')throw Error('layer opacity slider must be visible, 0–100%: '+r.dataset.layer);}
    // Mount real marks compositor on the same synthetic board, independent of report changes.
    const host=document.createElement('div');host.style.cssText='display:flex;position:fixed;inset:180px 400px 180px 100px;z-index:999;background:var(--bg)';document.body.append(host);
    const state={...S,m:'side',x:10,y:5,z:40,s:null};
    const c=BoardDiff.mount({stage:host,scenes:{base:scene,head:scene},changes:[{id:'opacity-change',action:'modified'}],state,appearance:glAppearance});
    for(const opacity of [0,1])for(const style of ['outline','recolour']){
      Appearance.patch({layerOpacity:{'In2.Cu':opacity},markStyle:style});c.render();
      if(!host.querySelector('.board-mark-label.modified'))throw Error('changed object mark missing at '+opacity+' '+style);
      const pane=c.panes[0],edge=pane.renderer.worldToScreen([6,3.975]),mark=c.readPixel(0,...edge);
      if(close(mark,KicadColors.layers['In1.Cu'])||close(mark,[255,105,180]))throw Error('GPU mark halo missing at '+opacity+' '+style+': '+mark);
      const p=c.panes[0];p.renderer.setScene(scene,'head');p.renderer.setAppearance(glAppearance());p.renderer.draw({mask:true,marks:true,filter:o=>o.changeIds.includes('opacity-change')});
      const q=p.renderer.worldToScreen([6,5]),rgba=p.renderer.readPixel(Math.floor(q[0]*devicePixelRatio),p.canvas.height-1-Math.floor(q[1]*devicePixelRatio));
      if(rgba[0]<250)throw Error('mark mask faded at '+opacity+' '+style+': '+rgba);
    }
    c.dispose();host.remove();
    document.querySelector('[data-appearance-reset]').click();
    if(Appearance.get().layers['In2.Cu'].opacity!==1||!close(Appearance.get().layers['In2.Cu'].color,KicadColors.layers['In2.Cu']))throw Error('reset did not restore KiCad defaults');
    color.value='#ff69b4';color.dispatchEvent(new Event('input'));slider.value='50';slider.dispatchEvent(new Event('input'));
    Appearance.patch({activeLayer:'In2.Cu'});
    sessionStorage.setItem('vf-opacity-viewer',JSON.stringify(Appearance.get()));boardDiff.render();
    console.log('BOARD_PROOF '+JSON.stringify({task:'vf-opacity',theme:KRTheme.get(),evidence,marks:'0%/100%, outline/recolour',reset:true}));return true;
  `, {afterReload:`
    const expected=JSON.parse(sessionStorage.getItem('vf-opacity-viewer')),actual=Appearance.get();
    if(JSON.stringify(actual)!==JSON.stringify(expected))throw Error('reload lost per-viewer opacity/colour'+(()=>{try{const s=localStorage.getItem('kr.appearance.v1');return ' storage '+(s?s.length:'none')+' viewers '+(s?Object.keys(JSON.parse(s).viewers||{}).join('|').slice(0,300):'')+' total '+Object.keys(localStorage).reduce((n,k)=>n+(localStorage.getItem(k)||'').length,0)+' path '+location.pathname}catch(e){return ' storage error '+e.message}})());
    console.log('BOARD_PROOF '+JSON.stringify({task:'vf-opacity',reload:true,opacity:actual.layerOpacity['In2.Cu'],color:actual.layers['In2.Cu'].color}));return true;
  `}],

];

// Reuse the pixel/UI regression without its reload so proof shots retain the synthetic board.
for (const closeup of [false,true]) {
  const body=CHECKS.find(c=>c[0]==='vf-opacity synthetic layer union UI persistence and marks')[2];
  CHECKS.push(['vf-opacity proof '+(closeup?'overlap close-up':'board and Appearance row'),'v=board&t=appearance',body.replace('sessionStorage.setItem',
    (closeup?"setT({x:12,y:5,z:100});":"")+"sessionStorage.setItem")]);
}
// Same retained-resource performance assertion, now exercising transparent copper layer passes.
for (const mode of ['side','overlay','wipe','blend','semantic']) {
  const source=CHECKS.find(c=>c[0]==='board diff fps outline '+mode);
  CHECKS.push(['vf-opacity Thermal fps '+mode,source[1],source[2].replace("Appearance.patch({markStyle:'outline'});",
    "Appearance.patch({markStyle:'outline',layerOpacity:{'F.Cu':.5,'B.Cu':.5}});")]);
}

CHECKS.push(['vf-avail unchanged board full design and Appearance hash', 'v=board&t=appearance', `
  proj().board.changed=false;proj().board.status='unchanged';
  const state=valid({...S,v:'board',t:'appearance'});
  if(state.v!=='board'||state.t!=='appearance')throw Error('unchanged board deep link rejected');
  Object.assign(S,state);renderNav();renderPanel();await draw();
  if(!currentView('board'))throw Error('unchanged board unavailable');
  document.querySelector('[data-left-tab=project]').click(); if(!document.querySelector('[data-view="board"]'))throw Error('unchanged board missing in navigator'); document.querySelector('[data-left-tab=appearance]').click();
  if(!document.querySelector('#appearance-root'))throw Error('Appearance unavailable');
  if(!document.querySelector('#stage').textContent.includes('No layout changes'))throw Error('missing no-change notice');
  for(const layer of proj().board.layers){if(!document.querySelector('#appearance-root [data-layer="'+canon(layer.name)+'"]'))throw Error('missing layer '+layer.name);}
  if(!boardView.renderers.length&&!document.querySelector('#stage svg'))throw Error('no board drawing');
  console.log('BOARD_PROOF '+JSON.stringify({task:'vf-avail',layers:proj().board.layers.length,renderers:boardView.renderers.length,theme:KRTheme.get()}));return true;
`]);

CHECKS.push(['vf-avail unchanged board modes checks threads and full hash', 'v=board&t=appearance', `
  if(proj().board.changed) return 'skip';
  for(const mode of ['side','overlay','wipe','blend','semantic']) {
    S.m=mode;await draw();
    if(!document.querySelector('#stage .no-change-notice')||!currentView())throw Error('unchanged board unavailable in '+mode);
    if(!boardView.renderers.length&&!document.querySelector('#stage svg'))throw Error('full board missing in '+mode);
  }
  const violation=allViolations().find(v=>v.where?.board&&v.pos);
  if(!violation)throw Error('real board finding required');
  await applyState({p:S.p,v:'sheet:'+proj().sheets[0].path,t:'checks'});await goTo(violation.id);
  if(S.v!=='board'||S.s!==violation.id||!currentView())throw Error('finding cannot open unchanged board');
  const a=pointAnchor(violation.pos[0],violation.pos[1],'head');
  acceptThreads([{id:'vf-avail-thread',resolved:false,anchor:a,comments:[]}]);
  await applyState({p:S.p,v:'sheet:'+proj().sheets[0].path});await openThread('vf-avail-thread');
  if(S.v!=='board'||!document.querySelector('#stage .pin'))throw Error('thread cannot open unchanged board');
  const st={p:S.p,v:'board',m:'side',x:10,y:20,z:5,s:violation.id,t:'appearance',layers:[proj().board.layers[0].name],camera3d:[1,2,3,4,5,6],hidden3d:['silk']};
  const got=valid(decodeState('#'+encodeState(st)));
  for(const k of ['p','v','m','x','y','z','s','t','layers','camera3d','hidden3d'])if(JSON.stringify(st[k])!==JSON.stringify(got[k]))throw Error('hash lost '+k);
  await applyState({p:S.p,v:'board',m:'side',t:'appearance'});return true;
`]);
CHECKS.push(['vf-avail unchanged 3D both revisions', 'v=3d&m=side', `
  if(!proj().board.model3d) return 'skip';
  const model=proj().board.model3d;
  if(!model.base||!model.head)throw Error('missing model revision');
  if(!document.querySelector('[data-view="3d"]'))throw Error('3D navigator unavailable');
  if(!window.Review3D.state.firstFrame||window.Review3D.state.roots.filter(Boolean).length!==2||document.querySelectorAll('#stage canvas').length!==1||window.Review3D.state.renderers.length!==1)throw Error('both revisions must draw');
  if(model.base===model.head&&!document.querySelector('#stage').textContent.includes('No 3D changes'))throw Error('missing 3D no-change notice');
  console.log('BOARD_PROOF '+JSON.stringify({task:'vf-avail',view:'3d',sameBlob:model.base===model.head,roots:window.Review3D.state.roots.length,theme:KRTheme.get()}));return true;
`]);
CHECKS.push(['vf-avail unchanged schematic sheet full design', '', `
  const p=D.projects.findIndex(p=>p.sheets.some(s=>s.svg.base&&s.svg.head));if(p<0)return 'skip';
  const sheet=D.projects[p].sheets.find(s=>s.svg.base&&s.svg.head);
  sheet.status='unchanged';sheet.svg.head=sheet.svg.base;
  await applyState({p,v:'sheet:'+sheet.path,m:'side'});
  if(document.querySelectorAll('#stage svg').length!==2||!document.querySelector('#stage').textContent.includes('No schematic changes on this sheet'))throw Error('unchanged sheet must draw both revisions and explain');return true;
`]);

CHECKS.push(['vf-avail several projects retained in full', '', `
  if(D.projects.length<2)return 'skip';
  const unchanged=D.projects.findIndex(p=>p.status==='unchanged');if(unchanged<0)return 'skip';
  if(D.projects.slice(unchanged).some(p=>p.status!=='unchanged'))throw Error('unchanged projects must sort last');
  for(let p=0;p<D.projects.length;p++){
    await applyState({p,v:'board',m:'side',t:'appearance'});
    if(!currentView()||!document.querySelector('#appearance-root'))throw Error('project board unavailable '+p);
    for(const sheet of proj().sheets){await applyState({p,v:'sheet:'+sheet.path,m:'side'});if(document.querySelectorAll('#stage svg').length!==2)throw Error('sheet revision unavailable '+sheet.path);}
    if(modelAvailable()){await applyState({p,v:'3d',m:'side'});if(window.Review3D.state.roots.filter(Boolean).length!==2)throw Error('project 3D unavailable '+p);}
  }
  await applyState({p:unchanged,v:'board',m:'side',t:'appearance'});
  console.log('BOARD_PROOF '+JSON.stringify({task:'vf-avail',projects:D.projects.map(p=>({name:p.name,status:p.status,sheets:p.sheets.length,layers:p.board.layers.length})),theme:KRTheme.get()}));return true;
`]);
CHECKS.push(['vf-avail board-only unchanged schematic proof', '', `
  const p=D.projects.findIndex(p=>p.board.changed&&p.sheets.every(s=>s.status==='unchanged'));if(p<0)return 'skip';
  await applyState({p,v:'sheet:'+D.projects[p].sheets[0].path,m:'side'});
  if(document.querySelectorAll('#stage svg').length!==2||!document.querySelector('#stage .no-change-notice'))throw Error('board-only edit hid unchanged schematic');return true;
`]);
CHECKS.push(['vf-avail one-sheet change retains unchanged sibling proof', '', `
  const p=D.projects.findIndex(p=>p.sheets.some(s=>s.status!=='unchanged')&&p.sheets.some(s=>s.status==='unchanged'));if(p<0)return 'skip';
  await applyState({p,v:'sheet:'+D.projects[p].sheets.find(s=>s.status==='unchanged').path,m:'side'});
  if(document.querySelectorAll('#stage svg').length!==2||!document.querySelector('#stage .no-change-notice'))throw Error('sibling sheet unavailable');return true;
`]);
CHECKS.push(['bench polish Fit stays centred after dock resize and Widen has a label', 'v=board', `
  const w=ms=>new Promise(r=>setTimeout(r,ms));
  for(let i=0;i<40&&!(boardDiff&&boardDiff.scenes?.head);i++)await w(100);
  if(!boardDiff?.scenes?.head)return 'skip';
  const btn=document.querySelector('[data-panel-wide]');
  if(!btn||/700 px/.test(btn.textContent)||!/Widen|Narrow/.test(btn.textContent)||!btn.querySelector('svg'))return 'widen label '+btn?.textContent;
  fit();await w(200);
  const ok=()=>{const vp=document.querySelector('#stage .vp'),b=sceneBox(),z=Math.min(vp.clientWidth/(b[2]-b[0]+4),vp.clientHeight/(b[3]-b[1]+4));
    return Math.abs(S.z/z-1)<.02&&Math.abs(S.x-(b[0]+b[2])/2)<.5&&Math.abs(S.y-(b[1]+b[3])/2)<.5;};
  if(!ok())return 'not fitted';
  btn.click();await w(600);
  if(!ok())return 'not refitted after widen';
  setT({z:S.z*2});btn.click&&document.querySelector('[data-panel-wide]').click();await w(600);
  return S.z>0&&autoFit===false;
`]);
CHECKS.push(['bench polish inspector shows nets as a list', 'v=board', `
  const w=ms=>new Promise(r=>setTimeout(r,ms));
  for(let i=0;i<40&&!(boardDiff&&boardDiff.scenes?.head);i++)await w(100);
  const sc=boardDiff?.scenes?.head;if(!sc)return 'skip';
  let fp=null;
  for(const o of sc.objects.filter(o=>o.kind==='footprint')){S.s=null;S.io=null;S.ig={side:'head',object:o};if(inspectorProperties()?.head?.Nets?.length>1){fp=o;break;}}
  if(!fp)return 'skip';renderInspector();
  const t=document.querySelector('#inspector').textContent;
  return !/\\[\\s*"/.test(t)&&document.querySelectorAll('#inspector .insp-list li').length>1;
`]);

// vf-sch-speed: a schematic pan must cost almost nothing (no ancestor restyle, no HUD rewrite, no grid repaint).
CHECKS.push(['vf-sch-speed schematic pan is cheap', '', `
  const sheet=proj().sheets.find(s=>s.svg); if(!sheet) return 'skip';
  S.v='sheet:'+sheet.path; S.m='side'; S.grid=true; await draw(); fit();
  const raf=()=>new Promise(requestAnimationFrame), vp=document.querySelector('#stage .vp.sheet'), r=vp.getBoundingClientRect();
  const ev=(type,i)=>vp.dispatchEvent(new PointerEvent(type,{pointerId:7,button:0,buttons:type==='pointerup'?0:1,clientX:r.x+r.width/2+(i||0)*3,clientY:r.y+r.height/2+(i||0),bubbles:true}));
  // 1. unchanged HUD text must not be rewritten
  const hud=new MutationObserver(()=>{}); hud.observe(document.querySelector('#statusbar'),{childList:true,characterData:true,subtree:true}); hud.observe(document.querySelector('#zoombar'),{childList:true,characterData:true,subtree:true});
  apply(); hud.takeRecords(); apply(); apply(); updateStatus();
  const rewrites=hud.takeRecords().length; hud.disconnect();
  if(rewrites) return 'unchanged status/zoom text rewritten '+rewrites+'x';
  // 2. grid: count dots painted while panning at constant zoom
  const proto=CanvasRenderingContext2D.prototype, oldRect=proto.rect; let rects=0; proto.rect=function(...a){rects++;return oldRect.apply(this,a)};
  let frames=[], t0;
  try {
    ev('pointerdown',0); await raf(); rects=0; t0=performance.now();
    for(let i=1;i<=60;i++){ ev('pointermove',i); const t=performance.now(); await raf(); frames.push(performance.now()-t); }
    ev('pointerup',60);
  } finally { proto.rect=oldRect; }
  if(rects) return 'grid repainted '+rects+' dots during pan';
  // 3. no custom property on viewport ancestors of the SVG
  if(/--cursor/.test(vp.style.cssText)) return 'pointer position written to SVG ancestor as CSS variable: '+vp.style.cssText;
  frames.sort((a,b)=>a-b); const fps=1000*frames.length/frames.reduce((a,b)=>a+b), p95=frames[Math.floor(frames.length*.95)];
  const gl=document.createElement('canvas').getContext('webgl'), ext=gl&&gl.getExtension('WEBGL_debug_renderer_info'), soft=!ext||/swiftshader|llvmpipe|software/i.test(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
  console.log('BOARD_PROOF '+JSON.stringify({task:'vf-sch-speed',fps:+fps.toFixed(1),p95:+p95.toFixed(1),software:soft,elements:document.querySelectorAll('#stage *').length}));
  if(!soft&&fps<50) return 'pan '+fps.toFixed(1)+' fps';
  return true;
`]);
CHECKS.push(['vf-sch-speed board crosshair follows pointer by transform', 'v=board', `
  const vp=document.querySelector('#stage .vp'), r=vp.getBoundingClientRect();
  updateCoordinates(vp,{clientX:r.left+100,clientY:r.top+50});
  const cross=vp.querySelector(':scope > .board-cross');
  if(!cross||!vp.classList.contains('board-cursor')||getComputedStyle(cross).display!=='block') return 'no crosshair';
  if(!new DOMMatrix(cross.style.transform).isIdentity&&Math.abs(new DOMMatrix(cross.style.transform).e-91)>1e-6) return cross.style.transform;
  if(/--cursor/.test(vp.style.cssText)) return 'css variable';
  const b=cross.getBoundingClientRect(); return Math.abs(b.left+9-(r.left+100))<1&&Math.abs(b.top+9-(r.top+50))<1||JSON.stringify(b);
`]);

// zoom-burst: a wheel/pinch burst on the largest sample sheet (project 1 Thermal_Camera root, ~28k SVG elements) must not freeze the page.
const ZB_WHEEL = `const zb = (vp, r, dy) => vp.dispatchEvent(new WheelEvent('wheel', {deltaY: dy, ctrlKey: true, clientX: r.left + r.width/2, clientY: r.top + r.height/2, bubbles: true, cancelable: true}));`;
// ponytail: still skipped. In headless SwiftShader the post-gesture re-raster of this sheet costs ~1.7-2.3 s with or
// without simplifySchematic (layers hidden: ~20 ms), so raster of the geometry, not element count, is the cost here.
// Under --gpu they pass with and without it. Run with --no-skip "zoom-burst" to see them.
const ZB_PENDING = `return 'skip';`;
CHECKS.push(['zoom-burst no long frame', 'p=1&v=sheet:/', `${ZB_WHEEL}${ZB_PENDING}
  const vp = document.querySelector('#stage .vp'), r = vp.getBoundingClientRect();
  const long = []; const po = new PerformanceObserver(l => long.push(...l.getEntries().map(e => e.duration))); po.observe({type:'longtask', buffered:false});
  const frames = []; let last = performance.now(), on = true;
  const tick = t => { frames.push(t - last); last = t; if (on) requestAnimationFrame(tick); }; requestAnimationFrame(tick);
  for (let i = 0; i < 200; i++) { zb(vp, r, i % 2 ? 4 : -4); if (i % 2) await new Promise(res => setTimeout(res, 10)); }
  await new Promise(res => setTimeout(res, 400)); on = false; po.disconnect();
  const worst = Math.max(...frames.slice(1)), task = Math.max(0, ...long);
  return worst < 200 && task < 200 || JSON.stringify({worst: Math.round(worst), task: Math.round(task)});
`]);
CHECKS.push(['zoom-burst dock tab responds', 'p=1&v=sheet:/', `${ZB_WHEEL}${ZB_PENDING}
  const vp = document.querySelector('#stage .vp'), r = vp.getBoundingClientRect();
  for (let i = 0; i < 100; i++) zb(vp, r, -4);
  await new Promise(res => setTimeout(res, 160));   // settle re-raster pending
  const tab = document.querySelector('[role="tab"][aria-selected="false"]');
  if (!tab) return 'no unselected tab';
  const t0 = performance.now(); tab.click();
  await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
  const ms = performance.now() - t0, now = document.getElementById(tab.id);   // tab bars re-render, so read the live node
  return now?.getAttribute('aria-selected') === 'true' && ms < 200 || JSON.stringify({ms: Math.round(ms), tab: tab.id, selected: now?.getAttribute('aria-selected')});
`]);
CHECKS.push(['zoom-burst memory returns', 'p=1&v=sheet:/', `${ZB_WHEEL}
  if (!performance.memory) return 'skip';
  const vp = document.querySelector('#stage .vp'), r = vp.getBoundingClientRect();
  const nodes0 = document.getElementsByTagName('*').length;
  for (let run = 0; run < 5; run++) for (let i = 0; i < 200; i++) zb(vp, r, i % 2 ? 4 : -4);
  await new Promise(res => setTimeout(res, 400));
  const nodes1 = document.getElementsByTagName('*').length;
  return nodes1 <= nodes0 * 1.1 || JSON.stringify({nodes0, nodes1});
`]);
CHECKS.push(['zoom-burst deep zoom no long frame', 'p=1&v=sheet:/', `${ZB_WHEEL}${ZB_PENDING}
  const vp = document.querySelector('#stage .vp'), r = vp.getBoundingClientRect();
  setT({z: S.z * 28}); await new Promise(res => setTimeout(res, 400));   // the original report: sustained pinch at deep zoom
  const long = []; const po = new PerformanceObserver(l => long.push(...l.getEntries().map(e => e.duration))); po.observe({type:'longtask', buffered:false});
  const frames = []; let last = performance.now(), on = true;
  const tick = t => { frames.push(t - last); last = t; if (on) requestAnimationFrame(tick); }; requestAnimationFrame(tick);
  for (let i = 0; i < 200; i++) { zb(vp, r, i % 2 ? 4 : -4); if (i % 2) await new Promise(res => setTimeout(res, 10)); }
  await new Promise(res => setTimeout(res, 400)); on = false; po.disconnect();
  const worst = Math.max(...frames.slice(1)), task = Math.max(0, ...long);
  return worst < 200 && task < 200 || JSON.stringify({worst: Math.round(worst), task: Math.round(task), z: +S.z.toFixed(2)});
`]);
// simplifySchematic: < 3,000 painted elements; joined strokes lighten thin text at fit, limits ~1.5x measured (fit mean 1.66, 18% moved; 28x 0.12, 2%).
CHECKS.push(['simplify largest sheet few elements, near-same pixels', 'p=1&v=sheet:/', `
  const svgs = [...document.querySelectorAll('#stage svg[data-appearance-schematic]')];
  const painted = svgs.map(s => s.querySelectorAll('path,line,polyline,polygon,rect,circle,ellipse').length);
  if (!svgs.length || painted.some(n => n >= 3000)) return 'painted ' + painted;
  const raw = await svgText(currentView().layers[0].svg.head), size = currentView().size;
  const render = async (markup, vb, W, H) => {
    const d = new DOMParser().parseFromString(markup, 'image/svg+xml').documentElement;
    d.setAttribute('viewBox', vb.join(' ')); d.setAttribute('width', W); d.setAttribute('height', H);
    const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(d)); await img.decode();
    const x = new OffscreenCanvas(W, H).getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, W, H); x.drawImage(img, 0, 0); return x.getImageData(0, 0, W, H).data; };
  const out = {painted};
  // [name, viewBox mm, px, mean limit, share of ink pixels allowed to move > 32/255]
  for (const [name, vb, W, H, meanMax, moveMax] of [['fit', [0, 0, size[0], size[1]], 1600, Math.round(1600 * size[1] / size[0]), 2.5, 0.25], ['28x', [60, 125, 1600 / 28 / 3.78, 900 / 28 / 3.78], 1600, 900, 0.25, 0.03]]) {
    const a = await render(raw.slice(raw.indexOf('<svg')), vb, W, H), b = await render(simpleSheet(raw), vb, W, H);
    let sum = 0, moved = 0, ink = 0;
    for (let i = 0; i < a.length; i += 4) { const m = Math.max(Math.abs(a[i]-b[i]), Math.abs(a[i+1]-b[i+1]), Math.abs(a[i+2]-b[i+2])); sum += m; if (m > 32) moved++; if (Math.min(a[i], a[i+1], a[i+2]) < 200) ink++; }
    out[name] = {mean: +(sum / (a.length / 4)).toFixed(2), moved: +(moved / ink).toFixed(3)};
    if (out[name].mean > meanMax || out[name].moved > moveMax) return JSON.stringify(out);
  }
  return true;
`]);

CHECKS.push(
  ['BR02 processed single renderer scissored sides', 'v=3d&m=side', `
    if(!proj().board.parts3d)return 'skip';
    const st=Review3D.state;
    if(!st?.firstFrame)return '3D fixture has no first frame';
    if(document.querySelectorAll('#stage canvas').length!==1)return 'expected one shared canvas';
    if(st.renderers.length!==1||st.cameras.length!==2)return 'renderer/camera ownership';
    const narrow=Boolean(S.phone);
    if(narrow?st.visibleSides.length!==1:st.visibleSides.join(',')!=='base,head')return 'revision viewport routing';
    if(st.views!==Review3D.session().views||st.views.some(v=>!v.host||!v.camera||!v.scene))return 'view diagnostics';
    return st.drawCallsByViewport.length===(narrow?1:2)||'missing viewport counters';
  `],
  ['BR02 single renderer head only', 'v=3d&m=side', `
    if(!proj().board.parts3d)return 'skip';
    const st=Review3D.state;
    if(REVIEW_DATA.mode!=='single')return 'fixture is not single mode';
    if(proj().board.model3d?.base||proj().board.poster3d?.base)return 'base blob present in fixture';
    if(!st?.firstFrame)return 'head model has no first frame';
    if(st.renderers.length!==1||st.roots.length!==1)return 'single renderer or single root';
    if(st.visibleSides.join(',')!=='head')return 'single mode must draw head only';
    if(st.views.length!==1||st.views[0].side!=='head')return 'single mode view list';
    if(!document.querySelector('#stage .vp.view3d.one'))return 'missing single viewport class';
    if(document.querySelector('#stage .tag')?.textContent!=='Design')return 'single label';
    if(window.__baseBlobReads?.length)return 'base blob decoded in single mode';
    return (Review3D.session()?.revision==='head'&&typeof Review3D.poster3d==='function')||'session accessor or poster3d export';
  `],
  ['BR02 processed digest parses and shared resources dispose once', 'v=3d&m=side', `
    if(!proj().board.parts3d)return 'skip';
    const stage=document.querySelector('#stage'), p=structuredClone(proj());
    for(const equal of [true,false]) {
      if(equal){p.board.model3d.head=p.board.model3d.base;p.board.assets3d.head=p.board.assets3d.base;}
      else {p.board.model3d=proj().board.model3d;p.board.assets3d=proj().board.assets3d;}
      const reopening=Review3D.show(stage,p,S), st=Review3D.state, parses=st.parseCount;
      await reopening;
      const [base,head]=st.roots, bg=base.getObjectByProperty('isMesh',true)?.geometry,hg=head.getObjectByProperty('isMesh',true)?.geometry;
      const same=st.modelDigests.base===st.modelDigests.head;
      if(same!==equal)return 'fixture must exercise both equal and distinct digests';
      if(st.parseCount-parses!==(same?1:2))return 'digest parse count';
      if(!bg||!hg||(bg===hg)!==same)return 'digest geometry sharing';
      if(base===head)return 'logical roots not cloned';
      const counts=new Map(), originals=new Map();
      const watch=o=>{if(!o?.dispose||originals.has(o))return;const fn=o.dispose;originals.set(o,fn);o.dispose=function(){counts.set(o,(counts.get(o)||0)+1);return fn.call(this);};};
      for(const root of [...st.roots,...st.decodedScenes])root?.traverse(n=>{
        watch(n.geometry);for(const m of [n.material].flat().filter(Boolean)){watch(m);for(const t of Object.values(m))if(t?.isTexture)watch(t);}
      });
      watch(st.renderers[0]);
      try{Review3D.dispose();if([...originals.keys()].some(o=>counts.get(o)!==1))return 'shared GPU resource disposed zero or multiple times';}
      finally{for(const [o,fn]of originals)o.dispose=fn;}
      if(Review3D.session()!==null)return 'disposed session still published';
    }
    return true;
  `],
  ['BR02 processed shared resources dispose once', 'v=3d&m=side', `
    if(!proj().board.parts3d)return 'skip';
    const counts=new Map(),originals=new Map();
    const watch=o=>{if(!o?.dispose||originals.has(o))return;const original=o.dispose;originals.set(o,original);o.dispose=function(){counts.set(o,(counts.get(o)||0)+1);return original.call(this);};};
    for(const root of Review3D.state.roots)root?.traverse(n=>{watch(n.geometry);for(const m of [n.material].flat().filter(Boolean)){watch(m);for(const value of Object.values(m))if(value?.isTexture)watch(value);}});
    try{Review3D.dispose();return [...originals.keys()].every(o=>counts.get(o)===1)||'shared GPU resource disposed zero or multiple times';}
    finally{for(const [o,fn]of originals)o.dispose=fn;}
  `],
  ['BR02 processed no WebGL retains poster and retries', 'v=3d&m=side', `
    if(!proj().board.parts3d)return 'skip';
    const original=HTMLCanvasElement.prototype.getContext,stage=document.querySelector('#stage');
    try{
      HTMLCanvasElement.prototype.getContext=function(type,...args){return /^webgl/.test(type)?null:original.call(this,type,...args);};
      await Review3D.show(stage,proj(),S);
      if(Review3D.state.firstFrame||Review3D.state.loading)return 'failed renderer claims ready';
      if(!stage.querySelector('[data-poster]:not([hidden])'))return 'WebGL failure lost poster';
      if(!stage.querySelector('[data-3d-retry]'))return 'WebGL failure has no retry';
    }finally{HTMLCanvasElement.prototype.getContext=original;}
    await Review3D.show(stage,proj(),S);return Review3D.state.firstFrame||'retry failed to render';
  `],
  ['BR02 processed visible model is not covered', 'v=3d&m=side', `
    if(!proj().board.parts3d)return 'skip';
    const st=Review3D.state,host=[...document.querySelectorAll('#stage .view3d')].find(e=>e.getBoundingClientRect().width>0);
    if(!st.firstFrame||!host)return 'no visible model frame';
    if(!document.querySelector('#stage > canvas'))return 'shared canvas missing';
    if(getComputedStyle(document.querySelector('#stage')).backgroundColor==='rgba(0, 0, 0, 0)')return 'stage has no theme background';
    for(const e of document.querySelectorAll('#stage .view3d'))if(getComputedStyle(e).backgroundColor!=='rgba(0, 0, 0, 0)')return 'opaque input host covers model';
    if([...document.querySelectorAll('#stage [data-poster]')].some(e=>!e.hidden&&e.closest('.view3d')===host))return 'poster still covers loaded model';
    if((await Review3D.sampleFrame()).opaquePixels<100)return 'actual model pixels absent';
    const b=host.getBoundingClientRect();if(!document.elementsFromPoint(b.x+b.width/2,b.y+b.height/2).includes(host))return 'viewport occluded';
    return st.drawCallsByViewport.every(n=>n>0)||'real model submitted no primitives';
  `]
);

CHECKS.push(
 ['BR02 processed canonical revision and empty phone side', 'v=3d&m=side', `
   if(!proj().board.parts3d)return 'skip';
   const stage=document.querySelector('#stage'), p=structuredClone(proj()), app={...S,phone:true,revision:'head',m:'side',s:null};
   for(const key of ['model3d','parts3d','assets3d','poster3d','coverage3dBySide'])delete p.board[key].head;
   await Review3D.show(stage,p,app);
   if(Review3D.state.revision!=='head'||Review3D.state.visibleSides.join(',')!=='head')return 'requested absent Head changed revision';
   const host=stage.querySelector('.view3d:not([hidden])');
   if(!host?.textContent.includes('Board not in this revision')||host.querySelector('[data-poster]'))return 'empty Head borrowed Base content';
   Review3D.setRevision('base');await Review3D.sampleFrame();
   if(Review3D.state.visibleSides.join(',')!=='base'||!Review3D.state.firstFrame)return 'Base revision inaccessible';
   if(S.revision!=='base')return 'app state not synchronized';
   Review3D.setRevision('head');
   if(Review3D.state.visibleSides.join(',')!=='head'||!host.querySelector('[data-revision-empty]'))return 'Head round trip failed';
   app.phone=false;Review3D.resize();
   return Review3D.state.views.every(v=>v.visible)||'resize did not consume canonical phone state';
 `],
 ['BR02 processed equal digest materials stay immutable across roles', 'v=3d&m=side', `
   if(!proj().board.parts3d)return 'skip';
   const p=structuredClone(proj()), stage=document.querySelector('#stage');
   p.board.model3d.head=p.board.model3d.base;p.board.assets3d.head=p.board.assets3d.base;
   await Review3D.show(stage,p,{...S,m:'blend',s:null});
   const st=Review3D.state, source=st.decodedScenes[0], original=new Map();
   source.traverse(n=>{for(const m of [n.material].flat().filter(Boolean))original.set(m,{opacity:m.opacity,transparent:m.transparent});});
   const [base,head]=st.roots, bm=base.getObjectByProperty('isMesh',true).material,hm=head.getObjectByProperty('isMesh',true).material;
   if(bm===hm||original.has(bm)||original.has(hm))return 'blend mutates shared source or shares roles';
   Review3D.setBlend(.2);
   if(bm.opacity!==.8||hm.opacity!==.2)return 'blend roles not independent';
   if([...original].some(([m,v])=>m.opacity!==v.opacity||m.transparent!==v.transparent))return 'source material mutated';
   const sourceMeshes=[],cloneMeshes=[];
   source.traverse(n=>{if(n.isMesh)sourceMeshes.push(n);});base.traverse(n=>{if(n.isMesh)cloneMeshes.push(n);});
   const roleMaterials=new Map();let mismatch=false;
   sourceMeshes.forEach((n,i)=>[n.material].flat().forEach((sourceMaterial,j)=>{
     const m=[cloneMeshes[i].material].flat()[j], prior=roleMaterials.get(sourceMaterial);
     if(prior&&prior!==m)mismatch=true;roleMaterials.set(sourceMaterial,m);
   }));
   return !mismatch||'material cloned per mesh instead of distinct source and role';
 `]
);

CHECKS.push(
  ...['side-base', 'side-head', 'side-highlight', 'overlay', 'blend', 'semantic'].map(fault => [
    'BR02 processed view build failure ' + fault, 'v=3d&m=side', `
    if(!proj().board.parts3d)return 'skip';
    const stage=document.querySelector('#stage'), T=THREE3D.THREE;
    const controls=THREE3D.OrbitControls, clone=T.Material.prototype.clone;
    const mode='${fault}'.startsWith('side-')?'side':'${fault}', side=['side-base','side-highlight'].includes('${fault}')?'base':'head';
    let calls=0, clones=0;
    try {
      THREE3D.OrbitControls=class extends controls {
        constructor(...args){
          if(++calls===('${fault}'==='side-base'?1:2)&&mode==='side'&&'${fault}'!=='side-highlight')throw Error('injected view build');
          super(...args);
          // Inject only after renderer construction and GLTF parsing complete.
          if(mode!=='side'||'${fault}'==='side-highlight')T.Material.prototype.clone=function(){
            if('${fault}'!=='side-highlight'||++clones===1)throw Error('injected view build');
            return clone.call(this);
          };
        }
      };
      await Review3D.show(stage,proj(),{...S,m:mode,phone:false,s:null});
      const st=Review3D.state, host=Review3D.session().hostsBySide[side];
      if(st.renderers.length!==1||!st.decodedScenes.length||!calls)return 'fault injected before view construction';
      if(!st.errorsBySide[side]?.includes('injected view build'))return 'build error not reported';
      if(st.loading||host.querySelector('.loading'))return 'build failure left loading';
      if(!host.querySelector('[data-3d-retry]')||!host.querySelector('[data-poster]:not([hidden])'))return 'build failure lost fallback or retry';
      if(mode==='side'&&!st.firstFrame)return 'healthy peer did not render: '+JSON.stringify({errors:st.errorsBySide,views:st.views.map(v=>({side:v.side,failed:v.failed,visible:v.visible,calls:v.calls}))});
      if(mode!=='side'&&st.firstFrame)return 'failed combined view claims ready';
    } finally {THREE3D.OrbitControls=controls;T.Material.prototype.clone=clone;}
    await Review3D.show(stage,proj(),{...S,m:mode,s:null});
    return Review3D.state.firstFrame&&!Object.keys(Review3D.state.errorsBySide).length||'build retry failed';
  `]),
  ['BR02 processed stage observer owns viewer resize', 'v=3d&m=side', `
    if(!proj().board.parts3d)return 'skip';
    const add=window.addEventListener, stage=document.querySelector('#stage');let registrations=0;
    try {
      window.addEventListener=function(type,...args){if(type==='resize')registrations++;return add.call(this,type,...args);};
      await Review3D.show(stage,proj(),S);
      if(registrations)return 'viewer registered redundant window resize';
      if(!Review3D.session().resizeObserver)return 'stage observer missing';
      const width=stage.style.width;
      try {
        stage.style.width='500px';
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        const canvas=stage.querySelector('canvas');
        return canvas.width===Math.floor(500*Math.min(devicePixelRatio,2))||'stage layout change missed without window resize';
      } finally {stage.style.width=width;}
    } finally {window.addEventListener=add;}
  `],
  ['BR02 processed collapsed pane resets draw counters', 'v=3d&m=side', `
    if(!proj().board.parts3d)return 'skip';
    const st=Review3D.state, v=st.views.find(v=>v.visible&&v.calls>0);
    if(!v)return 'fixture has no drawn viewport';
    const rect=v.host.getBoundingClientRect;
    try {
      v.host.getBoundingClientRect=()=>({left:0,bottom:0,width:0,height:0});
      await Review3D.sampleFrame();
      const i=st.views.filter(v=>v.visible).indexOf(v);
      if(v.calls!==0||st.drawCallsByViewport[i]!==0)return 'collapsed pane retained stale calls';
      return st.drawCalls===st.views.filter(other=>other.visible&&other!==v).reduce((n,other)=>n+other.calls,0)||'frame total includes collapsed pane';
    } finally {v.host.getBoundingClientRect=rect;}
  `],
  ['BR02 processed overlay ghosts retain flat unlit tint', 'v=3d&m=overlay', `
    if(!proj().board.parts3d)return 'skip';
    const st=Review3D.state, source=new Set(), ghosts=[];
    st.decodedScenes.forEach(root=>root.traverse(n=>{for(const m of [n.material].flat().filter(Boolean))source.add(m);}));
    st.ghosts.forEach(g=>g.object.traverse(n=>{if(n.isMesh)ghosts.push(...[n.material].flat());}));
    if(!ghosts.length)return 'fixture has no ghosts';
    const tint=new THREE3D.THREE.Color(getComputedStyle(document.documentElement).getPropertyValue('--removed').trim());
    for(const g of st.ghosts) {
      const node=st.roots[0].getObjectByName(g.ref),before=[],after=[];
      node.traverse(n=>{if(n.isMesh)before.push(...[n.material].flat());});
      g.object.traverse(n=>{if(n.isMesh)after.push(...[n.material].flat());});
      if(after.some((m,i)=>Math.abs(m.opacity-before[i].opacity*.45)>1e-7))return 'ghost alpha replaced';
      if(new Set(after).size!==new Set(before).size)return 'ghost material partition lost';
    }
    return ghosts.every(m=>m.isMeshBasicMaterial&&!m.map&&m.color.equals(tint)&&m.transparent&&!m.depthTest&&!source.has(m))||'ghost appearance changed or source mutated';
  `],
  ['BR02 processed default revision omitted from share hash', 'v=3d&m=side', `
    if(!proj().board.parts3d)return 'skip';
    for(const v of ['board','3d',...proj().sheets.map(s=>'sheet:'+s.path)]) {
      if(new URLSearchParams(encodeState({...S,v,revision:'head'})).has('revision'))return 'default Head persisted in '+v;
    }
    const base=decodeState(encodeState({...S,revision:'base',layout:'phone'}));
    return base.revision==='base'&&base.layout==='phone'||'explicit compatibility state lost';
  `]
);

CHECKS.push(['BR02 processed compatibility phone predicate fractional widths', 'v=3d&m=side', `
 if(!proj().board.parts3d)return 'skip';
 const frame=document.createElement('iframe');frame.style.cssText='position:absolute;left:-2000px;height:40px;border:0';document.body.appendChild(frame);
 try {
   const run=frame.contentWindow.Function('S','('+sync3DPhone.toString()+')();return S.phone;');
   for(const [width,expected]of [[699.5,true],[700,true],[700.5,false],[701,false]]){
     frame.style.width=width+'px';frame.getBoundingClientRect();
     if(run({})!==expected)return 'wrong responsive boundary at '+width;
   }
   frame.style.width='1200px';frame.getBoundingClientRect();
   return run({layout:'phone'})||'forced phone layout ignored';
 }finally{frame.remove();}
`]);

CHECKS.push(
  ['BR02 processed studio environment, tone mapping and no direct lights', 'v=3d&m=side', `
    if(!proj().board.parts3d)return 'skip';
    const st=Review3D.state, s=Review3D.session(), T=THREE3D.THREE, r=st.renderers[0];
    if(!st.firstFrame)return 'no first frame';
    if(r.toneMapping!==T.NeutralToneMapping||r.outputColorSpace!==T.SRGBColorSpace||r.toneMappingExposure!==1.35)return 'renderer tone mapping or exposure';
    if(JSON.stringify(st.lighting)!=='{"rig":"bench","bearing":60,"exposure":1.35}')return 'default lighting '+JSON.stringify(st.lighting);
    const lights=[];
    for(const v of st.views){ if(!v.scene.environment)return 'view without environment'; v.scene.traverse(o=>{if(o.isLight)lights.push(o.type);}); }
    if(lights.length)return 'direct lights '+lights;
    if(s.environments.size!==1)return 'environment cache size '+s.environments.size;
    const first=st.views[0].scene.environment;
    Review3D.setLighting({rig:'photo',bearing:100,exposure:9});
    if(JSON.stringify(st.lighting)!=='{"rig":"photo","bearing":90,"exposure":3}')return 'clamp/snap '+JSON.stringify(st.lighting);
    if(r.toneMappingExposure!==3||st.views.some(v=>v.scene.environment===first)||s.environments.size!==2)return 'rig change did not swap environment';
    Review3D.setLighting({rig:'photo',bearing:90,exposure:.1});
    if(r.toneMappingExposure!==.4||s.environments.size!==2)return 'exposure rebuilt the environment';
    Review3D.setLighting({rig:'photo',bearing:90,exposure:1});
    if(s.environments.size!==2)return 'revisiting a rig/bearing rebuilt its environment';
    Review3D.setLighting({rig:'bench',bearing:70,exposure:1});
    if(s.environments.size!==2||st.lighting.bearing!==60)return 'bearing not snapped to the 30 degree grid: '+s.environments.size;
    Review3D.setLighting({rig:'nope',bearing:'x',exposure:NaN});
    if(JSON.stringify(st.lighting)!=='{"rig":"bench","bearing":60,"exposure":1.35}')return 'invalid lighting not defaulted';
    const px=await Review3D.sampleFrame();
    return px.opaquePixels>0||'lit board draws nothing';
  `],
  ['BR02 processed lighting and assembled state survive the share hash', 'v=3d&m=side', `
    if(!proj().board.parts3d)return 'skip';
    if(/(^|&)(lt|asm)=/.test(encodeState({...S})))return 'defaults persisted';
    const hash=encodeState({...S,assembled3d:false,lighting3d:{rig:'lowsun',bearing:120,exposure:1.6},hidden3d:['silk'],camera3d:[1,2,3,4,5,6]});
    const d=valid(decodeState(hash));
    if(d.assembled3d!==false||d.lighting3d.rig!=='lowsun'||d.lighting3d.bearing!==120||d.lighting3d.exposure!==1.6)return 'round trip '+hash;
    if(d.hidden3d.join()!=='silk'||d.camera3d.join()!=='1,2,3,4,5,6')return 'old camera/hidden hash lost';
    const bad=valid(decodeState('p=0&lt=laser,x,y&asm=1'));
    if(bad.lighting3d||bad.assembled3d!==undefined)return 'invalid lighting accepted';
    const old=valid(decodeState('p=0&v=3d&m=side&c=1,2,3,4,5,6&h=silk'));
    return (old.camera3d&&old.hidden3d.join()==='silk'&&!old.lighting3d)||'old hash broke';
  `],
  ['BR02 processed bare board hides components and restores them', 'v=3d&m=side', `
    if(!proj().board.parts3d)return 'skip';
    const st=Review3D.state, s=Review3D.session(), seen=[];
    const meshes=g=>s.groups.filter(x=>x.groups.includes(g));
    if(!meshes('bodies').length)return 'fixture has no component bodies';
    const change=s.changes.find(c=>c.ref&&st.roots.some(r=>r?.getObjectByName(c.ref)));
    if(!change)return 'fixture has no focusable changed component';
    Review3D.focus(change,false);
    if(!st.selected.length||st.selected.some(o=>!o.visible))return 'selection outline missing before bare';
    Review3D.onStateChange=e=>seen.push(e);
    document.querySelector('[data-3d-assembled]').click();
    if(st.selected.some(o=>o.visible))return 'selection outline remains in bare mode';
    Review3D.focus(change,false);
    if(st.selected.length)return 'focus recreated bare outline';
    if(st.assembled!==false||document.querySelector('[data-3d-assembled]').getAttribute('aria-pressed')!=='false')return 'toggle state';
    if(meshes('bodies').some(x=>x.object.visible))return 'bodies still visible when bare';
    if(!meshes('board').every(x=>x.object.visible))return 'board hidden when bare';
    if(st.blocks.some(b=>b.object.visible)||st.views.some(v=>(v.labels||[]).some(m=>!m.el.hidden)))return 'blocks or markers still visible';
    if(seen[0]?.assembled!==false)return 'no state event';
    Review3D.setHidden(['silk']);
    if(meshes('bodies').some(x=>x.object.visible))return 'hidden groups re-showed bodies';
    Review3D.setAssembled(true);
    return (st.selected.length===0&&meshes('bodies').every(x=>x.object.visible)&&meshes('silk').every(x=>!x.object.visible))||'assemble did not restore';
  `],
  ['BR02 processed 3D tools whole screen reachable', 'v=3d&m=side', `
    if(!proj().board.parts3d)return 'skip';
    const tools=document.querySelector('#zoombar .tools3d');
    if(!tools)return 'missing .tools3d';
    // Page-level overflow at 412 px belongs to 05's shell (bench-menu popover); the 3D tools must be reachable by scrolling the toolbar.
    tools.scrollIntoView({inline:'center',block:'nearest'});
    { const r=tools.getBoundingClientRect(); if(r.left<0||r.right>innerWidth)return 'tools unreachable '+JSON.stringify(r); }
    const b=tools.querySelector('[data-3d-assembled]');
    for(const el of tools.querySelectorAll('button,summary,select,input')){
      const name=el.getAttribute('aria-label')||el.title||el.closest('label')?.textContent||el.textContent;
      if(!name.trim())return 'unnamed control '+el.outerHTML.slice(0,60);
    }
    const light=tools.querySelector('.light3d'); light.open=true; await new Promise(r=>setTimeout(r,50));
    tools.scrollIntoView({inline:'center',block:'nearest'});const m=light.querySelector('.light-menu').getBoundingClientRect(), tb=document.querySelector('#toolbar').getBoundingClientRect();
    if(m.left<0||m.right>innerWidth||m.top<tb.bottom||m.bottom>innerHeight)return 'light menu clipped '+JSON.stringify(m);
    for(const el of light.querySelectorAll('select,input')){const r=el.getBoundingClientRect(); if(innerWidth<=700&&r.height<43)return 'phone target too small '+r.height;}
    const ex=light.querySelector('[data-3d-exposure]'); ex.value='2'; ex.dispatchEvent(new Event('input',{bubbles:true}));
    if(Review3D.state.lighting.exposure!==2)return 'exposure slider not wired';
    light.querySelector('[data-3d-rig]').value='photo'; light.querySelector('[data-3d-rig]').dispatchEvent(new Event('change',{bubbles:true}));
    if(Review3D.state.lighting.rig!=='photo'||Review3D.state.lighting.exposure!==1.2)return 'preset did not apply its exposure';
    light.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    if(light.open||document.activeElement!==light.querySelector('summary'))return 'Escape did not close and refocus';
    const r=b.getBoundingClientRect(); if(innerWidth<=700&&r.height<43)return 'phone Assembled target too small';
    return true;
  `]
);

CHECKS.push(
  ['BR02 processed rendered top lamp orientation', 'v=3d&m=side', `
    if(!proj().board.parts3d)return 'skip';
    const T=THREE3D.THREE, st=Review3D.state, r=st.renderers[0];
    const scene=new T.Scene();scene.environment=st.views[0].scene.environment;
    const material=new T.MeshStandardMaterial({color:0x808080,metalness:0,roughness:1});
    const geometry=new T.BoxGeometry(2,.05,2);scene.add(new T.Mesh(geometry,material));
    const camera=new T.OrthographicCamera(-1.1,1.1,1.1,-1.1,.1,10), target=new T.WebGLRenderTarget(64,64);
    const previous=r.getRenderTarget(), viewport=r.getViewport(new T.Vector4()), scissor=r.getScissor(new T.Vector4()), scissorTest=r.getScissorTest();
    const clearColor=r.getClearColor(new T.Color()), clearAlpha=r.getClearAlpha(), autoClear=r.autoClear;
    const sample=side=>{
      camera.position.set(0,side*3,0);camera.up.set(0,0,-side);camera.lookAt(0,0,0);camera.updateMatrixWorld();
      r.setRenderTarget(target);r.setViewport(0,0,64,64);r.setScissorTest(false);r.autoClear=true;r.setClearColor(0x000000,0);r.clear();r.render(scene,camera);
      const pixels=new Uint8Array(64*64*4);r.readRenderTargetPixels(target,0,0,64,64,pixels);
      let sum=0;for(let y=16;y<48;y++)for(let x=16;x<48;x++){const i=(y*64+x)*4;sum+=.2126*pixels[i]+.7152*pixels[i+1]+.0722*pixels[i+2];}
      return sum/1024;
    };
    let top,bottom;
    try{top=sample(1);bottom=sample(-1);}finally{
      r.setRenderTarget(previous);r.setViewport(viewport);r.setScissor(scissor);r.setScissorTest(scissorTest);
      r.setClearColor(clearColor,clearAlpha);r.autoClear=autoClear;
      target.dispose();material.dispose();geometry.dispose();
    }
    console.log('BOARD_PROOF rendered studio top='+top.toFixed(2)+' bottom='+bottom.toFixed(2));
    if(!(top>bottom*1.2))return 'top lamp became underlighting: '+top+' vs '+bottom;
    Review3D.frame('top');await new Promise(resolve=>setTimeout(resolve,350));
    const pixels=await Review3D.sampleFrame();return pixels.opaquePixels>0||'top board frame empty';
  `],
  ['BR02 processed rendered bottom board comparison', 'v=3d&m=side', `
    if(!proj().board.parts3d)return 'skip';
    Review3D.frame('bottom');await new Promise(resolve=>setTimeout(resolve,350));
    const pixels=await Review3D.sampleFrame();return pixels.opaquePixels>0||'bottom board frame empty';
  `]
);

CHECKS.push(['BR02 processed lighting failure rolls back controls and recovers', 'v=3d&m=side', `
  if(!proj().board.parts3d)return 'skip';
  const T=THREE3D.THREE, s=Review3D.session(), st=Review3D.state, r=st.renderers[0], before=st.lighting;
  const environments=st.views.map(v=>v.scene.environment), count=s.environments.size, events=[];
  const original=T.PMREMGenerator.prototype.fromEquirectangular, onStateChange=Review3D.onStateChange;
  const menu=document.querySelector('.light3d');menu.open=true;
  menu.scrollIntoView({inline:'center',block:'nearest'});
  await new Promise(resolve=>setTimeout(resolve,50));
  try{
    Review3D.onStateChange=e=>events.push(e);
    T.PMREMGenerator.prototype.fromEquirectangular=()=>{throw Error('Synthetic PMREM failure');};
    const select=menu.querySelector('[data-3d-rig]');select.value='photo';select.dispatchEvent(new Event('change',{bubbles:true}));
    if(st.lighting!==before||s.lighting!==before||r.toneMappingExposure!==before.exposure||events.length)return 'failed lighting published success';
    if(st.views.some((v,i)=>v.scene.environment!==environments[i])||s.environments.size!==count)return 'failed lighting changed environment';
    const notice=menu.querySelector('[data-3d-light-error]');
    if(!st.lightingError||notice.hidden||notice.getAttribute('role')!=='alert'||!notice.textContent.includes('Synthetic PMREM failure'))return 'failure not announced';
    if(select.value!==before.rig||+menu.querySelector('[data-3d-exposure]').value!==before.exposure)return 'failed controls not rolled back';
    T.PMREMGenerator.prototype.fromEquirectangular=original;
    select.value='photo';select.dispatchEvent(new Event('change',{bubbles:true}));
    if(st.lighting.rig!=='photo'||r.toneMappingExposure!==1.2||events.length!==1||st.lightingError||!notice.hidden)return 'lighting recovery retained stale error';
    if(st.views.some((v,i)=>v.scene.environment===environments[i]))return 'recovery did not replace environment';
    return (await Review3D.sampleFrame()).opaquePixels>0||'recovered frame empty';
  }finally{T.PMREMGenerator.prototype.fromEquirectangular=original;Review3D.onStateChange=onStateChange;}
`]);

CHECKS.push(
["BR02 processed semantic partitions", "v=3d&m=semantic", `
 if(!proj().board.parts3d)return 'skip';
 const st=Review3D.state;
 if(!st.faded?.some(x=>x.materials.some(m=>m.opacity===.12)))return 'merged semantic fade absent';
 const bodies=[];st.roots[1].traverse(n=>{if(n.isMesh&&n.userData.role==='body'&&!n.userData.ref)
   bodies.push(...(Array.isArray(n.material)?n.material:[n.material]));});
 if(!bodies.length||!bodies.every(m=>m.opacity===.12))return 'unchanged material partition not faded';
 if(st.faded.length!==2||st.faded.some(p=>new Set(p.materials).size!==p.materials.length))return 'revision partition clone ownership lost';
 const base=st.highlights.filter(h=>h.side==='base'),head=st.highlights.filter(h=>h.side==='head');
 if(!base.length||base.some(h=>!h.marker.el.hidden)||!head.some(h=>!h.marker.el.hidden))return 'detached semantic markers visible';
 if(st.highlights.some(h=>h.marker.side!==h.side))return 'marker revision missing';
 return st.highlights.some(h=>h.ref==='R12'&&h.materials.every(m=>m.opacity===1))||'changed highlight lost';
`],
["BR02 processed blend preserves mask alpha", "v=3d&m=blend", `
 if(!proj().board.parts3d)return 'skip';
 Review3D.setBlend(.25);
 for(const [i,weight] of [[0,.75],[1,.25]]) {
   const masks=[];Review3D.state.roots[i].traverse(n=>{if(n.isMesh&&n.userData.role==='mask')
     masks.push(...(Array.isArray(n.material)?n.material:[n.material]));});
   if(!masks.length||!masks.every(m=>Math.abs(m.opacity-.72*weight)<1e-6))return 'mask alpha replaced';
 }
 Review3D.setBlend(.75);Review3D.setBlend(.25);
 for(const [i,weight] of [[0,.75],[1,.25]]) {
   let bad=false;Review3D.state.roots[i].traverse(n=>{if(n.isMesh&&n.userData.role==='mask')
     bad||=[n.material].flat().some(m=>Math.abs(m.opacity-.72*weight)>1e-6);});
   if(bad)return 'blend compounded saved alpha';
 }
 return true;
`],
["BR02 processed overlay preserves base world matrix", "v=3d&m=overlay", `
 if(!proj().board.parts3d)return 'skip';
 const st=Review3D.state,g=st.ghosts.find(g=>g.ref==='R1');if(!g)return 'changed ghost missing';
 st.roots[0].updateMatrixWorld(true);
 const n=st.roots[0].getObjectByName('R1');g.object.updateMatrixWorld(true);
 return n.matrixWorld.elements.every((v,i)=>Math.abs(v-g.object.matrixWorld.elements[i])<1e-7)
   ||'ghost lost base world transform';
`]

);

CHECKS.push(["BR02 processed overlay bare board hides ghosts and markers", "v=3d&m=overlay", `
 if(!proj().board.parts3d)return 'skip';
 const st=Review3D.state,g=st.ghosts[0],h=st.highlights.find(h=>h.marker&&!h.marker.el.hidden);
 if(!g?.object.parent||!h)return 'initial ghost or marker absent';
 let ghostMeshes=[];g.object.traverse(n=>{if(n.isMesh)ghostMeshes.push(n);});
 if(!ghostMeshes.length||ghostMeshes.some(n=>!n.visible))return 'initial ghost meshes hidden';
 const originalRoute={phone:S.phone,m:S.m};
 try {
   for(const phone of [false,true]) {
     Object.assign(S,{phone,m:'overlay'});Review3D.resize();
     const routedGhost=st.ghosts.find(x=>x.ref==='R1');
     const routedMarker=st.highlights.find(x=>x.marker&&x.side==='head');
     if(!routedGhost?.object.parent||!routedMarker||routedMarker.marker.el.hidden)return phone?'narrow overlay representation hidden':'wide overlay representation hidden';
   }
 } finally {
   Object.assign(S,originalRoute);Review3D.resize();
 }
 if(S.phone!==originalRoute.phone||S.m!==originalRoute.m||st.phone!==originalRoute.phone)return 'overlay route not restored';
 Review3D.setAssembled(false);
 if(st.ghosts.some(g=>g.object.parent&&(()=>{let visible=false;g.object.traverse(n=>{if(n.isMesh&&n.visible)visible=true;});return visible;})()))return 'bare ghost visible';
 if(st.highlights.some(h=>h.marker&&!h.marker.el.hidden))return 'bare marker visible';
 const bodies=[];st.roots.forEach(r=>r?.traverse(n=>{if(n.isMesh&&n.userData.role==='body')bodies.push(n);}));
 if(!bodies.length||bodies.some(n=>n.visible))return 'bare body visible';
 Review3D.setAssembled(true);
 if(!g.object.parent||!g.object.visible||h.marker.el.hidden)return 'overlay representation not restored';
 Review3D.focus(proj().changes.find(c=>c.ref==='R12'),false);await Review3D.sampleFrame();
 console.log('BOARD_PROOF '+JSON.stringify({mode:'overlay',phone:S.phone,calls:st.drawCallsByViewport,changedParts:st.changedParts}));
 return st.drawCallsByViewport.every(n=>n<100+st.changedParts)||'comparison call budget exceeded';
`]);

CHECKS.push(...['removed','base-only'].map(input=>[
 'BR02 processed overlay world ghosts '+input,'v=3d&m=overlay', `
 if(!proj().board.parts3d)return 'skip';
 const p=structuredClone(proj()),c=p.changes.find(c=>c.ref==='R12');
 if('${input}'==='removed')c.action='removed';
 else for(const key of ['model3d','parts3d','assets3d','poster3d','coverage3dBySide'])delete p.board[key]?.head;
 await Review3D.show(document.querySelector('#stage'),p,{...S,m:'overlay',s:null});
 const st=Review3D.state,g=st.ghosts.find(g=>g.ref==='R1');if(!g?.object.parent)return 'base ghost absent';
 const n=st.roots[0].getObjectByName('R1');st.roots[0].updateMatrixWorld(true);g.object.updateMatrixWorld(true);
 if(!n.matrixWorld.elements.every((v,i)=>Math.abs(v-g.object.matrixWorld.elements[i])<1e-7))return 'base ghost misplaced';
 if('${input}'==='base-only'&&!st.highlights.some(h=>h.side==='base'&&!h.marker.el.hidden))return 'base-only marker hidden';
 Review3D.setAssembled(false);if(g.object.parent||st.highlights.some(h=>!h.marker.el.hidden))return 'base ghost or marker survived bare';
 Review3D.setAssembled(true);return !!g.object.parent||'base ghost not restored';
 `]));

CHECKS.push(
  ["BR02 processed idle and offscreen stop drawing", "v=3d&m=side", `
 if(!proj().board.parts3d)return 'skip';
 await new Promise(r=>setTimeout(r,2600));const a=Review3D.state.drawCount;
 await new Promise(r=>setTimeout(r,250));
 if(Review3D.state.drawCount!==a)return 'settled idle still drawing';
 const stage=document.querySelector('#stage'),before=stage.style.transform;
 try {
   stage.style.transform='translateX(-200vw)';await new Promise(r=>setTimeout(r,100));
   const b=Review3D.state.drawCount;Review3D.frame('top');await new Promise(r=>setTimeout(r,200));
   if(Review3D.state.drawCount!==b)return 'offscreen viewer still drawing';
 } finally {stage.style.transform=before;}
 await new Promise(r=>setTimeout(r,150));
 return Review3D.state.drawCount>a||'onscreen viewer did not resume';
 `],
  ['BR02 processed rotation damping moves then settles', 'v=3d&m=side', `
 if(!proj().board.parts3d)return 'skip';
 const s=Review3D.session(),v=s.views.find(v=>v.visible),h=v.host,b=h.getBoundingClientRect();
 const start=v.camera.position.clone(),capture=h.setPointerCapture,release=h.releasePointerCapture;
 // Shorten the test's settling tail on software WebGL; this is not a timing benchmark.
 const damping=v.controls.dampingFactor;v.controls.dampingFactor=.2;
 // Synthetic pointer events exercise OrbitControls without claiming trusted-input performance.
 h.setPointerCapture=()=>{};h.releasePointerCapture=()=>{};
 try {
   const event=(type,x)=>h.dispatchEvent(new PointerEvent(type,{pointerId:1,pointerType:'mouse',button:0,buttons:type==='pointerup'?0:1,clientX:x,clientY:b.top+b.height/2,bubbles:true}));
   event('pointerdown',b.left+b.width/2);event('pointermove',b.left+b.width/2+40);event('pointerup',b.left+b.width/2+40);
 } finally {h.setPointerCapture=capture;h.releasePointerCapture=release;}
 const released=v.camera.position.clone();
 if(start.distanceTo(released)<1e-7)return 'rotation did not move camera';
 await new Promise(r=>setTimeout(r,150));
 if(v.controls.enableDamping&&released.distanceTo(v.camera.position)<1e-7)return 'damping did not move camera after release';
 for(let i=0;i<100&&s.raf;i++)await new Promise(r=>setTimeout(r,100));
 const count=s.state.drawCount;
 await new Promise(r=>setTimeout(r,250));
 if(count!==s.state.drawCount||s.raf)return 'damping never settled '+JSON.stringify({count,draws:s.state.drawCount,raf:s.raf,camera:v.camera.position.toArray(),delta:v.controls._sphericalDelta});
 const before=s.state.drawCount;const pixels=await Review3D.sampleFrame();
 if(s.state.drawCount<=before||!pixels.opaquePixels)return 'pixel sample did not draw a fresh frame';
 v.controls.dampingFactor=damping;return true;
 `]
);

CHECKS.push(
  ['BR02 processed adaptive DPR restores once then stays idle', 'v=3d&m=side', `
 if(!proj().board.parts3d)return 'skip';
 const s=Review3D.session(),r=s.renderer,cap=Math.min(devicePixelRatio,2),ratios=[],original=r.setPixelRatio;
 await new Promise(r=>setTimeout(r,100));
 r.setPixelRatio=function(n){ratios.push(n);return original.call(this,n);};
 try {
   for(let i=0;i<9;i++)s.policy.rotating(34);
   if(ratios.length)return 'DPR changed before tenth slow frame';
   s.policy.rotating(34);
   if(JSON.stringify(ratios)!==JSON.stringify(cap>1.5?[1.5]:[]))return 'tenth-frame DPR';
   await new Promise(r=>setTimeout(r,2600));
   if(JSON.stringify(ratios)!==JSON.stringify(cap>1.5?[1.5,cap]:[]))return 'idle DPR restore count '+JSON.stringify(ratios);
   const a=s.state.drawCount;await new Promise(r=>setTimeout(r,250));
   return s.state.drawCount===a||'restore kept drawing';
 } finally {r.setPixelRatio=original;}
 `],
  ['BR02 processed hidden document pauses and disposal cancels scheduler', 'v=3d&m=side', `
 if(!proj().board.parts3d)return 'skip';
 const s=Review3D.session(),descriptor=Object.getOwnPropertyDescriptor(document,'hidden');
 try {
   Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));
   const count=s.state.drawCount;Review3D.frame('top');await new Promise(r=>setTimeout(r,150));
   if(s.raf||s.state.drawCount!==count)return 'hidden document kept drawing';
   Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));
   await new Promise(r=>setTimeout(r,150));
   if(s.state.drawCount===count)return 'visible document did not resume';
   Review3D.frame('bottom');Review3D.dispose();const closed=s.state.drawCount;
   await new Promise(r=>setTimeout(r,150));
   return s.state.drawCount===closed&&s.animationFrames.size===0||'disposed scheduler still active';
 } finally {if(descriptor)Object.defineProperty(document,'hidden',descriptor);else delete document.hidden;}
 `],
  ['BR02 processed reduced motion disables damping', 'v=3d&m=side', `
 if(!proj().board.parts3d)return 'skip';
 const original=window.matchMedia;
 try {
   window.matchMedia=query=>query==='(prefers-reduced-motion: reduce)'?{matches:true}:original.call(window,query);
   await Review3D.show(document.querySelector('#stage'),proj(),S);
   return Review3D.state.controls.every(c=>!c.enableDamping)||'reduced motion still damps';
 } finally {window.matchMedia=original;}
 `]
);
