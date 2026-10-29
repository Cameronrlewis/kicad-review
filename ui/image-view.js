// Decoded SVG artwork ownership. Camera updates never rewrite the source.
(() => {
  const snapshotScale = (w,h,dpr) => Math.min(dpr,Math.sqrt(6e6/Math.max(1,w*h)));
  const wheelFactor = (delta,mode,sensitivity=1) =>
    Math.exp(-.0015*Math.max(-400,Math.min(400,delta*(mode===1?16:mode===2?200:1)*sensitivity)));

  // test seam
  const replacePaints=(text,paints)=>text.replace(
    /((?:\b(?:fill|stroke)\s*=\s*["']|\b(?:fill|stroke)\s*:\s*))(#[0-9a-f]{6})(?=\s*(?:!important)?[;"'])/gi,
    (all,prefix,hex)=>prefix+(paints.get(hex.toLowerCase())||hex));

  // The full-image owner outlives this session. Only transient artwork belongs here.
  // test seam
  function gestureSession({capture,restore,makeCrop,setTimer=setTimeout,clearTimer=clearTimeout}) {
    let ticket=0,disposed=false,timer=null,snapshot=null,crop=null,cropBox=null;
    const cancelTimer=()=>{if(timer!==null)clearTimer(timer);timer=null;};
    const clear=()=>{snapshot?.dispose();snapshot=null;crop?.dispose();crop=null;};
    return {
      begin(){if(disposed)return;ticket++;cancelTimer();
        if(!snapshot)snapshot=capture();},
      settle(box){if(disposed)return;cancelTimer();const generation=++ticket;
        timer=setTimer(async()=>{
          timer=null;let next=null,region=null;
          try {region=typeof box==='function'?box():box;if(region)next=region===cropBox&&crop?crop:await makeCrop(region);}
          catch { /* Keep the full image on crop failure. */ }
          if(disposed||generation!==ticket){if(next!==crop)next?.dispose();return;}
          if(crop!==next)crop?.dispose();crop=next;cropBox=region;restore(crop);snapshot?.dispose();snapshot=null;
        },150);},
      move(){snapshot?.move?.();},
      invalidate(){ticket++;cancelTimer();clear();if(!disposed)restore(null);},
      dispose(){if(disposed)return;disposed=true;ticket++;cancelTimer();clear();}
    };
  }

  function parseVector(source) {
    const root=new DOMParser().parseFromString(source,'image/svg+xml').documentElement;
    if(root.localName!=='svg'||root.querySelector('parsererror'))throw Error('invalid crop source');
    return root;
  }
  // test seam
  function vectorCrop(source,box,options,parsed) {
    const root=(parsed||parseVector(source)).cloneNode(true), [x,y,w,h]=box;
    if(box.length!==4||![x,y,w,h].every(Number.isFinite)||w<=0||h<=0)throw Error('invalid crop box');
    root.setAttribute('viewBox',box.join(' '));root.setAttribute('width',String(w));root.setAttribute('height',String(h));
    return mount(new XMLSerializer().serializeToString(root),[w,h],options);
  }
  function cropRegion(box,page,viewBox) {
    const world=[box[0]-box[2]*.1,box[1]-box[3]*.1,box[2]*1.2,box[3]*1.2];
    return {world,source:[(world[0]-page[0])*viewBox[2]/page[2]+viewBox[0],
      (world[1]-page[1])*viewBox[3]/page[3]+viewBox[1],
      world[2]*viewBox[2]/page[2],world[3]*viewBox[3]/page[3]]};
  }

  function controller(source, options, env={
    make:()=>document.createElement('img'),
    create:text=>URL.createObjectURL(new Blob([text],{type:'image/svg+xml'})),
    revoke:url=>URL.revokeObjectURL(url)
  }) {
    let generation=0, disposed=false, node=null, appliedSource=null, parsed=null, session=null;
    const owned=new Set(), release=(url,image)=>{
      if(image)image.removeAttribute?.('src');
      if(owned.delete(url))env.revoke(url);
    };
    let activeURL=null;
    const owner = {
      get node(){return node;}, get source(){return source;},
      get appliedSource(){return appliedSource;}, get generation(){return generation;},
      configureGesture(options){session?.dispose();session=disposed?null:gestureSession(options);},
      beginGesture(){session?.begin();},
      endGesture(box){session?.settle(box);},
      invalidateGesture(){session?.invalidate();},
      moveSnapshot(){session?.move();},
      crop(box){
        if(disposed)throw Error('image owner disposed');
        if(!appliedSource)throw Error('image not decoded');
        parsed ||= parseVector(appliedSource);
        return vectorCrop(appliedSource,box,options,parsed);
      },
      get viewBox(){
        if(!appliedSource)return null;
        parsed ||= parseVector(appliedSource);
        return parsed.getAttribute('viewBox').trim().split(/[\s,]+/).map(Number);
      },
      async setAppearance(paints) {
        if(disposed)return false;
        session?.invalidate();
        const ticket=++generation, text=replacePaints(source,paints), url=env.create(text);
        owned.add(url);
        let next;
        try {
          next=env.make(); next.decoding='async'; next.draggable=false;
          next.alt=`${options.side} ${options.layer}`;
          next.dataset.imageArtwork=''; next.dataset.side=options.side; next.src=url;
          await next.decode();
        }
        catch(error){release(url,next); if(disposed||ticket!==generation)return false; throw error;}
        if(disposed||ticket!==generation){release(url,next);return false;}
        session?.invalidate(); // Also cancel gestures begun while this decode was pending.
        const previous=node, previousURL=activeURL;
        node=next; node.imageOwner=owner; activeURL=url; appliedSource=text; parsed=null;
        if(previous?.isConnected)previous.replaceWith(next);
        else previous?.remove();
        if(previousURL)release(previousURL);
        return true;
      },
      dispose(){
        if(disposed)return;
        disposed=true; generation++; session?.dispose();session=null; parsed=null;node?.remove(); node=null;
        for(const url of [...owned])release(url);
      }
    };
    return owner;
  }

  const rgbHex=rgb=>'#'+rgb.slice(0,3).map(v=>Math.round(v).toString(16).padStart(2,'0')).join('');
  // test seam
  function layerPaints(text,original,rgb) {
    const expected=rgbHex(original).toLowerCase(), replacement=rgbHex(rgb);
    return text.replace(/(\b(?:fill|stroke)\s*(?:=\s*["']|:\s*))((?:#[\da-f]{3}(?:[\da-f]{3})?|rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)))(?=\s*(?:!important)?[;"'])/gi,
      (all,prefix,paint)=>{
        let hex=paint.toLowerCase();
        if(hex.startsWith('rgb'))hex=rgbHex(hex.match(/\d+/g).map(Number));
        else if(hex.length===4)hex='#'+[...hex.slice(1)].map(c=>c+c).join('');
        return prefix+(hex===expected?replacement:paint);
      });
  }
  function boardLayer(source,original,wrapper,options,env) {
    // Always substitute from the immutable selected export, not a prior rewrite.
    const normalized=layerPaints(source,original,original);
    let c=controller(normalized,options,env), hidden=false, disposed=false;
    return {get controller(){return c;},
      async setAppearance(look){
        if(disposed)return false;
        wrapper.style.opacity=String(look.color[3]*look.opacity);
        wrapper.hidden=look.visible===false;
        if(wrapper.hidden){
          hidden=true;c.dispose();wrapper.replaceChildren();return true;
        }
        if(hidden){c=controller(normalized,options,env);hidden=false;}
        const current=c;
        const applied=await current.setAppearance(options.comparison?new Map():new Map([[rgbHex(original),rgbHex(look.color)]]));
        if(!applied||disposed||hidden||current!==c||!current.node)return false;
        if(!current.node.isConnected)wrapper.replaceChildren(current.node);
        return true;
      },
      dispose(){disposed=true;c.dispose();}
    };
  }

  // Geometry is retained in micrometres, already in board/world coordinates.
  function segmentDistance(p,a,b) {
    const dx=b[0]-a[0],dy=b[1]-a[1],d=dx*dx+dy*dy;
    const t=d?Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/d)):0;
    return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy);
  }
  function polygonDistance(p,ring) {
    let inside=false,d=Infinity;
    for(let i=0,j=ring.length-1;i<ring.length;j=i++){
      const a=ring[j],b=ring[i];d=Math.min(d,segmentDistance(p,a,b));
      if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;
    }
    return inside?-d:d;
  }
  function primitiveDistance(point,p) {
    if(!p)return Infinity;
    // Inverse of the retained renderer's KiCad rotation (screen y points down).
    const a=(p.angle||0)*Math.PI/180000,c=Math.cos(a),s=Math.sin(a);
    const dx=point[0]-p.center[0],dy=point[1]-p.center[1];
    const local=[c*dx-s*dy,s*dx+c*dy], [w,h]=p.size.map(v=>v/2);
    if(p.shape==='circle')return Math.hypot(...local)-w;
    if(p.shape==='trapezoid'){
      const [tx,ty]=p.delta||[0,0];
      return polygonDistance(local,[[-1,-1],[1,-1],[1,1],[-1,1]].map(([sx,sy])=>[sx*w-sx*sy*ty/2,sy*h+sx*sy*tx/2]));
    }
    if(!['rect','roundrect','oval'].includes(p.shape))return Infinity;
    const r=p.shape==='oval'?Math.min(w,h):p.shape==='roundrect'?Math.min(p.radius||0,w,h):0;
    const q=[Math.abs(local[0])-w+r,Math.abs(local[1])-h+r];
    return Math.hypot(Math.max(q[0],0),Math.max(q[1],0))+Math.min(Math.max(...q),0)-r;
  }
  function segmentsDistance(p,segments=[]) {
    let d=Infinity;
    for(const s of segments)d=Math.min(d,segmentDistance(p,s.slice(0,2),s.slice(2,4))-s[4]/2);
    return d;
  }
  function copperDistance(p,o,visibleLayers) {
    const g=o.geometry;
    // A drill has no shape tag in the producer; its size describes a circle or slot.
    const drill=g.drill&&{...g.drill,shape:g.drill.size[0]===g.drill.size[1]?'circle':'oval'};
    if(drill&&primitiveDistance(p,drill)<=0)return Infinity;
    let d=segmentsDistance(p,g.segments);
    for(const layer of o.layers)if(visibleLayers.has(layer))
      d=Math.min(d,primitiveDistance(p,g.layerPrimitives?.[layer]||g.primitive));
    // Custom pad rings union with each other, the anchor and stroked extensions.
    for(const ring of g.rings||[])d=Math.min(d,polygonDistance(p,ring));
    return d;
  }
  function copperArea(o) {
    const g=o.geometry,p=g.primitive;
    const ringArea=(g.rings||[]).reduce((n,r)=>n+Math.abs(r.reduce((s,a,i)=>{
      const b=r[(i+1)%r.length];return s+a[0]*b[1]-b[0]*a[1];
    },0))/2,0);
    const [w,h]=p?.size||[];
    let primitiveArea=Infinity;
    if(p){
      if(p.shape==='circle')primitiveArea=Math.PI*w*w/4;
      else if(p.shape==='oval')primitiveArea=Math.min(w,h)*Math.abs(w-h)+Math.PI*Math.min(w,h)**2/4;
      else if(p.shape==='roundrect')primitiveArea=w*h-(4-Math.PI)*(p.radius||0)**2;
      else primitiveArea=w*h;
    }
    const segmentArea=(g.segments||[]).reduce((n,s)=>n+(Math.hypot(s[2]-s[0],s[3]-s[1])+s[4])*s[4],0);
    return ringArea+segmentArea+(Number.isFinite(primitiveArea)?primitiveArea:0);
  }
  function inspectHit(graph,pointMm,visibleLayers,pxPerMm,touch) {
    if(pointMm.length!==2||!pointMm.every(Number.isFinite)||!Number.isFinite(pxPerMm)||pxPerMm<=0)return null;
    const p=pointMm.map(v=>v*1000),reach=Math.max(.15,(touch?12:6)/pxPerMm)*1000;
    // Caller supplies eye-enabled, nonzero-effective-opacity layers for this revision.
    // toWorld already handles flip; never transform this graph a second time.
    const visible=o=>!o.hidden&&o.layers.some(l=>visibleLayers.has(l));
    const pads=graph.pads.filter(visible).map(o=>({o,d:copperDistance(p,o,visibleLayers)}));
    const vias=graph.vias.filter(visible).map(o=>({o,d:copperDistance(p,o,visibleLayers)}));
    const tracks=graph.tracks.filter(visible).map(o=>({o,d:segmentsDistance(p,o.geometry.segments)}));
    const byUuid=(a,b)=>a.o.uuid.localeCompare(b.o.uuid);
    const smallest=rows=>rows.sort((a,b)=>copperArea(a.o)-copperArea(b.o)||byUuid(a,b))[0]?.o;
    const nearest=rows=>rows.sort((a,b)=>a.d-b.d||byUuid(a,b))[0]?.o;
    // Direct copper containment takes precedence over every expanded reach target.
    return smallest(pads.filter(v=>v.d<=0))||smallest(vias.filter(v=>v.d<=0))||
      nearest(tracks.filter(v=>v.d<=0))||smallest(pads.filter(v=>v.d<=reach))||
      smallest(vias.filter(v=>v.d<=reach))||nearest(tracks.filter(v=>v.d<=reach))||null;
  }

  const natural = new Intl.Collator(undefined,{numeric:true,sensitivity:'base'});
  function searchComponents(elements,query) {
    const q=query.trim().toLowerCase();
    return elements.filter(e=>[e.ref,e.value,e.footprint,...Object.values(e.fields||{})]
      .some(v=>String(v||'').toLowerCase().includes(q)))
      .sort((a,b)=>Number(!String(a.ref||'').toLowerCase().startsWith(q))-Number(!String(b.ref||'').toLowerCase().startsWith(q)) || natural.compare(a.ref,b.ref))
      .slice(0,20);
  }
  function searchNets(nets,query) {
    const q=query.trim().toLowerCase(),rank=n=>n===q?0:n.startsWith(q)?1:2;
    return nets.filter(n=>(!n.name.toLowerCase().startsWith('unconnected-')||q.startsWith('unconnected-'))&&n.name.toLowerCase().includes(q))
      .sort((a,b)=>rank(a.name.toLowerCase())-rank(b.name.toLowerCase())||natural.compare(a.name,b.name)).slice(0,20);
  }

  function comparisonSource(text,side,schematic) {
    const root=new DOMParser().parseFromString(text,'image/svg+xml').documentElement;
    const ns='http:'+'//www.w3.org/2000/svg',uid='kr-image-'+side;
    const element=(name,attrs={})=>{const e=document.createElementNS(ns,name);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,v);return e;};
    const box=(root.getAttribute('viewBox')||'0 0 100 100').trim().split(/[\s,]+/).map(Number);
    const [x,y,width,height]=box.length===4&&box.every(Number.isFinite)?box:[0,0,100,100];
    const defs=element('defs'),f=element('filter',{id:uid,'color-interpolation-filters':'sRGB',filterUnits:'userSpaceOnUse',x,y,width,height});
    const rgb=side==='base'?[.85,.1,.15]:[.1,.6,.2];
    f.append(element('feColorMatrix',{type:'matrix',values:rgb.map(v=>'0 0 0 0 '+v).join(' ')+' '+(schematic?'-.3 -.59 -.11 1 0':'0 0 0 1 0')}));defs.append(f);
    const group=element('g',{filter:`url(#${uid})`});
    for(const child of [...root.children])if(!['defs','title','desc'].includes(child.localName))group.append(child);
    root.append(defs,group);return new XMLSerializer().serializeToString(root);
  }
  function visibleHotspots(elements,box,limit=400) {
    const intersects=b=>b[2]>=box[0]&&b[0]<=box[2]&&b[3]>=box[1]&&b[1]<=box[3];
    const area=e=>(e.bbox[2]-e.bbox[0])*(e.bbox[3]-e.bbox[1]);
    // ponytail: 400 DOM targets per pane; point scan keeps omitted targets pickable.
    return elements.filter(e=>intersects(e.bbox)).sort((a,b)=>area(a)-area(b)).slice(0,limit).reverse();
  }

  function boardDrawGate(stage,generation) {
    const seen=new Set();let cancelled=false;
    const active=()=>!cancelled&&stage.isConnected&&stage.dataset.view==='board'&&stage.dataset.generation===String(generation);
    const ready=backend=>{if(active()){stage.dataset.boardBackend=backend;stage.dataset.boardReady=String(generation);}};
    return {
      record(renderer,ok){if(ok&&renderer.stats.draws>0)seen.add(renderer);},
      finish(expected){if(expected>0&&seen.size===expected)ready('gl');},
      images(nodes,expected,failed){if(expected>0&&!failed&&nodes.length===expected&&nodes.every(n=>n.complete&&n.naturalWidth>0))ready('images');},
      cancel(){cancelled=true;}
    };
  }

  function pinPosition(a,sourceViews,targetViews) {
    if(a.kind!=='symbol'||a.sheet==null)return null;
    const source=(sourceViews.find(v=>v.sheet===a.sheet)?.elements||[]).filter(e=>e.uuid===a.uuid);
    const candidates=source.flatMap(e=>e.pins.filter(p=>Math.hypot(p.x-a.x,p.y-a.y)<=.002).map(p=>({e,p})));
    if(candidates.length>1)return {pos:[a.x,a.y],notes:['ambiguous pin endpoint; retaining original point']};
    if(!candidates.length)return null;
    const {e,p}=candidates[0];
    const next=(targetViews.find(v=>v.sheet===a.sheet)?.elements||[])
      .filter(t=>t.uuid===a.uuid&&t.unit===e.unit)
      .flatMap(t=>t.pins.filter(q=>q.number===p.number&&q.name===p.name));
    return next.length===1?{pos:[next[0].x,next[0].y],notes:[]}
      :{pos:[a.x,a.y],notes:['pin endpoint unavailable in this revision; retaining original point']};
  }

  const IMAGE_ASSET_LIMITS={svg:8*1024*1024,json:4*1024*1024};
  let assetClientSerial=0;
  // One opaque-frame client per view; only its parent can complete declared requests.
  function assetClient(host,allowed,scope=window) {
    const pending=new Map(),queue=[],prefix='asset-'+(++assetClientSerial)+'-';let serial=0,sequence=0,disposed=false,backoff=null;
    // Bursts wait FIFO; deadlines start only when one of eight network slots opens.
    const pump=()=>{
      while(!disposed&&backoff===null&&pending.size<8&&queue.length){
        const p=queue.shift(),requestId=prefix+(++serial);
        p.timer=setTimeout(()=>{
          pending.delete(requestId);p.reject(Error('Asset timeout; retry available'));pump();
        },15000);
        pending.set(requestId,p);
        try {host.postMessage({kicadReviewAsset:{requestId,digest:p.digest,kind:p.kind}},'*');}
        catch {pending.delete(requestId);clearTimeout(p.timer);p.reject(Error('Asset unavailable'));}
      }
    };
    const receive=e=>{
      const r=e.data?.kicadReviewAssetResult,p=pending.get(r?.requestId);
      if(e.source!==host||!p||r.digest!==p.digest)return;
      pending.delete(r.requestId);clearTimeout(p.timer);
      if(r.error==='Busy; retry'){
        const i=queue.findIndex(q=>q.seq>p.seq);
        queue.splice(i<0?queue.length:i,0,p);
        if(backoff===null)backoff=setTimeout(()=>{backoff=null;pump();},150);
      }
      else if(r.error||typeof r.text!=='string'||new TextEncoder().encode(r.text).length>IMAGE_ASSET_LIMITS[p.kind])p.reject(Error('Asset unavailable'));
      else p.resolve(r.text);
      pump();
    };
    scope.addEventListener('message',receive);
    return {
      get(digest,kind){
        if(disposed||queue.length>=128||!/^[0-9a-f]{12}$/.test(digest)||!['svg','json'].includes(kind)||allowed[digest]?.kind!==kind)return Promise.reject(Error('Asset unavailable'));
        return new Promise((resolve,reject)=>{queue.push({digest,kind,resolve,reject,seq:++sequence});pump();});
      },
      dispose(){if(disposed)return;disposed=true;clearTimeout(backoff);backoff=null;scope.removeEventListener('message',receive);
        for(const [requestId,p] of pending){
          try {host.postMessage({kicadReviewAssetCancel:{requestId}},'*');}catch { /* Disposal must still release local work. */ }
          clearTimeout(p.timer);p.reject(Error('Asset view disposed'));}pending.clear();
        for(const p of queue)p.reject(Error('Asset view disposed'));queue.length=0;}
    };
  }

  async function mount(text, size, options) {
    const c=controller(text,options);
    try {await c.setAppearance(new Map());return c;}
    catch(error){c.dispose();throw error;}
  }
  globalThis.ImageView={assetClient,snapshotScale,wheelFactor,gestureSession,vectorCrop,cropRegion,replacePaints,controller,layerPaints,boardLayer,rgbHex,mount,comparisonSource,visibleHotspots,boardDrawGate,
    segmentDistance,polygonDistance,primitiveDistance,inspectHit,searchComponents,searchNets,pinPosition};
})();
