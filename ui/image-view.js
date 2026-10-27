// Decoded SVG artwork ownership. Camera updates never rewrite the source.
(() => {
  const replacePaints=(text,paints)=>text.replace(
    /((?:\b(?:fill|stroke)\s*=\s*["']|\b(?:fill|stroke)\s*:\s*))(#[0-9a-f]{6})(?=\s*(?:!important)?[;"'])/gi,
    (all,prefix,hex)=>prefix+(paints.get(hex.toLowerCase())||hex));

  function controller(source, options, env={
    make:()=>document.createElement('img'),
    create:text=>URL.createObjectURL(new Blob([text],{type:'image/svg+xml'})),
    revoke:url=>URL.revokeObjectURL(url)
  }) {
    let generation=0, disposed=false, node=null, appliedSource=null;
    const owned=new Set(), release=url=>{if(owned.delete(url))env.revoke(url);};
    let activeURL=null;
    return {
      get node(){return node;}, get source(){return source;},
      get appliedSource(){return appliedSource;}, get generation(){return generation;},
      async setAppearance(paints) {
        if(disposed)return false;
        const ticket=++generation, text=replacePaints(source,paints), url=env.create(text);
        owned.add(url);
        let next;
        try {
          next=env.make(); next.decoding='async'; next.draggable=false;
          next.alt=`${options.side} ${options.layer}`;
          next.dataset.imageArtwork=''; next.dataset.side=options.side; next.src=url;
          await next.decode();
        }
        catch(error){release(url); if(disposed||ticket!==generation)return false; throw error;}
        if(disposed||ticket!==generation){release(url);return false;}
        const previous=node, previousURL=activeURL;
        node=next; activeURL=url; appliedSource=text;
        if(previous?.isConnected)previous.replaceWith(next);
        else previous?.remove();
        if(previousURL)release(previousURL);
        return true;
      },
      dispose(){
        if(disposed)return;
        disposed=true; generation++; node?.remove(); node=null;
        for(const url of [...owned])release(url);
      }
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
    if(g.rings?.length)return g.rings.reduce((n,r)=>n+Math.abs(r.reduce((s,a,i)=>{
      const b=r[(i+1)%r.length];return s+a[0]*b[1]-b[0]*a[1];
    },0))/2,0);
    if(!p)return Infinity;
    const [w,h]=p.size;
    if(p.shape==='circle')return Math.PI*w*w/4;
    if(p.shape==='oval')return Math.min(w,h)*Math.abs(w-h)+Math.PI*Math.min(w,h)**2/4;
    if(p.shape==='roundrect')return w*h-(4-Math.PI)*(p.radius||0)**2;
    return w*h;
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

  globalThis.ImageView={replacePaints,controller,segmentDistance,polygonDistance,primitiveDistance,inspectHit};
})();
